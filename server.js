import express from 'express';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory cache ────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const CATEGORIES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCached(key, ttl = CACHE_TTL) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ─── HTTP helper ────────────────────────────────────────────────
async function fetchPage(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await gotScraping({
        url,
        headerGeneratorOptions: {
          browsers: [{ name: 'chrome', minVersion: 100 }],
          locales: ['en-US'],
          operatingSystems: ['windows'],
        },
        timeout: { request: 25000 },
        retry: { limit: 0 },
      });

      if (response.statusCode === 200) {
        return response.body;
      }

      console.warn(`Attempt ${attempt}/${retries}: Status ${response.statusCode} for ${url}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    } catch (err) {
      console.warn(`Attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`Failed after ${retries} attempts`);
}

// ─── Scrape categories from justetf.com ─────────────────────────
// Dynamically scrapes etf-lists.html and extracts all guide page links
async function scrapeCategories() {
  const cacheKey = 'categories';
  const cached = getCached(cacheKey, CATEGORIES_CACHE_TTL);
  if (cached) return cached;

  console.log('Scraping categories from etf-lists.html...');
  const html = await fetchPage('https://www.justetf.com/en/etf-lists.html');
  const $ = cheerio.load(html);

  const categories = [];
  const seen = new Set();
  
  // Walk through the DOM sequentially to reliably map links to headers
  let currentGroup = 'Ostatní';
  
  // Find all headers and guide links in exact source order
  $('h2, h3, h4, a[href*="/en/how-to/"]').each((i, el) => {
    const $el = $(el);
    const tag = $el.prop('tagName');
    
    if (tag === 'H2' || tag === 'H3' || tag === 'H4') {
      const text = $el.text().trim();
      if (text.length > 3 && text.length < 100) {
        currentGroup = text;
      }
    } else if (tag === 'A') {
      const href = $el.attr('href') || '';
      if (href === '/en/how-to/' || href === '/en/how-to') return;
      
      const fullUrl = href.startsWith('/') ? 'https://www.justetf.com' + href : href;
      if (seen.has(fullUrl)) return;
      
      const name = $el.text().trim();
      if (!name || name.length <= 2 || name.length >= 80) return;
      
      seen.add(fullUrl);
      
      // Clean up group names
      let group = currentGroup
        .replace(/^List of ETFs by\s*/i, '')
        .replace(/^ETFs on\s*/i, '')
        .replace(/^ETFs by\s*/i, '')
        .trim();
        
      categories.push({ name, group, url: fullUrl });
    }
  });

  console.log(`Found ${categories.length} categories`);
  setCache(cacheKey, categories);
  return categories;
}

