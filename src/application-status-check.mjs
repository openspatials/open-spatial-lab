import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createApplicationStatusPanel} from "../web/application-status-panel.mjs";
import {createFabricNotificationPublisher} from "../web/fabric-notification-publisher.mjs";
import {statusCases} from "./fixtures/application-status-cases.mjs";
import {FakeTarget} from "../tools/behavior/controller-harness.mjs";
import {nodeChecks} from "../tools/behavior/node-checks.mjs";
import {STEPS} from "../tools/run-checks-lists.mjs";
const {check,finish}=nodeChecks("application-status");
const {HANDOFF_PHASES}=await import("data:text/javascript;base64,"+Buffer.from(readFileSync(new URL("../runtime/scene-core/public/frontend-contract.js",import.meta.url))).toString("base64"));
const make=({dom,adapter,isPlayer,role,notices,toasts})=>{
  const owner=createApplicationStatusPanel({lookup:dom.lookup,body:dom.body,isPlayer,role,phases:HANDOFF_PHASES,
    notifications:{show:(...value)=>toasts.push(value),publish:value=>notices.push(value),latestByKind:()=>"loading-record"},
    getAdapter:()=>adapter,canonicalDebugState:value=>value,destinationLoadingContent:()=>null,
    onConnectionChange:()=>notices.push("semantic-update"),reload:()=>notices.push("reload"),
    listen:(target,type,listener)=>target.addEventListener(type,listener),reconcile:dom.reconcile});
  return {...owner,snapshot:owner.connectionStatus,dismiss:()=>owner.dismissOrientation("idle",{})};
};
make.notifications=(adapter,publish)=>createFabricNotificationPublisher({getActive:()=>adapter.active,publish});
await check("captured-status","Status, equipment, recovery and event notices preserve all captured outputs",async()=>{
  const RealDate=Date;
  globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:["2026-01-01T00:00:00Z"]));}static now(){return 1767225600000;}};
  try {
    const actual=await statusCases(make),expected=JSON.parse(readFileSync(new URL("./fixtures/application-status.json",import.meta.url)));
    assert.equal(actual.length,23);assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected,"captured status output");
  } finally {globalThis.Date=RealDate;}
});
await check("return-lifetime","One return request owns its pending UI and cannot publish after disposal",async()=>{
  const button=Object.assign(new FakeTarget(),{dataset:{}}),body=new FakeTarget(),notices=[],toasts=[];
  let resolve,calls=0;
  const adapter={debugState:()=>({location_id:"a"}),returnToLobby:()=>{calls++;return new Promise(yes=>resolve=yes);}};
  const owner=make({dom:{lookup:()=>button,body,reconcile(){}},adapter,isPlayer:true,role:"player",notices,toasts});
  const first=owner.handleReturnLobbyClick();await owner.handleReturnLobbyClick();
  assert.equal(calls,1,"one return in flight");assert.equal(button.disabled,true);
  owner.dispose();resolve({ok:true});await first;
  assert.equal(notices.length,0,"retired return cannot notify");assert.equal(toasts.length,0);
  await owner.handleReturnLobbyClick();assert.equal(calls,1);
});
await check("return-reject","Rejected return releases its in-flight guard",async()=>{
  const button=Object.assign(new FakeTarget(),{dataset:{}});let calls=0;
  const owner=make({dom:{lookup:()=>button,body:new FakeTarget(),reconcile(){}},adapter:{debugState:()=>({location_id:"a"}),returnToLobby:async()=>{calls++;throw new Error("refused");}},isPlayer:true,role:"player",notices:[],toasts:[]});
  await assert.rejects(owner.handleReturnLobbyClick(),/refused/);assert.equal(button.disabled,false);
  await assert.rejects(owner.handleReturnLobbyClick(),/refused/);assert.equal(calls,2);
});
await check("registration","Completion checks remain automatic source checks",()=>{
  for(const name of ["application-status","application-boot","application-assembly","peer-avatar-presentation"]) {
    const selected=STEPS.filter(step=>step.file===`src/${name}-check.mjs`);
    assert.equal(selected.length,1,"completion check registered once");assert(selected[0].groups.includes("client")&&!selected[0].browser&&!selected[0].lab);
  }
});
await finish({checkFile:"src/application-status-check.mjs",faults:[
  {statement:"captured-status",name:"repeat phase toasts",expect:/captured status output/,edits:[{file:"web/application-phase-panel.mjs",find:"if (phase !== lastToastPhase)",replace:"if (true)"}]},
  {statement:"captured-status",name:"duplicate completion events",expect:/captured status output/,edits:[{file:"web/fabric-notification-publisher.mjs",find:"if (lastFabricCompletionRecordedFor === recordKey) return;",replace:"/* missing duplicate suppression */"}]},
  {statement:"return-lifetime",name:"late return publishes",expect:/retired return cannot notify/,edits:[{file:"web/application-status-panel.mjs",find:"if (disposed) return;\n      if (result && result.ok)",replace:"if (result && result.ok)"}]},
]});
