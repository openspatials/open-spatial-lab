import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as Engine from "three";
import * as boundary from "../runtime/scene-core/public/render-adapter/render-adapter.mjs";
import { chooseRenderAdapter } from "../runtime/scene-core/public/render-adapter/registry.mjs";
import { OwnX3dRenderAdapter } from "../runtime/scene-core/public/x3d/own-x3d-render-adapter.mjs";
import { createSoftBodyWorld } from "../runtime/scene-core/public/x3d/soft-body.mjs";
import { prepareWorld } from "../web/soft-body-world.mjs";
import { createApplicationState } from "../web/application-state.mjs";
import { createMovementCameraController } from "../web/movement-camera-controller.mjs";
import { createThreeCameraBridge } from "../web/three-camera-bridge.mjs";
import { ownX3dDocumentSelection, ownX3dShellUrl, x3dDestinationUrl, prepareOwnX3dScene } from "../web/own-x3d-document.mjs";
import { loadOwnX3dAmmo } from "../web/own-x3d-ammo.mjs";
import { FakeTarget } from "../tools/behavior/controller-harness.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
const { check, finish } = nodeChecks("own-x3d-integration");
const root = new URL("../", import.meta.url), read = path => readFileSync(new URL(path, root), "utf8");
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for(let i=0;i<100&&!predicate();i++) await tick(); assert.ok(predicate(),"fixture phase reached"); };
const createCanvas = () => ({ width:0,height:0,getContext:()=>({measureText:s=>({width:s.length*32}),clearRect(){},fillText(){}}) });
const sourceURL = new URL("web/scene-runtime-controller.mjs", root);
const source = read("web/scene-runtime-controller.mjs")
  .replace(/import \{ SpatialPortalPreviewManager \} from .*?;/, "const SpatialPortalPreviewManager = class {};")
  .replace(/import \{ composeBoundedPreview \} from .*?;/, "const composeBoundedPreview = () => { throw Error('preview outside document check'); };")
  .replace(/from "(\.\/[^\"]+)"/g,(_,p)=>`from ${JSON.stringify(new URL(p,sourceURL).href)}`);
const { createSceneRuntimeController } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const anchor = ownX3dDocumentSelection({explicitRoute:true}), soft = ownX3dDocumentSelection({explicitRoute:true,world:"soft-body.x3d.json"});
const texts = Object.fromEntries([anchor,soft].map(s=>[s.assetPath,read(`web${s.assetPath}`)]));
const physicsFixture = read("src/x3d-soft-body-check.mjs");
const fixtureStart = physicsFixture.indexOf("function recordingAmmo(");
const recordingAmmo = Function("assert", physicsFixture.slice(fixtureStart, physicsFixture.indexOf("\n}\n", fixtureStart) + 2) + ";return recordingAmmo;")(assert);
let foreignFrames=0;
globalThis.requestAnimationFrame=()=>{foreignFrames++;throw Error("second host clock");};

