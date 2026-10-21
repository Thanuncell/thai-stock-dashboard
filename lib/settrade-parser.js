'use strict';

function decodeXml(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number))).replace(/&#x([\da-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(block, name) {
  return block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '';
}

function marketHtmlText(value = '') {
  return decodeXml(String(value).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function marketRowsFromTable(table = '') {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(match => [...match[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(cell => marketHtmlText(cell[1])).filter(Boolean))
    .filter(row => row.length);
}

function marketNumber(value) {
  const number = Number(String(value || '').replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(number) ? number : null;
}

function parseSettradeMarket(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  const indexTable = tables.find(table => table.includes('index=SET') && table.includes('index=mai')) || '';
  const indices = [...indexTable.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => {
    const row = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => marketHtmlText(cell[1]));
    const href = match[1].match(/index=(SET|mai)(?:&|[\x22'])/i)?.[1];
    if (!href || row.length < 7) return null;
    const change = row[2]?.match(/([-+]?\d[\d,.]*)\s*\(([-+]?\d[\d,.]*)%\)/);
    const range = (row[4] || '').match(/([-+]?\d[\d,.]*)\s+([-+]?\d[\d,.]*)/);
    return {
      symbol: href.toUpperCase() === 'MAI' ? 'mai' : 'SET',
      last: marketNumber(row[1]),
      change: change ? marketNumber(change[1]) : null,
      changePercent: change ? marketNumber(change[2]) : null,
      open: marketNumber(row[3]),
      low: range ? marketNumber(range[1]) : null,
      high: range ? marketNumber(range[2]) : null,
      volumeThousand: marketNumber(row[5]),
      turnoverMillion: marketNumber(row[6])
    };
  }).filter(Boolean);
  const breadth = [];
  let breadthMarketIndex = 0;
  for (const table of tables) {
    const rows = marketRowsFromTable(table);
    if (rows.some(row => /Gainers|Unchanges|Losers/i.test(row[0] || ''))) {
      const market = ['SET', 'mai'][breadthMarketIndex++] || 'SET';
      breadth.push({
        market,
        items: rows.filter(row => /Gainers|Unchanges|Losers/i.test(row[0] || '')).map(row => ({
          label: row[0], count: marketNumber(row[1]), volumeThousand: marketNumber(row[2])
        }))
      });
    }
  }
  const text = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const closeStart = text.indexOf('หลังตลาดปิด');
  const closeSummary = closeStart >= 0 ? text.slice(closeStart).replace(/^หลังตลาดปิด\s*:?\s*/, '').split(/ดูเพิ่มเติม|ติดต่อเรา/)[0].trim().slice(0, 1200) : '';
  return { indices, breadth, closeSummary };
}

function parseSettradeForeign(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  const table = tables.find(value => value.includes('นักลงทุนต่างประเทศ') && value.includes('มูลค่าซื้อ')) || '';
  const row = marketRowsFromTable(table).find(items => items[0]?.includes('นักลงทุนต่างประเทศ'));
  const page = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const date = page.match(/ข้อมูล ณ วันที่\s*(\d{1,2}\s+[^\s]+\s+\d{4}|[\d/.-]{8,10})/)?.[1]?.trim() || '';
  return row ? {
    date,
    name: row[0],
    buyMillion: marketNumber(row[1]),
    sellMillion: marketNumber(row[3]),
    netMillion: marketNumber(row[5])
  } : { date, name: 'นักลงทุนต่างประเทศ', buyMillion: null, sellMillion: null, netMillion: null };
}

function parseSettradeNvdr(html) {
  const text = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const market = text.match(/มูลค่าการซื้อขายของ SET และ mai \(ล้านบาท\)\s*([\d,.]+)/);
  const nvdr = text.match(/มูลค่าการซื้อขายของ NVDR \(ล้านบาท\)\s*([\d,.]+)/);
  const ratio = text.match(/สัดส่วนของ NVDR เทียบกับ SET และ mai \(%\)\s*([\d,.]+)/);
  return {
    marketMillion: market ? marketNumber(market[1]) : null,
    nvdrMillion: nvdr ? marketNumber(nvdr[1]) : null,
    ratioPercent: ratio ? marketNumber(ratio[1]) : null
  };
}

function parseRange(value = '') {
  const numbers = String(value).match(/[-+]?\d[\d,.]*/g) || [];
  return {
    low: numbers.length > 0 ? marketNumber(numbers[0]) : null,
    high: numbers.length > 1 ? marketNumber(numbers[1]) : null
  };
}

function tableWithHeaders(html, requiredHeaders) {
  const tables = [...String(html || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  return tables.find(table => {
    const rows = marketRowsFromTable(table);
    const header = (rows[0] || []).join(' ').toLocaleLowerCase('th');
    return requiredHeaders.every(label => header.includes(label.toLocaleLowerCase('th')));
  }) || '';
}

function columnIndex(headers, pattern) {
  return headers.findIndex(header => pattern.test(String(header || '').replace(/\s+/g, ' ').trim()));
}

function parseSettradeActiveValue(html) {
  const table = tableWithHeaders(html, ['ชื่อย่อหลักทรัพย์', 'มูลค่า AOM', 'ราคาล่าสุด']);
  const tableRows = marketRowsFromTable(table);
  const headers = tableRows[0] || [];
  const columns = {
    rank: columnIndex(headers, /^อันดับ$/i),
    symbol: columnIndex(headers, /^ชื่อย่อหลักทรัพย์$/i),
    turnover: columnIndex(headers, /^มูลค่า AOM \(ล้านบาท\)$/i),
    volume: columnIndex(headers, /^ปริมาณ AOM \(['’]?000 หุ้น\)$/i),
    last: columnIndex(headers, /^ราคาล่าสุด$/i),
    change: columnIndex(headers, /^เปลี่ยนแปลง$/i),
    changePercent: columnIndex(headers, /^เปลี่ยนแปลง \(%\)$/i),
    range: columnIndex(headers, /^Intraday \(Low\/High\)$/i)
  };
  const hasSchema = Object.values(columns).every(index => index >= 0);
  const rows = hasSchema ? tableRows.slice(1) : [];
  const items = rows.map(row => {
    const rank = row[columns.rank];
    const symbol = row[columns.symbol];
    if (!/^\d+$/.test(rank || '') || !/^[A-Z0-9&.-]{1,20}$/i.test(symbol || '')) return null;
    const range = parseRange(row[columns.range]);
    const item = {
      rank: Number(rank),
      symbol: symbol.toUpperCase(),
      turnoverMillion: marketNumber(row[columns.turnover]),
      volumeThousand: marketNumber(row[columns.volume]),
      last: marketNumber(row[columns.last]),
      change: marketNumber(row[columns.change]),
      changePercent: marketNumber(row[columns.changePercent]),
      low: range.low,
      high: range.high
    };
    if (!Number.isInteger(item.rank) || item.rank < 1 || item.rank > 100) return null;
    if (item.turnoverMillion === null || item.turnoverMillion < 0 || item.volumeThousand === null || item.volumeThousand < 0) return null;
    if (item.last !== null && item.last < 0) return null;
    if (item.low !== null && item.high !== null && item.low > item.high) return null;
    return item;
  }).filter(Boolean);
  const text = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const asOf = text.match(/ข้อมูลล่าสุด\s*([^|]+?\d{1,2}:\d{2}:\d{2})/)?.[1]?.trim() || '';
  return { items, asOf };
}

function parseSettradeTfex(html) {
  const page = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const totals = page.match(/Total Market\s*([-+\d,.]+|-)\s*([-+\d,.]+|-)/i);
  const totalVolume = totals && totals[1] !== '-' ? marketNumber(totals[1]) : null;
  const openInterest = totals && totals[2] !== '-' ? marketNumber(totals[2]) : null;
  const delayMinutes = marketNumber(page.match(/ข้อมูลล่าช้า\s*(\d+)\s*นาที/)?.[1]) || 15;
  const marketDate = page.match(/ข้อมูล ณ วันที่\s*([^|]+?\d{4})/)?.[1]?.trim() || '';

  const investorTable = tableWithHeaders(html, ['นักลงทุน', 'ซื้อ', 'ขาย', 'สุทธิ']);
  const investorRows = marketRowsFromTable(investorTable);
  const investorHeaders = investorRows[0] || [];
  const investorColumns = {
    name: columnIndex(investorHeaders, /^นักลงทุน$/i),
    buy: columnIndex(investorHeaders, /^ซื้อ$/i),
    sell: columnIndex(investorHeaders, /^ขาย$/i),
    net: columnIndex(investorHeaders, /^สุทธิ$/i)
  };
  const investorSchema = Object.values(investorColumns).every(index => index >= 0);
  const investorType = (investorSchema ? investorRows.slice(1) : []).map(row => {
    const name = row[investorColumns.name];
    if (/ไม่มีข้อมูล/i.test(name || '')) return null;
    const item = {
      name,
      buy: marketNumber(row[investorColumns.buy]),
      sell: marketNumber(row[investorColumns.sell]),
      net: marketNumber(row[investorColumns.net])
    };
    return item.buy === null && item.sell === null && item.net === null ? null : item;
  }).filter(Boolean);

  const topTable = tableWithHeaders(html, ['ชื่อย่อสัญญา', 'ปริมาณ (สัญญา)', 'ราคาล่าสุด']);
  const topRows = marketRowsFromTable(topTable);
  const topHeaders = topRows[0] || [];
  const topColumns = {
    symbol: columnIndex(topHeaders, /^ชื่อย่อสัญญา$/i),
    volume: columnIndex(topHeaders, /^ปริมาณ \(สัญญา\)$/i),
    last: columnIndex(topHeaders, /^ราคาล่าสุด$/i),
    change: columnIndex(topHeaders, /^เปลี่ยนแปลง$/i),
    changePercent: columnIndex(topHeaders, /^เปลี่ยนแปลง \(%\)$/i)
  };
  const topSchema = Object.values(topColumns).every(index => index >= 0);
  const topVolume = (topSchema ? topRows.slice(1) : []).map(row => {
    const symbol = row[topColumns.symbol];
    if (!/^[A-Z0-9&.-]{1,30}$/i.test(symbol || '') || /ไม่มีข้อมูล/i.test(symbol)) return null;
    const item = {
      symbol: symbol.toUpperCase(),
      volume: marketNumber(row[topColumns.volume]),
      last: marketNumber(row[topColumns.last]),
      change: marketNumber(row[topColumns.change]),
      changePercent: marketNumber(row[topColumns.changePercent])
    };
    return item.volume === null || item.volume < 0 || (item.last !== null && item.last < 0) ? null : item;
  }).filter(Boolean);

  return {
    available: totalVolume !== null || openInterest !== null || investorType.length > 0 || topVolume.length > 0,
    delayMinutes,
    totalVolume,
    openInterest,
    marketDate,
    investorType,
    topVolume
  };
}

module.exports = {
  decodeXml,
  marketHtmlText,
  marketNumber,
  marketRowsFromTable,
  parseSettradeForeign,
  parseSettradeActiveValue,
  parseSettradeMarket,
  parseSettradeNvdr,
  parseSettradeTfex,
  xmlTag
};
