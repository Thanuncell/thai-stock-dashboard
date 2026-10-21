'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSettradeActiveValue,
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr,
  parseSettradeTfex
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

test('semantic headers survive column reordering and deterministic invalidity blocks only bad ranking rows', () => {
  const reordered = `
    <p>Most Active Value</p><p>ข้อมูลล่าสุด 20 ต.ค. 2569 22:19:18</p>
    <table><tr><th>ชื่อย่อหลักทรัพย์</th><th>อันดับ</th><th>ราคาล่าสุด</th><th>มูลค่า AOM (ล้านบาท)</th><th>ปริมาณ AOM ('000 หุ้น)</th><th>เปลี่ยนแปลง (%)</th><th>เปลี่ยนแปลง</th><th>Intraday (Low/High)</th></tr>
    <tr><td>PTT</td><td>1</td><td>33.75</td><td>3,210.75</td><td>95,133.33</td><td>0.75</td><td>0.25</td><td>33.25 / 34.00</td></tr>
    <tr><td>BAD</td><td>2</td><td>-10</td><td>100</td><td>100</td><td>-1</td><td>-1</td><td>12 / 10</td></tr></table>`;
  const result = parseSettradeActiveValue(reordered);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].symbol, 'PTT');
  assert.equal(result.items[0].turnoverMillion, 3210.75);

  const wrongUnit = reordered.replace('มูลค่า AOM (ล้านบาท)', 'มูลค่า AOM (พันล้านบาท)');
  assert.deepEqual(parseSettradeActiveValue(wrongUnit).items, []);
});

test('TFEX missing subfields remain null or empty while independently valid totals stay usable', () => {
  const result = parseSettradeTfex('<h1>อนุพันธ์ TFEX</h1><div>ข้อมูลล่าช้า 15 นาที ปริมาณ (สัญญา) สถานะคงค้าง (สัญญา) Total Market 12,345 -</div>');
  assert.equal(result.available, true);
  assert.equal(result.totalVolume, 12345);
  assert.equal(result.openInterest, null);
  assert.deepEqual(result.investorType, []);
  assert.deepEqual(result.topVolume, []);
});