function fixture({gateAt=null,failAt=null,realPhysics=false,environment=null}={}) {
  const gate=deferred(),trace=[],adapters=[],physics=[],frames=new Map(),documentTarget=new FakeTarget(),windowTarget=new FakeTarget();let id=0,phase=null,permission=true,viewed=null;
  const host=Object.assign(new FakeTarget(),{clientWidth:800,clientHeight:600,getBoundingClientRect:()=>({left:0,top:0,width:800,height:600})});
  documentTarget.body=new FakeTarget();documentTarget.createElement=()=>new FakeTarget();documentTarget.getElementById=()=>null;
  windowTarget.location={href:"https://fixture.invalid/index.html?renderer=own-x3d",origin:"https://fixture.invalid"};
  class Renderer { constructor(){this.domElement=new FakeTarget();this.shadowMap={};this.draws=0;this.disposals=0;}getContext(){return {};}setPixelRatio(){}setSize(){}render(){this.draws++;trace.push("draw");}dispose(){this.disposals++;trace.push("renderer-dispose");}forceContextLoss(){trace.push("context-release");} }
  const THREE={...Engine,WebGLRenderer:Renderer};
  const applicationState=createApplicationState({getAdapter:()=>null});
  async function phaseWait(name){phase=name;trace.push(name);if(name===failAt)throw Error(`rejected ${name}`);if(name===gateAt)await gate.promise;}
  let movement;
  const controller=createSceneRuntimeController({THREE,applicationState,isPlayer:true,role:"player",sharedAvatarCompositing:true,
    documentTarget,windowTarget,locationHref:windowTarget.location.href,getMount:()=>host,getRuntime:()=>null,getAvatarLayers:()=>({peers:[]}),logLine(){},
    createRenderAdapter(){const a=chooseRenderAdapter(THREE,"?renderer=own-x3d",{ownX3d:{createCanvas,preparePhysics:prepareWorld}}).active.adapter;if(environment){assert.deepEqual(a.setEnvironmentResolver(environment.resolver),{supported:true,resolver:true});const setLighting=a.setLighting.bind(a);a.setLighting=description=>{trace.push("set-lighting");return setLighting(description);};}adapters.push(a);return a;},
    fetchX3dDocument:async path=>{await phaseWait("fetch");return {ok:true,text:async()=>{await phaseWait("document");return texts[path];}};},
    loadX3dAmmo:async()=>{await phaseWait("ammo");return realPhysics?recordingAmmo():{Ammo:{}};},
    createX3dPhysics:(_ammo,prepared,sink)=>{assert.equal(prepared.soft.length,2);const actual=realPhysics?createSoftBodyWorld(_ammo,prepared,sink):null;let disposed=false;const p={steps:[],step(dt,actions){assert.equal(disposed,false);actual?.step(dt,actions);this.steps.push([dt,actions]);trace.push("physics-step");},dispose(){assert.equal(disposed,false);disposed=true;actual?.dispose();if(realPhysics)_ammo.assertClean();try { sink.readPoints(prepared.soft[0].def); } catch { trace.push("sink-already-disposed"); } trace.push("physics-dispose");}};physics.push(p);return p;},
    readX3dViewer:state=>{viewed=state;return {position:state.camera.position.toArray(),orientation:state.runtime.viewpoints[0].orientation,...movement?.documentActions()};},
    readX3dPermission:()=>permission&&controller.scene()?.document?["DEF:PortalAnchor"]:[],onX3dIntent:intent=>trace.push(["intent",intent]),
    readX3dLighting:()=>environment?.lighting??null,
  });
  const bridge=createThreeCameraBridge({THREE,sceneRuntime:controller,getAvatarLayers:()=>({peers:[]}),getRuntime:()=>null});
  function start(selection){movement=createMovementCameraController({cameraBridge:bridge,documentViewer:{softBody:selection===soft,entry:()=>controller.scene()?.entry,activate:event=>controller.activateX3dDocumentAt(event)},isPlayer:true,role:"player",windowTarget,documentTarget,lookup:key=>key==="scene-mount"?host:null,
    requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:key=>frames.delete(key),now:()=>0,getRuntime:()=>null,sceneRuntime:controller,getAvatarLayers:()=>({peers:[]}),logLine(){},showToast(){},isTypingTarget:()=>false});movement.start();return movement;}
  function frame(time){assert.equal(frames.size,1,"one shared host frame");const [key,fn]=frames.entries().next().value;frames.delete(key);fn(time);}
  return {controller,applicationState,gate,phase:()=>phase,state:()=>viewed,trace,adapters,physics,frames,documentTarget,windowTarget,host,start,frame,permission:value=>{permission=value;},dispose(){movement?.dispose();controller.dispose();applicationState.dispose();}};
}

