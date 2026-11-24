'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
process.env.SETSCOPE_PLAYWRIGHT_MODULE ||= require.resolve('playwright');
// Reuse original authentication/news browser fixtures; never contact Supabase.
const {mockRequest,seedPage}=require('../../test/account-isolation.browser.cjs');
process.env.SUPABASE_URL='https://isolation-test.supabase.co';
process.env.SUPABASE_ANON_KEY='public-browser-fixture';
process.env.SUPABASE_SECRET_KEY='';
const {createRuntimeServer:createServer}=require('../runtime.cjs');
const {loadCatalog}=require('../fixtures/coverage.cjs');
const {createFixtureAuth}=require('../fixtures/auth.cjs');
const {Lane}=require('../service.cjs');
const {createReader}=require('../reader.cjs');
const f=require('../fixtures/news.cjs');
const shots=path.resolve(__dirname,'../evidence/final/screenshots');fs.mkdirSync(shots,{recursive:true});
for(const [name,viewport]of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test(`${name}: actual legacy news + offline impact UI`,async t=>{
  const auth=createFixtureAuth();let time=0,impactRequests=0,refreshRequests=0,release,holdNext=false;
  const provider=f.mockProvider();const server=createServer({entryModule:'production.mjs',loadCatalog,auth,reader:createReader({loadHtml:async()=>({status:200,html:f.html})}),lane:new Lane({now:()=>time,wait:async ms=>{time+=ms;}}),provider:{async generate(args){if(holdNext){holdNext=false;await new Promise(r=>release=r);}return provider.generate(args);}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':undefined)});
  t.after(async()=>{release?.();await browser.close();await new Promise(r=>server.close(r));});
  const context=await browser.newContext({viewport,serviceWorkers:'block'});const state={putOwners:[],getOwners:[]};
  const denied=[];
  const articles=[{id:'legacy-settrade',title:'PTT ข่าวเดิมจาก SETTRADE',url:'https://www.settrade.com/th/news-and-articles/news/999900',source:'settrade',source_name:'SETTRADE',snippet:'ข้อความข่าวเดิมสำหรับตรวจ Regression',published_at:new Date().toISOString(),matched_symbols:['PTT'],analysis_mode:'unavailable'},{id:'legacy-infoquest',title:'AOT ข่าวเดิมจาก InfoQuest',url:'https://www.infoquest.co.th/2026/999900',source:'infoquest',source_name:'InfoQuest',snippet:'ข้อความข่าวเดิมสำหรับตรวจ Regression',published_at:new Date().toISOString(),matched_symbols:['AOT'],analysis_mode:'unavailable'}];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    const json=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
    if(url.origin==='https://isolation-test.supabase.co'&&url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='refresh_token'){refreshRequests++;return json({access_token:'token-a-refreshed',refresh_token:'fixture-refreshed',expires_in:3600,user:{id:'user-a',email:'a@example.test'}});}
    if(url.origin===base&&url.pathname==='/api/news-impact-phase1'){impactRequests++;return route.continue();}
    if(url.origin===base&&url.pathname==='/api/news-archive'){
      const source=url.searchParams.get('source')||'all',query=url.searchParams.get('query')||'';
      const items=articles.filter(x=>(source==='all'||x.source===source)&&x.title.toLowerCase().includes(query.toLowerCase()));
      return json({configured:true,items,featured:[],total:items.length,page:1,pageSize:10,maxAgeDays:365,dataState:'fresh',sourceCounts:{all:2,settrade:1,infoquest:1}});
    }
    if(url.origin===base&&url.pathname==='/api/news-analysis')return json({items:[],mode:'unavailable',aiConfigured:false});
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co'){denied.push(url.origin);return route.abort();}
    return mockRequest(route,base,state);
  });
  const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});await page.waitForSelector('body.authenticated');
  await page.waitForSelector('#news-impact-tab');
  const shot=async label=>{
    if(name==='mobile'&&label==='success'){
      await page.screenshot({path:path.join(shots,'mobile-success-full.png'),fullPage:true});
      await page.locator('#impact-result').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(shots,'mobile-success.png'),fullPage:false});
      await page.evaluate(()=>scrollTo(0,0));
    }else await page.screenshot({path:path.join(shots,`${name}-${label}.png`),fullPage:true});
  };
  await t.test('no new impact requests or provider calls on page load/tab selection',async()=>{assert.equal(impactRequests,0);assert.equal(provider.calls,0);await page.click('#news-impact-tab');assert.equal(impactRequests,0);assert.equal(await page.locator('#impact-quota').count(),0);await shot('empty');});
  await t.test('URL click shows only silent loading; disabled duplicate submit; success with evidence',async()=>{
    await page.fill('#impact-input','https://news.example.org/article');holdNext=true;await page.click('#impact-submit');
    await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='กำลังวิเคราะห์ข่าว...');
    assert.equal(await page.locator('#impact-submit').isDisabled(),true);assert.doesNotMatch(await page.locator('#news-impact-view').textContent(),/ลำดับคิว|เวลารอ/);await shot('loading');
    // Wait for the controlled provider gate; no arbitrary sleep used as race proof.
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);release();release=null;
    await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');
    assert.match(await page.locator('.impact-group.positive').textContent(),/PTT/);assert.match(await page.locator('.impact-group.negative').textContent(),/AOT/);assert.equal(await page.locator('#impact-quota').count(),0);assert.equal(impactRequests,1);await shot('success');
  });
  await t.test('explicit subsequent click analyzes again; no completed cache; pasted text flow',async()=>{
    await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');assert.equal(provider.calls,2);
    await page.check('input[name=mode][value=text]');await page.fill('#impact-input',f.text);await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');assert.equal(provider.calls,3);
  });
  await t.test('existing auth 401 refresh occurs before admission; only one provider call',async()=>{
    const calls=provider.calls,requests=impactRequests;auth.fixture.denyNext=true;
    await page.fill('#impact-input',f.text+' refresh-check');await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');
    assert.equal(impactRequests-requests,2);assert.equal(provider.calls-calls,1);assert.equal(refreshRequests,1);
  });
  await t.test('no match state without invented stock',async()=>{await page.fill('#impact-input',f.noMatch);await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='ไม่พบหุ้นไทยที่ยืนยันความเกี่ยวข้องได้');assert.equal(await page.locator('.impact-group strong').count(),0);await shot('no-match');});
  await t.test('error safe message; no retry dispatch',async()=>{const calls=provider.calls;await page.fill('#impact-input',f.text+' [invalid]');await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent.includes('ผลวิเคราะห์ไม่ถูกต้อง'));assert.equal(provider.calls,calls+1);assert.equal(await page.locator('#impact-submit').isDisabled(),false);await shot('error');});
  await t.test('Phase 1 has no quota UI and allows more than five successful analyses',async()=>{
    for(let i=0;i<6;i++){await page.fill('#impact-input',f.text+' success-'+i);await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');}
    assert.equal(await page.locator('#impact-quota').count(),0);assert.doesNotMatch(await page.locator('#news-impact-view').textContent(),/สิทธิ์คงเหลือ|5[/]5|วันรีเซ็ต/);await shot('quota-off');
  });
  await t.test('responsive layout without horizontal overflow or forbidden impact fields',async()=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.doesNotMatch(await page.locator('#news-impact-view').textContent(),/RSI|Impact Score|% เปลี่ยนแปลง/);const rect=await page.locator('#impact-submit').boundingBox();assert.ok(rect.width>=140);});
  await t.test('legacy source filter/search remain functional across view switches',async()=>{
    await page.click('#news-explore-tab');await page.waitForSelector('#news-list .news-item');
    const settled=()=>document.querySelector('#news-list').getAttribute('aria-busy')==='false'&&!document.querySelector('#refresh-news').disabled;
    await page.waitForFunction(settled);
    await page.click('#news-sources [data-source=infoquest]');
    await page.waitForFunction(()=>document.querySelector('#news-list').getAttribute('aria-busy')==='false'&&!document.querySelector('#refresh-news').disabled&&document.querySelectorAll('#news-list .news-title-link').length===1&&document.querySelector('#news-list .news-title-link').textContent.includes('AOT'));
    assert.match(await page.locator('#news-list').textContent(),/AOT/);assert.doesNotMatch(await page.locator('#news-list').textContent(),/PTT/);
    assert.equal(await page.locator('#news-count').isVisible(),false);
    await page.fill('#news-search','ไม่พบ');
    const empty=()=>document.querySelector('#news-list').getAttribute('aria-busy')==='false'&&!document.querySelector('#refresh-news').disabled&&document.querySelectorAll('#news-list .news-title-link').length===0&&document.querySelector('#news-list [data-empty-message]')?.dataset.emptyMessage==='ไม่พบข่าวที่ตรงกับคำค้นนี้';
    await page.waitForFunction(empty);assert.equal(await page.locator('#news-count').isVisible(),false);
    await page.click('#news-impact-tab');await page.click('#news-explore-tab');await page.waitForFunction(empty);
    assert.equal(await page.locator('#news-search').inputValue(),'ไม่พบ');assert.equal(await page.locator('#news-sources [data-source=infoquest]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#news-count').isVisible(),false);await shot('legacy-filters');
  });
  await t.test('session boundary clears input/result/quota; stale response cannot repaint',async()=>{
    await page.click('#news-impact-tab');await page.fill('#impact-input',f.text+' stale-response');holdNext=true;
    await page.click('#impact-submit');for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('setscope:session-boundary')));
    const previous=provider.calls;release();release=null;
    for(let i=0;i<100&&provider.calls===previous;i++)await new Promise(r=>setTimeout(r,10));assert.equal(provider.calls,previous+1);
    assert.equal(await page.locator('#impact-input').inputValue(),'');assert.equal(await page.locator('#impact-result').textContent(),'');assert.equal(await page.locator('#impact-quota').count(),0);
  });
  fs.writeFileSync(path.join(__dirname,`../evidence/final/browser-${name}.json`),JSON.stringify({viewport,impactRequests,mockProviderCalls:provider.calls,externalRequestsSent:0,blockedOrigins:[...new Set(denied)],fixtureClock:true,productionAuthIntegrated:false,existingClientAndServerAuthReused:true,refreshRequests},null,2));
});
