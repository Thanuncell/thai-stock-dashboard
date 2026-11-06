'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let domain;
test.before(async () => { domain = await import('../client/domain.mjs'); });

test('AOM contract UI: raw quantities carry no claimed unit or inferred normalization',()=>{
 const row={turnoverMillion:null,volumeThousand:null,sourceQuantities:{origin:'SETTRADE_AOM',value:{sourceField:'aomValue',raw:0.001,unit:null},volume:{sourceField:'aomVolume',raw:1000,unit:null}}};
 const display=domain.activeAmountDisplay(row,{quantityStatus:'UNVERIFIED'});
 assert.deepEqual(display,{mode:'RAW',value:0.001,label:'ค่าดิบ · ยังไม่ยืนยันหน่วย'});
 assert.equal(domain.activeAmountDisplay({...row,sourceQuantities:{...row.sourceQuantities,value:{...row.sourceQuantities.value,raw:0}}},{quantityStatus:'UNVERIFIED'}).value,0);
});

test('AOM contract UI: absent provenance cannot make legacy normalized numbers authoritative',()=>{
 assert.equal(domain.activeAmountDisplay({turnoverMillion:4864.4934,volumeThousand:24004.2},{}).mode,'UNAVAILABLE');
 assert.deepEqual(domain.activeAmountDisplay({turnoverMillion:4521.3,volumeThousand:25100.5},{quantityStatus:'HTML_LABELLED'}),{mode:'MILLION_BAHT',value:4521.3,label:'ล้านบาท'});
});

test('AOM evidence-supported UI uses normalized millions once and retains the separate raw baht/share values',()=>{
 const row={turnoverMillion:4864.4934,volumeThousand:24004.2,sourceQuantities:{origin:'SETTRADE_AOM',basis:'SET_AOM_BAHT_SHARES',verification:'EVIDENCE_SUPPORTED',value:{sourceField:'aomValue',raw:4864493400,unit:'baht'},volume:{sourceField:'aomVolume',raw:24004200,unit:'shares'}}};
 assert.deepEqual(domain.activeAmountDisplay(row,{quantityStatus:'EVIDENCE_SUPPORTED'}),{mode:'MILLION_BAHT',value:4864.4934,label:'ล้านบาท'});
 assert.equal(domain.activeAmountDisplay({...row,turnoverMillion:row.turnoverMillion/1000000},{quantityStatus:'EVIDENCE_SUPPORTED'}).mode,'INVALID');
 assert.equal(row.sourceQuantities.value.raw,4864493400);assert.equal(row.sourceQuantities.volume.raw,24004200);
 const context=domain.activeOverviewContext({activeValue:[row],fieldStatus:{activeValue:{state:'PASS',sourceUpdatedAt:'2026-11-02T16:51:48+07:00',fetchedAt:'2026-11-02T09:52:07Z',quantityStatus:'EVIDENCE_SUPPORTED'}}});
 assert.doesNotMatch(context.caption,/หน่วยมูลค่า\/ปริมาณยังไม่ยืนยัน/);assert.match(context.caption,/Trading Session ยังไม่ยืนยัน/);
});

test('AOM contract UI: forged normalized AOM fields or fabricated units never render as labelled money',()=>{
 const sourceQuantities={origin:'SETTRADE_AOM',value:{sourceField:'aomValue',raw:1000000,unit:null},volume:{sourceField:'aomVolume',raw:1000,unit:null}};
 assert.equal(domain.activeAmountDisplay({turnoverMillion:1,volumeThousand:null,sourceQuantities},{quantityStatus:'HTML_LABELLED'}).mode,'INVALID');
 assert.equal(domain.activeAmountDisplay({turnoverMillion:null,volumeThousand:null,sourceQuantities:{...sourceQuantities,value:{...sourceQuantities.value,unit:'million_baht'}}},{quantityStatus:'HTML_LABELLED'}).mode,'INVALID');
});

test('AOM contract UI: source update and fetch time are shown without inventing a completed trading session',()=>{
 const c=domain.activeOverviewContext({activeValue:[{}],fieldStatus:{activeValue:{state:'PASS',sourceUpdatedAt:'2026-11-02T16:51:48+07:00',reportedAsOf:'2026-11-02T16:51:48+07:00',fetchedAt:'2026-11-02T09:52:07Z',sessionContext:'SESSION_SNAPSHOT',quantityStatus:'UNVERIFIED',tradingSessionDate:null}}});
 assert.match(c.caption,/ต้นทางรายงาน.*รับข้อมูลเมื่อ.*Trading Session ยังไม่ยืนยัน/s);
 assert.doesNotMatch(c.caption,/อ้างอิงรอบที่สิ้นสุดแล้ว|ข้อมูลล่าสุด/);
});

