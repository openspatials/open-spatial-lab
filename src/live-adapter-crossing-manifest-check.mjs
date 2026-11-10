import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const root = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fileURLToPath(new URL('..', import.meta.url)));
const baseline = process.argv.includes('--baseline');
const fault = process.argv.includes('--unsigned-control');
const source = readFileSync(resolve(root, 'web/live-adapter.js'), 'utf8');
const defaultVariant = readFileSync(resolve(root, 'web/avatar-equipment-layer.js'), 'utf8').match(/DEFAULT_AVATAR_VARIANT = "([^"]+)"/)[1];
const fields = ['trust_tier','holder_binding','sealed_facets','agent_delegation','receipt','entity_personhood','statusref','liveness_assurance','higher_tier_proofs','bilateral_session','private_data','format_independence','rp1_som_gating'].map(x=>`um_${x}_v04`);
const json = x => JSON.parse(JSON.stringify(x));
const emitter = await import(pathToFileURL(resolve(root, 'web/manifest/um-manifest-emitter.mjs')));
const holder = await import(pathToFileURL(resolve(root, 'web/manifest/holder-binding.mjs')));
const packetInput = { handoff_id:'fixture-handoff', source:{location_id:'a',continuity_id:'fallback'}, target:{location_id:'b',base_url:'https://b.invalid/wow/world'}, avatar_context:{equippedItems:[{itemId:'fixture-item'}],equipment_profile:'fixture-profile'} };
const world = {location_id:'fallback-world',avatar:{continuity_id:'stable-person',avatar_id:'chosen-avatar',display_name:'Fixture'}};
const fn = name => { const start=source.indexOf(`function ${name}(`); assert.ok(start>=0,name); const asyncStart=source.slice(start-6,start)==='async '?start-6:start; return source.slice(asyncStart,source.indexOf('\n}',start)+2); };
function baselineModule() {
  const body=['featureCrossingStateFromPacket','featureSignManifestOntoPacket','featureVerifyManifestFromPacket'].map(fn).join('\n');
  const imports=[...source.matchAll(/^import\s*\{(.*?)\}\s*from\s*"([^"]+)";/gms)].flatMap(([,bindings,path])=>{
    const used=bindings.split(',').map(x=>x.trim()).filter(x=>x && body.includes(x.split(' as ').at(-1)) && !x.includes('DEFAULT_AVATAR_VARIANT'));
    return used.length?[`import { ${used.join(',')} } from '${path}';`]:[];
  });
  return imports.join('\n')+`\nconst DEFAULT_AVATAR_VARIANT=${JSON.stringify(defaultVariant)};\n`+body+'\nexport { featureCrossingStateFromPacket as crossingStateFromPacket, featureSignManifestOntoPacket as signManifestOntoPacket, featureVerifyManifestFromPacket as verifyManifestFromPacket };';
}
async function load(overrides={}) {
  const context=createContext({console,crypto:globalThis.crypto,TextEncoder,TextDecoder,URL,Date,Uint8Array,ArrayBuffer,Buffer,atob,btoa,structuredClone});
  const cache=new Map();
  async function module(path,entry=false) {
    if(cache.has(path)) return cache.get(path);
    if(entry || /\/(?:live-adapter-)?crossing-[^/]+\.mjs$/.test(path)) {
      let text=entry&&baseline?baselineModule():readFileSync(path,'utf8');
      if(entry&&fault) text=text.replace('signed: true,','signed: false,');
      if(process.argv.includes('--omit-surface-control')) text=text.replace('["um_trust_tier_v04", attachTrustTier],','');
      const m=new SourceTextModule(text,{context,identifier:path}); cache.set(path,m);
      await m.link(ref=>module(resolve(dirname(path),ref))); return m;
    }
    const native=await import(pathToFileURL(path));
    const m=new SyntheticModule(Object.keys(native),function(){for(const key of Object.keys(native)) this.setExport(key,overrides[key]??native[key]);},{context,identifier:path});
    cache.set(path,m); return m;
  }
  const m=await module(resolve(root,baseline?'web/live-adapter.js':'web/live-adapter-crossing-manifest.mjs'),true);
  await m.evaluate();
  const diagnostic=await module(resolve(root,'web/live-adapter-crossing-diagnostics.mjs'));
  await diagnostic.evaluate();
  return { ...m.namespace, ...diagnostic.namespace };
}
const actual=await load();
const untouched=JSON.stringify(packetInput);
const state=actual.crossingStateFromPacket(packetInput,world,defaultVariant);
assert.equal(state.continuityId,'stable-person'); assert.equal(state.sourceLocationId,'a'); assert.equal(state.targetLocationId,'b');
assert.equal(state.loading.target,packetInput.target.base_url); assert.equal(state.avatar.variant,defaultVariant);
assert.equal(JSON.stringify(packetInput),untouched);
const fallback=actual.crossingStateFromPacket({source:{continuity_id:'packet-person'},avatar_context:{source_location_id:'c',target_location_id:'d'}},null,defaultVariant);
assert.equal(fallback.continuityId,'packet-person'); assert.equal(fallback.sourceLocationId,'c'); assert.equal(fallback.targetLocationId,'d'); assert.equal(fallback.loading,undefined);
const signed=await emitter.buildAndSignManifest(state,{bindDidSubject:true}); assert.equal(signed.signed,true);
const bytes=JSON.stringify(signed.manifest);
const api=await load({buildAndSignManifest:async(s,options)=>{assert.deepEqual(json(s),json(state));assert.equal(options.bindDidSubject,true);return {...signed,manifest:structuredClone(signed.manifest)};}});
const packet=structuredClone(packetInput), events=[];
const report=await api.signManifestOntoPacket(packet,world,{emitSyntheticApiRequest:e=>events.push(json(e))},defaultVariant);
assert.equal(report.signed,true,'crossing reports real signing'); assert.equal(report.did_subject,signed.didKey); assert.equal(report.key_ref,signed.manifest.signature.keyRef);
assert.equal(JSON.stringify(packet.avatar_context.um_manifest_v04),bytes,'all enrichments preserve exact signed bytes');
const sentBytes=JSON.stringify(packet), publications=[];
await api.publishCrossingDiagnostics(packet,{transport:{emitSyntheticApiRequest:e=>events.push(json(e))},isCurrent:()=>true,publish:r=>publications.push(json(r))});
assert.equal(JSON.stringify(packet),sentBytes,'diagnostics never mutate the sent packet');
assert.equal(publications[0].state,'pending');assert.equal(publications.at(-1).state,'complete');
assert.equal(publications.length,15,'pending plus 13 ordered surface updates plus terminal state');
const diagnosticPacket={avatar_context:publications.at(-1).surfaces};
assert.deepEqual(Object.keys(diagnosticPacket.avatar_context).filter(x=>fields.includes(x)),fields,'13 surfaces retain original order');
const shape=Object.fromEntries(fields.map(key=>[key,Object.keys(diagnosticPacket.avatar_context[key]).sort()]));
for(const field of fields) assert.ok(diagnosticPacket.avatar_context[field] && typeof diagnosticPacket.avatar_context[field]==='object',field);
for(const field of fields) assert.equal(diagnosticPacket.avatar_context[field].error,undefined,field+' must produce useful data');
assert.equal(diagnosticPacket.avatar_context.um_sealed_facets_v04.holder_round_trip_ok,true);
assert.equal(diagnosticPacket.avatar_context.um_bilateral_session_v04.chain_verified,true);
assert.equal(diagnosticPacket.avatar_context.um_bilateral_session_v04.correlated_pair_found,true);
assert.equal(diagnosticPacket.avatar_context.um_format_independence_v04.receiptsEqual,true);
for(const key of ['cross_branch_write_blocked','hazard_reroute_delivered','ad_push_refused','chain_verified']) assert.equal(diagnosticPacket.avatar_context.um_rp1_som_gating_v04[key],true,key);
assert.deepEqual(events.map(e=>e.method),['RECEIPT','RECEIPT','BILATERAL',...Array(6).fill('PRIVATE-DATA'),'RP1-SOM']);
const verification=await api.verifyManifestFromPacket(packet); assert.equal(verification.verified,true); assert.equal(verification.handoff_id,'fixture-handoff');
const tampered=structuredClone(packet); tampered.avatar_context.um_manifest_v04.subject='did:key:tampered'; assert.equal((await api.verifyManifestFromPacket(tampered)).verified,false);
assert.deepEqual(json(await api.verifyManifestFromPacket({})),{present:false,verified:null,reason:'no-signed-manifest-in-packet'});
assert.equal(await api.signManifestOntoPacket(null,world,{},defaultVariant),null);
for(const [label,override,error] of [['unsigned',async()=>({signed:false}), 'emitter did not return a signed manifest'],['sign-throws',async()=>{throw new Error('planted-sign');},'planted-sign']]) {
  const a=await load({buildAndSignManifest:override}), p=structuredClone(packetInput);
  assert.deepEqual(json(await a.signManifestOntoPacket(p,world,{},defaultVariant)),{signed:false,error},label); assert.equal(p.avatar_context.um_manifest_v04,undefined);
}
const throwingVerifier=await load({verifyManifestSignatureDetailed:async()=>{throw new Error('planted-verify');}});
assert.deepEqual(json(await throwingVerifier.verifyManifestFromPacket(packet)),{present:true,verified:false,reason:'verify-threw:planted-verify'});
const failures=[['buildTierDemoSurface',0],['issueVerifierChallenge',1],['demoSealedFacetSurface',2],['emitAgentDelegationPointer',3],['createReceipt',4],['buildEntityPersonhoodDemoSurface',5],['makeDemoStatusAuthority',6],['demoLockedFacetScenario',7],['buildProofShapesDemoSurface',8],['conductBilateralExchange',9],['buildPrivateDataPanel',10],['runFormatIndependenceScenario',11],['runFactoryFloorSomDemo',12]];
for(const [builder,index] of failures) {
  const a=await load({buildAndSignManifest:async()=>({...signed,manifest:structuredClone(signed.manifest)}),[builder]:()=>{throw new Error(`planted-${builder}`);}});
  const p=structuredClone(packetInput), result=await a.signManifestOntoPacket(p,world,{emitSyntheticApiRequest(){}},defaultVariant);
  const sent=JSON.stringify(p), updates=[];
  await a.publishCrossingDiagnostics(p,{transport:{emitSyntheticApiRequest(){}},isCurrent:()=>true,publish:r=>updates.push(json(r))});
  const surface=updates.at(-1).surfaces;
  assert.equal(result.signed,true,builder); assert.equal(surface[fields[index]].error,`planted-${builder}`);
  assert.equal(updates.at(-1).state,'failed');
  assert.deepEqual(Object.keys(surface),fields,builder+' later surfaces survive');
  assert.equal(JSON.stringify(p),sent,'builder failure cannot alter sent payload');
  assert.equal(JSON.stringify(p.avatar_context.um_manifest_v04),bytes);
}
let release,entered; const waiting=new Promise(r=>entered=r); const blocked=new Promise(r=>release=r); let first=true;
const delayed=await load({buildAndSignManifest:async()=>({...signed,manifest:structuredClone(signed.manifest)}),evaluateHolderBinding:async(...args)=>{if(first){first=false;entered();await blocked;}return holder.evaluateHolderBinding(...args);}});
const delayedPacket=structuredClone(packetInput), delayedEvents=[], delayedUpdates=[];
const signing=await delayed.signManifestOntoPacket(delayedPacket,world,{},defaultVariant);
assert.equal(signing.signed,true,'required signing resolves independently');
const wire=JSON.stringify(delayedPacket);let settled=false;
const pending=delayed.publishCrossingDiagnostics(delayedPacket,{transport:{emitSyntheticApiRequest:e=>delayedEvents.push(e)},isCurrent:()=>true,publish:r=>delayedUpdates.push(json(r))}).then(()=>{settled=true;});
await waiting;assert.equal(settled,false);assert.equal(delayedUpdates.at(-1).state,'pending');
assert.equal(delayedPacket.avatar_context.um_sealed_facets_v04,undefined);release();await pending;
assert.equal(JSON.stringify(delayedPacket),wire);assert.equal(delayedUpdates.at(-1).state,'complete');
for(const cancel of ['operation','handoff','manifest','signature']){
 let release,entered;const waiting=new Promise(r=>entered=r),block=new Promise(r=>release=r);let first=true,current=true;
 const a=await load({buildAndSignManifest:async()=>({...signed,manifest:structuredClone(signed.manifest)}),evaluateHolderBinding:async(...args)=>{if(first){first=false;entered();await block;}return holder.evaluateHolderBinding(...args);}});
 const p=structuredClone(packetInput);await a.signManifestOntoPacket(p,world,{},defaultVariant);const events=[],updates=[];
 const work=a.publishCrossingDiagnostics(p,{transport:{emitSyntheticApiRequest:e=>events.push(e)},isCurrent:()=>current,publish:r=>updates.push(r)});
 await waiting;const count=updates.length;
 if(cancel==='operation')current=false;
 if(cancel==='handoff')p.handoff_id='replacement';
 if(cancel==='manifest')p.avatar_context.um_manifest_v04['@id']='replacement';
 if(cancel==='signature')p.avatar_context.um_manifest_v04.signature.value='replacement';
 const snapshot=JSON.stringify(p);release();await work;
 assert.equal(updates.length,count,cancel+' revokes publication');assert.equal(events.length,0);assert.equal(JSON.stringify(p),snapshot);
}
console.log(JSON.stringify({kind:'candidate',passed:true,fields:shape,eventMethods:events.map(e=>e.method),controls:['real signature and tampered subject','unchanged sent bytes','all 13 ordered useful diagnostics','13 contained builder failures','pending/complete/failed truthful','delayed optional work independent of signing','operation and packet/manifest/signature identity revoke publication'],networkRequests:0},null,2));