await check("selection", "Actual selected constructor and bootstrap use the own class without changing defaults or legacy dispatch",async()=>{
  const roleBody=read("web/app.js").split("const role =")[1].split("const isPlayer")[0];
  assert.equal(Function("documentViewerMode","roleParam","stageParam","isWowWorldUrl",`return (${roleBody.trim().replace(/;$/, "")});`)(true,"target",false,false),"player","document route always uses viewer camera policy");
  const factoryText=read("web/app.js").split("createRenderAdapter: () => ")[1].split(".active.adapter,")[0]+".active.adapter";
  const factory=Function("chooseRenderAdapter","THREE","location","document","prepareWorld",`return ()=>(${factoryText})`)(chooseRenderAdapter,Engine,{search:"?renderer=OWN-X3D"},{createElement:createCanvas},prepareWorld);
  const selected=factory();assert.ok(selected instanceof OwnX3dRenderAdapter,"actual app factory selects own class");selected.dispose();
  assert.equal(chooseRenderAdapter(Engine,"").active.kind,"three");assert.equal(chooseRenderAdapter(Engine,"?renderer=unknown").fallback,true);
  const boot=read("web/demo-shell-bootstrap.mjs");const body=boot.slice(boot.indexOf("async function startApp()"),boot.indexOf('\nviewsButton?.setAttribute')).replaceAll("import(","importModule(");
  for(const kind of ["three","own-x3d","x3dom","x_ite"]){const calls=[];const win={};const fn=Function("url","location","window","document","hideLauncher","importModule",`let appStarted=false;${body};return startApp;`)(new URL(`https://fixture/?renderer=${kind}`),{search:`?renderer=${kind}`},win,{},()=>{},async url=>{calls.push(url);return url.includes("render-adapter.mjs")?{...boundary,mountRenderAdapterNotice(){}}:{startLiveMode(){calls.push("legacy-start");}};});await fn();assert.equal(calls.includes("./app.js?v=1"),kind==="three"||kind==="own-x3d","actual boot path");}
});
await check("admission", "Only explicit exact documents and the configured portal selection are admitted",()=>{
  assert.equal(ownX3dDocumentSelection(),null);assert.throws(()=>ownX3dDocumentSelection({world:anchor.filename}),/explicit/);assert.throws(()=>ownX3dDocumentSelection({explicitRoute:true,world:"other.json"}),/Unknown/);
  assert.deepEqual(ownX3dDocumentSelection({portal:{portal_id:"lobby-portal-d",world:"lobby",x3d_world:soft.filename}}),soft);
  assert.throws(()=>ownX3dDocumentSelection({portal:{portal_id:"other",world:"lobby",x3d_world:soft.filename}}),/Unadmitted/);
  const url=ownX3dShellUrl("?renderer=own-x3d&active=b&world=soft-body.x3d.json",p=>"/lab"+p);assert.match(url,/^\/lab\/index.html\?/);assert.ok(!url.includes("active="));assert.ok(url.includes("x3dDocument=soft-body.x3d.json"));
  assert.equal(x3dDestinationUrl("/w/b/",{renderer:"own-x3d",serverOrigin:"https://server.invalid",withBase:p=>"/lab"+p,withServer:p=>"https://server.invalid"+p,locationHref:"https://front.invalid/lab/index.html"}),"/lab/?active=b&renderer=own-x3d&role=player&intro=bypass");
});
await check("app-entry", "The actual document boot bypasses server/LiveAdapter construction and only publishes after readiness",async()=>{
  const app=read("web/app.js"),start=app.indexOf("async function main()"),end=app.indexOf("\nfunction updateFabricPrefetchCard",start);
  const gates=deferred(),body=Object.assign(new FakeTarget(),{dataset:{}}),elements=new Map(),trace=[],view={};
  const scene={entry:{position:[0,1.6,6]},_impl:{camera:{position:{toArray:()=>[0,1.6,6]}}}};
  const values={documentViewerMode:true,params:new URLSearchParams("x3dDocument=anchor-portal-world.x3d.json"),chooseRendererAtBoot:boundary.chooseRendererAtBoot,location:{search:"?renderer=own-x3d"},ownX3dDocumentSelection,
    appEl:{},$:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},sceneRuntimeController:{mountX3dDocument:()=>{trace.push("prepare");return gates.promise;},activeAdapter:()=>null},requireActiveBoot:fn=>{if(fn())throw new DOMException("disposed","AbortError");},
    movementCameraController:{start:()=>trace.push("start-one-owner"),documentActions:()=>({}),debug:()=>({})},window:view,document:{body},disposeApplication:()=>{},liveViewport:{snapshot:()=>({}),resize:()=>trace.push("viewport")},rendererCapabilityPanel:null,setConnectionPresentation:()=>trace.push("ready"),
    LiveAdapter:class{constructor(){throw Error("document route started server adapter");}}};
  const factory=Function(...Object.keys(values),`let applicationDisposed=false;${app.slice(start,end)};return {main,dispose:()=>{applicationDisposed=true;}};`)(...Object.values(values));
  const boot=factory.main();await tick();assert.deepEqual(trace,["prepare"]);assert.equal(view.__assembly,undefined);gates.resolve(scene);await boot;assert.equal(view.__assembly.role,"document-viewer");assert.deepEqual(trace,["prepare","start-one-owner","viewport","ready"]);
  const retired=factory.main();factory.dispose();await assert.rejects(retired,{name:"AbortError"});assert.equal(trace.filter(value=>value==="start-one-owner").length,1,"disposed boot cannot start a second owner");
});
await check("content-and-intents", "Original digest and host intent checks reject changed text, stale generation, disallowed destination and permission",async()=>{
  let released=0;assert.throws(()=>prepareOwnX3dScene({rendererPreparation:{handle:{kind:"three"},dispose:()=>released++},selection:anchor}),/own-X3D adapter/);assert.equal(released,1,"invalid adapter preparation is released");
  let current=true,allowed=[],sent=0;const adapter=new OwnX3dRenderAdapter(Engine,{createCanvas,preparePhysics:prepareWorld});
  const preparation=prepareOwnX3dScene({rendererPreparation:{handle:adapter,ready:async()=>{},dispose:()=>adapter.dispose()},selection:anchor,
    fetchDocument:async()=>({ok:true,text:async()=>texts[anchor.assetPath]}),readViewer:()=>({position:[0,1.6,6]}),readPermission:()=>allowed,dispatchIntent:()=>sent++,isCurrent:()=>current});
  await preparation.ready();const intent=preparation.handle.state.runtime.activate("DEF:PortalAnchor",{time:0,allowedAnchors:["DEF:PortalAnchor"]});assert.equal(preparation.handle.dispatch(intent),false);allowed=["DEF:PortalAnchor"];
  assert.equal(preparation.handle.dispatch({...intent,urls:["/w/airport/"]}),false,"host denies unadmitted destination");assert.equal(preparation.handle.dispatch({...intent,generation:intent.generation+1}),false,"host denies stale runtime generation");
  current=false;assert.equal(preparation.handle.dispatch(intent),false,"host denies retired scene");current=true;assert.equal(preparation.handle.dispatch(intent),true);assert.equal(preparation.handle.dispatch(intent),false);assert.equal(sent,1);preparation.dispose();
  const changed=new OwnX3dRenderAdapter(Engine,{createCanvas,preparePhysics:prepareWorld});const bad=prepareOwnX3dScene({rendererPreparation:{handle:changed,ready:async()=>{},dispose:()=>changed.dispose()},selection:anchor,fetchDocument:async()=>({ok:true,text:async()=>texts[anchor.assetPath]+"\n"}),isCurrent:()=>true});await assert.rejects(bad.ready(),/digest does not match/);assert.equal(bad.handle.state,null);
});
await check("documents", "Both original texts reach actual own admission and preserve authored Entry and disposal order",async()=>{
  for(const selection of [anchor,soft]){const h=fixture();const scene=await h.controller.mountX3dDocument(selection);assert.ok(h.controller.activeAdapter() instanceof OwnX3dRenderAdapter);assert.equal(scene.document.schema,"x3d-subset/1");assert.deepEqual(scene._impl.camera.position.toArray(),selection===soft?[-10,1.6,10]:[0,1.6,6]);assert.equal(h.physics.length,selection===soft?1:0);assert.equal(h.adapters[0].renderer.draws,0,"no draw during unpublished preparation");const renderer=h.adapters[0].renderer;h.dispose();if(selection===soft)assert.ok(h.trace.indexOf("physics-dispose")<h.trace.indexOf("renderer-dispose"),"physics before renderer sink disposal");scene.renderFrame(5000);assert.equal(renderer.draws,0,"retired callback cannot draw");}
});
await check("cadence", "The existing movement owner advances one semantic/physics/render cadence at legacy viewer speed",async()=>{
  const h=fixture();const scene=await h.controller.mountX3dDocument(soft);const movement=h.start(soft);assert.equal(movement.start(),false);assert.equal(h.frames.size,1);const before=scene._impl.camera.position.toArray(),orientation=scene._impl.camera.quaternion.toArray();
  h.windowTarget.dispatch("keydown",{code:"KeyW"});h.frame(50);const after=scene._impl.camera.position.toArray();assert.ok(Math.abs(Math.hypot(after[0]-before[0],after[2]-before[2])-.12)<1e-10,"legacy 2.4 m/s viewer speed");assert.equal(after[1],1.6);assert.ok(after[0]<-5.4,"no invented Lobby bounds");assert.deepEqual(scene._impl.camera.quaternion.toArray(),orientation);assert.equal(h.physics[0].steps.length,1);assert.equal(h.adapters[0].renderer.draws,1);assert.equal(foreignFrames,0);
  h.windowTarget.dispatch("keydown",{code:"KeyA"});h.frame(100);assert.equal(h.physics[0].steps.at(-1)[1].armMovement,-1);h.windowTarget.dispatch("keydown",{code:"KeyQ"});assert.equal(movement.documentActions().armMovement,1);h.windowTarget.dispatch("keyup",{code:"KeyA"});assert.equal(movement.documentActions().armMovement,0);
  h.documentTarget.hidden=true;const paused=scene._impl.camera.position.toArray();h.frame(10000);assert.deepEqual(scene._impl.camera.position.toArray(),paused);assert.equal(h.physics[0].steps.at(-1)[1].paused,true);h.documentTarget.hidden=false;movement.stop();assert.equal(h.frames.size,0);h.dispose();assert.equal(h.windowTarget.listenerCount("keydown"),0);assert.equal(h.host.listenerCount("click"),0);
});
await check("physics-binding", "The actual accepted physics API binds admitted prepared topology to the real renderer sink",async()=>{
  const h=fixture({realPhysics:true});const scene=await h.controller.mountX3dDocument(soft);h.start(soft);h.frame(50);assert.equal(h.physics[0].steps.length,1);assert.equal(h.adapters[0].renderer.draws,1);h.dispose();assert.ok(h.trace.indexOf("physics-dispose")<h.trace.indexOf("renderer-dispose"));assert.equal(scene._impl.renderAdapter._disposed,true);
});
await check("async-retirement", "Fetch, document and Ammo continuations cannot publish or create physics after cancellation",async()=>{
  for(const stage of ["fetch","document","ammo"]){const h=fixture({gateAt:stage});const pending=h.controller.mountX3dDocument(soft);const rejected=assert.rejects(pending,{name:"AbortError"});await until(()=>h.phase()===stage);h.dispose();await rejected;h.gate.resolve();await tick();await tick();assert.equal(h.controller.scene(),null,"no late publication");assert.equal(h.physics.length,0,"no late physics construction");assert.equal(h.adapters[0]._disposed,true);}
  for(const stage of ["fetch","document","ammo"]){const h=fixture({failAt:stage});await assert.rejects(h.controller.mountX3dDocument(soft),new RegExp(`rejected ${stage}`));assert.equal(h.controller.scene(),null);assert.equal(h.adapters[0]._disposed,true);h.dispose();}
  const h=fixture({gateAt:"ammo"});const first=h.controller.mountX3dDocument(soft);const rejected=assert.rejects(first,{name:"AbortError"});await until(()=>h.phase()==="ammo");const replacement=await h.controller.mountX3dDocument(anchor);await rejected;h.gate.resolve();await tick();assert.equal(h.controller.scene(),replacement,"late readiness cannot replace current scene");assert.equal(h.physics.length,0);h.dispose();
});
await check("replacement-intents", "Ready replacement retires physics; host checks generation, permission, destination and deduplication",async()=>{
  const h=fixture();const old=await h.controller.mountX3dDocument(soft),oldAdapter=h.controller.activeAdapter();old.evaluateFrame(0);const state=h.state();const held=state.runtime.activate("DEF:PortalAnchor",{time:0,allowedAnchors:["DEF:PortalAnchor"]});
  const next=await h.controller.mountX3dDocument(anchor);assert.equal(oldAdapter._disposed,true);assert.equal(state.runtime.isCurrent(held.generation),false);const current=h.controller.activeAdapter();h.permission(false);assert.equal(next.activateAnchor({origin:[0,1.6,6],direction:[0,0,-1]}),false);h.permission(true);
  const camera=next._impl.camera;camera.position.set(0,1.6,6);next.evaluateFrame(.01);camera.position.set(0,1.6,-6);next.evaluateFrame(.01);const dispatched=h.trace.filter(v=>Array.isArray(v)&&v[0]==="intent");assert.equal(dispatched.length,1,"one current authorized intent");camera.position.set(0,1.6,6);next.evaluateFrame(.01);camera.position.set(0,1.6,-6);next.evaluateFrame(.01);assert.equal(h.trace.filter(v=>Array.isArray(v)&&v[0]==="intent").length,1,"host deduplicates destination intent");h.dispose();assert.equal(current._disposed,true);
});
await check("lighting", "A host environment is applied to each loaded document scene before publication, and only for a current preparation",async()=>{
  const map=()=>({kind:"equirect-linear-rgba",width:4,height:2,data:Float32Array.from({length:32},(_,i)=>i/32)});
  const lighting={environment:{asset:"env://fixture",intensity:1.5}};
  const h=fixture({environment:{resolver:async()=>map(),lighting}});
  const first=await h.controller.mountX3dDocument(soft),firstAdapter=h.controller.activeAdapter();
  assert.ok(firstAdapter instanceof OwnX3dRenderAdapter);assert.equal(first._impl.scene,firstAdapter.sceneRoot);
  assert.ok(first._impl.scene.environment instanceof Engine.DataTexture,"host environment on the loaded document scene");
  assert.equal(first.lighting?.environment?.status,"applied","lighting result reports applied");assert.equal(h.adapters[0].renderer.draws,0,"no draw before publication");
  const firstTexture=first._impl.scene.environment;
  const next=await h.controller.mountX3dDocument(anchor),nextAdapter=h.controller.activeAdapter();
  assert.notEqual(nextAdapter,firstAdapter);assert.equal(next._impl.scene,nextAdapter.sceneRoot);assert.notEqual(next._impl.scene,first._impl.scene);
  assert.ok(next._impl.scene.environment instanceof Engine.DataTexture,"host environment re-applied to the replacement document scene");
  assert.notEqual(next._impl.scene.environment,firstTexture);assert.equal(next.lighting?.environment?.status,"applied");
  assert.equal(h.trace.filter(v=>v==="set-lighting").length,2,"one lighting call per document load");h.dispose();
  const plain=fixture({environment:{resolver:async()=>map(),lighting:null}});const unlit=await plain.controller.mountX3dDocument(anchor);
  assert.equal(plain.trace.includes("set-lighting"),false,"no lighting call without a host description");assert.equal(unlit.lighting,null);plain.dispose();
  const gate=deferred();let asked=false;
  const stale=fixture({environment:{resolver:()=>{asked=true;return gate.promise;},lighting}});const pending=stale.controller.mountX3dDocument(anchor);const rejected=assert.rejects(pending,{name:"AbortError"});
  await until(()=>asked);const scene=stale.adapters[0].sceneRoot;stale.dispose();await rejected;gate.resolve(map());await tick();await tick();
  assert.equal(stale.controller.scene(),null,"no late publication");assert.equal(scene.environment??null,null,"cancelled preparation installs no environment");
});
await check("ammo-loader", "Host base URLs, rejection and cancellation do not resolve a retired Ammo preparation",async()=>{
  const paths=[],gate=deferred(),signal=new AbortController();const pending=loadOwnX3dAmmo({signal:signal.signal,assetUrl:p=>"/base"+p,documentTarget:{},importModule:url=>{paths.push(url);return gate.promise;}});signal.abort();gate.resolve({default:{Namespace:{AmmoClass:{btSoftRigidDynamicsWorld(){}}}}});await assert.rejects(pending,{name:"AbortError"});assert.equal(paths[0],"/base/vendor/scene-core/vendor/x_ite/x_ite.min.mjs");
  let script;const backend={Namespace:{}};const controller=new AbortController();const loading=loadOwnX3dAmmo({signal:controller.signal,assetUrl:p=>"/base"+p,documentTarget:{createElement:()=>({remove(){this.removed=true;}}),head:{appendChild:value=>{script=value;}}},importModule:async()=>({default:backend})});await until(()=>!!script);assert.match(script.src,/^\/base\/vendor/);const late=script.onload;controller.abort();await assert.rejects(loading,{name:"AbortError"});assert.equal(script.removed,true);assert.equal(script.onload,null);late();
});

