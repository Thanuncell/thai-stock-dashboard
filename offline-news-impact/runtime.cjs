'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createService,Lane}=require('./service.cjs');
const {createCoverageCatalog}=require('./coverage-catalog.cjs');
const assets=new Set(['ui.mjs','ui.css','preview.mjs','production.mjs','transport.mjs']);
function createImpactRuntime({repository,loadCatalog,reader,provider,lane=new Lane(),timeoutMs,entryModule='preview.mjs',canAnalyze=()=>true}){
  if(!['preview.mjs','production.mjs'].includes(entryModule))throw Error('INVALID_ENTRY_MODULE');
  const analyze=createService({authenticate:async request=>request.actor,loadCatalog:loadCatalog||createCoverageCatalog(repository),reader,provider,lane,timeoutMs});
  return{
    assetPath(pathname){const name=pathname.replace('/offline-news-impact/','');return pathname==='/offline-news-impact/'+name&&assets.has(name)?path.join(__dirname,name):null;},
    decorateIndex(data){return Buffer.from(data.toString().replace('</head>','<link rel="stylesheet" href="/offline-news-impact/ui.css"></head>').replace('</body>',`<script type="module" src="/offline-news-impact/${entryModule}"></script></body>`));},
    async handle(req,res,identity,send,readJson){
      if(!canAnalyze(identity?.user))return send(res,403,{code:'FEATURE_UNAVAILABLE'});
      if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return send(res,415,{code:'INVALID_INPUT'});
      let payload;try{payload=await readJson(req);}catch{return send(res,400,{code:'INVALID_JSON'});}
      try{return send(res,200,await analyze({actor:identity?.user},payload));}
      catch(error){const known=['INVALID_INPUT','INVALID_KEY','INVALID_URL','UNSAFE_URL','UNSAFE_DNS','REQUEST_CONFLICT','BUSY','CATALOG_UNAVAILABLE','COVERAGE_INCOMPLETE','EMPTY_ARTICLE','ARTICLE_TOO_LARGE','READER_RESTRICTED','READER_PAYWALL','READER_UNAVAILABLE','READER_PARSE','READER_TIMEOUT','READER_JS_REQUIRED','READER_DISABLED','READER_DNS','READER_CONTENT_TYPE','READER_REDIRECT_LIMIT','PROVIDER_FAILURE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_DISABLED','PROVIDER_CONFIG','PROVIDER_BLOCKED','INVALID_PROVIDER_JSON','INVALID_PROVIDER_OUTPUT','CONFLICTING_CLASSIFICATION'];const code=known.includes(error.code)?error.code:'SAFE_INTERNAL_ERROR';const status=code==='BUSY'||code==='PROVIDER_RATE_LIMIT'?429:code==='REQUEST_CONFLICT'?409:code==='CATALOG_UNAVAILABLE'||code==='COVERAGE_INCOMPLETE'?503:code.startsWith('PROVIDER_')?502:400;return send(res,status,{code});}
    }
  };
}
function createRuntimeServer({auth,...options}){
  if(typeof auth?.authorize!=='function')throw Error('EXISTING_AUTH_REQUIRED');
  const impact=createImpactRuntime(options),{handle}=require('../server.js');
  return http.createServer((req,res)=>{handle(req,res,auth,impact).catch(()=>{if(!res.headersSent){res.writeHead(500,{'content-type':'application/json'});res.end('{"code":"SAFE_INTERNAL_ERROR"}');}else res.end();});});
}
module.exports={createImpactRuntime,createRuntimeServer};