test('TFEX context separates source clock, receipt and unknown effective times', () => {
 const status={source:'TFEX',state:'LKG',sourceUpdatedAt:'2026-11-02T15:01:31+07:00',fetchedAt:'2026-11-02T08:16:34.778Z',
  volumeEffectiveTime:null,openInterestEffectiveTime:null,openInterestReference:{daySession:'PREVIOUS_NIGHT_SESSION',nightSession:'CURRENT_AFTERNOON_SESSION'}};
 const context=domain.tfexOverviewContext(status);
 assert.equal(context.sourceLabel,'TFEX Official');assert.equal(context.saved,true);
 assert.ok(context.updated.includes(domain.overviewSourceStamp(status.sourceUpdatedAt)));assert.ok(context.received.includes(domain.overviewSourceStamp(status.fetchedAt)));
 assert.match(context.volumeEffective,/ยังไม่ยืนยัน/);assert.match(context.oiEffective,/ยังไม่ยืนยัน/);assert.match(context.oiReference,/Night Session ก่อนหน้า/);
 assert.match(domain.marketOverviewStatus({fieldStatus:{tfex:status}}),/TFEX Official/);
});

test('P1 TFEX LKG and unverified effective time have explicit state and full source date including year', () => {
 const status={state:'LKG',source:'TFEX',sourceUpdatedAt:'2026-10-20T22:19:18+07:00',fetchedAt:'2026-10-20T15:20:00Z'};
 const c=domain.tfexOverviewContext(status);
 assert.match(c.stateLabel,/ข้อมูลเก่า.*LKG/);assert.match(c.updated,/2569/);
 assert.doesNotMatch(c.stateLabel,/ข้อมูลล่าสุด/);assert.equal(c.displayable,true);
 assert.match(domain.tfexOverviewContext({...status,state:'PASS'}).stateLabel,/Snapshot.*ยังไม่ยืนยัน/);
});

for (const state of ['UNAVAILABLE', undefined, 'fresh']) test('P1 UI refuses TFEX numeric payload when field status is '+state,()=>{
 assert.equal(domain.tfexOverviewContext({state,source:'TFEX',sourceUpdatedAt:'2026-10-20T22:19:18+07:00'}).displayable,false);
});

test('P1 UI refuses missing/invalid source clocks rather than using receipt time',()=>{
 for(const clock of [undefined,'bad','2026-02-30T12:00:00+07:00']) {
  assert.equal(domain.tfexOverviewContext({state:'PASS',source:'TFEX',sourceUpdatedAt:clock,fetchedAt:'2026-11-02T08:00:00Z'}).displayable,false);
  assert.equal(domain.activeOverviewContext({fieldStatus:{activeValue:{state:'PASS',sourceUpdatedAt:clock}},activeValueStatus:'ข้อมูลล่าสุด'}).displayable,false);
 }
});

test('P1 Most Active caption derives dated LKG/Snapshot from metadata, ignoring unsubstantiated latest caption',()=>{
 const status={state:'LKG',source:'SETTRADE',sourceUpdatedAt:'2026-10-20T22:19:18+07:00',reportedAsOf:'20 ต.ค. 2569 22:19:18',sessionContext:'SESSION_SNAPSHOT'};
 const data={activeValue:[{}],fieldStatus:{activeValue:status},activeValueStatus:'ข้อมูลล่าสุด'};
 const c=domain.activeOverviewContext(data);assert.equal(c.displayable,true);assert.match(c.caption,/LKG.*20 ต.ค. 2569/);
 assert.doesNotMatch(c.caption,/ข้อมูลล่าสุด/);
 const snapshot=domain.activeOverviewContext({...data,fieldStatus:{activeValue:{...status,state:'PASS'}}});
 assert.match(snapshot.caption,/Snapshot/);assert.doesNotMatch(snapshot.caption,/ข้อมูลล่าสุด/);
});

test('TFEX missing metadata cannot borrow the aggregate fetch clock or relabel an old source', () => {
 const context=domain.tfexOverviewContext({source:'SETTRADE',asOf:'2026-11-02T08:16:34.778Z'});
 assert.equal(context.sourceLabel,'SETTRADE');assert.match(context.updated,/ยังไม่ยืนยัน/);assert.match(context.received,/ยังไม่ยืนยัน/);
 assert.match(context.oiReference,/ยังไม่ยืนยัน/);assert.equal(context.saved,false);
});

