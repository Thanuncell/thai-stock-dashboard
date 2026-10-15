const DEFAULT_WATCHLIST = [
  { symbol: 'PTT', name: 'ปตท.' },
  { symbol: 'AOT', name: 'ท่าอากาศยานไทย' },
  { symbol: 'ADVANC', name: 'แอดวานซ์ อินโฟร์' },
  { symbol: 'KBANK', name: 'ธนาคารกสิกรไทย' },
  { symbol: 'CPALL', name: 'ซีพี ออลล์' }
];
const MAX_WATCHLIST = 30;
const MAX_WATCHLISTS = 5;
const THAI_NAMES = Object.fromEntries(DEFAULT_WATCHLIST.map(x => [x.symbol, x.name]));
const $ = selector => document.querySelector(selector);
const apiFetch = (url, options) => window.setscopeAuth.authorizedFetch(url, options);
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
let watchlists = loadWatchlists();
let activeWatchlistId = localStorage.getItem('setscope-active-watchlist') || 'list-1';
if (!watchlists.some(list => list.id === activeWatchlistId)) activeWatchlistId = watchlists[0].id;
let watchlist = currentWatchlist().items;
let activeSymbol = watchlist[0]?.symbol || 'PTT';
let activeName = watchlist[0]?.name || 'ปตท.';
let latestMarket = null;
let latestMarketSymbol = '';
let latestMarketRange = '';
let activeSource = 'all';
let latestNews = [];
let latestWatchlistNews = [];
const newsAnalyses = new Map();
let newsAnalysisPending = false;
let watchlistNewsRequestId = 0;
let searchTimer;
let searchSequence = 0;
let currentRange = '1D';
const chartIndicators = new Set(['sma20', 'ema20', 'ema50']);
let alertPrefs = readLocal('setscope-alert-prefs', {});
let alertStates = readLocal('setscope-alert-states', {});
let alertHistory = readLocal('setscope-alert-history', []);
let unreadAlerts = 0;
let watchlistCloudReady = false;
let watchlistSyncTimer = null;
let watchlistSyncChain = Promise.resolve();

