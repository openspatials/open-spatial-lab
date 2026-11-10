import assert from "node:assert/strict";
import {createPeerAvatarPresentation,playerViewSeparatedPeerAvatar} from "../web/peer-avatar-presentation.mjs";
import {createPeerPresenceReducer} from "../web/live-adapter-peer-presence-reducer.mjs";
import {nodeChecks} from "../tools/behavior/node-checks.mjs";
const {check,finish}=nodeChecks("peer-avatar-presentation");
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const peer=(changes={})=>({client_id:"peer",player_id:"person",co_present:true,location_id:"a",position:[0,0,0],rotation_y:0,avatar_variant:"chosen",...changes});
function fixture() {
  const layers=[],logs=[];
  const owner=createPeerAvatarPresentation({isPlayer:true,getLocalAvatar:()=>({position:[0,0,0],rotation_y:0}),variants:{chosen:{},other:{}},logLine:value=>logs.push(value),createLayer:()=>{
    const load=deferred(),variant=deferred();
    const layer={load,variant,ready:load.promise,status:{avatar_variant:"default"},shown:[],switches:[],disposed:0,isSettled:()=>true,
      setAvatar(pose){this.shown.push(pose);},async switchAvatarVariant(value){this.switches.push(value);await variant.promise;this.status.avatar_variant=value;},dispose(){this.disposed++;}};
    layers.push(layer);return layer;
  }});
  return {owner,layers,logs};
}
await check("prime-before-reveal","Latest keyed pose appears only after its own model is active",async()=>{
  const {owner,layers}=fixture();owner.sync({peer_players:[peer()]});const first=layers[0];assert.equal(first.shown.length,0);
  first.load.resolve();await tick();assert.deepEqual(first.switches,["chosen"]);assert.equal(first.shown.length,0,"default model never revealed");
  owner.sync({peer_players:[peer({position:[3,0,4]})]});assert.equal(layers.length,1);
  first.variant.resolve();await tick();assert.deepEqual(first.shown.at(-1).position,[3,0,4]);assert.equal(first.__peerPlayerId,"person");
  owner.sync({peer_players:[]});assert.equal(first.disposed,1);assert.equal(owner.layers.size,0);owner.dispose();assert.equal(first.disposed,1);
});
await check("retired-loads","Removal, replacement and disposal fence delayed ready and variant work",async()=>{
  for(const phase of ["ready","variant"]) {
    const {owner,layers}=fixture();owner.sync({peer_players:[peer()]});const first=layers[0];
    if(phase==="variant"){first.load.resolve();await tick();}
    owner.sync({peer_players:[]});owner.sync({peer_players:[peer()]});const second=layers[1];
    first.load.resolve();first.variant.resolve();await tick();assert.equal(first.shown.length,0,"retired peer never reveals");assert.equal(first.disposed,1);
    owner.dispose();second.load.resolve();second.variant.resolve();await tick();assert.equal(second.shown.length,0);assert.equal(second.disposed,1);assert.equal(owner.layers.size,0);
    owner.sync({peer_players:[peer()]});assert.equal(layers.length,2);
  }
});
await check("rejected-load","Rejected initial load stays hidden without an unhandled rejection",async()=>{
  const {owner,layers,logs}=fixture();owner.sync({peer_players:[peer()]});layers[0].load.reject(new Error("missing model"));await tick();
  assert.equal(layers[0].shown.length,0);assert(logs.some(value=>value.includes("missing model")));owner.dispose();
});
await check("failed-variant","Resolved, rejected and unconfirmed variant loads never reveal the default identity",async()=>{
  for(const mode of ["resolved","rejected","unconfirmed"]){
    const {owner,layers,logs}=fixture();owner.sync({peer_players:[peer()]});const layer=layers[0];
    layer.switchAvatarVariant=async()=>{if(mode==="rejected")throw new Error("named peer rejection");return mode==="resolved"?{ok:false,error:"named peer failure"}:{ok:true};};
    layer.load.resolve();await tick();owner.sync({peer_players:[peer({position:[2,0,3]})]});
    assert.equal(layer.shown.length,0,"failed variant remains hidden");assert.equal(layer.__variantPrimed,false);
    assert(logs.some(line=>line.includes(mode==="rejected"?"named peer rejection":mode==="resolved"?"named peer failure":"is not active")),"variant failure reported");owner.dispose();
  }
});
await check("changed-variant","A request changed during priming waits for the latest identity before first reveal",async()=>{
  const {owner,layers}=fixture();owner.sync({peer_players:[peer()]});const layer=layers[0],gates=[];
  layer.switchAvatarVariant=async value=>{const gate=deferred();gates.push({value,...gate});await gate.promise;layer.status.avatar_variant=value;return {ok:true};};
  layer.load.resolve();await tick();assert.equal(gates[0].value,"chosen");
  owner.sync({peer_players:[peer({avatar_variant:"other",position:[4,0,5]})]});gates[0].resolve();await tick();
  assert.equal(layer.shown.length,0,"superseded variant never revealed");assert.equal(gates[1].value,"other");
  owner.sync({peer_players:[peer({avatar_variant:"other",position:[7,0,8]})]});gates[1].resolve();await tick();
  assert.equal(layer.shown.length,1);assert.equal(layer.shown[0].avatar_variant,layer.status.avatar_variant);assert.deepEqual(layer.shown[0].position,[7,0,8]);owner.dispose();
});
await check("identity-reducer","Existing membership authority excludes self and removes departed peers",async()=>{
  const reducer=createPeerPresenceReducer({clientMode:"player",clientId:"own-tab",controlledIdentity:()=>({player_id:"self"}),getContext:()=>({world:{location_id:"a"}}),defaultAvatarVariant:"chosen",createBroadcastChannel:null,nowMs:()=>1000});
  const {owner,layers}=fixture();reducer.recordPeerPlayerPose(peer({client_id:"another-tab",player_id:"self"}));reducer.recordPeerPlayerPose(peer());
  owner.sync({peer_players:reducer.peerPlayersDebug()});assert.equal(layers.length,1);assert(owner.layers.has("peer"));
  reducer.clear();owner.sync({peer_players:reducer.peerPlayersDebug()});assert.equal(owner.layers.size,0);assert.equal(layers[0].disposed,1);owner.dispose();reducer.dispose();
});
await check("overlap","Visual overlap correction preserves source pose and observer coordinates",()=>{
  const pose=peer(),local={position:[0,0,0],rotation_y:0};const separated=playerViewSeparatedPeerAvatar(pose,0,true,local);
  assert.deepEqual(pose.position,[0,0,0]);assert.deepEqual(separated.position,[0.72,0,0]);assert.equal(separated.visual_separation.reason,"same_spawn_player_view_overlap");
  assert.equal(playerViewSeparatedPeerAvatar(pose,0,false,local),pose);assert.equal(playerViewSeparatedPeerAvatar({...pose,position:[2,0,0]},1,true,local).visual_separation,undefined);
});
await finish({checkFile:"src/peer-avatar-presentation-check.mjs",faults:[
  {statement:"prime-before-reveal",name:"reveal before variant",expect:/default model never revealed/,edits:[{file:"web/peer-avatar-presentation.mjs",find:"await layer.ready;",replace:"await layer.ready; layer.setAvatar(pose);"}]},
  {statement:"retired-loads",name:"retired peer revives",expect:/retired peer never reveals/,edits:[{file:"web/peer-avatar-presentation.mjs",find:"if (disposed || layers.get(clientId) !== layer) return;",replace:"/* stale generation guard removed */"},{file:"web/peer-avatar-presentation.mjs",find:"if (disposed || layers.get(clientId) !== layer) return;",replace:"/* stale generation guard removed */"}]},
  {statement:"identity-reducer",name:"removed peer not disposed",expect:/Expected values/,edits:[{file:"web/peer-avatar-presentation.mjs",find:"layer.dispose();",replace:"/* disposal omitted */"}]},
  {statement:"failed-variant",name:"failed load exposes default",expect:/failed variant remains hidden/,edits:[{file:"web/peer-avatar-presentation.mjs",find:"const result = await layer.switchAvatarVariant(wanted);",replace:"const result = await layer.switchAvatarVariant(wanted); if(result?.ok === false){layer.__variantPrimed=true;layer.setAvatar(pose);return;}"}]},
  {statement:"changed-variant",name:"superseded variant exposed",expect:/superseded variant never revealed/,edits:[{file:"web/peer-avatar-presentation.mjs",find:"if ((layer.__latestPeerAvatar || pose)?.avatar_variant !== wanted) continue;",replace:"/* latest requested identity ignored */"}]},
]});