test('retained Watchlist items intersect current stocks, merge identities and drop expired/negative news',()=>{
 const time=Date.now(),item={title:'public',url:'https://www.kaohoon.com/news/shared',pubDate:new Date(time).toISOString(),matchedSymbols:['PTT','OR'],verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}};
 const items=domain.retainWatchlistNews([item,{...item,url:item.url+'?utm_source=rss',matchedSymbols:['KBANK']},{...item,url:item.url+'expired',pubDate:new Date(time-31*86400000).toISOString()},{...item,url:item.url+'bad',verification:{status:'REJECTED'}}],[{symbol:'PTT'},{symbol:'KBANK'}],time);
 assert.equal(items.length,1);assert.deepEqual(new Set(items[0].matchedSymbols),new Set(['PTT','KBANK']));
});

test('Watchlist retention fails closed for missing/unknown verification and preserves only current verified associations',()=>{
 const time=Date.now(),good={title:'Verified public news',url:'https://www.kaohoon.com/news/strict',pubDate:new Date(time).toISOString(),matchedSymbols:['PTT','OR'],verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}};
 const bad=[undefined,{}, {status:'UNKNOWN'},{status:'UNVERIFIED'},{status:'REJECTED'}].map((verification,i)=>({...good,url:good.url+'/'+i,verification}));
 const expired={...good,url:good.url+'/expired',pubDate:new Date(time-31*86400000).toISOString()};
 const added=domain.retainWatchlistNews([good,...bad,expired],[{symbol:'PTT'},{symbol:'OR'},{symbol:'KBANK'}],time,{hardGate:true});
 assert.equal(added.length,1);assert.deepEqual(added[0].matchedSymbols,['PTT','OR']);
 const removed=domain.retainWatchlistNews(added,[{symbol:'PTT'}],time);assert.equal(removed.length,1);assert.deepEqual(removed[0].matchedSymbols,['PTT']);
 assert.deepEqual(domain.retainWatchlistNews(added,[{symbol:'KBANK'}],time),[]);
 const duplicate=domain.retainWatchlistNews([good,{...good,url:good.url+'?utm_source=rss',matchedSymbols:['KBANK']}],[{symbol:'PTT'},{symbol:'KBANK'}],time);
 assert.equal(duplicate.length,1);assert.deepEqual(new Set(duplicate[0].matchedSymbols),new Set(['PTT','KBANK']));
});

test('display rules never block actual AI and negative verification cannot inherit analysis',()=>{
 const item={title:'PTT',analysisMode:'rules',analysisSummary:'Read-time rules',verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}};
 assert.equal(domain.newsDisplayAnalysis(item).mode,'rules');
 assert.equal(domain.newsDisplayAnalysis(item,{mode:'ai',summary:'Real AI result'}).mode,'ai');
 assert.equal(domain.newsDisplayAnalysis(item,{mode:'unavailable',summary:''}).mode,'rules');
 for(const status of ['UNVERIFIED','REJECTED'])assert.equal(domain.newsDisplayAnalysis({...item,verification:{status}},{mode:'ai',summary:'Other result'}),null);
 assert.equal(domain.newsDisplayAnalysis({...item,analysisMode:'',analysisSummary:''}),null);
 assert.equal(domain.sentimentHeadline('PTT กำไรเพิ่ม'),'บวก');assert.equal(domain.sentimentHeadline('PTT ขาดทุน'),'ลบ');
 assert.equal(domain.sentimentHeadline('PTT รายงานข้อมูล'),'เป็นกลาง');
});

test('analysis requests stay below endpoint budget without timers and cooldown can expire',()=>{
 const calls=[];for(let time=0;time<60000;time+=100){if(domain.canRequestNewsAnalysis(time,calls))calls.push(time);}
 assert.equal(calls.length,6);assert.equal(domain.canRequestNewsAnalysis(59999,calls),false);
 assert.equal(domain.canRequestNewsAnalysis(60000,calls),true);
 assert.equal(domain.canRequestNewsAnalysis(61000,[],62000),false);assert.equal(domain.canRequestNewsAnalysis(62000,[],62000),true);
});

