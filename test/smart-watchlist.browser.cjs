'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');

const root = path.resolve(__dirname, '..');
const stocks = ['WHA', 'AMATA', 'ROJNA'];
const items = symbols => symbols.map(symbol => ({ symbol, name: 'บริษัท ' + symbol }));
const ownerLists = {
  a: [{ id: 'list-1', name: 'A Smart', items: items(stocks) }, { id: 'list-2', name: 'A Second', items: items(['PTT']) }],
  b: [{ id: 'list-1', name: 'B Smart', items: items(['CPALL']) }]
};
const quote = (symbol, last, prior, dataState = 'delayed') => ({
  symbol, last, prior, time: Date.now(), provider: 'Yahoo Finance', guardStatus: 'accepted', identityStatus: 'accepted', dataState
});

async function verifyAlertAcceptance(browser, base) {
  for (const width of [1366,390]) for (const theme of ['light','dark']) {
    const context = await browser.newContext({viewport:{width,height:900},isMobile:width<790,hasTouch:width<790});
    const page = await context.newPage(), errors=[], requests=[], external=[], state={getOwners:[],putOwners:[]};
    let last=110, prior=100, otherLast=49, bLast=100, invalid={}, fail=false, sourceOffset=0, descending=false;
    const legacyHistory={symbol:'PTT',title:'สัญญาณเอนซื้อ',body:'legacy notification retained',time:new Date().toISOString()};
    await page.clock.install({time:new Date()});
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      const owner=/token-b/.test(request.headers().authorization||'')?'b':'a';
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co'){external.push(url.origin);return route.abort();}
      if(url.origin===base&&url.pathname==='/api/watchlists') {
        if(request.method()==='PUT')return json({ok:true});
        return json({record:{watchlists:owner==='a'?[{id:'list-1',name:'Alerts A',items:items(['PTT'])},
          {id:'list-2',name:'A shared symbol',items:items(['PTT','SCB'])}]:[{id:'list-1',name:'Alerts B',items:items(['PTT'])}],active_watchlist_id:'list-1'}});
      }
      if(url.origin===base&&url.pathname==='/api/market') {
        requests.push({owner,symbols:url.searchParams.get('symbols').split(',')});
        if(fail)return json({error:'fixture unavailable'},503);
        const observed=Date.now(),barTime=observed-80*60000;
        const bars=Array.from({length:70},(_,i)=>{const close=descending?130-i*.1:100+i*.1;
          return {time:barTime+i*60000,open:close,close,high:close+.2,low:close-.2,volume:1000};});
        const meta={provider:'Yahoo Finance',interval:'1m',timeZone:'Asia/Bangkok',receivedAt:new Date(observed).toISOString()};
        const rows=[{...quote('PTT',owner==='a'?last:bLast,prior),time:observed+sourceOffset,history:bars,...invalid},quote('SCB',otherLast,50),quote('CPALL',90,89)];
        return json({stocks:rows,indices:[],history:bars,indicatorHistory:bars,levelsHistory:bars,
          technicalMeta:{history:meta,indicator:meta,levels:meta},fetchedAt:meta.receivedAt,dataState:'delayed'});
      }
      return mockRequest(route,base,state);
    });
    page.on('pageerror',error=>errors.push(error.message));
    await seedPage(page,'token-a');
    await page.addInitScript(({theme,legacyHistory})=>{
      localStorage.setItem('setscope-theme',theme);
      if(!localStorage.getItem('setscope-alert-prefs:user-a')) {
        localStorage.setItem('setscope-alert-prefs:user-a',JSON.stringify({PTT:{above:'103',below:'95',technical:true}}));
        localStorage.setItem('setscope-alert-states:user-a',JSON.stringify({PTT:{price:1,technical:'ขาย',updatedAt:Date.now()}}));
        localStorage.setItem('setscope-alert-history:user-a',JSON.stringify([legacyHistory]));
      }
      window.fixturePermission='granted';window.fixtureNotifications=[];
      window.Notification=class {static get permission(){return window.fixturePermission;}
        static async requestPermission(){return window.fixturePermission;}
        constructor(title,options){window.fixtureNotifications.push({title,options});}};
    },{theme,legacyHistory});
    await page.goto(base+'/?symbol=PTT&range=1D#watchlist');
    await page.waitForSelector('#watchlist-mobile [data-sym=PTT]');
    const panel=page.locator('#alerts-panel');
    const open=async()=>{if(!await panel.isVisible())await page.locator('#alerts-toggle').click();};
    const fields=symbol=>panel.locator(`[data-alert-symbol=${symbol}] input`);
    const set=async(field,value,symbol='PTT')=>{await open();await panel.locator(`[data-alert-symbol=${symbol}] [data-field=${field}]`).fill(value);};
    const history=async owner=>page.evaluate(owner=>JSON.parse(localStorage.getItem('setscope-alert-history:user-'+owner)||'[]'),owner);
    let total=1;
    const unchanged=async()=>assert.equal((await history('a')).length,Math.min(total,30));
    const added=async(count)=>{total+=count;await unchanged();};
    const refresh=async()=>{
      await open();const before=requests.length,done=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/market');
      await panel.locator('#watchlist-check').click();await done;
      await page.waitForFunction(()=>!document.querySelector('#watchlist-check').disabled);
      assert.equal(requests.length,before+1,'Manual Check reuses exactly one market request');
    };
    const switchList=async id=>{
      await page.locator('.side-nav [data-workspace-route=watchlist]').click();
      const done=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/market');
      await page.locator(width<790?'#watchlist-select-mobile':'#watchlist-select').selectOption(id);await done;
      await page.waitForFunction(()=>!document.querySelector('#watchlist-check').disabled);
    };
    await open();
    assert.equal(await fields('PTT').count(),4);assert.equal(await panel.locator('[data-field=technical]').count(),0);
    assert.deepEqual(await fields('PTT').evaluateAll(nodes=>nodes.map(node=>node.value)),['','','103','95'],'AC-13 legacy price retained; Percent starts empty');
    await unchanged();assert.deepEqual((await history('a'))[0],legacyHistory,'legacy technical history is not deleted');
    assert.equal(await page.evaluate(()=>window.fixtureNotifications.length),0,'first observation creates no browser notification');
    const beforeEdit=requests.length;
    for(const field of ['above','below','percentAbove','percentBelow'])await set(field,'');
    await panel.locator('#watchlist-check').click();
    assert.equal(requests.length,beforeEdit,'empty conditions and editing do not fetch data');await unchanged();
    for(const[field,value]of Object.entries({above:'103',below:'95',percentAbove:'3',percentBelow:'5'}))await set(field,value);
    last=102;await refresh();await unchanged();
    last=103;await refresh();await added(2); // exact Price + Percent upward boundary
    assert.equal(await page.evaluate(()=>window.fixtureNotifications.length),2);
    await refresh();await unchanged();
    last=102;await refresh();last=103;await refresh();await added(2); // re-arm
    last=102;await refresh();await set('above','104');await set('above','103');last=104;await refresh();await added(1);
    assert.equal((await history('a'))[0].title,'ผ่านระดับเปอร์เซ็นต์ขาขึ้น','editing back before a poll still resets only Price');
    last=102;await refresh();await set('above','104');last=105;await refresh();await added(1);
    assert.equal((await history('a'))[0].title,'ผ่านระดับเปอร์เซ็นต์ขาขึ้น','editing Price does not reset Percent');
    last=103;await refresh();last=104;await refresh();await added(1);
    await set('above','');last=102;await refresh();last=103;await refresh();await added(1);
    last=96;await refresh();last=95;await refresh();await added(2); // exact downward boundaries
    last=94;await refresh();await unchanged();last=96;await refresh();last=95;await refresh();await added(2);
    await set('above','103');await set('below','');await set('percentBelow','');
    last=102;await refresh();prior=null;last=104;await refresh();await added(1);
    assert.match(await panel.locator('#watchlist-check-result').textContent(),/ข้อมูลไม่ครบ: PTT/);
    prior=100;await refresh();await unchanged(); // Percent recovery only baselines
    for(const patch of [{stale:true},{guardStatus:'suspect'},{quoteStatus:'quarantined'},
      {dataState:'unavailable'},{fallbackFromLastKnown:true},{last:null}]) {
      last=102;await refresh();invalid=patch;last=104;await refresh();await unchanged();
      invalid={};await refresh();await unchanged();
    }
    last=102;await refresh();fail=true;last=104;await refresh();await unchanged();fail=false;await refresh();await unchanged();
    last=102;await refresh();prior=99;await refresh();await unchanged(); // no false +3% from a changed reference
    prior=100;last=104;sourceOffset+=24*3600000;await refresh();await unchanged(); // source/session gap
    const doneReload=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/market');
    last=110;await page.reload();await doneReload;await open();await unchanged(); // persisted states cannot replay a crossing
    descending=true;await refresh();await unchanged(); // legacy technical flag no longer evaluates indicators
    await page.evaluate(()=>window.fixturePermission='denied');
    last=102;await refresh();last=104;await refresh();await added(2);
    assert.equal(await page.evaluate(()=>window.fixtureNotifications.length),0,'denied permission suppresses OS notifications, not in-app history');
    await switchList('list-2');await open();
    assert.deepEqual(await fields('SCB').evaluateAll(nodes=>nodes.map(node=>node.value)),['','','',''],'AC-02 new symbol is opt-in only');
    await set('above','50','SCB');await refresh();await switchList('list-1');otherLast=51;await refresh();await unchanged();
    assert.deepEqual(requests.at(-1).symbols,['PTT'],'only selected Watchlist is requested');
    await switchList('list-2');await open();await unchanged();
    assert.equal(await panel.locator('[data-alert-symbol=PTT] [data-field=above]').inputValue(),'103','preferences are Account + Symbol across lists');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.equal(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
    assert.ok(await fields('PTT').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().width>60)));
    if(process.env.SETSCOPE_ALERT_EVIDENCE) {
      await fs.mkdir(process.env.SETSCOPE_ALERT_EVIDENCE,{recursive:true});
      await panel.screenshot({path:path.join(process.env.SETSCOPE_ALERT_EVIDENCE,`alerts-${width}-${theme}.png`)});
    }
    await page.goto(base+'/?symbol=CPALL&range=1D#chart');await page.locator('#watchlist-add-active').waitFor();
    const addResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/market');
    await page.locator('#watchlist-add-active').click();await addResponse;await open();
    assert.deepEqual(await fields('CPALL').evaluateAll(nodes=>nodes.map(node=>node.value)),['','','',''],
      'AC-02 adding a quoted symbol through the UI does not prefill any threshold');await unchanged();
    last=110;await refresh();await unchanged();
    const aPrefs=await page.evaluate(()=>localStorage.getItem('setscope-alert-prefs:user-a'));
    const logout=async()=>{await page.locator('.side-nav [data-workspace-route=profile]').click();
      await Promise.all([page.waitForEvent('load'),page.locator('#profile-logout-button').click()]);};
    const login=async owner=>{await page.locator('#login-form input[name=email]').fill(owner+'@example.test');
      await page.locator('#login-form input[name=password]').fill('fixture-password');await page.locator('#login-form button[type=submit]').click();
      await page.waitForSelector('body.authenticated');await page.waitForSelector('#watchlist-mobile [data-sym=PTT]',{state:'attached'});};
    await logout();await login('b');await open();
    assert.deepEqual(await fields('PTT').evaluateAll(nodes=>nodes.map(node=>node.value)),['','','',''],'AC-01 new account has four blank inputs');
    assert.equal((await history('b')).length,0);await set('above','103');await refresh();bLast=104;await refresh();
    assert.equal((await history('b')).length,1);await unchanged();
    assert.equal(await page.evaluate(()=>localStorage.getItem('setscope-alert-prefs:user-a')),aPrefs);
    await logout();await login('a');await open();await unchanged();
    assert.equal(await panel.locator('[data-alert-symbol=PTT] [data-field=above]').inputValue(),'103');
    const ownedStates=await page.evaluate(()=>Object.fromEntries(['a','b'].map(owner=>[owner,JSON.parse(localStorage.getItem('setscope-alert-states:user-'+owner))])));
    assert.equal(ownedStates.a.PTT.above.value,110);assert.equal(ownedStates.b.PTT.above.value,104);
    last=102;await refresh();await unchanged();await page.locator('#alerts-close').click();last=104;
    const beforePoll=requests.length,pollResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/market');
    await page.clock.fastForward(60000);await pollResponse;
    await page.waitForFunction(()=>!document.querySelector('#watchlist-check').disabled);
    assert.equal(requests.length,beforePoll+1,'existing 60-second polling remains browser-only');
    await added(2);await page.locator('#alert-badge').waitFor({state:'visible'});
    assert.equal(await page.locator('#alert-badge').textContent(),'2');await open();
    assert.equal(await page.locator('#alert-badge').isVisible(),false,'opening the existing bell clears unread state');
    assert.equal(context.serviceWorkers().length,0);
    assert.ok(external.every(origin=>['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(origin)),
      'only existing font loads may be attempted and aborted; no live market-provider requests');
    assert.deepEqual(errors,[]);
    await page.close();const closedCount=requests.length;await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(requests.length,closedCount,'closed page has no background requests');await context.close();
    console.log(JSON.stringify({watchlistAlertAcceptance:'PASS',width,theme,AC:'01-17',liveProviderRequests:0}));
  }
}

