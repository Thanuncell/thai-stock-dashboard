'use strict';

const { parseHydratedMaiBreadth } = require('./settrade-breadth-hydration');

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
    .map(match => [...match[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(cell => marketHtmlText(cell[1])))
    .filter(row => row.some(Boolean));
}

function marketNumber(value) {
  const number = Number(String(value || '').replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(number) ? number : null;
}

const PARSE_OUTCOME = Object.freeze({
  ACCEPT: 'ACCEPT',
  SOURCE_NO_DATA: 'SOURCE_NO_DATA',
  PARSER_MISMATCH: 'PARSER_MISMATCH',
  INVALID_DATA: 'INVALID_DATA'
});

function breadthNumber(value, integer = false) {
  const text = normalizedLabel(value);
  const missing = /^(?:|—|-|N\/A)$/i.test(text);
  const number = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text) ? Number(text.replace(/,/g, '')) : NaN;
  const valid = Number.isFinite(number) && number >= 0 && (!integer || Number.isSafeInteger(number));
  return { value: valid ? number : null, invalid: !missing && !valid };
}

function annotateParse(result, diagnostics) {
  Object.defineProperty(result, '__diagnostics', { value: diagnostics, enumerable: false });
  return result;
}

function classifySettradeParse(field, result) {
  return result?.__diagnostics?.[field] || result?.__diagnostics?.result || PARSE_OUTCOME.PARSER_MISMATCH;
}

function normalizedLabel(value = '') {
  return String(value).replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

function findHeaderRow(rows, requiredPatterns) {
  const index = rows.findIndex(row => requiredPatterns.every(pattern => row.some(cell => pattern.test(normalizedLabel(cell)))));
  return { index, headers: index >= 0 ? rows[index] : [] };
}

function headerIndex(headers, patterns) {
  const candidates = Array.isArray(patterns) ? patterns : [patterns];
  return headers.findIndex(header => candidates.some(pattern => pattern.test(normalizedLabel(header))));
}

function isNonNegative(value) {
  return value === null || value >= 0;
}

function explicitNoData(html = '') {
  return /(?:^|[>\s])(?:ไม่มีข้อมูล|ไม่พบข้อมูล|no data|result empty)(?:$|[<\s])/i.test(String(html));
}

function parseSettradeMarket(html) {
  const tableMatches = [...String(html || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const tables = tableMatches.map(match => match[1]);
  let indexCandidates = 0;
  let invalidIndexCandidates = 0;
  let indices = [];
  for (const table of tables) {
    const rows = marketRowsFromTable(table);
    const header = findHeaderRow(rows, [/^(?:ดัชนี(?:ตลาด)?|index)$/i, /^(?:ค่า)?ล่าสุด|^last/i]);
    if (header.index < 0) continue;
    const columns = {
      symbol: headerIndex(header.headers, [/^(?:ดัชนี(?:ตลาด)?|index)$/i]),
      last: headerIndex(header.headers, [/^(?:ค่า)?ล่าสุด$/i, /^last(?: price)?$/i]),
      change: headerIndex(header.headers, [/เปลี่ยนแปลง/i, /^change/i]),
      open: headerIndex(header.headers, [/^(?:ราคา)?เปิด$/i, /^open$/i]),
      range: headerIndex(header.headers, [/intraday/i, /ต่ำสุด.*สูงสุด/i, /low.*high/i]),
      volume: headerIndex(header.headers, [/ปริมาณ/i, /^volume/i]),
      turnover: headerIndex(header.headers, [/มูลค่า/i, /turnover|value/i])
    };
    const parsed = rows.slice(header.index + 1).map(row => {
      const symbolText = normalizedLabel(row[columns.symbol]);
      const symbolMatch = symbolText.match(/^(SET|mai)$/i);
      if (!symbolMatch) return null;
      indexCandidates += 1;
      const changeText = columns.change >= 0 ? row[columns.change] : '';
      const change = String(changeText || '').match(/([-+]?\d[\d,.]*)\s*\(([-+]?\d[\d,.]*)\s*%\)/);
      const range = parseRange(columns.range >= 0 ? row[columns.range] : '');
      const item = {
        symbol: symbolMatch[1].toUpperCase() === 'MAI' ? 'mai' : 'SET',
        last: marketNumber(row[columns.last]),
        change: change ? marketNumber(change[1]) : marketNumber(changeText),
        changePercent: change ? marketNumber(change[2]) : null,
        open: columns.open >= 0 ? marketNumber(row[columns.open]) : null,
        low: range.low,
        high: range.high,
        volumeThousand: columns.volume >= 0 ? marketNumber(row[columns.volume]) : null,
        turnoverMillion: columns.turnover >= 0 ? marketNumber(row[columns.turnover]) : null
      };
      const valid = Number.isFinite(item.last)
        && isNonNegative(item.last) && isNonNegative(item.open)
        && isNonNegative(item.low) && isNonNegative(item.high)
        && isNonNegative(item.volumeThousand) && isNonNegative(item.turnoverMillion)
        && !(Number.isFinite(item.low) && Number.isFinite(item.high) && item.low > item.high);
      if (!valid) invalidIndexCandidates += 1;
      return valid ? item : null;
    }).filter(Boolean);
    if (parsed.length) {
      indices = parsed;
      break;
    }
  }
  const breadth = [];
  let maiUnlabeledNumericRows = false;
  let maiBreadthTableObserved = false;
  let breadthCandidates = 0;
  let invalidBreadthCandidates = 0;
  const invalidBreadthMarkets = new Set();
  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex];
    const rows = marketRowsFromTable(table);
    const prefix = marketHtmlText(String(html).slice(Math.max(0, tableMatches[tableIndex].index - 500), tableMatches[tableIndex].index));
    const inlineMarkets = [...new Set(rows.slice(0, 2).flat().filter(cell => /^(?:SET|mai)$/i.test(cell))
      .map(cell => cell.toLowerCase() === 'mai' ? 'mai' : 'SET'))];
    const hint = prefix.match(/(?:^|\s)(SET|mai)\s*$/i)?.[1] || (inlineMarkets.length === 1 ? inlineMarkets[0] : null);
    const numericHeader = findHeaderRow(rows, [/(?:หลักทรัพย์|จำนวน|securities)/i, /(?:ปริมาณ|volume)/i]);
    if (hint?.toLowerCase() === 'mai' && numericHeader.index >= 0) maiBreadthTableObserved = true;
    const header = findHeaderRow(rows, [/(?:สถานะ|status|Gainers)/i, /(?:หลักทรัพย์|จำนวน|securities)/i, /(?:ปริมาณ|volume)/i]);
    const countColumn = header.index >= 0 ? headerIndex(header.headers, [/(?:หลักทรัพย์|จำนวน|securities)/i]) : -1;
    const volumeColumn = header.index >= 0 ? headerIndex(header.headers, [/(?:ปริมาณ|volume)/i]) : -1;
    const items = rows.map(row => {
      const labelIndex = row.findIndex(cell => /^(?:Gainers|Unchanges|Losers)$/i.test(normalizedLabel(cell)));
      if (labelIndex < 0) return null;
      breadthCandidates += 1;
      const count = breadthNumber(countColumn >= 0 ? row[countColumn] : row[labelIndex + 1], true);
      const volume = breadthNumber(volumeColumn >= 0 ? row[volumeColumn] : row[labelIndex + 2]);
      if (count.invalid || volume.invalid) {
        invalidBreadthCandidates += 1;
        invalidBreadthMarkets.add(hint?.toLowerCase() === 'mai' ? 'mai' : 'SET');
      }
      return { label: normalizedLabel(row[labelIndex]), count: count.value, volumeThousand: volume.value };
    }).filter(Boolean);
    if (hint?.toLowerCase() === 'mai' && !items.length && numericHeader.index >= 0
      && rows.slice(numericHeader.index + 1).some(row => row.filter(cell => marketNumber(cell) !== null).length >= 2)) {
      // Data is present, but numeric row order is not evidence of its meaning.
      maiUnlabeledNumericRows = true;
    }
    if (items.length) {
      // The approved Overview URL requests SET. A second unlabelled table
      // cannot establish mai identity merely by its ordinal position.
      const market = hint ? (hint.toUpperCase() === 'MAI' ? 'mai' : 'SET') : 'SET';
      if (!hint && breadth.some(group => group.market === 'SET')) continue;
      breadth.push({
        market,
        items
      });
    }
  }
  const text = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const closeMatch = text.match(/(?:หลังตลาดปิด|ปิดตลาด(?:เช้า|บ่าย)?)(?:\s*:)?\s*([^]*?)(?=ดูเพิ่มเติม|ติดต่อเรา|$)/i);
  const closeSummary = closeMatch
    ? `${closeMatch[0]}`.replace(/^(?:หลังตลาดปิด|ปิดตลาด(?:เช้า|บ่าย)?)\s*:?\s*/i, '').split(/ดูเพิ่มเติม|ติดต่อเรา/)[0].trim().slice(0, 1200)
    : '';
  const pageEvidence = /(?:สรุปภาวะตลาด|ข้อมูลดัชนี|ดัชนีตลาด)/i.test(text);
  // Preserve every existing HTML group, including SET. Structured metadata
  // fills only an absent mai group, never overwrites or merges HTML rows.
  const hydratedMai = breadth.some(group => group.market === 'mai') ? null
    : parseHydratedMaiBreadth(html, { pageIdentity: pageEvidence && /\bSET\b/i.test(text) });
  if (hydratedMai?.group) breadth.push(hydratedMai.group);
  const result = { indices, breadth, closeSummary };
  const marketBreadth = market => breadth.filter(group => group.market === market);
  // Coverage must agree with aggregate breadth's usable-number criterion;
  // a market heading or all-missing labelled rows alone cannot be ACCEPT.
  const coverage = groups => groups.some(group => group.items.some(item => item.count !== null || item.volumeThousand !== null))
    ? PARSE_OUTCOME.ACCEPT : groups.length ? PARSE_OUTCOME.SOURCE_NO_DATA : null;
  const maiGroups = marketBreadth('mai');
  const expectsMai = indices.some(item => item.symbol === 'mai') || maiBreadthTableObserved
    || maiUnlabeledNumericRows || maiGroups.length > 0 || (hydratedMai && hydratedMai.outcome !== 'NOT_APPLICABLE');
  return annotateParse(result, {
    ...(hydratedMai && hydratedMai.outcome !== 'NOT_APPLICABLE' ? { breadthHydration: {
      origin: 'HYDRATION', market: 'mai', outcome: hydratedMai.outcome,
      reportedAsOf: hydratedMai.reportedAsOf, invalidFields: hydratedMai.invalidFields,
      missingFields: hydratedMai.missingFields
    } } : {}),
    breadthCoverage: {
      SET: invalidBreadthMarkets.has('SET') ? PARSE_OUTCOME.INVALID_DATA : coverage(marketBreadth('SET')) || PARSE_OUTCOME.SOURCE_NO_DATA,
      ...(expectsMai ? { mai: (invalidBreadthMarkets.has('mai') ? PARSE_OUTCOME.INVALID_DATA : null) || (hydratedMai && hydratedMai.outcome !== 'NOT_APPLICABLE' ? hydratedMai.outcome : null) || coverage(maiGroups)
        || (maiUnlabeledNumericRows ? PARSE_OUTCOME.PARSER_MISMATCH : 'NOT_VERIFIED') } : {})
    },
    indices: indices.some(item => item.symbol === 'SET' && Number.isFinite(item.last))
      ? PARSE_OUTCOME.ACCEPT
      : invalidIndexCandidates > 0 ? PARSE_OUTCOME.INVALID_DATA
        : pageEvidence || indexCandidates > 0 ? PARSE_OUTCOME.PARSER_MISMATCH : PARSE_OUTCOME.SOURCE_NO_DATA,
    breadth: breadth.some(group => group.items.some(item => item.count !== null || item.volumeThousand !== null))
      ? PARSE_OUTCOME.ACCEPT
      : invalidBreadthCandidates > 0 || hydratedMai?.outcome === 'INVALID_DATA' ? PARSE_OUTCOME.INVALID_DATA
        : breadth.length || explicitNoData(html) ? PARSE_OUTCOME.SOURCE_NO_DATA
          : pageEvidence || breadthCandidates > 0 ? PARSE_OUTCOME.PARSER_MISMATCH : PARSE_OUTCOME.SOURCE_NO_DATA,
    closeSummary: closeSummary ? PARSE_OUTCOME.ACCEPT : PARSE_OUTCOME.SOURCE_NO_DATA
  });
}

function parseSettradeForeign(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  let row;
  let columns;
  let candidateFound = false;
  for (const table of tables) {
    const rows = marketRowsFromTable(table);
    const header = findHeaderRow(rows, [/(?:ประเภท)?นักลงทุน/i, /(?:มูลค่า)?ซื้อ/i, /(?:มูลค่า)?ขาย/i, /สุทธิ/i]);
    if (header.index < 0) continue;
    const foreignRow = rows.slice(header.index + 1).find(items => items.some(cell => /นักลงทุนต่างประเทศ|นักลงทุนต่างชาติ/i.test(cell)));
    if (!foreignRow) continue;
    candidateFound = true;
    row = foreignRow;
    columns = {
      name: headerIndex(header.headers, [/(?:ประเภท)?นักลงทุน/i]),
      buy: headerIndex(header.headers, [/^(?:มูลค่า)?ซื้อ$/i]),
      sell: headerIndex(header.headers, [/^(?:มูลค่า)?ขาย$/i]),
      net: headerIndex(header.headers, [/^สุทธิ$/i])
    };
    break;
  }
  const page = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const date = page.match(/ข้อมูล ณ วันที่\s*(\d{1,2}\s+[^\s]+\s+\d{4}|[\d/.-]{8,10})/)?.[1]?.trim() || '';
  const result = row ? {
    date,
    name: row[columns.name] || 'นักลงทุนต่างประเทศ',
    buyMillion: marketNumber(row[columns.buy]),
    sellMillion: marketNumber(row[columns.sell]),
    netMillion: marketNumber(row[columns.net])
  } : { date, name: 'นักลงทุนต่างประเทศ', buyMillion: null, sellMillion: null, netMillion: null };
  const values = [result.buyMillion, result.sellMillion, result.netMillion];
  const valid = values.some(Number.isFinite)
    && isNonNegative(result.buyMillion) && isNonNegative(result.sellMillion);
  return annotateParse(result, {
    result: valid ? PARSE_OUTCOME.ACCEPT
      : candidateFound && values.some(value => value !== null) ? PARSE_OUTCOME.INVALID_DATA
        : explicitNoData(html) ? PARSE_OUTCOME.SOURCE_NO_DATA
          : /กลุ่มนักลงทุน|นักลงทุนต่างประเทศ|นักลงทุนต่างชาติ/i.test(page) ? PARSE_OUTCOME.PARSER_MISMATCH : PARSE_OUTCOME.SOURCE_NO_DATA
  });
}

function parseSettradeNvdr(html) {
  const text = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const market = text.match(/มูลค่า(?:การ)?ซื้อขาย(?:รวม|ของ)?\s*(?:ของ\s*)?SET\s*(?:และ|&|\+)\s*mai\s*(?:\(ล้านบาท\))?\s*[:：-]?\s*([-+]?\d[\d,.]*)/i);
  const nvdr = text.match(/มูลค่า(?:การ)?ซื้อขาย(?:รวม|ของ)?\s*(?:ของ\s*)?NVDR\s*(?:\(ล้านบาท\))?\s*[:：-]?\s*([-+]?\d[\d,.]*)/i);
  const ratio = text.match(/สัดส่วน(?:ของ)?\s*NVDR\s*(?:เทียบกับ|ต่อ)\s*(?:(?:มูลค่า(?:การ)?ซื้อขาย(?:ของ)?|มูลค่า)\s*)?SET\s*(?:และ|&|\+)\s*mai\s*(?:\(%\)|%)?\s*[:：-]?\s*([-+]?\d[\d,.]*)/i);
  const result = {
    marketMillion: marketNumber(market?.[1]),
    nvdrMillion: marketNumber(nvdr?.[1]),
    ratioPercent: marketNumber(ratio?.[1])
  };
  const valid = isNonNegative(result.marketMillion) && isNonNegative(result.nvdrMillion)
    && (result.ratioPercent === null || (result.ratioPercent >= 0 && result.ratioPercent <= 100));
  const available = Object.values(result).some(Number.isFinite);
  return annotateParse(result, {
    result: available && valid ? PARSE_OUTCOME.ACCEPT
      : available ? PARSE_OUTCOME.INVALID_DATA
        : explicitNoData(html) ? PARSE_OUTCOME.SOURCE_NO_DATA
          : /NVDR/i.test(text) && /มูลค่า(?:การ)?ซื้อขาย|สัดส่วน/i.test(text) ? PARSE_OUTCOME.PARSER_MISMATCH : PARSE_OUTCOME.SOURCE_NO_DATA
  });
}

function parseRange(value = '') {
  const numbers = String(value).match(/[-+]?\d[\d,.]*/g) || [];
  return {
    low: numbers.length > 0 ? marketNumber(numbers[0]) : null,
    high: numbers.length > 1 ? marketNumber(numbers[1]) : null
  };
}

function parseSettradeActiveValue(html) {
  const tables = [...String(html || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  let tableRows = [];
  let header = { index: -1, headers: [] };
  for (const table of tables) {
    const rows = marketRowsFromTable(table);
    const candidate = findHeaderRow(rows, [/(?:ชื่อย่อหลักทรัพย์|หลักทรัพย์|symbol)/i, /(?:มูลค่า.*(?:ล้านบาท)|turnover|value)/i, /(?:ปริมาณ.*(?:000|พันหุ้น)|volume)/i]);
    if (candidate.index >= 0) {
      tableRows = rows;
      header = candidate;
      break;
    }
  }
  const headers = header.headers;
  const columns = {
    rank: headerIndex(headers, [/^(?:อันดับ|ลำดับ|rank)$/i]),
    symbol: headerIndex(headers, [/^(?:ชื่อย่อหลักทรัพย์|หลักทรัพย์|symbol)$/i]),
    turnover: headerIndex(headers, [/^มูลค่า(?:\s*AOM|การซื้อขาย)?.*ล้านบาท/i, /^(?:turnover|value)/i]),
    volume: headerIndex(headers, [/^ปริมาณ(?:\s*AOM|การซื้อขาย)?.*(?:000|พันหุ้น)/i, /^volume/i]),
    last: headerIndex(headers, [/^(?:ราคาล่าสุด|ล่าสุด|last(?: price)?)$/i]),
    change: headerIndex(headers, [/^เปลี่ยนแปลง$/i, /^change$/i]),
    changePercent: headerIndex(headers, [/^เปลี่ยนแปลง\s*\(%\)$/i, /^change\s*%$/i]),
    range: headerIndex(headers, [/^Intraday.*Low.*High/i, /^ระหว่างวัน.*(?:ต่ำสุด|Low).*(?:สูงสุด|High)/i])
  };
  const invalidTurnoverUnit = columns.turnover >= 0 && /พันล้านบาท/i.test(headers[columns.turnover]);
  const labelledTurnover = columns.turnover >= 0 && /\(\s*(?:ล้านบาท|million\s*(?:baht|THB))\s*\)/i.test(headers[columns.turnover]) && !invalidTurnoverUnit;
  const labelledVolume = columns.volume >= 0 && /\(\s*['’]?000(?:\s*(?:หุ้น|shares))?\s*\)|พันหุ้น|thousand\s*shares/i.test(headers[columns.volume]);
  if (invalidTurnoverUnit) columns.turnover = -1;
  const hasCoreSchema = ['rank', 'symbol', 'turnover', 'volume'].every(name => columns[name] >= 0);
  const rows = hasCoreSchema ? tableRows.slice(header.index + 1).filter(row => row.some(Boolean)) : [];
  let invalidRows = 0;
  const items = rows.map(row => {
    const rank = row[columns.rank];
    const symbol = row[columns.symbol];
    if (!/^\d+$/.test(rank || '') || !/^[A-Z0-9&.-]{1,20}$/i.test(symbol || '')) {
      invalidRows += 1;
      return null;
    }
    const range = parseRange(columns.range >= 0 ? row[columns.range] : '');
    const rawValue = marketNumber(row[columns.turnover]), rawVolume = marketNumber(row[columns.volume]);
    const item = {
      rank: Number(rank),
      symbol: symbol.toUpperCase(),
      turnoverMillion: labelledTurnover ? rawValue : null,
      volumeThousand: labelledVolume ? rawVolume : null,
      ...(!labelledTurnover || !labelledVolume ? { sourceQuantities: { origin: 'HTML_TABLE',
        value: { sourceField: headers[columns.turnover], raw: rawValue, unit: labelledTurnover ? 'million_baht' : null },
        volume: { sourceField: headers[columns.volume], raw: rawVolume, unit: labelledVolume ? 'thousand_shares' : null } } } : {}),
      last: columns.last >= 0 ? marketNumber(row[columns.last]) : null,
      change: columns.change >= 0 ? marketNumber(row[columns.change]) : null,
      changePercent: columns.changePercent >= 0 ? marketNumber(row[columns.changePercent]) : null,
      low: range.low,
      high: range.high
    };
    if (!Number.isInteger(item.rank) || item.rank < 1 || item.rank > 100
      || rawValue === null || rawValue < 0
      || rawVolume === null || rawVolume < 0
      || !isNonNegative(item.last)
      || (item.low !== null && item.high !== null && item.low > item.high)) {
      invalidRows += 1;
      return null;
    }
    return item;
  }).filter(Boolean);
  const text = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const asOf = text.match(/ข้อมูลล่าสุด\s*([^|]+?\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/)?.[1]?.trim() || '';
  const result = { items, asOf };
  return annotateParse(result, {
    invalidRows,
    result: items.length ? PARSE_OUTCOME.ACCEPT
      : invalidRows > 0 || invalidTurnoverUnit ? PARSE_OUTCOME.INVALID_DATA
        : hasCoreSchema && rows.length === 0 ? PARSE_OUTCOME.SOURCE_NO_DATA
          : explicitNoData(html) ? PARSE_OUTCOME.SOURCE_NO_DATA
            : /Most Active|มูลค่าการซื้อขายสูงสุด/i.test(text) ? PARSE_OUTCOME.PARSER_MISMATCH : PARSE_OUTCOME.SOURCE_NO_DATA
  });
}

function parseSettradeTfex(html) {
  const page = marketHtmlText(html.slice(0, html.indexOf('window.__NUXT__') > 0 ? html.indexOf('window.__NUXT__') : undefined));
  const totals = page.match(/Total Market\s*([-+\d,.]+|-)\s*([-+\d,.]+|-)/i);
  const rawVolume = totals && totals[1] !== '-' ? marketNumber(totals[1]) : null;
  const rawInterest = totals && totals[2] !== '-' ? marketNumber(totals[2]) : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const totalVolume = count(rawVolume), openInterest = count(rawInterest);
  const invalidFields = [rawVolume !== null && totalVolume === null ? 'totalVolume' : null,
    rawInterest !== null && openInterest === null ? 'openInterest' : null].filter(Boolean);
  const delayMinutes = marketNumber(page.match(/ข้อมูลล่าช้า\s*(\d+)\s*นาที/)?.[1]) || 15;
  const marketDate = page.match(/ข้อมูล ณ วันที่\s*([^|]+?\d{4})/)?.[1]?.trim() || '';

  const tables = [...String(html || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  let investorRows = [];
  let investorHeader = { index: -1, headers: [] };
  for (const table of tables) {
    const rows = marketRowsFromTable(table);
    const candidate = findHeaderRow(rows, [/(?:ประเภท)?นักลงทุน/i, /^ซื้อ$/i, /^ขาย$/i, /^สุทธิ$/i]);
    if (candidate.index >= 0) {
      investorRows = rows;
      investorHeader = candidate;
      break;
    }
  }
  const investorHeaders = investorHeader.headers;
  const investorColumns = {
    name: headerIndex(investorHeaders, [/^(?:ประเภท)?นักลงทุน$/i]),
    buy: headerIndex(investorHeaders, [/^ซื้อ$/i]),
    sell: headerIndex(investorHeaders, [/^ขาย$/i]),
    net: headerIndex(investorHeaders, [/^สุทธิ$/i])
  };
  const investorSchema = Object.values(investorColumns).every(index => index >= 0);
  let invalidRows = 0;
  const investorType = (investorSchema ? investorRows.slice(investorHeader.index + 1) : []).map(row => {
    const name = row[investorColumns.name];
    if (/ไม่มีข้อมูล/i.test(name || '')) return null;
    const item = {
      name,
      buy: marketNumber(row[investorColumns.buy]),
      sell: marketNumber(row[investorColumns.sell]),
      net: marketNumber(row[investorColumns.net])
    };
    if (item.buy === null && item.sell === null && item.net === null) return null;
    if (!isNonNegative(item.buy) || !isNonNegative(item.sell)) {
      invalidRows += 1;
      return null;
    }
    return item;
  }).filter(Boolean);

  let topRows = [];
  let topHeader = { index: -1, headers: [] };
  for (const table of tables) {
    const rows = marketRowsFromTable(table);
    const candidate = findHeaderRow(rows, [/(?:ชื่อย่อสัญญา|สัญญา|symbol)/i, /(?:ปริมาณ.*สัญญา|volume)/i]);
    if (candidate.index >= 0) {
      topRows = rows;
      topHeader = candidate;
      break;
    }
  }
  const topHeaders = topHeader.headers;
  const topColumns = {
    symbol: headerIndex(topHeaders, [/^(?:ชื่อย่อสัญญา|สัญญา|symbol)$/i]),
    volume: headerIndex(topHeaders, [/^ปริมาณ.*สัญญา.*$/i, /^volume$/i]),
    last: headerIndex(topHeaders, [/^(?:ราคาล่าสุด|ล่าสุด|last(?: price)?)$/i]),
    change: headerIndex(topHeaders, [/^เปลี่ยนแปลง$/i, /^change$/i]),
    changePercent: headerIndex(topHeaders, [/^เปลี่ยนแปลง\s*\(%\)$/i, /^change\s*%$/i])
  };
  const topSchema = topColumns.symbol >= 0 && topColumns.volume >= 0;
  const topVolume = (topSchema ? topRows.slice(topHeader.index + 1) : []).map(row => {
    const symbol = row[topColumns.symbol];
    if (!/^[A-Z0-9&.-]{1,30}$/i.test(symbol || '') || /ไม่มีข้อมูล/i.test(symbol)) return null;
    const item = {
      symbol: symbol.toUpperCase(),
      volume: marketNumber(row[topColumns.volume]),
      last: topColumns.last >= 0 ? marketNumber(row[topColumns.last]) : null,
      change: topColumns.change >= 0 ? marketNumber(row[topColumns.change]) : null,
      changePercent: topColumns.changePercent >= 0 ? marketNumber(row[topColumns.changePercent]) : null
    };
    if (item.volume === null || item.volume < 0 || !isNonNegative(item.last)) {
      invalidRows += 1;
      return null;
    }
    return item;
  }).filter(Boolean);

  const result = {
    available: totalVolume !== null || openInterest !== null || investorType.length > 0 || topVolume.length > 0,
    delayMinutes,
    totalVolume,
    openInterest,
    marketDate,
    investorType,
    topVolume
  };
  const structuredSkeleton = /Total Market/i.test(page) || investorHeader.index >= 0 || topHeader.index >= 0;
  return annotateParse(result, {
    invalidFields,
    result: result.available ? PARSE_OUTCOME.ACCEPT
      : invalidRows > 0 || invalidFields.length > 0 ? PARSE_OUTCOME.INVALID_DATA
        : explicitNoData(html) || structuredSkeleton ? PARSE_OUTCOME.SOURCE_NO_DATA
          : /TFEX|อนุพันธ์|Derivatives/i.test(page) ? PARSE_OUTCOME.PARSER_MISMATCH : PARSE_OUTCOME.SOURCE_NO_DATA
  });
}

module.exports = {
  PARSE_OUTCOME,
  classifySettradeParse,
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
