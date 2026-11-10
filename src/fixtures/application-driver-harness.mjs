import {createApplicationDriver} from "../../web/application-driver.mjs";
export function makeDriverFixture(readPublicDebugState) {
  const trace=[];
  const owner=(name,values={})=>new Proxy(values,{get(target,key){if(key in target)return target[key];return (...args)=>{trace.push([name+'.'+key,args]);return {owner:name,method:key,args};};}});
  const sharedScene={id:"world"},renderer={domElement:{id:"canvas"}},rig={visible:true,position:{x:1,y:2,z:3},rotation:{y:0.5},traverse(fn){fn({name:"visible-equipment-marker-test",isMesh:false});}};
  const layer={avatarRig:rig,renderer,scene:sharedScene,status:{avatar_variant:"chosen",errors:[],run_calibration:{speed:0}},isSettled:()=>false,debugState:()=>({attached_item_count:0}),rigProbe:()=>({pose:0}),motionWeights:()=>({idle:1})};
  const peerLayers=new Map([["peer",{...layer,__peerPlayerId:"person"}]]);
  const scene={rendererKind:"three",_impl:{scene:sharedScene,renderer,camera:{id:"camera"}}};
  const adapter=owner("adapter",{state:{phase:"idle"},debugState:()=>({phase:"idle"})});
  const movementCameraController=owner("movement",{exitPoseParity:()=>({delta:0}),crossingHeadingContinuity:()=>({yaw:0}),controlState:()=>({forward:false})});
  const env={role:"player",isPlayer:true,adapter,scene,equipmentLayer:layer,peerAvatarLayers:peerLayers,movementCameraController,
    sceneRuntimeController:owner("scene",{activeAdapter:()=>({getCapabilities:()=>({engine:"three"})})}),liveViewport:owner("viewport"),mainDemo:owner("main"),
    avatarSelectorController:owner("selector",{selectorDriver:()=>({}),inventoryDriver:()=>({})}),
    panelTruthChromeController:owner("panels",{wowApiDriver:()=>({}),groupDriver:()=>({}),chromeDriver:()=>({})}),
    storefrontShoppingController:owner("shop",{driver:()=>({})}),boardingJourneyController:owner("boarding",{driver:()=>({})}),
    runtimeTweakController:owner("tweaks"),semanticDestinationsController:owner("destinations"),
    connectionPresentation:{state:"live",recoverable:false},FRONTEND_CONTRACT:{version_id:"fixture"},lastExitPoseParity:{delta:0},lastCrossingHeadingContinuity:{yaw:0},
    crossingGuardFailures:[{handoff_id:"h"}],observedPhaseLog:[{phase:"idle",at_ms:0}],portalVisualAlignment:null,
    adapterVisualRuntimeSnapshot:()=>({state:{avatar:{id:"avatar"},portal:{id:"portal"}},world:{id:"world"}}),
    adapterVisualDebugState:()=>({phase:"idle"}),canonicalDebugState:value=>({...value}),updatePortalPreviewSurface:()=>null,
    worldDebugPanel:{render(){}},publishDebugDataset(){},document:{body:{}},$:()=>null,
    disposeApplication:()=>trace.push(["dispose",[]]),};
  env.avatarSelectorRemoveAllEquipment=()=>env.avatarSelectorController.removeAllEquipment();
  const newDriver=()=>createApplicationDriver({role:env.role,isPlayer:env.isPlayer,contract:env.FRONTEND_CONTRACT,lookup:env.$,connectionStatus:()=>({...env.connectionPresentation}),getScene:()=>env.scene,getEquipmentLayer:()=>env.equipmentLayer,peerAvatarLayers:()=>peerLayers,adapterVisualRuntimeSnapshot:env.adapterVisualRuntimeSnapshot,
    debugState:()=>readPublicDebugState(env),phaseLog:()=>env.observedPhaseLog.map(value=>({...value})),crossingGuardFailures:()=>env.crossingGuardFailures.map(value=>({...value}))},
    {dispose:env.disposeApplication,reset:async()=>{movementCameraController.reset();env.boardingJourneyController.reset("new_session");return adapter.reset();}},env);
  return {env,trace,newDriver};
}
export async function exerciseDriver(driver,trace) {
  const values={},args={cameraSpaceOfPoint:[[1,2,3]],samplePortalApertureTexels:["edge",[[1,2,3]]],moveAvatar:[{forward:true},0],applyArrival:[{id:"h"}],switchAvatar:["chosen"],equipItem:["item"],setCameraMode:["first_person"],setServerViewMode:["top_down"],orbitCamera:[0,0,0]};
  for(const key of Object.keys(driver).sort()) {
    if(typeof driver[key]==="function")values[key]=await driver[key](...(args[key]||[]));
  }
  for(const key of ["viewport","avatarSelector","runtimeTweaks","semanticDestinations"]) {
    if(!driver[key]){values[key]=driver[key];continue;}
    values[key]={};for(const method of Object.keys(driver[key]).sort())if(typeof driver[key][method]==="function")values[key][method]=await driver[key][method]("fixture",0);
  }
  return JSON.parse(JSON.stringify({keys:Object.keys(driver).sort(),values,trace}));
}
