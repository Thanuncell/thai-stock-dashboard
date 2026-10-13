const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {URL}=require('node:url');

const ROOT=__dirname;
const PORT=Number(process.env.PORT)||4173;
const HOST=process.env.HOST||'127.0.0.1';
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.ico':'image/x-icon'};
function send(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'same-origin'});res.end(JSON.stringify(obj))}
const authConfigured=Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_ANON_KEY);
async function requireUser(req,res){
 if(!authConfigured){send(res,503,{error:'ระบบสมาชิกยังไม่ได้ตั้งค่า'});return false}
 const token=(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i)?.[1];
 if(!token){send(res,401,{error:'กรุณาเข้าสู่ระบบ'});return false}
 try{const response=await fetch(`${process.env.SUPABASE_URL.replace(/\/$/,'')}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(7000)});if(response.ok)return true}catch(_){}
 send(res,401,{error:'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง'});return false;
}
function decodeXml(s=''){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}
function xmlTag(block,name){return block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]||''}
const feeds=[['thunhoon','ทันหุ้น','site:thunhoon.com'],['kaohoon','ข่าวหุ้น','site:kaohoon.com'],['settrade','SETTRADE','site:settrade.com'],['settrade','SET','site:set.or.th']];
async function getNews(){
 const cutoff=Date.now()-30*24*60*60*1000;
 const settled=await Promise.allSettled(feeds.map(async([source,sourceName,q])=>{
  const u='https://news.google.com/rss/search?q='+encodeURIComponent(`${q} when:30d`)+'&hl=th&gl=TH&ceid=TH:th';
  const r=await fetch(u,{headers:{'user-agent':'SETscope/1.0 news reader (local prototype)','accept':'application/rss+xml, application/xml, text/xml'}});
  if(!r.ok)throw Error(`${sourceName} RSS HTTP ${r.status}`);
  const xml=await r.text();
  const channel=xml.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/i)?.[1]||xml;
  return [...channel.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>{
   const block=m[1],title=decodeXml(xmlTag(block,'title')),url=decodeXml(xmlTag(block,'link')),pubDate=decodeXml(xmlTag(block,'pubDate'));
   const outlet=xmlTag(block,'source').match(/>([\s\S]*?)<\/source>/i)?.[1];
   return{source,sourceName:outlet?decodeXml(outlet):sourceName,title,url,pubDate};
  }).filter(item=>{
   const published=Date.parse(item.pubDate);
   return item.title&&/^https:\/\//.test(item.url)&&Number.isFinite(published)&&published>=cutoff;
  }).sort((a,b)=>Date.parse(b.pubDate)-Date.parse(a.pubDate)).slice(0,8);
 }));
 const items=settled.flatMap(result=>result.status==='fulfilled'?result.value:[]).sort((a,b)=>Date.parse(b.pubDate)-Date.parse(a.pubDate));
 return{items,errors:settled.map((result,i)=>result.status==='rejected'?feeds[i][0]:null).filter(Boolean),fetchedAt:new Date().toISOString(),maxAgeDays:30};
}
const periods={ '1D':['1d','1m'],'1W':['5d','15m'],'1M':['1mo','1d'],'3M':['3mo','1d'],'1Y':['1y','1d'] };
const levelsHistoryCache=new Map();
async function getLevelsHistory(symbol){
 const cached=levelsHistoryCache.get(symbol);
 if(cached&&cached.expiresAt>Date.now())return cached.history;
 const history=shapeChart(await yahooChart(symbol+'.BK','1y','1d'),symbol).history;
 levelsHistoryCache.set(symbol,{history,expiresAt:Date.now()+5*60*1000});
 return history;
}
async function yahooChart(symbol,range,interval){const endpoint=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);endpoint.searchParams.set('range',range);endpoint.searchParams.set('interval',interval);endpoint.searchParams.set('events','div,splits');const response=await fetch(endpoint,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36','accept':'application/json'}});if(!response.ok)throw Error(`Yahoo Finance ${symbol}: HTTP ${response.status}`);const body=await response.json(),result=body?.chart?.result?.[0];if(!result)throw Error(body?.chart?.error?.description||`ไม่มีข้อมูล ${symbol} จาก Yahoo Finance`);return result}
async function yahooSearch(query){const endpoint=new URL('https://query1.finance.yahoo.com/v1/finance/search');endpoint.searchParams.set('q',query);endpoint.searchParams.set('quotesCount','20');endpoint.searchParams.set('newsCount','0');const response=await fetch(endpoint,{headers:{'user-agent':'Mozilla/5.0 SETscope stock search','accept':'application/json'},signal:AbortSignal.timeout(9000)});if(!response.ok)throw Error(`Yahoo Finance search HTTP ${response.status}`);const body=await response.json();return(body.quotes||[]).filter(q=>/\.BK$/i.test(q.symbol||'')&&q.quoteType==='EQUITY').slice(0,12).map(q=>({symbol:q.symbol.replace(/\.BK$/i,''),name:q.longname||q.shortname||q.symbol.replace(/\.BK$/i,''),exchange:q.exchange||'SET',type:q.quoteType}))}
function shapeChart(result,symbol){const q=result.indicators?.quote?.[0]||{},timestamps=result.timestamp||[],bars=timestamps.map((time,i)=>({time:time*1000,open:q.open?.[i]??null,high:q.high?.[i]??null,low:q.low?.[i]??null,close:q.close?.[i]??null,volume:q.volume?.[i]??null})).filter(x=>x.close!==null);const meta=result.meta||{},last=meta.regularMarketPrice??bars.at(-1)?.close??null,prior=meta.chartPreviousClose??meta.previousClose??null;return{symbol,last,prior,time:(meta.regularMarketTime?meta.regularMarketTime*1000:bars.at(-1)?.time)||null,fullName:meta.longName||meta.shortName||symbol,currency:meta.currency||'THB',high:meta.regularMarketDayHigh??null,low:meta.regularMarketDayLow??null,volume:meta.regularMarketVolume??null,exchange:meta.fullExchangeName||'SET',marketState:meta.marketState||'UNKNOWN',history:bars}}
async function getSetTurnoverMillionBaht(){
 if(!process.env.SET_API_KEY)return null;
 const endpoint=new URL('https://marketplace.set.or.th/api/public/delay-data/index');endpoint.searchParams.set('market','SET');
 const response=await fetch(endpoint,{headers:{'api-key':process.env.SET_API_KEY,'accept':'application/json'},signal:AbortSignal.timeout(7000)});
 if(!response.ok)throw Error(`SET delayed index API HTTP ${response.status}`);
 const payload=await response.json();
 const findRecord=value=>{if(Array.isArray(value)){for(const item of value){const found=findRecord(item);if(found)return found}return null}if(value&&typeof value==='object'){if(String(value.symbol||'').toUpperCase()==='SET')return value;for(const child of Object.values(value)){const found=findRecord(child);if(found)return found}}return null};
 const row=findRecord(payload),total=Number(row?.totalValue??row?.value);
 return Number.isFinite(total)&&total>=0?total/1_000_000:null;
}
async function getMarket(symbols,active,range){
 const [rangeName,interval]=periods[range]||periods['1D'];
 const base=await Promise.allSettled(symbols.map(async symbol=>shapeChart(await yahooChart(symbol+'.BK','1d','5m'),symbol)));
 const stocks=base.filter(x=>x.status==='fulfilled').map(x=>x.value);
 const errors=base.filter(x=>x.status==='rejected').map(x=>x.reason.message);
 if(!stocks.length)throw Error(errors.join(' · ')||'Yahoo Finance ยังไม่คืนข้อมูลหุ้นไทย');
 const indexTry=await Promise.allSettled([yahooChart('^SET.BK','1d','5m')]);
 let index=null;
 if(indexTry[0].status==='fulfilled')index=shapeChart(indexTry[0].value,'SET');else errors.push(indexTry[0].reason.message);
 let turnoverMillionBaht=null;
 if(process.env.SET_API_KEY){try{turnoverMillionBaht=await getSetTurnoverMillionBaht()}catch(error){errors.push(`SET turnover: ${error.message}`)}}
 if(index)index.turnoverMillionBaht=turnoverMillionBaht;
 let selected=stocks.find(x=>x.symbol===active);
 if(selected&&(rangeName!=='1d'||interval!=='5m')){try{const hist=shapeChart(await yahooChart(active+'.BK',rangeName,interval),active);selected={...selected,history:hist.history}}catch(e){errors.push(e.message)}}
 let levelsHistory=[];
 if(selected&&rangeName==='1y'&&interval==='1d')levelsHistory=selected.history;
 else if(selected){try{levelsHistory=await getLevelsHistory(active)}catch(e){errors.push(`แนวรับ/แนวต้าน: ${e.message}`)}}
 return{stocks,indices:index?[index]:[],history:selected?.history||[],levelsHistory,fetchedAt:new Date().toISOString(),provider:'Yahoo Finance',delayMinutes:15,errors}
}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(req.method!=='GET'){res.writeHead(405);return res.end('Method Not Allowed')}
 if(url.pathname==='/healthz'){return send(res,200,{ok:true,service:'setscope',time:new Date().toISOString()})}
 if(url.pathname==='/api/auth-config'){return send(res,200,{configured:authConfigured,url:authConfigured?process.env.SUPABASE_URL.replace(/\/$/,''):null,anonKey:authConfigured?process.env.SUPABASE_ANON_KEY:null})}
 if(url.pathname.startsWith('/api/')&&!await requireUser(req,res))return;
 if(url.pathname==='/api/search'){const q=(url.searchParams.get('q')||'').trim().slice(0,80);if(q.length<1)return send(res,200,{items:[]});try{send(res,200,{items:await yahooSearch(q),provider:'Yahoo Finance'})}catch(e){send(res,502,{error:e.message,items:[]})}return}
 if(url.pathname==='/api/market'){try{const symbols=(url.searchParams.has('symbols')?url.searchParams.get('symbols'):'PTT,AOT,ADVANC,KBANK,CPALL').split(',').map(s=>s.trim().toUpperCase()).filter(s=>/^[A-Z0-9&.-]{1,20}$/.test(s)).slice(0,30);const active=(url.searchParams.get('symbol')||symbols[0]||'PTT').toUpperCase();if(!/^[A-Z0-9&.-]{1,20}$/.test(active))return send(res,400,{error:'ชื่อย่อหุ้นไม่ถูกต้อง'});if(!symbols.includes(active))symbols.push(active);const range=url.searchParams.get('range')||'1D';send(res,200,await getMarket(symbols,active,range))}catch(e){send(res,502,{error:e.message})}return}
 if(url.pathname==='/api/news'){try{const d=await getNews();send(res,200,d)}catch(e){send(res,502,{error:e.message})}return}
 let pathname=decodeURIComponent(url.pathname);if(pathname==='/')pathname='/index.html';const file=path.resolve(ROOT,'.'+pathname);if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end('Forbidden')}fs.readFile(file,(e,data)=>{if(e){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return res.end('Not found')}res.writeHead(200,{'content-type':TYPES[path.extname(file)]||'application/octet-stream','cache-control':'no-cache'});res.end(data)})
});
server.listen(PORT,HOST,()=>console.log(`SETscope running at http://${HOST}:${PORT}`));
