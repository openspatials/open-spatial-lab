/*
 * Portals in the `?wow=` viewer: the shown world's portals, each showing what its destination allows to be seen, the
 * placement tool when the world offers it, and the arrival at `#join=node.{n}` when the page was opened by crossing a
 * portal. The viewer is the lab's internal test tool; web/app.js holds only the call to this file.
 */

import { mountPortals, mountPlacementTool, applyJoinArrival, playerUrlFor } from "./wow-portal-mount.mjs";
import { readPlacementPolicy } from "./wow-portal.mjs";

export function mountViewerPortals({ THREE, document: doc, built, hostUrl, buildWowScene, canvas, viewControls, onModels, visitorPosition, logLine, listen }) {
  const fetchWow = window.fetch.bind(window);
  void mountPortals({
    built, hostUrl, THREE, document: doc, buildWowScene,
    fetch: fetchWow,
    camera: built.camera,
    canvas,
    // A world's own address opens in this player; a player page opens as it is.
    navigate: (url) => {
      // Placement mode is not carried across: the destination opens as a visitor sees it.
      const pageUrl = new URL(location.href);
      pageUrl.searchParams.delete("place");
      void playerUrlFor(url, { pageUrl: pageUrl.href, hostUrl, fetch: fetchWow })
        .then((target) => window.location.assign(target))
        .catch(() => window.location.assign(url));
    },
    onModels,
    // The visitor a portal's active radius measures from: the avatar when there is one, else the camera.
    visitor: () => visitorPosition() || built.camera.position.toArray(),
    // After a placement the portals are read back from the world: what a click can land on changes too.
    onPickables: (list) => viewControls?.setPickables(list),
    onUpdate: (portals) => {
      window.__wowPortals = Object.assign(window.__wowPortals || {}, { portals });
      doc.body.setAttribute("data-wow-portals", JSON.stringify(portals.map((p) => ({ id: p.id, preview: p.preview && p.preview.kind, refusal: p.refusal, awake: p.awake, active_radius_m: p.active_radius_m }))));
    },
  })
    .then((mounted) => {
      window.__wowPortals = Object.assign(window.__wowPortals || {}, { portals: mounted.summary(), cross: mounted.cross, summary: mounted.summary, screenPoint: mounted.screenPoint });
      viewControls?.setPickables(mounted.pickables());
      doc.body.setAttribute("data-wow-portals-ready", "1");
      logLine(`wow portals: ${mounted.portals.length} shown (${mounted.portals.map((p) => `${p.id}:${p.preview && p.preview.kind}`).join(", ")})`);
      // The placement tool: a panel on the scene; `&place=1` opens the page in placement mode.
      // Only a world served from 127.0.0.1 offers placement (the local-only switch): the world says so at
      // GET {base}placement. Otherwise the panel is not shown at all, `&place=1` is ignored, and the placed
      // portals are shown read-only.
      if (!viewControls || !canvas) return;
      void readPlacementPolicy(mounted.base, { fetch: fetchWow }).then((policy) => {
        if (!policy.allowed) {
          window.__wowPlacement = { offered: false, on: false, reason: policy.reason };
          doc.body.setAttribute("data-wow-placement", JSON.stringify(window.__wowPlacement));
          doc.body.setAttribute("data-wow-placement-ready", "unavailable");
          logLine(`wow placement: off (${policy.reason})`);
          return;
        }
        const placement = mountPlacementTool({
          THREE, document: doc, mounted, viewControls, camera: built.camera, canvas, fetch: fetchWow,
          worldsUrl: new URL("worlds.json", location.href).href,
          startOn: new URLSearchParams(location.search).get("place") === "1",
          onChange: (summary) => {
            window.__wowPlacement = { offered: true, ...summary };
            doc.body.setAttribute("data-wow-placement", JSON.stringify(window.__wowPlacement));
          },
        });
        void placement.ready.then(() => doc.body.setAttribute("data-wow-placement-ready", "1"));
      });
    })
    .catch((e) => {
      doc.body.setAttribute("data-wow-portals-ready", "error");
      logLine(`wow portals ERROR: ${(e && e.message) || e}`);
    });
  const arrive = () => applyJoinArrival({ hostUrl, camera: built.camera, hash: location.hash, fetch: fetchWow })
    .then((arrival) => {
      if (!arrival) return;
      viewControls?.syncFromCamera();
      const camera = built.camera.position.toArray();
      window.__wowArrival = { ...arrival, camera };
      doc.body.setAttribute("data-wow-arrival", JSON.stringify({ arrived: arrival.arrived, node: arrival.node || null, position: arrival.position || null, camera, reason: arrival.reason || null }));
      logLine(arrival.arrived ? `wow arrival: at ${arrival.node}` : `wow arrival: ${arrival.reason}`);
    })
    .catch((e) => logLine(`wow arrival ERROR: ${(e && e.message) || e}`));
  void arrive();
  // A fragment change is no page load: arriving again at a new `#join=` is up to this page.
  listen(window, "hashchange", () => { void arrive(); });
}
