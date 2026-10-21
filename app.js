import {
  DEFAULT_WATCHLIST,
  MAX_WATCHLIST,
  MAX_WATCHLISTS,
  THAI_NAMES,
  analyseTechnicals,
  alignIndicatorSeries,
  chartGeometry,
  computeEma,
  computeSmaSeries,
  createRequestSequence,
  escapeHtml,
  findPriceLevels,
  mergeWatchlists,
  marketOverviewStatus,
  navigationUrl,
  newsKey,
  normalizeLists,
  pageList,
  parseNavigationState,
  quoteChange,
  resolveMarketBannerFields,
  resolveActiveWatchlistId,
  selectNewsForDisplay,
  sentimentHeadline,
  stamp,
  summarizeBreadth,
  toFiniteNumber
} from './client/domain.mjs';

const $ = selector => document.querySelector(selector);
const apiFetch = (url, options) => window.setscopeAuth.authorizedFetch(url, options);
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const marketRequestSequence = createRequestSequence();
const NAVIGATION_FALLBACK_KEY = 'setscope-navigation-fallback-v1';
const navigationFallback = (() => {
  try { return JSON.parse(sessionStorage.getItem(NAVIGATION_FALLBACK_KEY) || '{}'); } catch (_) { return {}; }
})();
const initialNavigation = parseNavigationState(location.href, navigationFallback);
let watchlists = loadWatchlists();
const requestedWatchlistId = initialNavigation.route === 'watchlist' ? initialNavigation.watchlistId : '';
let activeWatchlistId = requestedWatchlistId
  ? requestedWatchlistId
  : localStorage.getItem('setscope-active-watchlist') || 'list-1';
if (!requestedWatchlistId && !watchlists.some(list => list.id === activeWatchlistId)) activeWatchlistId = watchlists[0].id;
let watchlist = currentWatchlist().items;
let activeSymbol = initialNavigation.route === 'chart' ? initialNavigation.symbol : watchlist[0]?.symbol || 'PTT';
let activeName = initialNavigation.route === 'chart'
  ? watchlist.find(item => item.symbol === activeSymbol)?.name || activeSymbol
  : watchlist[0]?.name || 'ปตท.';