function setWatchlistSyncStatus(text, state = '') {
  ['#watchlist-sync-status', '#watchlist-sync-status-mobile'].forEach(selector => {
    const el = $(selector); if (el) { el.textContent = text; el.dataset.state = state; }
  });
}
const workspaceRoutes = {
  overview: { nodes: ['#market-overview', '#market-data-overview'], title: 'ตลาดหุ้นไทย <span>วันนี้</span>', description: 'ดูภาพรวมดัชนีและข้อมูลตลาดหุ้นไทย' },
  chart: { nodes: ['#chart-section'], title: 'กราฟ<span>เทคนิค</span>', description: 'ค้นหาหุ้น ดูกราฟราคา และอ่านเหตุผลประกอบสัญญาณ' },
  news: { nodes: ['#activity-section', '#news-section'], title: 'ข่าวและ<span>บทวิเคราะห์</span>', description: 'ติดตามข่าวหุ้นไทยจากแหล่งข่าวที่เลือกได้' },
  watchlist: { nodes: ['#watchlist-page', '#movers-section'], title: 'รายการ<span>ติดตาม</span>', description: 'จัดการหุ้นที่บันทึกไว้และดูข่าวของหุ้นในรายการที่เลือก' }
};
function pageFromHash(hash = location.hash) {
  const key = String(hash || '').replace(/^#/, '');
  if (workspaceRoutes[key]) return key;
  if (key === 'chart-section') return 'chart';
  if (key === 'news-section') return 'news';
  if (key === 'top' || key === 'watchlist') return key === 'watchlist' ? 'watchlist' : 'overview';
  return 'overview';
}
function setWorkspacePage(page, updateHash = true) {
  if (!workspaceRoutes[page]) page = 'overview';
  const visible = new Set(workspaceRoutes[page].nodes);
  ['#market-overview', '#market-data-overview', '#chart-section', '#activity-section', '#news-section', '#movers-section', '#watchlist-page'].forEach(selector => {
    const node = $(selector); if (node) node.classList.toggle('workspace-hidden', !visible.has(selector));
  });
  $('#activity-section')?.classList.toggle('workspace-single', page === 'news' || page === 'watchlist');
  document.body.dataset.workspacePage = page;
  document.querySelectorAll('.nav-item[data-workspace-route]').forEach(link => {
    const active = link.dataset.workspaceRoute === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const heading = workspaceRoutes[page];
  $('#workspace-title').innerHTML = heading.title;
  $('#workspace-description').textContent = heading.description;
  if (updateHash && location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setupWorkspaceNavigation() {
  document.querySelectorAll('.nav-item[data-workspace-route]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); setWorkspacePage(link.dataset.workspaceRoute);
  }));
  window.addEventListener('hashchange', () => setWorkspacePage(pageFromHash(), false));
  window.addEventListener('popstate', () => setWorkspacePage(pageFromHash(), false));
  setWorkspacePage(pageFromHash(), false);
}
function persistWatchlistsLocal() {
  currentWatchlist().items = watchlist;
  localStorage.setItem('setscope-watchlists', JSON.stringify(watchlists));
  localStorage.setItem('setscope-watchlist', JSON.stringify(watchlist));
  localStorage.setItem('setscope-active-watchlist', activeWatchlistId);
}
function scheduleWatchlistCloudSync() {
  persistWatchlistsLocal();
  if (!watchlistCloudReady) return;
  clearTimeout(watchlistSyncTimer);
  setWatchlistSyncStatus('กำลังซิงก์…', 'pending');
  watchlistSyncTimer = setTimeout(() => {
    const payload = { watchlists: JSON.parse(JSON.stringify(watchlists)), activeWatchlistId };
    watchlistSyncChain = watchlistSyncChain.catch(() => {}).then(async () => {
      const response = await apiFetch('/api/watchlists', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.retryable ? 'ระบบกำลังเริ่มทำงาน' : (result.error || 'Sync failed'));
      setWatchlistSyncStatus('ซิงก์แล้ว', 'synced');
    }).catch(error => setWatchlistSyncStatus(error?.message?.includes('กำลังเริ่มทำงาน') ? 'ระบบกำลังเริ่มทำงาน · เก็บในเครื่องชั่วคราว' : 'ซิงก์ไม่ได้ · เก็บในเครื่อง', 'error'));
  }, 450);
}
function mergeWatchlists(localLists, cloudLists) {
  const merged = (Array.isArray(cloudLists) ? cloudLists : []).slice(0, MAX_WATCHLISTS).map((list, i) => ({ id: String(list.id || `list-${i + 1}`), name: String(list.name || `Watchlist ${i + 1}`), items: Array.isArray(list.items) ? list.items.filter(item => item && /^[A-Z0-9&.-]{1,20}$/.test(item.symbol || '')).slice(0, MAX_WATCHLIST) : [] }));
  for (const local of localLists) {
    let target = merged.find(list => list.id === local.id);
    if (!target && merged.length < MAX_WATCHLISTS) { target = { ...local, items: [] }; merged.push(target); }
    if (!target) continue;
    const seen = new Set(target.items.map(item => item.symbol));
    for (const item of local.items) if (!seen.has(item.symbol) && target.items.length < MAX_WATCHLIST) { target.items.push(item); seen.add(item.symbol); }
  }
  return merged.length ? merged : loadWatchlists();
}
async function initializeWatchlistCloudSync() {
  watchlistCloudReady = false;
  setWatchlistSyncStatus('กำลังโหลด…', 'pending');
  const localLists = JSON.parse(JSON.stringify(watchlists));
  const localActive = activeWatchlistId;
  try {
    const response = await apiFetch('/api/watchlists');
    const data = await response.json();
    if (!response.ok) throw new Error(data.retryable ? 'ระบบกำลังเริ่มทำงาน' : (data.error || 'โหลด Watchlist ไม่สำเร็จ'));
    const record = data.record;
    if (record && Array.isArray(record.watchlists)) {
      watchlists = mergeWatchlists(localLists, record.watchlists);
      activeWatchlistId = watchlists.some(list => list.id === record.active_watchlist_id) ? record.active_watchlist_id : (watchlists.some(list => list.id === localActive) ? localActive : watchlists[0].id);
      watchlist = currentWatchlist().items;
    } else {
      watchlists = localLists;
      activeWatchlistId = watchlists.some(list => list.id === localActive) ? localActive : watchlists[0].id;
      watchlist = currentWatchlist().items;
    }
    persistWatchlistsLocal();
    watchlistCloudReady = true;
    setWatchlistSyncStatus('ซิงก์แล้ว', 'synced');
    // First-time sync also uploads this device's existing Watchlist.
    scheduleWatchlistCloudSync();
  } catch (error) {
    watchlist = currentWatchlist().items;
    setWatchlistSyncStatus(error?.message?.includes('กำลังเริ่มทำงาน') ? 'ระบบกำลังเริ่มทำงาน · ใช้ข้อมูลในเครื่องชั่วคราว' : 'ซิงก์ไม่ได้ · เก็บในเครื่อง', 'error');
  }
}

function readLocal(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch (_) { return fallback; }
}

function loadWatchlists() {
  try {
    const savedLists = JSON.parse(localStorage.getItem('setscope-watchlists') || 'null');
    if (Array.isArray(savedLists) && savedLists.length) {
      return savedLists.slice(0, MAX_WATCHLISTS).map((list, i) => ({ id: list.id || `list-${i + 1}`, name: list.name || `Watchlist ${i + 1}`, items: (Array.isArray(list.items) ? list.items : []).filter(x => x && /^[A-Z0-9&.-]{1,20}$/.test(x.symbol || '')).slice(0, MAX_WATCHLIST) }));
    }
  } catch (_) {}
  let legacy = DEFAULT_WATCHLIST;
  try { const old = JSON.parse(localStorage.getItem('setscope-watchlist') || 'null'); if (Array.isArray(old)) legacy = old; } catch (_) {}
  const first = legacy.filter(x => x && /^[A-Z0-9&.-]{1,20}$/.test(x.symbol || '')).slice(0, MAX_WATCHLIST);
  const lists = [{ id: 'list-1', name: 'Watchlist 1', items: first }];
  localStorage.setItem('setscope-watchlists', JSON.stringify(lists));
  return lists;
}
function currentWatchlist() { return watchlists.find(list => list.id === activeWatchlistId) || watchlists[0]; }
function saveWatchlist() { scheduleWatchlistCloudSync(); }
function renderWatchlistPicker() {
  const selected = currentWatchlist();
  const options = watchlists.map(list => `<option value="${escapeHtml(list.id)}" ${list.id === selected.id ? 'selected' : ''}>${escapeHtml(list.name)} (${list.items.length})</option>`).join('');
  ['#watchlist-select', '#watchlist-select-mobile'].forEach(selector => { const el = $(selector); if (el) el.innerHTML = options; });
  let create = $('#watchlist-create');
  if (!create) { create = document.createElement('button'); create.id = 'watchlist-create'; create.type = 'button'; create.className = 'watchlist-create'; create.textContent = '+ ใหม่'; $('#watchlist-select')?.parentElement?.append(create); }
  create.disabled = watchlists.length >= MAX_WATCHLISTS;
  create.title = watchlists.length >= MAX_WATCHLISTS ? 'สร้างได้สูงสุด 5 Watchlist' : 'สร้าง Watchlist ใหม่';
  const mobileCreate = $('#watchlist-create-mobile');
  if (mobileCreate) { mobileCreate.disabled = create.disabled; mobileCreate.title = create.title; }
  const count = document.querySelector('.nav-item[data-workspace-route="watchlist"] .nav-count');
  if (count) count.textContent = String(watchlist.length);
}
function switchWatchlist(id) {
  const chosen = watchlists.find(list => list.id === id); if (!chosen) return;
  activeWatchlistId = id; watchlist = chosen.items; scheduleWatchlistCloudSync();
  if (watchlist.length && !watchlist.some(item => item.symbol === activeSymbol)) { activeSymbol = watchlist[0].symbol; activeName = watchlist[0].name || activeSymbol; updateTradingViewChart(); }
  syncTechnicalSearch();
  renderWatchlistPicker(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); renderMovers(latestMarket?.stocks || []); updateWatchlistAddButton(); getMarket(); getWatchlistNews();
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(+date) ? value : date.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short'
  });
}
function setText(selector, value) { const el = $(selector); if (el) el.textContent = value; }
function renderSettradeOverview(data) {
  const indices = data.indices || [];
  $('#market-index-grid').innerHTML = ['SET', 'mai', 'TFEX'].map(symbol => {
    if (symbol === 'TFEX') return `<article class="market-index-card market-index-card-tfex"><span>TFEX</span><strong>ดูข้อมูลต้นทาง</strong><small>ข้อมูลล่าช้า 15 นาที · อ้างอิงแหล่งข้อมูลด้านล่าง</small></article>`;
    const item = indices.find(row => row.symbol === symbol);
    if (!item) return `<article class="market-index-card"><span>${symbol}</span><strong>—</strong><small>ต้นทางยังไม่ส่งข้อมูล</small></article>`;
    const trend = Number(item.change) > 0 ? 'up' : Number(item.change) < 0 ? 'down' : 'neutral';
    const arrow = Number(item.change) > 0 ? '▲' : Number(item.change) < 0 ? '▼' : '•';
    return `<article class="market-index-card"><span>${symbol}</span><strong>${number(item.last)}</strong><small class="${trend}">${arrow} ${number(Math.abs(Number(item.change || 0)))} (${number(item.changePercent)}%) · มูลค่า ${number(item.turnoverMillion)} ลบ.</small></article>`;
  }).join('');
  const setIndex = indices.find(row => row.symbol === 'SET');
  if (setIndex) {
    const change = Number(setIndex.change || 0), pct = Number(setIndex.changePercent || 0);
    $('#set-index').innerHTML = `${number(setIndex.last)} <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${number(Math.abs(change))} (${pct.toFixed(2)}%)</span>`;
    setText('#set-volume', `${number(Number(setIndex.volumeThousand || 0) * 1000)} หุ้น`);
    setText('#set-range', `${number(setIndex.high)} / ${number(setIndex.low)}`);
    setText('#set-turnover', `${number(setIndex.turnoverMillion)} ล้านบาท`);
    $('#set-turnover').title = 'มูลค่าซื้อขายจากหน้า SETTRADE · หน่วยล้านบาท';
  }
  const breadthLabels = { Gainers: 'ปรับขึ้น', Unchanges: 'ไม่เปลี่ยนแปลง', Losers: 'ปรับลง' };
  const breadth = data.breadth || [];
  const breadthTotals = breadth.flatMap(group => group.items || []).reduce((totals, item) => {
    if (/gainers/i.test(item.label || '')) totals.up += Number(item.count || 0);
    if (/losers/i.test(item.label || '')) totals.down += Number(item.count || 0);
    return totals;
  }, { up: 0, down: 0 });
  const condition = breadth.length ? breadthTotals.up > breadthTotals.down ? 'หุ้นปรับขึ้นมากกว่าปรับลง' : breadthTotals.up < breadthTotals.down ? 'หุ้นปรับลงมากกว่าปรับขึ้น' : 'หุ้นปรับขึ้นและลงใกล้เคียงกัน' : 'ยังไม่มีข้อมูล breadth';
  const conditionNode = $('#market-condition');
  if (conditionNode) { conditionNode.textContent = `ภาวะตลาด: ${condition}`; conditionNode.className = `market-condition ${breadthTotals.up > breadthTotals.down ? 'up' : breadthTotals.up < breadthTotals.down ? 'down' : ''}`; }
  $('#market-breadth-list').innerHTML = breadth.length ? breadth.map(group => `<div class="market-breadth-group"><b>${escapeHtml(group.market)}</b>${(group.items || []).map(item => {
    const key = Object.keys(breadthLabels).find(label => item.label?.toLowerCase().includes(label.toLowerCase()));
    return `<div><span>${breadthLabels[key] || escapeHtml(item.label)}</span><strong>${number(item.count)} หุ้น</strong><small>${number(item.volumeThousand)} พันหุ้น</small></div>`;
  }).join('')}</div>`).join('') : '<p class="market-empty">หน้า SETTRADE ยังไม่มีสถิติหุ้นขึ้น–ลงรอบนี้</p>';
  setText('#market-close-summary', data.closeSummary || 'SETTRADE ยังไม่เผยแพร่สรุปซื้อขายสิ้นวันรอบนี้');
  const nvdr = data.nvdr || {};
  $('#nvdr-metrics').innerHTML = `<div><small>มูลค่าตลาด SET + mai</small><strong>${number(nvdr.marketMillion)}</strong><em>ล้านบาท</em></div><div><small>มูลค่าซื้อขาย NVDR</small><strong>${number(nvdr.nvdrMillion)}</strong><em>ล้านบาท</em></div><div><small>สัดส่วน NVDR</small><strong>${number(nvdr.ratioPercent)}</strong><em>%</em></div>`;
  const foreign = data.foreign || {};
  const net = Number(foreign.netMillion);
  $('#foreign-flow').innerHTML = `<span>ซื้อสุทธิต่างชาติ (รายวัน)</span><strong class="${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${net > 0 ? '+' : ''}${number(foreign.netMillion)}</strong><small>ล้านบาท · ${escapeHtml(foreign.date || 'วันที่อัปเดตยังไม่ทราบ')}</small>`;
  setText('#active-value-status', data.activeValueStatus || 'ตารางจัดอันดับยังโหลดไม่สำเร็จจากต้นทาง');
  setText('#settrade-updated', data.stale ? `ใช้ข้อมูล SETTRADE ที่บันทึกล่าสุด · ${stamp(data.fetchedAt)}` : `ข้อมูลจาก SETTRADE · ดึงล่าสุด ${stamp(data.fetchedAt)}`);
  setText('#market-data-date', data.marketDate ? `ข้อมูลนักลงทุน ณ ${data.marketDate}` : 'แสดงเวลาที่ดึงข้อมูลจาก SETTRADE');
}
async function getSettradeOverview(force = false) {
  const button = $('#refresh-market-data');
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.classList.add('is-loading'); button.textContent = 'กำลังอัปเดต…'; }
  setText('#settrade-updated', 'กำลังดึงข้อมูลจาก SETTRADE…');
  try {
    const response = await apiFetch(`/api/settrade-overview${force ? '?refresh=1' : ''}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ดึงข้อมูลจาก SETTRADE ไม่สำเร็จ');
    renderSettradeOverview(data);
  } catch (error) {
    console.warn('SETTRADE overview refresh failed', error);
    setText('#settrade-updated', 'ดึงข้อมูลไม่สำเร็จ · ตรวจสอบข้อมูลโดยตรงที่ SETTRADE');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-loading'); button.textContent = '↻ อัปเดตข้อมูลตลาด'; }
  }
}
function syncTechnicalSearch() { const input = $('#stock-search'); if (input && activeSymbol) input.value = activeSymbol; }
function setNewsStatus(text) { const el = $('.news-foot span'); if (el) el.textContent = text; }
function updateWatchlistAddButton() {
  const button = $('#watchlist-add-active');
  if (!button) return;
  const saved = watchlist.some(item => item.symbol === activeSymbol);
  button.disabled = saved;
  button.textContent = saved ? '✓ อยู่ใน Watchlist' : '＋ เพิ่มเข้า Watchlist';
}

function renderWatchlist(rows = []) {
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  const markup = watchlist.length ? watchlist.map(item => {
    const quote = bySymbol[item.symbol];
    const change = quote ? Number(quote.last) - Number(quote.prior) : null;
    const percent = quote && Number(quote.prior) ? change / Number(quote.prior) * 100 : null;
    return `<div class="watch-item ${activeSymbol === item.symbol ? 'selected' : ''}" data-sym="${escapeHtml(item.symbol)}" data-name="${escapeHtml(item.name || item.symbol)}">
      <div class="watch-details"><span class="watch-symbol">${escapeHtml(item.symbol)}</span><span class="watch-name">${escapeHtml(item.name || item.symbol)}</span></div>
      <div class="watch-quote"><span class="watch-price">${quote ? number(quote.last) : '—'}</span>${percent === null ? '' : `<span class="watch-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${percent.toFixed(2)}%</span>`}</div>
      <button class="watch-remove" type="button" data-remove="${escapeHtml(item.symbol)}" aria-label="ลบ ${escapeHtml(item.symbol)}" title="นำออกจากรายการ">×</button>
    </div>`;
  }).join('') : '<div class="watch-empty">ยังไม่มีหุ้นในรายการ · เลือกหุ้นในกราฟแล้วกดเพิ่มเข้า Watchlist</div>';
  $('#watchlist').innerHTML = markup;
  $('#watchlist-mobile').innerHTML = markup;
  renderWatchlistPicker();
  setText('.nav-count', String(watchlist.length));
  setText('#watch-metric', String(watchlist.length));
  updateWatchlistAddButton();
}

function updateTradingViewChart() {
  if (latestMarketSymbol !== activeSymbol || latestMarketRange !== currentRange) {
    renderPriceChart([]);
    return;
  }
  renderPriceChart(latestMarket?.history || [], latestMarket?.fetchedAt);
}

function renderPriceChart(bars = [], fetchedAt = '') {
  const host = $('#stock-price-chart');
  if (!host) return;
  const rows = (bars || []).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(Number(value))) && Number(bar.close) > 0);
  if (!rows.length) {
    host.innerHTML = '<div class="chart-empty">กำลังโหลดข้อมูลกราฟจาก Yahoo Finance…</div>';
    return;
  }
  const width = 960, height = 370, left = 70, right = 16, top = 18, priceBottom = 278, volumeBottom = 335;
  const plotWidth = width - left - right;
  const lows = rows.map(row => Number(row.low)), highs = rows.map(row => Number(row.high));
  const minPrice = Math.min(...lows), maxPrice = Math.max(...highs);
  const pad = Math.max((maxPrice - minPrice) * .08, maxPrice * .003, .01);
  const min = minPrice - pad, max = maxPrice + pad, span = max - min || 1;
  const y = value => top + (max - value) / span * (priceBottom - top);
  const step = plotWidth / rows.length, candleWidth = Math.max(2, Math.min(12, step * .62));
  const x = index => left + step * index + step / 2;
  const volumeMax = Math.max(...rows.map(row => Number(row.volume) || 0), 1);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max - span * index / 4, py = y(value);
    return `<line class="chart-grid" x1="${left}" y1="${py}" x2="${width - right}" y2="${py}"/><text class="chart-axis-text" x="${left - 9}" y="${py + 3}" text-anchor="end">${number(value)}</text>`;
  }).join('');
  const candles = rows.map((bar, index) => {
    const open = Number(bar.open), close = Number(bar.close), high = Number(bar.high), low = Number(bar.low);
    const rising = close >= open, cx = x(index), bodyTop = Math.min(y(open), y(close)), bodyHeight = Math.max(1.4, Math.abs(y(open) - y(close)));
    const volume = Math.max(0, Number(bar.volume) || 0), volumeHeight = volume / volumeMax * (volumeBottom - priceBottom - 6);
    const date = new Date(bar.time);
    const dateText = Number.isNaN(+date) ? '' : date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: currentRange === '1D' || currentRange === '1W' ? '2-digit' : undefined, minute: currentRange === '1D' || currentRange === '1W' ? '2-digit' : undefined });
    const detail = `${dateText} · O ${number(open)} · H ${number(high)} · L ${number(low)} · C ${number(close)} · Vol ${number(volume)}`;
    return `<g class="price-candle ${rising ? 'rising' : 'falling'}"><title>${escapeHtml(detail)}</title><line x1="${cx}" y1="${y(high)}" x2="${cx}" y2="${y(low)}"/><rect x="${cx - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" rx=".8"/><rect class="volume-bar" x="${cx - candleWidth / 2}" y="${volumeBottom - volumeHeight}" width="${candleWidth}" height="${volumeHeight}"/><rect class="candle-hit" x="${cx - Math.max(candleWidth, step) / 2}" y="${top}" width="${Math.max(candleWidth, step)}" height="${volumeBottom - top}"/></g>`;
  }).join('');
  const smaValues = rows.map((_, index) => index < 19 ? null : rows.slice(index - 19, index + 1).reduce((sum, row) => sum + Number(row.close), 0) / 20);
  const indicators = [
    ['sma20', smaValues, 'sma20-chart-line'],
    ['ema20', computeEma(rows.map(row => Number(row.close)), 20), 'ema20-chart-line'],
    ['ema50', computeEma(rows.map(row => Number(row.close)), 50), 'ema50-chart-line'],
    ['ema100', computeEma(rows.map(row => Number(row.close)), 100), 'ema100-chart-line'],
    ['ema200', computeEma(rows.map(row => Number(row.close)), 200), 'ema200-chart-line']
  ].filter(([key]) => chartIndicators.has(key)).map(([, values, className]) => {
    const points = values.map((value, index) => value == null ? '' : `${x(index)},${y(value)}`).filter(Boolean).join(' ');
    return points ? `<polyline class="${className}" points="${points}"/>` : '';
  }).join('');
  const labelIndices = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1])];
  const dateLabels = labelIndices.map(index => {
    const date = new Date(rows[index].time);
    const label = Number.isNaN(+date) ? '' : date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', ...(currentRange === '1D' ? { hour: '2-digit', minute: '2-digit' } : {}) });
    return `<text class="chart-axis-text" x="${x(index)}" y="357" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join('');
  const updated = fetchedAt ? new Date(fetchedAt).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '—';
  host.innerHTML = `<div class="chart-svg-scroll"><svg class="price-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="กราฟแท่งเทียน ${escapeHtml(activeSymbol)} ช่วง ${escapeHtml(currentRange)}"><text class="chart-label" x="${left}" y="12">${escapeHtml(activeSymbol)} · ${escapeHtml(currentRange)} · อัปเดต ${escapeHtml(updated)} (เวลาไทย)</text>${grid}<line class="chart-volume-separator" x1="${left}" y1="${priceBottom + 5}" x2="${width - right}" y2="${priceBottom + 5}"/>${candles}${indicators}<text class="chart-axis-text" x="${left}" y="${volumeBottom + 13}">VOL</text>${dateLabels}</svg></div>`;
}

function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('setscope-theme', next);
  setText('#theme-icon', next === 'dark' ? '☀' : '☾');
  setText('#theme-label', next === 'dark' ? 'โหมดสว่าง' : 'โหมดมืด');
  $('#theme-toggle')?.setAttribute('aria-label', next === 'dark' ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด');
  updateTradingViewChart();
}

function showSuggestions(items, message = '') {
  const box = $('#symbol-suggestions');
  if (message) {
    box.innerHTML = `<div class="suggestion-message">${escapeHtml(message)}</div>`;
  } else if (!items.length) {
    box.innerHTML = '<div class="suggestion-message">ไม่พบหุ้นที่ตรงกันในข้อมูล Yahoo Finance</div>';
  } else {
    box.innerHTML = items.map(item => `<button class="suggestion-item" type="button" role="option" data-symbol="${escapeHtml(item.symbol)}" data-name="${escapeHtml(item.name)}">
      <span class="suggestion-ticker">${escapeHtml(item.symbol)}</span><span class="suggestion-name">${escapeHtml(item.name)}</span><small>${escapeHtml(item.exchange)} · เลือกเพื่อดูกราฟ</small>
    </button>`).join('');
  }
  box.classList.add('visible');
}
function hideSuggestions() { $('#symbol-suggestions').classList.remove('visible'); }
async function searchStocks(query) {
  const sequence = ++searchSequence;
  if (!query.trim()) { hideSuggestions(); return; }
  showSuggestions([], 'กำลังค้นหาหุ้น…');
  try {
    const response = await apiFetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
    const data = await response.json();
    if (sequence !== searchSequence) return;
    if (!response.ok) throw new Error(data.error || 'ค้นหาหุ้นไม่สำเร็จ');
    showSuggestions(data.items || []);
  } catch (error) {
    if (sequence === searchSequence) showSuggestions([], error.message || 'ค้นหาหุ้นไม่สำเร็จ');
  }
}
async function selectStock(symbol, name = symbol) {
  symbol = String(symbol || '').trim().toUpperCase().replace(/\.BK$/, '');
  if (!/^[A-Z0-9&.-]{1,20}$/.test(symbol)) { showSuggestions([], 'ชื่อย่อหุ้นไม่ถูกต้อง'); return; }
  activeSymbol = symbol;
  activeName = name || symbol;
  syncTechnicalSearch();
  setText('#chart-name', activeName);
  setText('#chart-meta', `SET:${activeSymbol} · ${activeName} · THB`);
  renderWatchlist(latestMarket?.stocks || []);
  hideSuggestions();
  renderNews(latestNews.filter(item => activeSource === 'all' || item.source === activeSource));
  updateTradingViewChart();
  await getMarket();
}
async function addActiveToWatchlist() {
  const symbol = activeSymbol;
  if (watchlist.some(item => item.symbol === symbol)) return;
  if (!watchlist.some(item => item.symbol === symbol) && watchlist.length >= MAX_WATCHLIST) {
    showSuggestions([], `รายการติดตามเต็ม ${MAX_WATCHLIST} หุ้นแล้ว กรุณานำหุ้นเดิมออกก่อน`); return;
  }
  if (!watchlist.some(item => item.symbol === symbol)) watchlist.push({ symbol, name: activeName || symbol });
  saveWatchlist();
  renderWatchlist(latestMarket?.stocks || []);
  renderMovers(latestMarket?.stocks || []);
  renderAlertSettings();
  getWatchlistNews();
  await getMarket();
}

function createWatchlist() {
  if (watchlists.length >= MAX_WATCHLISTS) return;
  const id = `list-${Date.now()}`, name = `Watchlist ${watchlists.length + 1}`;
  watchlists.push({ id, name, items: [] }); activeWatchlistId = id; watchlist = currentWatchlist().items;
  saveWatchlist(); renderWatchlistPicker(); renderWatchlist(); renderAlertSettings(); renderMovers([]); getMarket(); getWatchlistNews();
}

let moverMode = 'up';
function renderMovers(rows = []) {
  const list = $('#mover-list'); if (!list) return;
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  const values = watchlist.map(item => ({ ...item, quote: bySymbol[item.symbol] })).filter(item => item.quote && Number.isFinite(Number(item.quote.last)));
  const pct = item => Number(item.quote.prior) ? (Number(item.quote.last) - Number(item.quote.prior)) / Number(item.quote.prior) * 100 : 0;
  values.sort((a, b) => moverMode === 'up' ? pct(b) - pct(a) : moverMode === 'down' ? pct(a) - pct(b) : Number(b.quote.volume || 0) - Number(a.quote.volume || 0));
  list.innerHTML = values.length ? values.map(item => { const change = Number(item.quote.last) - Number(item.quote.prior || 0); return `<button class="mover-row" type="button" data-mover-symbol="${escapeHtml(item.symbol)}" data-mover-name="${escapeHtml(item.name)}"><span><b>${escapeHtml(item.symbol)}</b><small>${escapeHtml(item.name)}</small></span><span class="mover-quote"><b>${number(item.quote.last)}</b><small class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${pct(item).toFixed(2)}%</small></span></button>`; }).join('') : '<div class="mover-empty">ยังไม่มีข้อมูลหุ้นใน Watchlist นี้</div>';
}

function computeEma(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  return values.map((value, index) => index ? value * k + values[index - 1] * (1 - k) : value);
}
function emaAtPeriod(values, period) {
  if (values.length < period) return null;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const k = 2 / (period + 1);
  return values.slice(period).reduce((ema, value) => value * k + ema * (1 - k), seed);
}
function findPriceLevels(bars, last) {
  if (!Number.isFinite(Number(last)) || Number(last) <= 0) return { supports: [], resistances: [] };
  const recent = (bars || []).filter(bar => Number.isFinite(Number(bar.low)) && Number(bar.low) > 0 && Number.isFinite(Number(bar.high)) && Number(bar.high) > 0).slice(-200);
  const supports = [], resistances = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const low = Number(recent[i].low), high = Number(recent[i].high);
    const neighbors = [recent[i - 2], recent[i - 1], recent[i + 1], recent[i + 2]];
    if (Number.isFinite(low) && low < last && neighbors.every(bar => low <= Number(bar.low))) supports.push(low);
    if (Number.isFinite(high) && high > last && neighbors.every(bar => high >= Number(bar.high))) resistances.push(high);
  }
  const softSupports = recent.map(bar => Number(bar.low)).filter(level => level < last);
  const softResistances = recent.map(bar => Number(bar.high)).filter(level => level > last);
  const gap = Math.max(last * 0.005, 0.01);
  const nearest = (levels, ascending) => {
    const selected = [];
    for (const level of [...new Set(levels)].sort((a, b) => ascending ? a - b : b - a)) {
      if (selected.every(item => Math.abs(item - level) >= gap)) selected.push(level);
      if (selected.length === 3) break;
    }
    return selected;
  };
  return {
    supports: nearest(supports, false).length >= 3 ? nearest(supports, false) : nearest([...supports, ...softSupports], false),
    resistances: nearest(resistances, true).length >= 3 ? nearest(resistances, true) : nearest([...resistances, ...softResistances], true)
  };
}
function analyseTechnicals(bars, levelBars = bars) {
  const usable = (bars || []).filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0);
  const values = usable.map(bar => Number(bar.close));
  if (values.length < 30) return null;
  const period = 14;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  const rsi = avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const sma20 = values.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const emas = { ema20: emaAtPeriod(values, 20), ema50: emaAtPeriod(values, 50), ema100: emaAtPeriod(values, 100), ema200: emaAtPeriod(values, 200) };
  const fast = computeEma(values, 12), slow = computeEma(values, 26);
  const macd = fast.map((value, index) => value - slow[index]);
  const signalLine = computeEma(macd, 9);
  const last = values.at(-1);
  const macdDiff = macd.at(-1) - signalLine.at(-1);
  const signals = {
    rsi: rsi < 30 ? 'ซื้อ' : rsi > 70 ? 'ขาย' : 'เป็นกลาง',
    macd: macdDiff > 0 ? 'ซื้อ' : 'ขาย',
    sma: last >= sma20 ? 'ซื้อ' : 'ขาย'
  };
  Object.entries(emas).forEach(([key, value]) => { if (value !== null) signals[key] = last > value ? 'ซื้อ' : last < value ? 'ขาย' : 'เป็นกลาง'; });
  const reasons = [
    { key: 'RSI (14)', signal: signals.rsi, value: `RSI ${rsi.toFixed(1)}`, detail: rsi < 30 ? 'ต่ำกว่า 30: แรงขายมาก อาจเกิดแรงรีบาวด์ แต่ยังไม่ยืนยันว่าราคากลับตัว' : rsi > 70 ? 'สูงกว่า 70: ภาวะซื้อมาก ราคาอาจย่อตัวได้ แต่ในขาขึ้น RSI อาจสูงต่อเนื่อง' : 'อยู่ระหว่าง 30–70: ยังไม่เข้าขอบเขตซื้อมาก/ขายมากตามเกณฑ์ทั่วไป' },
    { key: 'MACD (12, 26, 9)', signal: signals.macd, value: `MACD ${macd.at(-1).toFixed(3)} · Signal ${signalLine.at(-1).toFixed(3)}`, detail: macdDiff > 0 ? 'เส้น MACD อยู่เหนือเส้น Signal โมเมนตัมระยะสั้นเป็นบวก' : 'เส้น MACD อยู่ใต้เส้น Signal โมเมนตัมระยะสั้นเป็นลบ' },
    { key: 'SMA (20)', signal: signals.sma, value: `ราคา ${number(last)} · SMA ${number(sma20)}`, detail: last >= sma20 ? 'ราคาปิดอยู่เหนือค่าเฉลี่ย 20 แท่ง เป็นหลักฐานสนับสนุนแนวโน้มระยะสั้น' : 'ราคาปิดต่ำกว่าค่าเฉลี่ย 20 แท่ง แสดงว่าแนวโน้มระยะสั้นยังอ่อน' },
    { key: 'EMA (20)', signal: signals.ema20, value: `ราคา ${number(last)} · EMA ${number(emas.ema20)}`, detail: `ราคา${last >= emas.ema20 ? 'อยู่เหนือ' : 'อยู่ใต้'}ค่าเฉลี่ย 20 แท่ง ใช้ดูโมเมนตัมระยะสั้น` }
  ];
  for (const [key, period, horizon] of [['ema50', 50, 'ระยะสั้นถึงกลาง'], ['ema100', 100, 'ระยะกลาง'], ['ema200', 200, 'ระยะยาว']]) {
    if (emas[key] === null) continue;
    reasons.push({ key: `EMA (${period})`, signal: signals[key], value: `ราคา ${number(last)} · EMA ${number(emas[key])}`, detail: `ราคา${last >= emas[key] ? 'อยู่เหนือ' : 'อยู่ใต้'}ค่าเฉลี่ย ${period} แท่ง เป็นหลักฐานแนวโน้ม${horizon}` });
  }
  const buy = Object.values(signals).filter(value => value === 'ซื้อ').length;
  const sell = Object.values(signals).filter(value => value === 'ขาย').length;
  const overall = buy > sell + 1 ? 'ซื้อ' : sell > buy + 1 ? 'ขาย' : 'เป็นกลาง';
  const levels = findPriceLevels(levelBars || usable, last);
  return { values, rsi, sma20, emas, macd: macd.at(-1), macdSignal: signalLine.at(-1), last, signals, reasons, buy, sell, overall, levels, available: Object.keys(signals).length, total: 7 };
}
function updateSignalDonut(buy, hold, sell, total) {
  const donut = $('#signal-donut');
  if (!donut) return;
  const safeTotal = Math.max(0, Number(total) || 0);
  const counts = [Math.max(0, Number(buy) || 0), Math.max(0, Number(hold) || 0), Math.max(0, Number(sell) || 0)];
  const angles = safeTotal ? counts.map(count => `${count / safeTotal * 360}deg`) : ['0deg', '0deg', '0deg'];
  ['--donut-buy-angle', '--donut-hold-angle', '--donut-sell-angle'].forEach((name, index) => donut.style.setProperty(name, angles[index]));
  donut.classList.toggle('no-data', safeTotal === 0);
  const totalNode = $('#signal-total');
  if (totalNode) totalNode.textContent = safeTotal ? String(safeTotal) : '—';
  donut.setAttribute('aria-label', safeTotal ? `สัดส่วนสัญญาณ ซื้อ ${counts[0]} ถือ ${counts[1]} ขาย ${counts[2]} จาก ${safeTotal} สัญญาณ` : 'ยังไม่มีข้อมูลพอสรุปสัญญาณ');
}

