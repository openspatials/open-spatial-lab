import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=process.env.OSL_CANDIDATE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(root,'set OSL_CANDIDATE_ROOT');
const require=createRequire(import.meta.url);
const {createRuntime}=require(root+'/runtime/world-server/src/runtime-state.js');
const {makeConfig}=require(root+'/runtime/world-server/src/config.js');
const original={setInterval,clearInterval,Date,random:Math.random,log:console.log,error:console.error};
let now=100000;
globalThis.Date=class extends original.Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
Math.random=()=>0.25;
const timers=new Map(),runtimes=[],checks=[],errors=[];
globalThis.setInterval=(fn,ms)=>{const id={unref(){return this;}};timers.set(id,{fn,ms});return id;};
globalThis.clearInterval=id=>timers.delete(id);
console.log=()=>{};console.error=(...args)=>errors.push(args.join(' '));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'osl-composition-'));
const only=process.argv.includes('--only')?process.argv[process.argv.indexOf('--only')+1]:null;
function runtime(){process.env.OSL_WOW_SPATIAL_DIR=path.join(directory,String(runtimes.length));process.env.OSL_WOW_SPATIAL_PERSIST='0';const r=createRuntime(makeConfig('a'));runtimes.push(r);return r;}
async function check(name,fn){if(only&&only!==name)return;try{await fn();checks.push(name);original.log('PASS '+name);}catch(e){original.log('FAIL '+name+': '+e.message);throw e;}}
try{
 await check('simulator-completion-stop',async()=>{
  const r=runtime(),rootNode=r.getSpatialGraphRoot('1',{form:'flat'});
  const node=r.createSpatialNodes('1',rootNode.id,[{label:'simulate',properties:{retained:7}}],{form:'flat'}).value[0];
  const sim=r.startSimulator({interval_ms:37,count:2,node_id:node.id});const timer=sim.timer;
  let done=false;sim.done.then(()=>{done=true;});
  timers.get(timer).fn();assert.equal(r.getSimulatorLog().length,1);assert.equal(done,false);
  timers.get(timer).fn();await Promise.resolve();assert.equal(done,true,'simulator completes exactly at requested count');
  assert.equal(timers.has(timer),false);assert.equal(sim.timer,null);assert.equal(r.getSimulatorLog().length,2);
  assert.equal(r.getSpatialNode('1',node.id,{form:'flat'}).properties.retained,7);
  assert.ok(r.getSimulatorLog().every(x=>x.changed));
  const second=r.startSimulator({interval_ms:37,count:20,node_id:node.id});let stoppedDone=false;second.done.then(()=>{stoppedDone=true;});
  r.stopSimulator();await Promise.resolve();assert.equal(second.timer,null);assert.equal(stoppedDone,false,'historical early stop leaves done unresolved');
  assert.equal([...timers.values()].filter(x=>x.ms===37).length,0);
 });
 await check('scene-versioning-and-existing-drift',()=>{
  const r=runtime(),objects=r.getSceneObjects().objects,object=objects[0];
  const node=r.listSpatialNodes().find(x=>x.node.names?.includes(object.object_id)).node;
  const transform=node.localTransform.slice(),version=r.getUmAttachPoint().version;
  assert.throws(()=>r.moveSceneObject('missing',[0,0,0]),/unknown scene object/);
  const moved=r.moveSceneObject(object.object_id,[999,999,-999]);assert.equal(moved.position[0],5.4);assert.equal(moved.position[1],object.position[1]);
  assert.equal(r.getUmAttachPoint().version,version+1);assert.deepEqual(r.getSpatialNode('1',node.id,{form:'flat'}).localTransform,transform,'historical object/node drift is preserved, not repaired by extraction');
  for(const resolution of ['color','snapshot3d','splats'])assert.ok(r.getPortalView(resolution));assert.equal(r.getPortalView('unknown'),null);
  const before=r.getState().debug.state_revision;r.tick();assert.equal(r.getState().server_tick,1);assert.equal(r.getState().debug.state_revision,before);
 });
 await check('snapshot-isolation-and-reset-order',()=>{
  const r=runtime(),trace=[];const bad=r.subscribe(()=>{throw new Error('snapshot listener fixture');});
  const good=r.subscribe(s=>trace.push(['state',s]));const event=r.subscribeEvents(e=>trace.push(['event',e]));
  r.registerPresence({player_id:'reset-player',position:[0,0,0]});r.recordPortalArrival({target:{location_id:r.LOCATION_ID},avatar_context:{avatar_id:'incoming'}});
  const snapshot=r.getState();snapshot.avatar.transform.position[0]=999;assert.notEqual(r.getState().avatar.transform.position[0],999);
  trace.length=0;const reset=r.reset();assert.equal(reset.session.arrival_count,0);assert.equal(reset.avatar.avatar_id,'avatar-local-001');
  assert.equal(trace[0][0],'state');assert.equal(trace[0][1].session.connected_clients.length,0);assert.equal(trace.at(-1)[1].type,'user_left');
  assert.equal(trace.filter(x=>x[0]==='event'&&x[1].type==='user_left').length,1);
  assert.ok(errors.some(x=>x.includes('snapshot listener fixture')));
  const seen=trace.length;good();event();bad();r.reset();assert.equal(trace.length,seen);assert.equal(r.subscriberCount(),0);assert.equal(r.eventSubscriberCount(),0);
 });
 await check('republish-lifecycle-and-exit-departure',()=>{
  const r=runtime();const count=()=>[...timers.values()].filter(x=>x.ms===100).length;const total=count();
  r.setRepublishRate(0);assert.equal(count(),total-1);r.setRepublishRate(1);assert.equal(count(),total);
  const timer=[...timers.values()].filter(x=>x.ms===100).at(-1);const version=r.getUmAttachPoint().version;timer.fn();
  assert.equal(r.getUmAttachPoint().version,version+1);assert.equal(r.getRepublishRate().republish_tick_count,1);
  r.reset();r.reset();assert.equal(count(),total,'reset replaces the one republish timer');assert.equal(r.getRepublishRate().republish_tick_count,1);
  r.registerPresence({player_id:'crossing'});const packet=r.recordPortalExitIntent(r.getState().portals[0].portal_id,'crossing');
  assert.equal(packet.presence_departure.departed,true);assert.equal(r.getWowUser('crossing'),null);assert.equal(r.heartbeatPresence({player_id:'crossing'}).departed,true);
  assert.equal(packet.avatar_context.state_revision,r.getState().debug.state_revision-1);assert.ok(packet.handoff_id.endsWith('-250000'));
 });
 original.log(JSON.stringify({passed:checks.length,checks,networkRequests:0}));
}finally{
 for(const r of runtimes){r.stopPresenceSweeper();r.stopRepublishTimer();r.stopSimulator();}
 fs.rmSync(directory,{recursive:true,force:true});Object.assign(globalThis,{Date:original.Date,setInterval:original.setInterval,clearInterval:original.clearInterval});Math.random=original.random;console.log=original.log;console.error=original.error;
 assert.equal(timers.size,0,'all owned timers released');
}
