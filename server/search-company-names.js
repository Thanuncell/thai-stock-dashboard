'use strict';
const {normalizeSymbol}=require('../lib/validation');

function englishCompanyName(value){
 if(typeof value!=='string'||value!==value.trim()||value.length<4||value.length>200
  ||!/[A-Za-z]/.test(value)||/[<>\p{Cc}\p{Cf}]/u.test(value)||/\p{Script=Thai}/u.test(value))return null;
 return value;
}
function sourceUrl(value){
 try{const url=new URL(value);return typeof value==='string'&&value.length<=600&&url.protocol==='https:'
  &&!url.username&&!url.password&&!/(^|\.)yahoo\.[a-z.]+$/i.test(url.hostname)?value:null;}catch{return null;}
}
function registryCompanyName(row){
 const name=englishCompanyName(row?.company_name_en),checked=Date.parse(row?.name_checked_at||'');
 return name&&name!==row.symbol&&sourceUrl(row.name_source)&&Number.isFinite(checked)&&checked<=Date.now()?name:null;
}

// Offline preparation only: no provider calls, credentials, database connection or automatic persistence.
// Records must be reviewed against the original source and its permission evidence before preparation.
function prepareCompanyNameImport({registry,records,now=Date.now()}={}){
 if(!Array.isArray(registry)||!Array.isArray(records)||!records.length||records.length>1000)throw Error('Invalid name import');
 const bySymbol=new Map();
 for(const row of registry){if(!normalizeSymbol(row.symbol)||bySymbol.has(row.symbol))throw Error('Duplicate or invalid registry identity');bySymbol.set(row.symbol,row);}
 const seen=new Set(),changes=[];
 for(const record of records){
  const row=bySymbol.get(record.symbol),name=englishCompanyName(record.company_name_en);
  if(!row||seen.has(record.symbol)||record.symbol!==normalizeSymbol(record.symbol)||!row.active
   ||['inactive','unsupported'].includes(row.status)||row.provider!=='Yahoo Finance'
   ||row.provider_symbol!==record.symbol+'.BK'||record.provider_symbol!==row.provider_symbol)throw Error('Duplicate or incorrect symbol mapping');
  seen.add(record.symbol);
  const checked=Date.parse(record.name_checked_at||'');
  if(!name||name===record.symbol||!sourceUrl(record.name_source)||!sourceUrl(record.identity_evidence)
   ||!sourceUrl(record.rights_evidence)||record.storage_allowed!==true||record.display_allowed!==true
   ||!Number.isFinite(checked)||checked>now)throw Error('Unreviewed company name, identity or storage/display permission');
  const before={company_name_en:row.company_name_en??null,name_source:row.name_source??null,name_checked_at:row.name_checked_at??null};
  const after={company_name_en:name,name_source:record.name_source,name_checked_at:new Date(checked).toISOString()};
  changes.push({symbol:record.symbol,provider_symbol:row.provider_symbol,before,after});
 }
 const literal=value=>value===null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
 const statements=reverse=>changes.map(change=>{
  const from=reverse?change.after:change.before,to=reverse?change.before:change.after;
  const body=`DECLARE changed integer; BEGIN UPDATE public.security_coverage SET ${Object.entries(to).map(([key,value])=>key+'='+literal(value)).join(',')}`
   +` WHERE symbol=${literal(change.symbol)} AND provider_symbol=${literal(change.provider_symbol)} AND provider='Yahoo Finance' AND active=true`
   +` AND status NOT IN ('inactive','unsupported') AND ${Object.entries(from).map(([key,value])=>key+' IS NOT DISTINCT FROM '+literal(value)).join(' AND ')};`
   +" GET DIAGNOSTICS changed = ROW_COUNT; IF changed <> 1 THEN RAISE EXCEPTION 'Name import identity/state changed; review again'; END IF; END;";
  return 'DO '+literal(body)+';';
 }).join('\n');
 const wrap=sql=>"BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"+sql+'\nCOMMIT;\n';
 return {changes,sql:wrap(statements(false)),rollbackSql:wrap(statements(true))};
}
module.exports={englishCompanyName,registryCompanyName,prepareCompanyNameImport};
