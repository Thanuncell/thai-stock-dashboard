'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createControlledCoverageStore, LEASE_MS } = require('../server/controlled-coverage-store');
const { createCheckpointBatch } = require('../server/coverage-checkpoint');
const { createControlledCoverage } = require('../server/controlled-coverage');
const { backend } = require('./fixtures/controlled-backend.cjs');

test('PostgreSQL 17: approved migration, native concurrent claims and restart recovery', {
  skip: !process.env.SETSCOPE_V156_TEST_PG_CONFIG
}, async t => {
  const config = JSON.parse(await fs.readFile(process.env.SETSCOPE_V156_TEST_PG_CONFIG, 'utf8'));
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'postgres');
  const { Pool } = require(process.env.SETSCOPE_V156_TEST_PG_MODULE || 'pg');
  const admin = new Pool({ ...config, max: 1 });
  assert.match((await admin.query('show server_version')).rows[0].server_version, /^17\./);
  const database = 'setscope_v156_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await admin.query('create database ' + database);
  const pool = new Pool({ ...config, database, max: 4 });
  const writerPool = new Pool({ ...config, database, max: 4, options: '-c role=service_role' });
  let time = Date.parse('2026-10-26T10:00:00Z'), reads = 0, writes = 0;
  // Test transport maps the production REST filters to parameterized SQL.
  // This proves native PostgreSQL semantics; it does not claim live PostgREST testing.
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)), params = url.searchParams;
    if (url.pathname.endsWith('/security_coverage')) {
      const columns = new Set(['symbol','provider_symbol','active','status','symbol_verified','chart_ready','technical_ready','last_checked_at','guard_status']);
      const values = [], filters = [];
      for (const [key, filter] of params) if (columns.has(key)) {
        if (filter === 'is.null') filters.push(key + ' is null');
        else { assert.ok(filter.startsWith('eq.')); values.push(filter.slice(3)); filters.push(key + '=$' + values.length); }
      }
      const where = filters.length ? ' where ' + filters.join(' and ') : '';
      if (init.method === 'HEAD') {
        reads++; const count = (await writerPool.query('select count(*)::int n from public.security_coverage' + where, values)).rows[0].n;
        return new Response(null, {headers:{'content-range':'0-0/'+count}});
      }
      if (init.method === 'PATCH') {
        writes++; const patch = JSON.parse(init.body), keys = Object.keys(patch);
        assert.ok(keys.every(key=>/^[a-z_]+$/.test(key)));
        const filterValues = values.slice(); values.splice(0,values.length,...keys.map(key=>patch[key]),...filterValues);
        const shifted = where.replace(/\$(\d+)/g,(_,n)=>'$'+(Number(n)+keys.length));
        const result = await writerPool.query('update public.security_coverage set '+keys.map((key,i)=>key+'=$'+(i+1)).join(',')+shifted+' returning *', values);
        return Response.json(result.rows);
      }
      reads++; const result = await writerPool.query('select * from public.security_coverage'+where+' order by symbol limit 1000',values);
      return Response.json(result.rows,{headers:{'content-range':'0-'+Math.max(0,result.rows.length-1)+'/'+result.rows.length}});
    }
    let result;
    if (init.method === 'POST') {
      writes++;
      const [row] = JSON.parse(init.body), keys = Object.keys(row);
      assert.ok(keys.every(key => /^[a-z_]+$/.test(key)));
      result = await writerPool.query(`insert into public.coverage_runs(${keys.join(',')}) values(${keys.map((_,i) => '$' + (i+1)).join(',')}) on conflict(run_key) do nothing returning *`, keys.map(key => row[key]));
    } else if (init.method === 'PATCH') {
      writes++;
      const patch = JSON.parse(init.body), keys = Object.keys(patch);
      assert.ok(keys.every(key => /^[a-z_]+$/.test(key)));
      const values = keys.map(key => patch[key]);
      values.push(params.get('run_key').slice(3), params.get('automation_state->>owner').slice(3), params.get('automation_state->>revision').slice(3));
      result = await writerPool.query(`update public.coverage_runs set ${keys.map((key,i) => key + '=$' + (i+1)).join(',')}
        where run_key=$${keys.length+1} and automation_state->>'owner'=$${keys.length+2}
          and automation_state->>'revision'=$${keys.length+3} returning *`, values);
    } else {
      reads++;
      result = await writerPool.query('select * from public.coverage_runs where run_key=$1', [params.get('run_key').slice(3)]);
    }
    return Response.json(result.rows);
  };
  const env = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'synthetic-fixture', SETSCOPE_V156_MANUAL_VERIFY: '1' };
  const make = () => createControlledCoverageStore({ env, fetchImpl, now: () => time });
  const args = { runKey: 'v156:coverage:2026-10-26:postgres', startedAt: new Date(time).toISOString(), batchSize: 5, concurrency: 1 };
  try {
    await pool.query(await fs.readFile(path.join(__dirname, '../supabase/coverage.sql'), 'utf8'));
    await pool.query("insert into public.coverage_runs(run_key,status,started_at,batch_size,concurrency) values('legacy','completed',now(),1,1)");
    const before = (await pool.query("select row_to_json(r)::text value from public.coverage_runs r where run_key='legacy'")).rows[0].value;
    const migration = await fs.readFile(path.join(__dirname,'../supabase/migrations/20261026061519_coverage_automation_v156.sql'),'utf8');
    const rollback = await fs.readFile(path.join(__dirname,'../supabase/coverage_automation_v156_rollback.sql'),'utf8');
    const controls = async () => (await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='public.coverage_runs'::regclass")).rows;
    const beforeControls = await controls();
    await pool.query(migration);
    await t.test('existing row data and role protections survive additive column', async () => {
      const after = (await pool.query("select (to_jsonb(r)-'automation_state') value from public.coverage_runs r where run_key='legacy'")).rows[0].value;
      assert.deepEqual(after, JSON.parse(before));
      assert.deepEqual(await controls(),beforeControls);
      const protection = (await pool.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.coverage_runs'::regclass")).rows[0];
      assert.deepEqual(protection, { relrowsecurity: true, relforcerowsecurity: true });
      for (const role of ['anon','authenticated']) {
        assert.equal((await pool.query('select has_table_privilege($1,$2,$3) allowed', [role, 'public.coverage_runs', 'select'])).rows[0].allowed, false);
      }
    });
    const a = make(), b = make(); let winner;
    await t.test('independent connections atomically insert exactly one persisted job', async () => {
      const result = await Promise.all([a.beginRun(args), b.beginRun(args)]);
      assert.equal(result.filter(r => r.alreadyRunning).length, 1);
      assert.equal((await pool.query('select count(*)::int n from public.coverage_runs where run_key=$1', [args.runKey])).rows[0].n, 1);
      winner = result[0].alreadyRunning ? b : a;
    });
    let providerCalls = 0;
    const rows = [{ symbol: 'PTT', provider_symbol: 'PTT.BK' }];
    await t.test('checked result survives loss of process memory and prevents another provider call', async () => {
      const batch = createCheckpointBatch({ store: winner.checkpointStore,
        verify: async () => { providerCalls++; return { status: 'verified' }; }, apply: async () => { throw Error('fixture crash'); } });
      await assert.rejects(batch.run({ runKey: 'coverage-items:' + args.runKey, rows }), /fixture crash/);
      time += LEASE_MS + 1;
      const recovered = make(); await recovered.beginRun({ ...args, resume: true });
      await createCheckpointBatch({ store: recovered.checkpointStore, verify: async () => assert.fail('provider replay'), apply: async () => {} })
        .run({ runKey: 'coverage-items:' + args.runKey, rows });
      assert.equal(providerCalls, 1);
      await assert.rejects(winner.assertActive(), /LEASE_LOST/);
      winner = recovered;
    });
    await t.test('concurrent recovery compare-and-swap permits one owner', async () => {
      time += LEASE_MS + 1;
      const x = make(), y = make();
      const result = await Promise.allSettled([x.beginRun({ ...args, resume: true }), y.beginRun({ ...args, resume: true })]);
      assert.equal(result.filter(r => r.status === 'fulfilled' && !r.value.alreadyRunning).length, 1);
      await assert.rejects(winner.assertActive(), /LEASE_LOST/);
    });
    await t.test('unknown provider response remains blocked after lease expiry', async () => {
      const uncertainArgs = { ...args, runKey: args.runKey + '-unknown' }, first = make();
      await first.beginRun(uncertainArgs);
      await assert.rejects(createCheckpointBatch({ store: first.checkpointStore,
        verify: async () => { providerCalls++; throw Error('fixture lost response'); }, apply: async () => assert.fail('apply') })
        .run({ runKey: 'coverage-items:' + uncertainArgs.runKey, rows }));
      time += LEASE_MS + 1;
      await assert.rejects(make().beginRun({ ...uncertainArgs, resume: true }), /RECONCILIATION/);
      assert.equal(providerCalls, 2);
      assert.equal((await make().reconcile(uncertainArgs.runKey,true)).replayed,false);
      assert.equal((await make().status(uncertainArgs.runKey)).requiresReconciliation,false);
      await assert.rejects(make().beginRun({...uncertainArgs,resume:true}),/JOB_STOPPED/);
      assert.equal(providerCalls,2);
    });
    await t.test('native PostgreSQL rejects scalar/oversized checkpoints without changing persisted data', async () => {
      await assert.rejects(pool.query("update public.coverage_runs set automation_state=$1::jsonb where run_key='legacy'",[JSON.stringify('invalid')]),e=>e.code==='23514');
      await assert.rejects(pool.query("update public.coverage_runs set automation_state=$1::jsonb where run_key='legacy'",[JSON.stringify({padding:'x'.repeat(1048576)})]),e=>e.code==='23514');
      assert.equal((await pool.query("select automation_state from public.coverage_runs where run_key='legacy'")).rows[0].automation_state,null);
    });
    await t.test('full native jobs serialize across different keys, bound batches and persist daily capacity', async () => {
      await pool.query("insert into public.security_coverage(symbol,provider_symbol) select s,s||'.BK' from unnest(array['PTT','AOT','ADVANC','BBL','CPALL','KBANK']) s");
      const provider = backend(); provider.advance(time,35);
      let started,release,calls=0;
      const entered=new Promise(resolve=>{started=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
      const transport=async(input,init)=>{
        if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){
          calls++;if(calls===1){started();await blocked;}return provider.fetchImpl(input,init);
        }
        return fetchImpl(input,init);
      };
      const makeController=()=>createControlledCoverage({env,fetchImpl:transport,now:()=>time});
      const first=makeController().execute({tag:'native-a'}); await entered;
      assert.equal((await makeController().execute({tag:'native-b'})).alreadyRunning,true);
      assert.equal(calls,1);release();assert.equal((await first).verified,5);
      assert.equal((await makeController().execute({tag:'native-b'})).verified,1);
      await assert.rejects(makeController().execute({tag:'native-c'}),/DAILY_JOB_BUDGET/);
      assert.equal(calls,6);
      assert.equal((await pool.query("select count(*)::int n from public.coverage_runs where run_key like '%:native-%'")).rows[0].n,2);
      assert.equal((await pool.query("select count(*)::int n from public.security_coverage where status='verified'")).rows[0].n,6);
      const states=(await pool.query("select automation_state from public.coverage_runs where automation_state is not null")).rows;
      assert.ok(states.every(row=>!JSON.stringify(row.automation_state).includes(env.SUPABASE_SECRET_KEY)));
      t.diagnostic(JSON.stringify({nativeJobProviderCalls:calls,peakCheckpointBytes:Math.max(...states.map(row=>Buffer.byteLength(JSON.stringify(row.automation_state))))}));
    });
    await t.test('coverage-only seven-day timestamps survive restart and daily EOD registry writes',async()=>{
      const provider=backend();let calls=0;
      const transport=(input,init)=>{
        if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){calls++;return provider.fetchImpl(input,init);}
        return fetchImpl(input,init);
      };
      const run=args=>createControlledCoverage({env,fetchImpl:transport,now:()=>time}).execute(args);
      const before=(await pool.query("select automation_state->'metadata'->'coverageChecks' value from public.coverage_runs where run_key='v156:control'")).rows[0].value;
      assert.equal(Object.keys(before).length,6);
      time=Date.parse('2026-10-27T11:00:00Z');provider.advance(time,35);
      assert.equal((await run({mode:'eod',tag:'native-eod'})).verified,5);
      assert.equal((await run({tag:'not-due'})).attempted,0);assert.equal(calls,5);
      const after=(await pool.query("select automation_state->'metadata'->'coverageChecks' value from public.coverage_runs where run_key='v156:control'")).rows[0].value;
      assert.deepEqual(after,before);
      time=Date.parse('2026-11-02T11:00:00Z');provider.advance(time,36);
      assert.equal((await run({tag:'week-later'})).verified,5);assert.equal(calls,10);
    });
    await t.test('one-time canary persists exact selection, unchanged outside rows and replay prevention', async () => {
      const {main}=require('../scripts/run-v156-canary');
      const {SYMBOLS}=require('../server/canary-policy');
      // Disposable loopback database only, isolated above from production.
      await pool.query("delete from public.coverage_runs where run_key like 'v156:%'; delete from public.security_coverage");
      time=Date.parse('2026-10-26T10:00:00Z');
      for(const symbol of [...SYMBOLS,'OUTSIDE'])await pool.query(`insert into public.security_coverage
        (symbol,provider_symbol,provider,active,status,symbol_verified,chart_ready,technical_ready,last_checked_at,guard_status)
        values($1,$2,'Yahoo Finance',true,'verified',true,true,true,$3,'accepted')`,[symbol,symbol+'.BK',new Date(time-1000).toISOString()]);
      await pool.query("update public.security_coverage set status='partial' where symbol='OUTSIDE'");
      const before=(await pool.query("select row_to_json(r) value from public.security_coverage r where symbol='OUTSIDE'")).rows[0].value;
      const provider=backend({symbols:SYMBOLS});provider.advance(time,35);
      let calls=0;
      const transport=(input,init)=>{
        if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){calls++;return provider.fetchImpl(input,init);}
        return fetchImpl(input,init);
      };
      const settings={...env,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',SETSCOPE_CANARY_APPROVED:'1',SETSCOPE_V156_KILL:'1'};
      const result=await main({env:settings,fetchImpl:transport,now:()=>time});
      assert.equal(result.verified,5);assert.equal(result.partial,0);
      assert.equal(result.canaryCounts.before.verified,5);assert.equal(result.canaryCounts.after.verified,5);
      const persisted=(await pool.query("select partial from public.coverage_runs where run_key=$1",[result.runKey])).rows[0];
      assert.equal(persisted.partial,0);
      const control=(await pool.query("select status,failure_reason,automation_state from public.coverage_runs where run_key='v156:control'")).rows[0];
      assert.equal(control.status,'completed');assert.equal(control.failure_reason,null);
      assert.equal(control.automation_state.metadata.lastOutcome,'completed');
      assert.deepEqual((await pool.query("select row_to_json(r) value from public.security_coverage r where symbol='OUTSIDE'")).rows[0].value,before);
      time+=86400000;
      await assert.rejects(main({env:settings,fetchImpl:transport,now:()=>time}));assert.equal(calls,5);
      assert.equal(settings.SETSCOPE_V156_KILL,'1');
    });
    await t.test('manual twenty-stock preparation and four sequential jobs persist on PostgreSQL without rewriting canary history',async()=>{
      const {main}=require('../scripts/run-v156-batch20');
      const canaryKey='v156:coverage:2026-10-26:canary-5';
      const canary=(await pool.query('select row_to_json(r) value from public.coverage_runs r where run_key=$1',[canaryKey])).rows[0].value;
      const outside=(await pool.query('select row_to_json(r) value from public.security_coverage r order by symbol')).rows.map(r=>r.value);
      for(let i=0;i<20;i++){
        const symbol='B'+String(i).padStart(3,'0');
        await pool.query("insert into public.security_coverage(symbol,provider_symbol,provider,active,status) values($1,$2,'Yahoo Finance',true,'pending')",[symbol,symbol+'.BK']);
      }
      const provider=backend();let calls=0;
      const transport=(input,init)=>{
        if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){calls++;return provider.fetchImpl(input,init);}
        return fetchImpl(input,init);
      };
      const settings={...env,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'Thanuncell/thai-stock-dashboard',
        GITHUB_REPOSITORY_OWNER:'Thanuncell',GITHUB_ACTOR:'Thanuncell',GITHUB_RUN_ID:'98765432101',GITHUB_RUN_ATTEMPT:'1',SETSCOPE_BATCH_CONFIRMATION:'RUN COVERAGE 20'};
      time=Date.parse('2026-10-26T11:00:00Z');
      await assert.rejects(main({env:settings,fetchImpl:transport,now:()=>time}));assert.equal(calls,0);
      time=Date.parse('2026-10-27T11:00:00Z');provider.advance(time,35);
      const beforeWrites=writes;
      const ready=await main({env:settings,fetchImpl:transport,now:()=>time});assert.equal(ready.status,'READY');assert.equal(writes,beforeWrites);
      const result=await main({env:settings,fetchImpl:transport,now:()=>time,mode:'run'});
      assert.equal(result.status,'PASS');assert.equal(result.attempted,20);assert.equal(result.verified,20);assert.equal(result.partial,0);assert.equal(calls,20);
      assert.equal(result.jobs.length,4);assert.ok(result.jobs.every(j=>j.metrics.providerCalls<=10&&j.metrics.databaseReads+j.metrics.databaseWrites<=200));
      const meta=(await pool.query("select automation_state->'metadata' value from public.coverage_runs where run_key='v156:control'")).rows[0].value;
      assert.equal(meta.manualBatch.phase,'completed');assert.equal(meta.manualBatch.next,4);assert.equal(meta.manualBatch.targets.length,20);assert.equal(meta.reservations,4);
      assert.deepEqual((await pool.query('select row_to_json(r) value from public.coverage_runs r where run_key=$1',[canaryKey])).rows[0].value,canary);
      assert.deepEqual((await pool.query("select row_to_json(r) value from public.security_coverage r where symbol not like 'B0%' order by symbol")).rows.map(r=>r.value),outside);
    });
    await t.test('scaling receipts survive restart and require approved continuation on native PostgreSQL',async()=>{
      const {main}=require('../scripts/run-v156-scaling');
      time=Date.parse('2026-10-28T11:00:00Z');
      for(let i=0;i<120;i++){
        const symbol='C'+String(i).padStart(3,'0');
        await pool.query("insert into public.security_coverage(symbol,provider_symbol,provider,active,status) values($1,$2,'Yahoo Finance',true,'pending')",[symbol,symbol+'.BK']);
      }
      const provider=backend();provider.advance(time,35);let calls=0;
      const transport=(input,init)=>{
        if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){calls++;return provider.fetchImpl(input,init);}
        return fetchImpl(input,init);
      };
      const settings={...env,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'Thanuncell/thai-stock-dashboard',GITHUB_REPOSITORY_OWNER:'Thanuncell',GITHUB_ACTOR:'Thanuncell',GITHUB_RUN_ATTEMPT:'1',
        GITHUB_RUN_ID:'880000',SETSCOPE_SCALE_CONFIRMATION:'RUN COVERAGE 20'};
      const first=await main({env:settings,fetchImpl:transport,now:()=>time,mode:'run'});assert.equal(first.status,'STAGE_PASS');assert.equal(first.verified,20);
      time+=86400000;provider.advance(time,35);
      const nextSettings={...settings,GITHUB_RUN_ID:'880001',SETSCOPE_SCALE_STAGE:'100',SETSCOPE_SCALE_CONFIRMATION:'RUN COVERAGE 100'};
      const next=await main({env:nextSettings,fetchImpl:transport,now:()=>time,mode:'run'});assert.equal(next.status,'ROUND_PASS');assert.equal(next.stageProgress.completed,20);
      await assert.rejects(main({env:{...nextSettings,GITHUB_RUN_ID:'880002',SETSCOPE_SCALE_ID:'880001'},fetchImpl:transport,now:()=>time,mode:'run'}));assert.equal(calls,40);
      time+=86400000;provider.advance(time,35);
      const continued=await main({env:{...nextSettings,GITHUB_RUN_ID:'880002',SETSCOPE_SCALE_ID:'880001',SETSCOPE_SCALE_REVIEW:'REVIEWED 880001'},fetchImpl:transport,now:()=>time,mode:'run'});
      assert.equal(continued.stageProgress.completed,40);assert.equal(calls,60);
      const row=(await pool.query("select automation_state from public.coverage_runs where run_key='v156:control'")).rows[0];
      assert.equal(row.automation_state.metadata.scaling.completedSymbols.length,40);assert.equal(row.automation_state.metadata.scaling.phase,'awaiting_approval');
      assert.equal(row.automation_state.metadata.scaling.acceptedStages[0].verified,20);
      assert.equal((await pool.query("select verified from public.coverage_runs where run_key='v156:coverage:2026-10-26:canary-5'")).rows[0].verified,5);
    });
    await t.test('rollback refuses to destroy checkpoints, then supports an empty-column rollback and reapply', async () => {
      const archived=(await pool.query('select run_key,automation_state from public.coverage_runs where automation_state is not null')).rows;
      const client=await pool.connect();
      try { await assert.rejects(client.query(rollback),/Checkpoint state exists/); await client.query('rollback'); }
      finally { client.release(); }
      assert.equal((await pool.query('select count(*)::int n from public.coverage_runs where automation_state is not null')).rows[0].n,archived.length);
      // Disposable fixture only: archive above before clearing the test column.
      await pool.query('update public.coverage_runs set automation_state=null');
      await pool.query(rollback);assert.deepEqual(await controls(),beforeControls);
      assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='coverage_runs' and column_name='automation_state'")).rows[0].n,0);
      await pool.query(migration);
      for(const row of archived) await pool.query('update public.coverage_runs set automation_state=$1 where run_key=$2',[row.automation_state,row.run_key]);
      assert.deepEqual(await controls(),beforeControls);
      assert.equal((await pool.query("select status from public.coverage_runs where run_key='legacy'")).rows[0].status,'completed');
    });
    t.diagnostic(JSON.stringify({ providerCalls, databaseReads: reads, databaseWrites: writes }));
  } finally {
    await writerPool.end(); await pool.end(); await admin.query('drop database ' + database); await admin.end();
  }
});
