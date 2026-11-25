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
const evidence=path.resolve(process.env.SETSCOPE_IMPACT_UI_EVIDENCE||path.join(__dirname,'../evidence/final'));
const shots=path.join(evidence,'screenshots');fs.mkdirSync(shots,{recursive:true});
for(const [name,viewport,theme]of [['desktop',{width:1366,height:900},'light'],['mobile',{width:390,height:844},'dark'],['desktop-dark',{width:1366,height:900},'dark'],['mobile-light',{width:390,height:844},'light']])test(`${name}: actual legacy news + offline impact UI`,async t=>{
  const auth=createFixtureAuth();let time=0,impactRequests=0,refreshRequests=0,release,holdNext=false,summaryExtras=0,fonts,colours,formLayout;
  const provider=f.mockProvider();const server=createServer({entryModule:'production.mjs',loadCatalog,auth,reader:createReader({loadHtml:async()=>({status:200,html:f.html})}),lane:new Lane({now:()=>time,wait:async ms=>{time+=ms;}}),provider:{async generate(args){if(holdNext){holdNext=false;await new Promise(r=>release=r);}const raw=await provider.generate(args);if(!summaryExtras)return raw;const value=JSON.parse(raw);value.summary.push(...['บริษัทระบุว่าสามารถส่งมอบได้จากกำลังการผลิตที่มีอยู่','หน่วยงานกำลังจัดแผนฟื้นฟูการให้บริการตามปกติ'].slice(0,summaryExtras));return JSON.stringify(value);}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':undefined)});
  t.after(async()=>{release?.();await browser.close();await new Promise(r=>server.close(r));});
  const context=await browser.newContext({viewport,serviceWorkers:'block'});const state={putOwners:[],getOwners:[]};
  const denied=[],payloads=[];
  const articles=[{id:'legacy-settrade',title:'PTT ข่าวเดิมจาก SETTRADE',url:'https://www.settrade.com/th/news-and-articles/news/999900',source:'settrade',source_name:'SETTRADE',snippet:'ข้อความข่าวเดิมสำหรับตรวจ Regression',published_at:new Date().toISOString(),matched_symbols:['PTT'],analysis_mode:'unavailable'},{id:'legacy-infoquest',title:'AOT ข่าวเดิมจาก InfoQuest',url:'https://www.infoquest.co.th/2026/999900',source:'infoquest',source_name:'InfoQuest',snippet:'ข้อความข่าวเดิมสำหรับตรวจ Regression',published_at:new Date().toISOString(),matched_symbols:['AOT'],analysis_mode:'unavailable'}];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    const json=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
    if(url.origin==='https://isolation-test.supabase.co'&&url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='refresh_token'){refreshRequests++;return json({access_token:'token-a-refreshed',refresh_token:'fixture-refreshed',expires_in:3600,user:{id:'user-a',email:'a@example.test'}});}
    if(url.origin===base&&url.pathname==='/api/news-impact-phase1'){impactRequests++;payloads.push(request.postDataJSON());return route.continue();}
    if(url.origin===base&&url.pathname==='/api/news-archive'){
      const source=url.searchParams.get('source')||'all',query=url.searchParams.get('query')||'';
      const items=articles.filter(x=>(source==='all'||x.source===source)&&x.title.toLowerCase().includes(query.toLowerCase()));
      return json({configured:true,items,featured:[],total:items.length,page:1,pageSize:10,maxAgeDays:365,dataState:'fresh',sourceCounts:{all:2,settrade:1,infoquest:1}});
    }
    if(url.origin===base&&url.pathname==='/api/news-analysis')return json({items:[],mode:'unavailable',aiConfigured:false});
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co'){denied.push(url.origin);return route.abort();}
    return mockRequest(route,base,state);
  });
  const page=await context.newPage(),results=[],responseReads=[];
  const collectResult=r=>{if(new URL(r.url()).pathname==='/api/news-impact-phase1')responseReads.push(r.json().then(body=>{if(body.result)results.push(body.result);}));};
  page.on('response',collectResult);
  await seedPage(page,'token-a');await page.addInitScript(value=>localStorage.setItem('setscope-theme',value),theme);await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});await page.waitForSelector('body.authenticated');
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
  await t.test('both inputs are visible, mutually exclusive and never submit while typing',async()=>{
    assert.equal(await page.locator('#impact-form input[type=radio]').count(),0);assert.ok(await page.locator('#impact-url').isVisible());assert.ok(await page.locator('#impact-input').isVisible());
    formLayout=await page.evaluate(()=>Object.fromEntries(['impact-form','impact-url','impact-submit','impact-input'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,bottom:r.bottom}];})));
    const u=formLayout['impact-url'],b=formLayout['impact-submit'],text=formLayout['impact-input'],form=formLayout['impact-form'];
    if(viewport.width>600){assert.ok(Math.abs(u.y-b.y)<1&&Math.abs(u.bottom-b.bottom)<1);assert.ok(b.x>=u.x+u.width);}
    else{assert.ok(b.y>=u.bottom);assert.ok(Math.abs(u.width-form.width)<1&&Math.abs(b.width-form.width)<1);}
    assert.ok(text.y>=Math.max(u.bottom,b.bottom));assert.ok(Math.abs(text.width-form.width)<1);
    await page.click('#impact-submit');assert.equal(impactRequests,0,'empty form keeps native required validation');
    await page.fill('#impact-url','https://news.example.org/first');assert.equal(await page.locator('#impact-input').inputValue(),'');
    await page.fill('#impact-input',f.text);assert.equal(await page.locator('#impact-url').inputValue(),'');
    await page.fill('#impact-url','https://news.example.org/second');assert.equal(await page.locator('#impact-input').inputValue(),'');
    await page.fill('#impact-url','');assert.equal(await page.locator('#impact-form').evaluate(e=>e.checkValidity()),false);assert.equal(impactRequests,0);assert.equal(provider.calls,0);await shot('form-empty');
  });
  await t.test('URL click shows only silent loading; disabled duplicate submit; success with evidence',async()=>{
    await page.fill('#impact-url','https://news.example.org/article');holdNext=true;await page.click('#impact-submit');
    await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='กำลังวิเคราะห์ข่าว...');
    assert.equal(await page.locator('#impact-submit').isDisabled(),true);assert.equal(await page.locator('#impact-url').isDisabled(),true);assert.equal(await page.locator('#impact-input').isDisabled(),true);assert.doesNotMatch(await page.locator('#news-impact-view').textContent(),/ลำดับคิว|เวลารอ/);await shot('loading');
    // Wait for the controlled provider gate; no arbitrary sleep used as race proof.
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);release();release=null;
    await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');
    assert.match(await page.locator('.impact-group.positive').textContent(),/PTT/);assert.match(await page.locator('.impact-group.negative').textContent(),/AOT/);assert.equal(await page.locator('#impact-quota').count(),0);assert.equal(impactRequests,1);await shot('success');
    assert.deepEqual(Object.keys(payloads[0]).sort(),['mode','requestKey','value']);assert.equal(payloads[0].mode,'url');assert.equal(payloads[0].value,'https://news.example.org/article');assert.match(payloads[0].requestKey,/^[A-Za-z0-9_-]{1,128}$/);
    fonts=await page.evaluate(()=>Object.fromEntries(Object.entries({summary:'#impact-result li',heading:'#impact-result h3',stock:'.impact-group strong',reason:'.impact-group article p',evidence:'.impact-group blockquote',input:'#impact-input',status:'#impact-status',disclaimer:'.impact-preview'}).map(([key,selector])=>{const s=getComputedStyle(document.querySelector(selector));return[key,{fontSize:s.fontSize,fontFamily:s.fontFamily,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color}];})));
  });
  await t.test('explicit subsequent click analyzes again; no completed cache; pasted text flow',async()=>{
    await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');assert.equal(provider.calls,2);
    assert.equal(payloads.at(-1).mode,'url');assert.notEqual(payloads[0].requestKey,payloads[1].requestKey);
    await page.fill('#impact-input','  '+f.text+'  ');assert.equal(await page.locator('#impact-url').inputValue(),'');await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');assert.equal(provider.calls,3);assert.equal(payloads.at(-1).mode,'text');assert.equal(payloads.at(-1).value,f.text);
  });
  await t.test('Impact colours reuse the existing theme and keep text and placeholders legible',async()=>{
    colours=await page.evaluate(()=>{const theme=getComputedStyle(document.documentElement),style=s=>getComputedStyle(document.querySelector(s));const input=style('#impact-input'),hint=getComputedStyle(document.querySelector('#impact-input'),'::placeholder');return{variables:Object.fromEntries(['ink','muted','paper','bg','line'].map(key=>[key,theme.getPropertyValue('--'+key).trim()])),input:{text:input.color,background:input.backgroundColor,border:input.borderTopColor},placeholder:{text:hint.color,opacity:Number(hint.opacity)},disclaimer:{text:style('.impact-preview').color,background:style('.impact-preview').backgroundColor},borders:[...document.querySelectorAll('#impact-result > section')].map(n=>getComputedStyle(n).borderTopColor),evidence:{text:style('.impact-group blockquote').color,border:style('.impact-group blockquote').borderLeftColor},stock:style('.impact-group strong').color};});
    const rgb=hex=>(hex.length===4?hex.slice(1).split('').map(x=>x+x).join(''):hex.slice(1)).match(/../g).map(x=>parseInt(x,16)),css=hex=>'rgb('+rgb(hex).join(', ')+')';
    const luminance=values=>values.map(x=>{const n=x/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
    const ratio=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05),v=colours.variables;
    assert.equal(colours.input.background,css(v.paper));assert.equal(colours.input.text,css(v.ink));assert.equal(colours.input.border,css(v.line));assert.equal(colours.disclaimer.background,css(v.bg));assert.equal(colours.disclaimer.text,css(v.muted));assert.equal(colours.stock,css(v.ink));assert.ok(colours.borders.every(x=>x===css(v.line)));assert.equal(colours.evidence.border,css(v.line));assert.equal(colours.evidence.text,css(v.muted));assert.equal(colours.placeholder.text,css(v.ink));
    const background=rgb(v.paper),placeholder=rgb(v.ink).map((x,i)=>x*colours.placeholder.opacity+background[i]*(1-colours.placeholder.opacity));
    colours.contrast={input:ratio(rgb(v.ink),background),placeholder:ratio(placeholder,background),disclaimer:ratio(rgb(v.muted),rgb(v.bg))};assert.ok(colours.contrast.input>=4.5);assert.ok(colours.contrast.placeholder>=4.5);if(theme==='dark')assert.ok(colours.contrast.disclaimer>=4.5);
    colours.url=await page.locator('#impact-url').evaluate(el=>{const s=getComputedStyle(el),p=getComputedStyle(el,'::placeholder');return{fontSize:s.fontSize,text:s.color,background:s.backgroundColor,border:s.borderTopColor,placeholder:p.color,placeholderOpacity:Number(p.opacity)};});assert.equal(colours.url.fontSize,fonts.input.fontSize);assert.equal(colours.url.text,colours.input.text);assert.equal(colours.url.background,colours.input.background);assert.equal(colours.url.border,colours.input.border);assert.equal(colours.url.placeholder,colours.placeholder.text);assert.equal(colours.url.placeholderOpacity,colours.placeholder.opacity);
  });
  await t.test('three result cards preserve every summary, stock, reason and evidence at 2-4 bullets',async()=>{
    const checkResult=async count=>{
      await Promise.all(responseReads);const result=results.at(-1);assert.equal(result.summary.length,count);
      assert.equal(await page.locator('#impact-result > .impact-group').count(),3);
      assert.deepEqual(await page.locator('#impact-result > section').evaluateAll(nodes=>nodes.map(n=>n.className)),['impact-group impact-summary','impact-group positive','impact-group negative']);
      assert.deepEqual(await page.locator('.impact-summary li').allTextContents(),result.summary);
      for(const key of ['positive','negative']){
        assert.deepEqual(await page.locator('.impact-group.'+key+' article').evaluateAll(nodes=>nodes.map(n=>({name:n.querySelector('strong').textContent,reason:n.querySelector('p').textContent,evidence:n.querySelector('blockquote').textContent}))),result[key].map(s=>({name:s.name===s.symbol?s.symbol:s.symbol+' · '+s.name,reason:s.reason,evidence:s.evidence})));
      }
      const boxes=await page.locator('#impact-result > section').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,bottom:r.bottom};}));
      if(viewport.width>600){const total=boxes.reduce((sum,b)=>sum+b.width,0);for(const [i,ratio]of [0.4,0.3,0.3].entries())assert.ok(Math.abs(boxes[i].width/total-ratio)<0.005);assert.ok(boxes.every(b=>Math.abs(b.y-boxes[0].y)<1));}
      else{assert.ok(boxes.every(b=>Math.abs(b.x-boxes[0].x)<1));assert.ok(boxes[1].y>=boxes[0].bottom&&boxes[2].y>=boxes[1].bottom);}
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.doesNotMatch(await page.locator('#impact-result').textContent(),/กลุ่มอุตสาหกรรม|ประเด็นที่ต้องติดตาม|Weekly Quota/);assert.equal(await page.locator('#impact-quota').count(),0);
    };
    try{await checkResult(2);for(const count of [3,4]){summaryExtras=count-2;const calls=provider.calls,requests=impactRequests;await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');assert.equal(provider.calls,calls+1);assert.equal(impactRequests,requests+1);await checkResult(count);}
      await shot('result-layout');
      if(viewport.width<=600){await page.locator('#impact-result').evaluate(el=>scrollTo({top:el.getBoundingClientRect().top+scrollY-60,behavior:'instant'}));await page.screenshot({path:path.join(shots,name+'-result-cards.png')});}
      else await page.locator('#impact-result').screenshot({path:path.join(shots,name+'-result-cards.png')});
    }finally{summaryExtras=0;}
  });
  page.off('response',collectResult);
  await t.test('existing text and URL validation receive the unchanged inferred-mode payload',async()=>{
    const calls=provider.calls,requests=impactRequests;
    await page.fill('#impact-input','สั้น');await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='กรุณากรอกข้อความข่าวอย่างน้อย 60 ตัวอักษร');assert.equal(payloads.at(-1).mode,'text');assert.equal(payloads.at(-1).value,'สั้น');
    await page.fill('#impact-url','  not-a-url  ');assert.equal(await page.locator('#impact-input').inputValue(),'');await page.click('#impact-submit');await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='URL ข่าวไม่ถูกต้อง');assert.equal(payloads.at(-1).mode,'url');assert.equal(payloads.at(-1).value,'not-a-url');assert.equal(provider.calls,calls);assert.equal(impactRequests,requests+2);
    await page.fill('#impact-input',f.text);
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
    assert.equal(await page.locator('#impact-input').inputValue(),'');assert.equal(await page.locator('#impact-url').inputValue(),'');assert.equal(await page.locator('#impact-result').textContent(),'');assert.equal(await page.locator('#impact-quota').count(),0);assert.equal(await page.locator('#impact-input').isDisabled(),false);assert.equal(await page.locator('#impact-url').isDisabled(),false);
    const requests=impactRequests;await page.fill('#impact-url','https://news.example.org/private-input');await page.evaluate(()=>window.dispatchEvent(new CustomEvent('setscope:session-boundary')));assert.equal(await page.locator('#impact-url').inputValue(),'');assert.equal(await page.locator('#impact-input').inputValue(),'');assert.equal(impactRequests,requests);assert.equal(await page.locator('#impact-url').evaluate(e=>e.required),true);assert.equal(await page.locator('#impact-input').evaluate(e=>e.required),false);
  });
  await Promise.all(responseReads);
  fs.writeFileSync(path.join(evidence,`browser-${name}.json`),JSON.stringify({viewport,theme,fonts,colours,formLayout,payloads:payloads.map(p=>({mode:p.mode,value:p.value,keys:Object.keys(p).sort(),hasRequestKey:!!p.requestKey})),impactRequests,mockProviderCalls:provider.calls,externalRequestsSent:0,blockedOrigins:[...new Set(denied)],fixtureClock:true,productionAuthIntegrated:false,existingClientAndServerAuthReused:true,refreshRequests},null,2));
});
