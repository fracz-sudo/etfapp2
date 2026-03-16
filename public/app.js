// ─── DOM Elements ───────────────────────────────────────────────
const categoriesSection = document.getElementById('categoriesSection');
const categoriesContent = document.getElementById('categoriesContent');

const resultsSection = document.getElementById('resultsSection');
const resultsTitle = document.getElementById('resultsTitle');
const resultsSubtitle = document.getElementById('resultsSubtitle');
const resultsLoading = document.getElementById('resultsLoading');
const resultsError = document.getElementById('resultsError');
const resultsErrorText = document.getElementById('resultsErrorText');
const retryResults = document.getElementById('retryResults');
const etfCards = document.getElementById('etfCards');
const loadAllContainer = document.getElementById('loadAllContainer');
const loadAllBtn = document.getElementById('loadAllBtn');
const summaryTableWrap = document.getElementById('summaryTableWrap');
const summaryTableBody = document.getElementById('summaryTableBody');

const backBtn = document.getElementById('backBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

let currentCategoryUrl = null;
let currentCategoryName = null;
let currentEtfs = [];

// ─── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadCategories);
retryResults.addEventListener('click', () => {
  if (currentCategoryUrl) loadETFs(currentCategoryUrl, currentCategoryName);
});
if (loadAllBtn) {
  loadAllBtn.addEventListener('click', () => {
    if (currentCategoryUrl) loadETFs(currentCategoryUrl, currentCategoryName, true);
  });
}
backBtn.addEventListener('click', showCategories);
clearCacheBtn.addEventListener('click', clearCache);
if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportToCsv);

// ─── Load & Render Categories ───────────────────────────────────
async function loadCategories() {
  categoriesContent.innerHTML = `
    <div class="loading-state">
      <div class="loading-pulse">
        <div class="pulse-ring"></div>
        <div class="pulse-ring"></div>
        <svg class="loading-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      </div>
      <p class="loading-text">Načítám kategorie…</p>
    </div>
  `;

  try {
    const res = await fetch('/api/categories');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Neznámá chyba');
    renderCategories(json.data);
  } catch (err) {
    categoriesContent.innerHTML = `
      <div class="error-state">
        <div class="error-icon-wrap">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        </div>
        <p class="error-text">${escapeHTML(err.message || 'Nepodařilo se načíst kategorie.')}</p>
        <button class="btn-primary" onclick="loadCategories()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          Zkusit znovu
        </button>
      </div>
    `;
  }
}

function renderCategories(categories) {
  // Group by .group property
  const groups = {};
  categories.forEach(cat => {
    const g = cat.group || 'Ostatní';
    if (!groups[g]) groups[g] = [];
    groups[g].push(cat);
  });

  let html = '';
  for (const [groupName, cats] of Object.entries(groups)) {
    html += `
      <div class="category-group">
        <div class="category-group-title">${escapeHTML(groupName)}</div>
        <div class="categories-grid">
          ${cats.map(cat => `
            <div class="category-card" data-url="${escapeAttr(cat.url)}" data-name="${escapeAttr(cat.name)}">
              <span class="name">${escapeHTML(cat.name)}</span>
              <span class="arrow">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  categoriesContent.innerHTML = html;

  // Attach click handlers
  document.querySelectorAll('.category-card').forEach(card => {
    card.addEventListener('click', () => {
      const url = card.dataset.url;
      const name = card.dataset.name;
      currentCategoryUrl = url;
      currentCategoryName = name;
      loadETFs(url, name);
    });
  });
}

// ─── Load ETFs for Category ─────────────────────────────────────
async function loadETFs(url, name, isLoadAll = false) {
  categoriesSection.style.display = 'none';
  resultsSection.style.display = 'block';

  resultsTitle.textContent = name;
  resultsSubtitle.textContent = isLoadAll ? 'Všechny dostupné ETF fondy dle AUM' : 'Top 6 ETF fondů dle AUM';

  resultsLoading.style.display = 'flex';
  resultsError.style.display = 'none';
  etfCards.innerHTML = '';
  summaryTableWrap.style.display = 'none';
  if (loadAllContainer) loadAllContainer.style.display = 'none';

  try {
    const fetchUrl = isLoadAll 
      ? `/api/etfs?url=${encodeURIComponent(url)}&limit=all` 
      : `/api/etfs?url=${encodeURIComponent(url)}`;
      
    const res = await fetch(fetchUrl);
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'Neznámá chyba');

    if (!json.data || json.data.length === 0) {
      resultsLoading.style.display = 'none';
      etfCards.innerHTML = `
        <div class="loading-state" style="padding: 40px;">
          <p class="loading-text" style="color: var(--text-secondary);">V této kategorii nebyly nalezeny žádné ETF fondy.</p>
        </div>
      `;
      currentEtfs = [];
      return;
    }

    currentEtfs = json.allEtfs || json.data;
    renderETFs(json.data, json.allEtfs);

    // Show or hide "Load All" button
    if (json.hasMore && !isLoadAll && loadAllContainer) {
      loadAllContainer.style.display = 'block';
    }
  } catch (err) {
    resultsLoading.style.display = 'none';
    resultsError.style.display = 'flex';
    resultsErrorText.textContent = err.message || 'Nepodařilo se načíst ETF fondy.';
  }
}

