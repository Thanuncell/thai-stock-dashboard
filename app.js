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
let alertPrefs = readLocal('setscope-alert-prefs', {});
let alertStates = readLocal('setscope-alert-states', {});
let alertHistory = readLocal('setscope-alert-history', []);
let unreadAlerts = 0;

function readLocal(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch (_) { return fallback; }
}

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
  renderAlertSettings();
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
  const ema50 = computeEma(values, 50).at(-1);
  const fast = computeEma(values, 12), slow = computeEma(values, 26);
  const macd = fast.map((value, index) => value - slow[index]);
  const signalLine = computeEma(macd, 9);
  const last = values.at(-1);
  const macdDiff = macd.at(-1) - signalLine.at(-1);
  const signals = {
    rsi: rsi < 30 ? 'ซื้อ' : rsi > 70 ? 'ขาย' : 'เป็นกลาง',
    macd: macdDiff > 0 ? 'ซื้อ' : 'ขาย',
    sma: last >= sma20 ? 'ซื้อ' : 'ขาย',
    ema: last >= ema50 ? 'ซื้อ' : 'ขาย'
  };
  const reasons = [
    { key: 'RSI (14)', signal: signals.rsi, value: `RSI ${rsi.toFixed(1)}`, detail: rsi < 30 ? 'ต่ำกว่า 30: แรงขายมาก อาจเกิดแรงรีบาวด์ แต่ยังไม่ยืนยันว่าราคากลับตัว' : rsi > 70 ? 'สูงกว่า 70: ภาวะซื้อมาก ราคาอาจย่อตัวได้ แต่ในขาขึ้น RSI อาจสูงต่อเนื่อง' : 'อยู่ระหว่าง 30–70: ยังไม่เข้าขอบเขตซื้อมาก/ขายมากตามเกณฑ์ทั่วไป' },
    { key: 'MACD (12, 26, 9)', signal: signals.macd, value: `MACD ${macd.at(-1).toFixed(3)} · Signal ${signalLine.at(-1).toFixed(3)}`, detail: macdDiff > 0 ? 'เส้น MACD อยู่เหนือเส้น Signal โมเมนตัมระยะสั้นเป็นบวก' : 'เส้น MACD อยู่ใต้เส้น Signal โมเมนตัมระยะสั้นเป็นลบ' },
    { key: 'SMA (20)', signal: signals.sma, value: `ราคา ${number(last)} · SMA ${number(sma20)}`, detail: last >= sma20 ? 'ราคาปิดอยู่เหนือค่าเฉลี่ย 20 แท่ง เป็นหลักฐานสนับสนุนแนวโน้มระยะสั้น' : 'ราคาปิดต่ำกว่าค่าเฉลี่ย 20 แท่ง แสดงว่าแนวโน้มระยะสั้นยังอ่อน' },
    { key: 'EMA (50)', signal: signals.ema, value: `ราคา ${number(last)} · EMA ${number(ema50)}`, detail: last >= ema50 ? 'ราคาอยู่เหนือค่าเฉลี่ย EMA 50 แท่ง สนับสนุนโมเมนตัมในช่วงที่ยาวขึ้น' : 'ราคาอยู่ต่ำกว่า EMA 50 แท่ง เป็นสัญญาณว่าระยะกลางยังมีแรงกดดัน' }
  ];
  const buy = Object.values(signals).filter(value => value === 'ซื้อ').length;
  const sell = Object.values(signals).filter(value => value === 'ขาย').length;
  const overall = buy > sell + 1 ? 'ซื้อ' : sell > buy + 1 ? 'ขาย' : 'เป็นกลาง';
  const recent = usable.slice(-20);
  const support = Math.min(...recent.map(bar => Number(bar.low) || Number(bar.close)));
  const resistance = Math.max(...recent.map(bar => Number(bar.high) || Number(bar.close)));
  return { values, rsi, sma20, ema50, macd: macd.at(-1), macdSignal: signalLine.at(-1), last, signals, reasons, buy, sell, overall, support, resistance };
}
function drawSignals(bars) {
  const analysis = analyseTechnicals(bars);
  if (!analysis) {
    setText('#analysis-note', `ได้รับข้อมูล ${(bars || []).length} จุด ต้องมีอย่างน้อย 30 แท่งเพื่อสรุปสัญญาณ`);
    $('#technical-reasons').innerHTML = '<p class="reason-empty">ข้อมูลยังไม่พอคำนวณ RSI, MACD และค่าเฉลี่ยให้ครบ</p>';
    setText('#technical-plan', 'รอข้อมูลเพิ่มก่อนสรุปเงื่อนไขที่ควรจับตา');
    return null;
  }
  const ids = { rsi: 'rsi-signal', macd: 'macd-signal', sma: 'sma-signal', ema: 'ema-signal' };
  Object.entries(analysis.signals).forEach(([key, value]) => {
    const el = document.getElementById(ids[key]);
    el.textContent = value;
    el.className = `pill ${value === 'ซื้อ' ? 'buy-pill' : value === 'ขาย' ? 'sell-pill' : 'neutral-pill'}`;
  });
  setText('#buy-count', String(analysis.buy)); setText('#sell-count', String(analysis.sell)); setText('#neutral-count', String(4 - analysis.buy - analysis.sell));
  setText('#overall-signal', analysis.overall); setText('.signal-score strong', analysis.overall); setText('.neutral-chip', analysis.overall);
  const gauge = Math.round(50 + (analysis.buy - analysis.sell) * 12);
  setText('.signal-gauge>b', String(gauge)); $('.gauge-needle').style.transform = `rotate(${-90 + gauge * 1.8}deg)`;
  setText('#rsi-value', analysis.rsi.toFixed(1)); $('.rsi-track i').style.left = `${analysis.rsi}%`;
  const supportive = analysis.reasons.filter(reason => reason.signal === 'ซื้อ');
  const opposing = analysis.reasons.filter(reason => reason.signal === 'ขาย');
  const neutral = analysis.reasons.filter(reason => reason.signal === 'เป็นกลาง');
  const group = (title, className, items) => `<div class="reason-group ${className}"><b>${title} (${items.length})</b>${items.length ? `<ul>${items.map(item => `<li><strong>${escapeHtml(item.key)} · ${escapeHtml(item.value)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join('')}</ul>` : '<p>ยังไม่มีหลักฐานจากชุด indicator นี้</p>'}</div>`;
  $('#technical-reasons').innerHTML = group('แรงหนุนฝั่งบวก', 'positive', supportive) + group('แรงกดดัน/เหตุผลฝั่งลบ', 'negative', opposing) + (neutral.length ? group('ยังไม่ชี้ทิศทาง', 'neutral', neutral) : '');
  setText('#technical-support', number(analysis.support)); setText('#technical-resistance', number(analysis.resistance));
  const plan = analysis.overall === 'ซื้อ'
    ? `หลักฐานเอนบวก ${analysis.buy}/4 ข้อ · จับตาว่าราคาจะยืนเหนือแนวต้าน ${number(analysis.resistance)} ได้หรือไม่; หากปิดต่ำกว่าแนวรับ ${number(analysis.support)} มุมมองนี้อ่อนลง`
    : analysis.overall === 'ขาย'
      ? `หลักฐานเอนลบ ${analysis.sell}/4 ข้อ · จับตาว่าราคาจะกลับยืนเหนือแนวรับ ${number(analysis.support)} ได้หรือไม่; หากหลุดระดับนี้แรงกดดันอาจต่อเนื่อง`
      : `สัญญาณบวก ${analysis.buy} ข้อและลบ ${analysis.sell} ข้อขัดแย้งกัน · รอราคาเลือกทิศทางเทียบแนวรับ ${number(analysis.support)} และแนวต้าน ${number(analysis.resistance)}`;
  setText('#technical-plan', plan);
  setText('#analysis-note', `${analysis.overall === 'ซื้อ' ? 'หลักฐานเอนบวก' : analysis.overall === 'ขาย' ? 'หลักฐานเอนลบ' : 'สัญญาณยังผสม'} · ซื้อ ${analysis.buy} / กลาง ${4 - analysis.buy - analysis.sell} / ขาย ${analysis.sell} · กราฟช่วง ${currentRange} (${analysis.values.length} แท่ง)`);
  return analysis;
}
function getAlertPref(symbol) { return alertPrefs[symbol] || { technical: true, above: '', below: '' }; }
function renderAlertSettings() {
  const root = $('#alerts-settings');
  if (!watchlist.length) { root.innerHTML = '<p class="alert-empty">เพิ่มหุ้นเข้า Watchlist ก่อนตั้งการเตือน</p>'; return; }
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
  const text = permission === 'granted' ? 'อนุญาตแล้ว · แจ้งเมื่อเปิดเว็บค้างไว้' : permission === 'denied' ? 'ถูกปิดกั้นโดยเบราว์เซอร์ · ปรับได้จากการตั้งค่าเว็บไซต์' : permission === 'unsupported' ? 'เบราว์เซอร์นี้ไม่รองรับแจ้งเตือนนอกหน้าเว็บ' : 'ยังไม่ได้อนุญาต · รายการแจ้งเตือนในหน้านี้ยังใช้ได้';
  setText('#notification-status', text);
  setText('#notification-permission', permission === 'granted' ? 'เปิดรับแจ้งเตือนแล้ว' : 'อนุญาตการแจ้งเตือนบนเบราว์เซอร์');
  $('#notification-permission').disabled = permission === 'granted' || permission === 'unsupported';
}
function recordAlert(symbol, title, body) {
  const item = { symbol, title, body, time: new Date().toISOString() };
  alertHistory.unshift(item); alertHistory = alertHistory.slice(0, 30);
  localStorage.setItem('setscope-alert-history', JSON.stringify(alertHistory));
  if ($('#alerts-panel').hidden) unreadAlerts++;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`${symbol} · ${title}`, { body, tag: `setscope-${symbol}-${title}` }); } catch (_) {}
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
      recordAlert(row.symbol, `สัญญาณเอน${analysis.overall}`, `${side.slice(0, 2).map(item => item.key).join(' และ ')} · ราคา ${number(price)} (Yahoo ล่าช้า)`);
    }
    const above = Number(pref.above), below = Number(pref.below);
    if (fresh && Number.isFinite(price) && Number(previous.price) > 0) {
      if (Number.isFinite(above) && above > 0 && previous.price < above && price >= above) recordAlert(row.symbol, 'ผ่านระดับราคาขาขึ้น', `ราคา ${number(price)} สูงกว่าระดับที่ตั้ง ${number(above)} (Yahoo ล่าช้า)`);
      if (Number.isFinite(below) && below > 0 && previous.price > below && price <= below) recordAlert(row.symbol, 'ผ่านระดับราคาขาลง', `ราคา ${number(price)} ต่ำกว่าระดับที่ตั้ง ${number(below)} (Yahoo ล่าช้า)`);
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
  drawSignals(latestMarket?.history || []);
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
    evaluateWatchlistAlerts(stocks);
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
  renderAlertSettings(); renderAlertHistory(); updateNotificationStatus();
  const handleWatchlistClick = event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      event.stopPropagation();
      if (watchlist.length === 1) { showSuggestions([], 'ต้องเหลือหุ้นอย่างน้อยหนึ่งตัวในรายการ'); return; }
      const symbol = remove.dataset.remove;
      watchlist = watchlist.filter(item => item.symbol !== symbol);
      if (activeSymbol === symbol) activeSymbol = watchlist[0].symbol;
      saveWatchlist(); renderWatchlist(latestMarket?.stocks || []); renderAlertSettings(); updateTradingViewChart(); getMarket(); return;
    }
    const row = event.target.closest('.watch-item');
    if (row) { activeSymbol = row.dataset.sym; renderWatchlist(latestMarket?.stocks || []); updateTradingViewChart(); getMarket(); }
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