test('verified stored AI survives cached unavailable while legacy and negative evidence remain restricted',()=>{
 const stored={url:'https://www.kaohoon.com/news/verified',analysisMode:'ai',analysisSummary:'Verified stored AI'};
 const unavailable={mode:'unavailable',summary:''};
 assert.equal(domain.newsDisplayAnalysis({...stored,verification:{status:'VERIFIED',basis:'metadata'}},unavailable)?.summary,stored.analysisSummary);
 assert.equal(domain.newsDisplayAnalysis(stored,unavailable),null,'legacy summary has no verified evidence');
 assert.equal(domain.newsDisplayAnalysis(stored),null,'legacy AI cannot enter display/cache before a current attempt either');
 for(const status of ['UNVERIFIED','REJECTED']){
  assert.equal(domain.newsDisplayAnalysis({...stored,verification:{status}},unavailable),null);
  assert.equal(domain.newsDisplayAnalysis({...stored,verification:{status}},{mode:'ai',summary:'Cached AI'}),null);
 }
 assert.equal(domain.newsDisplayAnalysis({...stored,analysisMode:'unknown',verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}},unavailable),null);
});

test('Search display formats reviewed SEC names without modifying source records or symbols', () => {
  const { rows } = require('./fixtures/search-company-display.json');
  const before = structuredClone(rows);
  const cached = rows.map(row => Object.freeze({symbol:row.symbol,name:row.company_name_en}));
  for (const row of cached) Object.freeze(row);
  for (const [index, row] of rows.entries()) {
    assert.equal(domain.formatSearchCompanyName(cached[index].name, row.symbol), row.display, row.symbol);
    assert.equal(domain.formatSearchCompanyName(row.display, row.symbol), row.display, 'stable display: ' + row.symbol);
    assert.equal(row.company_name_en.replace(/\p{L}/gu, ''), row.display.replace(/\p{L}/gu, ''), 'punctuation: ' + row.symbol);
  }
  assert.deepEqual(rows, before);
  assert.deepEqual(cached, before.map(row => ({symbol:row.symbol,name:row.company_name_en})));
});

test('Search display preserves initialisms, brand casing and punctuation', () => {
  for (const [source, expected] of [
    ['PTT, SCG & CP PUBLIC COMPANY LIMITED', 'PTT, SCG & CP Public Company Limited'],
    ['B.GRIMM POWER PUBLIC COMPANY LIMITED', 'B.Grimm Power Public Company Limited'],
    ['S&P SYNDICATE PUBLIC COMPANY LIMITED', 'S&P Syndicate Public Company Limited'],
    ['P.C.S. MACHINE GROUP HOLDING PUBLIC COMPANY LIMITED', 'P.C.S. Machine Group Holding Public Company Limited'],
    ["O'REILLY (THAILAND) PUBLIC CO., LTD.", "O'Reilly (Thailand) Public Co., Ltd."],
    ['  AMATA  CORPORATION — PUBLIC COMPANY LIMITED  ', '  Amata  Corporation — Public Company Limited  ']
  ]) assert.equal(domain.formatSearchCompanyName(source), expected);
});

test('Search display keeps existing mixed casing and symbol-only fallbacks unchanged', () => {
  for (const name of ['B.Grimm Power Public Company Limited', 'i-Tail Corporation Public Company Limited',
    'BlueVenture Group Public Company Limited', 'S&P Syndicate Public Company Limited', 'all lowercase', 'บริษัททดสอบ']) {
    assert.equal(domain.formatSearchCompanyName(name), name);
  }
  for (const symbol of ['AMATA', 'PTT', 'S&P', 'L&E', 'THCOM']) assert.equal(domain.formatSearchCompanyName(symbol, symbol), symbol);
  assert.equal(domain.formatSearchCompanyName(''), '');
  assert.equal(domain.formatSearchCompanyName(null), '');
});

test('dense intraday chart geometry stays within the viewport and preserves ordering', () => {
  const geometry = domain.chartGeometry({ rowCount: 292, hostWidth: 640, range: '1D' });
  assert.equal(geometry.width, 640);
  assert.ok(geometry.step > 1);
  assert.ok(geometry.candleWidth >= 1);
  assert.ok(geometry.x(0) < geometry.x(291));
  assert.ok(geometry.x(291) <= geometry.width - geometry.right);
});

