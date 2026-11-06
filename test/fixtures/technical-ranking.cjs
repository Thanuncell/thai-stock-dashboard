'use strict';
// Synthetic OHLC evidence for ranking, never a market-data fallback.
function rankingRows(range='1Y'){
 const step=range==='1D'?60000:range==='1W'?900000:range==='1M'?1800000:range==='3M'?3600000:86400000,start=Date.UTC(2025,0,1,3);
 const rows=Array.from({length:200},(_,i)=>({time:start+i*step,open:39.5,close:39.5,high:41-i*.001,low:37.5+i*.001,volume:1000}));
 for(const [indices,field,value]of [[[20,35,45],'low',35],[[50,65],'low',35.25],[[80],'low',36.25],[[110,120,130],'high',41.25],[[140,150],'high',42],[[170],'high',41.75]])for(const i of indices)rows[i][field]=value;
 return rows;
}
function roleRankingRows(){return Array.from({length:45},(_,i)=>{
 const close=i>=35?112:100;
 return {time:Date.UTC(2026,9,20,3)+i*60000,open:close,close,high:i===25?110:close+2,low:i===38?110:i===25?90:close-2,volume:1000};
});}
function scarceRows(){const rows=Array.from({length:40},(_,i)=>({time:Date.UTC(2025,0,1,3)+i*60000,open:39.5,close:39.5,high:39.5,low:39.5,volume:1000}));Object.assign(rows.at(-2),{high:50,low:10,close:40});return rows;}
module.exports={rankingRows,roleRankingRows,scarceRows};
