// The loading record of a crossing carries what the destination world declared. It was built by a function that read a
// name it never declared, so no crossing could open its record or its toast.
//   node tools/behavior/fault-portal-loading.check.mjs [--faults] [--only id,id]
import { WORLDS } from "../../web/worlds-list.mjs";
import { nodeChecks } from "./node-checks.mjs";

const { check, finish } = nodeChecks("fault-portal-loading");

const CONSENT = "metaverse.portal.preloadContent";
const DECLARED = {
  pointers: {
    "metaverse.portal.loadingBranding": { value: { world_title: "Harbour", tagline: "Quiet water", location_id: "loc-harbour" } },
    "metaverse.portal.loadingInstructions": { value: { instructions: ["Look left", "Walk on"] } },
    "metaverse.portal.estimatedLoadTime": { value: { estimated_load_ms: 4200 } },
  },
  consent: { granted: true },
};
const crossingTo = (world) => ({ controls: { portal_transition_phase: "walking", portal_target_location_id: world.location_id } });

let loads = 0;

/** Starts one crossing in a freshly loaded module (its tracker is module state) and returns what the page shell was handed. */
async function cross({ cached = null, fetched = null } = {}) {
  const { initPortalLoadingOverlay, notePortalLoadingState } = await import(`../../web/portal-loading.mjs?crossing=${loads += 1}`);
  const published = [];
  const toasts = [];
  initPortalLoadingOverlay({
    isPlayer: true,
    adapter: { activeEndpointKey: WORLDS[0].key, previewEndpointKey: WORLDS[1].key, demoProxyBase: () => "" },
    readCachedLoadingContent: () => cached,
    fetchLoadingContent: fetched ? async () => fetched : null,
    showToast: (title, sub) => toasts.push({ title, sub }),
    publishNotification: (record) => published.push(record),
  });
  notePortalLoadingState(crossingTo(WORLDS[1]));
  return { published, toasts };
}

await check("record-carries-content", "A crossing opens its record with the destination's declared title, tagline, steps, wait and consent", async () => {
  const { published, toasts } = await cross({ cached: DECLARED });
  if (published.length !== 1) throw new Error(`the crossing published ${published.length} records, not 1`);
  const rec = published[0];
  if (rec.destination.world_title !== "Harbour" || rec.destination.tagline !== "Quiet water") throw new Error(`record names the destination ${rec.destination.world_title} / ${rec.destination.tagline}`);
  if (rec.destination.instructions.join("|") !== "Look left|Walk on") throw new Error(`record instructions are ${JSON.stringify(rec.destination.instructions)}`);
  if (rec.eta.destination_declared_ms !== 4200) throw new Error(`record wait is ${rec.eta.destination_declared_ms}`);
  if (rec.pointers.names_present.length !== 3) throw new Error(`record lists ${rec.pointers.names_present.length} pointers, not 3`);
  if (rec.pointers.consent_granted !== true || rec.pointers.consent_key !== CONSENT) throw new Error("record does not show the consent the destination gave");
  if (toasts.length !== 1 || !/Entering/.test(toasts[0].title)) throw new Error(`the crossing showed ${toasts.length} toasts`);
});

await check("record-without-content", "A destination that declared nothing still opens a record, with no pointers and no consent", async () => {
  const { published } = await cross();
  if (published.length !== 1) throw new Error(`the crossing published ${published.length} records, not 1`);
  const rec = published[0];
  if (rec.pointers.names_present.length !== 0 || rec.pointers.consent_granted !== false) throw new Error("a record claims pointers or consent nobody declared");
  if (rec.destination.world_title !== null) throw new Error(`record invents the title ${rec.destination.world_title}`);
});

await check("late-content-reaches-record", "Content fetched after the record opened is folded into that same record", async () => {
  const { published } = await cross({ fetched: DECLARED });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rec = published[0];
  if (!rec) throw new Error("the crossing published no record");
  if (rec.destination.world_title !== "Harbour" || rec.pointers.names_present.length !== 3 || !rec.pointers.consent_granted) throw new Error("the fetched content did not reach the record");
});

await finish({ checkFile: "tools/behavior/fault-portal-loading.check.mjs", faults: [
  { statement: "record-carries-content", name: "the record reads the destination content from a name its function never declared", expect: /crossing published 0 records/,
    edits: [{ file: "web/portal-loading.mjs", find: "function applyContentToRecord(rec) {\n  const c = tracker.capture && tracker.capture.content;\n", replace: "function applyContentToRecord(rec) {\n" }] },
] });
