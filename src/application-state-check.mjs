import assert from "node:assert/strict";
import { createApplicationState } from "../web/application-state.mjs";
import { chooseRendererAtBoot } from "../runtime/scene-core/public/render-adapter/render-adapter.mjs";
import { createRendererCapabilityPanel } from "../web/renderer-capability-panel.mjs";

for (const retire of ["dispose", "adapter", "avatar", "new-selection"]) {
  let publishes = 0, emits = 0, finish;
  let live = { state: { avatar: {} }, world: { id: "world" }, broadcastPlayerPose() { publishes++; }, _emit() { emits++; } };
  const state = createApplicationState({getAdapter:()=>live});
  assert.equal(state.snapshot().world,live.world,"one canonical world authority");
  const pending = state.selection().applyEquipment(["old"],()=>new Promise(resolve=>{finish=resolve;}));
  if (retire === "dispose") state.dispose();
  if (retire === "adapter") live = {...live,state:{avatar:{}}};
  if (retire === "avatar") live.state.avatar = {};
  if (retire === "new-selection") assert.equal((await state.selection().applyEquipment(["new"],async()=>"new-status")).ok,true);
  const before = {publishes,emits};
  finish("old-status");
  assert.equal((await pending).ok,false,retire);
  assert.deepEqual({publishes,emits},before,"retired selections cannot publish");
  if (retire === "new-selection") assert.equal(live.state.equipment_status,"new-status");
}

// Tiny DOM recorder exercises rendered wording, rather than checking source text.
class Element {
  constructor() { this.children=[]; this.textContent=""; this.listeners=new Map(); }
  append(...children) { this.children.push(...children); }
  prepend(child) { this.children.unshift(child); }
  replaceChildren() { this.children=[]; }
  setAttribute() {}
  addEventListener(name,fn) { this.listeners.set(name,fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  remove() { this.removed=true; }
  get text() { return this.textContent+this.children.map(child=>child.text).join(""); }
}
for (const name of ["three", "three.js", "threejs", "THREE.JS", "unknown-renderer"]) {
  const host = new Element();
  const document = {querySelector:()=>host,createElement:()=>new Element(),createTextNode:text=>({text})};
  const choice = chooseRendererAtBoot(`?renderer=${name}`);
  const panel = createRendererCapabilityPanel({document,rendererChoice:choice,readAdapter:()=>({getCapabilities:()=>({engine:"three",features:{}})}),readAvatar:()=>null,readRefresh:()=>null});
  assert.equal(host.text.includes("Fallback:"),name==="unknown-renderer",name);
  panel.dispose();
  assert.equal(host.children[0].removed,true);
  assert.equal(host.children[0].listeners.size,0);
}
console.log("application state: canonical projection, four stale-selection controls and five renderer alias cases passed");