async function run() {
  const mime = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
  const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = path.resolve(root, ['/', '/login', '/register'].includes(name) ? 'index.html' : name.slice(1));
    if (!file.startsWith(root + path.sep) || !mime[path.extname(file)]) return response.writeHead(404).end();
    try { response.writeHead(200, { 'content-type': mime[path.extname(file)] }).end(await fs.readFile(file)); }
    catch { response.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const state = { getOwners: [], putOwners: [] }, requests = [], news = [], errors = [];
    let price = 4, amataPrice = 20, failMarket = false, interval = '1m';
    const time = Date.UTC(2026, 10, 4, 3);
    const history = Array.from({ length: 70 }, (_, i) => {
      const close = 30 + i / 10;
      return { time: time + i * 60000, open: close, close, high: close + .2, low: close - .2, volume: 1000 };
    });
    const receivedAt = new Date(time + 71 * 60000).toISOString();
    const metadata = { provider: 'Yahoo Finance', interval: '1m', receivedAt, timeZone: 'Asia/Bangkok' };
    let indicatorReceivedAt = receivedAt, whaIdentity = 'accepted', historyState = 'delayed', historyLength = history.length;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const owner = /token-b/.test(request.headers().authorization || '') ? 'b' : 'a';
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.origin !== base && url.origin !== 'https://isolation-test.supabase.co') return route.abort();
      if (url.origin === base && url.pathname === '/api/watchlists') {
        if (request.method() === 'PUT') return json({ ok: true, syncedAt: new Date().toISOString() });
        return json({ record: { watchlists: ownerLists[owner], active_watchlist_id: 'list-1' } });
      }
      if (url.origin === base && url.pathname === '/api/market') {
        const symbols = url.searchParams.get('symbols').split(',');
        requests.push(symbols);
        if (failMarket) return json({ error: 'fixture unavailable' }, 503);
        const quotes = owner === 'b' ? [quote('CPALL', 45, 43)] : [
          { ...quote('WHA', price, 5), identityStatus: whaIdentity },
          quote('AMATA', amataPrice, 19), quote('ROJNA', 3, 4, 'stale'), quote('PTT', 40, null)
        ];
        const bars = history.slice(0, historyLength);
        return json({ stocks: quotes, indices: [], history: bars, indicatorHistory: bars, levelsHistory: bars,
          technicalMeta: { history: metadata, indicator: { ...metadata, interval, receivedAt: indicatorReceivedAt }, levels: metadata },
          fetchedAt: receivedAt, dataState: historyState });
      }
      if (url.origin === base && url.pathname === '/api/watchlist-news') {
        assert.equal(request.method(), 'POST');
        const symbols = request.postDataJSON().stocks.map(stock => stock.symbol);
        news.push(symbols);
        return json({ fetchedAt: new Date().toISOString(), dataState: 'fresh', items: symbols.map(symbol => ({
          source: 'kaohoon', sourceName: 'ข่าวหุ้น', title: symbol + ' รายงานผลประกอบการ',
          url: 'https://www.kaohoon.com/news/fixture-' + symbol,
          pubDate: new Date().toISOString(), matchedSymbols: [symbol],
          verification: { status: 'VERIFIED', basis: 'article' }
        })) });
      }
      return mockRequest(route, base, state);
    });
    page.on('pageerror', error => errors.push(error.message));
    await seedPage(page, 'token-a');
    await page.addInitScript(() => localStorage.setItem('setscope-alert-prefs:user-a', JSON.stringify({
      WHA: { above: '5', below: '', technical: false },
      AMATA: { above: '-1', below: '18', technical: false },
      ROJNA: { above: '', below: '5', technical: false }
    })));
    const nav = route => page.locator(`.side-nav [data-workspace-route="${route}"]`);
    const list = page.locator('#watchlist-mobile');
    const visible = () => list.locator('.watch-item').evaluateAll(rows => rows.map(row => row.dataset.sym));
    const checkResult = page.locator('#watchlist-check-result');
    const checkButton = page.locator('#alerts-panel #watchlist-check');
    const signal = page.locator('#watchlist-signal-detail summary');
    const cards = page.locator('#watchlist-signal-content .technical-reason-card');
    const sort = page.locator('#watchlist-sort');
    await page.goto(base + '/?symbol=WHA&range=1D#chart');
    await page.waitForSelector('#technical-reasons .compact-reasons');
    const overall = await page.locator('#overall-signal').textContent();
    const reasons = await page.locator('#technical-reasons .technical-reason-text').allTextContents();
    await nav('watchlist').click();
    await list.locator('table').waitFor();
    assert.deepEqual(await visible(), stocks);
    assert.deepEqual(await list.locator('thead th').allTextContents(), ['หุ้น', 'ราคาล่าสุด', 'เปลี่ยนแปลง (%)', 'จัดการ']);
    assert.deepEqual(await list.locator('tbody tr').evaluateAll(rows => rows.map(row => row.cells.length)), [4, 4, 4]);
    assert.equal(await sort.inputValue(), 'saved');
    assert.equal(await page.locator('#watchlist-filter, #watchlist-group').count(), 0);
    assert.equal(await page.locator('.watchlist-tools select').count(), 1);
    assert.deepEqual(await sort.locator('option').allTextContents(), [
      'ค่าเริ่มต้น', '% เปลี่ยนแปลง (สูงสุด → ต่ำสุด)', '% เปลี่ยนแปลง (ต่ำสุด → สูงสุด)',
      'ราคา (สูงสุด → ต่ำสุด)', 'ราคา (ต่ำสุด → สูงสุด)'
    ]);
    assert.equal(await list.evaluate(root => root.scrollWidth <= root.clientWidth), true);
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list').textContent.includes('ROJNA รายงาน'));
    assert.equal(await signal.textContent(), 'สัญญาณ WHA · ' + overall + ' · 1D');
    assert.equal(await list.locator('[data-sym=ROJNA] .watch-price').textContent(), '—');
    assert.equal(await page.locator('#watchlist-page .watchlist-source').count(), 0);
    assert.equal(await page.locator('.chart-source-note').textContent(), 'แหล่งข้อมูล: Yahoo Finance · ล่าช้าประมาณ 15 นาที');
    assert.equal(await list.evaluate(node => node.previousElementSibling.matches('.watchlist-tools')), true);
    await signal.focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await cards.locator('.technical-reason-text').allTextContents(), reasons);
    assert.deepEqual(await cards.locator('.technical-reason-number').allTextContents(),
      reasons.map((_, index) => String(index + 1).padStart(2, '0')));
    assert.equal(await page.locator('#watchlist-signal-content li').count(), 0);
    const initial = [requests.length, news.length];
    await page.locator('#watchlist-search').fill('wha');
    assert.deepEqual(await visible(), ['WHA']);
    for (const symbol of stocks) assert.match(await page.locator('#watchlist-news-list').textContent(), new RegExp(symbol + ' รายงาน'));
    await page.locator('#watchlist-search').fill('');
    for (const [option, expected] of [
      ['change-desc', ['AMATA', 'WHA', 'ROJNA']], ['change-asc', stocks],
      ['price-desc', ['AMATA', 'WHA', 'ROJNA']], ['saved', stocks], ['price-asc', stocks]
    ]) {
      await sort.selectOption(option);
      assert.deepEqual(await visible(), expected);
    }
    assert.deepEqual([requests.length, news.length], initial);
    await page.locator('#refresh-watchlist-news').click();
    await page.waitForFunction(() => !document.querySelector('#refresh-watchlist-news').disabled);
    assert.deepEqual(news.at(-1), stocks);
    await page.locator('#alerts-toggle').click();
    assert.equal(await checkButton.textContent(), 'ตรวจเงื่อนไขราคา/เปอร์เซ็นต์');
    assert.equal(await checkButton.isVisible(), true);
    assert.equal(requests.length, initial[0], 'opening alert settings must not run a manual check');
    price = 5;
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-check-result').textContent.includes('ถึงเงื่อนไข: WHA'));
    assert.equal(await checkResult.textContent(), 'ตรวจราคา/เปอร์เซ็นต์ได้ 2 หุ้น · ถึงเงื่อนไข: WHA · ข้อมูลไม่ครบ: ROJNA');
    assert.deepEqual(requests.at(-1), stocks);
    const countAlerts = () => page.locator('#alerts-history .alert-history-item').count();
    assert.equal(await countAlerts(), 1);
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => !document.querySelector('#watchlist-check').disabled);
    assert.equal(await countAlerts(), 1, 'repeat check must not duplicate a crossing alert');
    assert.equal(requests.length, initial[0] + 2);
    amataPrice = 18;
    interval = '5m';
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-check-result').textContent.includes('WHA, AMATA'));
    assert.equal(await countAlerts(), 2);
    assert.equal(await signal.textContent(), 'สัญญาณ WHA · ยังไม่พร้อม', 'mismatched interval');
    interval = '1m';
    const verifyUnavailable = async (setInvalid, restore, reason) => {
      setInvalid();
      await checkButton.click();
      await page.waitForFunction(() => !document.querySelector('#watchlist-check').disabled);
      assert.equal(await signal.textContent(), 'สัญญาณ WHA · ยังไม่พร้อม', reason);
      assert.equal(await cards.count(), 0);
      restore();
      await checkButton.click();
      await page.waitForFunction(() => !document.querySelector('#watchlist-check').disabled);
      assert.equal(await signal.textContent(), 'สัญญาณ WHA · ' + overall + ' · 1D');
    };
    await verifyUnavailable(() => { whaIdentity = undefined; }, () => { whaIdentity = 'accepted'; }, 'unverified symbol');
    await verifyUnavailable(() => { indicatorReceivedAt = null; }, () => { indicatorReceivedAt = receivedAt; }, 'missing observation time');
    await verifyUnavailable(() => { indicatorReceivedAt = new Date(time + 72 * 60000).toISOString(); },
      () => { indicatorReceivedAt = receivedAt; }, 'observation time newer than response');
    await verifyUnavailable(() => { historyState = 'stale'; }, () => { historyState = 'delayed'; }, 'invalid history state despite valid quote');
    await verifyUnavailable(() => { historyLength = 10; }, () => { historyLength = history.length; }, 'insufficient confirmed history');
    failMarket = true;
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-check-result').textContent.includes('ตรวจเงื่อนไขไม่สำเร็จ'));
    assert.equal(await list.locator('[data-sym=WHA] .watch-price').textContent(), '—');
    assert.equal(await countAlerts(), 2);
    failMarket = false;
    const beforeResize = requests.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await list.locator(':scope > .watch-item').first().waitFor();
    assert.equal(await list.locator('table').count(), 0);
    assert.equal(await sort.inputValue(), 'price-asc');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(requests.length, beforeResize);
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#watchlist-select-mobile').selectOption('list-2');
    await page.waitForFunction(() => document.querySelector('#watchlist-mobile [data-sym=PTT]'));
    assert.equal(await checkResult.isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list').textContent.includes('PTT รายงาน'));
    const withoutConditions = requests.length;
    await page.locator('#alerts-toggle').click();
    await checkButton.click();
    assert.match(await checkResult.textContent(), /ตั้งเงื่อนไขราคา/);
    assert.equal(requests.length, withoutConditions);
    await page.locator('#alerts-close').click();
    await page.locator('#watchlist-select-mobile').selectOption('list-1');
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list').textContent.includes('ROJNA รายงาน'));
    const amata = list.locator('[data-sym=AMATA] .watch-select');
    await amata.focus();
    await page.keyboard.press('Enter');
    assert.equal(await amata.getAttribute('aria-pressed'), 'true');
    assert.match(await signal.textContent(), /^สัญญาณ AMATA · /);
    await page.locator('#watchlist-search').fill('WHA');
    await nav('profile').click();
    await Promise.all([page.waitForEvent('load'), page.locator('#profile-logout-button').click()]);
    await page.locator('#login-form input[name=email]').fill('b@example.test');
    await page.locator('#login-form input[name=password]').fill('fixture-password');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForSelector('body.authenticated');
    await nav('watchlist').click();
    await list.locator('[data-sym=CPALL]').waitFor();
    assert.deepEqual(await visible(), ['CPALL']);
    assert.equal(await page.locator('#watchlist-search').inputValue(), '');
    assert.equal(await page.locator('#watchlist-sort').inputValue(), 'saved');
    await page.locator('#alerts-toggle').click();
    assert.equal(await checkResult.textContent(), '');
    assert.doesNotMatch(await page.locator('#alerts-panel').textContent(), /WHA|AMATA|ROJNA/);
    assert.doesNotMatch(await page.locator('#watchlist-page').textContent(), /WHA|AMATA|ROJNA/);
    assert.deepEqual(errors, []);
    await context.close();
    await verifyAlertAcceptance(browser,base);
    console.log(JSON.stringify({ smartWatchlist: 'PASS', desktop: 1366, mobile: 390, viewRequests: 0, liveProviderRequests: 0 }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
