import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {makeDriverFixture,exerciseDriver} from "./fixtures/application-driver-harness.mjs";
import {makeStatePresentationFixture,evaluateStatePresentation,presentationInput,readApplicationFunction} from "./fixtures/application-state-presentation-harness.mjs";
import {createHarness} from "../tools/behavior/controller-harness.mjs";
import {nodeChecks} from "../tools/behavior/node-checks.mjs";
import {requireActiveBoot} from "../web/application-boot.mjs";
const {check,finish}=nodeChecks("application-assembly");
const source=readFileSync(new URL("../web/app.js",import.meta.url),"utf8");
await check("driver-contract","Public driver keys, values and actual owner calls match the captured assembly",async()=>{
  const readDebug=env=>new Function("bindings","with(bindings){"+readApplicationFunction(source,"readPublicDebugState")+";return readPublicDebugState();}")(env);
  const fixture=makeDriverFixture(readDebug),driver=fixture.newDriver();
  const actual=await exerciseDriver(driver,fixture.trace),expected=JSON.parse(readFileSync(new URL("./fixtures/application-driver.json",import.meta.url)));
  assert.deepEqual(actual,expected,"captured driver contract");
  fixture.env.equipmentLayer=null;assert.equal(driver.rigProbe(),null);assert.equal(driver.equipmentReady(),true,"driver reads current equipment");
  fixture.env.scene={_impl:{camera:{id:"next"}}};assert.equal(driver.viewport.identity().camera.id,"next");
});
await check("state-order","One normalized snapshot follows actual scene/peer writes and preserves presentation order",()=>{
  const now=Date.now;Date.now=()=>0;
  try {
    const actual=[];
    for(const isPlayer of [true,false]){
      const fixture=makeStatePresentationFixture(isPlayer),onState=evaluateStatePresentation(source,fixture.env);
      for(const phase of ["departed","departed","arrived"])onState(presentationInput(phase));
      actual.push({isPlayer,...fixture.snapshot()});
      fixture.env.applicationDisposed=true;const count=fixture.trace.length;onState(presentationInput("idle"));assert.equal(fixture.trace.length,count);
    }
    const expected=JSON.parse(readFileSync(new URL("./fixtures/application-state-presentation.json",import.meta.url)));
    assert.deepEqual(actual,expected,"captured state order");
  } finally {Date.now=now;}
});
await check("crossing-guard","Guard failure still presents the committed destination before reporting failure",async()=>{
  const trace=[],detail={kind:"world_navigator_composition_crossing",handoff_id:"h"};
  const env={document:{body:{}},applicationDisposed:false,logLine(){},publishExitPose:()=>trace.push("exit-proof"),
    movementCameraController:{inspectCrossing:()=>{trace.push("inspect");return {heading:{},exit:{},failures:["guard failed"]};},handleCrossing:()=>{trace.push("camera");return true;},recordCrossingView:()=>trace.push("camera-proof"),persistSession:()=>trace.push("persist")},
    recomposeActiveWorldScene:async()=>trace.push("compose"),onState:()=>trace.push("state"),adapter:{debugState:()=>({})},reportCrossingGuardFailures:()=>trace.push("failure"),mainDemo:{mountPlacementForActiveWorld:()=>trace.push("placement")},showToast:()=>trace.push("toast")};
  const handler=new Function("bindings","with(bindings){"+readApplicationFunction(source,"handleAdapterCrossing")+";return handleAdapterCrossing;}")(env);
  await handler({detail});assert.deepEqual(trace,["inspect","exit-proof","camera","camera-proof","compose","state","failure","persist","placement"],"committed crossing order");
  trace.length=0;env.recomposeActiveWorldScene=async()=>{throw Object.assign(new Error("retired"),{name:"AbortError"});};await handler({detail});assert(!trace.includes("state")&&!trace.includes("failure")&&!trace.includes("persist"));
  trace.length=0;env.recomposeActiveWorldScene=async()=>{throw new Error("unavailable");};await handler({detail});assert(trace.includes("toast"));assert(!trace.includes("state"));
});
await check("actual-crossing-diagnostics","Actual movement owner isolates guard exceptions without mutating avatar",()=>{
  const harness=createHarness(),before=structuredClone(harness.state.avatar);
  const result=harness.controller.inspectCrossing({kind:"world_navigator_composition_crossing",handoff_id:"h"});
  assert(result.failures.some(value=>value.includes("applyExitPoseParity")),"missing edge identity is reported by guard");
  assert.deepEqual(harness.state.avatar,before);harness.controller.dispose();
});
await check("diagnostic-acquisition","Actual diagnostic getter failure is reported after the committed destination is presented",async()=>{
  const harness=createHarness(),trace=[],avatar=harness.state.avatar;
  Object.defineProperty(harness.state,"avatar",{configurable:true,get(){throw new Error("named diagnostic read failure");}});
  const env={document:{body:{}},applicationDisposed:false,logLine(){},publishExitPose(){},
    movementCameraController:{inspectCrossing:detail=>harness.controller.inspectCrossing(detail),handleCrossing:()=>true,recordCrossingView(){},persistSession:()=>trace.push("persist")},
    recomposeActiveWorldScene:async()=>trace.push("compose"),onState:()=>trace.push("state"),adapter:{debugState:()=>({})},
    reportCrossingGuardFailures:(_detail,failures)=>{assert(failures.some(f=>f.includes("named diagnostic read failure")));trace.push("reported");},
    mainDemo:{mountPlacementForActiveWorld(){}},showToast:()=>trace.push("scene-error")};
  const handler=new Function("bindings","with(bindings){"+readApplicationFunction(source,"handleAdapterCrossing")+";return handleAdapterCrossing;}")(env);
  try {
    await handler({detail:{kind:"world_navigator_composition_crossing"}});assert.deepEqual(trace,["compose","state","reported","persist"],"diagnostic failure preserves committed presentation");
    trace.length=0;env.recomposeActiveWorldScene=async()=>{throw new Error("real scene failure");};await handler({detail:{kind:"world_navigator_composition_crossing"}});
    assert.deepEqual(trace,["scene-error"],"real scene failure is not swallowed");
  } finally {Object.defineProperty(harness.state,"avatar",{configurable:true,writable:true,value:avatar});harness.controller.dispose();}
});
await check("session-intent","Actual session setup preserves restored pose and read-only hash intent, fencing retired joins",async()=>{
  const trace=[],listeners=new Map(),intent=Object.freeze({aspectId:"preview",join:false});
  let restored=null,hashIntent=intent;
  const env={applicationDisposed:false,isPlayer:true,requireActiveBoot,window:{location:{assign:url=>trace.push(["navigate",url])}},
    wowUrlIntent:intent,readWowUrlIntent:()=>hashIntent,readRestorablePlayerSession:()=>restored,
    listenAtRoot:(target,type,listener)=>listeners.set(type,listener),logLine(){},vec3Label:()=>"pose",
    adapter:{listenForCrossWindow:()=>trace.push("cross-window"),applyWowIntent:value=>trace.push(["hash",value]),applyRestoredPose:value=>{trace.push(["restore",value]);return true;}},
    movementCameraController:{setRestoredCameraSeed:value=>trace.push(["camera",value])},
    mainDemo:{handlePortalRefused:detail=>trace.push(["refused",detail]),arriveAtJoin:async id=>trace.push(["join",id])},
    presentLiveWorld:()=>trace.push("present")};
  const prepare=new Function("bindings","with(bindings){"+readApplicationFunction(source,"prepareLiveSession")+";return prepareLiveSession;}")(env);
  await prepare();assert.deepEqual(trace,["cross-window",["join","preview"],"present"],"initial join order");
  listeners.get("hashchange")();assert.equal(trace.at(-1)[1],intent,"hash intent passed unchanged");
  hashIntent=null;const before=trace.length;listeners.get("hashchange")();assert.equal(trace.length,before,"empty hash ignored");
  listeners.get("portal-refused")({detail:"denied"});listeners.get("portal-navigate")({detail:{url:"/next"}});
  assert.deepEqual(trace.slice(-2),[["refused","denied"],["navigate","/next"]]);
  restored={position:[3,0,8],orbit_azimuth_rad:1,orbit_polar_rad:2,orbit_distance_m:4};trace.length=0;
  await prepare();assert.deepEqual(trace,["cross-window",["restore",restored],["camera",{azimuth:1,polar:2,distance:4}],"present"],"restored session suppresses join");
  trace.length=0;env.isPlayer=false;await prepare();assert.deepEqual(trace,["cross-window","present"],"observer does not restore or join");
  env.isPlayer=true;restored=null;trace.length=0;let resolve;
  env.mainDemo.arriveAtJoin=()=>new Promise(done=>{resolve=done;});const pending=prepare();env.applicationDisposed=true;resolve();
  await assert.rejects(pending,{name:"AbortError"});assert(!trace.includes("present"),"retired join cannot publish world");
});
await check("wow-avatar-assembly","Actual graph avatar assembly preserves measured bounds and session camera, with no late readiness publication",async()=>{
  const trace=[],walkable={spawn:[2,3,4,1],min_x:-5,max_x:6,min_z:-7,max_z:8};
  let resolve;const ready=new Promise(done=>{resolve=done;});
  const layer={ready,setAvatar:value=>trace.push(["avatar",value])};
  const env={isPlayer:true,applicationDisposed:false,equipmentLayer:null,requireActiveBoot,role:"player",motionPreference:{},
    $:()=>({}),avatarLayerHost:()=>({}),AvatarEquipmentLayer:function(){return layer;},
    adapter:{world:{},state:{avatar:{id:"same"}},spawnWowLocalAvatar:value=>trace.push(["spawn",value]),applyRestoredPose:()=>true},
    listenAtRoot:(_target,type)=>trace.push(["listen",type]),logLine(){},vec3Label:()=>"pose",
    readRestorablePlayerSession:()=>({position:[5,0,8],orbit_azimuth_rad:1,orbit_polar_rad:2,orbit_distance_m:3}),
    movementCameraController:{seedOrbitCamera:value=>trace.push(["orbit",value]),start:()=>trace.push("start"),applyPlayerCamera:()=>trace.push("camera")},
    document:{body:{setAttribute:(...args)=>trace.push(["attribute",...args])}}};
  const functions=["restoreWowAvatar","publishWowAvatarWalk","mountWowAvatar"].map(name=>readApplicationFunction(source,name)).join("\n");
  const mount=new Function("bindings","with(bindings){"+functions+";return mountWowAvatar;}")(env);
  const resolved={spatialID:"space",graph:{title:"World"}},built={render_summary:{walkable_extent:walkable}};
  const pending=mount(resolved,built,null);assert.deepEqual(trace,[["spawn",{spawn:walkable.spawn,bounds:{minX:-5,maxX:6,minZ:-7,maxZ:8},spatialID:"space",title:"World"}]]);
  resolve();const result=await pending;assert.equal(result.embodied,true);assert.equal(result.walkable_extent,walkable);
  assert.deepEqual(trace.slice(1),[["avatar",env.adapter.state.avatar],["listen","state"],["orbit",{azimuth:Math.PI}],["orbit",{azimuth:1,polar:2,distance:3}],["avatar",env.adapter.state.avatar],"start","camera",["attribute","data-wow-avatar-embodied","1"]],"avatar assembly order");
  trace.length=0;layer.ready=new Promise(done=>{resolve=done;});const retired=mount(resolved,built,null);env.applicationDisposed=true;resolve();
  await assert.rejects(retired,{name:"AbortError"});assert.equal(trace.length,1,"retired avatar only had pre-await spawn");
});
await finish({checkFile:"src/application-assembly-check.mjs",faults:[
  {statement:"driver-contract",name:"camera command misrouted",expect:/captured driver contract/,edits:[{file:"web/application-movement-driver.mjs",find:"movementCameraController.togglePlayerCameraMode()",replace:"movementCameraController.toggleServerViewMode()"}]},
  {statement:"state-order",name:"peer update omitted",expect:/captured state order/,edits:[{file:"web/app.js",find:"sceneRuntimeController.syncPeers(dbg);",replace:"/* peer update omitted */"}]},
  {statement:"crossing-guard",name:"guard blocks committed scene",expect:/committed crossing order/,edits:[{file:"web/app.js",find:"publishExitPose(document.body, exit, logLine);",replace:"if(failures.length)return; publishExitPose(document.body, exit, logLine);"}]},
  {statement:"session-intent",name:"hash intent dropped",expect:/hash intent passed unchanged/,edits:[{file:"web/app.js",find:"void adapter.applyWowIntent(next);",replace:"void adapter.applyWowIntent(null);"}]},
  {statement:"diagnostic-acquisition",name:"diagnostic read escapes collector",expect:/named diagnostic read failure/,edits:[{file:"web/movement-camera-controller.mjs",find:'const debug=capture("crossingDiagnosticInput",()=>runtime()?.rawDebugState?.() || runtime()?.debugState?.());',replace:'const debug=runtime()?.rawDebugState?.() || runtime()?.debugState?.();'}]},
]});
