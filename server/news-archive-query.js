'use strict';
const {createHash}=require('node:crypto');
const {dedupeNewsGroups}=require('../lib/broker-news');
const {canonicalUrl}=require('../lib/news-evidence');
const {normalizeNewsSources,newsPublisherKey,newsSecuritySymbols,newsAssociationSymbols,newsDisplayBlocked}=require('../lib/news-content');
const {normalizeSymbol}=require('../lib/validation');
const timestampRank=value=>BigInt(Date.parse(value))*1000n+BigInt((String(value).match(/\.(\d+)/)?.[1]||'').padEnd(6,'0').slice(3,6)||0);
const TIERS={official:4,settrade:3,infoquest:2,efinance:2,thunhoon:2,kaohoon:2,broker:1};
function createArchiveQuery({enabled,request,headers,fromRow,reviewRow,displayProject,displayReview,blockedUrls=()=>[],displayOverlays=()=>[],policy,now=Date.now}){
 let pending=null,lastReviewAt=null;
 const rpc=async(name,args={})=>{const response=await request('rpc/'+name,{method:'POST',headers:headers({'content-type':'application/json'}),body:JSON.stringify(args)});return response.json();};
 const projection=(group,raw)=>{
  const item=group.item,first=raw.get(group.first.fingerprint);
  return {group_key:createHash('sha256').update(policy+'\0'+group.contributors.map(x=>x.fingerprint).sort().join('\0')).digest('hex'),aliases:group.aliases,
   order_published_at:first.published_at,order_id:String(first.id),winner_published_at:new Date(item.pubDate).toISOString(),
   winner_fingerprint:item.fingerprint,source:item.source,publisher:newsPublisherKey(item),blocked:newsDisplayBlocked(item),broker:Boolean(item.brokerCategory||item.source==='broker'),symbols:newsAssociationSymbols(item),
   search_fields:[item.title,item.sourceName,item.snippet,item.analysisSummary,...(newsSecuritySymbols(item)||[])].map(x=>String(x||'').toLocaleLowerCase('th')),
   url_identity:canonicalUrl(item.url),source_tier:TIERS[item.source]||0};
 };
 function groupsFor(rows){
  const raw=new Map(rows.map(row=>[row.fingerprint,row]));
  const items=rows.slice().sort((a,b)=>timestampRank(a.published_at)!==timestampRank(b.published_at)?(timestampRank(a.published_at)>timestampRank(b.published_at)?-1:1):(BigInt(a.id)>BigInt(b.id)?-1:1)).map(fromRow).filter(Boolean);
  const groups=dedupeNewsGroups(items);return {raw,groups,projections:groups.map(group=>projection(group,raw))};
 }
 async function refresh({maxBatches=2,batchSize=100,reset=false}={}){
  if(!enabled)return {enabled:false,pending:null};
  if(pending){const result=await pending;const work=await rpc('news_archive_query_work',{p_limit:1});return {...result,pending:work.fingerprints?.length?true:0};}
  const task=(async()=>{
   if(reset)await rpc('news_archive_query_reset',{p_policy:policy});
   let conflicts=0;
   for(let batch=0;batch<Math.max(1,Math.min(maxBatches,1000));batch++){
    const work=await rpc('news_archive_query_work',{p_limit:Math.max(1,Math.min(batchSize,500))});
    if(work.policy&&work.policy!==policy)throw Error('NEWS_QUERY_POLICY_MISMATCH');
    if(!work.fingerprints?.length)return {enabled:true,pending:0,conflicts};
    const initial=groupsFor(work.rows),aliases=[...new Set(initial.projections.flatMap(x=>x.aliases))];
    const component=await rpc('news_archive_query_components',{p_fingerprints:work.fingerprints,p_aliases:aliases});
    if(component.sourceRevision!==work.sourceRevision||component.indexRevision!==work.indexRevision){conflicts++;continue;}
    const rows=[...new Map([...component.rows,...work.rows].map(row=>[row.fingerprint,row])).values()],prepared=groupsFor(rows),membership=new Map();
    prepared.groups.forEach((group,i)=>group.contributors.forEach(item=>membership.set(item.fingerprint,prepared.projections[i].group_key)));
    const result=await rpc('news_archive_query_commit',{p_source_revision:work.sourceRevision,p_index_revision:work.indexRevision,p_policy:policy,p_dirty:work.fingerprints,p_removed:component.groups,p_groups:prepared.projections,
     p_rows:rows.map(row=>({fingerprint:row.fingerprint,group_key:membership.get(row.fingerprint)||null,row_digest:row._query_digest,quality_status:reviewRow(row).status}))});
    if(!result.committed){conflicts++;continue;}
    if(result.pending===0)return {enabled:true,pending:0,conflicts};
   }
   return {enabled:true,pending:true,conflicts};
  })();pending=task;
  try{return await task;}finally{if(pending===task)pending=null;}
 }
 async function list(options,recheck=true,extraExcluded=[]){
  const page=Math.max(1,Math.min(100000,Number.parseInt(options.page,10)||1)),pageSize=Math.max(1,Math.min(50,Number.parseInt(options.pageSize,10)||10));
  const exclude=[...new Set([...(options.excludeUrls||[]).slice(0,10),...blockedUrls().slice(0,400),...extraExcluded].map(canonicalUrl).filter(Boolean))];
  if(exclude.length>410)throw Error('NEWS_QUERY_EXCLUSION_LIMIT');
  const overlays=displayOverlays().slice(0,200);
  const result=await rpc('list_news_archive_query',{p_overlays:overlays,p_policy:policy,p_page:page,p_page_size:pageSize,p_sources:normalizeNewsSources(options.source).split(','),p_symbol:normalizeSymbol(options.symbol)||'',p_query:String(options.query||'').trim().slice(0,80).toLocaleLowerCase('th'),p_exclude:exclude,p_featured:Math.max(0,Math.min(5,Number.parseInt(options.featuredCount,10)||0)),p_now:new Date(Number(now())).toISOString()});
  if(!result||!Array.isArray(result.groups)||!Array.isArray(result.pageKeys)||!Array.isArray(result.featuredKeys)||!Number.isSafeInteger(result.total)||result.total<0||result.countExact!==true||result.page!==page||result.pageSize!==pageSize)throw Error('NEWS_QUERY_RESPONSE_INVALID');
  if(result.groups.length>pageSize+5)throw Error('NEWS_QUERY_RESPONSE_LIMIT');
  const keys=[...result.pageKeys,...result.featuredKeys];
  if(result.pageKeys.length>pageSize||result.featuredKeys.length>Math.max(0,Math.min(5,Number.parseInt(options.featuredCount,10)||0))||new Set(keys).size!==keys.length||keys.length!==result.groups.length||!Number.isSafeInteger(result.matchingTotal)||result.matchingTotal!==result.total+result.featuredKeys.length)throw Error('NEWS_QUERY_RESPONSE_INVALID');
  const items=new Map();
  for(const record of result.groups){
   if(!Array.isArray(record.rows)||record.rows.length>2000)throw Error('NEWS_QUERY_RESPONSE_LIMIT');
   const prepared=groupsFor(record.rows);if(prepared.groups.length!==1)throw Error('NEWS_QUERY_PROJECTION_CHANGED');
   const expected=prepared.projections[0],stored=record.projection;
   if(!stored||record.key!==expected.group_key||stored.group_key!==record.key)throw Error('NEWS_QUERY_PROJECTION_CHANGED');
   if(Object.keys(expected).some(key=>key.endsWith('_at')?timestampRank(expected[key])!==timestampRank(stored[key]):key==='order_id'?String(expected[key])!==String(stored[key]):JSON.stringify(expected[key])!==JSON.stringify(stored[key])))throw Error('NEWS_QUERY_PROJECTION_CHANGED');
   items.set(record.key,displayProject(prepared.groups[0].item));
  }
  if(recheck&&(lastReviewAt===null||Number(now())-lastReviewAt>=300000)){
   lastReviewAt=Number(now());
   const reviewed=await displayReview([...items.values()]);
   if(!Array.isArray(reviewed)||reviewed.length!==items.size)throw Error('NEWS_QUERY_REVIEW_POLICY_CHANGED');
   const blocked=reviewed.filter(newsDisplayBlocked).map(item=>item.url);
   if(blocked.length||JSON.stringify(overlays)!==JSON.stringify(displayOverlays().slice(0,200)))return list(options,false,[...extraExcluded,...blocked]);
   for(const item of reviewed){const entry=[...items].find(([,old])=>old.fingerprint===item.fingerprint);if(entry)items.set(entry[0],displayProject(item));}
  }
  const select=keys=>keys.map(key=>{if(!items.has(key))throw Error('NEWS_QUERY_RESPONSE_INCOMPLETE');return items.get(key);});
  return {configured:true,items:select(result.pageKeys),featured:select(result.featuredKeys),page,pageSize,total:result.total,matchingTotal:result.matchingTotal,countExact:true,countCoverage:'complete-database-query',snapshotRows:result.rawTotal,
   qualityFiltered:result.qualityFiltered,quarantined:result.quarantined,rejected:result.rejected,deduplicated:result.deduplicated,maxAgeDays:365,coverage:'up-to-365-days-subject-to-source-availability',queryMode:'database'};
 }
 return {enabled,refresh,list,invalidateReview(){lastReviewAt=null;}};
}
module.exports={createArchiveQuery};
