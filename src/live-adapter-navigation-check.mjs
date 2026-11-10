import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
const root=resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fileURLToPath(new URL('..',import.meta.url)));
const baseline=process.argv.includes('--baseline');
const context=createContext({ console,EventTarget,Event,CustomEvent,crypto:globalThis.crypto,TextEncoder,TextDecoder,URL,Date,Uint8Array,ArrayBuffer,Buffer,atob,btoa,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval });
const modules=new Map();
const pendingModules = new Map();
function load(path) {
  if (!pendingModules.has(path)) pendingModules.set(path, loadModule(path));
  return pendingModules.get(path);
}
async function loadModule(path) {
 if(path.endsWith('/web/vendor/scene-core/frontend-contract.js'))path=resolve(root,'runtime/scene-core/public/frontend-contract.js');
 if(modules.has(path))return modules.get(path);
 let fake=null;
 if(path.endsWith('/locomotion.mjs'))fake={Locomotion:class{constructor(){throw new Error('motion outside source fixture');}}};
 if(path.endsWith('/avatar/actionforge-avatar.mjs'))fake={motionRecord(){throw new Error('motion outside source fixture');}};
 if(path.endsWith('/avatar-equipment-layer.js'))fake={DEFAULT_AVATAR_VARIANT:'collection-adam',AVATAR_VARIANTS:{}};
 if(fake || (path.endsWith('.mjs') && !path.endsWith('-binding.mjs') && !path.includes('/live-adapter-movement'))){
  const native=fake||await import(pathToFileURL(path));
  const mod=new SyntheticModule(Object.keys(native),function(){for(const key of Object.keys(native))this.setExport(key,native[key]);},{context,identifier:path});modules.set(path,mod);return mod;
 }
 let source=readFileSync(path,'utf8');
 if(path.endsWith('/live-adapter.js') && process.argv.includes('--partial-commit-control'))source=source.replace('    const navigationCurrent = this._beginWorldNavigation(isCurrent);','    this.base = ENDPOINTS[targetKey].proxy_base;\n    const navigationCurrent = this._beginWorldNavigation(isCurrent);');
 if(path.endsWith('/live-adapter.js') && process.argv.includes('--stale-caller-control'))source=source.replace('return () => !this._disposed && this._worldNavigationOperation === operation && isCurrent();','return () => true;');
 const mod=new SourceTextModule(source,{context,identifier:path});modules.set(path,mod);
 await mod.link(ref=>load(resolve(dirname(path),ref)));return mod;
}
const mod=await load(resolve(root,'web/live-adapter.js'));await mod.evaluate();const {LiveAdapter}=mod.namespace;
const clean=value=>JSON.parse(JSON.stringify(value,(key,value)=>['loaded_at','promoted_at','upgraded_at','resolved_at','pose_adopted_at'].includes(key)?'<timestamp>':value));
const deferred=()=>{let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};};
const fabric={container:'fabric-b',data:{Children:[{Head:{Self:10},Name:'Portal',Type:{bSubtype:255},Transform:{Position:[3,0,4]},Resource:{sReference:'/api/a/fabric.json'}},{Head:{Self:11},Name:'Avatar Spawn',Transform:{Position:[0,0,0]}}]},primary:{camera:{position:[0,1.7,8],rotation:[0,0,0,1]}}};
const liveWorld={id:'world-b',location:{id:'location-b',title:'B',port:18152},presence:{avatars:[{avatar_id:'a',continuity_id:'person'}]},session:{id:'session-b',arrival_count:0},portals:{portal_count:0},proof_boundary:{},webofworlds_extension:{spatialID:'2'}};
function host(getJson=async url=>url.endsWith('/fabric.json')?structuredClone(fabric):url.endsWith('/wow/world')?structuredClone(liveWorld):url.endsWith('/wow/spatial/2')?{spatialID:'2',root:1,nodes:{1:{id:1,children:[]}}}:null){
 const h=new EventTarget(),trace=[];Object.setPrototypeOf(h,LiveAdapter.prototype);
 Object.assign(h,{role:'player',clientMode:'player',base:'/api/a',activeEndpointKey:'a',endpoint:{portal_id:'a-portal',proxy_base:'/api/a'},world:{location_id:'location-a',avatar:{spawn_position:[0,0,0]},arrival:{position:[0,0,3.6],rotation_y:0},portals:[]},wowRef:null,
 _rootFabricManifest:structuredClone(fabric),_rootFabricManifestUrl:'/api/a/fabric.json',_navigatorPromotions:[],_startsEmbodied:true,_playerContextMarker:{context_id:'ctx',marker_id:'marker'},
 _transport:{getJson,postJson:async()=>({})},state:{phase:'idle',avatar:{position:[0,0,0]},controls:{}},_log:m=>trace.push(['log',m]),_emit:()=>trace.push(['emit']),_updatePortalStatus:()=>trace.push(['status']),
 _fabricPrefetchController:{capturePromotionInput:()=>({}),recordPromotion:r=>trace.push(['promotion',r.handoff_id]),cancelCompletion(){},dispose(){}},_fabricPrefetchProofBlock:()=>null,
 _resetFabricPrefetch:()=>trace.push(['prefetch']),_startFabricCompletion:()=>trace.push(['completion']),_closeRuntimeStream:()=>trace.push(['close']),_connectRuntimeStream:()=>trace.push(['connect']),_adoptLiveAirportScenePhysics:()=>trace.push(['physics']),
 _resolveAvatarGround:()=>({ok:true,surface_y_m:2}),_portalTraversalController:{forgetPortalSides(){},cancel(){trace.push(['cancel']);},reset(){}},_runtimeStreams:{dispose(){}},_presenceController:{dispose(){}},_peers:{dispose(){},resetBroadcastState(){}},
 _clientSceneController:{active:()=>false},_departPresence:async()=>null,_registerPresence:async()=>null,_syncPresenceEventStreams(){},_maybeBroadcastPlayerPose(){},_broadcast(){},_bootEndpointKey:'a',baseA:'/api/a',baseB:'/api/b'});
 return {h,trace};
}
const {h,trace}=host();await h._initWorldNavigator();
assert.equal(h._navigator.status,'root_fabric_loaded_destinations_previewed_by_their_own_data');assert.equal(h._navigator.portal_attachment.node_id,'10');assert.equal(h._navigator.child_fabric,null);assert.equal(h._childFabricManifest,null);
assert.deepEqual(clean(h.world.avatar.spawn_position),[0,0,8]);assert.equal(h._playerContextMarker.context_id,'ctx');assert.equal(h._playerContextMarker.fabrics_loaded_count,1);
const mapping={mapped_exit_transform:{position:[3,0,5],rotation_y:1.2},target_portal_frame:{ground_center:[3,0,4],portal_id:'target',location_id:'location-b'},exit_offset_m:1};
const pose=h._fabricDerivedExitPose(mapping);assert.deepEqual(clean(pose.position),[3,2,5]);assert.equal(pose.rotation_y,1.2);assert.equal(pose.hosting_fabric_node.node_id,'10');
const fallback=h._fabricDerivedExitPose(null);assert.equal(fallback.source,'promoted_fabric_portal_back_node+primary_camera');assert.equal(fallback.position[1],2);
h.world.portal={portal_id:'p',trigger:{position:[1,0,1],radius_m:1},frame:{forward:[0,0,1]},target_location_id:'location-b',target_frame:{portal_id:'back',ground_center:[1,0,1],forward:[0,0,1]}};h.world.portals=[h.world.portal];
assert.equal(h.applyHostedPortalPose([2,9,3]).changed,true);assert.equal(h.applyHostedTargetPortalPose([4,9,5]).changed,true);assert.equal(h.world.portal.target_frame.pose_source,'hosted_point_reload');
const happy={navigator:clean(h._navigator),pose:clean(pose),fallback:clean(fallback),portal:clean(h.world.portal),marker:clean(h._playerContextMarker)};
const {h:promoted}=host();const record=await promoted._promoteActiveEndpoint('b',{handoff_id:'h'});assert.equal(promoted.base,'/api/b');assert.equal(promoted.world.location_id,'location-b');assert.equal(record.handoff_id,'h');assert.equal(promoted._navigatorPromotions.length,1);
const gate=deferred(), pending=host(async url=>url.endsWith('/fabric.json')?gate.promise:structuredClone(liveWorld));
const initial=pending.h.world;const work=pending.h._promoteActiveEndpoint('b',{handoff_id:'late'});await Promise.resolve();
assert.equal(pending.h.base,baseline?'/api/b':'/api/a','no partial destination commit');
pending.h.dispose();gate.resolve(fabric);await work;
assert.equal(pending.h.world===initial,!baseline,'disposed caller cannot later replace host');
if(!baseline){
 assert.equal(pending.trace.some(event=>event[0]==='cancel'),true,'facade disposal cancels traversal diagnostics');
 for(const method of ['enterClientSceneLoad','returnFromClientSceneLoad']){
  const x=host();let current=true;
  x.h._portalTraversalController.cancel=()=>{current=false;};
  x.h._clientSceneController.enter=async options=>options.isCurrent&&assert.equal(options.isCurrent(),true,'client scene must retain traversal owner');
  x.h._clientSceneController.returnToLobby=async options=>options&&assert.equal(options.isCurrent(),true,'client return must retain traversal owner');
  await x.h[method]({isCurrent:()=>current});assert.equal(current,true);
  await x.h[method]();assert.equal(current,false,'manual navigation retires traversal');
  let validity;x.h._clientSceneController.enter=x.h._clientSceneController.returnToLobby=async options=>{validity=options.isCurrent;};
  await x.h[method]();assert.equal(validity(),true);x.h._beginWorldNavigation();assert.equal(validity(),false,'later navigation retires client-scene adoption');
 }
 const unavailable=host(async()=>null);unavailable.h._rootFabricManifest=null;
 const markerBefore=JSON.stringify(unavailable.h._playerContextMarker);await unavailable.h._initWorldNavigator();
 assert.equal(JSON.stringify(unavailable.h._playerContextMarker),markerBefore,'failed root keeps existing marker identity and claims');
 const fractional=host();fractional.h._rootFabricManifest.primary.camera.position=[0.123456,1,8.654321];await fractional.h._initWorldNavigator();assert.deepEqual(clean(fractional.h.world.avatar.spawn_position),[0.123456,0,8.654321]);
 for(const name of ['init','_initWorldNavigator','refreshWorldPortals','reset','returnToLobby']){
  const gate=deferred(), x=host(async()=>gate.promise);x.h._rootFabricManifest=null;x.h._transport.postJson=()=>gate.promise;x.h._departPresence=()=>gate.promise;
  const work=x.h[name]();await Promise.resolve();
  x.h._beginWorldNavigation();assert.equal(x.h._nonPortalHandoffInFlight,false,'replacement retires old nonportal busy state');x.h._nonPortalHandoffInFlight=true;
  const replacement=x.h.world={location_id:'replacement',portals:['current']};const snapshot=JSON.stringify(replacement),events=x.trace.length;
  gate.resolve(fabric);await work;
  assert.equal(x.h.world,replacement,name+' stale outer caller changed world');assert.equal(JSON.stringify(x.h.world),snapshot,name+' stale outer caller mutated world');assert.equal(x.trace.length,events,name+' stale outer caller published effects');
  assert.equal(x.h._nonPortalHandoffInFlight,true,'retired caller must not clear newer busy state');
 }
 for(const path of ['/wow/world','/wow/spatial/2']){
  const gate=deferred();let reached;const waiting=new Promise(r=>reached=r);
  const x=host(async url=>{if(url.endsWith(path)){reached();return gate.promise;}return url.endsWith('/fabric.json')?fabric:url.endsWith('/wow/world')?liveWorld:null;});
  const work=x.h._promoteActiveEndpoint('b',{handoff_id:'stale-stage'});await waiting;
  assert.equal(x.h.base,'/api/a','destination must remain uncommitted throughout reads');
  const replacement=x.h.world={location_id:'replacement'};x.h._beginWorldNavigation();const events=x.trace.length;
  gate.resolve(path==='/wow/world'?liveWorld:{spatialID:'2',root:1,nodes:{1:{id:1}}});await work;
  assert.equal(x.h.world,replacement);assert.equal(x.trace.length,events,'retired staged reader publishes nothing');
 }
 const failure=host(async url=>{if(url.endsWith('/fabric.json'))return fabric;throw new Error('destination offline');});const oldWorld=failure.h.world;
 await assert.rejects(failure.h._promoteActiveEndpoint('b',{}),/destination offline/);assert.equal(failure.h.world,oldWorld);assert.equal(failure.h.base,'/api/a');
 const gate2=deferred(),preview=host(()=>gate2.promise);preview.h.previewEndpoint={proxy_base:'/api/b'};preview.h.state.preview={state:'ready'};
 const work=preview.h.refreshPreviewReadOnlyState();preview.h._beginWorldNavigation();const now=preview.h.state.preview={state:'newer'};gate2.reject(new Error('late preview failure'));await work;assert.equal(preview.h.state.preview,now);assert.equal(now.state,'newer');
}
console.log(JSON.stringify({passed:true,baseline,happy,partialCommitObserved:baseline,staleDisposedCommitObserved:baseline},null,2));
