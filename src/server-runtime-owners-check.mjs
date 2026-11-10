import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.OSL_CANDIDATE_ROOT || path.resolve(here,'..');
const require=createRequire(import.meta.url);
const {createRuntime}=require(root+'/runtime/world-server/src/runtime-state.js');
const {makeConfig}=require(root+'/runtime/world-server/src/config.js');
const {translationMatrix}=require(root+'/runtime/world-server/src/spatial-graph.js');
const chosen=process.argv.includes('--only')?process.argv[process.argv.indexOf('--only')+1]:null;
const original={setInterval,clearInterval,now:Date.now,log:console.log,error:console.error};
const intervals=new Map(),runtimes=[],lines=[],checks=[];
let clock=100000,failed=0;
Date.now=()=>clock;
globalThis.setInterval=(fn,ms)=>{const id={unref(){return this;}};intervals.set(id,{fn,ms});return id;};
globalThis.clearInterval=id=>intervals.delete(id);
console.log=(...x)=>lines.push(x.join(' ')); console.error=(...x)=>lines.push(x.join(' '));
const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'osl-server-owners-'));
const config=()=>({...makeConfig('a'),event_replay_limit:4});
function runtime(label,extra={}) {
  const directory=path.join(fixtureRoot,label); fs.mkdirSync(directory,{recursive:true});
  process.env.OSL_WOW_SPATIAL_DIR=directory;process.env.OSL_WOW_SPATIAL_PERSIST='0';
  const r=createRuntime({...config(),...extra});runtimes.push(r);return r;
}
const stop=r=>{r.stopPresenceSweeper();r.stopRepublishTimer();r.stopSimulator();};
async function check(name,fn) {
  if(chosen && chosen!==name)return;
  try{await fn();checks.push(name);original.log('PASS '+name);}
  catch(e){failed++;original.error('FAIL '+name+': '+e.message);}
}
try {
  await check('events',()=>{
    const r=runtime('events'),seen=[],other=[];
    const offBad=r.subscribeEvents(()=>{throw new Error('listener fixture');});
    const offA=r.subscribeEvents(e=>seen.push(e)),offB=r.subscribeEvents(e=>other.push(e));
    const start=r.currentRevision().revision;
    r.registerPresence({player_id:'p',position:[0,0,0]});
    assert.ok(seen.length>=2);assert.deepEqual(other,seen);
    assert.equal(seen[0].type,'user_joined');assert.equal(seen[1].type,'node_created');
    assert.equal(seen[0].revision,start+1);assert.equal(seen[1].revision,start+2);
    assert.ok(seen.every(e=>e.urls.includes('wow/world')));
    assert.equal(r.lastChangeOf('wow/user/'+seen[0].user.id),seen[0].time);
    assert.ok(lines.some(x=>x.includes('listener fixture')));
    offBad();offA();offB();assert.equal(r.eventSubscriberCount(),0);
  });
  await check('revision-restart',()=>{
    const a=runtime('restart');a.registerPresence({player_id:'restart'});
    const saved=a.currentRevision();stop(a);
    const b=runtime('restart');assert.deepEqual(b.currentRevision(),saved);
    assert.equal(b.getWowEventsHello().revision,saved.revision);
    assert.deepEqual(b.eventsSince(saved.revision),{events:[]});
    assert.equal(b.eventsSince(saved.revision-1).resync,true,'journal history is not invented across restart');
    b.registerPresence({player_id:'next'});assert.ok(b.currentRevision().revision>saved.revision);
  });
  await check('graph-shared-ids',()=>{
    const cfg=config(),anchor=cfg.spatial_anchors.graphs[0];
    const r=runtime('graphs',{spatial_anchors:{graphs:[anchor,{id:2}]}});
    const first=r.getSpatialGraphRoot('1',{form:'flat'}),second=r.getSpatialGraphRoot('2',{form:'flat'});
    const a=r.createSpatialNodes('1',first.id,[{label:'a'}],{form:'flat'});
    const b=r.createSpatialNodes('2',second.id,[{label:'b'}],{form:'flat'});
    assert.equal(a.ok,true);assert.equal(b.ok,true);assert.notEqual(a.value[0].id,b.value[0].id);
    const issued=a.value[0].id;r.deleteSpatialNode('1',issued);
    const next=r.createSpatialNodes('1',first.id,[{label:'next'}],{form:'flat'});
    assert.ok(next.value[0].id>Math.max(issued,b.value[0].id));
    assert.equal(r.getSpatialDescriptor('2').geoPose,undefined);
  });
  await check('graph-order-and-ancestors',()=>{
    const r=runtime('ancestors'),trace=[];
    r.subscribe(s=>trace.push(['state',s.debug.state_revision]));r.subscribeEvents(e=>trace.push(['event',e]));trace.length=0;
    const rootNode=r.getSpatialGraphRoot('1',{form:'flat'});
    const p=r.createSpatialNodes('1',rootNode.id,[{label:'parent'}],{form:'flat'}).value[0];
    const c=r.createSpatialNodes('1',p.id,[{label:'child'}],{form:'flat'}).value[0];
    assert.equal(trace[0][0],'state');assert.equal(trace[1][0],'event');
    const last=trace.at(-1)[1];assert.equal(last.type,'node_created');
    for(const id of [rootNode.id,p.id,c.id])assert.ok(last.urls.includes('wow/spatial/1/node/'+id));
    trace.length=0;r.updateSpatialNode('1',c.id,{localTransform:translationMatrix([2,0,0])},{form:'flat'});
    assert.equal(trace[0][0],'state');assert.equal(trace[1][1].type,'node_updated');
    trace.length=0;r.deleteSpatialNode('1',p.id);
    assert.equal(trace[0][0],'state');assert.deepEqual(trace.filter(x=>x[0]==='event').map(x=>x[1].nodeId).sort((a,b)=>a-b),[p.id,c.id].sort((a,b)=>a-b));
  });
  await check('graph-unchanged',()=>{
    const r=runtime('unchanged'),rootNode=r.getSpatialGraphRoot('1',{form:'flat'});
    const node=r.createSpatialNodes('1',rootNode.id,[{label:'stable'}],{form:'flat'}).value[0];
    const revision=r.currentRevision().revision,stateRevision=r.getState().debug.state_revision;
    const result=r.updateSpatialNode('1',node.id,{label:'stable'},{form:'flat'});
    assert.equal(result.unchanged,true);assert.equal(r.currentRevision().revision,revision);assert.equal(r.getState().debug.state_revision,stateRevision);
    assert.equal(r.createSpatialNodes('missing',1,[],{form:'flat'}).status,404);
    assert.equal(r.getSpatialNode('missing',1),null);
  });
  await check('presence-invalid-and-saturated',()=>{
    const r=runtime('capacity');
    const sweepersBefore=[...intervals.values()].filter(t=>t.ms===1000).length;
    for(const method of ['registerPresence','heartbeatPresence','departPresence'])assert.throws(()=>r[method]({}),/player_id required/);
    for(let i=0;i<64;i++)r.registerPresence({player_id:'p'+i,requested_ttl_ms:60000});
    assert.equal(r.getState().session.connected_clients.length,64);
    assert.throws(()=>r.registerPresence({player_id:'overflow'}),/registry full/);
    assert.equal(r.registerPresence({player_id:'p0'}).registered,true);
    assert.equal([...intervals.values()].filter(t=>t.ms===1000).length,sweepersBefore+1,'one sweeper for every register and re-register in this runtime');
  });
  await check('presence-tombstone',()=>{
    const r=runtime('tombstone'),events=[];r.subscribeEvents(e=>events.push(e));
    r.registerPresence({player_id:'p'});const id=r.getWowEventsHello().users[0].id;
    assert.equal(r.departPresence({player_id:'p'}).departed,true);
    assert.equal(r.departPresence({player_id:'p'}).departed,false);
    assert.equal(events.filter(e=>e.type==='user_left').length,1);
    assert.equal(r.heartbeatPresence({player_id:'p'}).departed,true);
    assert.equal(r.getState().session.connected_clients.length,0);
    r.registerPresence({player_id:'p'});assert.equal(r.getState().session.connected_clients.length,1);
    assert.ok(r.getWowEventsHello().users[0].id>id,'explicit fresh register keeps current monotonic ID semantics');
    assert.equal(r.getFabricPresence().departure_enforcement.active_tombstones,0);
  });
  await check('presence-read-and-reset',()=>{
    const r=runtime('read-reset'),events=[];r.subscribeEvents(e=>events.push(e));
    r.registerPresence({player_id:'expired',requested_ttl_ms:1000});
    const stateRevision=r.getState().debug.state_revision,rev=r.currentRevision().revision;
    clock+=1001;assert.equal(r.getState().session.connected_clients.length,0);assert.equal(r.getWowEventsHello().users.length,0);
    assert.equal(r.getState().debug.state_revision,stateRevision);assert.equal(r.currentRevision().revision,rev);
    r.reset();assert.equal(events.filter(e=>e.type==='user_left').length,1);
    assert.equal(r.getFabricPresence().departure_enforcement.resurrections_blocked,0);
    const before=events.length;r.reset();assert.equal(events.slice(before).some(e=>e.type==='user_left'),false);
  });
} finally {
  for(const r of runtimes)stop(r);
  fs.rmSync(fixtureRoot,{recursive:true,force:true});
  assert.equal(intervals.size,0,'all owned timers released');
  globalThis.setInterval=original.setInterval;globalThis.clearInterval=original.clearInterval;Date.now=original.now;console.log=original.log;console.error=original.error;
}
console.log(JSON.stringify({checks,passed:checks.length,failed,ownedTimers:intervals.size}));
process.exitCode=failed?1:0;