await finish({checkFile:"src/own-x3d-integration-check.mjs",faults:[
  {statement:"lighting",name:"host lighting not applied after document load",expect:/host environment on the loaded document scene/,edits:[{file:"web/own-x3d-document.mjs",find:"      if (lighting) {\n",replace:"      if (false) {\n"}]},
  {statement:"selection",name:"own selection routes into legacy boot",expect:/actual boot path/,edits:[{file:"web/demo-shell-bootstrap.mjs",find:'choice.active.kind === "x3dom" || choice.active.kind === "x_ite"',replace:'choice.active.kind !== "three"'}]},
  {statement:"cadence",name:"viewer inherits wrong speed",expect:/legacy 2.4 m\/s viewer speed/,edits:[{file:"web/movement-camera-controller.mjs",find:'const distance = 2.4 * deltaSeconds;',replace:'const distance = 1.2 * deltaSeconds;'}]},
  {statement:"documents",name:"prepared document draws before host cadence",expect:/no draw during unpublished preparation/,edits:[{file:"web/own-x3d-document.mjs",find:'      assertCurrent();\n      if (state.realization.preparedPhysics)',replace:'      assertCurrent(); adapter.requestRender();\n      if (state.realization.preparedPhysics)'}]},
  {statement:"replacement-intents",name:"host dedup removed",expect:/host deduplicates destination intent/,edits:[{file:"web/own-x3d-document.mjs",find:'if (dispatched.has(key)) return false;',replace:'if (false) return false;'}]},
  {statement:"content-and-intents",name:"runtime generation guard lost",expect:/host denies stale runtime generation/,edits:[{file:"web/own-x3d-document.mjs",find:'|| !state.runtime.isCurrent(intent.generation)',replace:''}]},
  {statement:"content-and-intents",name:"admitted content digest ignored",expect:/Missing expected rejection/,edits:[{file:"web/own-x3d-document.mjs",find:'if (sha256 !== selection.sha256)',replace:'if (false)'}]},
  {statement:"documents",name:"physics outlives renderer sink",expect:/physics before renderer sink disposal/,edits:[{file:"web/own-x3d-document.mjs",find:'() => physics?.dispose(), () => rendererPreparation.dispose()',replace:'() => rendererPreparation.dispose(), () => physics?.dispose()'}]},
]});