let latestMarket = null;
let latestMarketSymbol = '';
let latestMarketRange = '';
let latestSettradeOverview = null;
let activeSource = initialNavigation.route === 'news' ? initialNavigation.source : 'all';
let latestNews = [];
let latestWatchlistNews = [];
let archiveNews = [];
let archiveTotal = 0;
let archiveConfigured = false;
let archiveLoaded = false;
const PAGE_SIZE = 10;
const FEATURED_COUNT = 5;
const SOURCE_TIER = { official: 4, settrade: 3, infoquest: 2, efinance: 2, thunhoon: 2, kaohoon: 2, broker: 1 };
let newsPage = initialNavigation.route === 'news' ? initialNavigation.newsPage : 1;
let newsQuery = initialNavigation.route === 'news' ? initialNavigation.query : '';
let watchNewsPage = initialNavigation.route === 'watchlist' ? initialNavigation.watchPage : 1;
const newsAnalyses = new Map();
let newsAnalysisPending = false;
let watchlistNewsRequestId = 0;
let archiveNewsRequestId = 0;
let searchTimer;
let newsSearchTimer;
let searchSequence = 0;
let currentRange = initialNavigation.route === 'chart' ? initialNavigation.range : '1D';
const chartIndicators = new Set(['sma20', 'ema20', 'ema50', 'macd']);
let chartLoadState = 'loading';
let chartLoadMessage = 'กำลังโหลดข้อมูลจาก Yahoo Finance…';
let chartResizeTimer = null;
let chartCssFullscreen = false;
let coverageSummaryRequested = false;
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
  overview: { nodes: ['#market-overview', '#market-data-overview'], title: 'ตลาดหุ้นไทย <span>วันนี้</span>', description: 'ดูภาพรวมดัชนีและข้อมูลตลาดหุ้นไทย', breadcrumb: 'ภาพรวม' },
  chart: { nodes: ['#chart-section'], title: 'กราฟ<span>เทคนิค</span>', description: 'ค้นหาหุ้น ดูกราฟราคา และอ่านเหตุผลประกอบสัญญาณ', breadcrumb: 'กราฟเทคนิค' },
  news: { nodes: ['#activity-section', '#news-section'], title: 'ข่าวและ<span>บทวิเคราะห์</span>', description: 'ติดตามข่าวหุ้นไทยจากแหล่งข่าวที่เลือกได้', breadcrumb: 'ข่าวและบทวิเคราะห์' },
  watchlist: { nodes: ['#watchlist-page', '#movers-section'], title: 'รายการ<span>ติดตาม</span>', description: 'จัดการหุ้นที่บันทึกไว้และดูข่าวของหุ้นในรายการที่เลือก', breadcrumb: 'รายการติดตาม' }
};
function currentNavigationState(route = document.body.dataset.workspacePage || initialNavigation.route || 'overview') {
  if (route === 'chart') return { route, symbol: activeSymbol, range: currentRange };
  if (route === 'news') return { route, query: newsQuery, source: activeSource, newsPage };
  if (route === 'watchlist') return { route, watchlistId: activeWatchlistId, watchPage: watchNewsPage };
  return { route: 'overview' };
}
function writeNavigation(mode = 'push', route) {
  const state = currentNavigationState(route);
  const target = navigationUrl(state, location.pathname === '/login' || location.pathname === '/register' ? '/' : location.pathname);
  const current = `${location.pathname}${location.search}${location.hash}`;
  try { sessionStorage.setItem(NAVIGATION_FALLBACK_KEY, JSON.stringify(state)); } catch (_) {}
  if (target === current || mode === 'none') return;
  history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', target);
}
function syncNavigationControls() {
  const search = $('#news-search'); if (search) search.value = newsQuery;
  document.querySelectorAll('.source-chip').forEach(button => button.classList.toggle('active', button.dataset.source === activeSource));
  document.querySelectorAll('.range-tabs button').forEach(button => button.classList.toggle('selected', button.dataset.range === currentRange));
}
function setWorkspacePage(page, { historyMode = 'push', scroll = true } = {}) {
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
  setText('#breadcrumb-current', heading.breadcrumb);
  if (page === 'chart') getCoverageSummary();
  if (historyMode !== 'none') writeNavigation(historyMode, page);
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}
let lastRestoredLocation = '';
function restoreNavigationFromLocation() {
  const locationKey = `${location.pathname}${location.search}${location.hash}`;
  if (locationKey === lastRestoredLocation) return;
  lastRestoredLocation = locationKey;
  const state = parseNavigationState(location.href, currentNavigationState());
  const previousRoute = document.body.dataset.workspacePage;
  const previousSymbol = activeSymbol, previousRange = currentRange, previousWatchlist = activeWatchlistId;
  const previousNewsPage = newsPage, previousNewsSource = activeSource, previousNewsQuery = newsQuery;
  if (state.route === 'chart') {
    activeSymbol = state.symbol;
    activeName = watchlist.find(item => item.symbol === activeSymbol)?.name || activeSymbol;
    currentRange = state.range;
  }
  if (state.route === 'news') { newsQuery = state.query; activeSource = state.source; newsPage = state.newsPage; }
  if (state.route === 'watchlist') {
    if (watchlists.some(list => list.id === state.watchlistId)) activeWatchlistId = state.watchlistId;
    watchlist = currentWatchlist().items;
    watchNewsPage = state.watchPage;
  }
  syncNavigationControls();
  syncTechnicalSearch();
  renderWatchlistPicker();
  setWorkspacePage(state.route, { historyMode: 'none', scroll: false });
  renderNews(); renderWatchlistNews(); renderWatchlist(latestMarket?.stocks || []); renderMovers(latestMarket?.stocks || []);
  if (state.route === 'chart' && (previousSymbol !== activeSymbol || previousRange !== currentRange || previousRoute !== 'chart')) getMarket();
  if (state.route === 'news' && archiveConfigured && (previousNewsPage !== newsPage || previousNewsSource !== activeSource || previousNewsQuery !== newsQuery || previousRoute !== 'news')) getArchiveNews({ page: newsPage, reason: 'restore' });
  if (state.route === 'watchlist' && (previousWatchlist !== activeWatchlistId || previousRoute !== 'watchlist')) getWatchlistNews({ reason: 'restore' });
  writeNavigation('replace', state.route);
}
function setupWorkspaceNavigation() {
  document.querySelectorAll('.nav-item[data-workspace-route]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); setWorkspacePage(link.dataset.workspaceRoute, { historyMode: 'push' });
  }));
  $('#breadcrumb-home')?.addEventListener('click', event => { event.preventDefault(); setWorkspacePage('overview', { historyMode: 'push' }); });
  window.addEventListener('hashchange', restoreNavigationFromLocation);
  window.addEventListener('popstate', restoreNavigationFromLocation);
  syncNavigationControls();
  setWorkspacePage(initialNavigation.route, { historyMode: 'none', scroll: false });
  writeNavigation('replace', initialNavigation.route);
}
function persistWatchlistsLocal() {
  currentWatchlist().items = watchlist;
  localStorage.setItem('setscope-watchlists-v2', JSON.stringify(watchlists));
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
async function initializeWatchlistCloudSync() {
  watchlistCloudReady = false;
  setWatchlistSyncStatus('กำลังโหลด…', 'pending');
  const localLists = JSON.parse(JSON.stringify(watchlists));
  const localActive = requestedWatchlistId || activeWatchlistId;
  try {
    const response = await apiFetch('/api/watchlists');
    const data = await response.json();
    if (!response.ok) throw new Error(data.retryable ? 'ระบบกำลังเริ่มทำงาน' : (data.error || 'โหลด Watchlist ไม่สำเร็จ'));
    const record = data.record;
    if (record && Array.isArray(record.watchlists)) {
      watchlists = mergeWatchlists(localLists, record.watchlists);
      activeWatchlistId = resolveActiveWatchlistId(watchlists, {
        requestedId: requestedWatchlistId,
        cloudId: record.active_watchlist_id,
        localId: localActive
      });
      watchlist = currentWatchlist().items;
    } else {
      watchlists = localLists;
      activeWatchlistId = resolveActiveWatchlistId(watchlists, {
        requestedId: requestedWatchlistId,
        localId: localActive
      });
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
    const saved = JSON.parse(localStorage.getItem('setscope-watchlists-v2') || 'null');
    if (Array.isArray(saved) && saved.length) return normalizeLists(saved);
  } catch (_) {}
  return [{ id: 'list-1', name: 'Watchlist 1', items: [] }];
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
function switchWatchlist(id, { historyMode = 'push', resetPage = true } = {}) {
  const chosen = watchlists.find(list => list.id === id); if (!chosen) return;
  activeWatchlistId = id; watchlist = chosen.items; scheduleWatchlistCloudSync();
  if (resetPage) watchNewsPage = 1;
  if (watchlist.length && !watchlist.some(item => item.symbol === activeSymbol)) { activeSymbol = watchlist[0].symbol; activeName = watchlist[0].name || activeSymbol; updateTradingViewChart(); }
  syncTechnicalSearch();
  renderWatchlistPicker(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); renderMovers(latestMarket?.stocks || []); updateWatchlistAddButton();
  if (document.body.dataset.workspacePage === 'watchlist') writeNavigation(historyMode, 'watchlist');
  getMarket(); getWatchlistNews({ reason: 'watchlist-change' });
}
function setText(selector, value) { const el = $(selector); if (el) el.textContent = value; }
function renderMarketBanner() {
  const overviewIndex = latestSettradeOverview?.indices?.find(item => item.symbol === 'SET') || null;
  const marketIndex = latestMarket?.indices?.find(item => item.symbol === 'SET') || null;
  const resolved = resolveMarketBannerFields(overviewIndex, marketIndex);
  const index = resolved.index;
  if (index) {
    const quote = resolved.sources.index === 'market'
      ? quoteChange(index.last, index.prior)
      : { change: toFiniteNumber(index.change), percent: toFiniteNumber(index.changePercent) };
    const trend = quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'neutral';
    const arrow = quote.change > 0 ? '▲' : quote.change < 0 ? '▼' : '•';
    const changeLabel = quote.change === null || quote.percent === null
      ? ''
      : ` <span class="${trend}">${arrow} ${number(Math.abs(quote.change))} (${number(quote.percent)}%)</span>`;
    $('#set-index').innerHTML = `${number(index.last)}${changeLabel}`;
  } else {
    setText('#set-index', '—');
  }
  setText('#set-volume', number(resolved.volumeThousand));
  setText('#set-range', resolved.high === null || resolved.low === null ? '—' : `${number(resolved.high)} / ${number(resolved.low)}`);
  setText('#set-turnover', number(resolved.turnoverMillion));
  $('#set-volume').title = resolved.sources.volume === 'overview'
    ? "ปริมาณซื้อขายจาก Market Overview · หน่วย '000 หุ้น"
    : resolved.sources.volume === 'market' ? "ปริมาณซื้อขายสำรองจากข้อมูลหุ้น แปลงเป็นหน่วย '000 หุ้น" : 'ข้อมูลปริมาณซื้อขายยังไม่พร้อม';
  $('#set-turnover').title = resolved.sources.turnover === 'overview'
    ? 'มูลค่าซื้อขายจาก Market Overview · หน่วยล้านบาท'
    : resolved.sources.turnover === 'market' ? 'มูลค่าซื้อขายสำรองจากข้อมูลตลาด · หน่วยล้านบาท' : 'ข้อมูลมูลค่าซื้อขายยังไม่พร้อม';
}
function renderSettradeOverview(data) {
  latestSettradeOverview = data;
  renderMarketBanner();
  const indices = data.indices || [];
  const tfex = data.tfex || {};
  const tfexDelayMinutes = toFiniteNumber(tfex.delayMinutes) ?? 15;
  const tfexDelayLabel = Number.isInteger(tfexDelayMinutes) ? String(tfexDelayMinutes) : number(tfexDelayMinutes);
  $('#market-index-grid').innerHTML = ['SET', 'mai', 'TFEX'].map(symbol => {
    if (symbol === 'TFEX') {
      if (!tfex.available) return `<article class="market-index-card market-index-card-tfex"><span>TFEX</span><strong>ข้อมูลยังไม่พร้อม</strong><small>ข้อมูลล่าช้า ${tfexDelayLabel} นาที</small></article>`;
      const volume = toFiniteNumber(tfex.totalVolume);
      const openInterest = toFiniteNumber(tfex.openInterest);
      const primary = volume === null ? `มีข้อมูล ${tfex.topVolume?.length || 0} รายการ` : `${number(volume)} สัญญา`;
      const detail = openInterest === null ? 'สถานะคงค้างยังไม่พร้อม' : `สถานะคงค้าง ${number(openInterest)} สัญญา`;
      return `<article class="market-index-card market-index-card-tfex"><span>TFEX</span><strong>${primary}</strong><small>${detail} · ล่าช้า ${tfexDelayLabel} นาที</small></article>`;
    }
    const item = indices.find(row => row.symbol === symbol);
    if (!item) return `<article class="market-index-card"><span>${symbol}</span><strong>—</strong><small>ต้นทางยังไม่ส่งข้อมูล</small></article>`;
    const last = toFiniteNumber(item.last), change = toFiniteNumber(item.change), changePercent = toFiniteNumber(item.changePercent), turnover = toFiniteNumber(item.turnoverMillion);
    const trend = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '•';
    const details = [];
    if (change !== null && changePercent !== null) details.push(`<span class="${trend}">${arrow} ${number(Math.abs(change))} (${number(changePercent)}%)</span>`);
    if (turnover !== null && turnover >= 0) details.push(`มูลค่า ${number(turnover)} ลบ.`);
    return `<article class="market-index-card"><span>${symbol}</span><strong>${number(last)}</strong><small>${details.join(' · ') || 'รายละเอียดตลาดยังไม่พร้อม'}</small></article>`;
  }).join('');
  const breadthLabels = { Gainers: 'ปรับขึ้น', Unchanges: 'ไม่เปลี่ยนแปลง', Losers: 'ปรับลง' };
  const breadth = data.breadth || [];
  const breadthTotals = summarizeBreadth(breadth);
  const condition = breadthTotals.comparable
    ? breadthTotals.up > breadthTotals.down ? 'หุ้นปรับขึ้นมากกว่าปรับลง' : breadthTotals.up < breadthTotals.down ? 'หุ้นปรับลงมากกว่าปรับขึ้น' : 'หุ้นปรับขึ้นและลงใกล้เคียงกัน'
    : 'ยังไม่มีข้อมูล breadth ที่เปรียบเทียบได้';
  const conditionNode = $('#market-condition');
  if (conditionNode) {
    const direction = breadthTotals.comparable ? (breadthTotals.up > breadthTotals.down ? 'up' : breadthTotals.up < breadthTotals.down ? 'down' : '') : '';
    conditionNode.textContent = `ภาวะตลาด: ${condition}`;
    conditionNode.className = `market-condition ${direction}`;
  }
  $('#market-breadth-list').innerHTML = breadth.length ? breadth.map(group => `<div class="market-breadth-group"><b>${escapeHtml(group.market)}</b>${(group.items || []).map(item => {
    const key = Object.keys(breadthLabels).find(label => item.label?.toLowerCase().includes(label.toLowerCase()));
    return `<div><span>${breadthLabels[key] || escapeHtml(item.label)}</span><strong>${number(item.count)} หุ้น</strong><small>${number(item.volumeThousand)} พันหุ้น</small></div>`;
  }).join('')}</div>`).join('') : '<p class="market-empty">หน้า SETTRADE ยังไม่มีสถิติหุ้นขึ้น–ลงรอบนี้</p>';
  setText('#market-close-summary', data.closeSummary || 'ยังไม่มีสรุปภาวะตลาดรอบนี้');
  const nvdr = data.nvdr || {};
  const marketMillion = toFiniteNumber(nvdr.marketMillion), nvdrMillion = toFiniteNumber(nvdr.nvdrMillion), ratioPercent = toFiniteNumber(nvdr.ratioPercent);
  $('#nvdr-metrics').innerHTML = `<div><small>มูลค่าซื้อขาย SET + mai</small><strong>${number(marketMillion)}</strong>${marketMillion === null ? '' : '<em>ล้านบาท</em>'}</div><div><small>มูลค่าซื้อขาย NVDR</small><strong>${number(nvdrMillion)}</strong>${nvdrMillion === null ? '' : '<em>ล้านบาท</em>'}</div><div><small>สัดส่วน NVDR</small><strong>${number(ratioPercent)}</strong>${ratioPercent === null ? '' : '<em>%</em>'}</div>`;
  const foreign = data.foreign || {};
  const net = toFiniteNumber(foreign.netMillion);
  $('#foreign-flow').innerHTML = `<span>ซื้อสุทธิต่างชาติ (รายวัน)</span><strong class="${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${net > 0 ? '+' : ''}${number(net)}</strong><small>${net === null ? 'ข้อมูลยังไม่พร้อม' : `ล้านบาท · ${escapeHtml(foreign.date || 'วันที่อัปเดตยังไม่ทราบ')}`}</small>`;
  const activeRows = (Array.isArray(data.activeValue) ? data.activeValue : []).filter(item =>
    typeof item?.symbol === 'string' && item.symbol.trim()
    && toFiniteNumber(item.rank) > 0
    && [item.last, item.change, item.changePercent, item.turnoverMillion].every(value => toFiniteNumber(value) !== null)
    && toFiniteNumber(item.turnoverMillion) >= 0
  );
  const activeRoot = $('#active-value-content');
  if (activeRoot) {
    activeRoot.className = activeRows.length ? 'market-active-table-wrap' : 'market-live-placeholder';
    activeRoot.innerHTML = activeRows.length
      ? `<table class="market-active-table"><thead><tr><th>หุ้น</th><th>ล่าสุด</th><th>เปลี่ยนแปลง</th><th>มูลค่า (ลบ.)</th></tr></thead><tbody>${activeRows.slice(0, 10).map(item => {
          const change = toFiniteNumber(item.change);
          const trend = change > 0 ? 'up' : change < 0 ? 'down' : '';
          return `<tr><td><b>${escapeHtml(item.symbol)}</b><small>#${number(item.rank)}</small></td><td>${number(item.last)}</td><td class="${trend}">${change > 0 ? '+' : ''}${number(change)} (${number(item.changePercent)}%)</td><td>${number(item.turnoverMillion)}</td></tr>`;
        }).join('')}</tbody></table><small class="market-source-caption">${escapeHtml(data.activeValueStatus || 'ข้อมูลจัดอันดับจาก SETTRADE')}</small>`
      : `<span class="market-placeholder-icon">↗</span><div><strong id="active-value-status">${escapeHtml(data.activeValueStatus || 'ตารางจัดอันดับยังโหลดไม่สำเร็จจากต้นทาง')}</strong><p>ต้นทางยังไม่ส่งข้อมูลตารางแบบอ่านได้</p></div>`;
  }
  setText('#settrade-updated', marketOverviewStatus(data));
}
async function getSettradeOverview(force = false) {
  const button = $('#refresh-market-data');
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.classList.add('is-loading'); button.textContent = 'กำลังอัปเดต…'; }
  setText('#settrade-updated', 'กำลังดึงข้อมูลจาก SETTRADE…');
  try {
    const response = await apiFetch(`/api/market-overview${force ? '?refresh=1' : ''}`);
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
function updateWatchlistAddButton() {
  const button = $('#watchlist-add-active');
  if (!button) return;
  const saved = watchlist.some(item => item.symbol === activeSymbol);
  button.disabled = saved;
  button.textContent = saved ? 'ติดตามแล้ว' : '＋ เพิ่มเข้า Watchlist';
}

function renderWatchlist(rows = []) {
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  const markup = watchlist.length ? watchlist.map(item => {
    const quote = bySymbol[item.symbol];
    const quoteState = quote?.dataState;
    const quoteStateText = quoteState === 'stale' ? 'ข้อมูลเก่า' : quoteState === 'suspect' || quoteState === 'quarantined' ? 'ข้อมูลต้องสงสัย' : '';
    const change = quote ? Number(quote.last) - Number(quote.prior) : null;
    const percent = quote && Number(quote.prior) ? change / Number(quote.prior) * 100 : null;
    return `<div class="watch-item ${activeSymbol === item.symbol ? 'selected' : ''}" data-sym="${escapeHtml(item.symbol)}" data-name="${escapeHtml(item.name || item.symbol)}">
      <div class="watch-details"><span class="watch-symbol">${escapeHtml(item.symbol)}</span><span class="watch-name">${escapeHtml(item.name || item.symbol)}</span></div>
      <div class="watch-quote"><span class="watch-price">${quote ? number(quote.last) : '—'}</span>${percent === null ? '' : `<span class="watch-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${percent.toFixed(2)}%</span>`}${quoteStateText ? `<span class="watch-data-state">${quoteStateText}</span>` : ''}</div>
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
  const activeQuote = latestMarket?.stocks?.find(item => item.symbol === activeSymbol);
  const chartBarTime = latestMarket?.history?.at(-1)?.time;
  const providerTime = chartBarTime ? new Date(chartBarTime).toISOString() : activeQuote?.time ? new Date(activeQuote.time).toISOString() : latestMarket?.asOf;
  const guardedState = ['stale', 'suspect', 'quarantined', 'unavailable'].includes(latestMarket?.dataState)
    ? latestMarket.dataState
    : activeQuote?.dataState || latestMarket?.dataState;
  renderPriceChart(latestMarket?.history || [], providerTime, latestMarket?.levelsHistory || [], latestMarket?.indicatorHistory || [], guardedState);
}

function setChartLoadState(state, message = '') {
  chartLoadState = state;
  chartLoadMessage = message || (state === 'loading' ? 'กำลังโหลดข้อมูลจาก Yahoo Finance…' : '');
}

function setTechnicalPanelState(state) {
  const panel = $('.analysis-panel');
  if (!panel) return;
  panel.classList.toggle('signals-unavailable', state === 'insufficient' || state === 'unavailable' || state === 'error' || state === 'loading');
  panel.classList.toggle('no-chart-data', state === 'unavailable' || state === 'error' || state === 'loading');
}

function renderPriceChart(bars = [], providerTime = '', levelBars = bars, indicatorBars = bars, dataState = 'delayed') {
  const host = $('#stock-price-chart');
  if (!host) return;
  const rows = (bars || []).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(Number(value))) && Number(bar.close) > 0);
  if (!rows.length) {
    const isError = chartLoadState === 'error';
    const isUnavailable = chartLoadState === 'unavailable';
    const message = chartLoadMessage || (isUnavailable ? 'กราฟยังไม่พร้อมสำหรับหลักทรัพย์นี้' : isError ? 'โหลดข้อมูลไม่สำเร็จ' : 'กำลังโหลดข้อมูลจาก Yahoo Finance…');
    host.innerHTML = `<div class="chart-empty chart-empty-${escapeHtml(chartLoadState)}"><span>${escapeHtml(message)}</span>${isError ? '<button type="button" data-chart-retry>ลองใหม่</button>' : ''}</div>`;
    host.closest('.own-chart-wrap')?.classList.remove('has-macd');
    setText('#chart-updated', 'อัปเดตล่าสุด: —');
    return;
  }
  const calculationRows = (indicatorBars || bars || []).filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0);
  const analysis = analyseTechnicals(calculationRows, levelBars);
  const alignToChart = values => alignIndicatorSeries(calculationRows, values, rows);
  const macdSeries = analysis ? alignToChart(analysis.macdSeries) : [];
  const signalSeries = analysis ? alignToChart(analysis.signalSeries) : [];
  const macdHistogram = analysis ? alignToChart(analysis.macdHistogram) : [];
  const showMacd = chartIndicators.has('macd') && macdSeries.some(Number.isFinite);
  const hostWidth = Math.max(320, Math.floor(host.clientWidth || host.parentElement?.clientWidth || 640));
  const geometry = chartGeometry({ rowCount: rows.length, hostWidth, range: currentRange });
  const { left, right, width, plotWidth, step, candleWidth, x } = geometry;
  const top = 22;
  const height = showMacd ? 520 : 390;
  const priceBottom = 280, volumeBottom = 340, macdTop = 375, macdBottom = 475;
  const closes = rows.map(row => Number(row.close));
  const calculationCloses = calculationRows.map(row => Number(row.close));
  const smaValues = alignToChart(computeSmaSeries(calculationCloses, 20));
  const indicatorSeries = [
    ['sma20', smaValues, 'sma20-chart-line'],
    ['ema20', alignToChart(computeEma(calculationCloses, 20)), 'ema20-chart-line'],
    ['ema50', alignToChart(computeEma(calculationCloses, 50)), 'ema50-chart-line'],
    ['ema100', alignToChart(computeEma(calculationCloses, 100)), 'ema100-chart-line'],
    ['ema200', alignToChart(computeEma(calculationCloses, 200)), 'ema200-chart-line']
  ];
  const chartLevels = analysis?.levels || findPriceLevels(levelBars, closes.at(-1));
  const levelDetails = [...chartLevels.supportDetails, ...chartLevels.resistanceDetails];
  const scaleValues = [
    ...rows.flatMap(row => [Number(row.low), Number(row.high)]),
    ...indicatorSeries.filter(([key]) => chartIndicators.has(key)).flatMap(([, values]) => values.filter(Number.isFinite)),
    ...levelDetails.map(item => item.value)
  ].filter(Number.isFinite);
  const minPrice = Math.min(...scaleValues), maxPrice = Math.max(...scaleValues);
  const pad = Math.max((maxPrice - minPrice) * .08, maxPrice * .003, .01);
  const min = minPrice - pad, max = maxPrice + pad, span = max - min || 1;
  const y = value => top + (max - value) / span * (priceBottom - top);
  const volumeMax = Math.max(...rows.map(row => toFiniteNumber(row.volume)).filter(value => value !== null && value >= 0), 1);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max - span * index / 4, py = y(value);
    return `<line class="chart-grid" x1="${left}" y1="${py}" x2="${width - right}" y2="${py}"/><text class="chart-axis-text" x="${left - 9}" y="${py + 3}" text-anchor="end">${number(value)}</text>`;
  }).join('');
  const candles = rows.map((bar, index) => {
    const open = Number(bar.open), close = Number(bar.close), high = Number(bar.high), low = Number(bar.low);
    const rising = close >= open, cx = x(index), bodyTop = Math.min(y(open), y(close)), bodyHeight = Math.max(1.4, Math.abs(y(open) - y(close)));
    const rawVolume = toFiniteNumber(bar.volume);
    const volume = rawVolume === null ? null : Math.max(0, rawVolume);
    const volumeHeight = volume === null ? 0 : volume / volumeMax * (volumeBottom - priceBottom - 6);
    const volumeBar = volume === null ? '' : `<rect class="volume-bar" x="${cx - candleWidth / 2}" y="${volumeBottom - volumeHeight}" width="${candleWidth}" height="${volumeHeight}"/>`;
    const date = new Date(bar.time);
    const dateText = Number.isNaN(+date) ? '' : date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: currentRange === '1D' || currentRange === '1W' ? '2-digit' : undefined, minute: currentRange === '1D' || currentRange === '1W' ? '2-digit' : undefined });
    const detail = `${dateText} · O ${number(open)} · H ${number(high)} · L ${number(low)} · C ${number(close)} · Vol ${number(volume)}`;
    return `<g class="price-candle ${rising ? 'rising' : 'falling'}"><title>${escapeHtml(detail)}</title><line x1="${cx}" y1="${y(high)}" x2="${cx}" y2="${y(low)}"/><rect x="${cx - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" rx=".8"/>${volumeBar}<rect class="candle-hit" x="${cx - Math.max(candleWidth, step) / 2}" y="${top}" width="${Math.max(candleWidth, step)}" height="${volumeBottom - top}"/></g>`;
  }).join('');
  const indicators = indicatorSeries.filter(([key]) => chartIndicators.has(key)).map(([, values, className]) => {
    const points = values.map((value, index) => value == null ? '' : `${x(index)},${y(value)}`).filter(Boolean).join(' ');
    return points ? `<polyline class="${className}" points="${points}"/>` : '';
  }).join('');
  const levelLines = levelDetails.map(item => {
    const py = y(item.value);
    const typeLabel = item.type === 'support' ? `S${item.rank}` : `R${item.rank}`;
    return `<g class="chart-level ${item.type}"><line x1="${left}" y1="${py}" x2="${width - right}" y2="${py}"/><text x="${width - right - 4}" y="${py - 4}" text-anchor="end">${escapeHtml(typeLabel)} ${escapeHtml(number(item.value))} · ${escapeHtml(item.source)}</text></g>`;
  }).join('');
  let macdPanel = '';
  if (showMacd) {
    const macdValues = [...macdSeries, ...signalSeries, 0].filter(Number.isFinite);
    const macdMin = Math.min(...macdValues), macdMax = Math.max(...macdValues), macdSpan = macdMax - macdMin || 1;
    const macdY = value => macdTop + (macdMax - value) / macdSpan * (macdBottom - macdTop);
    const zeroY = macdY(0);
    const macdLine = macdSeries.map((value, index) => Number.isFinite(value) ? `${x(index)},${macdY(value)}` : '').filter(Boolean).join(' ');
    const signalLine = signalSeries.map((value, index) => Number.isFinite(value) ? `${x(index)},${macdY(value)}` : '').filter(Boolean).join(' ');
    const histogram = macdHistogram.map((value, index) => {
      if (!Number.isFinite(value)) return '';
      const py = macdY(value), barWidth = Math.max(1.4, Math.min(8, step * .55));
      return `<rect class="macd-histogram ${value >= 0 ? 'positive' : 'negative'}" x="${x(index) - barWidth / 2}" y="${Math.min(py, zeroY)}" width="${barWidth}" height="${Math.max(1, Math.abs(zeroY - py))}"/>`;
    }).join('');
    macdPanel = `<g class="macd-panel"><rect class="macd-panel-bg" x="${left}" y="${macdTop - 18}" width="${plotWidth}" height="${macdBottom - macdTop + 26}" rx="4"/><text class="chart-label" x="${left + 6}" y="${macdTop - 5}">MACD (12, 26, 9)</text><line class="macd-zero" x1="${left}" y1="${zeroY}" x2="${width - right}" y2="${zeroY}"/>${histogram}<polyline class="macd-line" points="${macdLine}"/><polyline class="macd-signal-line" points="${signalLine}"/></g>`;
  }
  const labelIndices = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1])];
  const dateLabels = labelIndices.map(index => {
    const date = new Date(rows[index].time);
    const label = Number.isNaN(+date) ? '' : date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', ...(currentRange === '1D' ? { hour: '2-digit', minute: '2-digit' } : {}) });
    return `<text class="chart-axis-text" x="${x(index)}" y="${showMacd ? 510 : 375}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join('');
  const updated = providerTime ? new Date(providerTime).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const stateText = dataState === 'stale' ? ' · ข้อมูลเก่า' : dataState === 'suspect' || dataState === 'quarantined' ? ' · ข้อมูลต้องสงสัย' : '';
  setText('#chart-updated', `อัปเดตล่าสุด: ${updated} น. (เวลาไทย)${stateText}`);
  host.closest('.own-chart-wrap')?.classList.toggle('has-macd', showMacd);
  host.innerHTML = `<div class="chart-svg-scroll"><svg class="price-chart-svg" style="width:${width}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="กราฟแท่งเทียน ${escapeHtml(activeSymbol)} ช่วง ${escapeHtml(currentRange)}"><text class="chart-label" x="${left}" y="14">${escapeHtml(activeSymbol)} · ${escapeHtml(currentRange)}</text>${grid}<line class="chart-volume-separator" x1="${left}" y1="${priceBottom + 5}" x2="${width - right}" y2="${priceBottom + 5}"/>${candles}${indicators}${levelLines}<text class="chart-axis-text" x="${left}" y="${volumeBottom + 13}">VOL</text>${macdPanel}${dateLabels}</svg></div>`;
}

function scheduleChartRedraw() {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(updateTradingViewChart, 180);
}

function updateFullscreenControl() {
  const button = $('#chart-fullscreen');
  const panel = $('.chart-panel');
  const active = chartCssFullscreen || document.fullscreenElement === panel;
  if (panel) panel.classList.toggle('is-chart-fullscreen', active);
  document.body.classList.toggle('chart-fullscreen-open', active);
  if (button) {
    button.textContent = active ? 'ย่อกราฟ' : 'เต็มจอ';
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'ออกจากโหมดเต็มจอ' : 'เปิดกราฟเต็มจอ');
  }
  scheduleChartRedraw();
}

