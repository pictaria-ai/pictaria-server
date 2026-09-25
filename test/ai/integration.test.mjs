import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as turn } from 'node:timers/promises';
import { Repository } from '../../src/enrich/repository.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { RefereeService } from '../../src/enrich/refereeService.mjs';
import { analyzeWithValidationRetry } from '../../src/enrich/runner.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { aiBackendKey } from '../../src/curate/ai-limits.mjs';
import { loadV1Taxonomy, sampleOutput } from '../enrich/helpers.mjs';

const provider = { providerName:'local_lmstudio', modelName:'enrich-model', baseUrl:'http://model.test:8000/v1', apiKey:'test' };
const taxonomy=loadV1Taxonomy(), deferred=()=>Promise.withResolvers();
const immich={ getAsset:async id=>({id,originalPath:`${id}.jpg`}),
  getAssetThumbnail:async()=>{ await turn(); return {data:Buffer.from('synthetic'),contentType:'image/jpeg'}; } };
async function fixture(work) {
  const dir=mkdtempSync(join(tmpdir(),'pictaria-ai-scheduling-'));
  const repo=new Repository(join(dir,'enrichment.sqlite'));repo.initSchema();
  let now=0; const scheduler=new AiRequestScheduler({now:()=>now});
  try { await work({repo,scheduler,advance:ms=>{now+=ms;}}); }
  finally {await scheduler.stop(10);repo.close();rmSync(dir,{recursive:true,force:true});}
}
function config(fetchImpl) {
  return {promptsDir:fileURLToPath(new URL('../../prompts',import.meta.url)),promptVersion:'v1',
    promptOverrides:{},defaultProvider:'local_lmstudio',imageSource:'preview',maxFailuresPerAsset:2,
    enrichEnabled:true,curateBurstGrouping:true,curateRefereeEnabled:true,curateRefereeModel:'referee-model',
    providers:{local_lmstudio:{...provider,fetchImpl}}};
}
function referee(f,cfg,runner) {
  for (const id of ['r1','r2']) f.repo.upsertAsset({id,originalPath:`${id}.jpg`});
  return new RefereeService({repo:f.repo,immich,config:cfg,enrichRunner:runner,aiScheduler:f.scheduler,
    review:{annotatedReviewRows:()=>['r1','r2'].map(assetId=>({assetId,burstId:'stack',state:'undecided',aiTags:[]}))}});
}

test('real Enrich and legacy referee workers share five-call turns with different models on one endpoint',async()=>fixture(async f=>{
  const started=deferred(),release=deferred(),order=[];
  const cfg=config(async(_url,options)=>{
    const request=JSON.parse(options.body),isRef=request.model==='referee-model';
    order.push(isRef?'curate':'enrich');
    if(order.length===1){started.resolve();await release.promise;}
    f.advance(10_000);
    const output=isRef?{same_subject:true,photos:[{photo:1,rank:1,keep:true,eyes_closed:'no'},{photo:2,rank:2,keep:false,eyes_closed:'no'}]}:sampleOutput();
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})};
  });
  const runner=new EnrichJobRunner({repo:f.repo,immich,taxonomy,config:cfg,aiScheduler:f.scheduler});
  const ref=referee(f,cfg,runner);
  runner.start({assetIds:Array.from({length:10},(_,i)=>`e${i}`),sendToCurate:false});
  await started.promise;
  const check=ref.tick();await turn();
  assert.equal(ref.status().scheduling.state,'waiting');assert.equal(ref.status().yielding,true);
  release.resolve();await Promise.all([runner.runPromise,check]);
  assert.equal(runner.status().error,null,JSON.stringify(runner.status().log));
  assert.deepEqual(order,[...Array(5).fill('enrich'),'curate',...Array(5).fill('enrich')]);
  assert.equal(runner.status().counters.succeeded,10);assert.equal(runner.status().error,null);
  assert.equal(f.repo.refereeStats().groups,1);assert.equal(runner.status().scheduling.state,'idle');
}));

