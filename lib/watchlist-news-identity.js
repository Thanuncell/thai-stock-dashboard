'use strict';
// Company identities reviewed against SEC listed-company profiles, 2026-10-27.
// SCB group/Thai Commercial Bank relationship: https://www.scbx.com/th/
const ALIASES = Object.freeze({
 PTT:['ปตท. จำกัด','PTT Public Company'],
 PTTEP:['ปตท.สผ.','ปตท.สำรวจและผลิตปิโตรเลียม','PTT Exploration and Production'],
 OR:['ปตท. น้ำมันและการค้าปลีก','โออาร์','ปตท.น้ำมันและการค้าปลีก','PTT Oil and Retail'],
 KBANK:['ธนาคารกสิกรไทย','กสิกรไทย','Kasikornbank'],
 BBL:['ธนาคารกรุงเทพ','Bangkok Bank'],
 SCB:['เอสซีบี เอกซ์','SCBX','SCB X','ธนาคารไทยพาณิชย์','Siam Commercial Bank'],
 KTB:['ธนาคารกรุงไทย','กรุงไทย','Krung Thai Bank','Krungthai Bank'],
 BAY:['ธนาคารกรุงศรีอยุธยา','กรุงศรีอยุธยา','Bank of Ayudhya'],
 TTB:['ธนาคารทหารไทยธนชาต','ทหารไทยธนชาต','TMBThanachart'],
 KKP:['ธนาคารเกียรตินาคินภัทร','เกียรตินาคินภัทร','Kiatnakin Phatra'],
 TISCO:['ทิสโก้ไฟแนนเชียลกรุ๊ป','ธนาคารทิสโก้','Tisco Financial Group']
});
const SOURCES=Object.fromEntries(Object.keys(ALIASES).map(symbol=>[symbol,'https://market.sec.or.th/public/idisc/th/companyprofile/listed/'+symbol]));
SOURCES.PTTEP='https://www.set.or.th/th/market/product/stock/quote/PTTEP/factsheet';
// Thai brand spelling: https://www.pttor.com/wp-content/uploads/2024/10/20230404_174113_8070.pdf
const escape=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function stockAliases(stock){return [...(ALIASES[stock.symbol]||[]),...(stock.verifiedName?[stock.verifiedName]:[])];}
function matchesWatchlistStock(stock,text){
 text=String(text||'');
 if(stockAliases(stock).some(name=>new RegExp('(?<![A-Za-z0-9])'+escape(name)+'(?![A-Za-z0-9])','i').test(text)))return true;
 if(stock.symbol==='OR')return /(?:หุ้น|บริษัท|บมจ\.?|stock|ticker)\s*[:(]?\s*OR\b|\bOR\s*[:–-]?\s*(?:หุ้น|กำไร|รายได้|ปันผล|ผลประกอบการ|รายงานผลประกอบการ|reports?\b|announces?\b|earnings\b|dividend\b)/.test(text);
 if(stock.symbol==='PTT')return /(?:^|[^A-Za-z0-9])PTT(?![A-Za-z0-9]|\s+(?:Oil|Exploration)\b)/i.test(text)||/ปตท\.(?!\s*(?:สผ|สำรวจ|น้ำมัน))/.test(text);
 if(stock.symbol==='PTTEP'&&/ปตท\.?\s*(?:สผ\.?|สำรวจและผลิตปิโตรเลียม)/.test(text))return true;
 if(stock.symbol.length<3)return new RegExp('(?:หุ้น|บริษัท)\\s*'+escape(stock.symbol)+'(?![A-Za-z0-9])').test(text);
 return new RegExp('(^|[^A-Za-z0-9])'+escape(stock.symbol)+'([^A-Za-z0-9]|$)','i').test(text);
}
function watchlistStockQuery(stock){
 const terms=[stock.symbol,...stockAliases(stock).slice(0,2)].map(value=>'"'+value.replace(/["\\]/g,' ')+'"').join(' OR ');
 return `(${terms}) หุ้น when:30d`;
}
module.exports={ALIASES,SOURCES,stockAliases,matchesWatchlistStock,watchlistStockQuery};