function setCssChartFullscreen(active) {
  chartCssFullscreen = active;
  $('.chart-panel')?.classList.toggle('chart-fullscreen-fallback', active);
  updateFullscreenControl();
}

async function toggleChartFullscreen() {
  const panel = $('.chart-panel');
  if (!panel) return;
  if (document.fullscreenElement === panel) {
    await document.exitFullscreen?.();
    return;
  }
  if (chartCssFullscreen) {
    setCssChartFullscreen(false);
    return;
  }
  if (typeof panel.requestFullscreen === 'function') {
    try {
      await panel.requestFullscreen();
      return;
    } catch (_) {}
  }
  setCssChartFullscreen(true);
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
  renderWatchlist(latestMarket?.stocks || []);
  hideSuggestions();
  renderNews();
  updateTradingViewChart();
  if (document.body.dataset.workspacePage === 'chart') writeNavigation('push', 'chart');
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
  watchNewsPage = 1;
  if (document.body.dataset.workspacePage === 'watchlist') writeNavigation('push', 'watchlist');
  getWatchlistNews({ reason: 'watchlist-change' });
  await getMarket();
}

function createWatchlist() {
  if (watchlists.length >= MAX_WATCHLISTS) return;
  const id = `list-${Date.now()}`, name = `Watchlist ${watchlists.length + 1}`;
  watchlists.push({ id, name, items: [] }); activeWatchlistId = id; watchlist = currentWatchlist().items;
  watchNewsPage = 1;
  saveWatchlist(); renderWatchlistPicker(); renderWatchlist(); renderAlertSettings(); renderMovers([]); getMarket();
  if (document.body.dataset.workspacePage === 'watchlist') writeNavigation('push', 'watchlist');
  getWatchlistNews({ reason: 'watchlist-change' });
}
function renameActiveWatchlist() {
  const current = currentWatchlist();
  const next = (window.prompt('ชื่อใหม่ของรายการ', current.name) || '').trim().slice(0, 40);
  if (!next || next === current.name) return;
  current.name = next;
  saveWatchlist();
  renderWatchlistPicker();
  renderAlertSettings();
}

