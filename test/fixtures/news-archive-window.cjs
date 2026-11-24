'use strict';
// SYNTHETIC CONTRACT ONLY. In-memory input is not a database/index implementation.
// Selected key counts measure the bounded contract, not actual database reads.
const {encodeNewsArchiveCursor,decodeNewsArchiveCursor}=require('../../server/news-archive-cursor');
const rank=value=>BigInt(Date.parse(value))*1000n+BigInt((String(value).match(/\.(\d+)/)?.[1]||'').padEnd(6,'0').slice(3,6)||0);
module.exports=async function createWindowFixture({rows,now=Date.now(),revision='1'}={}){
 const domain=await import('../../client/domain.mjs'),{cursorScope}=await import('../../client/news-archive-cursor.mjs');
 let currentRevision=revision,featuredCache=null;
 const all=rows.map((item,index)=>({...item,id:String(item.id??index+1)})).sort((a,b)=>rank(a.pubDate)===rank(b.pubDate)?(BigInt(a.id)>BigInt(b.id)?-1:1):(rank(a.pubDate)>rank(b.pubDate)?-1:1));
 const metrics={requests:0,metadataRows:0,metadataBytes:0,selectedOrderingKeys:0,articleRows:0,articleBytes:0,featuredRows:0,featuredBytes:0,featuredSelections:0};
 function read({source='all',query='',symbol='',excludeUrls=[],featuredCount=0,cursor=null,revision,lookahead=null}={}){
  metrics.requests++;
  const scope=cursorScope({source,query,symbol,excludeUrls,featuredCount});
  const binding=JSON.stringify({scope,sort:'order_published_at.desc,order_id.desc',policy:'synthetic-contract-only'});
  if(revision!=null&&revision!==currentRevision)throw Error('NEWS_ARCHIVE_CURSOR_INDEX_CHANGED');
  const encode=item=>encodeNewsArchiveCursor({publishedAt:item.pubDate,id:item.id,scope:binding,indexRevision:currentRevision});
  const after=token=>token?decodeNewsArchiveCursor(token,{scope:binding,indexRevision:currentRevision}):null;
  if(!featuredCache||featuredCache.scope!==scope||featuredCache.revision!==currentRevision){
   const selected=domain.selectNewsForDisplay(all,{source,query,now,featuredCount:0}).filtered
    .filter(item=>(!symbol||domain.newsSecuritySymbols(item).includes(symbol))&&!excludeUrls.some(url=>domain.newsKey({url})===domain.newsKey(item)));
   featuredCache={scope,revision:currentRevision,items:domain.selectNewsForDisplay(selected,{source,query,now,featuredCount,sourceTier:{official:4,settrade:3,infoquest:2,efinance:2,thunhoon:2,kaohoon:2,broker:1}}).featured};
   const featuredKeys=new Set(featuredCache.items.map(domain.newsKey));
   featuredCache.eligible=selected.filter(item=>!featuredKeys.has(domain.newsKey(item)));
   if(featuredCount)metrics.featuredSelections++;
  }
  const eligible=featuredCache.eligible;
  const remaining=boundary=>eligible.filter(item=>!boundary||rank(item.pubDate)<rank(boundary.publishedAt)||rank(item.pubDate)===rank(boundary.publishedAt)&&BigInt(item.id)<BigInt(boundary.id));
  const candidates=remaining(after(cursor)).slice(0,11),items=candidates.slice(0,10),hasNext=candidates.length>10;
  const response={configured:true,pagination:'cursor',scope,revision:currentRevision,items,hasNext,nextCursor:hasNext?encode(items.at(-1)):null,dataState:'fresh',pageSize:10};
  if(!cursor)response.featured=featuredCache.items;
  if(lookahead){
   if(!Number.isSafeInteger(lookahead.startPage)||lookahead.startPage<1||!Number.isInteger(lookahead.pageCount)||lookahead.pageCount<1||lookahead.pageCount>5)throw Error('FIXTURE_LOOKAHEAD_ARGUMENT_INVALID');
   const keys=remaining(after(lookahead.cursor)).slice(0,lookahead.pageCount*10+1);
   const pages=[];
   for(let index=0;index<Math.min(keys.length,lookahead.pageCount*10);index+=10)pages.push({page:lookahead.startPage+index/10,cursor:index===0?lookahead.cursor:encode(keys[index-1])});
   const hasMore=keys.length>lookahead.pageCount*10;
   response.window={pages,hasMore,nextCursor:hasMore?encode(keys[lookahead.pageCount*10-1]):null};
   metrics.metadataRows+=pages.length;metrics.selectedOrderingKeys+=keys.length;
  }
  metrics.metadataBytes+=Buffer.byteLength(JSON.stringify({scope,revision:currentRevision,hasNext,nextCursor:response.nextCursor,...(response.window?{window:response.window}:{})}));
  metrics.articleRows+=items.length;metrics.articleBytes+=Buffer.byteLength(JSON.stringify({items}));
  if(response.featured){metrics.featuredRows+=response.featured.length;metrics.featuredBytes+=Buffer.byteLength(JSON.stringify({featured:response.featured}));}
  return response;
 }
 return{read,metrics,setRevision(value){currentRevision=value;featuredCache=null;}};
};
