import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { ReviewService } from '../../src/enrich/reviewService.mjs';
import { TagWriteCoordinator } from '../../src/enrich/tagWriteCoordinator.mjs';
import { MAX_LEASES } from '../../src/curate/repository.mjs';
import { RECEIPT_MS, TOMBSTONE_MS } from '../../src/curate/decisions.mjs';
import { SYNC_ACTION_RULES } from '../../src/enrich/reviewActions.mjs';
import { loadV1Taxonomy } from '../enrich/helpers.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const IDS = [id(1),id(2),id(3)];
class Remote {
  constructor() { this.tags=new Set(['frame/eligible','frame/reviewed','frame/favorite','frame/never-show']); this.assets=new Map(); this.calls=[]; }
  async listTags() { return [...this.tags].map(value=>({id:value,value})); }
  async upsertTags(values) { values.forEach(t=>this.tags.add(t)); return values.map(value=>({id:value,value})); }
  async getAsset(assetId) { return {id:assetId,tags:[...(this.assets.get(assetId)??[])].map(value=>({id:value,value}))}; }
  async tagAssetsBulk({assetIds,tagIds}) { this.calls.push(['add',assetIds,tagIds]); for(const id of assetIds) {const s=this.assets.get(id)??new Set();tagIds.forEach(t=>s.add(t));this.assets.set(id,s);} }
  async untagAssets({assetIds,tagId}) { this.calls.push(['remove',assetIds,[tagId]]); for(const id of assetIds)this.assets.get(id)?.delete(tagId); }
}
async function fixture(work) {
 const dir=mkdtempSync(join(tmpdir(),'pic368-')), path=join(dir,'enrichment.sqlite');
 let repo=new Repository(path); repo.initSchema();
 const immich=new Remote(), tagWrites=new TagWriteCoordinator();
 let curate=new CurateService({repo});
 let review=new ReviewService({repo,immich,tagWrites,taxonomy:loadV1Taxonomy(),verifyDelayMs:0});
 const f={path,immich,tagWrites,get repo(){return repo;},get curate(){return curate;},get review(){return review;},
  seed(ids=IDS,offset=0) { ids.forEach((assetId,i)=>{repo.upsertAsset({id:assetId,fileCreatedAt:new Date(Date.UTC(2026,0,1)+offset+i*1000).toISOString()});repo.reviewListAdd([assetId],'test');}); },
  async operation(outcomes=Object.fromEntries(IDS.map((x,i)=>[x,i===0?'approve':'reviewed']))) {
   const view=await curate.openView(); const group=view.groups.find(g=>g.memberCount===Object.keys(outcomes).length);
   const comparison=curate.comparison(view.viewId,group.id); const {expiresAt,...issued}=await curate.issueDecision(comparison.id);
   return {...issued,outcomes};
  },
  async drain(){for(let i=0;i<100;i++){const j=repo.nextSyncJob();if(!j)return;assert.equal(j.invalidReason,null);await review.pushDecisionToImmich({...j,assetIds:j.assetIds.slice(0,50)});repo.completeSyncJobSlice(j.id,Math.min(j.assetIds.length,50));}throw Error('queue did not drain');},
  async restart(){await curate.close();repo.close();repo=new Repository(path);repo.initSchema();curate=new CurateService({repo});review=new ReviewService({repo,immich,tagWrites,taxonomy:loadV1Taxonomy(),verifyDelayMs:0});},
  accept(action,assetId){const rule=SYNC_ACTION_RULES[action];return repo.recordDecision({assetIds:[assetId],addTags:rule.add,removeTags:rule.remove,action});}
 };
 try{await work(f);}finally{await review.stopSyncWorker();await curate.close();repo.close();rmSync(dir,{recursive:true,force:true});}
}
const undoPayload = receipt => {const {expiresAt,...payload}=receipt.undo;return payload;};
const local = (f,assetId)=>f.repo.loadAssetTagsFor([assetId])[assetId]??[];
async function waitFor(condition) {
 const deadline=Date.now()+5000;
 while(!condition()) { assert.ok(Date.now()<deadline,'worker did not reach expected state');await new Promise(r=>setTimeout(r,5)); }
}

