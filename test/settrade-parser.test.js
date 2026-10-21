'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySettradeParse,
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
  const rejected = parseSettradeActiveValue(wrongUnit);
  assert.deepEqual(rejected.items, []);
  assert.equal(classifySettradeParse('activeValue', rejected), 'INVALID_DATA');
});

test('TFEX missing subfields remain null or empty while independently valid totals stay usable', () => {
  const result = parseSettradeTfex('<h1>อนุพันธ์ TFEX</h1><div>ข้อมูลล่าช้า 15 นาที ปริมาณ (สัญญา) สถานะคงค้าง (สัญญา) Total Market 12,345 -</div>');
  assert.equal(result.available, true);
  assert.equal(result.totalVolume, 12345);
  assert.equal(result.openInterest, null);
  assert.deepEqual(result.investorType, []);
  assert.deepEqual(result.topVolume, []);
});

test('semantic index links and headings survive harmless SETTRADE markup variation', () => {
  const html = `
    <h1>สรุปภาวะตลาด</h1>
    <table>
      <tr><th>ดัชนีตลาด</th><th>ค่าล่าสุด</th><th>เปลี่ยนแปลง</th><th>ราคาเปิด</th><th>Intraday (Low/High)</th><th>ปริมาณ ('000 หุ้น)</th><th>มูลค่า (ล้านบาท)</th></tr>
      <tr><td><a href="/th/market/index/SET">SET</a></td><td>1,546.45</td><td>-8.49 (-0.55%)</td><td>1,560.85</td><td>1,532.71 / 1,563.04</td><td>7,531,884</td><td>39,558.23</td></tr>
      <tr><td><a data-index="mai" href="/th/market/index/mai">mai</a></td><td>219.68</td><td>+0.70 (+0.32%)</td><td>219.25</td><td>218.73 / 219.95</td><td>201,269</td><td>420.71</td></tr>
    </table>`;
  const result = parseSettradeMarket(html);
  assert.deepEqual(result.indices.map(item => item.symbol), ['SET', 'mai']);
  assert.equal(result.indices[0].last, 1546.45);
  assert.equal(result.indices[1].turnoverMillion, 420.71);
});

test('breadth preserves semantic columns when provider rows contain empty spacer cells', () => {
  const html = `
    <h1>สรุปภาวะตลาด</h1>
    <section><h2>SET</h2><table>
      <tr><th>สถานะ</th><th></th><th>หลักทรัพย์</th><th></th><th>ปริมาณ ('000 หุ้น)</th></tr>
      <tr><td>Gainers</td><td></td><td></td><td></td><td>969,646.80</td></tr>
      <tr><td>Unchanges</td><td></td><td>206</td><td></td><td>475,084.40</td></tr>
      <tr><td>Losers</td><td></td><td>217</td><td></td><td>1,235,592.60</td></tr>
    </table></section>`;
  const result = parseSettradeMarket(html);
  assert.equal(result.breadth[0].items[0].count, null);
  assert.equal(result.breadth[0].items[0].volumeThousand, 969646.8);
});

test('NVDR semantic label variations parse without weakening numeric validation', () => {
  const result = parseSettradeNvdr(`
    <h1>ภาพรวมมูลค่าการซื้อขาย NVDR</h1>
    <p>มูลค่าซื้อขายรวม SET และ mai (ล้านบาท): 60,980.99</p>
    <p>มูลค่าซื้อขาย NVDR (ล้านบาท): 34,209.86</p>
    <p>สัดส่วน NVDR ต่อมูลค่า SET และ mai (%): 28</p>`);
  assert.deepEqual(result, { marketMillion: 60980.99, nvdrMillion: 34209.86, ratioPercent: 28 });
});

test('Investor Flow uses semantic headers and does not shift columns across empty cells', () => {
  const result = parseSettradeForeign(`
    <h1>มูลค่าการซื้อขายตามกลุ่มนักลงทุน</h1><p>ข้อมูล ณ วันที่ 20 ต.ค. 2569</p>
    <table><tr><th>นักลงทุน</th><th>มูลค่าซื้อ</th><th>%</th><th></th><th>มูลค่าขาย</th><th>%</th><th>สุทธิ</th></tr>
      <tr><td>นักลงทุนต่างประเทศ</td><td>35,325.59</td><td>58.18</td><td></td><td></td><td></td><td>139.39</td></tr></table>`);
  assert.equal(result.buyMillion, 35325.59);
  assert.equal(result.sellMillion, null);
  assert.equal(result.netMillion, 139.39);
});

test('Most Active accepts safe semantic header variants but distinguishes empty source rows', () => {
  const valid = parseSettradeActiveValue(`
    <h1>Most Active Value</h1><table><tr><th>ลำดับ</th><th>Symbol</th><th>มูลค่าการซื้อขาย (ล้านบาท)</th><th>ปริมาณการซื้อขาย ('000 หุ้น)</th><th>ล่าสุด</th></tr>
      <tr><td>1</td><td>PTT</td><td>3,210.75</td><td>95,133.33</td><td>33.75</td></tr></table>`);
  assert.equal(valid.items.length, 1);
  assert.equal(valid.items[0].last, 33.75);
  assert.equal(classifySettradeParse('activeValue', valid), 'ACCEPT');

  const empty = parseSettradeActiveValue('<h1>Most Active Value</h1><p>ไม่มีข้อมูล</p><table><tr><th>อันดับ</th><th>ชื่อย่อหลักทรัพย์</th><th>มูลค่า AOM (ล้านบาท)</th><th>ปริมาณ AOM (\'000 หุ้น)</th></tr></table>');
  assert.deepEqual(empty.items, []);
  assert.equal(classifySettradeParse('activeValue', empty), 'SOURCE_NO_DATA');
});

test('TFEX publishes independently valid partial totals and classifies true no-data safely', () => {
  const partial = parseSettradeTfex('<h1>ภาพรวมตลาด TFEX</h1><div>Total Market</div><div>-</div><div>3,104,220</div>');
  assert.equal(partial.available, true);
  assert.equal(partial.totalVolume, null);
  assert.equal(partial.openInterest, 3104220);
  assert.equal(classifySettradeParse('tfex', partial), 'ACCEPT');

  const empty = parseSettradeTfex('<h1>ภาพรวมตลาด TFEX</h1><p>ไม่มีข้อมูล</p><div>Total Market - -</div>');
  assert.equal(empty.available, false);
  assert.equal(classifySettradeParse('tfex', empty), 'SOURCE_NO_DATA');
});
