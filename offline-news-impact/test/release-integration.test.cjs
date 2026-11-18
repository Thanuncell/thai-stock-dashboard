'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRuntimeServer}=require('../runtime.cjs');
const {createGeminiProvider}=require('../gemini.cjs');
const {createReader}=require('../reader.cjs');
const {createFixtureAuth}=require('../fixtures/auth.cjs');
const {loadCatalog,catalog}=require('../fixtures/coverage.cjs');
const {Lane}=require('../service.cjs'),core=require('../analysis.cjs');
const {comparisonOnlyEvidence}=require('../temporal-evidence.cjs');
const fixture=require('../fixtures/news.cjs');
const raw=stocks=>JSON.stringify({summary:['ประเด็นทดสอบหนึ่ง','ประเด็นทดสอบสอง'],stocks});
const stock=(symbol,evidence,direction='positive')=>({symbol,evidence,direction,reason:'เหตุการณ์ตามงวดรายงานที่ระบุในข่าวจำลอง'});
test('integrated accuracy baseline: stitched quote, changed whitespace, historical comparison, correct current PTTEP',()=>{
 const ptt='หุ้น PTT ได้รับคำสั่งซื้อใหม่ในงวดนี้';
 const pttgc='หุ้น PTTGC เปิดเผยต้นทุนทางการเงินในงวดนี้';
 const top='หุ้น TOP เคยมีกำไรในปีก่อน';
 const pttep='หุ้น PTTEP แจ้งกำไรในงวดนี้ลดลง';
 const article=ptt+' '+pttgc+' ขณะที่ช่วงเดียวกันของปีก่อน '+top+' อย่างไรก็ตาม '+pttep;
 const result=core.validate(raw([stock('PTT',ptt+'...'+pttgc),stock('PTTGC',pttgc.replace('เปิดเผย','เปิดเผย  ')),stock('TOP',top),stock('PTTEP',pttep,'negative')]),article,catalog);
 assert.deepEqual(result.positive,[]);assert.deepEqual(result.negative.map(s=>s.symbol),['PTTEP']);
 assert.equal(core.validate(raw([stock('PTT',ptt)]),article,catalog).positive[0].symbol,'PTT');
 assert.equal(comparisonOnlyEvidence('หุ้น PTT กำไรงวดนี้เพิ่มขึ้นเมื่อเทียบกับปีก่อน','หุ้น PTT กำไรงวดนี้เพิ่มขึ้นเมื่อเทียบกับปีก่อน'),false);
 assert.match(core.PROMPT,/ห้ามนำข้อความคนละช่วงมาต่อ/);assert.match(core.PROMPT,/ต้องลบหุ้นนั้นออกจาก stocks ทั้งรายการ/);
});
test('one real SETscope handler composes reviewed Reader, HTTP400 fix and accuracy validator for URL and text',async t=>{
 let clock=0,providerCalls=0,readerCalls=0,coverageCalls=0;
 const provider=createGeminiProvider({enabled:true,env:{GEMINI_API_KEY:'OFFLINE_SENTINEL'},fetchImpl:async(_url,options)=>{
  providerCalls++;const body=JSON.parse(options.body);
  assert.equal(body.generationConfig.responseJsonSchema.properties.stocks.items.properties.symbol.enum,undefined);
  assert.equal(body.generationConfig.maxOutputTokens,4096);assert.match(body.systemInstruction.parts[0].text,/ห้ามนำข้อความคนละช่วงมาต่อ/);
  assert.equal(JSON.parse(body.systemInstruction.parts[0].text.split('Catalog ของ Server:\n')[1]).length,499);
  const article=JSON.parse(body.contents[0].parts[0].text).article;assert.ok(article.includes(fixture.positive));
  const output=structuredClone(fixture.output);
  output.stocks.push(stock('UNKNOWN',fixture.positive),stock('PTTGC','PTTGC ข้อความที่ไม่มีในต้นฉบับ'));
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}]});
 }});
 const reader=createReader({loadHtml:async()=>{readerCalls++;return{status:200,html:fixture.html};}});
 const server=createRuntimeServer({auth:createFixtureAuth(),loadCatalog:async()=>{coverageCalls++;return loadCatalog();},reader,provider,lane:new Lane({now:()=>clock,wait:async ms=>{clock+=ms;}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const post=(mode,value,key,token='token-a')=>fetch(base+'/api/news-impact-phase1',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({mode,value,requestKey:key,user_id:'forged'})});
 await fetch(base);assert.deepEqual([providerCalls,readerCalls,coverageCalls],[0,0,0]);
 assert.equal((await post('text',fixture.text,'bad-auth','invalid')).status,401);assert.equal(providerCalls,0);
 for(const [mode,value]of [['url','https://news.example.org/article'],['text',fixture.text]]){
  const response=await post(mode,value,mode);assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(body.result.positive.map(s=>s.symbol),['PTT']);assert.deepEqual(body.result.negative.map(s=>s.symbol),['AOT']);
  assert.equal('quota'in body,false);assert.equal('resetAt'in body,false);
 }
 assert.deepEqual([providerCalls,readerCalls,coverageCalls],[2,1,2]);
});
