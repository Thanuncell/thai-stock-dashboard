'use strict';
// Manual derived-index bootstrap/repair. No scheduler and no original-row writes.
const {createNewsArchiveService}=require('../server/news-archive-service');
(async()=>{
 const args=process.argv.slice(2),confirmed=args.find(x=>x.startsWith('--confirm-origin='))?.slice('--confirm-origin='.length);
 let origin;try{origin=new URL(process.env.SUPABASE_URL).origin;}catch{throw Error('Configured database origin required');}
 if(!args.includes('--apply-derived-index')||confirmed!==origin)throw Error('Explicit apply flag and matching confirmed origin required');
 if(!['read','write'].includes(process.env.SETSCOPE_NEWS_EVIDENCE))throw Error('Evidence-aware mode required for bootstrap');
 const archive=createNewsArchiveService({env:{...process.env,SETSCOPE_NEWS_ARCHIVE_QUERY:'on'}}),result=await archive.refreshQueryIndex({maxBatches:1000,batchSize:500,reset:args.includes('--reset-derived-index')});
 console.log(JSON.stringify({enabled:result.enabled,pending:result.pending,conflicts:result.conflicts}));if(result.pending!==0)process.exitCode=2;
})().catch(()=>{console.error('Archive query bootstrap unavailable; no original rows were changed by this tool.');process.exitCode=1;});
