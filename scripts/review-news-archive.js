'use strict';
const fs=require('node:fs');
const {planNewsArchiveCleanup}=require('../server/news-archive-service');
if(process.argv.length!==4)throw Error('Usage: node scripts/review-news-archive.js read-only-snapshot.json output.json');
const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!Array.isArray(rows)||rows.length>20000)throw Error('Invalid bounded archive snapshot');
const plan=planNewsArchiveCleanup(rows);
fs.writeFileSync(process.argv[3],JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({dryRun:plan.dryRun,totalRows:plan.totalRows,quarantined:plan.quarantined,rejected:plan.rejected,writes:0}));
