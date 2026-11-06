import { analyseTechnicals,computeTechnicalSeries,normalizeTechnicalParameters,trustedMarketBars,findPriceLevels,toFiniteNumber } from './domain.mjs';
import * as timeModule from '../lib/market-time.js';
const {temporalBars}=timeModule.default||globalThis.SETscopeMarketTime;
export const TECHNICAL_VERSION='setscope-ta-2';
export const RANGE_INTERVAL=Object.freeze({'1D':'1m','1W':'15m','1M':'30m','3M':'60m','1Y':'1d'});
export const INDICATOR_PRESETS=Object.freeze({basic:['sma20','ema20','ema50','macd'],trend:['sma20','ema20','ema50','ema100','ema200'],momentum:['macd','rsi'],volatility:['bb','atr']});
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const sign=v=>v>0?1:v<0?-1:0;
const side=v=>v>0?'ซื้อ':v<0?'ขาย':'เป็นกลาง';
const mean=values=>values.length&&values.every(finite)?values.reduce((a,b)=>a+b,0)/values.length:null;
const frozen=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
function fingerprint(value){let hash=2166136261;for(const char of JSON.stringify(value)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16);}
function clock(value){const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)&&n>0?n:null;}

export function confirmedSwings(rows,{asOf=Infinity,left=2,right=2}={}){
 const confirmed=[],pending=[];
 for(let i=left;i<rows.length;i++){
  for(const [type,field,compare] of [['support','low',(a,b)=>a<=b],['resistance','high',(a,b)=>a>=b]]){
   const price=toFiniteNumber(rows[i][field]);if(!(price>0))continue;
   if(!rows.slice(i-left,i).every(row=>compare(price,row[field])))continue;
   const following=rows.slice(i+1,i+right+1),confirm=rows[i+right];
   if(following.some(row=>!compare(price,row[field])))continue;
   const value={type,price,time:rows[i].time,confirmedAt:clock(confirm?.availableAt),left,right};
   if(following.length===right&&confirm?.complete&&value.confirmedAt<=asOf)confirmed.push(value);
   else pending.push({...value,confirmedAt:null});
  }
 }
 return {confirmed,pending};
}

