/*
 * The main demo's standard-portal behaviour that is not drawing: what a refused crossing says, what each ring says
 * about its portal, keeping a present visitor's portals up to date, the arrival at `#join=node.{n}` when a page opens,
 * and the placement tool for the world the visitor is in. web/app.js holds only the wiring to this file.
 *
 * Everything from app.js comes through `deps`, read late, because a crossing swaps what they return.
 */

import { applyPortalRingState } from "./main-demo-preview.mjs";
import { mountMainDemoPlacement } from "./main-demo-placement.mjs";
import { destinationOf, refusalSentence } from "./main-demo-portals.mjs";
import { portalLabel } from "./wow-portal-mount.mjs";

// How long a portal whose destination was offline waits before it looks again.
const PREVIEW_RETRY_MS = 5000;
const PORTAL_WATCH_MS = 3000;

function nameOfDestination(portal) {
  const destination = destinationOf(portal && portal.destination);
  return destination ? (destination.world ? destination.world.name : destination.base) : null;
}

export function createMainDemoWiring(deps) {
  const {
    THREE, document: doc, getAdapter, getScene, getSceneRuntime, redrawPortals, logLine, publishNotification, showToast,
    isDeparted, isDisposed, isPlayer, wantsPlacement, keyOf, getMount, worldsUrl, setCameraAzimuth,
  } = deps;
  const refusals = [];
  const previewRetryAt = new Map();
  let selectedPortalId = null;
  let watching = false;
  let placement = null;

  /** A portal's ring says what its destination allows: offline and no destination change its colour and carry a label. */
  function syncPortalRing(portalKey, entry, surface) {
    const scene = getScene();
    const impl = scene && scene._impl;
    const adapter = getAdapter();
    if (!impl || !entry.wow_resource) return;
    const primary = adapter && adapter.world && adapter.world.portal === entry;
    const group = primary ? impl.directionalPortalGroup : impl.additionalPortalGroups?.[portalKey]?.group;
    if (!group) return;
    const ring = primary ? group.getObjectByName("standing-oval-ring") : group.getObjectByName(`standing-oval-ring--${portalKey}`);
    const sceneRuntime = getSceneRuntime();
    const preview = sceneRuntime.portalPreviewStates()[portalKey] || {};
    const state = surface.asleep ? "asleep" : preview.kind || null;
    applyPortalRingState({
      THREE, document: doc, group, ring, entry, state,
      selected: selectedPortalId != null && Number(entry.portal_id) === Number(selectedPortalId),
      destinationName: nameOfDestination(entry),
      makeLabel: portalLabel,
    });
    if (preview.kind === "unreachable") {
      const now = performance.now();
      const at = previewRetryAt.get(portalKey);
      if (at === undefined) previewRetryAt.set(portalKey, now + PREVIEW_RETRY_MS);
      else if (now >= at) {
        previewRetryAt.delete(portalKey);
        sceneRuntime.forgetPortalPreview(entry);
      }
    } else {
      previewRetryAt.delete(portalKey);
    }
  }

  /** A refused crossing: the visitor stays, and the main demo's own notification says why. */
  function handlePortalRefused(refusal) {
    const sentence = refusalSentence(refusal, nameOfDestination(refusal.portal));
    const record = { at: new Date().toISOString(), kind: refusal.kind, reason: refusal.reason, sentence, portal: refusal.portal ? refusal.portal.portal_id : null };
    refusals.push(record);
    doc.body.setAttribute("data-portal-refusal", JSON.stringify(record));
    logLine(`crossing refused: ${refusal.reason}`);
    const notificationId = `portal-refused-${refusals.length}`;
    publishNotification({ id: notificationId, kind: "portal_refused", status: "refused", title: "Crossing refused", summary: sentence, created_at: record.at });
    showToast("Crossing refused", sentence, "failed", { notificationId });
    // Its window may still show what it read earlier: look again, so the ring says what is true now.
    if (refusal.kind === "offline" && refusal.portal) getSceneRuntime().forgetPortalPreview(refusal.portal);
  }

  /** Read the shown world's portals again, and draw the difference now: nothing else may happen until the visitor moves. */
  async function refreshPortals() {
    await getAdapter().refreshWorldPortals();
    redrawPortals();
  }

  /**
   * A portal placed, moved or sent elsewhere by anyone reaches every visitor already here: the world's portals, read
   * again, say when to draw them again (web/live-adapter.js, portalsChanged).
   */
  function startPortalWatch() {
    if (watching) return;
    watching = true;
    const look = async () => {
      try {
        const adapter = getAdapter();
        if (adapter && !isDeparted(adapter) && await adapter.portalsChanged()) {
          await refreshPortals();
          logLine("a portal changed in this world: the portals were read again");
        }
      } catch { /* the next look tries again */ }
      if (!isDisposed()) window.setTimeout(look, PORTAL_WATCH_MS);
    };
    window.setTimeout(look, PORTAL_WATCH_MS);
  }

  /** `&place=1`: the placement tool for the world the visitor is in. */
  async function mountPlacementForActiveWorld() {
    const adapter = getAdapter();
    if (!isPlayer || !wantsPlacement || !adapter) return;
    if (placement && placement.dispose) placement.dispose();
    const publish = (summary) => {
      window.__wowPlacement = summary;
      doc.body.setAttribute("data-wow-placement", JSON.stringify(summary));
    };
    placement = await mountMainDemoPlacement({
      THREE,
      document: doc,
      getImpl: () => { const scene = getScene(); return scene && scene._impl; },
      getWorld: () => adapter.world,
      keyOf,
      address: `${adapter.endpoint.backend_base_url}/`,
      mount: getMount(),
      worldsUrl,
      fetch: window.fetch.bind(window),
      refresh: refreshPortals,
      onChange: (summary) => publish({ offered: true, ...summary }),
      setSelected: (id) => { selectedPortalId = id; },
      startOn: true,
      say: (reason) => {
        publish({ offered: false, on: false, reason });
        doc.body.setAttribute("data-wow-placement-ready", "unavailable");
        showToast("Placement is off", reason, "failed");
        logLine(`placement: off (${reason})`);
      },
    });
    if (placement.offered) void placement.ready.then(() => doc.body.setAttribute("data-wow-placement-ready", "1"));
  }

  /** A page opened at `#join=node.{n}` (a portal crossed by plain navigation) stands at that node, facing its way. */
  async function arriveAtJoin(aspectId) {
    const joinNode = /^node[./](\d+)$/.exec(String(aspectId || ""));
    if (!joinNode) return;
    const arrival = await getAdapter().applyJoinArrival(Number(joinNode[1]));
    doc.body.setAttribute("data-main-join-arrival", JSON.stringify({ arrived: arrival.arrived, node: arrival.node || null, reason: arrival.reason || null }));
    if (arrival.arrived) {
      setCameraAzimuth(arrival.yaw - Math.PI);
      logLine(`arrival: at ${arrival.node} (#join)`);
    } else {
      showToast("No such arrival", arrival.reason, "failed");
    }
  }

  return { syncPortalRing, handlePortalRefused, startPortalWatch, mountPlacementForActiveWorld, arriveAtJoin, refusals: () => refusals.slice() };
}
