'use strict';

const {createHash,createHmac,randomBytes,timingSafeEqual}=require('node:crypto');
const MAX_CURSOR_LENGTH=512;
const VERSION=1;
const digest=scope=>createHash('sha256').update(String(scope)).digest('base64url');
const validInteger=(value,positive=false)=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n&&(!positive||BigInt(value)>0n);
function validTimestamp(value){
  if(typeof value!=='string')return false;
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
  if(!match||!Number.isFinite(Date.parse(value)))return false;
  const [,year,month,day,hour,minute,second,,zone]=match;
  const days=new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
  return Number(year)>=1000&&Number(month)>=1&&Number(month)<=12&&Number(day)>=1&&Number(day)<=days
    &&Number(hour)<24&&Number(minute)<60&&Number(second)<60
    &&(zone==='Z'||Number(zone.slice(1,3))<=14&&Number(zone.slice(4))<60&&(Number(zone.slice(1,3))!==14||zone.slice(4)==='00'));
}

/**
 * Opaque, scope-bound keyset position for the existing query-index order.
 * This token is not an authorization credential. The API must still enforce
 * authentication, publisher/quality policy, and exclusions on every request.
 * Preserve fractional timestamp precision: PostgreSQL may provide microseconds.
 */
function encodeNewsArchiveCursor({publishedAt,id,scope,indexRevision}){
  const stamp=String(publishedAt||''),orderId=String(id||''),revision=String(indexRevision??'');
  if(!validTimestamp(stamp)||!validInteger(orderId,true)||!validInteger(revision)||typeof scope!=='string'||!scope)throw Error('NEWS_ARCHIVE_CURSOR_INVALID');
  const token=Buffer.from(JSON.stringify({v:VERSION,t:stamp,i:orderId,s:digest(scope),r:revision})).toString('base64url');
  if(token.length>MAX_CURSOR_LENGTH)throw Error('NEWS_ARCHIVE_CURSOR_INVALID');
  return token;
}

function decodeNewsArchiveCursor(token,{scope,indexRevision}){
  if(typeof token!=='string'||!token.length||token.length>MAX_CURSOR_LENGTH||!/^[A-Za-z0-9_-]+$/.test(token))throw Error('NEWS_ARCHIVE_CURSOR_INVALID');
  let value;
  try{const bytes=Buffer.from(token,'base64url');if(bytes.toString('base64url')!==token)throw Error();value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('NEWS_ARCHIVE_CURSOR_INVALID');}
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='i,r,s,t,v'||value.v!==VERSION||!validTimestamp(value.t)||!validInteger(value.i,true)||typeof value.s!=='string'||!validInteger(value.r)||typeof scope!=='string'||!scope||!validInteger(String(indexRevision??'')))throw Error('NEWS_ARCHIVE_CURSOR_INVALID');
  if(value.s!==digest(scope))throw Error('NEWS_ARCHIVE_CURSOR_SCOPE_CHANGED');
  if(value.r!==String(indexRevision??''))throw Error('NEWS_ARCHIVE_CURSOR_INDEX_CHANGED');
  return {publishedAt:value.t,id:value.i};
}
// Per-service process memory only: no new environment setting, persistent key or
// checkpoint store. A restart retires the session's positions; auth is independent.
function createNewsArchiveCursorCodec(){
 const key=randomBytes(32);
 const invalid=()=>{throw Error('NEWS_ARCHIVE_CURSOR_INVALID');};
 const pack=(kind,value)=>{
  const body=kind+'.'+Buffer.from(JSON.stringify(value)).toString('base64url');
  return body+'.'+createHmac('sha256',key).update(body).digest('base64url');
 };
 const unpack=(token,kind,limit)=>{
  if(typeof token!=='string'||token.length>limit)return invalid();
  const parts=token.split('.');if(parts.length!==3||parts[0]!==kind||!/^[A-Za-z0-9_-]+$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))return invalid();
  const expected=createHmac('sha256',key).update(parts[0]+'.'+parts[1]).digest(),actual=Buffer.from(parts[2],'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return invalid();
  try{return JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}catch{return invalid();}
 };
 return {
  context: value=>pack('c2',value),
  readContext: token=>unpack(token,'c2',2048),
  position({publishedAt,id,page},context){
   if(!validTimestamp(publishedAt)||!validInteger(String(id),true)||!Number.isSafeInteger(page)||page<1||page>100000)return invalid();
   return pack('p2',{t:publishedAt,i:String(id),p:page,c:context});
  },
  readPosition(token,context){
   const value=unpack(token,'p2',512);
   if(!value||Object.keys(value).sort().join(',')!=='c,i,p,t'||!validTimestamp(value.t)||!validInteger(value.i,true)||!Number.isSafeInteger(value.p)||value.p<1||value.p>100000)return invalid();
   if(value.c!==context)throw Error('NEWS_ARCHIVE_CURSOR_SCOPE_CHANGED');
   return {publishedAt:value.t,id:value.i,page:value.p};
  }
 };
}
module.exports={encodeNewsArchiveCursor,decodeNewsArchiveCursor,createNewsArchiveCursorCodec};