test('Footer Coverage accepts only fresh, valid persisted counts', () => {
  const valid = {
    configured: true, universe: 400, currentVerified: 321,
    lastChecked: '2026-10-24T01:00:00.000Z', provider: 'Yahoo Finance', dataState: 'fresh'
  };
  assert.deepEqual(domain.coverageDisplayState(valid), {
    ready: true, reason: null, universe: 400, currentVerified: 321
  });
  assert.equal(domain.coverageDisplayState({ ...valid, universe: null }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, dataState: 'stale' }).reason, 'stale');
  assert.equal(domain.coverageDisplayState({ ...valid, currentVerified: 401 }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, currentVerified: '321' }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, provider: 'fixture' }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, currentUsable: 0 }).currentVerified, 0);
  assert.equal(domain.coverageDisplayState({ ...valid, currentUsable: null }).reason, 'invalid');
});

test('chart viewport defaults to a useful latest window without changing the dataset', () => {
  assert.deepEqual(domain.defaultChartViewport({ rowCount: 200, hostWidth: 390, range: '1D' }), {
    start: 158, end: 200, followLatest: true
  });
  assert.deepEqual(domain.defaultChartViewport({ rowCount: 8, hostWidth: 390, range: '1D' }), {
    start: 0, end: 8, followLatest: true
  });
});

test('chart zoom preserves its anchor and pan remains bounded in cached rows', () => {
  const initial = { start: 100, end: 150, followLatest: false };
  const zoomed = domain.zoomChartViewport(initial, 200, .5, .5);
  assert.deepEqual(zoomed, { start: 113, end: 138, followLatest: false });
  assert.deepEqual(domain.panChartViewport(zoomed, 200, -999), { start: 0, end: 25, followLatest: false });
  assert.deepEqual(domain.panChartViewport(zoomed, 200, 999), { start: 175, end: 200, followLatest: true });
});

test('adaptive price axis uses only visible valid values and does not invent missing prices', () => {
  const axis = domain.chartPriceAxis([
    { low: 98, high: 103 },
    { low: 99, high: 104 },
    { low: null, high: undefined }
  ], [100, null]);
  assert.equal(axis.min, 97.52);
  assert.equal(axis.max, 104.48);
  assert.equal(domain.chartPriceAxis([{ low: null, high: null }]), null);
});

test('workspace routing preserves canonical and legacy hashes', () => {
  assert.equal(domain.pageFromHash('#overview'), 'overview');
  assert.equal(domain.pageFromHash('#chart-section'), 'chart');
  assert.equal(domain.pageFromHash('#news-section'), 'news');
  assert.equal(domain.pageFromHash('#top'), 'overview');
  assert.equal(domain.pageFromHash('#unknown'), 'overview');
});

test('watchlists stay bounded and reject invalid symbols without inventing items', () => {
  const normalized = domain.normalizeLists([{
    id: 'list-1',
    name: ' Main ',
    items: [{ symbol: 'PTT', name: 'ปตท.' }, { symbol: '../BAD' }, null]
  }]);
  assert.equal(normalized[0].name, 'Main');
  assert.deepEqual(normalized[0].items, [{ symbol: 'PTT', name: 'ปตท.' }]);
  assert.equal(domain.mergeWatchlists(normalized, []), normalized);
});

test('a valid Watchlist URL selection wins over cloud and local active selections', () => {
  const lists = [{ id: 'list-1' }, { id: 'list-2' }];
  assert.equal(domain.resolveActiveWatchlistId(lists, {
    requestedId: 'list-2',
    cloudId: 'list-1',
    localId: 'list-1'
  }), 'list-2');
  assert.equal(domain.resolveActiveWatchlistId(lists, {
    requestedId: 'stale-list',
    cloudId: 'list-1',
    localId: 'list-2'
  }), 'list-1');
});

test('news search includes an analysis summary but does not fabricate a match', () => {
  const item = { title: 'PTT update', sourceName: 'SET News', snippet: '' };
  assert.equal(domain.matchesNewsQuery(item, 'กำไร', 'กำไรเติบโต'), true);
  assert.equal(domain.matchesNewsQuery(item, 'ขาดทุน', ''), false);
});

