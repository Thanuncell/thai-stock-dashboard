'use strict';
const {xmlTag,decodeXml}=require('../lib/settrade-parser');
const {createNewsTransport}=require('../lib/news-fetch');
const {createNewsArticleLoader}=require('../lib/news-resolver');
const {inspectNewsArticle}=require('../lib/news-article');
const {isNewsDocumentForDisplay}=require('../lib/news-content');
const {publisherMatches}=require('../lib/news-policy');
const {canonicalUrl,issueEvidence,projectEvidence}=require('../lib/news-evidence');
const {dedupeNewsItems,decorateBrokerAttribution}=require('../lib/broker-news');
const {matchesWatchlistStock}=require('../lib/watchlist-news-identity');
const {readBoundedText}=require('../lib/news-response');
const {abortable}=require('./watchlist-news');
const SITEMAP='https://api.bangkokbiznews.com/sitemap/latest',TTL=300000,LKG=1800000;
function parseBangkokSitemap(xml,now=Date.now()){
 if(typeof xml!=='string'||Buffer.byteLength(xml)>1000000||/<!DOCTYPE|<!ENTITY/i.test(xml)
  ||!/<urlset\b/.test(xml)||!/<\/urlset>\s*$/.test(xml))throw Error('PARSER_MISMATCH');
 const blocks=[...xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi)];
 if(blocks.length!==(xml.match(/<url(?:\s|>)/gi)||[]).length)throw Error('PARSER_MISMATCH');
 const items=[];
 for(const match of blocks.slice(0,500)){
  const block=match[1],url=decodeXml(xmlTag(block,'loc')),title=decodeXml(xmlTag(block,'news:title'));
  const date=decodeXml(xmlTag(block,'news:publication_date')),name=decodeXml(xmlTag(block,'news:name'));
  let target;try{target=new URL(url);}catch{continue;}
  if(!['www.bangkokbiznews.com','bangkokbiznews.com'].includes(target.hostname)||target.protocol!=='https:'||target.username||target.password||target.port
   ||!/^\/(?:finance|business|economics)(?:\/[a-z0-9-]+)*\/\d+\/?$/.test(target.pathname))continue;
  if(!title||title.length>500||!/^Bangkokbiznews$/i.test(name)||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date)
   ||!Number.isFinite(Date.parse(date))||Date.parse(date)>now+600000||Date.parse(date)<now-30*86400000)continue;
  // Keep the existing storage source contract; publisher identity remains explicit.
  const item=decorateBrokerAttribution({source:'other',sourceName:'กรุงเทพธุรกิจ',discoverySource:'bangkokbiznews',title,url:target.href,pubDate:new Date(date).toISOString(),snippet:''});
  if(!isNewsDocumentForDisplay(item))items.push(item);
 }
 return [...new Map(items.map(item=>[canonicalUrl(item.url),item])).values()].sort((a,b)=>Date.parse(b.pubDate)-Date.parse(a.pubDate)).slice(0,20);
}
function createBangkokBizNewsSource({enabled=false,transport=createNewsTransport({allowBangkok:enabled}),articleLoader,now=Date.now}={}){
 const loadArticle=articleLoader||createNewsArticleLoader({transport,now,allowGoogleRpc:false}),texts=new WeakMap(),seenAt=new WeakMap(),turns=new Map();
 let snapshot=null,pending=null,retryAt=0,denied=false,turn=0;
 const empty=(reason)=>({items:[],assessments:[],errors:reason?[reason]:[],unverifiedCount:0,partial:Boolean(reason),dataState:reason?'unavailable':'disabled'});
 function fallback(reason){
  const old=snapshot&&Number(now())-snapshot.at<=LKG?snapshot:null;
  return old?{...old.value,items:old.value.items.filter(x=>Number(now())-seenAt.get(x)<=LKG),errors:[reason],partial:true,dataState:'stale'}:empty(reason);
 }
 async function refresh(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000),budget={httpRemaining:12};
  try{
   budget.httpRemaining--;
   const response=await transport(SITEMAP,{redirect:'manual',signal:controller.signal,maxBytes:1000000,headers:{accept:'application/xml,text/xml','user-agent':'SETscope/1.0 news reader'}});
   if([401,403].includes(response.status)){denied=true;throw Error('SOURCE_ACCESS_DENIED');}
   if(response.status===429){retryAt=Number(now())+TTL;throw Error('SOURCE_RATE_LIMIT');}
   if(!response.ok)throw Error('SOURCE_HTTP_'+response.status);
   if(!/^(?:application|text)\/(?:xml|rss\+xml)(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error('PARSER_MISMATCH');
   const candidates=parseBangkokSitemap(await readBoundedText(response,1000000,controller.signal),Number(now()));
   for(const item of candidates)if(!turns.has(item.url))turns.set(item.url,++turn);
   while(turns.size>200)turns.delete(turns.keys().next().value);
   const waiting=[...candidates].sort((a,b)=>turns.get(a.url)-turns.get(b.url));
   const items=[],assessments=[],old=snapshot&&Number(now())-snapshot.at<=LKG?snapshot.value.items:[];
   for(const original of waiting.slice(0,3)){
    if(controller.signal.aborted||budget.httpRemaining<=0)break;
    try{
    const loaded=await loadArticle(original.url,{signal:controller.signal,budget,maxBytes:1000000});
    if(loaded.reason==='ARTICLE_REQUEST_BUDGET')break;
    turns.delete(original.url);turns.set(original.url,++turn);
    if(!loaded.response){assessments.push({url:original.url,reason:loaded.reason});continue;}
    const {response:article,target}=loaded;
    if(!article.ok||!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(article.headers.get('content-type')||'')){
     assessments.push({url:original.url,reason:'ARTICLE_RESPONSE_UNVERIFIED'});continue;
    }
    if(!publisherMatches({...original,url:target.href})||isNewsDocumentForDisplay({...original,url:target.href})){
     assessments.push({url:original.url,reason:'ARTICLE_PUBLISHER_OR_DOCUMENT'});continue;
    }
    if(article.url&&canonicalUrl(article.url)!==canonicalUrl(target.href)){assessments.push({url:original.url,reason:'ARTICLE_RESPONSE_URL_MISMATCH'});continue;}
    const html=await readBoundedText(article,1000000,controller.signal);
    const inspection=inspectNewsArticle(html,{url:target.href,title:original.title,strict:true});
    if(inspection.reason==='ARTICLE_ACCESS_DENIED')loadArticle.blockOrigin(target);
    if(inspection.status!=='VERIFIED'||Date.parse(inspection.publishedAt)!==Date.parse(original.pubDate)){
     assessments.push({url:original.url,reason:inspection.status==='VERIFIED'?'PUBLICATION_DATE_MISMATCH':inspection.reason});continue;
    }
    const item={...original,url:inspection.resolvedUrl};
    item.verification=issueEvidence(item,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},
     {inspection,checkedAt:Number(now()),originalUrl:original.url,pathway:'bangkokbiznews/sitemap-article'});
    if(item.verification){texts.set(item,inspection.text);seenAt.set(item,Number(now()));items.push(item);}
    }catch{assessments.push({url:original.url,reason:controller.signal.aborted?'ARTICLE_REQUEST_TIMEOUT':'ARTICLE_RESPONSE_UNVERIFIED'});}
   }
   // Previously verified stories retain their own timestamps; failed refresh cannot renew their LKG.
   const expired=new Set(assessments.map(x=>canonicalUrl(x.url)));
   const combined=dedupeNewsItems([...items,...old.filter(x=>Number(now())-seenAt.get(x)<=LKG&&!expired.has(canonicalUrl(x.url))&&!items.some(y=>canonicalUrl(y.url)===canonicalUrl(x.url)))]).slice(0,20);
   const value={items:combined,assessments:[],errors:assessments.length?['ARTICLE_COVERAGE_PARTIAL']:[],unverifiedCount:assessments.length,
    diagnostics:assessments,partial:assessments.length>0,dataState:assessments.length?(combined.length?'partial':'unavailable'):combined.length?'fresh':'empty'};
   snapshot={at:Number(now()),value};return value;
  }catch(error){retryAt=Number(now())+TTL;return fallback(controller.signal.aborted?'SOURCE_TIMEOUT':['PARSER_MISMATCH','SOURCE_ACCESS_DENIED','SOURCE_RATE_LIMIT'].includes(error.message)||/^SOURCE_HTTP_\d+$/.test(error.message)?error.message:'SOURCE_UNAVAILABLE');}
  finally{clearTimeout(timer);}
 }
 async function getNews({stock,signal}={}){
  if(!enabled)return empty();
  let result;
  if(denied||Number(now())<retryAt)result=fallback(denied?'SOURCE_ACCESS_DENIED':'SOURCE_COOLDOWN');
  else if(snapshot&&Number(now())-snapshot.at<TTL)result=snapshot.value;
  else{if(!pending)pending=refresh().finally(()=>{pending=null;});result=await abortable(pending,signal);}
  if(!stock)return result;
  const items=[];
  for(const item of result.items){
   const text=texts.get(item);if(!text||!matchesWatchlistStock(stock,item.title+' '+text))continue;
   const projected={...item,matchedSymbols:[stock.symbol]};projected.verification=projectEvidence(item,projected,item.verification);items.push(projected);
  }
  return {...result,items};
 }
 return {getNews};
}
module.exports={SITEMAP,parseBangkokSitemap,createBangkokBizNewsSource};