test('one operation commits multiple keepers/remainder, sync and prior state; zero keepers is reviewed, never deletion',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation({[IDS[0]]:'approve',[IDS[1]]:'favorite',[IDS[2]]:'reviewed'});const receipt=await f.curate.applyDecision(input);
 assert.equal(receipt.assetCount,3); assert.equal(receipt.sync,'pending'); assert.equal(f.immich.calls.length,0);
 assert.deepEqual(local(f,IDS[0]),['frame/eligible']);assert.deepEqual(local(f,IDS[1]),['frame/eligible','frame/favorite']);assert.deepEqual(local(f,IDS[2]),['frame/reviewed']);
 await f.drain();assert.equal(f.repo.decisions.status(receipt.operationId).sync,'synced');
 await f.curate.applyDecision(undoPayload(receipt));await f.drain();IDS.forEach(x=>assert.deepEqual(local(f,x),[]));
 const all=await f.operation(Object.fromEntries(IDS.map(x=>[x,'reviewed'])));await f.curate.applyDecision(all);IDS.forEach(x=>assert.deepEqual(local(f,x),['frame/reviewed']));
 });
});
test('lost response replays exact receipt after expiry, restart and newer Frame Hide; altered payload conflicts',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();const receipt=await f.curate.applyDecision(input);f.accept('frame_hide',IDS[0]);
 f.repo.db.prepare('UPDATE curate_leases SET expires_at=0').run();await f.restart();const count=f.repo.pendingSyncJobCount();
 assert.deepEqual(await f.curate.applyDecision(input),receipt);assert.equal(f.repo.pendingSyncJobCount(),count);
 await assert.rejects(f.curate.applyDecision({...input,outcomes:{...input.outcomes,[IDS[0]]:'favorite'}}),/already used/);
 await f.drain();assert.ok(f.immich.assets.get(IDS[0]).has('frame/never-show'));assert.equal(f.immich.assets.get(IDS[0]).has('frame/eligible'),false);
 });
});
test('issued IDs are bound to exact mode, immutable snapshot and exhaustive outcomes',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();
 for(const changed of [ {...input,operationId:'unknown'}, {...input,mode:'advice'}, {...input,snapshot:{...input.snapshot,ids:[IDS[0]]},outcomes:{[IDS[0]]:'approve'}}, {...input,outcomes:{[IDS[0]]:'approve'}}, {...input,snapshot:{...input.snapshot,material:'invented'}}, {...input,outcomes:{...input.outcomes,[IDS[0]]:'restore'}} ])
  await assert.rejects(f.curate.applyDecision(changed));
 assert.equal(f.repo.pendingSyncJobCount(),0);IDS.forEach(x=>assert.deepEqual(local(f,x),[]));
 const other=f.repo.curate.lease('operation',{kind:'undo',targetOperationId:'elsewhere'});
 await assert.rejects(f.curate.applyDecision({...input,operationId:other.id}),/scope/);
 f.repo.db.prepare('UPDATE curate_leases SET expires_at=0 WHERE id=?').run(input.operationId);await assert.rejects(f.curate.applyDecision(input),/expired/);
 });
});
test('a stale member conflicts the whole decision and cannot affect unaffected siblings',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();f.accept('frame_favorite',IDS[1]);
 await assert.rejects(f.curate.applyDecision(input),/changed/);assert.deepEqual(local(f,IDS[0]),[]);assert.deepEqual(local(f,IDS[2]),[]);assert.deepEqual(local(f,IDS[1]),['frame/favorite']);
 assert.equal(f.repo.pendingSyncJobCount(),1);
 });
});
test('a queue/receipt failure rolls back every local patch, job, revision and receipt',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();f.repo.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON decision_operations BEGIN SELECT RAISE(ABORT,'fault after all writes'); END;");
 await assert.rejects(f.curate.applyDecision(input),/fault after all writes/);assert.equal(f.repo.pendingSyncJobCount(),0);assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM decision_intents').get().n,0);IDS.forEach(x=>assert.deepEqual(local(f,x),[]));
 f.repo.db.exec('DROP TRIGGER fail_receipt');await f.curate.applyDecision(input);
 });
});
test('unrelated enrichment and a machine-only split do not veto explicit outcomes; a new alternative does',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();f.seed([id(20)],86400000);await f.curate.refresh();
 // Simulate publication of AI-only subgroups over the identical inspected set.
 for(const assetId of IDS)f.curate.current.byMember.set(assetId,{ids:[assetId]});
 await f.curate.applyDecision(input);
 });
 await fixture(async f=>{f.seed();const input=await f.operation();f.seed([id(4)]);await assert.rejects(f.curate.applyDecision(input),/membership changed/);assert.equal(f.repo.pendingSyncJobCount(),0);});
});
test('human separation, same-photo image edits, missing/trash/offline and removed review membership conflict',async()=>{
 for(const change of [
  async(f,input)=>f.curate.separate(input.snapshot.comparisonId,[[IDS[0]],[IDS[1],IDS[2]]]),
  async f=>f.repo.upsertAsset({id:IDS[1],fileModifiedAt:'2026-02-01T00:00:00Z'}),
  async f=>f.repo.db.prepare("UPDATE assets SET missing_since='now' WHERE asset_id=?").run(IDS[1]),
  async f=>f.repo.curate.observe({id:IDS[1],isTrashed:true}),
  async f=>f.repo.curate.observe({id:IDS[1],isOffline:true}),
  async f=>f.repo.db.prepare('DELETE FROM review_list WHERE asset_id=?').run(IDS[1])
 ])await fixture(async f=>{f.seed();const input=await f.operation();await change(f,input);await assert.rejects(f.curate.applyDecision(input));assert.equal(f.repo.pendingSyncJobCount(),0);IDS.forEach(x=>assert.deepEqual(local(f,x),[]));});
});
test('conditional Undo cannot erase a later Frame Favorite; unrelated AI changes are preserved on successful Undo',async()=>{
 await fixture(async f=>{f.seed();const receipt=await f.curate.applyDecision(await f.operation());await f.review.frameDecision(IDS[0],'frame_favorite');
 await assert.rejects(f.curate.applyDecision(undoPayload(receipt)),/newer human/);assert.ok(local(f,IDS[0]).includes('frame/favorite'));assert.deepEqual(local(f,IDS[2]),['frame/reviewed']);
 });
 await fixture(async f=>{f.seed();const receipt=await f.curate.applyDecision(await f.operation());f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES(?,'ai/scene/new','ai','now')").run(IDS[0]);
 const result=await f.curate.applyDecision(undoPayload(receipt));assert.deepEqual(local(f,IDS[0]),['ai/scene/new']);await f.restart();assert.deepEqual(await f.curate.applyDecision(undoPayload(receipt)),result);
 });
});
test('Undo ID cannot authorize a different target and expired Undo cannot become a fresh decision',async()=>{
 await fixture(async f=>{f.seed();const receipt=await f.curate.applyDecision(await f.operation());const input=undoPayload(receipt);
 await assert.rejects(f.curate.applyDecision({...input,targetOperationId:'other'}),/scope/);
 f.repo.db.prepare("UPDATE decision_operations SET receipt_json=json_set(receipt_json,'$.undo.expiresAt',0) WHERE id=?").run(receipt.operationId);await assert.rejects(f.curate.applyDecision(input),/expired/);
 });
});
test('old queued/dead approval uses current scoped intent, preserves custom tags, and never reapplies after completion',async()=>{
 await fixture(async f=>{f.seed();const old=f.accept('approve',IDS[0]);f.repo.deadLetterSyncJob(old,'test outage');await f.review.frameDecision(IDS[0],'frame_hide');await f.drain();
 f.immich.assets.get(IDS[0]).add('family/holiday');f.immich.assets.get(IDS[0]).delete('frame/never-show'); // later direct Immich edit
 const calls=f.immich.calls.length;f.repo.retryDeadSyncJobs(old);await f.drain();assert.equal(f.immich.calls.length,calls);assert.deepEqual([...f.immich.assets.get(IDS[0])],['family/holiday']);
 });
});
test('partial remote write survives restart and converges to a newer Hide without replaying old approval',async()=>{
 await fixture(async f=>{f.seed();const receipt=await f.curate.applyDecision(await f.operation());const original=f.immich.tagAssetsBulk.bind(f.immich);let once=true;
 f.immich.tagAssetsBulk=async p=>{await original(p);if(once){once=false;throw Error('lost connection after remote mutation');}};
 const job=f.repo.nextSyncJob();await assert.rejects(f.review.pushDecisionToImmich(job),/lost connection/);assert.equal(f.repo.decisions.status(receipt.operationId).sync,'pending');
 await f.restart();f.accept('frame_hide',IDS[0]);await f.drain();assert.ok(f.immich.assets.get(IDS[0]).has('frame/never-show'));assert.equal(f.immich.assets.get(IDS[0]).has('frame/eligible'),false);
 assert.equal(f.repo.decisions.status(receipt.operationId).sync,'superseded');
 });
});
test('new intent accepted during an in-flight remote write remains pending until a follow-up repairs it',async()=>{
 await fixture(async f=>{f.seed();f.accept('approve',IDS[0]);const original=f.immich.tagAssetsBulk.bind(f.immich);let once=true;
 f.immich.tagAssetsBulk=async p=>{await original(p);if(once){once=false;f.accept('frame_hide',IDS[0]);}};
 const old=f.repo.nextSyncJob();await assert.rejects(f.review.pushDecisionToImmich(old),{code:'decision_sync_changed'});assert.ok(f.repo.decisions.pendingFor(IDS[0]).length>0);
 await f.drain();assert.ok(f.immich.assets.get(IDS[0]).has('frame/never-show'));assert.equal(f.immich.assets.get(IDS[0]).has('frame/eligible'),false);
 });
});
test('Frame Favorite/Hide on an unlisted photo retain narrow semantics and do not touch remote AI/custom tags',async()=>{
 await fixture(async f=>{const assetId=id(90);f.immich.assets.set(assetId,new Set(['ai/scene/beach','personal/trip']));
 const result=await f.review.frameDecision(assetId,'frame_favorite');assert.equal(result.tag.value,'frame/favorite');assert.deepEqual(local(f,assetId),['frame/favorite']);assert.equal(f.repo.reviewListMembership([assetId]).size,0);
 await f.review.frameDecision(assetId,'frame_hide');assert.deepEqual(local(f,assetId),['frame/favorite','frame/never-show']);assert.deepEqual([...f.immich.assets.get(assetId)].sort(),['ai/scene/beach','frame/favorite','frame/never-show','personal/trip']);
});
});
test('Frame replies after mutation while verification is blocked; the background worker still repairs and acknowledges',async()=>{
 for(const action of ['frame_favorite','frame_hide'])await fixture(async f=>{
  const assetId=id(90), rule=SYNC_ACTION_RULES[action];
  f.immich.assets.set(assetId,new Set(['frame/eligible']));
  const verify=f.review.verifyAndRepairTags.bind(f.review);
  let release, verifying=false, replied=false, result, failure;
  const gate=new Promise(resolve=>{release=resolve;});
  f.review.verifyAndRepairTags=async(...args)=>{verifying=true;await gate;return verify(...args);};
  // Immich accepts the write but initially drops it. The response must not
  // wait for the repair; success is still followed by real verification.
  const add=f.immich.tagAssetsBulk.bind(f.immich);let mutations=0;
  f.immich.tagAssetsBulk=async p=>{mutations++;if(mutations<=2)return;return add(p);};
  f.review.startSyncWorker();
  const request=f.review.frameDecision(assetId,action).then(r=>{result=r;replied=true;},e=>{failure=e;});
  try {
   await waitFor(()=>replied||failure);
   assert.equal(failure,undefined);assert.equal((result.tag??result.addedTag).value,rule.add[0]);
   await waitFor(()=>verifying);
   assert.equal(mutations,2,'one inline mutation and one worker attempt; no inline verification');
   assert.equal(f.repo.pendingSyncJobCount(),1);assert.ok(f.repo.decisions.pendingFor(assetId).length>0);
  } finally {release();await request;}
  await waitFor(()=>f.repo.pendingSyncJobCount()===0);
  assert.equal(f.repo.decisions.pendingFor(assetId).length,0);
  assert.ok(f.immich.assets.get(assetId).has(rule.add[0]));
  if(action==='frame_hide')assert.equal(f.immich.assets.get(assetId).has('frame/eligible'),false);
 });
});
test('failed inline Frame work wakes the worker after the attempt and remains recoverable',async()=>{
 await fixture(async f=>{
  const add=f.immich.tagAssetsBulk.bind(f.immich);let first=true;
  f.immich.tagAssetsBulk=async p=>{if(first){first=false;throw Error('temporary connection failure');}return add(p);};
  f.review.startSyncWorker();
  await assert.rejects(f.review.frameDecision(IDS[0],'frame_favorite'),e=>e.savedLocally===true);
  await waitFor(()=>f.repo.pendingSyncJobCount()===0);
  assert.ok(f.immich.assets.get(IDS[0]).has('frame/favorite'));assert.equal(f.repo.decisions.pendingFor(IDS[0]).length,0);
 });
});
test('failed synchronization reports failure and retries current work without new human revision or AI',async()=>{
 await fixture(async f=>{f.seed();const receipt=await f.curate.applyDecision(await f.operation());const j=f.repo.nextSyncJob();f.repo.deadLetterSyncJob(j.id,'Permission denied');
 assert.equal(f.repo.decisions.status(receipt.operationId).sync,'failed');const human=f.repo.decisions.humanId(IDS[0]);
 f.repo.decisions.retry(receipt.operationId);assert.equal(f.repo.decisions.humanId(IDS[0]),human);await f.drain();assert.equal(f.repo.decisions.status(receipt.operationId).sync,'synced');
 });
});
test('deleted or trashed remote photos never produce a synced receipt; permanent errors park once',async()=>{
 await fixture(async f=>{f.seed();const receipt=await f.curate.applyDecision(await f.operation());f.immich.getAsset=async()=>({isTrashed:true,tags:[]});f.review.startSyncWorker();
 for(let i=0;i<100&&f.repo.pendingSyncJobCount();i++)await new Promise(r=>setImmediate(r));await f.review.stopSyncWorker();
 assert.equal(f.repo.pendingSyncJobCount(),0);assert.equal(f.repo.deadSyncJobCount(),3);assert.equal(f.repo.decisions.status(receipt.operationId).sync,'failed');assert.equal(f.immich.calls.length,0);
});
});
test('consecutive Frame HTTP actions do not wait on the default 1500 ms worker settle',async t=>{
 await fixture(async f=>{
  const {createServer}=await import('node:http');const {createVoiceRoutes}=await import('../../src/routes/voice.mjs');
  const route=createVoiceRoutes({immich:f.immich,review:f.review,config:{voice:{},ambient:{}},requireImmich:()=>true});
  const server=createServer(async(req,res)=>{if(!await route(req,res,new URL(req.url,'http://local')))res.writeHead(404).end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/assets/`;
  f.review.verifyDelayMs=1500;
  const verify=f.review.verifyAndRepairTags.bind(f.review);let settling=false;
  f.review.verifyAndRepairTags=(...args)=>{settling=true;return verify(...args);};
  f.review.startSyncWorker();const timings=[];
  try {
   for(let i=0;i<4;i++) {
    const started=performance.now();const response=await fetch(base+id(i+90)+(i%2?'/never-show':'/favorite'),{method:'POST'});
    assert.equal(response.status,200);await response.json();timings.push(performance.now()-started);
    assert.ok(timings.at(-1)<1000,`Frame action ${i+1} waited ${timings.at(-1)} ms`);
    if(i===0)await waitFor(()=>settling);
   }
   assert.ok(f.repo.pendingSyncJobCount()>0,'verification remains pending after the fast replies');
  } finally {
   f.review.verifyDelayMs=0;await f.review.stopSyncWorker();await new Promise(r=>server.close(r));
  }
  await f.drain();assert.equal(f.repo.pendingSyncJobCount(),0);
  t.diagnostic(`Consecutive Frame HTTP actions: ${timings.map(n=>n.toFixed(1)).join(', ')} ms`);
 });
});
test('newer Frame Hide during settle, verification reads or repair settle prevents stale approval repair',async()=>{
 for(const phase of ['settle','read','repair-settle'])await fixture(async f=>{
  f.seed([IDS[0]]);const receipt=f.review.applyDecision({action:'approve',assetIds:[IDS[0]]}).receipt;
  let release, entered=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const verify=f.review.verifyAndRepairTags.bind(f.review);
  let passes=0;
  f.review.verifyAndRepairTags=(job,options)=>verify(job,{...options,runExclusive:async work=>{
   passes++;
   if((phase==='settle'&&passes===1)||(phase==='repair-settle'&&passes===2)){entered=true;await gate;}
   return options.runExclusive(work);
  }});
  if(phase==='repair-settle') {
   const add=f.immich.tagAssetsBulk.bind(f.immich);let first=true;
   f.immich.tagAssetsBulk=async p=>{if(first){first=false;return;}return add(p);};
  }
  if(phase==='read') {
   const get=f.immich.getAsset.bind(f.immich);let reads=0;
   f.immich.getAsset=async assetId=>{
    if(++reads===2){f.immich.assets.get(assetId).delete('frame/eligible');entered=true;await gate;}
    return get(assetId);
   };
  }
  const recordFailure=f.repo.recordSyncJobFailure.bind(f.repo);let failures=0;
  f.repo.recordSyncJobFailure=(...args)=>{failures++;return recordFailure(...args);};
  f.review.startSyncWorker();let hide;
  try {
   await waitFor(()=>entered);const start=f.immich.calls.length;
   let replied=false;hide=f.review.frameDecision(IDS[0],'frame_hide').then(()=>{replied=true;});
   if(phase!=='read')await waitFor(()=>replied); // no write lock held during either settle
   release();await hide;await waitFor(()=>f.repo.pendingSyncJobCount()===0);
   assert.ok(f.immich.calls.slice(start).every(([kind,,tags])=>!(kind==='add'&&tags.includes('frame/eligible'))));
   assert.ok(f.immich.assets.get(IDS[0]).has('frame/never-show'));assert.equal(f.immich.assets.get(IDS[0]).has('frame/eligible'),false);
   assert.equal(failures,0);assert.equal(f.repo.deadSyncJobCount(),0);
   assert.equal(f.repo.decisions.status(receipt.operationId).sync,'superseded');
  } finally {release();await hide;}
 });
});
test('unavailable photos are isolated; healthy siblings sync, and ordinary failed-job retry recovers after restart',async()=>{
 for(const mode of ['trashed','offline','404','410','local','verification','bulk-race'])await fixture(async f=>{
  f.seed();const receipt=f.review.applyDecision({action:'reviewed',assetIds:IDS}).receipt;
  const human=IDS.map(assetId=>f.repo.decisions.humanId(assetId));
  const get=f.immich.getAsset.bind(f.immich), add=f.immich.tagAssetsBulk.bind(f.immich);
  let broken=true, readCount=0, writeStarted=false;
  if(mode==='local')f.repo.curate.observe({id:IDS[1],isOffline:true});
  f.immich.getAsset=async assetId=>{
   if(assetId!==IDS[1]||!broken||mode==='local')return get(assetId);
   if(mode==='verification'&&++readCount===1)return get(assetId);
   if(mode==='bulk-race'&&!writeStarted)return get(assetId);
   if(['404','410','bulk-race'].includes(mode))throw Object.assign(Error('Photo gone'),{status:Number(mode==='bulk-race'?404:mode)});
   return {...await get(assetId),[mode==='offline'?'isOffline':'isTrashed']:true};
  };
  if(mode==='bulk-race')f.immich.tagAssetsBulk=async p=>{
   await add(p);writeStarted=true;
   if(broken&&p.assetIds.includes(IDS[1]))throw Object.assign(Error('Photo vanished during mutation'),{status:404});
  };
  f.review.startSyncWorker();await waitFor(()=>f.repo.pendingSyncJobCount()===0);await f.review.stopSyncWorker();
  const [failed]=f.repo.deadSyncJobs();assert.equal(f.repo.deadSyncJobCount(),1,mode);assert.deepEqual(failed.assetIds,[IDS[1]]);
  assert.equal(failed.attempts,1);assert.equal(f.repo.decisions.status(receipt.operationId).sync,'failed');
  assert.equal(f.repo.decisions.status(receipt.operationId).synced,2);assert.equal(f.repo.decisions.status(receipt.operationId).pending,1);
  for(const assetId of [IDS[0],IDS[2]])assert.ok(f.immich.assets.get(assetId).has('frame/reviewed'));
  assert.deepEqual(IDS.map(assetId=>f.repo.decisions.humanId(assetId)),human);
  await f.restart();assert.equal(f.repo.decisions.status(receipt.operationId).synced,2);
  // Retry once while still unavailable: healthy photos are not rewritten.
  const calls=f.immich.calls.length;
  f.review.retryDeadSyncJobs(failed.id);f.review.startSyncWorker();await waitFor(()=>f.repo.pendingSyncJobCount()===0);await f.review.stopSyncWorker();
  assert.equal(f.immich.calls.length,calls);assert.equal(f.repo.deadSyncJobCount(),1);
  broken=false;if(mode==='local')f.repo.curate.observe({id:IDS[1],isOffline:false});
  f.repo.decisions.retry(receipt.operationId);await f.drain();
  assert.equal(f.repo.decisions.status(receipt.operationId).sync,'synced');assert.equal(f.repo.deadSyncJobCount(),0);
  assert.deepEqual(IDS.map(assetId=>f.repo.decisions.humanId(assetId)),human);
 });
});
test('isolating unavailable jobs is atomic, preserves operation links and does not consume backlog capacity',async()=>{
 await fixture(async f=>{
  f.seed();const receipt=f.review.applyDecision({action:'reviewed',assetIds:IDS}).receipt;
  const job=f.repo.nextSyncJob();
  f.repo.db.exec("CREATE TRIGGER fail_split BEFORE INSERT ON decision_sync_links BEGIN SELECT RAISE(ABORT,'split fault'); END;");
  assert.throws(()=>f.repo.deadLetterSyncJobAssets(job.id,[IDS[1]],'unavailable'),/split fault/);
  assert.deepEqual(f.repo.nextSyncJob().assetIds,IDS);assert.equal(f.repo.deadSyncJobCount(),0);
  assert.equal(f.repo.decisions.status(receipt.operationId).pending,3);f.repo.db.exec('DROP TRIGGER fail_split');
  const padding=Array.from({length:1000},(_,i)=>id(i+100));
  for(let i=0;i<10;i++)f.repo.enqueueDecisionSync({assetIds:i===9?padding.slice(3):padding,action:'approve',addTags:['frame/eligible'],removeTags:[]});
  const refs=()=>f.repo.db.prepare('SELECT SUM(json_array_length(asset_ids_json)) n FROM pending_sync_jobs').get().n;
  assert.equal(refs(),10000);f.repo.deadLetterSyncJobAssets(job.id,[IDS[1]],'unavailable');assert.equal(refs(),10000);
  assert.deepEqual(f.repo.nextSyncJob().assetIds,[IDS[0],IDS[2]]);assert.equal(f.repo.decisions.status(receipt.operationId).pending,3);
  assert.equal(f.repo.decisions.status(receipt.operationId).sync,'failed');
 });
});
test('shared tag-service 404 and permission failures do not classify healthy photos as unavailable',async()=>{
 for(const status of [403,404])await fixture(async f=>{
  f.seed();f.review.applyDecision({action:'reviewed',assetIds:IDS});
  const list=f.immich.listTags.bind(f.immich);f.immich.listTags=async()=>{throw Object.assign(Error('tag service failure'),{status});};
  f.review.startSyncWorker();await waitFor(()=>f.repo.nextSyncJob()?.attempts===1);await f.review.stopSyncWorker();
  assert.equal(f.repo.deadSyncJobCount(),0);assert.deepEqual(f.repo.nextSyncJob().assetIds,IDS);
  f.immich.listTags=list;await f.drain();assert.equal(f.repo.pendingSyncJobCount(),0);
 });
});
test('retention pins pending work, then keeps receipts and tombstones for successive 30-day windows',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();const receipt=await f.curate.applyDecision(input);const now=Date.now();
 f.repo.decisions.prune(now+100*RECEIPT_MS);assert.deepEqual(f.repo.decisions.replay(input),receipt);
 await f.drain();f.repo.decisions.prune(now);f.repo.decisions.prune(now+RECEIPT_MS-1);assert.deepEqual(f.repo.decisions.replay(input),receipt);
 f.repo.decisions.prune(now+RECEIPT_MS);assert.throws(()=>f.repo.decisions.replay(input),/expired/);
 f.repo.decisions.prune(now+RECEIPT_MS+TOMBSTONE_MS);assert.equal(f.repo.decisions.replay(input),null);
 await assert.rejects(f.curate.applyDecision(input),/expired/);
 });
});
test('schema-13 pending/dead jobs adopt local latest intent once; upgrade and restart do not alter decisions',async()=>{
 await fixture(async f=>{f.seed();f.repo.recordDecision({assetIds:[IDS[0]],action:'approve',...{addTags:['frame/eligible'],removeTags:[]}});f.accept('frame_hide',IDS[0]);
 const old=f.repo.nextSyncJob();f.repo.deadLetterSyncJob(old.id,'old failure');
 f.repo.db.exec('DELETE FROM decision_intents; DELETE FROM decision_meta; PRAGMA user_version=13');const tags=local(f,IDS[0]);
 await f.restart();assert.equal(f.repo.db.prepare('PRAGMA user_version').get().user_version,16);assert.deepEqual(local(f,IDS[0]),tags);assert.equal(f.repo.deadSyncJobCount(),1);
 f.repo.retryDeadSyncJobs(old.id);await f.drain();assert.ok(f.immich.assets.get(IDS[0]).has('frame/never-show'));assert.equal(f.immich.assets.get(IDS[0]).has('frame/eligible'),false);
 });
});

test('HTTP operation lifecycle uses issued scope, supports exact retry/status/Undo and rejects malformed or advice actions',async()=>{
 await fixture(async f=>{
  const {createServer}=await import('node:http');const {createCurateRoutes}=await import('../../src/routes/curate.mjs');
  f.seed();const route=createCurateRoutes({curate:f.curate,review:f.review});
  const server=createServer(async(req,res)=>{try{if(!await route(req,res,new URL(req.url,'http://local')))res.writeHead(404).end();}catch(e){res.writeHead(500).end(e.message);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/review/curate/`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
   const v=await(await post('groups',{})).json();const c=await(await post('comparisons',{viewId:v.viewId,groupId:v.groups[0].id})).json();
   assert.equal((await post('operations',{comparisonId:c.id,mode:'advice'})).status,409);
   const issued=await(await post('operations',{comparisonId:c.id})).json();const {expiresAt,...scope}=issued;
   const input={...scope,outcomes:Object.fromEntries(IDS.map(x=>[x,'approve']))};
   assert.equal((await post('operations/apply',{...input,outcomes:{[IDS[0]]:'approve'}})).status,400);
   const receipt=await(await post('operations/apply',input)).json();assert.equal(receipt.savedLocally,true);
   assert.deepEqual(await(await post('operations/apply',input)).json(),receipt);
   assert.equal((await fetch(base+'operations/status?operationId='+receipt.operationId)).status,200);
   const undo=await post('operations/apply',undoPayload(receipt));assert.equal(undo.status,200);
   assert.equal((await post('operations/retry',{operationId:receipt.operationId})).status,200);
  }finally{await new Promise(r=>server.close(r));}
 });
});
test('Frame routes use the shared writer, retain response fields and report saved-but-pending failures',async()=>{
 await fixture(async f=>{
  const {createServer}=await import('node:http');const {createVoiceRoutes}=await import('../../src/routes/voice.mjs');
  const route=createVoiceRoutes({immich:f.immich,review:f.review,config:{voice:{},ambient:{}},requireImmich:()=>true});
  const server=createServer(async(req,res)=>{try{if(!await route(req,res,new URL(req.url,'http://local')))res.writeHead(404).end();}catch(e){res.writeHead(500).end(e.message);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/assets/`;
  try{
   let response=await fetch(base+id(90)+'/favorite',{method:'POST'});assert.equal(response.status,200);assert.equal((await response.json()).tag.value,'frame/favorite');
   response=await fetch(base+id(90)+'/never-show',{method:'POST'});assert.equal(response.status,200);const body=await response.json();assert.equal(body.addedTag.value,'frame/never-show');assert.equal(body.removedTag.value,'frame/eligible');
   await f.drain();f.immich.tagAssetsBulk=async()=>{throw Error('PRIVATE credential from remote');};
   response=await fetch(base+id(91)+'/favorite',{method:'POST'});assert.equal(response.status,502);const fail=await response.json();assert.equal(fail.savedLocally,true);assert.equal(fail.sync,'pending');assert.doesNotMatch(JSON.stringify(fail),/PRIVATE/);assert.equal(f.repo.pendingSyncJobCount(),1);
   assert.equal((await fetch(base+'bad-id/favorite',{method:'POST'})).status,400);
  }finally{await new Promise(r=>server.close(r));}
 });
});

test('an operation at lease capacity can atomically consume its scope and issue Undo',async()=>{
 await fixture(async f=>{f.seed();const input=await f.operation();for(let i=1;i<MAX_LEASES;i++)f.repo.curate.lease('operation',{kind:'undo',targetOperationId:'unused-'+i});
 const receipt=await f.curate.applyDecision(input);assert.ok(receipt.undo.operationId);assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_leases WHERE kind='operation'").get().n,MAX_LEASES-1);
 });
});
test('legacy migration skips malformed maximum SQLite IDs without looping or losing later restart',async()=>{
 await fixture(async f=>{f.repo.db.exec(`DELETE FROM decision_meta; INSERT INTO pending_sync_jobs(id,action,asset_ids_json,add_tags_json,remove_tags_json,created_at) VALUES(9223372036854775807,'approve','[]','[]','[]','now')`);
 await f.restart();assert.equal(f.repo.pendingSyncJobCount(),1);assert.match(f.repo.nextSyncJob().invalidReason,/row identifier/);
 });
});

test('legacy Keep best is atomic and its existing Undo is conditional across Frame actions',async()=>{
 await fixture(async f=>{f.seed();const result=f.review.applyDecision({action:'selection',assetIds:IDS,keepers:[IDS[0]]});
 assert.equal(result.receipt.assetCount,3);assert.deepEqual(local(f,IDS[0]),['frame/eligible']);assert.deepEqual(local(f,IDS[1]),['frame/reviewed']);
 f.accept('frame_favorite',IDS[1]);await assert.rejects(f.curate.applyDecision(undoPayload(result.receipt)),/newer human/);
 assert.deepEqual(local(f,IDS[2]),['frame/reviewed']);
 });
 await fixture(async f=>{f.seed();f.repo.db.exec("CREATE TRIGGER fail_remainder BEFORE INSERT ON asset_tags WHEN NEW.tag='frame/reviewed' BEGIN SELECT RAISE(ABORT,'remainder fault'); END;");
 assert.throws(()=>f.review.applyDecision({action:'selection',assetIds:IDS,keepers:[IDS[0]]}),/remainder fault/);IDS.forEach(x=>assert.deepEqual(local(f,x),[]));assert.equal(f.repo.pendingSyncJobCount(),0);
 });
});
test('legacy selection rejects stale decided members instead of silently clearing a favorite',async()=>{
 await fixture(async f=>{f.seed();f.accept('frame_favorite',IDS[2]);assert.throws(()=>f.review.applyDecision({action:'selection',assetIds:IDS,keepers:[IDS[0]]}),/already been decided/);assert.deepEqual(local(f,IDS[0]),[]);});
});
test('hundreds of accepted decisions issue indexed Undo IDs without exhausting comparison scope capacity',async()=>{
 await fixture(async f=>{const ids=Array.from({length:250},(_,i)=>id(i+1));f.seed(ids);let last;
 for(const assetId of ids)last=f.review.applyDecision({action:'approve',assetIds:[assetId]});
 assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_leases WHERE kind='operation'").get().n,0);
 assert.equal(f.repo.decisions.undoLease(last.receipt.undo.operationId,Date.now()).targetOperationId,last.receipt.operationId);
 const plan=f.repo.db.prepare("EXPLAIN QUERY PLAN SELECT receipt_json FROM decision_operations WHERE json_extract(receipt_json,'$.undo.operationId')=?").all(last.receipt.undo.operationId);
 assert.ok(plan.some(row=>row.detail.includes('idx_decision_undo_id')));
 });
});

test('a Frame action settling older human work does not drop the older Curate AI-tag synchronization',async()=>{
 await fixture(async f=>{f.seed();f.repo.recordProcessingRun({assetId:IDS[0],provider:'test',model:'test',promptVersion:'v1',taxonomyVersion:'v1',status:'succeeded',normalizedOutput:{}});
 f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES(?,'ai/scene/landscape','ai','now')").run(IDS[0]);
 f.accept('approve',IDS[0]);await f.review.frameDecision(IDS[0],'frame_hide');
 await f.review.pushDecisionToImmich({assetIds:[IDS[0]],action:'frame_hide'});
 assert.equal(f.repo.decisions.pendingFor(IDS[0]).length,0);assert.equal(f.immich.assets.get(IDS[0]).has('ai/scene/landscape'),false);
 await f.drain();assert.ok(f.immich.assets.get(IDS[0]).has('ai/scene/landscape'));assert.ok(f.immich.assets.get(IDS[0]).has('frame/never-show'));assert.equal(f.immich.assets.get(IDS[0]).has('frame/eligible'),false);
 });
});

test('remaining AI-tag work keeps operation sync/status/retry/retention honest after human intent is superseded',async()=>{
 await fixture(async f=>{f.seed();f.repo.recordProcessingRun({assetId:IDS[0],provider:'test',model:'test',promptVersion:'v1',taxonomyVersion:'v1',status:'succeeded',normalizedOutput:{}});
 f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES(?,'ai/scene/landscape','ai','now')").run(IDS[0]);
 const receipt=f.review.applyDecision({action:'approve',assetIds:[IDS[0]]}).receipt;
 await f.review.frameDecision(IDS[0],'frame_hide');
 await f.review.pushDecisionToImmich({assetIds:[IDS[0]],action:'frame_hide'});
 assert.equal(f.repo.decisions.pendingFor(IDS[0]).length,0);assert.equal(f.repo.decisions.status(receipt.operationId).sync,'pending');
 const original=f.immich.tagAssetsBulk.bind(f.immich);f.immich.tagAssetsBulk=async()=>{throw Error('tag permission failure');};
 const job=f.repo.nextSyncJob();await assert.rejects(f.review.pushDecisionToImmich(job));f.repo.deadLetterSyncJob(job.id,'tag permission failure');
 assert.equal(f.repo.decisions.status(receipt.operationId).sync,'failed');f.repo.decisions.prune(Date.now()+100*RECEIPT_MS);assert.equal(f.repo.decisions.status(receipt.operationId).sync,'failed');
 f.immich.tagAssetsBulk=original;assert.ok(f.repo.decisions.retry(receipt.operationId).retried>0);await f.drain();assert.equal(f.repo.decisions.status(receipt.operationId).sync,'superseded');
 });
});
