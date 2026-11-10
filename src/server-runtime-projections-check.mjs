import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=process.env.OSL_CANDIDATE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(root,'set OSL_CANDIDATE_ROOT');
const require=createRequire(import.meta.url);
const {createRuntime}=require(root+'/runtime/world-server/src/runtime-state.js');
const {makeConfig}=require(root+'/runtime/world-server/src/config.js');
const {linkPortalArrivals}=require(root+'/runtime/world-server/src/portal-standard.js');
const original={Date,setInterval,clearInterval,log:console.log};
let now=100000;
globalThis.Date=class extends original.Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
const timers=new Map(),runtimes=[],checks=[];
globalThis.setInterval=(fn,ms)=>{const id={unref(){return this;}};timers.set(id,{fn,ms});return id;};
globalThis.clearInterval=id=>timers.delete(id);
console.log=()=>{};
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'osl-projections-'));
const only=process.argv.includes('--only')?process.argv[process.argv.indexOf('--only')+1]:null;
function runtime(key,alter=cfg=>cfg){
 process.env.OSL_WOW_SPATIAL_DIR=path.join(directory,String(runtimes.length));
 process.env.OSL_WOW_SPATIAL_PERSIST='0';
 const r=createRuntime(alter(makeConfig(key)));runtimes.push(r);return r;
}
async function check(name,fn){if(only&&only!==name)return;try{await fn();checks.push(name);original.log('PASS '+name);}catch(e){original.log('FAIL '+name+': '+e.message);throw e;}}
function pages(r,portal,radius,options){
 const results=[];let cursor;
 do{const result=r.getFabricRegionChunk(portal,radius,{...options,cursor});results.push(result);cursor=result.continuation?.cursor;assert.ok(results.length<200,'continuation makes progress');}while(cursor);
 return results;
}
try{
 await check('portal-direction-counterpart',()=>{
  const a=runtime('a',cfg=>({...cfg,portals:cfg.portals.map(p=>({...p,traversal:{mode:'one_way',allowed_entry_side:'back'}}))})),b=runtime('b');
  linkPortalArrivals([a,b]);
  const pa=a.getWowPortalResource(1),pb=b.getWowPortalResource(1),x=pa.webofworlds_extension;
  assert.equal(x.traversal.allowed_entry_side,'back');assert.equal(x.traversal.blocked_entry_side,'front');
  assert.deepEqual(x.zones.prefetch.armed_entry_sides,['back']);assert.deepEqual(x.zones.traversal.armed_entry_sides,['back']);
  assert.equal(x.shared_edge.edge_id,pb.webofworlds_extension.shared_edge.edge_id);
  assert.equal(x.shared_edge.counterpart.portal_id,pb.webofworlds_extension.portal_id);
  assert.ok(pa.destination.endsWith('#join=node.'+b.portalArrivalNodeId(x.shared_edge.counterpart.portal_id)));
  assert.equal(a.getWowPortal('missing'),null);assert.equal(a.getWowPortalResource(999),null);
  b.movePortal([1,0,2]);assert.notDeepEqual(b.getWowPortalResource(1).geoPose,pb.geoPose);
  assert.equal(a.getWowPortalResource(1).webofworlds_extension.shared_edge.edge_id,x.shared_edge.edge_id);
 });
 await check('region-nonempty-empty-expired',()=>{
  const r=runtime('airport'),portal=r.getState().portals[0],id=portal.portal_id,anchor=portal.trigger.position;
  const region=r.getFabricRegion(id,24);assert.ok(region.entities.length>0);assert.ok(region.totals.excluded_entities>0);assert.equal(region.region.radius_m,24);
  r.registerPresence({player_id:'inside',position:anchor,requested_ttl_ms:1000});
  r.registerPresence({player_id:'outside',position:[anchor[0]+100,0,anchor[2]],requested_ttl_ms:1000});
  r.registerPresence({player_id:'unpositioned',requested_ttl_ms:1000});
  const before=r.currentRevision(),stateRevision=r.getState().debug.state_revision;
  assert.equal(r.getFabricRegion(id,24).avatars.avatars_in_circle,1);assert.equal(r.getFabricRegion(id,24).avatars.avatars_without_position,1);
  now+=1001;assert.equal(r.getFabricRegion(id,24).avatars.avatars_in_circle,0);assert.equal(r.getFabricRegion(id,24).presence.occupancy.registered_player_count,0);
  assert.deepEqual(r.currentRevision(),before);assert.equal(r.getState().debug.state_revision,stateRevision);
  const empty=runtime('a',cfg=>({...cfg,portals:cfg.portals.map(p=>({...p,trigger:{...p.trigger,position:[1000,0,1000]}}))}));
  const emptyId=empty.getState().portals[0].portal_id;
  assert.equal(empty.getFabricRegion(emptyId,1).entities.length,0);
  assert.equal(empty.getFabricRegionChunk(emptyId,1,{}).chunk.entity_count,0);
  assert.equal(empty.getFabricRegionChunk(emptyId,1,{}).continuation,null);
  assert.throws(()=>r.getFabricRegion('missing',5),/unknown anchor portal/);
 });
 await check('chunk-budgets-pagination',()=>{
  const r=runtime('airport'),portal=r.getState().portals[0].portal_id;
  const all=pages(r,portal,24,{scope:'full',max_entities:1,max_bytes:256});
  const ids=all.flatMap(x=>x.chunk.entities.map(e=>e.object_id));
  assert.ok(ids.length>10);assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,all[0].totals.fabric_entities);
  assert.ok(all[0].avatars&&all[0].presence&&all[0].portal&&all[0].spawn);
  assert.ok(all.slice(1).every(x=>!('avatars'in x)&&!('presence'in x)&&!('portal'in x)&&!('spawn'in x)));
  for(const chunk of all){assert.ok(chunk.chunk.entity_count<=1);assert.equal(chunk.chunk.byte_size,chunk.chunk.entities.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e)),0));if(chunk.chunk.byte_size>256)assert.equal(chunk.chunk.byte_budget_exceeded_by_single_entity,true);}
  assert.ok(all.some(x=>x.chunk.byte_budget_exceeded_by_single_entity));
  const byteLimited=pages(r,portal,24,{max_entities:64,max_bytes:256});
  assert.ok(byteLimited.some(x=>x.truncation_reason==='byte_budget'));
  const entityLimited=pages(r,portal,24,{scope:'full',max_entities:1,max_bytes:65536});
  assert.ok(entityLimited.every(x=>x.chunk.entity_count<=1),'entity budget holds independently of byte budget');
  assert.ok(all.some(x=>x.chunk.band_label==='beyond_roi'));
  assert.equal(r.getFabricRegionChunk(portal,24,{max_entities:999,max_bytes:999999}).budget.max_entities,64);
  assert.equal(r.getFabricRegionChunk(portal,24,{max_entities:999,max_bytes:999999}).budget.max_bytes,65536);
  for(const options of [{scope:'bad'},{cursor:'bad'},{cursor:'9:0'},{cursor:'0:99999'}])assert.throws(()=>r.getFabricRegionChunk(portal,24,options),/invalid/);
  process.env.OSL_FABRIC_REGION_TTL_OVERRIDES=JSON.stringify({'location-airport':{near:777}});
  assert.equal(r.getFabricRegionChunk(portal,24,{}).region.bands[0].ttl_ms,777);
  delete process.env.OSL_FABRIC_REGION_TTL_OVERRIDES;
  const tiles=r.getFabricRegionTilesetHypothesis(portal,24);assert.equal(tiles.three_d_tiles_conformance,false);assert.equal(tiles.root.children.length,4);
 });
 await check('world-user-view-signing-delete',async()=>{
  const r=runtime('airport');let eventCount=0;const off=r.subscribeEvents(()=>eventCount++);
  const world=r.getWowWorld(),graph=r.getWowGraph(),local=r.getWowUser('me'),view=r.getWowView('player');
  assert.ok(graph.nodes.length>10);assert.ok(world.content.label);assert.ok(local.node&&view.node);assert.ok(view.webofworlds_extension.local_camera.position.every(Number.isFinite));
  assert.equal(r.getWowLocation().world_id,world.id);assert.deepEqual(r.getWowUser(1),local);assert.equal(r.getWowView('missing'),null);
  const signed=await r.getWowUserSigned('me');assert.ok(signed.open_user_manifest.signature);
  const {verifyManifestProfileA}=await import(pathToFileURL(root+'/web/signing/index.mjs').href);
  assert.equal((await verifyManifestProfileA(signed.open_user_manifest)).ok,true);
  assert.equal((await verifyManifestProfileA({...signed.open_user_manifest,name:'tampered'})).ok,false);
  assert.strictEqual((await r.getWowUserSigned(1)).open_user_manifest,signed.open_user_manifest,'same canonical content reuses signature cache');
  assert.equal(eventCount,0,'reads and signing do not create users or mutations');
  r.recordPortalArrival({handoff_id:'rename',target:{location_id:r.LOCATION_ID},avatar_context:{display_name:'Renamed identity'}});
  const renamed=await r.getWowUserSigned('me');
  assert.equal(renamed.open_user_manifest.name,'Renamed identity','signature cache follows canonical content');
  assert.notDeepEqual(renamed.open_user_manifest.signature,signed.open_user_manifest.signature);
  assert.equal((await verifyManifestProfileA(renamed.open_user_manifest)).ok,true);
  assert.equal(r.deleteWowUser('me').status,400);assert.equal(r.deleteWowUser('missing').status,404);
  r.registerPresence({player_id:'deletable',position:[0,0,0]});const user=r.getWowUser('deletable');assert.ok(user.node);
  const deleted=r.deleteWowUser(user.id);assert.equal(deleted.status,200);assert.equal(r.getWowUser('deletable'),null);assert.equal(r.heartbeatPresence({player_id:'deletable'}).departed,true);
  off();
 });
 original.log(JSON.stringify({passed:checks.length,checks,networkRequests:0}));
}finally{
 for(const r of runtimes){r.stopPresenceSweeper();r.stopRepublishTimer();r.stopSimulator();}
 fs.rmSync(directory,{recursive:true,force:true});
 Object.assign(globalThis,{Date:original.Date,setInterval:original.setInterval,clearInterval:original.clearInterval});console.log=original.log;
 delete process.env.OSL_FABRIC_REGION_TTL_OVERRIDES;
 assert.equal(timers.size,0,'all timers released');
}