test('pagination and escaping preserve frontend output contracts', () => {
  assert.deepEqual(domain.pageList(5, 10), [1, 2, '…', 4, 5, 6, '…', 9, 10]);
  assert.deepEqual(domain.pageList(1, 1), [1]);
  assert.deepEqual(domain.pageList(1, 2), [1, 2]);
  assert.deepEqual(domain.pageList(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(domain.pageList(22, 43), [1, 2, '…', 21, 22, 23, '…', 42, 43]);
  assert.equal(domain.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test('featured news is source-aware and excluded from the latest list', () => {
  const now = Date.parse('2026-10-18T00:00:00.000Z');
  const items = [
    { source: 'infoquest', title: 'IQ recent', pubDate: '2026-10-17T00:00:00.000Z' },
    { source: 'infoquest', title: 'IQ older', pubDate: '2026-10-01T00:00:00.000Z' },
    { source: 'efinance', title: 'EF recent', pubDate: '2026-10-16T00:00:00.000Z' }
  ];
  const selected = domain.selectNewsForDisplay(items.map((item,index)=>({...item,url:item.url || 'https://www.kaohoon.com/news/fixture-'+index,verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}})), { source: 'infoquest', now });
  assert.deepEqual(selected.featured.map(item => item.title), ['IQ recent']);
  assert.deepEqual(selected.latest.map(item => item.title), ['IQ older']);
});

test('canonical URL state restores all five workspaces and rejects stale input', () => {
  assert.equal(domain.pageFromHash('#profile'), 'profile');
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?watchlist=private&token=discard#profile'), { route: 'profile' });
  assert.equal(domain.navigationUrl({ route: 'profile', watchlistId: 'private', query: 'discard' }), '/#profile');
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/#overview'), { route: 'overview' });
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?symbol=ptt&range=1M#chart'), {
    route: 'chart', symbol: 'PTT', range: '1M'
  });
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?s=PTT&source=infoquest&newsPage=12#news'), {
    route: 'news', query: 'PTT', source: 'infoquest', newsPage: 12
  });
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?watchlist=list-2&watchPage=4#watchlist'), {
    route: 'watchlist', watchlistId: 'list-2', watchPage: 4
  });
  assert.equal(domain.navigationUrl({ route: 'watchlist', watchlistId: 'fixture-private-list', watchPage: 4 }), '/?watchPage=4#watchlist');
  assert.equal(domain.navigationUrl({ route: 'chart', symbol: 'PTT', range: '1M' }), '/?symbol=PTT&range=1M#chart');
  assert.equal(domain.navigationUrl({ route: 'news', query: '<PTT>', source: 'invalid', newsPage: -2 }), '/?s=%3CPTT%3E#news');
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?token=secret&source=bad&newsPage=NaN#news'), {
    route: 'news', query: '', source: 'all', newsPage: 1
  });
});

test('missing market values remain unavailable instead of becoming zero', () => {
  assert.equal(domain.toFiniteNumber(null), null);
  assert.equal(domain.toFiniteNumber(''), null);
  assert.equal(domain.toFiniteNumber('0'), 0);
  assert.deepEqual(domain.quoteChange(35.25, null), { change: null, percent: null });
  assert.deepEqual(domain.quoteChange(35.25, 35), { change: 0.25, percent: 0.25 / 35 * 100 });

  const unavailable = domain.summarizeBreadth([{ items: [
    { label: 'Gainers', count: null },
    { label: 'Losers', count: undefined }
  ] }]);
  assert.deepEqual(unavailable, { up: null, down: null, comparable: false });

  const validZero = domain.summarizeBreadth([{ items: [
    { label: 'Gainers', count: 0 },
    { label: 'Losers', count: 0 }
  ] }]);
  assert.deepEqual(validZero, { up: 0, down: 0, comparable: true });
});

test('Market Overview banner keeps one validated SETTRADE index snapshot after a later market response', () => {
  const resolved = domain.resolveMarketBannerFields({
    symbol: 'SET', last: 1546.05, change: -8.89, changePercent: -0.57,
    volumeThousand: 9921584, high: 1563.04, low: 1532.71, turnoverMillion: 43861.21
  }, {
    symbol: 'SET', guardStatus: 'accepted', last: 1546.1, prior: 1554.9,
    volume: null, high: null, low: null, turnoverMillionBaht: null
  });

  assert.equal(resolved.index.last, 1546.05);
  assert.equal(resolved.volumeThousand, 9921584);
  assert.deepEqual([resolved.high, resolved.low], [1563.04, 1532.71]);
  assert.equal(resolved.turnoverMillion, 43861.21);
  assert.deepEqual(resolved.sources, {
    index: 'overview', volume: 'overview', range: 'overview', turnover: 'overview'
  });
});