// ─── Render ETF Cards ───────────────────────────────────────────
function renderETFs(etfs, allEtfs) {
  resultsLoading.style.display = 'none';
  etfCards.innerHTML = '';

  etfs.forEach((etf, i) => {
    const profileUrl = `https://www.justetf.com/en/etf-profile.html?isin=${etf.isin}`;
    const card = document.createElement('div');
    card.className = 'etf-card';

    card.innerHTML = `
      <div class="etf-card-header">
        <span class="etf-card-rank">${i + 1}</span>
        <div class="etf-card-title-group">
          <div class="etf-card-name">
            <a href="${profileUrl}" target="_blank" rel="noopener" title="Otevřít na justetf.com">${escapeHTML(etf.name || 'N/A')}</a>
          </div>
          <span class="etf-card-isin">${escapeHTML(etf.isin)}</span>
        </div>
      </div>
      <div class="etf-params">
        <div class="etf-param">
          <span class="etf-param-label">Měna fondu</span>
          <span class="etf-param-value">${escapeHTML(etf.currency || 'N/A')}</span>
        </div>
        <div class="etf-param">
          <span class="etf-param-label">TER</span>
          <span class="etf-param-value">${escapeHTML(etf.ter || 'N/A')}</span>
        </div>
        <div class="etf-param">
          <span class="etf-param-label">AUM</span>
          <span class="etf-param-value">${escapeHTML(etf.aum || 'N/A')}</span>
        </div>
        <div class="etf-param">
          <span class="etf-param-label">Distribuce výnosů</span>
          <span class="etf-param-value">${escapeHTML(etf.distribution || 'N/A')}</span>
        </div>
        <div class="etf-param">
          <span class="etf-param-label">Replikační metoda</span>
          <span class="etf-param-value">${escapeHTML(etf.replication || 'N/A')}</span>
        </div>
        <div class="etf-param">
          <span class="etf-param-label">KID</span>
          <span class="etf-param-value">${escapeHTML(etf.kidAvailable || 'N/A')}</span>
        </div>
      </div>
      ${etf.description ? `
        <div class="etf-card-description">
          <div class="desc-label">Popis fondu</div>
          <p>${escapeHTML(etf.description)}</p>
        </div>
      ` : ''}
    `;

    etfCards.appendChild(card);
  });

  renderSummaryTable(allEtfs || etfs);
}

// ─── Summary Table ──────────────────────────────────────────────
function renderSummaryTable(etfs) {
  summaryTableBody.innerHTML = '';

  etfs.forEach(etf => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHTML(etf.name || 'N/A')}</td>
      <td class="isin-cell">${escapeHTML(etf.isin)}</td>
      <td>${escapeHTML(etf.currency || 'N/A')}</td>
      <td>${escapeHTML(etf.ter || 'N/A')}</td>
      <td>${escapeHTML(etf.aum || 'N/A')}</td>
      <td>${escapeHTML(etf.distribution || 'N/A')}</td>
      <td>${escapeHTML(etf.replication || 'N/A')}</td>
    `;
    summaryTableBody.appendChild(row);
  });

  summaryTableWrap.style.display = 'block';
}

// ─── Show Categories (go back) ──────────────────────────────────
function showCategories() {
  resultsSection.style.display = 'none';
  categoriesSection.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Clear Cache ────────────────────────────────────────────────
async function clearCache() {
  try {
    clearCacheBtn.classList.remove('success');
    const res = await fetch('/api/cache/clear');
    const json = await res.json();
    if (json.success) {
      clearCacheBtn.classList.add('success');
      clearCacheBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      `;
      setTimeout(() => {
        clearCacheBtn.classList.remove('success');
        clearCacheBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        `;
      }, 2000);
    }
  } catch {
    // silently fail
  }
}

// ─── Export CSV ───────────────────────────────────────────────────
function exportToCsv() {
  if (!currentEtfs || currentEtfs.length === 0) return;

  const headers = ['Název', 'ISIN', 'Měna fondu', 'TER', 'AUM (mil. EUR)', 'Distribuce výnosů', 'Replikační metoda'];
  const rows = currentEtfs.map(etf => {
    return [
      escapeCsv(etf.name || 'N/A'),
      escapeCsv(etf.isin || ''),
      escapeCsv(etf.currency || 'N/A'),
      escapeCsv(etf.ter || 'N/A'),
      escapeCsv(etf.aum || 'N/A'),
      escapeCsv(etf.distribution || 'N/A'),
      escapeCsv(etf.replication || 'N/A')
    ].join(';');
  });

  // Skutečný BOM (\uFEFF) a správné nové řádky pro Windows/Excel (\r\n)
  const csvContent = "\uFEFF" + [headers.join(';'), ...rows].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  
  const safeName = (currentCategoryName || 'etf_list').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  
  link.setAttribute('href', url);
  link.setAttribute('download', `${safeName}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function escapeCsv(str) {
  if (str === null || str === undefined) return '""';
  const stringified = String(str);
  // Pokud obsahuje středníky, uvozovky nebo konce řádků, obalit do uvozovek
  if (stringified.includes(';') || stringified.includes('"') || stringified.includes('\n')) {
    return '"' + stringified.replace(/"/g, '""') + '"';
  }
  return stringified;
}

// ─── Utilities ──────────────────────────────────────────────────
function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
