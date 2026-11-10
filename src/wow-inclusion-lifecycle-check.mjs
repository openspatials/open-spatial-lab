import assert from "node:assert/strict";
import {mountLiveInclusions} from "../web/wow-inclusion-mount.mjs";
import {openWorldStream} from "../web/wow-observe.mjs";
import {THREE} from "../tools/behavior/controller-harness.mjs";
import {nodeChecks} from "../tools/behavior/node-checks.mjs";
const {check,finish}=nodeChecks("wow-inclusion-lifecycle");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function socketFixture(){
  const sockets=[];
  class Socket {
    constructor(url){this.url=url;this.closed=false;sockets.push(this);}
    close(){this.closed=true;this.onclose?.();}
    send(){}
  }
  return {Socket,sockets};
}
async function inclusionFixture(){
  const host="https://host.invalid/wow/spatial/1",root=host+"/node/1",child="https://child.invalid/wow/spatial/2";
  const gate=deferred(),entered=deferred(),updates=[],{Socket,sockets}=socketFixture();let refreshing=false;
  const response=body=>({ok:true,status:200,headers:{get:name=>name==="content-type"?"application/wow+json":null},json:async()=>body});
  const fetch=async url=>{
    if(url===host)return response({rootNodeID:1});
    if(url===root){if(refreshing){entered.resolve();await gate.promise;}return response({id:1,children:[],...(refreshing?{spatialAssetURI:child}:{})});}
    if(url===child)return response({rootNodeID:2});
    if(url===child+"/node/2")return response({id:2,children:[]});
    if(url.endsWith("/wow/world"))return response({services:{events:"wow/events"}});
    throw new Error("unexpected fixture request "+url);
  };
  const group=new THREE.Group();
  const mounted=await mountLiveInclusions({hostUrl:host,built:{asset_nodes:[{id:1,group}]},THREE,document:null,fetch,WebSocket:Socket,
    buildWowScene:()=>({root:new THREE.Group(),asset_nodes:[]}),onUpdate:summary=>updates.push(summary)});
  await tick();assert.equal(sockets.length,1,"initial stream discovery connects");
  return {mounted,group,updates,sockets,gate,async refresh(){refreshing=true;sockets[0].onmessage({data:JSON.stringify({type:"change",revision:1,urls:[root]})});await entered.promise;},
    close(){mounted.live.close();mounted.current().undo();},dispose(){mounted.live.close();mounted.current().undo();for(const socket of sockets)socket.close();}};
}
await check("inclusion-recomposition","Active deferred recomposition still mounts the child and discovers its stream",async()=>{
  const fixture=await inclusionFixture();try{
    await fixture.refresh();fixture.gate.resolve();await fixture.mounted.live.idle();await tick();
    assert.equal(fixture.updates.length,1);assert.equal(fixture.group.children.length,1);assert.equal(fixture.sockets.filter(s=>!s.closed).length,2);
  }finally{fixture.dispose();}
});
await check("inclusion-disposal","Closing during recomposition prevents retired scene mount, state adoption and child streams",async()=>{
  const fixture=await inclusionFixture(),composition=fixture.mounted.live.composition;
  try{
    await fixture.refresh();fixture.close();fixture.gate.resolve();await fixture.mounted.live.idle();await tick();
    assert.equal(fixture.updates.length,0,"retired inclusion cannot publish");assert.equal(fixture.group.children.length,0,"retired scene stays empty");
    assert.equal(fixture.mounted.live.composition,composition,"closed composition keeps its last committed value");
    assert.equal(fixture.sockets.length,1,"no late child discovery");assert(fixture.sockets.every(s=>s.closed));
  }finally{fixture.dispose();}
});
await check("stream-discovery","Closing at either discovery await prevents connection while the active control connects",async()=>{
  for(const phase of ["fetch","json"])for(const closed of [false,true]){
    const gate=deferred(),{Socket,sockets}=socketFixture(),statuses=[];
    const world={services:{events:"wow/events"}},response={ok:true,json:()=>phase==="json"?gate.promise:Promise.resolve(world)};
    const stream=openWorldStream("https://host.invalid/",{WebSocket:Socket,reconnect:false,onStatus:s=>statuses.push(s.status),fetch:()=>phase==="fetch"?gate.promise:Promise.resolve(response)});
    await tick();if(closed)stream.close();gate.resolve(phase==="fetch"?response:world);await tick();
    try{assert.equal(sockets.length,closed?0:1,"closed discovery cannot create a socket");if(closed)assert.equal(stream.state.status,"closed");assert.deepEqual(statuses,[]);}
    finally{stream.close();for(const socket of sockets)socket.close();}
  }
});
await check("stream-discovery-rejection","Discovery rejection after close cannot overwrite closed status or notify",async()=>{
  const gate=deferred(),{Socket,sockets}=socketFixture(),statuses=[];
  const stream=openWorldStream("https://host.invalid/",{WebSocket:Socket,reconnect:false,onStatus:s=>statuses.push(s.status),fetch:()=>gate.promise});
  stream.close();gate.reject(new Error("discovery unavailable"));await tick();
  assert.equal(stream.state.status,"closed","closed discovery retains closed status");assert.deepEqual(statuses,[]);assert.equal(sockets.length,0);
});
await finish({checkFile:"src/wow-inclusion-lifecycle-check.mjs",faults:[
  {statement:"inclusion-disposal",name:"closed recomposition adopted",expect:/retired inclusion cannot publish/,edits:[{file:"web/wow-inclusion.mjs",find:"      if (closed) return;\n      composition = next;",replace:"      composition = next;"}]},
  {statement:"stream-discovery",name:"closed discovery connects",expect:/closed discovery cannot create a socket/,edits:[{file:"web/wow-observe.mjs",find:"    if (state.closed) return;\n    if (state.revision",replace:"    if (state.revision"}]},
  {statement:"stream-discovery-rejection",name:"closed discovery reports failure",expect:/closed discovery retains closed status/,edits:[{file:"web/wow-observe.mjs",find:'      if (state.closed) return;\n      state.status = "unreachable";',replace:'      state.status = "unreachable";'}]},
]});
