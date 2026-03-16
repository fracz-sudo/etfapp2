import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

async function test() {
  const html = await gotScraping({
    url: 'https://www.justetf.com/en/how-to/invest-in-uranium.html',
    headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 100 }], locales: ['en-US'], operatingSystems: ['windows'] },
    timeout: { request: 20000 }
  }).then(r => r.body);

  const $ = cheerio.load(html);

  const trs = $('table[class*="dt-etf-param"]').first().find('tbody').first().find('tr');
  console.log('Total TRs in tbody:', trs.length);
  
  trs.each((i, tr) => {
    const a = $(tr).find('a[href*="isin="]').first();
    console.log(i, a.text().trim(), $(tr).attr('class'));
  });
}

test().catch(console.error);