export function priceStructure(rows,last,{asOf=Infinity,candleTime=Infinity,interval='1d',atr=null}={}){
 const completed=rows.filter(row=>row.complete&&clock(row.availableAt)!==null&&row.availableAt<=asOf&&row.time<=candleTime).slice(-260);
 const swings=confirmedSwings(completed,{asOf});
 // Existing nearest-level separation is retained as an upper bound. ATR only
 // narrows the zone; every centre is an actual confirmed swing price.
 const width=Math.max(last*1e-7,Math.min(last*.005,finite(atr)&&atr>0?atr*.25:last*.005));
 const zones=[];
 for(const swing of swings.confirmed){
  let zone=zones.find(z=>z.type===swing.type&&Math.abs(z.value-swing.price)<=width);
  if(!zone){zone={type:swing.type,value:swing.price,low:swing.price-width/2,high:swing.price+width/2,source:swing.type==='support'?'Swing low':'Swing high',
    confirmedAt:swing.confirmedAt,referenceTime:swing.time,referenceInterval:interval,swings:[],events:[],state:'confirmed'};zones.push(zone);}
  zone.swings.push(swing);
 }
 for(const zone of zones){
  let previousEvent=-3,breakDirection=0;
  for(let i=0;i<completed.length;i++){
   const bar=completed[i];if(bar.availableAt<=zone.confirmedAt||i-previousEvent<3)continue;
   const referenceVolume=completed.slice(Math.max(0,i-20),i).map(row=>toFiniteNumber(row.volume));
   const volumeBaseline=referenceVolume.length===20?mean(referenceVolume):null;
   const volumeConfirmed=volumeBaseline>0&&bar.volume>0&&bar.volume>=volumeBaseline;
   const broken=zone.type==='support'?bar.close<zone.low:bar.close>zone.high;
   const touched=bar.low<=zone.high&&bar.high>=zone.low;
   if(!breakDirection&&broken){
    const direction=zone.type==='support'?-1:1;
    zone.events.push({kind:volumeConfirmed?'breakout-confirmed':'breakout-pending-volume',time:bar.time,confirmedAt:bar.availableAt,direction,volume:bar.volume,volumeBaseline});
    zone.state=volumeConfirmed?'breakout-confirmed':'breakout-pending-volume';if(volumeConfirmed)breakDirection=direction;previousEvent=i;
   }else if(touched){
    const held=zone.type==='support'?bar.close>=zone.value:bar.close<=zone.value;
    const retest=breakDirection&&(breakDirection>0?bar.close>zone.high:bar.close<zone.low);
    if(retest||held){zone.events.push({kind:retest?'retest-confirmed':'reaction',time:bar.time,confirmedAt:bar.availableAt,direction:retest?breakDirection:zone.type==='support'?1:-1,volume:bar.volume,volumeBaseline});previousEvent=i;if(retest)zone.state='retest-confirmed';}
   }
  }
 }
 // Classic Pivot is explicitly the previous completed reference-interval bar,
 // never the current candle. This is a session pivot only for a daily reference.
 const prior=completed.filter(row=>row.time<candleTime);
 const legacy=findPriceLevels(prior,last);
 const select=(type,legacyDetails)=>{
  const roleEvidence=z=>z.events.findLast(event=>['breakout-confirmed','retest-confirmed'].includes(event.kind)&&event.direction===(type==='support'?1:-1));
  const onSide=value=>type==='support'?value<last:value>last;
  const candidates=zones.filter(z=>onSide(z.value)&&(z.type===type||roleEvidence(z))).map(z=>({
   ...z,originalType:z.type,roleConfirmation:z.type===type?null:roleEvidence(z),
   ...(z.type===type?{}:{sourceLabel:`${z.source} → ${type==='support'?'แนวรับ':'แนวต้าน'} (กลับบทบาทยืนยัน)`})
  }));
  for(const detail of legacyDetails.filter(d=>d.source==='Classic Pivot')){
   if(onSide(detail.value)&&candidates.every(z=>Math.abs(z.value-detail.value)>width))candidates.push({...detail,confirmedAt:prior.at(-1)?.availableAt??null,referenceTime:prior.at(-1)?.time??null,referenceInterval:interval,state:'previous-completed-period',events:[]});
  }
  // Rank the complete eligible pool by price relative to the confirmed signal
  // close. Reactions only break equal-price ties; never promote a farther level.
  const strength=z=>z.events.filter(e=>e.kind==='reaction'||e.kind==='retest-confirmed').length;
  candidates.sort((a,b)=>(type==='support'?b.value-a.value:a.value-b.value)||strength(b)-strength(a)||(a.confirmedAt??0)-(b.confirmedAt??0));
  const chosen=[];
  for(const candidate of candidates){
   if(chosen.every(z=>Math.abs(z.value-candidate.value)>width))chosen.push(candidate);
   if(chosen.length===3)break;
  }
  return chosen.map((z,i)=>({...z,type,rank:i+1}));
 };
 const supportDetails=select('support',legacy.supportDetails),resistanceDetails=select('resistance',legacy.resistanceDetails);
 return {supports:supportDetails.map(z=>z.value),resistances:resistanceDetails.map(z=>z.value),supportDetails,resistanceDetails,zones,swings,width,referenceInterval:interval};
}

