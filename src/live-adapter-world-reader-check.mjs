import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root=resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
const baseline=process.argv.includes('--baseline');
const fault=process.argv.includes('--stale-adoption-control');
const source=readFileSync(resolve(root,'web/live-adapter.js'),'utf8');
const load=rel=>import(pathToFileURL(resolve(root,rel)));
const {readGeoPose}=await load('web/wow-geopose.mjs');
const {flattenCanonicalNode}=await load('web/wow-graph.mjs');
const {readPortalResources}=await load('web/main-demo-portals.mjs');
const {displayPath}=await load('web/live-adapter-transport.mjs');
const refs=await load('web/live-adapter-fabric-reference.mjs');
const json=x=>JSON.parse(JSON.stringify(x));
const method=name=>{const re=new RegExp('^  (?:async )?'+name+'\\(','m'),m=re.exec(source);assert.ok(m,name);return source.slice(m.index,source.indexOf('\n  }',m.index)+4);};
let resolveWowEndpoints,readers={};
if(baseline){
  const start=source.indexOf('const WOW_SERVICE_TYPE'),end=source.indexOf('\nfunction yawFromQuaternionY',start);
  resolveWowEndpoints=new Function('displayPath',source.slice(start,end)+'\nreturn resolveWowEndpoints;')(displayPath);
}else{
  readers=await load('web/live-adapter-world-reader.mjs');
  resolveWowEndpoints=(await load('web/live-adapter-world-discovery.mjs')).resolveEndpoints;
}
const names=['initWow','_readGraphDocument','_walkCanonicalGraph','_resolveWowSceneGraph','_ensureRootFabric','_resolveWowEndpoints','_fetchWowPortals'];
let methods=names.map(method).join('\n');
if(fault) methods=methods.replace('!this._disposed && this._wowSceneReadOperation === operation && this.base === base && this.world === world && this.wowRef === wowRef','true');
const bindings={readGeoPose,flattenCanonicalNode,readPortalResources,resolveWowEndpoints,...readers};
const Host=new Function(...Object.keys(bindings),'return class { '+methods+' };')(...Object.values(bindings));
function host(getJson){const h=new Host();Object.assign(h,{base:'/api/a',wowRef:'7',world:{name:'a'},_wowResolved:{sentinel:'current'},_wowSceneSource:{sentinel:'current'},_transport:{getJson},_log(){}});return h;}
const calls=[];
const docs={
 '/api/a/wow/spatial/7':{id:7,rootNodeID:10,geoPose:{position:{lat:1,lon:2,h:3},angles:{yaw:0,pitch:0,roll:0}}},
 '/api/a/wow/spatial/7/node/10':{id:10,children:[{id:11,children:[]},12,'bad',13]},
 '/api/a/wow/spatial/7/node/12':{id:12,children:[10]},
 '/api/a/wow/spatial/7/node/NaN':{garbage:true},
};
const h=host(async url=>{calls.push(url);if(!(url in docs))throw new Error('missing '+url);return structuredClone(docs[url]);});
const graph=await h.initWow();assert.equal(graph.node_count,3);assert.equal(graph.graph.root,10);assert.deepEqual(Object.keys(graph.graph.nodes),['10','11','12']);
assert.equal(graph.canonical_walk.failed,2);assert.equal(graph.canonical_walk.fetched,1);assert.equal(h._wowResolved,graph);assert.ok(calls.includes('/api/a/wow/spatial/7/node/NaN'));
const anchorBad=await h._readGraphDocument('/api/a/wow/spatial/7',{id:7,rootNodeID:10,geoPose:{bad:true}});assert.equal(anchorBad.anchor,null);assert.ok(anchorBad.anchorError);
const bundled=host(async()=>({spatialID:'bundle',root:2,nodes:{2:{id:2,children:[]}},base_url:'./assets/'}));bundled.wowRef='./fixture.json';
const bundle=await bundled.initWow();assert.equal(bundle.graph_url,'./fixture.json');assert.equal(bundle.base_url,'./assets/');assert.equal(bundle.spatialID,'bundle');
const authored=await bundled._resolveWowSceneGraph({base:'/api/a',spatialId:'bundle',graphEndpoint:'/api/a/wow/graph',resolvedFrom:'authored advertisement'});assert.equal(authored.ok,true);assert.equal(bundled._wowResolved.authored_graph,true);
await bundled._resolveWowSceneGraph({base:'/api/a',spatialId:'bundle'});assert.equal(bundled._wowResolved.authored_graph,false);
const invalid=host(async()=>({bad:true}));await assert.rejects(invalid.initWow(),/neither a dev-bundle/);
const previous=invalid._wowResolved;const failed=await invalid._resolveWowSceneGraph({spatialId:'7'});assert.equal(failed.ok,false);assert.equal(invalid._wowResolved,previous);
assert.equal(refs.resolveFabricReference('/open',null),null);assert.equal(refs.resolveFabricReference('/open',42),null);assert.equal(refs.resolveFabricReference('/open','./child.json'),'./child.json');assert.equal(refs.resolveFabricReference('/open','/api/a/fabric.json'),'/open/api/a/fabric.json');
const endpoints=resolveWowEndpoints({services:[{name:'wow-user',endpoint:'/wow/user/{userId}',default_id:9,type:'web-of-worlds'},{name:'wow-portal',endpoint:'wow/portal/{portalId}',default_id:3},{name:'wow-view',endpoint:'/wrong',type:'foreign'}]},'/api/a');
assert.equal(endpoints.endpoints.user.path,'/api/a/wow/user/9');assert.equal(endpoints.endpoints.portal.path,'/api/a/wow/portal/3');assert.equal(endpoints.endpoints.view.path,'/api/a/wow/view/1');assert.equal(endpoints.provenance.view.source,'fallback_constant');
const portalCalls=[], skips=[];
const portalDocs={
 '/api/a/wow/portal/1':{id:1,node:'/wow/spatial/2/node/21',destination:'https://b.invalid/wow/world#join=node.1'},
 '/api/a/wow/portal/2':{id:2,node:'bad-ref'},
 '/api/a/wow/spatial/2':{rootNodeID:20},
 '/api/a/wow/spatial/2/node/20':{id:20,children:[{id:21,localTransform:[1,0,0,0,0,1,0,0,0,0,1,0,3,0,4,1]}]},
};
const portalHost=host(async url=>{portalCalls.push(url);if(!(url in portalDocs))throw new Error('unreadable portal');return portalDocs[url];});portalHost._log=s=>skips.push(s);
const portals=await portalHost._fetchWowPortals({}, {portals:{portal_count:3}});
assert.equal(portals.length,1);assert.equal(portals[0].id,1);assert.deepEqual(portals[0].osl_placement.position,[3,0,4]);assert.equal(skips.length,1);assert.ok(portalCalls.includes('/api/a/wow/portal/3'));
if(!baseline){
 const d=await load('web/live-adapter-world-discovery.mjs');
 assert.equal(d.resolveFabricReference(42),null);assert.equal(d.resolveFabricReference('./child.json'),'./child.json');
 assert.equal(d.authoredWowGraphEndpoint({webofworlds_extension:{authored_graph:{endpoint:'/wow/graph'}}},'/api/a/'),'/api/a/wow/graph');
 assert.equal(d.authoredWowGraphEndpoint({},'/api/a'),null);
 const attachment={Head:{Self:22},Name:'Portal',Type:{bSubtype:255},Transform:{Position:[3,0,4]}};
 const spawn={Name:'Avatar Spawn',Transform:{Position:[0,0,0]}};
 const action={Resource:{sReference:'action:enter'}};
 const fabric={data:{Children:[attachment,spawn,action]},primary:{camera:{position:[1,2,3],rotation:[0,0,0,1]}}};
 assert.equal(d.findFabricPortalAttachmentNode(fabric),attachment);assert.deepEqual(d.findFabricPortalAttachmentNodes(fabric),[attachment]);
 assert.equal(d.findFabricSpawnNode(fabric),spawn);assert.equal(d.findFabricActionTriggerNode(fabric),action);
 assert.equal(d.fabricNodeId(attachment),'22');assert.deepEqual(d.fabricNodePosition(attachment),[3,0,4]);
 assert.equal(d.fabricSummary('/fabric.json',fabric).node_count,3);assert.equal(d.yawFromQuaternionY([0,0,0,1]),0);
}
const deferred=()=>{let release;return {promise:new Promise(r=>release=r),resolve:v=>release(v)};};
const lateCases=[];
for(const name of ['initWow','_resolveWowSceneGraph','_ensureRootFabric','_resolveWowEndpoints']){
 const gate=deferred(), x=host(()=>gate.promise), prior=x._wowResolved;
 const promise=name==='_resolveWowSceneGraph'?x[name]({spatialId:'7'}):x[name]();
 x.base='/api/b';x.world={name:'b'};x.wowRef='8';x._wowResolved={sentinel:'b'};x._wowSceneSource={sentinel:'b'};
 gate.resolve(name.includes('Fabric')||name.includes('Endpoints')?{services:[{name:'wow-user',endpoint:'/wow/user/{userId}',default_id:9}]}:{spatialID:'old',root:1,nodes:{1:{id:1}}});
 await promise;
 const overwritten=name==='initWow'?x._wowResolved.sentinel!=='b':name==='_resolveWowSceneGraph'?x._wowSceneSource.sentinel!=='b':name==='_ensureRootFabric'?!!x._rootFabricManifest:!!x._wowEndpoints;
 assert.equal(overwritten,baseline,name+' stale adoption');lateCases.push({name,staleAdopted:overwritten});
}
if(!baseline){
 const one=deferred(),two=deferred();let count=0;const x=host(()=>count++?two.promise:one.promise);
 const old=x._resolveWowSceneGraph({spatialId:'old'}),now=x._resolveWowSceneGraph({spatialId:'new'});
 two.resolve({spatialID:'new',root:1,nodes:{1:{id:1}}});await now;one.resolve({spatialID:'old',root:1,nodes:{1:{id:1}}});await old;assert.equal(x._wowResolved.spatialID,'new');
 const d=deferred(),disposed=host(()=>d.promise);const pending=disposed.initWow();disposed._disposed=true;const prior=disposed._wowResolved;d.resolve({spatialID:'late',root:1,nodes:{1:{id:1}}});await pending;assert.equal(disposed._wowResolved,prior);
 const start=source.indexOf('      resolveClientGraph: '),end=source.indexOf('\n      readHostState:',start);
 assert.ok(start>=0&&end>start,'client graph resolver binding is present');
 const preview=new Function('readWorld','return ({'+source.slice(start,end)+'}).resolveClientGraph;').call(x,readers.readWorld);const snapshot=x._wowResolved,ref=x.wowRef;const p=await preview({graph_endpoint:'./preview.json'});assert.equal(p.spatialID,'new');assert.equal(x._wowResolved,snapshot);assert.equal(x.wowRef,ref);
}
console.log(JSON.stringify({kind:baseline?'baseline':'candidate',passed:true,canonical:{nodeCount:graph.node_count,walk:graph.canonical_walk,requests:calls},portalReads:{requests:portalCalls,skips,placed:portals[0].osl_placement},lateCases,controls:['integer spatial/node routes','embedded and flat children plus cycle','invalid child becomes NaN route and counted failure: retained baseline','invalid GeoPose','relative asset/document references','authored readiness','malformed graph preserves prior scene','invalid fabric refs','services and fallback provenance','actual portal reader: placed, invalid ref, unreadable resource',...(!baseline?['same-host newer read wins','disposed read cannot publish','preview read does not mutate host','fabric spawn/action/attachment/summary projections']:[])],networkRequests:0},null,2));
