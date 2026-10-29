'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),{randomBytes,createHmac}=require('node:crypto');
module.exports=async function startHttp(pool,config){
 const executable=process.env.SETSCOPE_TEST_POSTGREST;if(!executable)throw Error('Isolated PostgREST runtime required');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'setscope-ws7-http-')),secret=randomBytes(32).toString('hex'),password=randomBytes(24).toString('hex'),role='ws7_http_'+randomBytes(6).toString('hex');
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const jwt=roleName=>{const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),v=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:roleName,exp:Math.floor(Date.now()/1000)+3600});return v+'.'+createHmac('sha256',secret).update(v).digest('base64url');};
 await pool.query('create role '+role+" login noinherit nosuperuser nocreatedb nocreaterole password '"+password+"'; grant anon,authenticated,service_role to "+role);
 const safeupdate=process.env.SETSCOPE_TEST_SAFEUPDATE_LIBRARY;
 if(safeupdate){if(!/^[A-Za-z0-9_:./\\-]+$/.test(safeupdate))throw Error('Unsafe test library path');await pool.query("alter role "+role+" set session_preload_libraries='"+safeupdate.replaceAll('\\','/')+"'");}
 const file=path.join(root,'postgrest.conf');await fs.writeFile(file,'db-uri = "postgresql://'+role+':'+password+'@127.0.0.1:'+config.port+'/'+config.database+'"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = '+port+'\njwt-secret = "'+secret+'"\n');
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PGRST_|^PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)/i.test(key)));env.PATH=process.env.SETSCOPE_TEST_PG_BIN+';'+(env.PATH||env.Path||'');
 const child=spawn(executable,[file],{windowsHide:true,env,stdio:'ignore'}),base='http://127.0.0.1:'+port,token=jwt('service_role');
 for(let i=0;i<100;i++){try{const r=await fetch(base+'/news_archive?select=id&limit=0',{headers:{Authorization:'Bearer '+token}});if(r.ok)return{base,token,jwt,stop:()=>new Promise(r=>{if(child.exitCode!==null)return r();child.once('close',r);child.kill();})};}catch{}await new Promise(r=>setTimeout(r,100));}
 child.kill();throw Error('Isolated PostgREST startup failed');
};