test('Market Overview banner converts valid raw-share fallback volume to thousands without inventing missing values', () => {
  const fallback = domain.resolveMarketBannerFields(null, {
    symbol: 'SET', guardStatus: 'accepted', last: 1500, prior: 1490,
    volume: 1234567000, high: 1510, low: 1480, turnoverMillionBaht: 45678.9
  });
  assert.equal(fallback.volumeThousand, 1234567);
  assert.equal(fallback.turnoverMillion, 45678.9);
  assert.deepEqual(fallback.sources, {
    index: null, volume: 'market', range: 'market', turnover: 'market'
  });
  assert.equal(fallback.index, null);

  const unavailable = domain.resolveMarketBannerFields({}, {
    symbol: 'SET', guardStatus: 'accepted', last: 1500, prior: 1490,
    volume: null, high: null, low: null, turnoverMillionBaht: null
  });
  assert.equal(unavailable.volumeThousand, null);
  assert.equal(unavailable.high, null);
  assert.equal(unavailable.low, null);
  assert.equal(unavailable.turnoverMillion, null);
  assert.equal(unavailable.index, null);
});

test('Market Overview banner keeps truthful LKG or unavailable SETTRADE index state without Yahoo substitution', () => {
  const yahoo = {
    symbol: 'SET', guardStatus: 'accepted', last: 1498.25, prior: 1490,
    volume: 1000000, high: 1510, low: 1480, turnoverMillionBaht: 45000
  };
  const savedSettrade = { symbol: 'SET', last: 1502.75, change: -1.25, changePercent: -0.08 };
  const lkg = domain.resolveMarketBannerFields(savedSettrade, yahoo);

  assert.equal(lkg.index.last, 1502.75);
  assert.equal(lkg.sources.index, 'overview');
  const savedAt = '2026-10-23T07:30:00.000Z';
  const refreshedAt = '2026-10-23T08:00:00.000Z';
  const lkgStatus = domain.marketOverviewStatus({
    fetchedAt: refreshedAt,
    dataState: 'stale',
    fieldStatus: { indices: { state: 'LKG', stale: true, asOf: savedAt } }
  });
  assert.match(lkgStatus, /ข้อมูลที่บันทึกล่าสุด \(LKG\)$/);
  assert.ok(lkgStatus.includes(domain.stamp(savedAt)));
  assert.ok(lkgStatus.includes(`รับข้อมูลเมื่อ: ${domain.stamp(refreshedAt)}`));
  assert.ok(lkgStatus.includes(`เวลาตลาด: ${domain.stamp(savedAt)}`));

  const passAt = '2026-10-23T07:59:00.000Z';
  const passStatus = domain.marketOverviewStatus({
    fetchedAt: refreshedAt,
    dataState: 'delayed',
    fieldStatus: { indices: { state: 'PASS', asOf: passAt } }
  });
  assert.ok(passStatus.includes(domain.stamp(passAt)));

  const expired = domain.resolveMarketBannerFields(null, yahoo);
  assert.equal(expired.index, null);
  assert.equal(expired.sources.index, null);
});

