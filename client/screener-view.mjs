import { THAI_NAMES } from './domain.mjs';
import { SCREENER_SCHEMA_VERSION, queryScreenerSnapshot } from './screener-core.mjs';

const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
const date = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const amount = value => value == null ? '—' : number.format(value);
const indicators = [['ema20', 'EMA20'], ['ema50', 'EMA50'], ['rsi14', 'RSI14'], ['macd', 'MACD']];

export function createScreenerView(root, { fetchSnapshot, currentIdentity }) {
  const get = id => root.querySelector('#screener-' + id);
  const status = get('status'), coverage = get('coverage'), reload = get('reload');
  const form = get('filters'), filterError = get('filter-error'), summary = get('result-summary');
  const results = get('results'), body = results.querySelector('tbody');
  const pager = get('pager'), prev = get('prev'), next = get('next');
  let snapshot, expiresAt, expiryTimer, request, settled = false, page = 1;
  let filters = {}, sort = {};

  function renderAvailability(counts) {
    const container = get('availability');
    container.hidden = !counts;
    for (const [name, key] of [['ready', 'ready'], ['unavailable', 'unavailable'], ['stale', 'staleSession'], ['blocked', 'guardBlocked']])
      get(name + '-count').textContent = counts ? amount(counts[key]) : '—';
    coverage.textContent = counts
      ? 'หุ้นในทะเบียน ' + amount(counts.registered) + ' · เข้าเกณฑ์ Coverage ' + amount(counts.eligible)
        + ' · มีราคาปิดรอบล่าสุด ' + amount(counts.ready) + ' · ข้อมูลเก่า ' + amount(counts.staleSession)
        + ' · ไม่มีข้อมูล ' + amount(counts.unavailable) + ' · ไม่ผ่านการตรวจข้อมูล ' + amount(counts.guardBlocked)
        + ' · ไม่เข้าเกณฑ์ Coverage ' + amount(counts.coverageIneligible) : '';
  }

  function clearResults() {
    body.replaceChildren();
    results.hidden = true;
    pager.hidden = true;
    summary.textContent = '';
  }

  function showExpired() {
    clearTimeout(expiryTimer);
    expiresAt = 0;
    snapshot = null;
    renderAvailability(null);
    status.textContent = 'ข้อมูลคัดกรองหมดอายุ กรุณาโหลดข้อมูลของรอบล่าสุด';
    form.hidden = true;
    reload.hidden = false;
    clearResults();
  }

  function reset() {
    request?.abort();
    clearTimeout(expiryTimer);
    request = snapshot = null;
    expiresAt = 0;
    settled = false;
    page = 1;
    filters = {};
    sort = {};
    form.reset();
    form.hidden = reload.hidden = filterError.hidden = true;
    status.textContent = '';
    renderAvailability(null);
    clearResults();
  }

  function textCell(row, value, heading = false) {
    const cell = document.createElement(heading ? 'th' : 'td');
    if (heading) cell.scope = 'row';
    cell.textContent = value;
    row.append(cell);
    return cell;
  }

  function render(nextFilters = filters, nextSort = sort, nextPage = page) {
    if (!snapshot) return;
    if (Date.now() >= expiresAt) return showExpired();
    let result;
    try {
      result = queryScreenerSnapshot(snapshot, nextFilters, { ...nextSort, page: nextPage });
    } catch (_) {
      filterError.textContent = 'ตรวจช่วงตัวกรองให้ถูกต้อง ค่าต่ำสุดต้องไม่เกินค่าสูงสุด';
      filterError.hidden = false;
      return;
    }
    filters = nextFilters;
    sort = nextSort;
    page = nextPage;
    filterError.hidden = true;
    const { matched, evaluated, unevaluable } = result.counts;
    summary.textContent = matched
      ? 'พบ ' + amount(matched) + ' หุ้น · ประเมินได้ ' + amount(evaluated) + ' · ข้อมูลตัวกรองไม่พอ ' + amount(unevaluable)
      : 'ไม่พบหุ้นที่ตรงกับตัวกรอง · ประเมินได้ ' + amount(evaluated) + ' · ข้อมูลตัวกรองไม่พอ ' + amount(unevaluable);
    body.replaceChildren(...result.rows.map(stock => {
      const row = document.createElement('tr');
      const name = textCell(row, stock.symbol, true);
      if (THAI_NAMES[stock.symbol]) {
        const detail = document.createElement('small');
        detail.textContent = THAI_NAMES[stock.symbol];
        name.append(document.createElement('br'), detail);
      }
      textCell(row, amount(stock.price.close));
      textCell(row, stock.available.changePercent ? amount(stock.price.changePercent) + '%' : '—');
      const tech = textCell(row, '');
      for (const [key, label] of indicators) {
        const detail = document.createElement('span');
        detail.textContent = label + ' ' + (stock.available[key] ? amount(stock.technical[key]) : 'ยังไม่พร้อม');
        tech.append(detail);
      }
      return row;
    }));
    results.hidden = !result.rows.length;
    pager.hidden = result.totalPages < 2;
    get('page-number').textContent = 'หน้า ' + page + ' / ' + result.totalPages;
    prev.disabled = page <= 1;
    next.disabled = page >= result.totalPages;
  }

  async function load({ force = false } = {}) {
    const identity = currentIdentity();
    if (!identity || request) return;
    if (settled && !force) {
      if (expiresAt && Date.now() >= expiresAt) showExpired();
      return;
    }
    const controller = request = new AbortController();
    clearTimeout(expiryTimer);
    expiresAt = 0;
    snapshot = null;
    form.hidden = reload.hidden = true;
    clearResults();
    status.textContent = 'กำลังโหลดข้อมูลคัดกรองหุ้น…';
    renderAvailability(null);
    try {
      const response = await fetchSnapshot(controller.signal);
      if (!response.ok) throw Error('snapshot request failed');
      const data = await response.json();
      if (request !== controller || currentIdentity() !== identity) return;
      expiresAt = Date.parse(data.validUntil);
      if (!Number.isFinite(expiresAt) || !['CURRENT_SESSION', 'STALE', 'UNAVAILABLE'].includes(data.marketFreshness))
        throw Error('invalid snapshot metadata');
      if (Date.now() >= expiresAt) return showExpired();
      const value = data.snapshot;
      if (value && (value.schemaVersion !== SCREENER_SCHEMA_VERSION || !Array.isArray(value.rows)
        || value.sessionDate !== data.latestCompletedSessionDate || !Number.isFinite(Date.parse(value.generatedAt))))
        throw Error('invalid snapshot');
      const latest = data.latestCompletedSessionDate;
      const session = latest ? date.format(new Date(latest + 'T00:00:00+07:00')) : 'ไม่ทราบ';
      const counts = value?.counts || data.availability;
      renderAvailability(counts || null);
      const ready = data.marketFreshness === 'CURRENT_SESSION' && value?.state === 'COMPLETE'
        && counts?.ready > 0 && counts.ready === counts.eligible
        && counts.staleSession === 0 && counts.unavailable === 0 && counts.guardBlocked === 0;
      const message = ready ? 'มีข้อมูลรอบล่าสุด'
        : data.marketFreshness === 'STALE' ? 'ข้อมูลเก่ากว่ารอบล่าสุด' : 'ข้อมูลคัดกรองยังไม่พร้อม';
      status.textContent = message + ' · รอบซื้อขายล่าสุดที่ปิดแล้ว ' + session
        + (value ? ' · คำนวณเมื่อ ' + dateTime.format(new Date(value.generatedAt)) + ' (เวลาไทย)' : '');
      expiryTimer = setTimeout(showExpired, expiresAt - Date.now());
      if (!value) return;
      if (!ready) return;
      snapshot = value;
      form.hidden = false;
      page = 1;
      render();
    } catch (_) {
      if (request === controller && currentIdentity() === identity) {
        clearTimeout(expiryTimer);
        expiresAt = 0;
        snapshot = null;
        form.hidden = true;
        clearResults();
        renderAvailability(null);
        status.textContent = 'โหลดข้อมูลคัดกรองไม่สำเร็จ กรุณาลองอีกครั้ง';
      }
    } finally {
      if (request === controller) {
        request = null;
        if (currentIdentity() === identity) {
          settled = true;
          reload.hidden = false;
        }
      }
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const fields = form.elements;
    const range = key => {
      const min = fields.namedItem(key + 'Min');
      const max = fields.namedItem(key + 'Max');
      return { min: min.value === '' ? null : min.valueAsNumber, max: max.value === '' ? null : max.valueAsNumber };
    };
    const [sortBy, sortDirection] = fields.namedItem('sort').value.split(':');
    render({
      search: fields.namedItem('search').value,
      price: range('price'), changePercent: range('changePercent'), rsi14: range('rsi14'),
      ema20: fields.namedItem('ema20').value, ema50: fields.namedItem('ema50').value, macd: fields.namedItem('macd').value
    }, { sortBy, sortDirection }, 1);
  });
  form.addEventListener('reset', () => render({}, {}, 1));
  form.addEventListener('change', event => {
    const fields = form.elements;
    const preset = fields.namedItem('preset');
    if (event.target === preset) {
      fields.namedItem('ema20').value = fields.namedItem('ema50').value = preset.value === 'trend' ? 'above' : 'any';
      fields.namedItem('macd').value = preset.value === 'momentum' ? 'above' : 'any';
    } else if (['ema20', 'ema50', 'macd'].includes(event.target.name)) preset.value = '';
  });
  prev.addEventListener('click', () => { render(filters, sort, page - 1); if (prev.disabled && !next.disabled) next.focus(); });
  next.addEventListener('click', () => { render(filters, sort, page + 1); if (next.disabled && !prev.disabled) prev.focus(); });
  reload.addEventListener('click', () => load({ force: true }));

  return { load, reset };
}
