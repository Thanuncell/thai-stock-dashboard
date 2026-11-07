import { navigationUrl } from './domain.mjs';

const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const amount = value => value == null ? '—' : number.format(value);

export function createScreenerView(root, { fetchCoverage, currentIdentity, openChart }) {
  const get = id => root.querySelector('#screener-' + id);
  const tabs = [...get('index-groups').querySelectorAll('button')];
  const search = get('index-search'), status = get('index-status');
  const list = get('index-list'), pager = get('index-pager');
  const prev = get('index-prev'), next = get('index-next');
  const pageSize = 20;
  let catalog, request, membershipTimer, group = 'all', page = 1;

  function chartLink({ symbol, name }) {
    const link = document.createElement('a');
    link.href = navigationUrl({ route: 'chart', symbol, range: '1D' }, location.pathname);
    link.className = 'screener-stock-card';
    const ticker = document.createElement('strong');
    ticker.textContent = symbol;
    link.append(ticker);
    if (name && name !== symbol) {
      const company = document.createElement('small');
      company.textContent = name;
      link.append(company);
    }
    link.setAttribute('aria-label', 'เปิดกราฟ ' + symbol);
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openChart(symbol);
    });
    return link;
  }

  function render() {
    clearTimeout(membershipTimer);
    for (const button of tabs) button.setAttribute('aria-pressed', String(button.dataset.group === group));
    const membership = catalog?.groups[group];
    const validFor = membership?.available
      ? Date.parse(membership.effectiveThrough + 'T23:59:59.999+07:00') + 1 - Date.now()
      : 0;
    if (validFor > 0) membershipTimer = setTimeout(render, Math.min(validFor, 2147483647));
    const available = !!catalog && (group === 'all' || validFor > 0);
    search.disabled = !available;
    const members = new Set(membership?.symbols);
    const stocks = available ? catalog.stocks.filter(stock => group === 'all' || members.has(stock.symbol)) : [];
    const query = search.value.trim().toLocaleLowerCase('th');
    const matches = stocks.filter(stock => [stock.symbol, stock.name || '']
      .some(value => value.toLocaleLowerCase('th').includes(query)));
    if (catalog) status.textContent = available
      ? 'พบ ' + amount(matches.length) + ' จาก ' + amount(stocks.length) + ' หุ้นในกลุ่ม'
      : 'ข้อมูลกลุ่ม ' + group + ' ยังไม่พร้อม';
    const pages = Math.ceil(matches.length / pageSize);
    list.replaceChildren(...matches.slice((page - 1) * pageSize, page * pageSize).map(stock => {
      const item = document.createElement('li');
      item.append(chartLink(stock));
      return item;
    }));
    list.hidden = !matches.length;
    pager.hidden = pages < 2;
    get('index-page').textContent = 'หน้า ' + page + ' / ' + pages;
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
  }

  function reset() {
    request?.abort();
    request = catalog = null;
    group = 'all';
    search.value = status.textContent = '';
    page = 1;
    render();
  }

  async function load() {
    const identity = currentIdentity();
    if (!identity || request || catalog) return;
    const controller = request = new AbortController();
    status.textContent = 'กำลังโหลดรายชื่อหุ้น…';
    try {
      const response = await fetchCoverage(controller.signal);
      if (!response.ok) throw Error('coverage request failed');
      const value = await response.json();
      if (request !== controller || currentIdentity() !== identity) return;
      if (!Array.isArray(value.stocks) || !value.groups) throw Error('invalid coverage');
      catalog = value;
      render();
    } catch (_) {
      if (request === controller && currentIdentity() === identity) {
        catalog = null;
        render();
        status.textContent = 'โหลดรายชื่อหุ้นไม่สำเร็จ';
      }
    } finally {
      if (request === controller) request = null;
    }
  }

  for (const button of tabs) button.addEventListener('click', () => {
    group = button.dataset.group;
    page = 1;
    render();
  });
  search.addEventListener('input', () => { page = 1; render(); });
  prev.addEventListener('click', () => { page--; render(); if (prev.disabled) next.focus(); });
  next.addEventListener('click', () => { page++; render(); if (next.disabled) prev.focus(); });
  return { load, reset };
}
