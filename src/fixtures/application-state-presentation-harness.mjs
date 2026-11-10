export function readApplicationFunction(source,name) {
  const match=source.match(new RegExp("^(?:async )?function "+name+"\\([^]*?^}","m"));
  if(!match)throw new Error("missing application function "+name);return match[0];
}
export function makeStatePresentationFixture(isPlayer) {
  const trace=[],elements=new Map(),body={setAttribute:(...args)=>trace.push(["attribute",...args])};
  const call=name=>(...args)=>trace.push([name,...args]);
  const lookup=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
  const scene={setPhase:call("scene-phase"),setAvatar:call("scene-avatar"),_impl:{scene:{id:"scene"}}};
  const env={isPlayer,role:isPlayer?"player":"source",applicationDisposed:false,scene,document:{body},$ :lookup,
    observedPhaseLog:[],lastObservedPhase:null,equipmentLayer:{setAvatar:call("local-avatar")},syncPeerAvatars:call("peer-avatar"),
    sceneRuntimeController:{syncPeers:call("peer-avatar"),syncPortalPeers:call("portal-peers"),liveAuthoredScene:()=>({airport_terminal:{id:"airport"}}),engagePortalTakeover:call("takeover"),portalTakeoverEngaged:()=>true,disengagePortalTakeover:call("release-takeover")},
    canonicalDebugState:value=>{trace.push(["normalize"]);return {...value,canonical:true};},adapterVisualRuntimeSnapshot:()=>({world:{id:"world"}}),
    semanticDestinationsController:{update:call("destinations")},worldDebugPanel:{render:call("world"),renderGeoPose:call("geopose")},
    publishDebugDataset:(_body,...args)=>trace.push(["dataset",...args]),syncReturnLobbyButton:call("return-button"),
    storefrontShoppingController:{observe:call("shop")},boardingJourneyController:{observe:call("boarding")},
    movementCameraController:{observeState:call("movement")},updatePortalPreviewSurface:()=>({surface:"preview"}),portalVisualAlignment:{existing:true},
    connectionPresentation:{state:"live"},HANDOFF_PHASES:{DEPARTED:"departed"},PHASE_LABEL:{departed:{text:"departed"},arrived:{text:"arrived"}},
    renderOverlay:call("overlay"),updateFabricPrefetchCard:call("prefetch"),ensureFabricPrefetchZoneRing:call("ring"),renderEquipment:call("equipment"),avatarSelectorController:{updateInventorySelection:call("inventory")},
    updateMovementDebug:call("movement-debug"),panelTruthChromeController:{refresh:call("chrome")},applyStageScenePresentation:call("stage"),featureNotePortalLoadingState:call("loading"),logLine:call("log")};
  env.statusPanel={connectionStatus:()=>env.connectionPresentation,renderState:debug=>{lookup("phase-pill").textContent=(env.PHASE_LABEL[debug.phase]||{text:debug.phase}).text;env.renderOverlay(debug.phase,debug);}};
  return {env,trace,snapshot:()=>JSON.parse(JSON.stringify({trace,elements:Object.fromEntries(elements),phases:env.observedPhaseLog}))};
}
export function evaluateStatePresentation(source,env,current=true) {
  const names=current?["observeApplicationPhase","updateSceneState","updateWorldPresentation","updateCrossingPresentation","updateStatusPresentation","onState"]:["onState"];
  return new Function("bindings","with(bindings){"+names.map(name=>readApplicationFunction(source,name)).join("\n")+";return onState;}")(env);
}
export function presentationInput(phase) {
  return {phase,location_id:"a",peer_players:[{client_id:"peer"}],avatar:{avatar_id:"avatar",continuity_id:"same",display_name:"Visitor",position:[1,0,2]},session:{arrival_count:0},equipment_status:null,handoff_id:"handoff",fabric_prefetch:{portal_key:"edge"},live_player_pose:{applied_count:1,from_client_id:"peer",location_id:"a"}};
}