function renderPriceLevels(bars, last) {
  const levels = findPriceLevels(bars || [], last);
  for (let i = 0; i < 3; i++) {
    setText(`#support-${i + 1}`, number(levels.supports[i]));
    setText(`#resistance-${i + 1}`, number(levels.resistances[i]));
  }
  setText('#levels-basis', `*แนวรับ–แนวต้านคำนวณจากจุดกลับตัวในกราฟช่วง ${currentRange} (${(bars || []).length} แท่ง) · อาจมีไม่ครบ 3 ระดับ`);
  return levels;
}

function drawSignals(bars, levelBars = bars) {
  const analysis = analyseTechnicals(bars, levelBars);
  if (!analysis) {
    const priceBars = (levelBars || bars || []).filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0);
    renderPriceLevels(levelBars || bars || [], Number(priceBars.at(-1)?.close));
    setText('#analysis-note', `ได้รับข้อมูล ${(bars || []).length} จุด ต้องมีอย่างน้อย 30 แท่งเพื่อสรุปสัญญาณ`);
    $('#technical-reasons').innerHTML = '<p class="reason-empty">ข้อมูลยังไม่พอคำนวณ RSI, MACD และค่าเฉลี่ยให้ครบ</p>';
    setText('#technical-plan', 'รอข้อมูลเพิ่มก่อนสรุปเงื่อนไขที่ควรจับตา');
    ['rsi-signal', 'macd-signal', 'sma-signal', 'ema20-signal', 'ema50-signal', 'ema100-signal', 'ema200-signal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = 'ข้อมูลไม่พอ'; el.className = 'pill neutral-pill'; }
    });
    ['#buy-count', '#neutral-count', '#sell-count'].forEach(id => setText(id, '—'));
    ['#overall-signal', '.signal-score strong'].forEach(id => setText(id, 'รอข้อมูล'));
    updateSignalDonut(0, 0, 0, 0);
    setText('#rsi-value', '—');
    if ($('.rsi-track i')) $('.rsi-track i').style.left = '50%';
    return null;
  }
  const ids = { rsi: 'rsi-signal', macd: 'macd-signal', sma: 'sma-signal', ema20: 'ema20-signal', ema50: 'ema50-signal', ema100: 'ema100-signal', ema200: 'ema200-signal' };
  Object.entries(ids).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const value = analysis.signals[key];
    const requiredBars = { ema20: 20, ema50: 50, ema100: 100, ema200: 200 }[key];
    el.textContent = value || (requiredBars ? `ข้อมูลไม่ครบ (${analysis.values.length}/${requiredBars})` : 'รอข้อมูล');
    el.className = `pill ${value === 'ซื้อ' ? 'buy-pill' : value === 'ขาย' ? 'sell-pill' : 'neutral-pill'}`;
  });
  const hold = analysis.available - analysis.buy - analysis.sell;
  setText('#buy-count', String(analysis.buy)); setText('#sell-count', String(analysis.sell)); setText('#neutral-count', String(hold));
  updateSignalDonut(analysis.buy, hold, analysis.sell, analysis.available);
  setText('#overall-signal', analysis.overall); setText('.signal-score strong', analysis.overall);
  setText('#rsi-value', analysis.rsi.toFixed(1)); $('.rsi-track i').style.left = `${analysis.rsi}%`;
  const supportive = analysis.reasons.filter(reason => reason.signal === 'ซื้อ');
  const opposing = analysis.reasons.filter(reason => reason.signal === 'ขาย');
  const neutral = analysis.reasons.filter(reason => reason.signal === 'เป็นกลาง');
  const group = (title, className, items) => `<div class="reason-group ${className}"><b>${title} (${items.length})</b>${items.length ? `<ul>${items.map(item => `<li><strong>${escapeHtml(item.key)} · ${escapeHtml(item.value)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join('')}</ul>` : '<p>ยังไม่มีหลักฐานจากชุด indicator นี้</p>'}</div>`;
  $('#technical-reasons').innerHTML = group('แรงหนุนฝั่งบวก', 'positive', supportive) + group('แรงกดดัน/เหตุผลฝั่งลบ', 'negative', opposing) + (neutral.length ? group('ยังไม่ชี้ทิศทาง', 'neutral', neutral) : '');
  renderPriceLevels(levelBars || bars || [], analysis.last);
  const support1 = analysis.levels.supports[0], resistance1 = analysis.levels.resistances[0];
  const plan = analysis.overall === 'ซื้อ'
    ? `หลักฐานเอนบวก ${analysis.buy}/${analysis.available} ข้อ · รอการยืนเหนือแนวต้าน 1 ${number(resistance1)} เพื่อยืนยัน; หากปิดต่ำกว่าแนวรับ 1 ${number(support1)} มุมมองนี้อ่อนลง`
    : analysis.overall === 'ขาย'
      ? `หลักฐานเอนลบ ${analysis.sell}/${analysis.available} ข้อ · หากหลุดแนวรับ 1 ${number(support1)} แรงกดดันอาจต่อเนื่อง; การกลับยืนเหนือแนวต้าน 1 ${number(resistance1)} จะทำให้มุมมองลบอ่อนลง`
      : `สัญญาณบวก ${analysis.buy} ข้อและลบ ${analysis.sell} ข้อ · รอราคาเลือกทิศทางเหนือแนวต้าน 1 ${number(resistance1)} หรือหลุดแนวรับ 1 ${number(support1)} ก่อนพิจารณา`;
  setText('#technical-plan', plan);
  setText('#analysis-note', `${analysis.overall === 'ซื้อ' ? 'หลักฐานเอนบวก' : analysis.overall === 'ขาย' ? 'หลักฐานเอนลบ' : 'สัญญาณยังผสม'} · ซื้อ ${analysis.buy} / กลาง ${analysis.available - analysis.buy - analysis.sell} / ขาย ${analysis.sell} · มีข้อมูล ${analysis.available}/${analysis.total} indicators · ช่วง ${currentRange} (${analysis.values.length} แท่ง)`);
  return analysis;
}
function getAlertPref(symbol) { return alertPrefs[symbol] || { technical: true, above: '', below: '' }; }
function renderAlertSettings() {
  const root = $('#alerts-settings');
  setText('#alerts-scope', `${currentWatchlist().name} · แจ้งเตือนเฉพาะหุ้นในรายการนี้ · ทำงานเมื่อเปิดเว็บไว้`);
  if (!watchlist.length) { root.innerHTML = `<p class="alert-empty">${escapeHtml(currentWatchlist().name)} ยังไม่มีหุ้น · เพิ่มหุ้นก่อนตั้งการเตือน</p>`; return; }
  root.innerHTML = watchlist.map(item => {
    const pref = getAlertPref(item.symbol);
    return `<article class="alert-stock-setting" data-alert-symbol="${escapeHtml(item.symbol)}"><header><b>${escapeHtml(item.symbol)}</b><span>${escapeHtml(item.name || item.symbol)}</span></header><label class="alert-check"><input type="checkbox" data-field="technical" ${pref.technical ? 'checked' : ''}> เตือนเมื่อสัญญาณเทคนิคเปลี่ยนเป็นซื้อ/ขาย</label><div class="alert-price-fields"><label>สูงกว่า<input type="number" min="0" step="0.01" data-field="above" value="${escapeHtml(pref.above)}" placeholder="ไม่ตั้ง"></label><label>ต่ำกว่า<input type="number" min="0" step="0.01" data-field="below" value="${escapeHtml(pref.below)}" placeholder="ไม่ตั้ง"></label></div></article>`;
  }).join('');
}
function renderAlertHistory() {
  const root = $('#alerts-history');
  root.innerHTML = alertHistory.length ? alertHistory.slice(0, 8).map(item => `<div class="alert-history-item"><b>${escapeHtml(item.symbol)} · ${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span><time>${escapeHtml(stamp(item.time))}</time></div>`).join('') : '<p class="alert-empty">ยังไม่มีรายการแจ้งเตือน</p>';
  const badge = $('#alert-badge');
  badge.hidden = unreadAlerts === 0;
  badge.textContent = String(unreadAlerts);
}
function updateNotificationStatus() {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const text = permission === 'granted' ? 'เปิดอยู่ · แจ้งเตือนระหว่างเปิด SETscope ไว้' : permission === 'denied' ? 'เบราว์เซอร์ปิดสิทธิ์ไว้ · เปิดได้จากการตั้งค่าเว็บไซต์' : permission === 'unsupported' ? 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนบนเดสก์ท็อป' : 'ปิดอยู่ · การแจ้งเตือนในหน้านี้ยังทำงานได้';
  setText('#notification-status', text);
  setText('#notification-permission', permission === 'granted' ? '✓ เปิดแจ้งเตือนบนเบราว์เซอร์แล้ว' : permission === 'denied' ? 'เบราว์เซอร์ปิดสิทธิ์การแจ้งเตือน' : 'เปิดแจ้งเตือนบนเบราว์เซอร์');
  $('#notification-permission').disabled = permission === 'granted' || permission === 'unsupported' || permission === 'denied';
}
function recordAlert(symbol, title, body) {
  const item = { symbol, title, body, time: new Date().toISOString() };
  alertHistory.unshift(item); alertHistory = alertHistory.slice(0, 30);
  localStorage.setItem('setscope-alert-history', JSON.stringify(alertHistory));
  if ($('#alerts-panel').hidden) unreadAlerts++;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`SETscope  ·  ${symbol}`, { body: `${title} — ${body}`, tag: `setscope-${symbol}-${title}` }); } catch (_) {}
  }
  renderAlertHistory();
}
function evaluateWatchlistAlerts(rows) {
  const current = new Set(watchlist.map(item => item.symbol));
  const now = Date.now();
  rows.filter(row => current.has(row.symbol)).forEach(row => {
    const analysis = analyseTechnicals(row.history || []);
    const price = Number(row.last);
    const previous = alertStates[row.symbol];
    const fresh = previous && now - Number(previous.updatedAt || 0) < 6 * 60 * 60 * 1000;
    const pref = getAlertPref(row.symbol);
    if (fresh && analysis && pref.technical && previous.technical && analysis.overall !== previous.technical && analysis.overall !== 'เป็นกลาง') {
      const side = analysis.overall === 'ซื้อ' ? analysis.reasons.filter(item => item.signal === 'ซื้อ') : analysis.reasons.filter(item => item.signal === 'ขาย');
      recordAlert(row.symbol, `สัญญาณเอน${analysis.overall}`, `${side.slice(0, 2).map(item => item.key).join(' และ ')} · ราคา ${number(price)}`);
    }
    const above = Number(pref.above), below = Number(pref.below);
    if (fresh && Number.isFinite(price) && Number(previous.price) > 0) {
      if (Number.isFinite(above) && above > 0 && previous.price < above && price >= above) recordAlert(row.symbol, 'ผ่านระดับราคาขาขึ้น', `ราคา ${number(price)} สูงกว่าระดับที่ตั้ง ${number(above)}`);
      if (Number.isFinite(below) && below > 0 && previous.price > below && price <= below) recordAlert(row.symbol, 'ผ่านระดับราคาขาลง', `ราคา ${number(price)} ต่ำกว่าระดับที่ตั้ง ${number(below)}`);
    }
    alertStates[row.symbol] = { price, technical: analysis?.overall || previous?.technical || '', updatedAt: now };
  });
  localStorage.setItem('setscope-alert-states', JSON.stringify(alertStates));
}
function updateStockCards(rows) {
  if (latestMarketSymbol === activeSymbol && latestMarketRange === currentRange) renderPriceChart(latestMarket?.history || [], latestMarket?.fetchedAt);
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  renderWatchlist(rows);
  const quote = bySymbol[activeSymbol];
  if (!quote) {
    setText('#chart-price', '—'); setText('#chart-change', `ไม่พบราคา ${activeSymbol} จาก Yahoo Finance`);
    setText('#chart-name', activeName || THAI_NAMES[activeSymbol] || activeSymbol);
    setText('#chart-meta', `SET:${activeSymbol} · ${activeName || activeSymbol} · THB`);
    updateWatchlistAddButton();
    setText('#history-count', String(latestMarket?.history?.length || 0));
    return;
  }
  const change = Number(quote.last) - Number(quote.prior);
  const percent = Number(quote.prior) ? change / Number(quote.prior) * 100 : 0;
  setText('#chart-price', number(quote.last));
  setText('#chart-change', `${change >= 0 ? '+' : ''}${number(change)} (${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%)`);
  $('#chart-change').className = change >= 0 ? 'up' : 'down';
  if (!activeName || activeName === activeSymbol) activeName = quote.fullName || activeSymbol;
  setText('#chart-name', activeName);
  setText('#chart-meta', `SET:${activeSymbol} · ${activeName} · THB`);
  updateWatchlistAddButton();
  setText('#history-count', String(latestMarket?.history?.length || 0));
  drawSignals(latestMarket?.history || [], latestMarket?.levelsHistory || latestMarket?.history || []);
}
async function getMarket() {
  try {
    const params = new URLSearchParams({ symbols: watchlist.map(item => item.symbol).join(','), symbol: activeSymbol, range: currentRange });
    const response = await apiFetch(`/api/market?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'เชื่อมต่อ Yahoo Finance ไม่สำเร็จ');
    latestMarket = data;
    latestMarketSymbol = activeSymbol;
    latestMarketRange = currentRange;
    const stocks = data.stocks || [];
    evaluateWatchlistAlerts(stocks);
    updateStockCards(stocks);
    renderMovers(stocks);
    const index = (data.indices || []).find(item => item.symbol === 'SET');
    if (index && Number(index.last) > 0) {
      const change = Number(index.last) - Number(index.prior);
      const pct = Number(index.prior) ? 100 * change / Number(index.prior) : 0;
      $('#set-index').innerHTML = `${number(index.last)} <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${number(Math.abs(change))} (${pct.toFixed(2)}%)</span>`;
      setText('#set-volume', `${number(index.volume)} หุ้น`);
      setText('#set-range', `${number(index.high)} / ${number(index.low)}`);
      setText('#set-turnover', `${number(index.turnoverMillionBaht)} ล้านบาท`);
      $('#set-turnover').title = index.turnoverMillionBaht == null ? 'ต้องตั้งค่า SET_API_KEY ใน Render เพื่อแสดงมูลค่าซื้อขายจากข้อมูลของ SET' : 'ข้อมูลมูลค่าซื้อขายจาก SET API · หน่วยล้านบาท';
    }
    const selected = stocks.find(item => item.symbol === activeSymbol);
    if (selected) setText('#chart-meta', `SET:${activeSymbol} · ${activeName || selected.fullName} · THB`);
  } catch (error) {
    console.warn('Market data refresh failed', error);
    if (!latestMarket) setText('#analysis-note', error.message);
  }
}