test('Market Overview freshness label distinguishes current, partial and LKG data', () => {
  const fetchedAt = '2026-10-21T07:16:21.000Z';
  const fresh = domain.marketOverviewStatus({ fetchedAt, dataState: 'fresh', fieldStatus: {} });
  assert.match(fresh, /^แหล่งข้อมูล SETTRADE · เวลาตลาดยังไม่ยืนยัน · รับข้อมูลเมื่อ: /);
  assert.doesNotMatch(fresh, /อัปเดตล่าสุด/);
  assert.doesNotMatch(fresh, /LKG|บางส่วนไม่พร้อม/);

  const partial = domain.marketOverviewStatus({ fetchedAt, dataState: 'partial', fieldStatus: {} });
  assert.doesNotMatch(partial, /บางส่วนไม่พร้อม/);

  const lkg = domain.marketOverviewStatus({ fetchedAt, dataState: 'partial', fieldStatus: { nvdr: { state: 'LKG' } } });
  assert.match(lkg, /ข้อมูลที่บันทึกล่าสุด \(LKG\)$/);
});
test('one news URL keeps the same identity across Live Featured and Archive Latest', () => {
  const date = '2026-10-27T04:00:00.000Z';
  const article = { source: 'kaohoon', title: 'PTT รายงานผลประกอบการ', url: 'https://www.kaohoon.com/news/abc?utm_source=rss', pubDate: date };
  const archived = { ...article, url: 'https://www.kaohoon.com/news/abc', fingerprint: 'sha256-archive-fingerprint' };
  const official = { source: 'official', title: 'BOT ประกาศแนวทางใหม่', url: 'https://www.bot.or.th/news/official', pubDate: date };
  article.verification = official.verification = {status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'};
    const options = { now: Date.parse(date) + 1000, featuredCount: 1, sourceTier: { official: 4, kaohoon: 2 } };
  const category = domain.selectNewsForDisplay([article, official], { ...options, source: 'kaohoon' });
  const all = domain.selectNewsForDisplay([article, official], { ...options, source: 'all' });
  assert.equal(category.featured[0].url, article.url);
  assert.equal(all.featured[0].url, official.url);
  assert.equal(all.latest[0].url, article.url);
  assert.equal(domain.newsKey(category.featured[0]), domain.newsKey(archived));
  assert.equal(domain.newsKey(all.latest[0]), domain.newsKey(archived));
  assert.notEqual(domain.newsKey(article), domain.newsKey(official));
});

test('Watchlist News empty, partial and unavailable are not conflated', () => {
  assert.equal(domain.watchlistNewsViewState({items:[],dataState:'fresh'}), 'empty');
  assert.equal(domain.watchlistNewsViewState({items:[],dataState:'unavailable'}), 'unavailable');
  assert.equal(domain.watchlistNewsViewState({items:[{title:'news'}],dataState:'partial'}), 'partial');
  assert.equal(domain.watchlistNewsViewState({items:[{title:'news'}],dataState:'stale',stale:true}), 'stale');
  assert.equal(domain.watchlistNewsViewState({items:[{title:'news'}],dataState:'fresh'}), 'fresh');
  assert.equal(domain.watchlistNewsViewState({error:'broken'}), 'error');
});

test('Smart Watchlist only uses validated Yahoo quotes and leaves an unknown percent blank', () => {
  const quote = { provider: 'Yahoo Finance', guardStatus: 'accepted', dataState: 'delayed', last: 25, prior: 20 };
  assert.deepEqual(domain.usableWatchlistQuote(quote), { last: 25, change: 5, percent: 25 });
  assert.deepEqual(domain.usableWatchlistQuote({ ...quote, prior: null }), { last: 25, change: null, percent: null });
  for (const patch of [
    { provider: 'Other' }, { identityStatus: 'suspect' }, { quoteStatus: 'unavailable' },
    { guardStatus: 'rejected' }, { dataState: 'stale' }, { stale: true }, { fallbackFromLastKnown: true },
    { last: null }, { last: '25' }, { last: Infinity }, { last: 0 }
  ]) assert.equal(domain.usableWatchlistQuote({ ...quote, ...patch }), null);
});

test('Watchlist sorts both ways with stable ties, missing criteria last and saved membership intact', () => {
  const items = Object.freeze([{ symbol: 'PTT' }, { symbol: 'WHA', name: 'บริษัท ดับบลิวเอชเอ' },
    { symbol: 'AMATA' }, { symbol: 'CPALL' }, { symbol: 'ROJNA' }]);
  const quotes = new Map([
    ['WHA', { last: 4, percent: 5 }], ['AMATA', { last: 20, percent: -2 }],
    ['CPALL', { last: 4, percent: 5 }], ['ROJNA', { last: 2, percent: null }]
  ]);
  const view = options => domain.watchlistView(items, quotes, options).map(({ item }) => item.symbol);
  assert.deepEqual(view({ sort: 'price-desc' }), ['AMATA', 'WHA', 'CPALL', 'ROJNA', 'PTT']);
  assert.deepEqual(view({ sort: 'price-asc' }), ['ROJNA', 'WHA', 'CPALL', 'AMATA', 'PTT']);
  assert.deepEqual(view({ sort: 'change-desc' }), ['WHA', 'CPALL', 'AMATA', 'PTT', 'ROJNA']);
  assert.deepEqual(view({ sort: 'change-asc' }), ['AMATA', 'WHA', 'CPALL', 'PTT', 'ROJNA']);
  assert.deepEqual(view({ query: 'ดับบลิว', sort: 'change-desc' }), ['WHA']);
  assert.deepEqual(view({}), ['PTT', 'WHA', 'AMATA', 'CPALL', 'ROJNA']);
});

test('manual monitoring and crossing alerts share positive finite thresholds', () => {
  assert.deepEqual(domain.watchlistThresholds({ above: '2.50', below: 1 }), { above: 2.5, below: 1 });
  assert.deepEqual(domain.watchlistThresholds({ above: '-5', below: Infinity }), { above: null, below: null });
  assert.deepEqual(domain.watchlistThresholds({ above: '', below: 0 }), { above: null, below: null });
});
