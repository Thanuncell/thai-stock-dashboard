'use strict';
const {allowedNewsUrl}=require('./news-policy');
const records=new WeakMap();
const VERSION='news-discovery-1';
const PATHWAYS=new Set(['google-news-rss/general','google-news-rss/watchlist','bangkokbiznews/sitemap','thansettakij/sitemap']);
const binding=item=>JSON.stringify([item.title,item.url,item.source,item.sourceName,item.pubDate,item.snippet||'']);
function validRecord(value){
 return value?.version===VERSION&&PATHWAYS.has(value.pathway)&&typeof value.publisher==='string'
  &&value.publisher.length>0&&value.publisher.length<=160&&typeof value.originalUrl==='string'
  &&value.originalUrl.length<=2048&&Boolean(allowedNewsUrl(value.originalUrl))
  &&Number.isFinite(Date.parse(value.publishedAt))&&Number.isFinite(Date.parse(value.observedAt))
  &&Buffer.byteLength(JSON.stringify(value))<=3000;
}
function trustedDiscovery(item){
 const value=item?.discovery,subject=value&&records.get(value);
 return subject&&subject===binding(item)?value:null;
}
function restoreDiscovery(item,value){
 if(!validRecord(value))return null;
 // Copy only this contract, never caller extras such as owner IDs or raw HTML.
 const copy=Object.freeze({version:VERSION,pathway:value.pathway,publisher:value.publisher,
  originalUrl:value.originalUrl,publishedAt:value.publishedAt,observedAt:value.observedAt});
 records.set(copy,binding(item));return copy;
}
function recordDiscovery(item,{pathway,observedAt=Date.now()}={}){
 if(!Number.isFinite(Date.parse(item.pubDate))||!Number.isFinite(Number(observedAt)))return item;
 const discovery=restoreDiscovery(item,{version:VERSION,pathway,publisher:item.sourceName,originalUrl:item.url,
  publishedAt:new Date(item.pubDate).toISOString(),observedAt:new Date(Number(observedAt)).toISOString()});
 return discovery?{...item,discovery}:item;
}
function projectDiscovery(original,projected){
 const value=trustedDiscovery(original),result={...projected};delete result.discovery;
 if(value)result.discovery=restoreDiscovery(result,value);
 return result;
}
module.exports={recordDiscovery,trustedDiscovery,projectDiscovery,restoreDiscovery};
