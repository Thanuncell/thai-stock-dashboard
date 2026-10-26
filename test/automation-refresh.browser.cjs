'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { backend } = require('./fixtures/controlled-backend.cjs');
const { manualSignature } = require('../server/controlled-coverage');

(async()=>{
  Object.assign(process.env,{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_ANON_KEY:'synthetic-public',
    SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_TRIGGER_TOKEN:'fixture-'.repeat(6)});
  delete process.env.SETSCOPE_V156_KILL;delete process.env.SET_API_KEY;
  const db=backend();globalThis.fetch=db.fetchImpl;
  const {server}=require('../server');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  function trigger(body){
    const timestamp=String(Date.now()),token=process.env.SETSCOPE_V156_TRIGGER_TOKEN;
    return new Promise((resolve,reject)=>{
      const req=http.request(base+'/api/automation/manual',{method:'POST',headers:{authorization:'Bearer '+token,
        'content-type':'application/json','x-setscope-sent-at':timestamp,'x-setscope-signature':manualSignature(body,token,timestamp)}},res=>{
        const chunks=[];res.on('data',data=>chunks.push(data));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on('error',reject);req.end(JSON.stringify(body));
    });
  }
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
    for(const [label,viewport,oldPrice,newPrice] of [['desktop',{width:1366,height:900},35,36],['mobile',{width:390,height:844},36,37]]){
      db.advance(Date.now()-60000,oldPrice);
      const row=db.registry.get('PTT');row.status='pending';row.last_checked_at=null;
      const context=await browser.newContext({viewport});
      await context.addInitScript(()=>sessionStorage.setItem('setscope-auth-session-v1',JSON.stringify({access_token:'fixture-user',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000})));
      const json=(route,body)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin==='https://fixture.supabase.co')return json(route,{id:'fixture-user',email:'fixture@example.test'});
        if(url.origin!==base)return route.abort();
        if(['/api/market','/api/auth-config','/api/automation/manual'].includes(url.pathname)||!url.pathname.startsWith('/api/'))return route.continue();
        if(url.pathname==='/api/watchlists')return json(route,{record:{watchlists:[{id:'fixture-list',name:'Fixture',items:[{symbol:'PTT',name:'PTT'}]}],active_watchlist_id:'fixture-list'}});
        if(url.pathname==='/api/coverage')return json(route,{configured:false,dataState:'unavailable'});
        return json(route,{items:[],indices:[],errors:[],fieldStatus:{},sourceStatus:{},dataState:'unavailable',configured:false,total:0,page:1,pageSize:10});
      });
      const page=await context.newPage();
      await page.goto(base+'/#chart',{waitUntil:'domcontentloaded'});
      await page.waitForSelector('body.authenticated');
      await page.waitForFunction(price=>document.querySelector('#chart-price')?.textContent===price.toFixed(2),oldPrice);
      await page.locator('[data-range="3M"]').click();
      await page.waitForSelector('#stock-price-chart svg');
      const oldSvg=await page.locator('#stock-price-chart').innerHTML();
      db.advance(Date.now(),newPrice);
      const job=await trigger({tag:'browser-'+label});assert.equal(job.status,200);assert.equal(job.body.verified,1);
      await page.locator('#refresh-chart').click();
      await page.waitForFunction(price=>document.querySelector('#chart-price')?.textContent===price.toFixed(2),newPrice);
      await page.waitForSelector('#stock-price-chart svg');
      const newSvg=await page.locator('#stock-price-chart').innerHTML();assert.notEqual(newSvg,oldSvg);
      assert.ok(await page.locator('#stock-price-chart .price-candle').count()>0);
      assert.match(await page.locator('#stock-price-chart .price-candle title').last().textContent(),new RegExp('C '+newPrice.toFixed(2).replace('.','\\.')));
      assert.equal(await page.locator('.analysis-panel').evaluate(node=>node.classList.contains('signals-unavailable')),false);
      if(process.env.SETSCOPE_V156_BROWSER_ARTIFACTS)await page.screenshot({path:process.env.SETSCOPE_V156_BROWSER_ARTIFACTS+'/'+label+'-refresh.png',fullPage:true});
      console.log(JSON.stringify({viewport:label,chartPrice:newPrice,renderedChart:'PASS',technicalPanel:'PASS',triggerProviderCalls:job.body.metrics.providerCalls}));
      await context.close();
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
