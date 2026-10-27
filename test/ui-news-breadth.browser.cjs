'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
(async()=>{
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 const breadth=['SET','mai'].map(market=>({market,items:[{label:'Gainers',count:1234,volumeThousand:123456789.12},{label:'Unchanges',count:56,volumeThousand:98765.43},{label:'Losers',count:789,volumeThousand:1234.5}]}));
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['tablet',{width:1024,height:900}],['mobile',{width:390,height:844}],['narrow',{width:320,height:800}]]){
   for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false,mode:'partial'};
    await context.route('**/*',async route=>{
     const request=route.request(),url=new URL(request.url()),json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
     if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
     if(url.origin===base&&['/api/market-overview','/api/settrade-overview'].includes(url.pathname))return json({indices:[],breadth,tfex:{},nvdr:{},foreign:{},activeValue:[],dataState:'fresh',fetchedAt:new Date().toISOString()});
     if(url.origin===base&&url.pathname==='/api/watchlist-news')return json({items:state.mode==='unavailable'?[]:Array.from({length:12},(_,i)=>({title:'PTT fixture news '+i,url:'https://www.kaohoon.com/news/ui-'+i,pubDate:new Date().toISOString(),source:'kaohoon',matchedSymbols:['PTT'],verification:{status:'VERIFIED'}})),dataState:state.mode,partial:true,limited:true,matchedCandidates:12,qualityExcluded:1,stockStatus:Array.from({length:4},()=>({dataState:'unavailable',reason:'REQUEST_BUDGET'}))});
     return mockRequest(route,base,state);
    });
    const page=await context.newPage();await seedPage(page,'token-a');await page.addInitScript(value=>localStorage.setItem('setscope-theme',value),theme);
    await page.goto(base+'/#overview',{waitUntil:'domcontentloaded'});await page.waitForSelector('body.authenticated');await page.waitForSelector('.market-breadth-group tbody tr');
    assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
    for(const table of await page.locator('.market-breadth-group').all()){
     assert.deepEqual(await table.locator('thead th').allTextContents(),['สถานะ','จำนวนหุ้น',"ปริมาณซื้อขาย ('000)"]);
     const values=await table.locator('tbody tr').evaluateAll(rows=>rows.map(row=>[...row.cells].map(cell=>cell.textContent)));
     assert.deepEqual(values,[['ปรับขึ้น','1,234.00','123,456,789.12'],['ไม่เปลี่ยนแปลง','56.00','98,765.43'],['ปรับลง','789.00','1,234.50']]);
     assert.doesNotMatch(await table.locator('tbody').textContent(),/ปริมาณซื้อขาย|'000| หุ้น/);
     const layout=await table.evaluate(table=>({overflow:table.scrollWidth>table.clientWidth+1,rows:[...table.querySelectorAll('tbody tr')].map(row=>[...row.cells].map(cell=>({right:cell.getBoundingClientRect().right,align:getComputedStyle(cell).textAlign,numbers:getComputedStyle(cell).fontVariantNumeric})))}));
     assert.equal(layout.overflow,false);
     for(const row of layout.rows)for(const column of [1,2]){assert.equal(row[column].align,'right');assert.match(row[column].numbers,/tabular-nums/);assert.ok(Math.abs(row[column].right-layout.rows[0][column].right)<1);}
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no viewport overflow');
    if(process.env.SETSCOPE_UI_SCREENSHOT_DIR)await page.locator('#market-breadth-list').screenshot({path:path.join(process.env.SETSCOPE_UI_SCREENSHOT_DIR,'breadth-'+label+'-'+theme+'.png')});
    await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='partial');
    const news=page.locator('#watchlist-news-list');assert.equal(await news.locator('.news-item').count(),10);assert.equal(await news.locator(':scope > [role="status"]').count(),0);
    assert.doesNotMatch(await news.textContent(),/ยังอัปเดตไม่ครบ|แสดงเฉพาะข่าว|ขีดจำกัด|กำลังอัปเดตข่าว/);
    assert.match(await page.locator('#watchlist-page').textContent(),/WATCHLIST NEWS/);assert.match(await page.locator('#watchlist-page').textContent(),/ข่าวของหุ้นที่ติดตาม/);
    await page.locator('#watchlist-news-pager').getByRole('button',{name:'ถัดไป',exact:true}).click();assert.equal(await news.locator('.news-item').count(),2);
    state.mode='unavailable';await page.locator('#watchlist-select'+(label==='mobile'||label==='narrow'?'-mobile':'')).selectOption('list-1');
    // A fresh synthetic session has no LKG, so the explicit unavailable empty view can be checked.
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('body.authenticated');await page.locator('.nav-item[data-workspace-route="watchlist"]').click();
    await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='unavailable');
    assert.equal((await news.textContent()).trim(),'ยังไม่สามารถตรวจสอบข่าวของหุ้นในรายการติดตามได้');
    if(process.env.SETSCOPE_UI_SCREENSHOT_DIR)await page.locator('.watchlist-news-panel').screenshot({path:path.join(process.env.SETSCOPE_UI_SCREENSHOT_DIR,'empty-'+label+'-'+theme+'.png')});
    console.log(JSON.stringify({viewport:label,theme,breadthNumbersAndAlignment:'PASS',noOverflow:'PASS',watchlistNoBanner:'PASS',exactEmptyMessage:'PASS',pagination:'PASS'}));
    await context.close();
   }
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
