'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr
} = require('../lib/settrade-parser');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('SETTRADE overview fixture preserves index, breadth and closing summary shape', () => {
  const result = parseSettradeMarket(fixture('settrade-overview.html'));
  assert.deepEqual(result.indices[0], {
    symbol: 'SET', last: 1234.56, change: 1.23, changePercent: 0.1,
    open: 1230, low: 1225, high: 1240, volumeThousand: 12345, turnoverMillion: 67890.12
  });
  assert.equal(result.indices[1].symbol, 'mai');
  assert.equal(result.indices[1].changePercent, -0.67);
  assert.equal(result.breadth[0].market, 'SET');
  assert.equal(result.breadth[0].items[2].count, 150);
  assert.match(result.closeSummary, /นักลงทุนต่างชาติซื้อสุทธิ/);
});

test('SETTRADE foreign and NVDR fixtures preserve null-safe numeric fields', () => {
  assert.deepEqual(parseSettradeForeign(fixture('settrade-foreign.html')), {
    date: '16 ตุลาคม 2569',
    name: 'นักลงทุนต่างประเทศ',
    buyMillion: 20100.25,
    sellMillion: 18000,
    netMillion: 2100.25
  });
  assert.deepEqual(parseSettradeNvdr(fixture('settrade-nvdr.html')), {
    marketMillion: 75000.5,
    nvdrMillion: 12345.67,
    ratioPercent: 16.46
  });
});

test('malformed or partial provider HTML degrades to missing data, never zero', () => {
  assert.deepEqual(parseSettradeMarket('<html>changed upstream markup</html>'), {
    indices: [], breadth: [], closeSummary: ''
  });
  assert.deepEqual(parseSettradeForeign('<html></html>'), {
    date: '', name: 'นักลงทุนต่างประเทศ', buyMillion: null, sellMillion: null, netMillion: null
  });
  assert.deepEqual(parseSettradeNvdr('<html></html>'), {
    marketMillion: null, nvdrMillion: null, ratioPercent: null
  });
});