export function createTechnicalSnapshot({history=[],indicatorHistory=history,levelsHistory=history,symbol='',timeframe='1M',fetchedAt=null,technicalMeta={},parameters={},dataState='unknown',guardReasons=[]}={}){
 const p=normalizeTechnicalParameters(parameters),interval=RANGE_INTERVAL[timeframe]||'1d';
 const meta=technicalMeta.indicator||technicalMeta.history||{};
 let invalidTimeZone=false;
 try{new Intl.DateTimeFormat('en-CA',{timeZone:meta.timeZone||'Asia/Bangkok'});}catch{invalidTimeZone=true;}
 const observedAt=clock(meta.receivedAt)||clock(fetchedAt);
 const receivedAt=clock(technicalMeta.history?.receivedAt)||observedAt;
 const visible=trustedMarketBars(history).filter(row=>clock(row.time)!==null&&(observedAt===null||row.time<=observedAt));
 const visibleCandleTime=visible.at(-1)?.time??null;
 const mismatch=Boolean(meta.interval&&meta.interval!==interval);
 const rows=temporalBars(mismatch?[]:trustedMarketBars(indicatorHistory).filter(row=>clock(row.time)!==null&&visibleCandleTime!==null&&row.time<=visibleCandleTime),{
  interval,observedAt,regularStart:meta.regularStart,regularEnd:meta.regularEnd,timeZone:meta.timeZone
 });
 const levelMeta=technicalMeta.levels||meta,levelInterval=levelMeta.interval||interval;
 const timedLevels=temporalBars(trustedMarketBars(levelsHistory).filter(row=>clock(row.time)!==null&&(observedAt===null||row.time<=observedAt)),{interval:levelInterval,observedAt,regularStart:levelMeta.regularStart,regularEnd:levelMeta.regularEnd,timeZone:levelMeta.timeZone});
 // Chart series retain real provisional prices. Confirmed signals use only the
 // latest available closed candle and its confirmed prefix, never that draft.
 const latestCandle=rows.at(-1)||null;
 const signalRows=rows.filter(row=>row.complete&&row.availableAt<=observedAt),latest=signalRows.at(-1);
 const candleTime=latest?.time??null,asOf=latest?.availableAt??0;
 const signalReference=latest?{barOpenTime:latest.barOpenTime,barCloseTime:latest.barCloseTime,availableAt:latest.availableAt,confirmationBasis:latest.confirmationBasis,
  selection:latest.time===latestCandle.time?'latest-confirmed':'previous-confirmed'}:null;
 const completedLevels=timedLevels.filter(row=>row.complete&&row.availableAt<=asOf&&row.time<=candleTime);
 const analysis=analyseTechnicals(signalRows,completedLevels,p),signalSeries=analysis?.series||computeTechnicalSeries(signalRows,p);
 const series=signalRows.length===rows.length?signalSeries:computeTechnicalSeries(rows,p);
 const last=latest?.close??null,atr=signalSeries.atr.at(-1)??null;
 const levels=last===null?{supports:[],resistances:[],supportDetails:[],resistanceDetails:[],zones:[],swings:{confirmed:[],pending:[]}}:priceStructure(timedLevels,last,{asOf,candleTime,interval:levelInterval,atr});
 const warnings=[...new Set([...guardReasons,...(meta.historyReasons||[]),...(mismatch?['INTERVAL_MISMATCH']:[]),...(invalidTimeZone?['EXCHANGE_TIMEZONE_INVALID']:[]),...(meta.corporateActionCount?['CORPORATE_ACTION_REVIEW']:[]),...(['stale','suspect','quarantined','unavailable'].includes(dataState)?['SOURCE_'+dataState.toUpperCase()]:[])])];
 const confirmation=latest?.complete?'confirmed':'provisional';
 const quality={state:mismatch?'unavailable':rows.length?'usable-with-warnings':'insufficient',warnings};
 if(rows.length&&!warnings.length)quality.state='usable';
 const required={sma20:p.sma,ema20:p.ema20,ema50:p.ema50,ema100:p.ema100,ema200:p.ema200,rsi:p.rsi+1,macd:p.macdSlow+p.macdSignal-1,bb:p.bb,atr:p.atr+1};
 const latestValue=key=>key==='bb'?signalSeries.bb.middle.at(-1):key==='macd'?signalSeries.signal.at(-1):signalSeries[key]?.at(-1);
 const availability=Object.fromEntries(Object.entries(required).map(([key,bars])=>[key,{state:finite(latestValue(key))?'available':'insufficient',bars:signalRows.length,required:bars,confirmation}]));
 const common={version:TECHNICAL_VERSION,symbol,timeframe,candleTime,confirmation,dataQuality:quality.state};
 const trendValues=['sma20','ema20','ema50','ema100','ema200'].map(key=>signalSeries[key].at(-1)).filter(finite);
 const trend=sign(trendValues.reduce((sum,value)=>sum+sign(last-value),0));
 const rsi=signalSeries.rsi.at(-1)??null,macd=signalSeries.macd.at(-1)??null,signal=signalSeries.signal.at(-1)??null;
 const rsiVote=rsi===null?0:rsi<30?1:rsi>70?-1:0,macdVote=macd===null||signal===null?0:sign(macd-signal);
 const momentum=sign(rsiVote+macdVote);
 const recentBreak=levels.zones.flatMap(z=>z.events).filter(e=>['breakout-confirmed','retest-confirmed'].includes(e.kind)&&e.confirmedAt===latest?.availableAt).at(-1);
 const structure=recentBreak?.direction||0;
 const score=trend+momentum+structure;
 const critical=warnings.some(w=>['HISTORICAL_ANOMALY','CORPORATE_ACTION_REVIEW','INTERVAL_MISMATCH','EXCHANGE_TIMEZONE_INVALID','SYMBOL_MISMATCH','MARKET_MISMATCH','SYMBOL_UNVERIFIED','INVALID_TIMESTAMP','FUTURE_TIMESTAMP','DATA_ANOMALY','INVALID_OHLC'].includes(w)||w.startsWith('SOURCE_'));
 const requiredBars=Math.max(30,p.sma,p.rsi+1,p.macdSlow+p.macdSignal-1);
 const status=critical?'data-review':signalRows.length>=requiredBars&&analysis?'ready':rows.length<requiredBars||signalRows.length>0?'insufficient':'waiting-close';
 const actionable=status==='ready';
 const overall=actionable?side(score>=2?1:score<=-2?-1:0):status==='data-review'?'ข้อมูลต้องตรวจสอบ':status==='waiting-close'?'รอแท่งปิด':'ข้อมูลไม่เพียงพอ';
 const number=value=>finite(value)?Number(value.toPrecision(7)).toString():'—';
 const referenceVolume=signalRows.slice(-21,-1).map(row=>toFiniteNumber(row.volume));
 const volumeBaseline=referenceVolume.length===20?mean(referenceVolume):null,volumeRatio=volumeBaseline>0&&finite(latest?.volume)?latest.volume/volumeBaseline:null;
 const reasons=[
  {...common,ruleId:'TREND-MA-GROUP-1',group:'trend',direction:trend,text:`แนวโน้ม: ราคา ${number(last)} เทียบค่าเฉลี่ยที่พร้อม ${trendValues.length} เส้น · ${side(trend)}`,values:{last,averages:trendValues}},
  {...common,ruleId:'MOMENTUM-RSI-MACD-1',group:'momentum',direction:momentum,text:`โมเมนตัม: RSI ${number(rsi)} · MACD ${number(macd)} / Signal ${number(signal)}${rsiVote&&macdVote&&rsiVote!==macdVote?' · หลักฐานขัดแย้งกัน':''}`,values:{rsi,macd,signal,rsiVote,macdVote}},
  levels.supports.length||levels.resistances.length?{...common,ruleId:'STRUCTURE-CONFIRMED-1',group:'structure',direction:structure,text:`โครงสร้างราคา: แนวรับ ${number(levels.supports[0])} · แนวต้าน ${number(levels.resistances[0])}${recentBreak?' · '+recentBreak.kind:' · รอการทะลุ/ทดสอบยืนยัน'}`,values:{support:levels.supports[0]??null,resistance:levels.resistances[0]??null,event:recentBreak||null}}
   :{...common,ruleId:'VOLATILITY-CONTEXT-1',group:'volatility',direction:0,text:`ความผันผวน: ATR ${number(atr)} · ปริมาณเทียบ 20 แท่งก่อน ${number(volumeRatio)} เท่า (ไม่ใช่สัญญาณซื้อขาย)`,values:{atr,volumeRatio}}
 ];
 const crosses=[];
 for(let i=1;i<signalRows.length;i++){
  if(!finite(signalSeries.histogram[i])||!finite(signalSeries.histogram[i-1]))continue;
  const before=signalSeries.histogram[i-1],after=signalSeries.histogram[i];
  if(before<=0&&after>0||before>=0&&after<0)crosses.push({kind:'MACD_SIGNAL_CROSS',direction:sign(after),candleTime:signalRows[i].time,confirmedAt:signalRows[i].availableAt});
  if(finite(signalSeries.macd[i-1])&&(signalSeries.macd[i-1]<=0&&signalSeries.macd[i]>0||signalSeries.macd[i-1]>=0&&signalSeries.macd[i]<0))crosses.push({kind:'MACD_ZERO_CROSS',direction:sign(signalSeries.macd[i]),candleTime:signalRows[i].time,confirmedAt:signalRows[i].availableAt});
 }
 const id=TECHNICAL_VERSION+':'+fingerprint([symbol,timeframe,rows.map(row=>[row.time,row.close,row.high,row.low,row.volume,row.complete,row.availableAt]),signalReference,p,warnings]);
 return frozen({id,...common,interval,asOf,observedAt,receivedAt,latestCandle,signalReference,signalRows,signalSeries,priceBasis:meta.priceBasis||'provider-quote-ohlc',adjustment:meta.adjustment||'unverified',parameters:p,rows,series,availability,levels,
  analysis:analysis?{...analysis,levels}:null,summary:{overall,actionable,status,requiredBars,score,groups:{trend,momentum,structure},reasons},crosses,volume:{baseline:volumeBaseline,ratio:volumeRatio},quality});
}
