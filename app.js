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
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
let watchlists = loadWatchlists();
let activeWatchlistId = localStorage.getItem('setscope-active-watchlist') || 'list-1';
if (!watchlists.some(list => list.id === activeWatchlistId)) activeWatchlistId = watchlists[0].id;
let watchlist = currentWatchlist().items;
let activeSymbol = watchlist[0]?.symbol || 'PTT';
let activeName = watchlist[0]?.name || 'ปตท.';
let latestMarket = null;
let activeSource = 'all';
let latestNews = [];
let searchTimer;
let searchSequence = 0;
let currentRange = '1D';
let alertPrefs = readLocal('setscope-alert-prefs', {});
let alertStates = readLocal('setscope-alert-states', {});
let alertHistory = readLocal('setscope-alert-history', []);
let unreadAlerts = 0;

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
function saveWatchlist() { currentWatchlist().items = watchlist; localStorage.setItem('setscope-watchlists', JSON.stringify(watchlists)); localStorage.setItem('setscope-watchlist', JSON.stringify(watchlist)); localStorage.setItem('setscope-active-watchlist', activeWatchlistId); }
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
}
function switchWatchlist(id) {
  const chosen = watchlists.find(list => list.id === id); if (!chosen) return;
  activeWatchlistId = id; watchlist = chosen.items; localStorage.setItem('setscope-active-watchlist', id);
  if (watchlist.length && !watchlist.some(item => item.symbol === activeSymbol)) { activeSymbol = watchlist[0].symbol; activeName = watchlist[0].name || activeSymbol; updateTradingViewChart(); }
  renderWatchlistPicker(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); renderMovers(latestMarket?.stocks || []); updateWatchlistAddButton(); getMarket();
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
  const host = $('#tradingview-chart');
  if (!host || !activeSymbol) return;
  host.replaceChildren();
  const container = document.createElement('div');
  container.className = 'tradingview-widget-container';
  container.style.cssText = 'height:100%;width:100%';
  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container__widget';
  widget.style.cssText = 'height:calc(100% - 28px);width:100%';
  container.append(widget);
  const credit = document.createElement('div');
  credit.className = 'tradingview-widget-copyright';
  credit.innerHTML = `<a href="https://www.tradingview.com/symbols/SET-${encodeURIComponent(activeSymbol)}/" target="_blank" rel="noopener nofollow">${escapeHtml(activeSymbol)} · SET</a><span> by TradingView</span>`;
  container.append(credit);
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  const intervals = { '1D': '5', '1W': '15', '1M': 'D', '3M': 'D', '1Y': 'D' };
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: `SET:${activeSymbol}`,
    interval: intervals[currentRange] || 'D',
    timezone: 'Asia/Bangkok',
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    style: '1',
    locale: 'th_TH',
    withdateranges: true,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    save_image: false,
    hide_volume: false,
    hide_top_toolbar: false,
    studies: [
      { id: 'MASimple@tv-basicstudies', inputs: { length: 20 } },
      { id: 'MAExp@tv-basicstudies', inputs: { length: 20 } },
      { id: 'MAExp@tv-basicstudies', inputs: { length: 50 } },
      { id: 'MAExp@tv-basicstudies', inputs: { length: 100 } },
      { id: 'MAExp@tv-basicstudies', inputs: { length: 200 } }
    ],
    support_host: 'https://www.tradingview.com'
  });
  container.append(script);
  host.append(container);
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
    const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
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
  setText('#chart-name', activeName);
  setText('#chart-meta', `SET:${activeSymbol} · ${activeName} · THB`);
  renderWatchlist(latestMarket?.stocks || []);
  $('#stock-search').value = '';
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
  await getMarket();
}

