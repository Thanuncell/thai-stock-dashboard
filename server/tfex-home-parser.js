'use strict';

const { marketHtmlText, decodeXml } = require('../lib/settrade-parser');
const { sourceMarketTime } = require('./market-overview-session');
const TFEX_HOME_URL = 'https://www.tfex.co.th/th/home';

function divTree(html) {
  const nodes = [], stack = [];
  const tokens = /<\/?div\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  for (const match of html.matchAll(tokens)) {
    if (/^<\//.test(match[0])) {
      const node = stack.pop();
      if (node) { node.innerEnd = match.index; node.end = match.index + match[0].length; }
    } else {
      if (nodes.length >= 5000 || stack.length >= 80) return null;
      const node = { start: match.index, innerStart: match.index + match[0].length, innerEnd: null, end: null,
        classes: (match[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/\s+/), children: [] };
      if (stack.length) stack.at(-1).children.push(node);
      nodes.push(node);
      if (/\/\s*>$/.test(match[0])) { node.innerEnd = node.innerStart; node.end = node.innerStart; }
      else stack.push(node);
    }
  }
  return nodes;
}

function parseTfexHome(html) {
  const value = { available: false, delayMinutes: 15, totalVolume: null, openInterest: null,
    marketDate: '', investorType: [], topVolume: [] };
  const diagnostics = { result: 'PARSER_MISMATCH', source: 'TFEX', sourceUrl: TFEX_HOME_URL,
    units: null, reportedAsOf: null, sourceTimeLabel: null, tradingSessionDate: null,
    volumeEffectiveTime: null, openInterestEffectiveTime: null, openInterestReference: null,
    components: {}, consistency: {}, invalidFields: [], missingFields: [] };
  const finish = result => {
    diagnostics.result = result;
    Object.defineProperty(value, '__diagnostics', { value: diagnostics, enumerable: false });
    return value;
  };
  if (typeof html !== 'string' || html.length > 1_000_000) return finish('PARSER_MISMATCH');
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const title = marketHtmlText(markup.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  if (!/TFEX|Thailand Futures Exchange/i.test(title)) return finish('PARSER_MISMATCH');
  if (/captcha|challenge|access denied|login|sign in/i.test(title)
    || /cf-chl-|verify (?:that )?you are human/i.test(markup)) return finish('PARSER_MISMATCH');
  const nodes = divTree(markup);
  if (!nodes) return finish('PARSER_MISMATCH');
  const cards = nodes.filter(node => node.end !== null && node.classes.includes('accordion-derivative-summary'));
  if (cards.length !== 1) return finish('PARSER_MISMATCH');
  const card = cards[0];
  const inside = nodes.filter(node => node.end !== null && node.start >= card.start && node.end <= card.end);
  const headers = inside.filter(node => node.classes.includes('accordion-derivative-summary-header'));
  const footers = inside.filter(node => node.classes.includes('accordion-derivative-summary-footer'));
  if (headers.length !== 1 || footers.length !== 1) return finish('PARSER_MISMATCH');
  const text = node => marketHtmlText(markup.slice(node.innerStart, node.innerEnd));
  const header = headers[0], footer = footers[0];
  const labels = header.children.map(text);
  const volumeColumn = labels.findIndex(label => /^(?:ปริมาณ|Volume)\s*\((?:สัญญา|contracts)\)$/i.test(label));
  const oiPattern = /^(?:สถานะคงค้าง|Open Interest)(?:\s*\((?:สัญญา|contracts)\))?$/i;
  const oiColumn = labels.findIndex(label => oiPattern.test(label));
  if (labels.length !== 3 || volumeColumn < 0 || oiColumn < 0 || volumeColumn === oiColumn
    || labels.filter(label => oiPattern.test(label)).length !== 1
    || footer.children.length !== labels.length || text(footer.children[0]) !== 'Total Market') return finish('PARSER_MISMATCH');
  diagnostics.units = 'contracts';
  const prefix = marketHtmlText(markup.slice(Math.max(0, card.start - 700), card.start));
  const delay = prefix.match(/ข้อมูลล่าช้า\s*(\d+)\s*นาที/);
  const stamp = prefix.match(/ข้อมูลล่าสุด\s*(\d{1,2}\s+[^\s]+\s+\d{4}\s+\d{2}:\d{2}:\d{2})/);
  if (!delay || Number(delay[1]) !== 15 || !stamp) return finish('PARSER_MISMATCH');
  diagnostics.sourceTimeLabel = stamp[1];
  diagnostics.reportedAsOf = sourceMarketTime(stamp[1]);
  if (!diagnostics.reportedAsOf) { diagnostics.invalidFields.push('reportedAsOf'); return finish('INVALID_DATA'); }
  const headerMarkup = markup.slice(header.innerStart, header.innerEnd);
  const tooltipText = [...headerMarkup.matchAll(/\btitle\s*=\s*(["'])([\s\S]*?)\1/gi)]
    .map(match => decodeXml(match[2])).join(' ');
  if (/Day Session:\s*OI as of the Night Session of previous day/i.test(tooltipText)
    && /Night Session:\s*OI as of the Afternoon Session of current day/i.test(tooltipText)) {
    diagnostics.openInterestReference = { daySession: 'PREVIOUS_NIGHT_SESSION', nightSession: 'CURRENT_AFTERNOON_SESSION' };
  }
  if (!diagnostics.openInterestReference) diagnostics.missingFields.push('openInterestReference');
  function count(raw, field) {
    if (!raw || /^[-–—]$/.test(raw)) { diagnostics.missingFields.push(field); return null; }
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) { diagnostics.invalidFields.push(field); return null; }
    const number = Number(raw.replace(/,/g, ''));
    if (!Number.isSafeInteger(number) || number < 0) { diagnostics.invalidFields.push(field); return null; }
    return number;
  }
  function rowValues(node, prefixName) {
    return { totalVolume: count(text(node.children[volumeColumn]), prefixName + '.totalVolume'),
      openInterest: count(text(node.children[oiColumn]), prefixName + '.openInterest') };
  }
  Object.assign(value, rowValues(footer, 'totalMarket'));
  for (const [label, key] of [['Total Futures', 'futures'], ['Total Options', 'options']]) {
    const rows = inside.filter(node => node.children.length === labels.length && text(node.children[0]) === label);
    if (rows.length === 1) diagnostics.components[key] = rowValues(rows[0], key);
  }
  for (const field of ['totalVolume', 'openInterest']) {
    const first = diagnostics.components.futures?.[field], second = diagnostics.components.options?.[field];
    diagnostics.consistency[field] = value[field] !== null && Number.isFinite(first) && Number.isFinite(second)
      ? Number.isSafeInteger(first + second) && value[field] === first + second : null;
    if (diagnostics.consistency[field] === false) {
      diagnostics.invalidFields.push('totalMarket.' + field + '.componentMismatch');
      value[field] = null;
    }
  }
  value.available = value.totalVolume !== null || value.openInterest !== null;
  return finish(value.available ? 'ACCEPT' : diagnostics.invalidFields.length ? 'INVALID_DATA' : 'SOURCE_NO_DATA');
}

module.exports = { TFEX_HOME_URL, parseTfexHome };
