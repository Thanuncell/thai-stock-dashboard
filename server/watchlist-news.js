'use strict';
const {normalizeWatchlistNewsStocks}=require('../lib/validation');
const {createWatchlistNewsCacheKey}=require('./reliability');
const {matchesWatchlistStock,watchlistStockQuery}=require('../lib/watchlist-news-identity');
const {newsFingerprint,dedupeNewsItems}=require('../lib/broker-news');
const {reviewNewsItem}=require('../lib/news-quality');
const {mergeEvidenceAssociations}=require('../lib/news-evidence');
const {registryCompanyName}=require('./search-company-names');
const AGE=30*86400000,TTL=300000,LKG=1800000,PER_STOCK=30;
function abortable(task,signal){
 if(!signal)return task;
 if(signal.aborted)return Promise.reject(Error('WATCHLIST_DEADLINE'));
 let listener;const expired=new Promise((_,reject)=>{listener=()=>reject(Error('WATCHLIST_DEADLINE'));signal.addEventListener('abort',listener,{once:true});});
 return Promise.race([task,expired]).finally(()=>signal.removeEventListener('abort',listener));
}
function mergeStockNews(items,stocks,now){
 const unique=new Map(),symbols=new Set(stocks.map(stock=>stock.symbol));
 for(const item of items){
  const published=Date.parse(item.pubDate);
  if(!Number.isFinite(published)||published<now-AGE||published>now+600000||reviewNewsItem(item).status!=='VERIFIED')continue;
  const matchedSymbols=(item.matchedSymbols||[]).filter(symbol=>symbols.has(symbol));if(!matchedSymbols.length)continue;
  const key=newsFingerprint(item),old=unique.get(key);
  unique.set(key,mergeEvidenceAssociations(item,{...item,matchedSymbols:[...new Set([...(old?.matchedSymbols||[]),...matchedSymbols])]},old?[old]:[]));
 }
 return dedupeNewsItems([...unique.values()]).sort((a,b)=>Date.parse(b.pubDate)-Date.parse(a.pubDate));
}
function createWatchlistNews({fetchStock,registrySearch=async()=>[],isRejected=()=>false,canDisplay=()=>true,now=Date.now,deadlineMs=30000}){
 const cache=new Map(),pending=new Map(),budgets=new Map();
 const prune=map=>{while(map.size>200)map.delete(map.keys().next().value);};
 function usable(entry){return entry&&Number(now())-entry.storedAt<=LKG?entry:null;}
 async function load(stock,key,budget,signal){
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   try{
    const result=await abortable(fetchStock(stock,budget,signal),signal);
    if(signal.aborted)throw Error('WATCHLIST_DEADLINE');
    const old=usable(cache.get(key));
    const rejected=new Set(result.rejectedKeys||[]);
    const items=mergeStockNews([...(old?.items||[]).filter(item=>!rejected.has(newsFingerprint(item))&&!isRejected(item)),...result.items],[stock],Number(now()));
    const limited=items.length>PER_STOCK||result.limited;
    const withheldUrls=[...new Set([...(result.withheldUrls||[]),...(old?.items||[]).filter(isRejected).map(item=>item.url)])];
    const entry={...result,withheldUrls,items:items.slice(0,PER_STOCK),limited,storedAt:Number(now()),retryAt:0};
    // Unknown checks cannot renew the age of last-known-good evidence.
    if(result.unverifiedCount>0&&!result.items.length){
     if(old){old.retryAt=Number(now())+30000;old.failure=true;return {...old,withheldUrls,state:'stale',reason:'ARTICLE_UNVERIFIED'};}
     return {...entry,items:[],state:'unavailable',reason:'ARTICLE_UNVERIFIED'};
    }
    cache.delete(key);cache.set(key,entry);prune(cache);
    return {...entry,state:result.unverifiedCount?'partial':'fresh'};
   }catch(error){
    const old=usable(cache.get(key));if(old){old.retryAt=Number(now())+30000;old.failure=true;}
    return {...(old||{items:[],matchedCandidates:0,qualityExcluded:0}),state:old?.items.length?'stale':'unavailable',reason:signal.aborted?'WATCHLIST_DEADLINE':error.providerCooldown?'PROVIDER_COOLDOWN':'PROVIDER_FAILURE'};
   }
  })();pending.set(key,task);task.finally(()=>{if(pending.get(key)===task)pending.delete(key);}).catch(()=>{});return task;
 }
 return async function getWatchlistNews(rawStocks='',{ownerId='',refresh=false}={}){
  const stocks=normalizeWatchlistNewsStocks(rawStocks),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadlineMs);
  try{
   // Only reviewed registry names extend identity; client-supplied names are not evidence.
   if(stocks.length){
    let lookupTimer;try{
     const rows=await Promise.race([registrySearch(),new Promise(resolve=>{lookupTimer=setTimeout(()=>resolve([]),750);})]);
     const counts=new Map();for(const row of rows)counts.set(row.symbol,(counts.get(row.symbol)||0)+1);
     for(const stock of stocks){const row=rows.find(row=>row.symbol===stock.symbol&&counts.get(row.symbol)===1&&row.active===true&&!['inactive','unsupported'].includes(row.status)&&row.provider==='Yahoo Finance'&&row.provider_symbol===row.symbol+'.BK');if(row)stock.verifiedName=registryCompanyName(row)||'';}
    }catch{/* Symbols and reviewed aliases remain available. */}finally{clearTimeout(lookupTimer);}
   }
   const ownerKey=createWatchlistNewsCacheKey([],ownerId),recent=budgets.get(ownerKey)||[];
   recent.splice(0,recent.length,...recent.filter(time=>Number(now())-time<60000));
   budgets.delete(ownerKey);budgets.set(ownerKey,recent);prune(budgets);
   const records=[],budget={remaining:3,signal:controller.signal};let requests=0;
   // Missing stocks first, then oldest checks: progress is explicit across later requests.
   const ordered=[...stocks].sort((a,b)=>(cache.get(createWatchlistNewsCacheKey([{symbol:a.symbol}],ownerId))?.storedAt||0)-(cache.get(createWatchlistNewsCacheKey([{symbol:b.symbol}],ownerId))?.storedAt||0));
   for(const stock of ordered){
    const key=createWatchlistNewsCacheKey([{symbol:stock.symbol}],ownerId),old=usable(cache.get(key));let entry;
    if(old?.retryAt>Number(now()))entry={...old,state:'stale',reason:'RETRY_COOLDOWN'};
    else if(old&&!old.failure&&!refresh&&Number(now())-old.storedAt<TTL)entry={...old,state:old.unverifiedCount?'partial':'fresh'};
    else if(pending.has(key))entry=await pending.get(key);
    else if(requests>=4||recent.length>=8||controller.signal.aborted)entry={...(old||{items:[],matchedCandidates:0,qualityExcluded:0}),state:old?.items.length?'stale':'unavailable',reason:controller.signal.aborted?'WATCHLIST_DEADLINE':'REQUEST_BUDGET'};
    else{requests++;recent.push(Number(now()));entry=await load(stock,key,budget,controller.signal);}
    records.push({stock,...entry});
   }
   const items=mergeStockNews(records.flatMap(record=>record.items).filter(item=>!isRejected(item)&&canDisplay(item)),stocks,Number(now()));
   const abnormal=records.some(record=>record.state!=='fresh'||record.limited),allStale=items.length&&records.filter(record=>record.items.length).every(record=>record.state==='stale');
   const dataState=allStale?'stale':abnormal?(items.length?'partial':'unavailable'):'fresh';
   const fetchedAt=new Date(records.length?Math.min(...records.map(record=>record.storedAt||Number(now()))):Number(now())).toISOString();
   const withheldUrls=[...new Set(records.flatMap(record=>[...(record.withheldUrls||[]),...record.items.filter(item=>isRejected(item)||!canDisplay(item)).map(item=>item.url)]))].slice(0,200);
   return {...(withheldUrls.length?{withheldUrls}:{}),items,fetchedAt,asOf:items[0]?.pubDate||null,source:'Google News',stale:Boolean(allStale),partial:abnormal,dataState,maxAgeDays:30,
    matchedCandidates:records.reduce((n,r)=>n+(r.matchedCandidates||0),0),qualityExcluded:records.reduce((n,r)=>n+(r.qualityExcluded||0),0),
    limited:records.some(record=>record.limited),stockStatus:records.map(record=>({symbol:record.stock.symbol,dataState:record.state,reason:record.reason||null,retained:mergeStockNews(record.items.filter(item=>!isRejected(item)&&canDisplay(item)),[record.stock],Number(now())).length,limited:Boolean(record.limited)})),total:items.length};
  }finally{clearTimeout(timer);}
 };
}
module.exports={createWatchlistNews,mergeStockNews,abortable};
