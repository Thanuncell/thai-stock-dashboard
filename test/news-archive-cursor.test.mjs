import test from 'node:test';
import assert from 'node:assert/strict';
import {cursorScope,cursorPageWindow,createArchiveCursorSession} from '../client/news-archive-cursor.mjs';
const token=(page,revision='1')=>page===1?null:`v${revision}-before-${(page-1)*10}`;
function responseFor(request,{size=84,revision='1',featured}={}){
 const count=Math.max(0,Math.min(10,size-(request.page-1)*10)),hasNext=request.page*10<size;
 const response={scope:request.scope,revision,items:Array.from({length:count},(_,i)=>({title:`page-${request.page}-${i}`})),hasNext,nextCursor:hasNext?token(request.page+1,revision):null};
 if(featured!==undefined)response.featured=featured;
 if(request.lookahead){
  const {startPage,pageCount}=request.lookahead,last=Math.min(Math.ceil(size/10),startPage+pageCount-1),pages=[];
  for(let page=startPage;page<=last;page++)pages.push({page,cursor:token(page,revision)});
  const hasMore=last*10<size;response.window={pages,hasMore,nextCursor:hasMore?token(last+1,revision):null};
 }
 return response;
}
const load=(s,options={},requestOptions={})=>{const req=s.begin(requestOptions);assert.equal(req.cached,false);assert.equal(s.accept(req,responseFor(req,options)),true);return req;};

