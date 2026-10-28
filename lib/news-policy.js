'use strict';

// Roadmap entries remain disabled until their source integration is approved.
const NEWS_PUBLISHERS = Object.freeze([
 { host:'thunhoon.com', sources:['thunhoon'], name:/ทันหุ้น|thunhoon/i },
 { host:'kaohoon.com', sources:['kaohoon'], name:/ข่าวหุ้น|kaohoon/i },
 { host:'settrade.com', sources:['settrade','official'], name:/^(?:SET|SETTRADE)(?:\.COM)?$|ตลาดหลักทรัพย์/i },
 { host:'set.or.th', sources:['settrade','official'], name:/^(?:SET|SETTRADE)$|ตลาดหลักทรัพย์/i },
 { host:'bot.or.th', sources:['official'], name:/ธนาคารแห่งประเทศไทย|bank of thailand|^BOT$/i },
 { host:'efinancethai.com', sources:['efinance'], name:/efinance|อีไฟแนนซ์/i },
 { host:'infoquest.co.th', sources:['infoquest'], name:/infoquest|อินโฟเควสท์/i },
 // Storage uses the existing 'other' enum; acquisition requires an explicit opt-in.
 { host:'bangkokbiznews.com', sources:['other'], name:/^(?:กรุงเทพธุรกิจ|bangkokbiznews)$/i, articleHost:true },
 { host:'prachachat.net', sources:['other'], name:/^(?:ประชาชาติธุรกิจ|prachachat)$/i, articleHost:true }
]);
// Investing.com acquisition is excluded from this release by Owner decision.
const ROADMAP_NEWS_PUBLISHERS = Object.freeze([]);
const ALLOWED_NEWS_HOSTS = Object.freeze(['news.google.com',...NEWS_PUBLISHERS.map(x=>x.host)]);
function allowedNewsUrl(value) {
 try {
  const url=new URL(value),host=ALLOWED_NEWS_HOSTS.some(h=>url.hostname===h||url.hostname.endsWith('.'+h));
  return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&host?url:null;
 } catch { return null; }
}
function isGoogleNewsUrl(value) {
 const url=allowedNewsUrl(value);return Boolean(url&&url.hostname==='news.google.com');
}
function publisherMatches(item) {
 const url=allowedNewsUrl(item.url);
 return Boolean(url&&NEWS_PUBLISHERS.some(p=>(url.hostname===p.host||url.hostname.endsWith('.'+p.host))
  &&(!p.articleHost||url.hostname===p.host||url.hostname==='www.'+p.host)
  &&p.sources.includes(item.source)&&p.name.test(String(item.sourceName||''))));
}
function resolveAllowedNewsRedirect(currentUrl,location) {
 if(!location)return null;
 try{return allowedNewsUrl(new URL(location,currentUrl).href);}catch{return null;}
}
function p1DisplayGateEnabled(env=process.env) { return env.SETSCOPE_P1_DISPLAY_GATE==='on'; }
function isSlugNewsTitle(value='') {
 const title=String(value).trim().replace(/\s+-\s+[^-]+$/,'').trim();
 return /^[a-z0-9]+(?:[-_][a-z0-9]+){2,}$/i.test(title)||/^[a-z0-9]+(?:[-_][\p{L}\p{M}\p{N}]+){2,}$/u.test(title);
}
module.exports={p1DisplayGateEnabled,isSlugNewsTitle,NEWS_PUBLISHERS,ROADMAP_NEWS_PUBLISHERS,ALLOWED_NEWS_HOSTS,allowedNewsUrl,isGoogleNewsUrl,publisherMatches,resolveAllowedNewsRedirect};