// ─── Scrape ETF list from guide page ────────────────────────────
async function scrapeETFListFromGuidePage(guideUrl, limitAmount) {
  const cacheKey = `list:${guideUrl}:${limitAmount}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  console.log(`Scraping guide page: ${guideUrl}`);
  const html = await fetchPage(guideUrl);
  const $ = cheerio.load(html);

  const etfs = [];
  const seenIsins = new Set();

  // Find ONLY the primary overview table. Let's locate the first table on the page
  // and exclusively get its rows.
  // justETF uses either 'dt-etf-param' (topics) or 'dt-etf-param-region' (regions) for the overview table.
  const $overviewTable = $('table[class*="dt-etf-param"]').first();
  if (!$overviewTable.length) {
    console.warn(`No main ETF table found for ${guideUrl}`);
  }

  // Parse only rows from this specific first table
  let foundRows = 0;
  $overviewTable.children('tbody').first().children('tr').each((i, row) => {
    // Ukončit hledání pokud jsme už našli 20 položek, zbytek nás nezajímá kvůli výkonu
    if (foundRows >= 20) return false;

    const $row = $(row);
    
    // Find ISIN from link
    let isin = '';
    $row.find('a[href*="isin="]').each((j, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/isin=([A-Z0-9]{12})/);
      if (m && !isin) isin = m[1];
    });
    
    // If no ISIN, it's not an ETF row
    if (!isin) return;
    
    // Zabráníme přidání duplicit, pokud by tabulka obsahovala zdvojené řádky
    if (seenIsins.has(isin)) return;
    seenIsins.add(isin);
    foundRows++;
    
    const cells = $row.find('td');
    if (cells.length < 3) return;

    // Name from first link
    const nameLink = $row.find('a[href*="isin="]').first();
    const name = nameLink.text().trim();

    // Cell values
    const cellTexts = [];
    cells.each((j, cell) => cellTexts.push($(cell).text().trim()));

    // Pokusíme se extrahovat měnu rovnou z názvu nebo AUM, pokud to jde (vylepšení pro limit=all)
    let currency = 'N/A';
    const aumText = cellTexts[2] || '';
    if (aumText.includes('EUR')) currency = 'EUR';
    else if (aumText.includes('USD')) currency = 'USD';
    else if (aumText.includes('GBP')) currency = 'GBP';
    // Fallback: mrknout do názvu
    if (currency === 'N/A') {
       if (name.includes('EUR') || name.includes('(EUR)')) currency = 'EUR';
       else if (name.includes('USD') || name.includes('(USD)')) currency = 'USD';
       else if (name.includes('GBP') || name.includes('(GBP)')) currency = 'GBP';
    }

    etfs.push({
      isin,
      name: name || 'N/A',
      currency, // Základní pokus o měnu
      aum: aumText ? `EUR ${aumText.replace('EUR', '').trim()}` : 'N/A',
      ter: cellTexts[3] || 'N/A',
      distribution: cellTexts[4] || 'N/A',
      replication: cellTexts[6] || 'N/A',
    });
  });

  // Sort by AUM descending
  etfs.sort((a, b) => {
    const parseAum = (s) => {
      if (!s) return 0;
      return parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;
    };
    return parseAum(b.aum) - parseAum(a.aum);
  });

  // Uživatel si přál maximálně 20 ETF v kategorii
  const finalEtfs = etfs.slice(0, 20);

  const hasMore = finalEtfs.length > 6;
  const isAll = limitAmount === 'all';
  const targetList = isAll ? finalEtfs : finalEtfs.slice(0, 6);

  // Pokud je limit === 'all', přeskočíme zdlouhavé stahování profilů, jinak stáhneme detaily pro top 6
  if (isAll) {
    const simplified = targetList.map(etf => ({
      ...etf,
      kidAvailable: 'Nedostupný (rychlé načtení)',
      description: 'Detailní popis z profilové stránky je z výkonnostních důvodů u hromadného načítání vynechán.'
    }));
    setCache(cacheKey, { etfs: simplified, allEtfs: targetList, hasMore: false });
    return { etfs: simplified, allEtfs: targetList, hasMore: false };
  }

  // Fetch details from profile pages (batched, 3 at a time) for top 6
  const detailed = [];
  for (let i = 0; i < targetList.length; i += 3) {
    const batch = targetList.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(async (etf) => {
        try {
          const detail = await scrapeETFDetail(etf.isin);
          return {
            ...etf,
            ...detail,
            name: detail.name || etf.name,
            aum: detail.aum || etf.aum,
            ter: detail.ter || etf.ter,
            distribution: detail.distribution || etf.distribution,
            replication: detail.replication || etf.replication,
            // Pokud detail.currency chybí, necháme tu základní z hlavní stránky
            currency: detail.currency || etf.currency,
          };
        } catch (err) {
          console.warn(`Detail failed for ${etf.isin}: ${err.message}`);
          return { ...etf, kidAvailable: 'N/A', description: '' };
        }
      })
    );
    results.forEach(r => {
      detailed.push(r.status === 'fulfilled' ? r.value : { isin: 'N/A', name: 'Error', currency: 'N/A', ter: 'N/A', aum: 'N/A', distribution: 'N/A', replication: 'N/A', kidAvailable: 'N/A', description: '' });
    });
  }

  setCache(cacheKey, { etfs: detailed, allEtfs: finalEtfs, hasMore });
  return { etfs: detailed, allEtfs: finalEtfs, hasMore };
}

// ─── Scrape ETF detail from profile page ────────────────────────
async function scrapeETFDetail(isin) {
  const cacheKey = `etf:${isin}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  console.log(`  → Detail: ${isin}`);
  const url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const result = {
    name: '',
    isin,
    currency: '',
    ter: '',
    aum: '',
    distribution: '',
    replication: '',
    kidAvailable: '',
    description: '',
  };

  // Name from h1
  const h1 = $('h1').first().text().trim();
  if (h1) result.name = h1;

  // Extract from table rows
  $('table tr').each((i, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;

    const label = $(cells[0]).text().trim().toLowerCase();
    const value = $(cells[1]).text().trim();
    if (!value || value.length > 200) return;

    if ((label.includes('fund currency') || label === 'currency') && !result.currency) {
      result.currency = value;
    }
    if ((label.includes('total expense ratio') || label === 'ter') && !result.ter) {
      result.ter = value;
    }
    if ((label.includes('fund size') || label.includes('assets under management')) && !result.aum) {
      result.aum = value;
    }
    if ((label.includes('distribution policy') || label.includes('use of profits')) && !result.distribution) {
      result.distribution = value;
    }
    if ((label.includes('replication') || label.includes('index tracking')) && !result.replication) {
      result.replication = value;
    }
  });

  // Description – investment strategy
  $('h2, h3, h4').each((i, heading) => {
    const text = $(heading).text().toLowerCase();
    if (text.includes('investment strategy') || text.includes('description') || text.includes('fund description')) {
      let sibling = $(heading).next();
      let attempts = 0;
      while (sibling.length && attempts < 5) {
        const sibText = sibling.text().trim();
        if (sibText.length > 30 && sibText.length < 2000) {
          result.description = sibText;
          return false;
        }
        sibling = sibling.next();
        attempts++;
      }
    }
  });

  // KID availability
  const kidLinks = new Set();
  $('a').each((i, a) => {
    const href = ($(a).attr('href') || '').toLowerCase();
    const text = $(a).text().trim();
    if (!text) return;
    if (href.includes('kid') || href.includes('kiid') || href.includes('key-information') || href.includes('key_information')) {
      kidLinks.add(text);
    }
    if (href.includes('.pdf')) {
      const lt = text.toLowerCase();
      if (lt.includes('kid') || lt.includes('key information') || lt.includes('kiid')) {
        kidLinks.add(text);
      }
    }
  });
  result.kidAvailable = kidLinks.size > 0 ? `Ano (${[...kidLinks].join(', ')})` : 'Nedostupný';

  setCache(cacheKey, result);
  return result;
}

