function dom() {
  const elements=new Map(),attributes={};
  const lookup=id=>{if(!elements.has(id)) elements.set(id,{textContent:'',innerHTML:'',className:'',hidden:false,disabled:false,style:{},dataset:{},attrs:{},events:{},setAttribute(n,v){this.attrs[n]=String(v);},getAttribute(n){return this.attrs[n]??null;},addEventListener(n,f){this.events[n]=f;}});return elements.get(id);};
  return {lookup,body:{setAttribute(n,v){attributes[n]=String(v);},removeAttribute(n){delete attributes[n];}},reconcile(el,html){el.innerHTML=html;},snapshot(){return {attributes:{...attributes},elements:Object.fromEntries([...elements].map(([id,e])=>[id,{text:e.textContent,html:e.innerHTML,className:e.className,hidden:e.hidden,disabled:e.disabled,style:{...e.style},attributes:{...e.attrs}}]))};}};
}
export async function statusCases(make) {
  const outputs=[];
  for(const isPlayer of [true,false]) {
    const d=dom(),notices=[],toasts=[];
    const adapter={base:'http://fixture',active:{location_id:'a'},world:{title:'A & B'},state:{phase:'idle'},debugState:()=>({phase:'idle',location_id:'a'}),returnToLobby:async()=>({ok:true,from:{location_id:'a'},to:{location_id:'location-lobby'},no_page_reload:true})};
    const owner=make({dom:d,adapter,isPlayer,role:isPlayer?'player':'source',notices,toasts});
    const save=name=>outputs.push({name:(isPlayer?'player-':'observer-')+name,dom:d.snapshot(),connection:owner.snapshot(),notices:structuredClone(notices),toasts:structuredClone(toasts)});
    owner.setConnectionPresentation('loading','Connecting');save('loading');
    owner.setConnectionPresentation('live','Connected');save('orientation');owner.dismiss();
    for(const phase of ['portal_active','portal_active','departed','departed','arrived','arrived'])owner.renderOverlay(phase,{crossing:{controls_resume_ms:0},last_handoff_payload:{fabric_prefetch_proof:{used:false}}});save('phases-once');
    owner.renderEquipment(null,null);save('equipment-empty');
    owner.renderEquipment({validation:{ok:false,errors:['missing']},items:[{itemId:'held',fetch_ok:false,message:'not loaded',visible_fallback:false}]},{equippedItems:[{itemId:'held',attachmentPoint:'hand',mode:'hold'}]});save('equipment-failed');
    owner.setConnectionPresentation('disconnected','Offline','/state');owner.handleConnectionApiRequest({detail:{ok:true,path:'/other'}});save('unrelated-recovery');owner.handleConnectionApiRequest({detail:{ok:true,path:'/state'}});save('recovered');
    owner.setConnectionPresentation('refused','Policy',{kind:'policy',recovery:{kind:'reload',label:'Retry'}});save('refused');
    owner.setConnectionPresentation('unavailable','Child unavailable',{current:'live-world-projection',recovery:{kind:'return',label:'Continue',note:'Keep live',current:'live-world-projection'}});save('return-current');
    if(isPlayer)d.lookup('btn-connection-retry').events.click();save('continued');
    owner.syncReturnLobbyButton({location_id:'a'});await owner.handleReturnLobbyClick();save('return-lobby');
  }
  const notices=[],adapter={active:{location_id:'a',world_id:'world-a',endpoint_key:'a'}};
  const publisher=make.notifications(adapter,record=>notices.push(record));
  const fp={supported:true,status:'ready',portal_key:'edge',events:[{event:'region_ready',at:'now',region_entities:0,fabric_entities:2,occupancy_count:0}],address:{location_id:'b'},region:{age_ms:0,totals:{}},presence:{occupancy:{count:0}}};
  publisher.publishFabricPrefetchNotifications(fp);publisher.publishFabricPrefetchNotifications(fp);publisher.publishFabricPrefetchNotifications({...fp,portal_key:'other'});
  const completion={handoff_id:'h',status:'complete',location_id:'b',entities_added:0,started_at:'start',reconciliation:{received_unique_entities:0,expected_fabric_entities:0,match:true,duration_ms:0,input_during_completion:{movement_samples:0}}};
  publisher.publishFabricCompletionNotification(completion);publisher.publishFabricCompletionNotification(completion);publisher.publishFabricCompletionNotification({...completion,status:'running'});
  outputs.push({name:'notification-dedup',notices});return outputs;
}
