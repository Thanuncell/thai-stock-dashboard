'use strict';
const {createHash}=require('node:crypto');
const {createNewsArticleLoader}=require('../lib/news-resolver');
const {inspectNewsArticle,articleIdentity}=require('../lib/news-article');
const {classifyNewsItem}=require('../lib/news-quality');
const {isNewsDocumentForDisplay,isSetNewsCandidate}=require('../lib/news-content');
const {identifySetSecurities}=require('../lib/news-set-security');
const {readBoundedText}=require('../lib/news-response');
const {publisherMatches}=require('../lib/news-policy');
// Read-time facts only: never issue G1 evidence, edit associations or write an archive row.
function createNewsLinkReview({transport,loadArticle=createNewsArticleLoader({transport,allowGoogleRpc:false}),registrySearch=async()=>[],now=Date.now}={}){
 const cache=new Map(),pending=new Map(),observations=new WeakMap(),turns=new Map();let revision=0,turn=0;
 const key=item=>JSON.stringify([item.url,item.title,item.pubDate,item.source,item.sourceName]);
 const unknown=reason=>({status:'UNVERIFIED',kind:'UNKNOWN',reason});
 const negative=value=>['DOCUMENT','NON_ARTICLE'].includes(value?.link?.kind);
 function retained(item,id){
  const seen=observations.get(item);if(seen?.key===id)return seen.facts;
  return ['DOCUMENT','NON_ARTICLE'].includes(item?.linkVerification?.kind)?{link:item.linkVerification}:null;
 }
 const put=(id,value,item)=>{const cached=cache.get(id)?.value,old=negative(cached)?cached:retained(item,id);if(negative(old)&&value.link.kind==='UNKNOWN')value=old;cache.delete(id);cache.set(id,{value,expiresAt:Number(now())+(value.link.status==='VERIFIED'?21600000:300000)});while(cache.size>200)cache.delete(cache.keys().next().value);revision++;return value;};
 function project(item){
  const id=key(item),entry=cache.get(id),previous=retained(item,id);
  const cached=entry&&(entry.expiresAt>Number(now())||negative(entry.value))?entry.value:null;
  const facts=negative(previous)&&(!cached||cached.link.kind==='UNKNOWN')?previous:cached||previous;
  const result={...item,linkVerification:facts?.link||unknown('LINK_NOT_CHECKED_BUDGET')};
  delete result.displayUrl;delete result.securityIdentification;
  if(facts?.displayUrl)result.displayUrl=facts.displayUrl;
  if(isSetNewsCandidate(item))result.securityIdentification=facts?.security||{status:'UNVERIFIED',symbols:[],reason:'SET_PUBLISHER_UNVERIFIED'};
  const record={key:id,facts:negative(facts)?facts:null};
  observations.set(item,record);observations.set(result,record);
  return result;
 }
 async function inspect(item,budget,signal){
  const id=key(item),old=cache.get(id);if(old&&old.expiresAt>Number(now()))return old.value;
  if(pending.has(id))return pending.get(id);
  if(budget.remaining<=0||signal.aborted)return {link:unknown(signal.aborted?'LINK_REVIEW_TIMEOUT':'LINK_NOT_CHECKED_BUDGET')};
  budget.remaining--;
  const task=(async()=>{
   const finish=(link,extra={})=>put(id,{link:{...link,checkedAt:new Date(Number(now())).toISOString()},...extra},item);
   if(isNewsDocumentForDisplay(item))return finish({status:'UNVERIFIED',kind:'DOCUMENT',reason:'DOCUMENT_NOT_ARTICLE'});
   const loaded=await loadArticle(item.url,{budget,signal,maxBytes:1000000});
   if(!loaded.response){
    // A partial request budget is not a source verdict; retry it fairly next round.
    if(loaded.reason==='ARTICLE_REQUEST_BUDGET')return {link:unknown(loaded.reason)};
    return finish(unknown(loaded.reason));
   }
   const {response,target}=loaded,url=target.href;
   if([404,410].includes(response.status))return finish({status:'UNVERIFIED',kind:'NON_ARTICLE',reason:'LINK_HTTP_'+response.status});
   if(!response.ok)return finish(unknown('LINK_HTTP_'+response.status));
   if(response.url&&articleIdentity(response.url)!==articleIdentity(url))return finish(unknown('LINK_RESPONSE_URL_MISMATCH'));
   const type=response.headers.get('content-type')||'';
   if(isNewsDocumentForDisplay({...item,url})||/application\/(?:pdf|msword|vnd\.(?:ms-|openxmlformats))/i.test(type))return finish({status:'UNVERIFIED',kind:'DOCUMENT',reason:'DOCUMENT_RESPONSE'});
   const isHtml=/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type);
   let html;try{html=await readBoundedText(response,isHtml?1000000:4096,signal);}catch{return finish(unknown('LINK_READ_TIMEOUT'));}
   if(/^\s*%PDF-/.test(html))return finish({status:'UNVERIFIED',kind:'DOCUMENT',reason:'PDF_RESPONSE_SIGNATURE'});
   if(!isHtml)return finish(unknown('LINK_CONTENT_TYPE_UNVERIFIED'));
   const quality=classifyNewsItem({...item,url});
   const nonArticle=['AUTH_ACCOUNT','AUTHENTICATION_PAGE','COMPANY_PROFILE','QUOTE_DATA_OVERVIEW','ARCHIVE_LISTING','PAGINATION','CAREERS_RECRUITING','COMPANY_LEADERSHIP','SHAREHOLDER_OWNERSHIP','SERVICE_MARKETING','INSTRUMENT_REFERENCE','REPORT_REFERENCE','TRADING_CALENDAR','NAVIGATION_REFERENCE'];
   if(nonArticle.includes(quality.classification))return finish({status:'UNVERIFIED',kind:'NON_ARTICLE',reason:quality.reason});
   if(/<form\b[^>]*>[\s\S]*?<input\b[^>]*type=["']password["']/i.test(html)&&!/<article\b/i.test(html))return finish({status:'UNVERIFIED',kind:'NON_ARTICLE',reason:'LOGIN_FORM'});
   const inspection=inspectNewsArticle(html,{url,title:item.title,strict:true});
   if(inspection.reason==='ARTICLE_ACCESS_DENIED')loadArticle.blockOrigin(target);
   let security=null;
   if(isSetNewsCandidate(item)){
    let rows=[],timer;try{rows=await Promise.race([Promise.resolve().then(registrySearch),new Promise(resolve=>{timer=setTimeout(()=>resolve([]),750);})]);}catch{/* Identification degrades independently. */}finally{clearTimeout(timer);}
    security=identifySetSecurities(item,{url,html,text:inspection.status==='VERIFIED'?inspection.text:''},Array.isArray(rows)?rows:[]);
   }
   const publisher=publisherMatches({...item,url}),dateValid=Date.parse(inspection.publishedAt)<=Number(now())+600000;
   const verified=inspection.status==='VERIFIED'&&publisher&&dateValid;
   const reason=inspection.status==='VERIFIED'?(!publisher?'PUBLISHER_IDENTITY_UNVERIFIED':'PUBLICATION_DATE_INVALID'):inspection.status==='REJECTED'?'LINK_CANONICAL_IDENTITY_UNVERIFIED':inspection.reason;
   return finish(verified?{status:'VERIFIED',kind:'ARTICLE',reason:'ARTICLE_IDENTITY_VERIFIED'}:unknown(reason||'ARTICLE_NOT_VERIFIED'),{...(security?{security}:{}),...(verified?{displayUrl:url}:{})});
  })().catch(()=>put(id,{link:unknown('LINK_NETWORK_UNVERIFIED')},item)).finally(()=>pending.delete(id));
  pending.set(id,task);return task;
 }
 async function review(items){
  const budget={remaining:3,httpRemaining:12},signal=AbortSignal.timeout(7000);
  // Keep waiting order across reordering/new arrivals; official sources win only initial ties.
  const candidates=new Map();
  for(const item of [...items.filter(isSetNewsCandidate),...items.filter(x=>!isSetNewsCandidate(x))]){
   const id=key(item);if(candidates.has(id))continue;
   const token=createHash('sha256').update(id).digest('hex');
   const ticket=turns.get(token)??++turn;turns.delete(token);turns.set(token,ticket);
   // Bound bookkeeping to the existing maximum archive scan; retain no owner data.
   while(turns.size>100000)turns.delete(turns.keys().next().value);
   candidates.set(id,{item,id,token,ticket});
  }
  const waiting=[...candidates.values()].filter(({id})=>{const hit=cache.get(id);return !hit||hit.expiresAt<=Number(now());}).sort((a,b)=>a.ticket-b.ticket);
  for(const candidate of waiting.slice(0,3)){
   if(budget.remaining<=0||budget.httpRemaining<=0||signal.aborted)break;
   const result=await inspect(candidate.item,budget,signal);
   if(result.link.reason==='ARTICLE_REQUEST_BUDGET')break;
   // Unattempted work keeps its ticket when the shared deadline/budget ends a round.
   turns.delete(candidate.token);turns.set(candidate.token,++turn);
  }
  return items.map(project);
 }
 return {review,project,inspect:(item,{budget={remaining:1,httpRemaining:6},signal=AbortSignal.timeout(7000)}={})=>inspect(item,budget,signal),get revision(){return revision;}};
}
module.exports={createNewsLinkReview};