test('Enrich waiting cancellation records no failed photo and sends no provider request',async()=>fixture(async f=>{
  let requests=0;const cfg=config(async()=>{requests++;assert.fail('unexpected call');});
  const gate=deferred(),held=f.scheduler.session(provider,'curate');
  const active=held.run(()=>gate.promise);await turn();
  const runner=new EnrichJobRunner({repo:f.repo,immich,taxonomy,config:cfg,aiScheduler:f.scheduler});
  runner.start({assetIds:['e1'],sendToCurate:false});
  for(let i=0;i<20&&runner.status().scheduling.state!=='waiting';i++)await turn();
  assert.equal(runner.status().scheduling.state,'waiting');runner.cancel();await runner.runPromise;
  assert.equal(requests,0);assert.equal(runner.status().cancelled,true);
  assert.equal(runner.status().counters.failed,0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM processing_runs').get().n,0);
  gate.resolve();await active;held.close();
}));

test('a changed Settings endpoint does not move an active Enrich run to a different scheduling resource',async()=>fixture(async f=>{
  const first=deferred(),release=deferred(),urls=[];
  const cfg=config(async url=>{urls.push(url);if(urls.length===1){first.resolve();await release.promise;}
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(sampleOutput())}}]})};});
  const runner=new EnrichJobRunner({repo:f.repo,immich,taxonomy,config:cfg,aiScheduler:f.scheduler});
  runner.start({assetIds:['e1','e2'],sendToCurate:false});await first.promise;
  cfg.providers.local_lmstudio.baseUrl='http://new.test:8000/v1';
  const independent=f.scheduler.session({...provider,baseUrl:cfg.providers.local_lmstudio.baseUrl},'curate');
  await independent.run(()=>{});independent.close();
  release.resolve();await runner.runPromise;
  assert.equal(urls.length,2);assert.ok(urls.every(url=>url.startsWith('http://model.test:8000/')));
}));

test('validation retries reacquire a turn and release the model to waiting Curate work',async()=>fixture(async f=>{
  const started=deferred(),release=deferred(),order=[];let attempts=0;
  const model={...provider,analyzeImage:async()=>{attempts++;order.push(`e${attempts}`);
    if(attempts===1){started.resolve();await release.promise;return {normalizedOutput:{}};}
    return {normalizedOutput:sampleOutput()};}};
  const enrich=f.scheduler.session(model,'enrich'),curate=f.scheduler.session(provider,'curate');
  const run=analyzeWithValidationRetry(model,{data:Buffer.from('synthetic'),mimeType:'image/jpeg'},
    {systemPrompt:'system',userPrompt:'user',jsonSchema:{},taxonomy,aiSession:enrich});
  await started.promise;const check=curate.run(()=>order.push('c'));release.resolve();
  const result=await run;await check;enrich.close();curate.close();
  assert.equal(result.retryCount,1);assert.deepEqual(order,['e1','c','e2']);
}));

function execution(f, cfg={curateBurstGrouping:true,curateStackRefereeEnabled:true,curateKeeperRefereeEnabled:true}) {
  return new CurateAiExecution({attempts:f.repo.curate.aiAttempts,limits:f.repo.curate.aiLimits,
    scheduler:f.scheduler,getConfig:()=>cfg,availability:{stack:true,keeper:true}});
}
function job(extra={}) {return {role:'stack',inputKey:'a'.repeat(64),provider,backendKey:aiBackendKey(provider),
  photoIds:['a','b'],isCurrent:()=>true,prepare:async check=>{check();},submit:async()=>({ok:true}),
  validate:x=>x,accept:()=>{},...extra};}

test('new referee executor waits before preparation/accounting and preserves frozen inputs and durable limits',async()=>fixture(async f=>{
  const e=f.scheduler.session(provider,'enrich'),gate=deferred();
  const active=e.run(()=>gate.promise);await turn();
  const ex=execution(f),input=job();let prepared=0,submitted=0;
  input.prepare=async check=>{prepared++;check();};input.submit=async()=>{submitted++;return {};};
  const waiting=ex.run(input);await turn();input.photoIds.push('substituted');
  assert.equal(ex.schedulingStatus().state,'waiting');assert.equal(prepared,0);
  assert.equal(f.repo.curate.aiAttempts.status('stack',input.inputKey).attempts,0);
  assert.equal((await ex.run(job({role:'keeper'}))).state,'busy');
  gate.resolve();await active;e.close();assert.equal((await waiting).state,'succeeded');
  assert.equal(prepared,1);assert.equal(submitted,1);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n,2);
  assert.equal((await ex.run(job())).state,'settled');
}));

test('queued new-role opt-out stops before preparation; provider identity mismatch fails closed',async()=>fixture(async f=>{
  const cfg={curateBurstGrouping:true,curateStackRefereeEnabled:true},ex=execution(f,cfg);
  const e=f.scheduler.session(provider,'enrich'),gate=deferred();const active=e.run(()=>gate.promise);await turn();
  const waiting=ex.run(job({prepare:()=>assert.fail('disabled work prepared')}));await turn();
  cfg.curateStackRefereeEnabled=false;f.scheduler.refresh();assert.equal((await waiting).state,'disabled');
  assert.equal(f.repo.curate.aiAttempts.status('stack','a'.repeat(64)).attempts,0);
  gate.resolve();await active;e.close();cfg.curateStackRefereeEnabled=true;
  await assert.rejects(ex.run(job({backendKey:'b'.repeat(64)})),/pinned admission identity/);
}));