function createWatchlist() {
  if (watchlists.length >= MAX_WATCHLISTS) return;
  const id = `list-${Date.now()}`, name = `Watchlist ${watchlists.length + 1}`;
  watchlists.push({ id, name, items: [] }); activeWatchlistId = id; watchlist = currentWatchlist().items;
  saveWatchlist(); renderWatchlistPicker(); renderWatchlist(); renderAlertSettings(); renderMovers([]); getMarket();
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
  const recent = bars.slice(-200);
  const supports = [], resistances = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const low = Number(recent[i].low), high = Number(recent[i].high);
    const neighbors = [recent[i - 2], recent[i - 1], recent[i + 1], recent[i + 2]];
    if (Number.isFinite(low) && low < last && neighbors.every(bar => low <= Number(bar.low))) supports.push(low);
    if (Number.isFinite(high) && high > last && neighbors.every(bar => high >= Number(bar.high))) resistances.push(high);
  }
  const gap = Math.max(last * 0.005, 0.01);
  const nearest = (levels, ascending) => {
    const selected = [];
    for (const level of [...new Set(levels)].sort((a, b) => ascending ? a - b : b - a)) {
      if (selected.every(item => Math.abs(item - level) >= gap)) selected.push(level);
      if (selected.length === 3) break;
    }
    return selected;
  };
  return { supports: nearest(supports, false), resistances: nearest(resistances, true) };
}
function analyseTechnicals(bars) {
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
  const levels = findPriceLevels(usable, last);
  return { values, rsi, sma20, emas, macd: macd.at(-1), macdSignal: signalLine.at(-1), last, signals, reasons, buy, sell, overall, levels, available: Object.keys(signals).length, total: 7 };
}
function drawSignals(bars) {
  const analysis = analyseTechnicals(bars);
  if (!analysis) {
    setText('#analysis-note', `ได้รับข้อมูล ${(bars || []).length} จุด ต้องมีอย่างน้อย 30 แท่งเพื่อสรุปสัญญาณ`);
    $('#technical-reasons').innerHTML = '<p class="reason-empty">ข้อมูลยังไม่พอคำนวณ RSI, MACD และค่าเฉลี่ยให้ครบ</p>';
    setText('#technical-plan', 'รอข้อมูลเพิ่มก่อนสรุปเงื่อนไขที่ควรจับตา');
    ['rsi-signal', 'macd-signal', 'sma-signal', 'ema20-signal', 'ema50-signal', 'ema100-signal', 'ema200-signal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = 'ข้อมูลไม่พอ'; el.className = 'pill neutral-pill'; }
    });
    ['#buy-count', '#neutral-count', '#sell-count'].forEach(id => setText(id, '—'));
    ['#overall-signal', '.signal-score strong', '.neutral-chip'].forEach(id => setText(id, 'รอข้อมูล'));
    setText('#rsi-value', '—'); setText('.signal-gauge>b', '—');
    if ($('.gauge-needle')) $('.gauge-needle').style.transform = 'rotate(0deg)';
    if ($('.rsi-track i')) $('.rsi-track i').style.left = '50%';
    for (let i = 1; i <= 3; i++) { setText(`#support-${i}`, '—'); setText(`#resistance-${i}`, '—'); }
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
  setText('#buy-count', String(analysis.buy)); setText('#sell-count', String(analysis.sell)); setText('#neutral-count', String(analysis.available - analysis.buy - analysis.sell));
  setText('#overall-signal', analysis.overall); setText('.signal-score strong', analysis.overall); setText('.neutral-chip', analysis.overall);
  const gauge = Math.round(50 + (analysis.buy - analysis.sell) / analysis.available * 50);
  setText('.signal-gauge>b', String(gauge)); $('.gauge-needle').style.transform = `rotate(${-90 + gauge * 1.8}deg)`;
  setText('#rsi-value', analysis.rsi.toFixed(1)); $('.rsi-track i').style.left = `${analysis.rsi}%`;
  const supportive = analysis.reasons.filter(reason => reason.signal === 'ซื้อ');
  const opposing = analysis.reasons.filter(reason => reason.signal === 'ขาย');
  const neutral = analysis.reasons.filter(reason => reason.signal === 'เป็นกลาง');
  const group = (title, className, items) => `<div class="reason-group ${className}"><b>${title} (${items.length})</b>${items.length ? `<ul>${items.map(item => `<li><strong>${escapeHtml(item.key)} · ${escapeHtml(item.value)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join('')}</ul>` : '<p>ยังไม่มีหลักฐานจากชุด indicator นี้</p>'}</div>`;
  $('#technical-reasons').innerHTML = group('แรงหนุนฝั่งบวก', 'positive', supportive) + group('แรงกดดัน/เหตุผลฝั่งลบ', 'negative', opposing) + (neutral.length ? group('ยังไม่ชี้ทิศทาง', 'neutral', neutral) : '');
  for (let i = 0; i < 3; i++) {
    setText(`#support-${i + 1}`, number(analysis.levels.supports[i]));
    setText(`#resistance-${i + 1}`, number(analysis.levels.resistances[i]));
  }
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
  drawSignals(latestMarket?.history || []);
}
async function getMarket() {
  try {
    const params = new URLSearchParams({ symbols: watchlist.map(item => item.symbol).join(','), symbol: activeSymbol, range: currentRange });
    const response = await fetch(`/api/market?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'เชื่อมต่อ Yahoo Finance ไม่สำเร็จ');
    latestMarket = data;
    const stocks = data.stocks || [];
    evaluateWatchlistAlerts(stocks);
    updateStockCards(stocks);
    renderMovers(stocks);
    const index = (data.indices || []).find(item => item.symbol === 'SET');
    if (index && Number(index.last) > 0) {
      const change = Number(index.last) - Number(index.prior);
      const pct = Number(index.prior) ? 100 * change / Number(index.prior) : 0;
      $('#set-index').innerHTML = `${number(index.last)} <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${number(Math.abs(change))} (${pct.toFixed(2)}%)</span>`;
      const stats = document.querySelectorAll('.banner-stats b');
      if (stats[0]) stats[0].innerHTML = `${number(index.volume)} <em>หุ้น</em>`;
      if (stats[1]) stats[1].textContent = `${number(index.high)} / ${number(index.low)}`;
    }
    const selected = stocks.find(item => item.symbol === activeSymbol);
    if (selected) setText('#chart-meta', `SET:${activeSymbol} · ${activeName || selected.fullName} · THB`);
  } catch (error) {
    console.warn('Market data refresh failed', error);
    if (!latestMarket) setText('#analysis-note', error.message);
  }
}

async function getNews() {
  try {
    const response = await fetch('/api/news'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    latestNews = data.items || [];
    renderNews(latestNews.filter(item => activeSource === 'all' || item.source === activeSource));
    setNewsStatus(`ดึงฟีดล่าสุด · ${stamp(data.fetchedAt)}`);
  } catch (_) { setNewsStatus('โหลดฟีดไม่สำเร็จ · เปิดเว็บไซต์ต้นทางจากลิงก์ด้านบน'); }
}
function renderNews(items) {
  const positive = /(กำไรเพิ่ม|กำไรพุ่ง|โตเด่น|เติบโต|บวก|รับอานิสงส์|ปรับขึ้น|เพิ่มขึ้น|ยอดขายโต|ซื้อคืน|ปันผลเพิ่ม|ผ่านจุดต่ำสุด|ฟื้นตัว|ชนะประมูล|คว้างาน|กำไรสุทธิ.*เพิ่ม)/i;
  const negative = /(ขาดทุน|กำไรลด|กำไรวูบ|ร่วง|ลดลง|หดตัว|ปิดลบ|ผิดนัด|ถูกฟ้อง|คดี|เพิ่มทุน|ลดเป้า|เลื่อนโครงการ|ผลกระทบ|คว่ำบาตร|ภัยแล้ง|ต้นทุนพุ่ง)/i;
  const title = item => String(item.title || '');
  const sentiment = item => positive.test(title(item)) && !negative.test(title(item)) ? 'บวก' : negative.test(title(item)) && !positive.test(title(item)) ? 'ลบ' : 'เป็นกลาง';
  const relevance = item => { const text = title(item).toLocaleUpperCase('th-TH'); const symbol = activeSymbol.toLocaleUpperCase('th-TH'); const name = String(activeName || '').trim(); return text.includes(symbol) || (name.length > 3 && title(item).includes(name)); };
  $('#news-list').innerHTML = items.length ? items.map(item => { const mood = sentiment(item), related = relevance(item), cls = mood === 'บวก' ? 'impact-positive' : mood === 'ลบ' ? 'impact-negative' : 'impact-neutral'; const badge = related ? `${mood}ต่อ ${activeSymbol}` : `ข่าวตลาด · ${mood}`; return `<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none"><div><div class="news-title">${escapeHtml(item.title)}</div><div class="news-tags"><span class="source-tag">${escapeHtml(item.sourceName)}</span><span class="news-impact ${cls}" title="ประเมินจากคำในพาดหัว ไม่ใช่การวิเคราะห์เนื้อหาฉบับเต็ม">${badge}</span>${related ? '' : '<span class="news-relevance">ไม่ได้ระบุหุ้นที่กำลังดู</span>'}</div></div><span class="news-time">${escapeHtml(stamp(item.pubDate))} ↗</span></a>`; }).join('') : '<div class="news-item"><div class="news-title">ไม่มีข่าวจากตัวกรองนี้ในขณะนี้</div></div>';
}

function setup() {
  setTheme(localStorage.getItem('setscope-theme') || 'light');
  renderWatchlist();
  renderAlertSettings(); renderAlertHistory(); updateNotificationStatus();
  const handleWatchlistClick = event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      event.stopPropagation();
      const symbol = remove.dataset.remove;
      watchlist = watchlist.filter(item => item.symbol !== symbol);
      if (activeSymbol === symbol && watchlist.length) { activeSymbol = watchlist[0].symbol; activeName = watchlist[0].name || activeSymbol; }
      saveWatchlist(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); renderMovers(latestMarket?.stocks || []); updateTradingViewChart(); getMarket(); return;
    }
    const row = event.target.closest('.watch-item');
    if (row) { activeSymbol = row.dataset.sym; activeName = row.dataset.name || activeSymbol; renderWatchlist(latestMarket?.stocks || []); renderNews(latestNews.filter(item => activeSource === 'all' || item.source === activeSource)); updateTradingViewChart(); getMarket(); }
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
  document.querySelectorAll('.source-chip').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.source-chip').forEach(item => item.classList.remove('active'));
    button.classList.add('active'); activeSource = button.dataset.source; getNews();
  }));
  $('#refresh-chart').addEventListener('click', getMarket);
  updateTradingViewChart(); getMarket(); getNews();
  setInterval(getMarket, 60000); setInterval(getNews, 300000);
}
setup();
