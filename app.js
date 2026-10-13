const DEFAULT_WATCHLIST = [
  { symbol: 'PTT', name: 'ปตท.' },
  { symbol: 'AOT', name: 'ท่าอากาศยานไทย' },
  { symbol: 'ADVANC', name: 'แอดวานซ์ อินโฟร์' },
  { symbol: 'KBANK', name: 'ธนาคารกสิกรไทย' },
  { symbol: 'CPALL', name: 'ซีพี ออลล์' }
];
const THAI_NAMES = Object.fromEntries(DEFAULT_WATCHLIST.map(x => [x.symbol, x.name]));
const $ = selector => document.querySelector(selector);
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
let watchlist = loadWatchlist();
let activeSymbol = watchlist[0]?.symbol || 'PTT';
let latestMarket = null;
let activeSource = 'all';
let searchTimer;
let searchSequence = 0;
let currentRange = '1D';

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem('setscope-watchlist') || 'null');
    if (Array.isArray(saved)) {
      return saved.filter(x => x && /^[A-Z0-9&.-]{1,20}$/.test(x.symbol || '')).slice(0, 12);
    }
  } catch (_) {}
  return DEFAULT_WATCHLIST.map(x => ({ ...x }));
}
function saveWatchlist() { localStorage.setItem('setscope-watchlist', JSON.stringify(watchlist)); }
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function status(text, kind = 'wait') {
  const el = $('.market-hours');
  if (el) el.innerHTML = `<i class="${kind}"></i> ${escapeHtml(text)}`;
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
function updateLiveBadge(text) { document.querySelectorAll('.live-badge').forEach(el => { el.textContent = text; }); }

function renderWatchlist(rows = []) {
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  const markup = watchlist.length ? watchlist.map(item => {
    const quote = bySymbol[item.symbol];
    const change = quote ? Number(quote.last) - Number(quote.prior) : null;
    const percent = quote && Number(quote.prior) ? change / Number(quote.prior) * 100 : null;
    return `<div class="watch-item ${activeSymbol === item.symbol ? 'selected' : ''}" data-sym="${escapeHtml(item.symbol)}">
      <div class="watch-details"><span class="watch-symbol">${escapeHtml(item.symbol)}</span><span class="watch-name">${escapeHtml(item.name || item.symbol)}</span></div>
      <div class="watch-quote"><span class="watch-price">${quote ? number(quote.last) : '—'}</span>${percent === null ? '' : `<span class="watch-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${percent.toFixed(2)}%</span>`}</div>
      <button class="watch-remove" type="button" data-remove="${escapeHtml(item.symbol)}" aria-label="ลบ ${escapeHtml(item.symbol)}" title="นำออกจากรายการ">×</button>
    </div>`;
  }).join('') : '<div class="watch-empty">ยังไม่มีหุ้นในรายการ · ค้นหาหุ้นแล้วกดเพิ่มได้เลย</div>';
  $('#watchlist').innerHTML = markup;
  $('#watchlist-mobile').innerHTML = markup;
  setText('.nav-count', String(watchlist.length));
  setText('#watch-metric', String(watchlist.length));
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
  const intervals = { '1D': '5', '1W': '15', '1M': 'D', '3M': 'D', '1Y': 'W' };
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
    studies: ['MASimple@tv-basicstudies'],
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
      <span class="suggestion-ticker">${escapeHtml(item.symbol)}</span><span class="suggestion-name">${escapeHtml(item.name)}</span><small>${escapeHtml(item.exchange)} · SET/mai</small>
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
async function addStock(symbol, name = symbol, select = true) {
  symbol = String(symbol || '').trim().toUpperCase().replace(/\.BK$/, '');
  if (!/^[A-Z0-9&.-]{1,20}$/.test(symbol)) { showSuggestions([], 'ชื่อย่อหุ้นไม่ถูกต้อง'); return; }
  if (!watchlist.some(item => item.symbol === symbol) && watchlist.length >= 12) {
    showSuggestions([], 'รายการติดตามเต็ม 12 หุ้นแล้ว กรุณานำหุ้นเดิมออกก่อน'); return;
  }
  if (!watchlist.some(item => item.symbol === symbol)) watchlist.push({ symbol, name: name || symbol });
  else if (name && name !== symbol) watchlist = watchlist.map(item => item.symbol === symbol ? { ...item, name } : item);
  saveWatchlist();
  if (select) activeSymbol = symbol;
  renderWatchlist(latestMarket?.stocks || []);
  $('#stock-search').value = '';
  hideSuggestions();
  updateTradingViewChart();
  await getMarket();
}

function computeEma(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  return values.map((value, index) => index ? value * k + values[index - 1] * (1 - k) : value);
}
function drawSignals(values) {
  if (values.length < 30) {
    setText('#analysis-note', `ได้รับข้อมูล ${values.length} จุด ต้องมีข้อมูลเพิ่มเพื่อคำนวณสัญญาณได้ครบ`);
    return;
  }
  let gains = 0, losses = 0;
  for (let i = Math.max(1, values.length - 14); i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  const rsi = 100 - 100 / (1 + gains / Math.max(losses, 0.00001));
  const sma20 = values.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const ema50 = computeEma(values, 50).at(-1);
  const fast = computeEma(values, 12), slow = computeEma(values, 26);
  const macd = fast.map((value, index) => value - slow[index]);
  const signal = computeEma(macd, 9);
  const latest = values.at(-1);
  const signals = {
    'rsi-signal': rsi < 30 ? 'ซื้อ' : rsi > 70 ? 'ขาย' : 'เป็นกลาง',
    'sma-signal': latest > sma20 ? 'ซื้อ' : 'ขาย',
    'ema-signal': latest > ema50 ? 'ซื้อ' : 'ขาย',
    'macd-signal': macd.at(-1) > signal.at(-1) ? 'ซื้อ' : 'ขาย'
  };
  let buy = 0, sell = 0;
  Object.entries(signals).forEach(([id, text]) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `pill ${text === 'ซื้อ' ? 'buy-pill' : text === 'ขาย' ? 'sell-pill' : 'neutral-pill'}`;
    if (text === 'ซื้อ') buy++; else if (text === 'ขาย') sell++;
  });
  const overall = buy > sell + 1 ? 'ซื้อ' : sell > buy + 1 ? 'ขาย' : 'เป็นกลาง';
  setText('#buy-count', String(buy)); setText('#sell-count', String(sell)); setText('#neutral-count', String(4 - buy - sell));
  setText('#overall-signal', overall); setText('.signal-score strong', overall); setText('.neutral-chip', overall);
  setText('.signal-gauge>b', String(Math.round(50 + (buy - sell) * 12)));
  $('.gauge-needle').style.transform = `rotate(${-90 + (50 + (buy - sell) * 12) * 1.8}deg)`;
  setText('#rsi-value', rsi.toFixed(1));
  $('.rsi-track i').style.left = `${rsi}%`;
  setText('#analysis-note', `RSI ${rsi.toFixed(1)} · MACD · SMA 20 · EMA 50 คำนวณจาก ${values.length} จุดราคาจาก Yahoo Finance`);
}
function updateStockCards(rows) {
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  renderWatchlist(rows);
  const quote = bySymbol[activeSymbol];
  if (!quote) {
    setText('#chart-price', '—'); setText('#chart-change', `ไม่พบราคา ${activeSymbol} จาก Yahoo Finance`);
    setText('#chart-name', THAI_NAMES[activeSymbol] || watchlist.find(item => item.symbol === activeSymbol)?.name || activeSymbol);
    setText('#history-count', String(latestMarket?.history?.length || 0));
    return;
  }
  const change = Number(quote.last) - Number(quote.prior);
  const percent = Number(quote.prior) ? change / Number(quote.prior) * 100 : 0;
  setText('#chart-price', number(quote.last));
  setText('#chart-change', `${change >= 0 ? '+' : ''}${number(change)} (${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%)`);
  $('#chart-change').className = change >= 0 ? 'up' : 'down';
  setText('#chart-name', quote.fullName || quote.symbol);
  setText('#history-count', String(latestMarket?.history?.length || 0));
  drawSignals((latestMarket?.history || []).map(bar => Number(bar.close)).filter(Number.isFinite));
}
async function getMarket() {
  if (!watchlist.length) { renderWatchlist(); return; }
  try {
    const params = new URLSearchParams({ symbols: watchlist.map(item => item.symbol).join(','), symbol: activeSymbol, range: currentRange });
    const response = await fetch(`/api/market?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'เชื่อมต่อ Yahoo Finance ไม่สำเร็จ');
    latestMarket = data;
    const stocks = data.stocks || [];
    updateStockCards(stocks);
    const index = (data.indices || []).find(item => item.symbol === 'SET');
    if (index && Number(index.last) > 0) {
      const change = Number(index.last) - Number(index.prior);
      const pct = Number(index.prior) ? 100 * change / Number(index.prior) : 0;
      $('#set-index').innerHTML = `${number(index.last)} <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${number(Math.abs(change))} (${pct.toFixed(2)}%)</span>`;
      const stats = document.querySelectorAll('.banner-stats b');
      if (stats[0]) stats[0].innerHTML = `${number(index.volume)} <em>หุ้น</em>`;
      if (stats[2]) stats[2].textContent = `${number(index.high)} / ${number(index.low)}`;
    }
    setText('#market-connection', 'Yahoo · ล่าช้า 15 นาที');
    setText('.date-button span', stamp(data.fetchedAt));
    status('Yahoo · ล่าช้า 15 นาที');
    updateLiveBadge('DELAYED 15M');
    const selected = stocks.find(item => item.symbol === activeSymbol);
    if (selected) $('.chart-meta').innerHTML = `TradingView · SET:${escapeHtml(activeSymbol)} <span>วิเคราะห์ด้วย Yahoo Finance · อัปเดต ${stamp(selected.time)}</span>`;
  } catch (error) {
    status('Yahoo Finance ไม่พร้อม', 'error'); updateLiveBadge('OFFLINE');
    setText('#market-connection', latestMarket ? 'ข้อมูลล่าสุดอาจเก่า' : 'ยังไม่เชื่อมต่อ');
    if (!latestMarket) setText('#analysis-note', error.message);
  }
}

async function getNews() {
  try {
    const response = await fetch('/api/news'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    renderNews((data.items || []).filter(item => activeSource === 'all' || item.source === activeSource));
    setNewsStatus(`ดึงฟีดล่าสุด · ${stamp(data.fetchedAt)}`);
  } catch (_) { setNewsStatus('โหลดฟีดไม่สำเร็จ · เปิดเว็บไซต์ต้นทางจากลิงก์ด้านบน'); }
}
function renderNews(items) {
  $('#news-list').innerHTML = items.length ? items.map(item => `<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none"><div><div class="news-title">${escapeHtml(item.title)}</div><div class="news-tags"><span class="source-tag">${escapeHtml(item.sourceName)}</span><span class="demo-tag">ข่าวล่าสุด · ต้นทาง</span></div></div><span class="news-time">${escapeHtml(stamp(item.pubDate))} ↗</span></a>`).join('') : '<div class="news-item"><div class="news-title">ไม่มีข่าวจากตัวกรองนี้ในขณะนี้</div></div>';
}

function setup() {
  setTheme(localStorage.getItem('setscope-theme') || 'light');
  renderWatchlist();
  const handleWatchlistClick = event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      event.stopPropagation();
      if (watchlist.length === 1) { showSuggestions([], 'ต้องเหลือหุ้นอย่างน้อยหนึ่งตัวในรายการ'); return; }
      const symbol = remove.dataset.remove;
      watchlist = watchlist.filter(item => item.symbol !== symbol);
      if (activeSymbol === symbol) activeSymbol = watchlist[0].symbol;
      saveWatchlist(); renderWatchlist(latestMarket?.stocks || []); updateTradingViewChart(); getMarket(); return;
    }
    const row = event.target.closest('.watch-item');
    if (row) { activeSymbol = row.dataset.sym; renderWatchlist(latestMarket?.stocks || []); updateTradingViewChart(); getMarket(); }
  };
  $('#watchlist').addEventListener('click', handleWatchlistClick);
  $('#watchlist-mobile').addEventListener('click', handleWatchlistClick);
  $('#add-watchlist').addEventListener('click', () => { $('#stock-search').focus(); $('#stock-search').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
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
      if (first) { event.preventDefault(); addStock(first.dataset.symbol, first.dataset.name); }
      else if (/^[A-Z0-9&.-]{1,20}$/i.test(event.target.value.trim())) { event.preventDefault(); addStock(event.target.value.trim()); }
    }
  });
  $('#search-add').addEventListener('click', () => {
    const first = $('.suggestion-item');
    if (first) addStock(first.dataset.symbol, first.dataset.name);
    else if ($('#stock-search').value.trim()) addStock($('#stock-search').value.trim());
  });
  $('#symbol-suggestions').addEventListener('click', event => {
    const result = event.target.closest('.suggestion-item');
    if (result) addStock(result.dataset.symbol, result.dataset.name);
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
