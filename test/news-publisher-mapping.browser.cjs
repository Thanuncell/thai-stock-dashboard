'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const {createNewsArchiveService}=require('../server/news-archive-service');
const {createNewsLinkReview}=require('../server/news-link-review');

(async()=>{
  const port=await freePort(),base='http://127.0.0.1:'+port;
  const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:'ignore',
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SUPABASE_URL:'https://isolation-test.supabase.co',
      SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SETSCOPE_NEWS_WORK_QUEUE:'off'}});
  let browser;
  try {
    await waitForServer(base+'/healthz');
    browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
    for(const [viewportName,viewport] of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]) {
      const rows=Array.from({length:19},(_,i)=>({id:i+1,fingerprint:'fixture-browser-'+i,title:'PTT รายงานผลประกอบการโครงการ '+i,
        url:i<4?'https://www.settrade.com/th/news-and-articles/news/'+(999900+i):'https://news.google.com/rss/articles/fixture-browser-'+i,
        source:i<4?'settrade':i===18?'infoquest':'other',source_name:i<3?['SET','SETTRADE','SETTRADE.COM'][i]:i===18?'InfoQuest':'SETTRADE.COM',
        snippet:'บริษัทเปิดเผยรายละเอียดผลประกอบการและการลงทุนตามบทความต้นฉบับ',published_at:new Date(Date.now()-60_000-i*1000).toISOString(),
        matched_symbols:['PTT'],broker_firms:[],analysis_mode:'ai',analysis_summary:'Synthetic archive summary'}));
      rows.push({...rows[4],id:20,fingerprint:'fixture-browser-duplicate',url:rows[4].url+'?utm_source=fixture'});
      const original=JSON.stringify(rows);
      const review=createNewsLinkReview({registrySearch:async()=>[{symbol:'PTT',provider_symbol:'PTT.BK',provider:'Yahoo Finance',active:true,status:'verified'}],
        loadArticle:async value=>{
          const row=rows.find(row=>row.url===String(value));assert.ok(row);
          const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:row.url,headline:row.title,
            datePublished:row.published_at,articleBody:row.snippet.repeat(8),about:row.id===4?[]:[{'@type':'Corporation',tickerSymbol:'PTT'}]})+'</script>';
          return {response:new Response(html,{headers:{'content-type':'text/html'}}),target:new URL(row.url)};
        }});
      for(const row of rows.slice(0,4))await review.inspect({title:row.title,url:row.url,source:row.source,sourceName:row.source_name,pubDate:row.published_at});
      let reads=0,archiveCalls=0,lastArchive;
      const archive=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'off'},
        displayProject:item=>review.project(item),fetchImpl:async(_url,init)=>{
          assert.ok(!init?.method||init.method==='GET');reads++;
          return Response.json(rows,{headers:{'content-range':`0-${rows.length-1}/${rows.length}`}});
        }});
      const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[]};
      try {
        await context.route('**/*',async route=>{
          const request=route.request(),url=new URL(request.url());
          const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
          if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
          if(url.origin===base&&url.pathname==='/api/news')return json({items:[],dataState:'fresh'});
          if(url.origin===base&&url.pathname==='/api/news-archive') {
            archiveCalls++;
            lastArchive=await archive.list({source:url.searchParams.get('source')||'all',query:url.searchParams.get('query')||'',
              page:Number(url.searchParams.get('page')||1),pageSize:10,featuredCount:Number(url.searchParams.get('featuredCount')||0),
              excludeUrls:url.searchParams.getAll('exclude')});return json({...lastArchive,dataState:'fresh'});
          }
          if(url.origin===base&&url.pathname==='/api/watchlist-news')return json({items:[],dataState:'fresh'});
          if(url.origin===base&&url.pathname==='/api/news-analysis')return json({items:request.postDataJSON().items.map(()=>({mode:'unavailable',summary:''}))});
          return mockRequest(route,base,state);
        });
        const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});
        const counter=page.locator('#news-count');
        const ready=()=>page.waitForFunction(()=>document.body.classList.contains('authenticated')&&document.querySelector('#news-list')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#refresh-news').disabled);
        await ready();assert.equal(lastArchive.matchingTotal,19);assert.equal(await counter.isVisible(),false);
        const choose=async source=>{
          const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');
          await page.locator('#news-sources [data-source="'+source+'"]').click();await response;await ready();
        };
        await choose('settrade');assert.equal(lastArchive.matchingTotal,18);
        for(let i=0;i<3;i++) {
          const card=page.locator('#featured-news .news-item').filter({has:page.getByRole('link',{name:'PTT รายงานผลประกอบการโครงการ '+i,exact:true})});
          assert.equal(await card.count(),1);assert.equal(await card.locator('.news-relevance').textContent(),'PTT');
        }
        const unknown=page.locator('#featured-news .news-item').filter({has:page.getByRole('link',{name:'PTT รายงานผลประกอบการโครงการ 3',exact:true})});
        assert.equal(await unknown.locator('.news-relevance').textContent(),'ยังไม่ระบุหลักทรัพย์');
        assert.equal(await page.locator('#news-list .news-title-link').count(),10);
        const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');
        await page.locator('#news-pager').getByRole('button',{name:'2',exact:true}).click();await response;
        await page.waitForFunction(()=>document.querySelector('#news-pager .active')?.textContent==='2');
        assert.equal(await page.locator('#news-list .news-title-link').count(),3);assert.equal(await counter.isVisible(),false);
        await choose('infoquest');assert.equal(lastArchive.matchingTotal,19);
        assert.equal(await page.locator('#news-sources [aria-pressed="true"]').count(),2);
        const searched=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('query')==='โครงการ 17');
        await page.locator('#news-search').fill('โครงการ 17');await searched;
        await ready();assert.equal(lastArchive.matchingTotal,1);assert.equal(await counter.isVisible(),false);
        assert.equal(await page.locator('#news-section .news-title-link').count(),1);
        assert.equal(await page.locator('#news-section .news-title-link').textContent(),'PTT รายงานผลประกอบการโครงการ 17');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        assert.equal(reads,1);assert.equal(JSON.stringify(rows),original);assert.ok(archiveCalls>=4);
        console.log(JSON.stringify({viewport:viewportName,publisherFilter:'PASS',existingTickerTags:'PASS',noInventedTag:'PASS',
          archiveSearchAndOr:'PASS',countPagingDedupe:'PASS',snapshotReads:reads,productionRequests:0}));
      } finally { await context.close(); }
    }
  } finally { await browser?.close().catch(()=>{});server.kill(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