// ─── Serve static frontend ─────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ─────────────────────────────────────────────────

// GET /api/categories – dynamically scraped from justetf.com
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await scrapeCategories();
    res.json({ success: true, data: categories });
  } catch (err) {
    console.error('Error fetching categories:', err.message);
    res.status(500).json({ success: false, error: 'Could not load categories from justetf.com.' });
  }
});

// GET /api/etfs?url=<guideUrl>
app.get('/api/etfs', async (req, res) => {
  try {
    const guideUrl = req.query.url;
    const limit = req.query.limit || '6';
    if (!guideUrl) {
      return res.status(400).json({ success: false, error: 'Missing url parameter.' });
    }
    if (!guideUrl.includes('justetf.com')) {
      return res.status(400).json({ success: false, error: 'Only justetf.com URLs allowed.' });
    }

    const { etfs, allEtfs, hasMore } = await scrapeETFListFromGuidePage(guideUrl, limit);
    res.json({ success: true, data: etfs, allEtfs, hasMore });
  } catch (err) {
    console.error('Error fetching ETFs:', err.message);
    res.status(500).json({
      success: false,
      error: 'Could not load ETF data. The server may be temporarily unavailable.',
    });
  }
});

// GET /api/etf/:isin
app.get('/api/etf/:isin', async (req, res) => {
  try {
    const { isin } = req.params;
    if (!/^[A-Z0-9]{12}$/.test(isin)) {
      return res.status(400).json({ success: false, error: 'Invalid ISIN.' });
    }
    const detail = await scrapeETFDetail(isin);
    res.json({ success: true, data: detail });
  } catch (err) {
    console.error('Error fetching ETF detail:', err.message);
    res.status(500).json({ success: false, error: 'Could not load ETF detail.' });
  }
});

// GET /api/cache/clear
app.get('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ success: true, message: 'Cache cleared.' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cacheSize: cache.size });
});

// ─── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 ETF Screener v2 running at http://localhost:${PORT}`);
  console.log(`   RAM: ~${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
  // Pre-warm categories cache after a short delay so the server binds the port and responds to health checks immediately
  setTimeout(() => {
    scrapeCategories().catch(err => console.warn('Category pre-warm failed:', err.message));
  }, 5000);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});
