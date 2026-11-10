import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {bootLive,bootWow} from "../web/application-boot.mjs";
import {createWowScenePresentation} from "../web/three-wow-presentation.mjs";
import {THREE,FakeTarget} from "../tools/behavior/controller-harness.mjs";
import {nodeChecks} from "../tools/behavior/node-checks.mjs";
const {check,finish}=nodeChecks("application-boot");
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function liveFixture(pending) {
  const calls=[],gates=Object.fromEntries(["init","session","scene","avatar"].map(key=>[key,deferred()]));let disposed=false;
  const phase=async name=>{calls.push(name);if(name===pending)await gates[name].promise;};
  const adapter={world:{title:"current"},state:{phase:"idle"},debugState:()=>({}),init:()=>phase("init"),setAvatarLocomotionTuning:()=>{}};
  const options={adapter,isDisposed:()=>disposed,isPlayer:true,sceneRole:()=>"source",prepareSession:()=>phase("session"),sceneRuntime:{mountLive:()=>phase("scene")},createAvatar:()=>{calls.push("construct-avatar");return {ready:phase("avatar"),setLocomotionTuningListener(){calls.push("tuning");}};}};
  return {calls,gates,options,dispose(){disposed=true;calls.push("dispose-owned");}};
}
await check("live-order","Live boot awaits adapter, session, scene and avatar before returning",async()=>{
  const fixture=liveFixture("init"),pending=bootLive(fixture.options);await tick();assert.deepEqual(fixture.calls,["init"]);
  fixture.gates.init.resolve();const result=await pending;
  assert.equal(result.adapter,fixture.options.adapter);assert.deepEqual(fixture.calls,["init","session","scene","construct-avatar","avatar","tuning"]);
});
await check("live-disposal","Disposal during each awaited phase prevents later adoption",async()=>{
  for(const phase of ["init","session","scene","avatar"]) {
    const fixture=liveFixture(phase),pending=bootLive(fixture.options);const rejected=assert.rejects(pending,{name:"AbortError"});
    await tick();fixture.dispose();const count=fixture.calls.length;fixture.gates[phase].resolve();await rejected;
    assert.equal(fixture.calls.length,count,`no later ${phase} boot effects`);
  }
});
await check("live-rejection","Init, session, scene and avatar failures never report ready",async()=>{
  for(const phase of ["init","session","scene","avatar"]) {
    const fixture=liveFixture(phase),pending=bootLive(fixture.options);const rejected=assert.rejects(pending,/named failure/);
    await tick();const count=fixture.calls.length;fixture.gates[phase].reject(new Error("named failure"));await rejected;
    assert.equal(fixture.calls.length,count);
  }
});
await check("wow-order","WoW boot uses its graph owner, preserves load errors and fences cancellation",async()=>{
  const gate=deferred(),calls=[];let disposed=false;
  const adapter={initWow:()=>gate.promise},options={adapter,isDisposed:()=>disposed,logLine(){},sceneRuntime:{mountWowGraph:async(resolved,error)=>{calls.push([resolved,error]);return {built:resolved?.graph||null};}}};
  const first=bootWow(options);await tick();assert.deepEqual(calls,[]);gate.resolve({spatialID:"world",node_count:1,graph:{id:1}});assert.equal((await first).built.id,1);
  const failed=await bootWow({...options,adapter:{initWow:async()=>{throw new Error("unavailable");}}});assert.equal(failed.loadError,"unavailable");assert.deepEqual(calls.at(-1),[null,"unavailable"]);
  const late=deferred(),pending=bootWow({...options,adapter:{initWow:()=>late.promise}});const rejected=assert.rejects(pending,{name:"AbortError"});disposed=true;late.resolve({graph:{}});await rejected;assert.equal(calls.length,2);
});
function graphFixture(resolved={graph:{},source:"fixture"}) {
  const body=new FakeTarget(),document=new FakeTarget(),view=new FakeTarget(),canvas=new FakeTarget();
  document.body=body;document.createElement=()=>Object.assign(new FakeTarget(),{remove(){}});document.getElementById=()=>null;
  view.location={href:"http://fixture/",origin:"http://fixture"};view.requestAnimationFrame=()=>1;view.cancelAnimationFrame=()=>{};
  const gate=deferred(),assets=deferred(),calls=[];
  const built={scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),asset_nodes:[{id:1}],render_summary:{rendered:{rendered_nodes:1}}};
  let assetOptions;
  const owner=createWowScenePresentation({THREE,resolved,mount:{clientWidth:800,clientHeight:600},document,view,
    buildWowScene:()=>{calls.push("build");return built;},mountAirportTerminalContent:()=>null,mountWowSceneAssets:(_nodes,_engine,options)=>{assetOptions=options;return assets.promise;},
    loadGltf(){},cloneScene(){},cache:new Map(),sceneDescription:()=>({}),composeRenderer:async construct=>{await gate.promise;return construct({});},
    mountRenderer:()=>({_impl:{renderer:{domElement:canvas}}}),publishTerminal:()=>calls.push("terminal"),hideStageDebugVisuals(){},visitorPosition:()=>null,logLine(){}});
  return {owner,gate,assets,calls,body,document,view,canvas,assetOptions:()=>assetOptions};
}
await check("graph-lifetime","Mounted graph controls and pending asset publication retire together",async()=>{
  const fixture=graphFixture(),pending=fixture.owner.start();await tick();assert.deepEqual(fixture.calls,[]);
  fixture.gate.resolve();await pending;await tick();assert.deepEqual(fixture.calls,["build"]);assert.equal(fixture.assetOptions().shouldMount(),true);
  assert(fixture.canvas.listeners.size>0);fixture.owner.dispose();assert.equal(fixture.assetOptions().shouldMount(),false);
  for(const target of [fixture.canvas,fixture.document,fixture.view])for(const listeners of target.listeners.values())assert.equal(listeners.size,0,"graph listener removed");
  fixture.assets.resolve({loaded:1,failed:0});await tick();assert.equal(fixture.body.getAttribute("data-wow-assets-loaded"),null,"no late graph asset publication");
});
await check("graph-invalid-url","Malformed graph URL reports the existing render error without constructing resources",async()=>{
  const fixture=graphFixture({graph:{},graph_url:"http://[",source:"fixture"});
  const result=await fixture.owner.start();assert.match(result.renderState.error,/Invalid URL/);
  assert.equal(result.built,null);assert.deepEqual(fixture.calls,[]);fixture.owner.dispose();
});
await check("terminal-adoption","Actual terminal publisher preserves the previous identity on mount failure and releases unadopted terminal resources",async()=>{
  const sourceUrl=new URL("../web/scene-runtime-controller.mjs",import.meta.url);
  let source=readFileSync(sourceUrl,"utf8")
    .replace(/import \{ SpatialPortalPreviewManager \} from .*?;/,"const SpatialPortalPreviewManager = class {};")
    .replace(/import \{ composeBoundedPreview \} from .*?;/,"const composeBoundedPreview = () => { throw new Error('preview outside fixture'); };");
  source=source.replace(/from "(\.\/[^\"]+)"/g,(_,path)=>`from ${JSON.stringify(new URL(path,sourceUrl).href)}`);
  const {createSceneRuntimeController}=await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  for(const failure of [true,false]){
    const document=new FakeTarget(),view=new FakeTarget(),disposed={hud:0,entities:0};document.body=new FakeTarget();
    view.location={href:"https://fixture.invalid/",origin:"https://fixture.invalid"};
    const publisher=createSceneRuntimeController({THREE,documentTarget:document,windowTarget:view,isPlayer:false,
      applicationState:{cancelComposition(){}},getAvatarLayers:()=>({peers:[]}),logLine(){}});
    publisher.publishTerminalReadyWorld("previous-terminal");let mounted=null;
    const presentation=createWowScenePresentation({THREE,resolved:{graph:{},spatialID:"world-airport-terminal",source:"fixture"},mount:{},document,view,
      buildWowScene:()=>({scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(),asset_nodes:[],render_summary:{rendered:{rendered_nodes:1}}}),
      mountAirportTerminalContent:(_graph,built)=>{built.airport_hud_overlay={dispose:()=>disposed.hud++};built.airport_entity_runtime={dispose:()=>disposed.entities++};return {storefront_count:1,npc_count:1,gate:{gate:"A"}};},
      sceneDescription:()=>({}),hideStageDebugVisuals(){},composeRenderer:async build=>build({}),
      mountRenderer:({built})=>{
        assert.equal(document.body.getAttribute("data-terminal-ready-world"),"previous-terminal","no publication before renderer adoption");
        if(failure)throw new Error("named renderer mount failure");
        mounted={dispose(){built.airport_hud_overlay.dispose();built.airport_entity_runtime.dispose();}};return mounted;
      },publishTerminal:publisher.publishTerminalReadyWorld,logLine(){},loadGltf(){},cloneScene(){},cache:new Map(),visitorPosition:()=>null});
    try{
      const result=await presentation.start();await tick();
      assert.equal(document.body.getAttribute("data-terminal-ready-world"),failure?"previous-terminal":"world-airport-terminal","terminal publication follows adoption");
      if(failure){assert.match(result.renderState.error,/named renderer mount failure/);assert.equal(result.alternateRuntime,null);assert.equal(result.built,null);}
      else {assert.equal(result.alternateRuntime,mounted);assert.equal(document.body.getAttribute("data-airport-terminal-ready"),"1");}
      assert.deepEqual(disposed,failure?{hud:1,entities:1}:{hud:0,entities:0},"only unadopted terminal resources released");
      presentation.dispose();assert.deepEqual(disposed,failure?{hud:1,entities:1}:{hud:0,entities:0},"presentation disposal does not release them twice");
    }finally{presentation.dispose();mounted?.dispose();publisher.dispose();}
  }
});
await finish({checkFile:"src/application-boot-check.mjs",faults:[
  {statement:"live-disposal",name:"boot cancellation ignored",expect:/Missing expected rejection|no later/,edits:[{file:"web/application-boot.mjs",find:"if (isDisposed())",replace:"if (false)"}]},
  {statement:"live-order",name:"scene readiness not awaited",expect:/Expected values|Live boot/,edits:[{file:"web/application-boot.mjs",find:"await adapter.init();",replace:"void adapter.init();"}]},
  {statement:"graph-lifetime",name:"retired assets publish",expect:/no late graph asset publication/,edits:[{file:"web/three-wow-presentation.mjs",find:'if (!active()) return;\n      Object.assign(renderState.asset_load, summary',replace:'Object.assign(renderState.asset_load, summary'}]},
  {statement:"terminal-adoption",name:"terminal ready before mount",expect:/terminal publication follows adoption/,edits:[{file:"web/three-wow-presentation.mjs",find:"    runtime = mountRenderer({",replace:"    if (terminal) publishTerminal(resolved.spatialID);\n    runtime = mountRenderer({"}]},
  {statement:"terminal-adoption",name:"failed terminal resources leaked",expect:/only unadopted terminal resources released/,edits:[{file:"web/three-wow-presentation.mjs",find:"built?.airport_hud_overlay?.dispose();",replace:"/* unadopted HUD not released */"}]},
]});
