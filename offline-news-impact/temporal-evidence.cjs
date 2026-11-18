'use strict';
// Narrow, deterministic comparison-clause check. No clock/year blacklist or NLP.
function comparisonOnlyEvidence(article,evidence){
  const ranges=[];const start=/ขณะที่ช่วงเดียวกันของปีก่อน/g;let match;
  while((match=start.exec(article))){
    const after=match.index+match[0].length;
    const boundary=article.slice(after).search(/ (?:อย่างไรก็ตาม|นอกจากนี้|ทั้งนี้|สำหรับ|ขณะเดียวกัน|ส่วนผล|แต่ปัจจุบัน|แต่ปีนี้|แต่งวดนี้|แต่ไตรมาสนี้)/);
    ranges.push([match.index,boundary<0?article.length:after+boundary]);
  }
  const occurrences=[];let from=0,index;
  while((index=article.indexOf(evidence,from))>=0){occurrences.push(index);from=index+Math.max(1,evidence.length);}
  return occurrences.length>0&&occurrences.every(offset=>ranges.some(([first,last])=>offset>=first&&offset+evidence.length<=last));
}
module.exports={comparisonOnlyEvidence};