let moverMode = 'up';
function renderMovers(rows = []) {
  const list = $('#mover-list'); if (!list) return;
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  const values = watchlist.map(item => ({ ...item, quote: bySymbol[item.symbol] })).filter(item => item.quote?.guardStatus === 'accepted' && Number.isFinite(Number(item.quote.last)));
  const pct = item => quoteChange(item.quote.last, item.quote.prior).percent;
  const descending = value => value === null ? Number.NEGATIVE_INFINITY : value;
  const ascending = value => value === null ? Number.POSITIVE_INFINITY : value;
  values.sort((a, b) => moverMode === 'up'
    ? descending(pct(b)) - descending(pct(a))
    : moverMode === 'down'
      ? ascending(pct(a)) - ascending(pct(b))
      : descending(toFiniteNumber(b.quote.volume)) - descending(toFiniteNumber(a.quote.volume)));
  list.innerHTML = values.length ? values.map(item => {
    const { change, percent } = quoteChange(item.quote.last, item.quote.prior);
    const direction = change === null ? '' : change >= 0 ? 'up' : 'down';
    const changeText = percent === null ? '—' : `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
    return `<button class="mover-row" type="button" data-mover-symbol="${escapeHtml(item.symbol)}" data-mover-name="${escapeHtml(item.name)}"><span><b>${escapeHtml(item.symbol)}</b><small>${escapeHtml(item.name)}</small></span><span class="mover-quote"><b>${number(item.quote.last)}</b><small class="${direction}">${changeText}</small></span></button>`;
  }).join('') : '<div class="mover-empty">ยังไม่มีข้อมูลหุ้นใน Watchlist นี้</div>';
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

function renderPriceLevels(bars, last, calculatedLevels = null) {
  const levels = calculatedLevels || findPriceLevels(bars || [], last);
  for (let i = 0; i < 3; i++) {
    const support = levels.supportDetails[i], resistance = levels.resistanceDetails[i];
    setText(`#support-${i + 1}`, support ? `${number(support.value)} · ${support.source}` : 'ไม่มีแนวในช่วงนี้');
    setText(`#resistance-${i + 1}`, resistance ? `${number(resistance.value)} · ${resistance.source}` : 'ไม่มีแนวในช่วงนี้');
  }
  const pivotCount = [...levels.supportDetails, ...levels.resistanceDetails].filter(item => item.source === 'Classic Pivot').length;
  const primaryCount = latestMarket?.history?.length || 0;
  const levelCount = (bars || []).length;
  const historyNote = levelCount > primaryCount && primaryCount > 0 ? `ข้อมูลกราฟ ${primaryCount} แท่ง และย้อนหลังเพิ่มเติมรวม ${levelCount} แท่ง` : `${levelCount} แท่ง`;
  setText('#levels-basis', `แนวรับ–แนวต้านช่วง ${currentRange} จาก ${historyNote} · จุดกลับตัว${pivotCount ? ` และจุดหมุน ${pivotCount} ระดับ` : ''}`);
  return levels;
}

function drawSignals(bars, levelBars = bars, displayBars = bars) {
  const analysis = analyseTechnicals(bars, levelBars);
  if (!analysis) {
    const priceBars = (levelBars || bars || []).filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0);
    renderPriceLevels(levelBars || bars || [], Number(priceBars.at(-1)?.close));
    setTechnicalPanelState(priceBars.length ? 'insufficient' : chartLoadState);
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
  setTechnicalPanelState('ready');
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
  setText('#rsi-value', analysis.rsi.toFixed(1));
  const rsiBar = $('.rsi-track i');
  if (rsiBar) rsiBar.style.left = `${analysis.rsi}%`;
  const supportive = analysis.reasons.filter(reason => reason.signal === 'ซื้อ');
  const opposing = analysis.reasons.filter(reason => reason.signal === 'ขาย');
  const neutral = analysis.reasons.filter(reason => reason.signal === 'เป็นกลาง');
  const group = (title, className, items) => `<div class="reason-group ${className}"><b>${title} (${items.length})</b>${items.length ? `<ul>${items.map(item => `<li><strong>${escapeHtml(item.key)} · ${escapeHtml(item.value)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join('')}</ul>` : '<p>ยังไม่มีหลักฐานจากชุด indicator นี้</p>'}</div>`;
  $('#technical-reasons').innerHTML = group('แรงหนุนฝั่งบวก', 'positive', supportive) + group('แรงกดดัน/เหตุผลฝั่งลบ', 'negative', opposing) + (neutral.length ? group('ยังไม่ชี้ทิศทาง', 'neutral', neutral) : '');
  renderPriceLevels(levelBars || bars || [], analysis.last, analysis.levels);
  const support1 = analysis.levels.supports[0], resistance1 = analysis.levels.resistances[0];
  const plan = analysis.overall === 'ซื้อ'
    ? `หลักฐานเอนบวก ${analysis.buy}/${analysis.available} ข้อ · รอการยืนเหนือแนวต้าน 1 ${number(resistance1)} เพื่อยืนยัน; หากปิดต่ำกว่าแนวรับ 1 ${number(support1)} มุมมองนี้อ่อนลง`
    : analysis.overall === 'ขาย'
      ? `หลักฐานเอนลบ ${analysis.sell}/${analysis.available} ข้อ · หากหลุดแนวรับ 1 ${number(support1)} แรงกดดันอาจต่อเนื่อง; การกลับยืนเหนือแนวต้าน 1 ${number(resistance1)} จะทำให้มุมมองลบอ่อนลง`
      : `สัญญาณบวก ${analysis.buy} ข้อและลบ ${analysis.sell} ข้อ · รอราคาเลือกทิศทางเหนือแนวต้าน 1 ${number(resistance1)} หรือหลุดแนวรับ 1 ${number(support1)} ก่อนพิจารณา`;
  setText('#technical-plan', plan);
  const displayedCount = (displayBars || []).filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0).length;
  const barsNote = analysis.values.length > displayedCount
    ? `แสดง ${displayedCount} แท่ง · ใช้ย้อนหลัง ${analysis.values.length} แท่งคำนวณ`
    : `${analysis.values.length} แท่ง`;
  setText('#analysis-note', `${analysis.overall === 'ซื้อ' ? 'หลักฐานเอนบวก' : analysis.overall === 'ขาย' ? 'หลักฐานเอนลบ' : 'สัญญาณยังผสม'} · ซื้อ ${analysis.buy} / กลาง ${analysis.available - analysis.buy - analysis.sell} / ขาย ${analysis.sell} · มีข้อมูล ${analysis.available}/${analysis.total} indicators · ช่วง ${currentRange} (${barsNote})`);
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
    if (row.guardStatus !== 'accepted') return;
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
  const activeQuote = rows.find(row => row.symbol === activeSymbol);
  const chartBarTime = latestMarket?.history?.at(-1)?.time;
  const providerTime = chartBarTime ? new Date(chartBarTime).toISOString() : activeQuote?.time ? new Date(activeQuote.time).toISOString() : latestMarket?.asOf;
  const guardedState = ['stale', 'suspect', 'quarantined', 'unavailable'].includes(latestMarket?.dataState)
    ? latestMarket.dataState
    : activeQuote?.dataState || latestMarket?.dataState;
  if (latestMarketSymbol === activeSymbol && latestMarketRange === currentRange) renderPriceChart(latestMarket?.history || [], providerTime, latestMarket?.levelsHistory || [], latestMarket?.indicatorHistory || [], guardedState);
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  renderWatchlist(rows);
  const quote = bySymbol[activeSymbol];
  if (!quote) {
    setText('#chart-price', '—'); setText('#chart-change', `ไม่พบราคา ${activeSymbol} จาก Yahoo Finance`);
    updateWatchlistAddButton();
    setText('#history-count', String(latestMarket?.history?.length || 0));
    setChartLoadState('unavailable', 'กราฟยังไม่พร้อมสำหรับหลักทรัพย์นี้');
    renderPriceChart([]);
    setTechnicalPanelState('unavailable');
    setText('#analysis-note', 'กราฟยังไม่พร้อมสำหรับหลักทรัพย์นี้');
    return;
  }
  const { change, percent } = quoteChange(quote.last, quote.prior);
  setText('#chart-price', number(quote.last));
  setText('#chart-change', change === null || percent === null
    ? '— (ไม่มีราคาปิดก่อนหน้า)'
    : `${change >= 0 ? '+' : ''}${number(change)} (${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%)`);
  $('#chart-change').className = change === null ? '' : change >= 0 ? 'up' : 'down';
  if (!activeName || activeName === activeSymbol) activeName = quote.fullName || activeSymbol;
  updateWatchlistAddButton();
  setText('#history-count', String(latestMarket?.history?.length || 0));
  drawSignals(latestMarket?.indicatorHistory || latestMarket?.history || [], latestMarket?.levelsHistory || latestMarket?.history || [], latestMarket?.history || []);
}
async function getCoverageSummary() {
  const root = $('#coverage-summary');
  if (!root || coverageSummaryRequested) return;
  coverageSummaryRequested = true;
  try {
    const response = await apiFetch('/api/coverage');
    const data = await response.json();
    const count = Number(data.currentVerified);
    if (!response.ok || !data.configured || !data.lastChecked || data.dataState === 'unavailable' || !Number.isFinite(count)) {
      root.hidden = true;
      return;
    }
    setText('#coverage-count', String(count));
    setText('#coverage-checked', data.lastChecked ? stamp(data.lastChecked) : 'ยังไม่เคยตรวจสอบ');
    root.hidden = false;
  } catch (_) {
    root.hidden = true;
  }
}
async function getMarket() {
  const requestId = marketRequestSequence.begin();
  const requestedSymbol = activeSymbol;
  const requestedRange = currentRange;
  const requestedSymbols = watchlist.map(item => item.symbol);
  const changingChart = latestMarketSymbol !== requestedSymbol || latestMarketRange !== requestedRange;
  if (changingChart) {
    setChartLoadState('loading', 'กำลังโหลดข้อมูลจาก Yahoo Finance…');
    setTechnicalPanelState('loading');
    setText('#analysis-note', 'กำลังโหลดข้อมูลจาก Yahoo Finance…');
    renderPriceChart([]);
  }
  try {
    const params = new URLSearchParams({ symbols: requestedSymbols.join(','), symbol: requestedSymbol, range: requestedRange });
    const response = await apiFetch(`/api/market?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'เชื่อมต่อ Yahoo Finance ไม่สำเร็จ');
    if (!marketRequestSequence.isCurrent(requestId) || requestedSymbol !== activeSymbol || requestedRange !== currentRange) return;
    latestMarket = data;
    latestMarketSymbol = requestedSymbol;
    latestMarketRange = requestedRange;
    setChartLoadState((data.history || []).length ? 'ready' : 'unavailable', (data.history || []).length ? '' : 'กราฟยังไม่พร้อมสำหรับหลักทรัพย์นี้');
    const stocks = data.stocks || [];
    evaluateWatchlistAlerts(stocks);
    updateStockCards(stocks);
    renderMovers(stocks);
    renderMarketBanner();
  } catch (error) {
    if (!marketRequestSequence.isCurrent(requestId)) return;
    console.warn('Market data refresh failed', error);
    setChartLoadState('error', 'โหลดข้อมูลไม่สำเร็จ');
    setTechnicalPanelState('error');
    renderPriceChart([]);
    setText('#analysis-note', error.message || 'โหลดข้อมูลไม่สำเร็จ');
  }
}

async function getNews({ reason = 'refresh', resetPage = false } = {}) {
  if (resetPage) {
    newsPage = 1;
    if (document.body.dataset.workspacePage === 'news') writeNavigation('push', 'news');
  }
  const refreshButton = $('#refresh-news');
  if (refreshButton?.disabled) return;
  if (refreshButton) { refreshButton.disabled = true; refreshButton.classList.add('is-loading'); refreshButton.textContent = 'กำลังอัปเดตข่าว…'; }
  try {
    const response = await apiFetch('/api/news'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    latestNews = data.items || [];
    await getArchiveNews({ page: newsPage, reason });
    renderNews();
    analyzeNewsBriefs([...latestNews, ...latestWatchlistNews]);
  } catch (_) { /* Existing list remains visible when a refresh fails. */ }
  finally {
    if (refreshButton) { refreshButton.disabled = false; refreshButton.classList.remove('is-loading'); refreshButton.textContent = '↻ อัปเดตข้อมูลข่าว'; }
  }
}
async function getArchiveNews({ page = newsPage } = {}) {
  const requestId = ++archiveNewsRequestId;
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    source: activeSource,
    query: newsQuery.trim()
  });
  const prepared = latestNews.map(item => ({ ...item, analysisSummary: newsAnalyses.get(newsKey(item))?.summary || '' }));
  const featuredUrls = selectNewsForDisplay(prepared, {
    source: activeSource,
    query: newsQuery.trim(),
    featuredCount: FEATURED_COUNT,
    sourceTier: SOURCE_TIER
  }).featured.map(item => item.url).filter(url => /^https:\/\//i.test(String(url || '')));
  featuredUrls.forEach(url => params.append('exclude', url));
  try {
    const response = await apiFetch(`/api/news-archive?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'โหลดคลังข่าวไม่สำเร็จ');
    if (requestId !== archiveNewsRequestId) return;
    archiveConfigured = Boolean(data.configured);
    archiveLoaded = archiveConfigured;
    archiveNews = Array.isArray(data.items) ? data.items : [];
    archiveTotal = Number.isFinite(Number(data.total)) ? Number(data.total) : archiveNews.length;
    const totalPages = Math.max(1, Math.ceil(archiveTotal / PAGE_SIZE));
    if (newsPage > totalPages) {
      newsPage = totalPages;
      if (document.body.dataset.workspacePage === 'news') writeNavigation('replace', 'news');
      return getArchiveNews({ page: newsPage });
    }
    renderNews();
  } catch (_) {
    if (requestId !== archiveNewsRequestId) return;
    archiveLoaded = false;
    archiveNews = [];
    archiveTotal = 0;
  }
}
async function getWatchlistNews({ reason = 'refresh', resetPage = false } = {}) {
  if (resetPage) {
    watchNewsPage = 1;
    if (document.body.dataset.workspacePage === 'watchlist') writeNavigation('push', 'watchlist');
  }
  const requestId = ++watchlistNewsRequestId;
  const root = $('#watchlist-news-list');
  const symbols = watchlist.map(item => item.symbol).filter(Boolean);
  if (!symbols.length) {
    latestWatchlistNews = [];
    const refresh = $('#refresh-watchlist-news');
    if (refresh) { refresh.disabled = false; refresh.classList.remove('is-loading'); }
    renderWatchlistNews();
    return;
  }
  const button = $('#refresh-watchlist-news');
  if (button) { button.disabled = true; button.classList.add('is-loading'); }
  try {
    const stockQuery = encodeURIComponent(JSON.stringify(watchlist.map(item => ({ symbol: item.symbol, name: item.name || item.symbol }))));
    const response = await apiFetch(`/api/watchlist-news?stocks=${stockQuery}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'โหลดข่าว Watchlist ไม่สำเร็จ');
    if (requestId !== watchlistNewsRequestId) return;
    latestWatchlistNews = data.items || [];
    renderWatchlistNews();
    analyzeNewsBriefs([...latestNews, ...latestWatchlistNews]);
  } catch (_) {
    if (requestId !== watchlistNewsRequestId) return;
    if (root) root.innerHTML = '<div class="news-item"><div class="news-title">โหลดข่าวไม่สำเร็จ ระบบจะลองใหม่อัตโนมัติ หรือกดปุ่มด้านบนเพื่อลองอีกครั้ง</div></div>';
    const pager = $('#watchlist-news-pager');
    if (pager) pager.hidden = true;
  } finally {
    if (requestId === watchlistNewsRequestId && button) { button.disabled = false; button.classList.remove('is-loading'); }
  }
}
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
    renderNews();
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
  const mode = analysis?.mode === 'ai'
    ? `โดย AI · ${analysis.basis === 'article' ? 'อ่านเนื้อหาข่าว' : analysis.basis === 'snippet' ? 'อ่านข้อความย่อข่าว' : 'อ่านพาดหัว'}`
    : 'สรุปจากคำสำคัญ';
  const article = document.createElement('article');
  article.className = 'news-item';
  const content = document.createElement('div');
  const title = document.createElement('a');
  title.className = 'news-title news-title-link';
  title.href = /^https:\/\//i.test(String(item.url || '')) ? item.url : '#';
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.textContent = item.title || 'ข่าว';
  const tags = document.createElement('div');
  tags.className = 'news-tags';
  const source = document.createElement('span');
  source.className = 'source-tag';
  source.textContent = item.sourceName || item.source || 'ข่าว';
  const impact = document.createElement('span');
  impact.className = `news-impact ${cls}`;
  impact.title = 'ประเมินจากพาดหัวข่าว ไม่ใช่เนื้อหาฉบับเต็ม';
  impact.textContent = mood;
  tags.append(source, impact);
  if (item.brokerCategory || item.source === 'broker') {
    const promo = document.createElement('span');
    promo.className = 'promo-tag';
    promo.textContent = 'จากผู้ให้บริการ อาจมีเนื้อหาส่งเสริมการขาย';
    tags.append(promo);
  }
  if (relatedSymbols.length) {
    const symbols = document.createElement('span');
    symbols.className = 'news-relevance';
    symbols.textContent = relatedSymbols.join(', ');
    tags.append(symbols);
  }
  const brief = document.createElement('div');
  brief.className = 'news-ai-summary';
  const briefMode = document.createElement('b');
  briefMode.textContent = mode;
  const briefText = document.createElement('span');
  briefText.textContent = summary;
  brief.append(briefMode, briefText);
  content.append(title, tags, brief);
  const time = document.createElement('a');
  time.className = 'news-time';
  time.href = title.href;
  time.target = '_blank';
  time.rel = 'noopener noreferrer';
  time.textContent = `${stamp(item.pubDate)} ↗`;
  article.append(content, time);
  return article;
}
function renderNewsItemsInto(root, items, emptyText) {
  if (!root) return;
  root.replaceChildren();
  if (items.length) {
    root.append(...items.map(item => renderNewsItem(item)));
    return;
  }
  const message = document.createElement('div');
  message.className = 'news-item';
  const title = document.createElement('div');
  title.className = 'news-title';
  title.textContent = emptyText;
  message.append(title);
  root.append(message);
}
function watchlistEmptyText() {
  return watchlist.length ? 'ยังไม่มีข่าวของหุ้นในรายการติดตาม' : 'ยังไม่มีหุ้นในรายการติดตาม';
}
function scrollPageToTop() {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}
function renderWatchlistNews() {
  const root = $('#watchlist-news-list');
  if (!root) return;
  const total = Math.max(1, Math.ceil(latestWatchlistNews.length / PAGE_SIZE));
  watchNewsPage = Math.max(1, Math.min(watchNewsPage, total));
  const items = latestWatchlistNews.slice((watchNewsPage - 1) * PAGE_SIZE, watchNewsPage * PAGE_SIZE);
  renderNewsItemsInto(root, items, watchlistEmptyText());
  renderPagerInto($('#watchlist-news-pager'), watchNewsPage, total, latestWatchlistNews.length, page => {
    watchNewsPage = page; renderWatchlistNews(); writeNavigation('push', 'watchlist'); scrollPageToTop();
  });
}
function renderPagerInto(bar, current, total, count, onPick) {
  if (!bar) return;
  bar.replaceChildren();
  bar.hidden = count <= PAGE_SIZE;
  if (count <= PAGE_SIZE) return;
  const makeButton = (label, page, options = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = options.active ? 'page-btn active' : 'page-btn';
    button.disabled = Boolean(options.disabled);
    button.addEventListener('click', () => onPick(page));
    return button;
  };
  bar.append(makeButton('ก่อนหน้า', current - 1, { disabled: current === 1 }));
  pageList(current, total).forEach(page => {
    if (page === '…') { const separator = document.createElement('span'); separator.textContent = '…'; bar.append(separator); }
    else bar.append(makeButton(String(page), page, { active: page === current }));
  });
  bar.append(makeButton('ถัดไป', current + 1, { disabled: current === total }));
}
function renderNews() {
  const query = newsQuery.trim().toLocaleLowerCase('th');
  const prepared = latestNews.map(item => ({ ...item, analysisSummary: newsAnalyses.get(newsKey(item))?.summary || '' }));
  const { filtered: all, featured, latest: liveLatest } = selectNewsForDisplay(prepared, {
    source: activeSource,
    query,
    featuredCount: FEATURED_COUNT,
    sourceTier: SOURCE_TIER
  });
  const featuredKeys = new Set(featured.map(newsKey));
  const archived = archiveNews.map(item => ({ ...item, analysisSummary: newsAnalyses.get(newsKey(item))?.summary || item.analysisSummary || '' }))
    .filter(item => !featuredKeys.has(newsKey(item)));
  const archivedSelection = selectNewsForDisplay(archived, { source: activeSource, query, featuredCount: 0 });
  const rest = archiveLoaded ? archivedSelection.filtered : liveLatest;
  const featuredBox = $('#featured-news');
  if (featuredBox) {
    featuredBox.replaceChildren(...featured.map(item => renderNewsItem(item)));
    const section = featuredBox.closest('.featured-news');
    if (section) section.hidden = !featured.length;
  }
  const availableCount = archiveLoaded ? archiveTotal : rest.length;
  const total = Math.max(1, Math.ceil(availableCount / PAGE_SIZE));
  const displayPage = archiveLoaded ? Math.max(1, Math.min(newsPage, total)) : 1;
  if (archiveLoaded) newsPage = displayPage;
  const items = archiveLoaded ? rest.slice(0, PAGE_SIZE) : rest.slice((displayPage - 1) * PAGE_SIZE, displayPage * PAGE_SIZE);
  const emptyText = query ? 'ไม่พบข่าวที่ตรงกับคำค้นนี้' : 'ยังไม่มีข่าวในหมวดที่เลือก';
  renderNewsItemsInto($('#news-list'), items, emptyText);
  renderPagerInto($('#news-pager'), displayPage, total, availableCount, async page => {
    newsPage = page; writeNavigation('push', 'news');
    if (archiveConfigured) await getArchiveNews({ page }); else renderNews();
    scrollPageToTop();
  });
  const counter = $('#news-count');
  if (counter) counter.textContent = query ? `พบ ${archiveLoaded ? archiveTotal : all.length} ข่าวที่ตรงกับ "${newsQuery.trim()}"` : '';
}

