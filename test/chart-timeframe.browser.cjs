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
      const standard = responder(providerCalls);
      const service = createMarketService({env:{},now:()=>received,fetchImpl:async input => {
        const url = new URL(input);
        if (url.searchParams.get('range') !== 'max') return standard(input);
        const data = barsBetween(received - 1500 * 86400000, received, '1d');
        return {ok:true,json:async()=>({chart:{result:[payload('PTT.BK','1d',data.rows,data.periods)]}})};
      }});
      let hold = null;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base && url.origin !== 'https://isolation-test.supabase.co') return route.abort();
        if (url.origin === base && url.pathname === '/api/market') {
          const range = url.searchParams.get('range'), symbol = url.searchParams.get('symbol') || 'PTT';
          requests.push({range,history:url.searchParams.get('history'),symbol});
          const data = await service.getMarket([symbol],symbol,range,{allDailyHistory:url.searchParams.get('history')==='all'});
          if (hold) { const pending=hold; hold=null; pending.started(); await pending.wait; }
          return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
        }
        return mockRequest(route,base,state);
      });
      const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
      await seedPage(page,'token-a'); await page.addInitScript(theme=>localStorage.setItem('setscope-theme',theme),theme);
      await page.goto(base+'/?symbol=PTT&range=1D#chart');
      await page.waitForSelector('.price-candle'); await page.waitForSelector('.compact-reasons',{state:'attached'});
      const filename = `${width}-${theme}`;
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
      for (const range of ['1M','3M','6M','1Y','ALL']) {
        await page.locator(`[data-historical-range="${range}"]`).click(); await waitLabel(`M · ${range}`);
        const count = Number(await page.locator('#stock-price-chart').getAttribute('data-source-candles'));
        check(count>=previous,true,'range changes data coverage independently of Monthly'); previous=count;
      }
      check(requests.at(-1).history,'all');
      check(await page.locator('.price-chart-svg').evaluate(node=>{
        const {width,height}=node.viewBox.baseVal;
        return [...node.querySelectorAll(`text.chart-axis-text[y="${height-10}"]`)].every(label=>{
          const bounds=label.getBBox();return bounds.x>=-1&&bounds.x+bounds.width<=width+1;
        });
      }),true,'historical dates with years stay inside the chart');
      await page.locator('[data-timeframe="W"]').focus(); await page.keyboard.press('Enter'); await waitLabel('W · ALL');
      check(await page.locator('[data-historical-range="ALL"]').getAttribute('aria-pressed'),'true');
      await page.locator('#chart-zoom-in').click();
      check(await page.locator('.price-candle').count()>0,true);
      if (evidence) { fs.mkdirSync(path.join(evidence,'after'),{recursive:true}); await page.locator('.chart-panel').screenshot({path:path.join(evidence,'after',filename+'-weekly.png'),style:'.topbar,.sidebar,.side-nav{opacity:0!important}'}); }
      await page.goBack(); await waitLabel('M · ALL');
      await page.reload(); await page.waitForSelector('.price-candle'); await waitLabel('M · ALL');
      check(await page.locator('[data-historical-range="ALL"]').getAttribute('aria-pressed'),'true');
      await page.locator('[data-timeframe="Auto"]').click(); await waitLabel('1Y');
      check(await page.locator('[data-range="1Y"]').getAttribute('aria-pressed'),'true','Auto remembers its independent range');
      if (width===390 && theme==='light') {
        let release, began;
        const wait = new Promise(resolve=>release=resolve), started = new Promise(resolve=>began=resolve);
        hold={wait,started:began};
        await page.locator('[data-timeframe="W"]').click(); await started;
        await page.locator('[data-timeframe="D"]').click(); await waitLabel('D · ALL');
        const snapshot=await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'); release();
        await page.waitForTimeout(100);
        check(await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'),snapshot,'late response cannot overwrite new timeframe');
      }
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal page overflow');
      check(await page.locator('#timeframe-label').textContent(),'Timeframe — ระยะเวลาต่อแท่ง');
      check(await page.locator('#historical-range-label').textContent(),'Historical Range — ระยะเวลาข้อมูลย้อนหลัง');
      check(errors,[]);
      if (evidence) { fs.mkdirSync(path.join(evidence,'after'),{recursive:true}); await page.locator('.chart-panel').screenshot({path:path.join(evidence,'after',filename+'.png'),style:'.topbar,.sidebar,.side-nav{opacity:0!important}'}); }
      console.log(JSON.stringify({width,theme,status:'PASS',checks}));
      await context.close();
    }
    console.log(JSON.stringify({chartTimeframeBrowser:'PASS',baseline,checks,liveProviderRequests:0}));
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(JSON.stringify({chartTimeframeBrowser:'FAIL',phase,message:error.message,stack:error.stack}));process.exitCode=1;});