async function getNews() {
  const refreshButton = $('#refresh-news');
  if (refreshButton?.disabled) return;
  if (refreshButton) { refreshButton.disabled = true; refreshButton.classList.add('is-loading'); refreshButton.textContent = 'กำลังอัปเดตข่าว…'; }
  setNewsStatus('กำลังดึงข่าวล่าสุด…');
  try {
    const response = await apiFetch('/api/news'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    latestNews = data.items || [];
    renderNews(latestNews.filter(item => activeSource === 'all' || item.source === activeSource));
    analyzeNewsBriefs([...latestNews, ...latestWatchlistNews]);
    setNewsStatus(`ย้อนหลัง 30 วัน · อัปเดต ${stamp(data.fetchedAt)}`);
  } catch (_) { setNewsStatus('โหลดฟีดไม่สำเร็จ · ข่าวย้อนหลัง 30 วัน'); }
  finally {
    if (refreshButton) { refreshButton.disabled = false; refreshButton.classList.remove('is-loading'); refreshButton.textContent = '↻ อัปเดตข้อมูลข่าว'; }
  }
}
async function getWatchlistNews() {
  const requestId = ++watchlistNewsRequestId;
  const root = $('#watchlist-news-list');
  const symbols = watchlist.map(item => item.symbol).filter(Boolean);
  if (!symbols.length) {
    latestWatchlistNews = [];
    const refresh = $('#refresh-watchlist-news');
    if (refresh) { refresh.disabled = false; refresh.classList.remove('is-loading'); }
    setText('#watchlist-news-status', `${currentWatchlist().name} ยังไม่มีหุ้นให้ค้นหาข่าว`);
    if (root) root.innerHTML = '<div class="news-item"><div class="news-title">เพิ่มหุ้นใน Watchlist เพื่อดูข่าวที่เกี่ยวข้อง</div></div>';
    return;
  }
  const button = $('#refresh-watchlist-news');
  if (button) { button.disabled = true; button.classList.add('is-loading'); }
  setText('#watchlist-news-status', `กำลังค้นข่าวของ ${currentWatchlist().name}…`);
  try {
    const stockQuery = encodeURIComponent(JSON.stringify(watchlist.map(item => ({ symbol: item.symbol, name: item.name || item.symbol }))));
    const response = await apiFetch(`/api/watchlist-news?stocks=${stockQuery}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'โหลดข่าว Watchlist ไม่สำเร็จ');
    if (requestId !== watchlistNewsRequestId) return;
    latestWatchlistNews = data.items || [];
    renderWatchlistNews();
    setText('#watchlist-news-status', `${currentWatchlist().name} · ${latestWatchlistNews.length} ข่าว · อัปเดต ${stamp(data.fetchedAt)}`);
    analyzeNewsBriefs([...latestNews, ...latestWatchlistNews]);
  } catch (_) {
    if (requestId !== watchlistNewsRequestId) return;
    setText('#watchlist-news-status', 'โหลดข่าวไม่สำเร็จ · ลองอัปเดตอีกครั้ง');
    if (root) root.innerHTML = '<div class="news-item"><div class="news-title">ยังดึงข่าวที่ตรงกับหุ้นในรายการนี้ไม่ได้</div></div>';
  } finally {
    if (requestId === watchlistNewsRequestId && button) { button.disabled = false; button.classList.remove('is-loading'); }
  }
}
function newsKey(item) { return `${item.source || ''}|${item.title || ''}`; }
async function analyzeNewsBriefs(items) {
  if (newsAnalysisPending || !items.length) return;
  const fresh = [...new Map(items.map(item => [newsKey(item), item])).values()]
    .filter(item => !newsAnalyses.has(newsKey(item))).slice(0, 8);
  if (!fresh.length) return;
  newsAnalysisPending = true;
  const targets = fresh.map(item => ({ source: item.sourceName || item.source || '', title: String(item.title || '').slice(0, 300), url: item.url, snippet: String(item.snippet || '').slice(0, 1200) }));
  try {
    const response = await apiFetch('/api/news-analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: targets }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'วิเคราะห์ข่าวไม่สำเร็จ');
    (data.items || []).forEach((result, index) => {
      const item = fresh[index];
      if (item && result?.summary) newsAnalyses.set(newsKey(item), { summary: result.summary, mode: result.mode || data.mode || 'rules', basis: result.basis || 'headline' });
    });
  } catch (_) {
    fresh.forEach(item => newsAnalyses.set(newsKey(item), { summary: 'อ่านรายละเอียดข่าวและตัวเลขในข่าวต้นฉบับเพิ่มเติมก่อนประเมินผลกระทบต่อหุ้น', mode: 'rules' }));
  } finally {
    newsAnalysisPending = false;
    renderNews(latestNews.filter(item => activeSource === 'all' || item.source === activeSource));
    renderWatchlistNews();
    if ([...latestNews, ...latestWatchlistNews].some(item => !newsAnalyses.has(newsKey(item)))) queueMicrotask(() => analyzeNewsBriefs([...latestNews, ...latestWatchlistNews]));
  }
}
function renderNewsItem(item, options = {}) {
  const mood = options.mood || sentimentHeadline(item.title || '');
  const relatedSymbols = item.matchedSymbols || [];
  const cls = mood === 'บวก' ? 'impact-positive' : mood === 'ลบ' ? 'impact-negative' : 'impact-neutral';
  const analysis = newsAnalyses.get(newsKey(item));
  const summary = analysis?.summary || 'กำลังอ่านและสรุปเนื้อหาข่าว…';
  const mode = analysis?.mode === 'ai' ? `วิเคราะห์โดย AI · ${analysis.basis === 'article' ? 'อ่านเนื้อหาข่าว' : analysis.basis === 'snippet' ? 'อ่าน snippet' : 'อ่านพาดหัว'}` : `สรุปอัตโนมัติ · ${analysis?.basis === 'snippet' ? 'snippet' : 'พาดหัว'}`;
  const symbolTag = relatedSymbols.length ? `<span class="news-relevance">${escapeHtml(relatedSymbols.join(', '))}</span>` : '';
  return `<article class="news-item"><div><a class="news-title news-title-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a><div class="news-tags"><span class="source-tag">${escapeHtml(item.sourceName || item.source || 'ข่าว')}</span><span class="news-impact ${cls}" title="ประเมินจากพาดหัวข่าว ไม่ใช่เนื้อหาฉบับเต็ม">${mood}</span>${symbolTag}</div><div class="news-ai-summary"><b>${mode}</b><span>${escapeHtml(summary)}</span></div></div><a class="news-time" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(stamp(item.pubDate))} ↗</a></article>`;
}
function sentimentHeadline(headline) {
  const text = String(headline || '');
  const positive = /(กำไรเพิ่ม|กำไรพุ่ง|โตเด่น|เติบโต|บวก|รับอานิสงส์|ปรับขึ้น|เพิ่มขึ้น|ยอดขายโต|ซื้อคืน|ปันผลเพิ่ม|ผ่านจุดต่ำสุด|ฟื้นตัว|ชนะประมูล|คว้างาน)/i;
  const negative = /(ขาดทุน|กำไรลด|กำไรวูบ|ร่วง|ลดลง|หดตัว|ปิดลบ|ผิดนัด|ถูกฟ้อง|คดี|เพิ่มทุน|ลดเป้า|เลื่อนโครงการ|ผลกระทบ|คว่ำบาตร|ภัยแล้ง|ต้นทุนพุ่ง)/i;
  return positive.test(text) && !negative.test(text) ? 'บวก' : negative.test(text) && !positive.test(text) ? 'ลบ' : 'เป็นกลาง';
}
function renderWatchlistNews() {
  const root = $('#watchlist-news-list');
  if (!root) return;
  root.innerHTML = latestWatchlistNews.length ? latestWatchlistNews.map(item => renderNewsItem(item)).join('') : '<div class="news-item"><div class="news-title">ไม่พบข่าวที่พาดพิงหุ้นใน Watchlist นี้ใน 30 วันที่ผ่านมา</div></div>';
}
function renderNews(items) {
  $('#news-list').innerHTML = items.length ? items.map(item => renderNewsItem(item)).join('') : '<div class="news-item"><div class="news-title">ไม่มีข่าวจากตัวกรองนี้ในขณะนี้</div></div>';
}

async function setup() {
  await initializeWatchlistCloudSync();
  setupWorkspaceNavigation();
  renderWatchlistPicker();
  setTheme(localStorage.getItem('setscope-theme') || 'light');
  syncTechnicalSearch();
  renderWatchlist();
  renderAlertSettings(); renderAlertHistory(); updateNotificationStatus();
  const handleWatchlistClick = event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      event.stopPropagation();
      const symbol = remove.dataset.remove;
      watchlist = watchlist.filter(item => item.symbol !== symbol);
      if (activeSymbol === symbol && watchlist.length) { activeSymbol = watchlist[0].symbol; activeName = watchlist[0].name || activeSymbol; syncTechnicalSearch(); }
      saveWatchlist(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); renderMovers(latestMarket?.stocks || []); updateTradingViewChart(); getMarket(); getWatchlistNews(); return;
    }
    const row = event.target.closest('.watch-item');
    if (row) { activeSymbol = row.dataset.sym; activeName = row.dataset.name || activeSymbol; syncTechnicalSearch(); renderWatchlist(latestMarket?.stocks || []); renderNews(latestNews.filter(item => activeSource === 'all' || item.source === activeSource)); updateTradingViewChart(); getMarket(); }
  };
  $('#watchlist').addEventListener('click', handleWatchlistClick);
  $('#watchlist-mobile').addEventListener('click', handleWatchlistClick);
  const alertsPanel = $('#alerts-panel');
  $('#alerts-toggle').addEventListener('click', () => {
    alertsPanel.hidden = !alertsPanel.hidden;
    $('#alerts-toggle').setAttribute('aria-expanded', String(!alertsPanel.hidden));
    if (!alertsPanel.hidden) { unreadAlerts = 0; renderAlertHistory(); renderAlertSettings(); }
  });
  $('#alerts-close').addEventListener('click', () => { alertsPanel.hidden = true; $('#alerts-toggle').setAttribute('aria-expanded', 'false'); });
  $('#notification-permission').addEventListener('click', async () => {
    if (!('Notification' in window)) { updateNotificationStatus(); return; }
    try { await Notification.requestPermission(); } catch (_) {}
    updateNotificationStatus();
  });
  $('#alerts-settings').addEventListener('change', event => {
    const field = event.target.dataset.field, stock = event.target.closest('[data-alert-symbol]');
    if (!field || !stock) return;
    const symbol = stock.dataset.alertSymbol, pref = getAlertPref(symbol);
    pref[field] = field === 'technical' ? event.target.checked : event.target.value;
    alertPrefs[symbol] = pref; localStorage.setItem('setscope-alert-prefs', JSON.stringify(alertPrefs));
  });
  $('#alerts-settings').addEventListener('input', event => {
    const field = event.target.dataset.field, stock = event.target.closest('[data-alert-symbol]');
    if (!field || field === 'technical' || !stock) return;
    const symbol = stock.dataset.alertSymbol, pref = getAlertPref(symbol);
    pref[field] = event.target.value; alertPrefs[symbol] = pref;
    localStorage.setItem('setscope-alert-prefs', JSON.stringify(alertPrefs));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.alerts-menu') && !alertsPanel.hidden) { alertsPanel.hidden = true; $('#alerts-toggle').setAttribute('aria-expanded', 'false'); }
  });
  $('#watchlist-add-active').addEventListener('click', addActiveToWatchlist);
  ['#watchlist-select', '#watchlist-select-mobile'].forEach(selector => $(selector)?.addEventListener('change', event => switchWatchlist(event.target.value)));
  $('#watchlist-create')?.addEventListener('click', createWatchlist);
  $('#watchlist-create-mobile')?.addEventListener('click', createWatchlist);
  $('#mover-list').addEventListener('click', event => { const row = event.target.closest('[data-mover-symbol]'); if (row) selectStock(row.dataset.moverSymbol, row.dataset.moverName); });
  document.querySelectorAll('.movers-tabs button').forEach((button, index) => button.addEventListener('click', () => {
    document.querySelectorAll('.movers-tabs button').forEach(item => item.classList.remove('selected'));
    button.classList.add('selected'); moverMode = ['up', 'down', 'volume'][index]; renderMovers(latestMarket?.stocks || []);
  }));
  $('#view-stock').addEventListener('click', () => {
    const first = $('.suggestion-item');
    if (first) selectStock(first.dataset.symbol, first.dataset.name);
    else if ($('#stock-search').value.trim()) selectStock($('#stock-search').value.trim());
  });
  $('#stock-search').addEventListener('input', event => {
    clearTimeout(searchTimer);
    const query = event.target.value.trim();
    if (!query) { hideSuggestions(); return; }
    searchTimer = setTimeout(() => searchStocks(query), 280);
  });
  $('#stock-search').addEventListener('keydown', event => {
    if (event.key === 'Escape') hideSuggestions();
    if (event.key === 'Enter') {
      const first = $('.suggestion-item');
      if (first) { event.preventDefault(); selectStock(first.dataset.symbol, first.dataset.name); }
      else if (/^[A-Z0-9&.-]{1,20}$/i.test(event.target.value.trim())) { event.preventDefault(); selectStock(event.target.value.trim()); }
    }
  });
  $('#symbol-suggestions').addEventListener('click', event => {
    const result = event.target.closest('.suggestion-item');
    if (result) selectStock(result.dataset.symbol, result.dataset.name);
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.stock-search-wrap')) hideSuggestions();
  });
  $('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.querySelectorAll('.range-tabs button').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.range-tabs button').forEach(item => item.classList.remove('selected'));
    button.classList.add('selected'); currentRange = button.dataset.range; updateTradingViewChart(); getMarket();
  }));
  $('#chart-indicators').addEventListener('click', event => {
    const button = event.target.closest('[data-indicator]');
    if (!button) return;
    const key = button.dataset.indicator;
    if (chartIndicators.has(key)) chartIndicators.delete(key); else chartIndicators.add(key);
    button.classList.toggle('active', chartIndicators.has(key));
    updateTradingViewChart();
  });
  document.querySelectorAll('.source-chip').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.source-chip').forEach(item => item.classList.remove('active'));
    button.classList.add('active'); activeSource = button.dataset.source; getNews();
  }));
  $('#refresh-news').addEventListener('click', getNews);
  $('#refresh-watchlist-news').addEventListener('click', getWatchlistNews);
  $('#refresh-chart').addEventListener('click', getMarket);
  $('#refresh-market-data').addEventListener('click', () => getSettradeOverview(true));
  updateTradingViewChart(); getMarket(); getSettradeOverview(); getNews(); getWatchlistNews();
  setInterval(getMarket, 60000); setInterval(getSettradeOverview, 300000); setInterval(getNews, 300000); setInterval(getWatchlistNews, 300000);
}
window.addEventListener('setscope:authenticated', setup, { once: true });
