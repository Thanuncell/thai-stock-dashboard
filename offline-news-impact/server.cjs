'use strict';
// Isolated Phase 1 loopback composition. Existing production server is unchanged.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {createService,Lane}=require('./service.cjs');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
function createServer({auth,provider,reader,loadCatalog,lane=new Lane(),timeoutMs}={}){
  if(typeof auth?.authorize!=='function'||typeof auth?.configPayload!=='function')throw Error('SERVER_AUTH_REQUIRED');
  const analyze=createService({provider,reader,lane,loadCatalog,authenticate:async req=>req.impactIdentity,timeoutMs});
  const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/api/news-impact-phase1'){
        if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
        if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)return send(res,403,{code:'ORIGIN_REJECTED'});
        // Mandatory authentication BEFORE creating a job or reading payload identity.
        const context=await auth.authorize(req,res);if(!context)return;
        Object.defineProperty(req,'impactIdentity',{value:context.user});
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>85_000)return send(res,413,{code:'INPUT_TOO_LARGE'});}
        let payload;try{payload=JSON.parse(body);}catch{return send(res,400,{code:'INVALID_JSON'});}
        return send(res,200,await analyze(req,payload));
      }
      if(url.pathname==='/api/auth-config')return send(res,200,auth.configPayload(req));
      if(url.pathname.startsWith('/api/'))return send(res,503,{code:'LEGACY_API_NOT_STARTED'});
      const relative=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';
      if(!['index.html','app.js','auth.js','style.css','analysis.css'].includes(relative)&&!/^(client|lib|assets)\/[a-zA-Z0-9_./-]+$/.test(relative)&&!['offline-news-impact/ui.mjs','offline-news-impact/ui.css','offline-news-impact/preview.mjs','offline-news-impact/transport.mjs'].includes(relative))return send(res,404,{code:'NOT_FOUND'});
      const file=path.resolve(ROOT,relative),extension=path.extname(file);
      if(!file.startsWith(ROOT+path.sep)||relative.includes('..')||!MIME[extension]||!fs.existsSync(file))return send(res,404,{code:'NOT_FOUND'});
      let content=fs.readFileSync(file);
      if(relative==='index.html')content=Buffer.from(content.toString().replace('</head>','<link rel="stylesheet" href="/offline-news-impact/ui.css"></head>').replace('</body>','<script type="module" src="/offline-news-impact/preview.mjs"></script></body>'));
      res.writeHead(200,{'content-type':MIME[extension],'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(content);
    }catch(error){
      const allowed=['INVALID_INPUT','INVALID_URL','UNSAFE_URL','UNSAFE_DNS','UNAUTHORIZED','INVALID_KEY','REQUEST_CONFLICT','BUSY','EMPTY_ARTICLE','ARTICLE_TOO_LARGE','READER_RESTRICTED','READER_PAYWALL','READER_UNAVAILABLE','READER_PARSE','READER_TIMEOUT','READER_JS_REQUIRED','READER_DISABLED','READER_DNS','READER_CONTENT_TYPE','READER_REDIRECT_LIMIT','PROVIDER_FAILURE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_DISABLED','PROVIDER_CONFIG','PROVIDER_BLOCKED','INVALID_PROVIDER_OUTPUT','INVALID_PROVIDER_JSON','CONFLICTING_CLASSIFICATION'];
      const code=allowed.includes(error.code)?error.code:'SAFE_INTERNAL_ERROR';
      const status=code==='UNAUTHORIZED'?401:code==='BUSY'||code==='PROVIDER_RATE_LIMIT'?429:code==='REQUEST_CONFLICT'?409:code.startsWith('PROVIDER_')?502:400;
      send(res,status,{code});
    }
  });
}
function createOfflinePreviewServer(){
  // No external fixture Auth URL in the default CLI. Browser tests explicitly
  // inject auth mocks; an ordinary browser must fail closed without them.
  const {createAuthService}=require('../server/auth-service.js'),fixture=require('./fixtures/news.cjs'),{createReader}=require('./reader.cjs');
  const auth=createAuthService({env:{},fetchImpl:async()=>{throw Error('LIVE_AUTH_DISABLED');},send(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({...body,code:'AUTH_UNAVAILABLE'}));}});
  return createServer({auth,loadCatalog:async()=>{throw Object.assign(Error('CATALOG_UNAVAILABLE'),{code:'CATALOG_UNAVAILABLE'});},provider:fixture.mockProvider(),reader:createReader({loadHtml:async url=>url==='https://news.example.org/article'?{status:200,html:fixture.html}:null})});
}
if(require.main===module){
  const server=createOfflinePreviewServer();
  server.listen(Number(process.env.PORT)||4171,'127.0.0.1',()=>console.log('PHASE1_OFFLINE_READY'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
module.exports={createServer,createOfflinePreviewServer};
