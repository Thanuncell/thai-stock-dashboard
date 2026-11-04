'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./fixtures/technical-reference.json');
for(const entry of fixture.cases)test(`locked independent TA-Lib reference: ${entry.name}`,async()=>{
 const {computeTechnicalSeries}=await import('../client/domain.mjs');
 const actual=computeTechnicalSeries(entry.rows);let compared=0;
 const compare=(got,want,path)=>{
  if(Array.isArray(want)){assert.equal(got.length,want.length,path);want.forEach((v,i)=>{if(v===null)assert.equal(got[i],null,`${path}[${i}] warm-up`);else {assert.ok(Number.isFinite(got[i]),path);assert.ok(Math.abs(got[i]-v)<=1e-8*Math.max(1,Math.abs(v)),`${path}[${i}] ${got[i]} != ${v}`);compared++;}});}
  else for(const [key,value]of Object.entries(want))compare(got[key],value,path+'.'+key);
 };
 compare(actual,entry.expected,entry.name);assert.ok(compared>2000);
});