async function setup() {
  await initializeWatchlistCloudSync();
  if (!watchlists.some(list => list.id === activeWatchlistId)) activeWatchlistId = watchlists[0].id;
  watchlist = currentWatchlist().items;
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
      watchNewsPage = 1;
      saveWatchlist(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); renderMovers(latestMarket?.stocks || []); updateTradingViewChart(); getMarket();
      if (document.body.dataset.workspacePage === 'watchlist') writeNavigation('push', 'watchlist');
      getWatchlistNews({ reason: 'watchlist-change' }); return;
    }
    const row = event.target.closest('.watch-item');
    if (row) { activeSymbol = row.dataset.sym; activeName = row.dataset.name || activeSymbol; syncTechnicalSearch(); renderWatchlist(latestMarket?.stocks || []); renderNews(); updateTradingViewChart(); getMarket(); }
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
  ['#watchlist-rename', '#watchlist-rename-mobile'].forEach(selector => $(selector)?.addEventListener('click', renameActiveWatchlist));
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
    button.classList.add('selected'); currentRange = button.dataset.range; writeNavigation('push', 'chart'); updateTradingViewChart(); getMarket();
  }));
  $('#chart-indicators').addEventListener('click', event => {
    const button = event.target.closest('[data-indicator]');
    if (!button) return;
    const key = button.dataset.indicator;
    if (chartIndicators.has(key)) chartIndicators.delete(key); else chartIndicators.add(key);
    button.classList.toggle('active', chartIndicators.has(key));
    updateTradingViewChart();
  });
  $('#chart-fullscreen')?.addEventListener('click', toggleChartFullscreen);
  $('#stock-price-chart')?.addEventListener('click', event => {
    if (event.target.closest('[data-chart-retry]')) getMarket();
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) chartCssFullscreen = false;
    updateFullscreenControl();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && chartCssFullscreen) setCssChartFullscreen(false);
  });
  window.addEventListener('resize', scheduleChartRedraw, { passive: true });
  window.addEventListener('orientationchange', scheduleChartRedraw, { passive: true });
  document.querySelectorAll('.source-chip').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.source-chip').forEach(item => item.classList.remove('active'));
    button.classList.add('active'); activeSource = button.dataset.source; newsPage = 1; renderNews(); writeNavigation('push', 'news');
    if (archiveConfigured) getArchiveNews({ page: 1 });
  }));
  $('#news-search').addEventListener('input', event => {
    newsQuery = event.target.value;
    newsPage = 1;
    renderNews();
    writeNavigation('replace', 'news');
    clearTimeout(newsSearchTimer);
    newsSearchTimer = setTimeout(() => {
      if (archiveConfigured) getArchiveNews({ page: 1 });
    }, 280);
  });
  $('#refresh-news').addEventListener('click', () => getNews({ reason: 'manual', resetPage: true }));
  $('#refresh-watchlist-news').addEventListener('click', () => getWatchlistNews({ reason: 'manual', resetPage: true }));
  $('#refresh-chart').addEventListener('click', getMarket);
  $('#refresh-market-data').addEventListener('click', () => getSettradeOverview(true));
  updateTradingViewChart(); getMarket(); getSettradeOverview(); getNews({ reason: 'startup' }); getWatchlistNews({ reason: 'startup' });
  setInterval(getMarket, 60000); setInterval(getSettradeOverview, 300000); setInterval(() => getNews({ reason: 'poll' }), 300000); setInterval(() => getWatchlistNews({ reason: 'poll' }), 300000);
}
if (document.body.classList.contains('authenticated')) setup();
else window.addEventListener('setscope:authenticated', setup, { once: true });
