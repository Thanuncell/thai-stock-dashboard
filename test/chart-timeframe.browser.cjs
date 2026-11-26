'use strict';
// Offline only: reuse the existing provider and authenticated-browser fixtures.
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const { createMarketService } = require('../server/market-service');
const { barsBetween, payload, responder, received } = require('./fixtures/chart-candle-density.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.SETSCOPE_TIMEFRAME_EVIDENCE;
const baseline = process.env.SETSCOPE_TIMEFRAME_BASELINE === '1';
const g3Only = process.env.SETSCOPE_G3_ONLY === '1';
let checks = 0, phase = 'setup';
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const styles = page => page.evaluate(() => Object.fromEntries([
  '.chart-panel h2', '.analysis-panel h2', '.stock-search-wrap label', '#chart-price', '#chart-change',
  '[data-range="1D"]', '#chart-zoom-in', '#chart-reset', '.chart-source-note', '.compact-reasons', '.signal-row', '.indicator-toggle'
].map(selector => {
  const node = document.querySelector(selector); if (!node) return [selector, null];
  const style = getComputedStyle(node);
  return [selector, Object.fromEntries(['fontFamily','fontSize','fontWeight','color','backgroundColor','borderColor'].map(key => [key, style[key]]))];
})));
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const relative = ['/', '/login', '/register'].includes(pathname) ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      const data = baseline ? execFileSync('git', ['show', `40c4cbb406c20e1f3fa6887329412b602ba519df:${relative}`], { cwd:root, stdio:['ignore','pipe','ignore'] }) : fs.readFileSync(file);
      res.writeHead(200, { 'content-type': {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless:true, executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const width of (process.env.SETSCOPE_TECHNICAL_WIDTHS || '320,375,390,768,1024,1440').split(',').map(Number)) for (const theme of ['light','dark']) {
      phase = `${width}-${theme}`;
      const context = await browser.newContext({ viewport:{width,height:950}, isMobile:width<790, hasTouch:width<790 });
      const errors = [], requests = [], providerCalls = [], state = {getOwners:[],putOwners:[]};
      let historicalQuality = 'rejected';
      const standard = responder(providerCalls);
      const service = createMarketService({env:{},now:()=>received,fetchImpl:async input => {
        const url = new URL(input);
        if (url.searchParams.get('range') !== '5y') return standard(input);
        const start = new Date(received); start.setUTCFullYear(start.getUTCFullYear()-5);
        providerCalls.push({range:'5y',interval:url.searchParams.get('interval')});
        const data = barsBetween(+start, received, '1d');
        const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
        const raw = payload(symbol,'1d',data.rows,data.periods);
        if (['SCB.BK','TISCO.BK'].includes(symbol)) {
          const quote = raw.indicators.quote[0];
          quote.high[350] = quote.low[350] - 1;
          if (symbol === 'SCB.BK') for (const key of Object.keys(quote)) quote[key][1] = null;
          if (historicalQuality === 'retained') {
            quote.open[600] = 300; quote.high[600] = 301; quote.low[600] = 299; quote.close[600] = 300;
          }
        }
        return {ok:true,json:async()=>({chart:{result:[raw]}})};
      }});
      let hold = null, g3Scenario = 'provisional', lastMarket = null;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base && url.origin !== 'https://isolation-test.supabase.co') return route.abort();
        if (url.origin === base && url.pathname === '/api/market') {
          const range = url.searchParams.get('range'), symbol = url.searchParams.get('symbol') || 'PTT';
          requests.push({range,history:url.searchParams.get('history'),symbol});
          const data = await service.getMarket([symbol],symbol,range,{fiveYearDailyHistory:url.searchParams.get('history')==='5y'});
          if (g3Only) {
            if (g3Scenario === 'closed') {
              data.fetchedAt = new Date(Date.UTC(2026,11,1,11,30)).toISOString();
              for (const meta of Object.values(data.technicalMeta)) {
                meta.receivedAt = data.fetchedAt;
                meta.regularStart = data.history.at(-1).time;
                meta.regularEnd = meta.regularStart + 6.5 * 3600000;
              }
            } else if (g3Scenario === 'short') {
              for (const field of ['history','indicatorHistory','levelsHistory']) data[field] = data[field].slice(-5);
            } else if (g3Scenario === 'unconfirmed') {
              data.fetchedAt = null;
              for (const meta of Object.values(data.technicalMeta)) meta.receivedAt = null;
            }
          }
          if (hold) { const pending=hold; hold=null; pending.started(); await pending.wait; }
          lastMarket = structuredClone(data);
          return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
        }
        return mockRequest(route,base,state);
      });
      const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
      await seedPage(page,'token-a'); await page.addInitScript(theme=>localStorage.setItem('setscope-theme',theme),theme);
      await page.goto(base+(g3Only?'/?symbol=PTT&range=1D&timeframe=D&historicalRange=5Y#chart':'/?symbol=PTT&range=1D#chart'));
      await page.waitForSelector('.price-candle'); await page.waitForSelector('.compact-reasons',{state:'attached'});
      const filename = `${width}-${theme}`;
      if (g3Only) {
        const {marketTimeframe} = await import('../client/chart-timeframe.mjs');
        const {createTechnicalSnapshot} = await import('../client/technical.mjs');
        const stamp = value => new Intl.DateTimeFormat('th-TH',{timeZone:'Asia/Bangkok',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
        const reload = async action => {
          const done = page.waitForResponse(response => new URL(response.url()).pathname === '/api/market');
          await action(); await done; return structuredClone(lastMarket);
        };
        const verifyEvidence = async (timeframe,parameters={},data=lastMarket) => {
          const selected = marketTimeframe(data,timeframe,'5Y');
          const expected = createTechnicalSnapshot({...selected,symbol:'PTT',timeframe,parameters});
          await page.waitForFunction(id=>document.querySelector('.analysis-panel').dataset.snapshotId===id,expected.id);
          check(await page.locator('.analysis-panel').getAttribute('data-signal-status'),expected.summary.status,'selected timeframe status');
          check(await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'),expected.id,'chart/evidence use the selected calculation snapshot');
          check(await page.locator('.analysis-panel').getAttribute('data-signal-candle-time'),String(expected.candleTime??''),'selected reference candle');
          check(await page.locator('#overall-signal').textContent(),expected.summary.overall);
          const note = await page.locator('#analysis-note').textContent();
          check(note.includes(`· ช่วง ${timeframe} ·`),true,'reference note has the selected D/W/M');
          const ref = expected.signalReference;
          if (ref) {
            check(note.includes(stamp(ref.barOpenTime)),true,'reference open date/time');
            check(note.includes(stamp(ref.availableAt)),true,'reference confirmation date/time');
            check(note.includes(ref.selection==='previous-confirmed'?'ใช้แท่งปิดก่อนหน้า; แท่งล่าสุดยังไม่ยืนยัน':'แท่งยืนยันแล้ว'),true,'confirmed versus provisional latest candle');
          } else check(note.includes('ยังไม่มีแท่งที่ยืนยันได้'),true,'no invented confirmed reference');
          if (expected.summary.status === 'ready') {
            check(await page.locator('.analysis-panel .technical-reason-text').allTextContents(),expected.summary.reasons.map(reason=>reason.text),'reason values contain no previous-timeframe data');
            const disclosure = page.locator('.analysis-panel #technical-reasons > .technical-evidence');
            if (!await disclosure.evaluate(node=>node.open)) await disclosure.locator('summary').click();
            const visible = expected.analysis.reasons.filter(reason=>['ซื้อ','ขาย','เป็นกลาง'].includes(reason.signal));
            check((await disclosure.locator('.evidence-grid li strong').allTextContents()).sort(),visible.map(reason=>`${reason.key} · ${reason.value}`).sort(),'individual indicator evidence values');
            check((await disclosure.locator('.evidence-grid li span').allTextContents()).sort(),visible.map(reason=>reason.detail).sort(),'individual indicator evidence detail');
            for (const key of ['ema20','ema50','ema100','ema200']) {
              if (expected.availability[key].state === 'insufficient')
                check(await page.locator('#'+key+'-signal').textContent(),`ข้อมูลไม่ครบ (${expected.signalRows.length}/${expected.availability[key].required})`,key+' warm-up label uses the selected parameter');
            }
          } else {
            check(await page.locator('.analysis-panel .technical-reason-card').count(),0,'previous reasons cleared');
            check(await page.locator('.analysis-panel #technical-reasons > .technical-evidence').count(),0,'previous evidence cleared');
            check(await page.locator('#rsi-value').textContent(),'—');
          }
          return expected;
        };
        for (const timeframe of ['D','W','M']) {
          phase = `G3-${width}-${theme}-${timeframe}-provisional`;
          g3Scenario = 'provisional';
          await reload(()=>page.locator(`[data-timeframe="${timeframe}"]`).click());
          const initial = await verifyEvidence(timeframe);
          check(initial.summary.status,'ready');check(initial.latestCandle.complete,false);
          check(initial.signalReference.selection,'previous-confirmed');
          phase = `G3-${width}-${theme}-${timeframe}-parameters`;
          const settings = page.locator('.indicator-workspace');
          if (!await settings.evaluate(node=>node.open)) await settings.locator('summary').click();
          const calls = requests.length;
          await page.locator('#indicator-settings input[name=ema20]').fill('100');
          await page.locator('#indicator-settings button[type=submit]').click();
          const changed = await verifyEvidence(timeframe,{ema20:100});
          check(changed.id!==initial.id,true,'parameter change recomputes selected timeframe');
          await page.locator('#indicator-defaults').click();
          check(await page.locator('#indicator-settings input[name=ema20]').inputValue(),'20');
          const reset = await verifyEvidence(timeframe);check(reset.id,initial.id,'reset restores the original selected-timeframe evidence');
          check(requests.length,calls,'parameter/reset remain local');
          phase = `G3-${width}-${theme}-${timeframe}-closed`;
          g3Scenario = 'closed';await reload(()=>page.locator('#refresh-chart').click());
          const closed = await verifyEvidence(timeframe);check(closed.latestCandle.complete,true);check(closed.signalReference.selection,'latest-confirmed');
          phase = `G3-${width}-${theme}-${timeframe}-insufficient`;
          g3Scenario = 'short';await reload(()=>page.locator('#refresh-chart').click());
          check((await verifyEvidence(timeframe)).summary.status,'insufficient');
          phase = `G3-${width}-${theme}-${timeframe}-unconfirmed`;
          g3Scenario = 'unconfirmed';await reload(()=>page.locator('#refresh-chart').click());
          const unconfirmed = await verifyEvidence(timeframe);check(unconfirmed.confirmation,'provisional');check(unconfirmed.summary.status,'waiting-close');
        }
        phase = `G3-${width}-${theme}-late-W-response`;
        g3Scenario = 'closed';
        let release, began;
        const wait = new Promise(resolve=>release=resolve), started = new Promise(resolve=>began=resolve);
        hold = {wait,started:began};
        await page.locator('[data-timeframe="W"]').click();await started;
        g3Scenario = 'provisional';
        const winningData = await reload(()=>page.locator('[data-timeframe="D"]').click());
        await verifyEvidence('D',{},winningData);release();await page.waitForTimeout(100);
        await verifyEvidence('D',{},winningData);
        check(errors,[]);console.log(JSON.stringify({g3Evidence:'PASS',width,theme,checks}));
        await context.close();continue;
      }
      if (baseline) {
        if (evidence) {
          fs.mkdirSync(evidence,{recursive:true}); fs.writeFileSync(path.join(evidence,filename+'.json'),JSON.stringify(await styles(page),null,2));
          await page.locator('.chart-panel').screenshot({path:path.join(evidence,filename+'.png')});
        }
        await context.close(); continue;
      }
      if (evidence) check(await styles(page),JSON.parse(fs.readFileSync(path.join(evidence,'before',filename+'.json'))),'existing visual properties preserved');
      check(await page.locator('[data-timeframe="Auto"]').getAttribute('aria-pressed'),'true');
      check(await page.locator('[data-range]').allTextContents(),['1D','1W','1M','3M','1Y']);
      for (const range of ['1W','1M','3M','1Y']) {
        await page.locator(`[data-range="${range}"]`).click();
        await page.waitForFunction(range=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith(range),range);
        check(requests.at(-1).range,range);
      }
      const quote = await page.locator('#chart-price').textContent();
      const waitLabel = async label => page.waitForFunction(label=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith(label),label);
      for (const timeframe of ['D','W','M']) {
        await page.locator(`[data-timeframe="${timeframe}"]`).click(); await waitLabel(`${timeframe} · 1Y`);
        check(await page.locator('#chart-price').textContent(),quote,'quote does not become aggregated close');
        check(await page.locator(`[data-timeframe="${timeframe}"]`).getAttribute('aria-pressed'),'true');
        check(await page.locator('#auto-range-tabs').isVisible(),false);
        check(requests.at(-1).range,'1Y');
      }
      let previous = 0;
      for (const range of ['1M','3M','6M','1Y','5Y']) {
        await page.locator(`[data-historical-range="${range}"]`).click(); await waitLabel(`M · ${range}`);
        const count = Number(await page.locator('#stock-price-chart').getAttribute('data-source-candles'));
        check(count>=previous,true,'range changes data coverage independently of Monthly'); previous=count;
      }
      check(requests.at(-1).history,'5y');
      check(await page.locator('[data-historical-range]').allTextContents(),['1M','3M','6M','1Y','5Y']);
      const {marketTimeframe} = await import('../client/chart-timeframe.mjs');
      for (const timeframe of ['D','W','M']) {
        await page.locator(`[data-timeframe="${timeframe}"]`).click(); await waitLabel(`${timeframe} · 5Y`);
        const expected = marketTimeframe(lastMarket,timeframe,'5Y');
        const host = page.locator('#stock-price-chart');
        check(Number(await host.getAttribute('data-source-candles')),expected.history.length,'D/W/M use actual selected calendar buckets');
        const initial = await page.locator('.price-candle').count(), calls = requests.length;
        await page.locator('#chart-fit').click();
        await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length===count,expected.history.length);
        const dates = await page.locator('.price-candle title').allTextContents();
        const dateFormat = new Intl.DateTimeFormat('th-TH',{timeZone:'Asia/Bangkok',day:'2-digit',month:'short',year:'2-digit'});
        const valueFormat = new Intl.NumberFormat('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
        const expectedTitles = expected.history.map(row=>dateFormat.format(new Date(row.time))+' · '+
          [['O','open'],['H','high'],['L','low'],['C','close'],['Vol','volume']].map(([label,key])=>label+' '+valueFormat.format(row[key])).join(' · '));
        check(dates,expectedTitles,'Fit All retains each real candle date and OHLCV, not axis-label sampling');
        await page.locator('#chart-zoom-in').click();
        await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length<count,expected.history.length);
        await page.locator('#chart-reset').click();
        await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length===count,initial);
        check(requests.length,calls,'Fit/Zoom/Reset remain local');
        check(requests.at(-1).history,'5y');
      }
      check(providerCalls.some(call=>call.range==='5y'&&call.interval==='1d'),true);
      check(providerCalls.some(call=>call.range==='max'),false,'5Y never fetches max');
      check(await page.locator('.price-chart-svg').evaluate(node=>{
        const {width,height}=node.viewBox.baseVal;
        return [...node.querySelectorAll(`text.chart-axis-text[y="${height-10}"]`)].every(label=>{
          const bounds=label.getBBox();return bounds.x>=-1&&bounds.x+bounds.width<=width+1;
        });
      }),true,'historical dates with years stay inside the chart');
      await page.locator('[data-timeframe="W"]').focus(); await page.keyboard.press('Enter'); await waitLabel('W · 5Y');
      check(await page.locator('[data-historical-range="5Y"]').getAttribute('aria-pressed'),'true');
      await page.locator('#chart-zoom-in').click();
      check(await page.locator('.price-candle').count()>0,true);
      if (evidence) { fs.mkdirSync(path.join(evidence,'after'),{recursive:true}); await page.locator('.chart-panel').screenshot({path:path.join(evidence,'after',filename+'-weekly.png'),style:'.topbar,.sidebar,.side-nav{opacity:0!important}'}); }
      await page.goBack(); await waitLabel('M · 5Y');
      await page.reload(); await page.waitForSelector('.price-candle'); await waitLabel('M · 5Y');
      check(await page.locator('[data-historical-range="5Y"]').getAttribute('aria-pressed'),'true');
      await page.goto(base+'/?symbol=PTT&range=1Y&timeframe=W&historicalRange=ALL#chart');
      await page.waitForSelector('.price-candle'); await waitLabel('W · 5Y');
      check(await page.locator('[data-historical-range="5Y"]').getAttribute('aria-pressed'),'true','legacy ALL URL selects bounded 5Y');
      check(requests.at(-1).history,'5y');
      await page.locator('[data-timeframe="Auto"]').click(); await waitLabel('1Y');
      check(await page.locator('[data-range="1Y"]').getAttribute('aria-pressed'),'true','Auto remembers its independent range');
      if (width===390 && theme==='light') {
        let release, began;
        const wait = new Promise(resolve=>release=resolve), started = new Promise(resolve=>began=resolve);
        hold={wait,started:began};
        await page.locator('[data-timeframe="W"]').click(); await started;
        await page.locator('[data-timeframe="D"]').click(); await waitLabel('D · 5Y');
        const snapshot=await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'); release();
        await page.waitForTimeout(100);
        check(await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'),snapshot,'late response cannot overwrite new timeframe');
      }
      for (const symbol of ['SCB','TISCO']) {
        historicalQuality = 'rejected';
        await page.goto(base+`/?symbol=${symbol}&range=1Y&timeframe=D&historicalRange=5Y#chart`);
        await page.waitForSelector('.price-candle');
        for (const timeframe of ['D','W','M']) {
          await page.locator(`[data-timeframe="${timeframe}"]`).click(); await waitLabel(`${timeframe} · 5Y`);
          await page.waitForFunction(()=>document.querySelector('.analysis-panel')?.dataset.signalStatus==='ready');
          check(await page.locator('.analysis-panel').getAttribute('data-signal-status'),'ready',`${symbol} ${timeframe} excludes rejected rows from the quality block`);
          check(await page.locator('#overall-signal').textContent() === 'ข้อมูลต้องตรวจสอบ',false);
          check(Number(await page.locator('#stock-price-chart').getAttribute('data-source-candles')),
            marketTimeframe(lastMarket,timeframe,'5Y').history.length,'guarded chart candles remain visible');
        }
        historicalQuality = 'retained'; await page.reload();
        for (const timeframe of ['M','W','D']) {
          await page.locator(`[data-timeframe="${timeframe}"]`).click(); await waitLabel(`${timeframe} · 5Y`);
          await page.waitForFunction(()=>document.querySelector('.analysis-panel')?.dataset.signalStatus==='data-review');
          check(await page.locator('.analysis-panel').getAttribute('data-signal-status'),'data-review',`${symbol} ${timeframe} retained anomaly stays blocked`);
          check(await page.locator('.price-candle').count()>0,true,'quality review does not blank the chart');
        }
      }
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal page overflow');
      check(await page.locator('#timeframe-label').textContent(),'Timeframe — ระยะเวลาต่อแท่ง');
      check(await page.locator('#historical-range-label').textContent(),'Historical Range — ระยะเวลาข้อมูลย้อนหลัง');
      check(errors,[]);
      if (evidence) { fs.mkdirSync(path.join(evidence,'after'),{recursive:true}); await page.locator('.chart-panel').screenshot({path:path.join(evidence,'after',filename+'.png'),style:'.topbar,.sidebar,.side-nav{opacity:0!important}'}); }
      console.log(JSON.stringify({width,theme,status:'PASS',checks}));
      await context.close();
    }
    console.log(JSON.stringify({chartTimeframeBrowser:'PASS',g3Only,baseline,checks,liveProviderRequests:0}));
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(JSON.stringify({chartTimeframeBrowser:'FAIL',phase,message:error.message,stack:error.stack}));process.exitCode=1;});