test('AC-01 amended: ten content rows; only prepared positions appear as clickable numbers',()=>{
 const s=createArchiveCursorSession();assert.deepEqual(s.window.pages,[]);const req=load(s);
 assert.deepEqual(req.lookahead,{startPage:1,cursor:null,pageCount:5});assert.equal(s.current.items.length,10);assert.equal(s.highestLoaded,1);
 assert.deepEqual(s.window.pages,[1,2,3,4,5]);assert.ok(s.visibleButtons().every(x=>!x.disabled));assert.equal(s.canOpen(5),true);assert.equal(s.canOpen(6),false);
});
test('AC-02 target window slides one number at a time',()=>{
 for(const [page,start]of [[1,1],[3,1],[4,2],[5,3],[7,5],[11,9]])assert.deepEqual(cursorPageWindow(page).pages,[start,start+1,start+2,start+3,start+4]);
});
test('AC-03 1 -> 5 -> 2 -> 4 loads chosen pages only, with incremental tail lookahead',()=>{
 const s=createArchiveCursorSession();load(s);assert.equal(s.open(5),true);const req=load(s);
 assert.equal(req.cursor,token(5));assert.deepEqual(req.lookahead,{startPage:6,cursor:token(6),pageCount:2});assert.deepEqual(s.window.pages,[3,4,5,6,7]);
 s.open(2);assert.equal(load(s).lookahead,null);s.open(4);assert.equal(load(s).lookahead,null);assert.deepEqual(s.window.pages,[2,3,4,5,6]);
 s.open(5);assert.equal(s.begin().cached,true);s.open(3);assert.equal(s.begin().cached,false,'prepared pages have no prefetched articles');
});
test('AC-04/08 extension stops at a real short final page',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);load(s);s.open(7);assert.deepEqual(load(s).lookahead,{startPage:8,cursor:token(8),pageCount:2});
 assert.deepEqual(s.window.pages,[5,6,7,8,9]);s.open(9);load(s);assert.equal(s.current.items.length,4);assert.equal(s.navigateNext(),false);assert.equal(s.canOpen(10),false);assert.equal(s.window.rightEllipsis,false);assert.equal(s.navigatePrevious(),true);
});
for(const size of [0,3,10,11,37,40,49,50])test(`only actual pages appear for ${size} eligible rows`,()=>{
 const s=createArchiveCursorSession();load(s,{size});const count=Math.ceil(size/10);
 assert.deepEqual(s.window.pages,Array.from({length:count},(_,i)=>i+1));assert.equal(s.window.rightEllipsis,false);assert.ok(s.visibleButtons().every(x=>s.canOpen(x.page)&&!x.disabled));
 if(count){s.open(count);if(count>1)load(s,{size});assert.equal(s.current.hasNext,false);assert.equal(s.navigateNext(),false);}
});
test('AC-05 old article/window response cannot overwrite changed search/publisher scope',()=>{
 const s=createArchiveCursorSession({scope:cursorScope({query:'PTT'})}),old=s.begin();s.setScope(cursorScope({query:'SCB',source:'settrade'}));
 assert.equal(s.accept(old,responseFor(old)),false);load(s,{size:11});assert.equal(s.page,1);assert.deepEqual(s.window.pages,[1,2]);assert.equal(s.canOpen(5),false);
});
test('late jump/expansion loses authority after another prepared page is selected',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);const old=s.begin();s.open(1);
 assert.equal(s.accept(old,responseFor(old)),false);assert.equal(s.current.items[0].title,'page-1-0');assert.equal(s.canOpen(7),false);
});
test('AC-07 failed refresh retains accepted current view and inbound cursor',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);load(s);s.invalidateCurrent();const req=s.begin();
 assert.equal(req.cursor,token(5));assert.equal(s.fail(req),true);assert.equal(s.current.items[0].title,'page-5-0');assert.equal(s.page,5);
});
test('unchanged scoped refresh retains prepared window and cached visited pages',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);load(s);s.open(1);load(s,{}, {refresh:true});assert.equal(s.canOpen(7),true);s.open(5);assert.equal(s.begin().cached,true);
});
test('deep revision change rejects the whole response; reset discards old prepared history',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);load(s);const req=s.begin({refresh:true});assert.throws(()=>s.accept(req,responseFor(req,{revision:'2'})),/REVISION_CHANGED/);
 assert.equal(s.revision,'1');assert.equal(s.current.items[0].title,'page-5-0');s.resetToFirst();load(s,{size:11,revision:'2'});assert.equal(s.canOpen(5),false);
});
test('page-one revision refresh replaces all old cursors and cached articles',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);load(s);s.open(1);load(s,{size:11,revision:'2'},{refresh:true});assert.deepEqual(s.window.pages,[1,2]);assert.equal(s.canOpen(5),false);
});
test('metadata rejects article fields, excess pages and inconsistent boundaries without mutation',()=>{
 const s=createArchiveCursorSession(),req=s.begin(),valid=responseFor(req);
 const cases=[{...valid,scope:'other'},{...valid,revision:''},
  {...valid,window:{...valid.window,pages:valid.window.pages.map((p,i)=>i===1?{...p,title:'prefetched'}:p)}},
  {...valid,window:{...valid.window,pages:[...valid.window.pages,{page:6,cursor:token(6)}]}},
  {...valid,window:{...valid.window,pages:[valid.window.pages[0],valid.window.pages[2]]}},
  {...valid,window:{...valid.window,pages:valid.window.pages.map((p,i)=>i===2?{...p,cursor:token(2)}:p)}}];
 for(const response of cases){assert.throws(()=>s.accept(req,response),/INVALID/);assert.equal(s.current,null);assert.deepEqual(s.window.pages,[]);}assert.equal(s.accept(req,valid),true);
});
test('short hasNext page, repeating cursor and end carrying a cursor are invalid',()=>{
 const s=createArchiveCursorSession();load(s);const req=s.begin({refresh:true}),valid=responseFor(req);
 for(const response of [{...valid,items:valid.items.slice(0,2)},{...valid,hasNext:false,nextCursor:'invalid'}])assert.throws(()=>s.accept(req,response),/INVALID/);
 s.open(2);const second=s.begin();assert.throws(()=>s.accept(second,{...responseFor(second),nextCursor:second.cursor}),/INVALID/);
});
test('AC-11/13 same-scope cache retains Featured and expires using existing TTL',()=>{
 let clock=1000;const s=createArchiveCursorSession({now:()=>clock});load(s,{featured:[{url:'featured'}]});s.open(2);load(s);assert.deepEqual(s.current.featured,[{url:'featured'}]);
 s.open(1);assert.equal(s.begin().cached,true);clock+=30001;assert.equal(s.begin().cached,false);
});
test('account reset retires pending window response, content and cursor history',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);const old=s.begin();s.resetToFirst();assert.equal(s.current,null);assert.equal(s.canOpen(5),false);assert.equal(s.accept(old,responseFor(old)),false);
});
test('display-policy invalidation expires articles while retaining revision-bound positions for revalidation',()=>{
 const s=createArchiveCursorSession();load(s);s.open(5);load(s);s.invalidateCache();assert.equal(s.canOpen(5),true);assert.equal(s.begin().cached,false);assert.equal(s.begin().cursor,token(5));
});
test('AC-14 canonical equivalent scope retains history; real scope changes reset it',()=>{
 const a=cursorScope({source:'settrade,infoquest',query:' PTT ',excludeUrls:['b','a']}),b=cursorScope({source:'infoquest,settrade,infoquest',query:'ptt',excludeUrls:['a','b']});
 assert.equal(a,b);const s=createArchiveCursorSession({scope:a});load(s);assert.equal(s.setScope(b),false);assert.equal(s.canOpen(5),true);assert.equal(s.setScope(cursorScope({source:'all',query:'ptt'})),true);assert.equal(s.canOpen(5),false);
});
