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

module.exports = {
  decodeXml,
  marketHtmlText,
  marketNumber,
  marketRowsFromTable,
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr,
  xmlTag
};
