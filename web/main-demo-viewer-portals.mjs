/*
 * Portals in the `?wow=` viewer: the shown world's portals, each showing what its destination allows to be seen, the
 * placement tool when the world offers it, and the arrival at `#join=node.{n}` when the page was opened by crossing a
 * portal, or at `#follow=user.{id}`, where the camera keeps to that user's node while the user moves (keepFollowing,
 * shared with the main page). The viewer is the lab's internal test tool; web/app.js holds only the call to this file.
 */

import { mountPortals, mountPlacementTool, applyJoinArrival, keepFollowing, playerUrlFor } from "./wow-portal-mount.mjs";
import { readPlacementPolicy } from "./wow-portal.mjs";

export function mountViewerPortals({ THREE, document: doc, built, hostUrl, buildWowScene, canvas, viewControls, onModels, visitorPosition, logLine, listen }) {
  let disposed=false, portalMount=null, placementMount=null, keep=null;
  const fetchWow = window.fetch.bind(window);
  void mountPortals({
    built, hostUrl, THREE, document: doc, buildWowScene,
    fetch: fetchWow,
    camera: built.camera,
    canvas,
    // A world's own address opens in this player; a player page opens as it is.
    navigate: (url) => {
      if(disposed)return;
      // Placement mode is not carried across: the destination opens as a visitor sees it.
      const pageUrl = new URL(location.href);
      pageUrl.searchParams.delete("place");
      void playerUrlFor(url, { pageUrl: pageUrl.href, hostUrl, fetch: fetchWow })
        .then((target) => {if(!disposed)window.location.assign(target);})
        .catch(() => {if(!disposed)window.location.assign(url);});
    },
    onModels,
    // The visitor a portal's active radius measures from: the avatar when there is one, else the camera.
    visitor: () => visitorPosition() || built.camera.position.toArray(),
    // After a placement the portals are read back from the world: what a click can land on changes too.
    onPickables: (list) => {if(!disposed)viewControls?.setPickables(list);},
    onUpdate: (portals) => {
      if(disposed)return;
      window.__wowPortals = Object.assign(window.__wowPortals || {}, { portals });
      doc.body.setAttribute("data-wow-portals", JSON.stringify(portals.map((p) => ({ id: p.id, preview: p.preview && p.preview.kind, refusal: p.refusal, awake: p.awake, active_radius_m: p.active_radius_m }))));
    },
  })
    .then((mounted) => {
      if(disposed){mounted.dispose();return;}
      portalMount=mounted;
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
        if(disposed)return;
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
            if(disposed)return;
            window.__wowPlacement = { offered: true, ...summary };
            doc.body.setAttribute("data-wow-placement", JSON.stringify(window.__wowPlacement));
          },
        });
        placementMount=placement;
        void placement.ready.then(() => {if(!disposed)doc.body.setAttribute("data-wow-placement-ready", "1");});
      });
    })
    .catch((e) => {
      if(disposed)return;
      doc.body.setAttribute("data-wow-portals-ready", "error");
      logLine(`wow portals ERROR: ${(e && e.message) || e}`);
    });
  const shown = (arrival) => {
    viewControls?.syncFromCamera();
    const camera = built.camera.position.toArray();
    window.__wowArrival = { ...arrival, camera };
    doc.body.setAttribute("data-wow-arrival", JSON.stringify({ arrived: arrival.arrived, node: arrival.node || null, position: arrival.position || null, camera, reason: arrival.reason || null }));
  };
  // While the fragment still follows that user, stand the camera at the user's node again whenever it moves.
  const keepCamera = (hash, first) => keepFollowing((last) => applyJoinArrival({ hostUrl, camera: built.camera, hash, fetch: fetchWow, from: last }), {
    first,
    stopped: () => disposed || location.hash !== hash,
    onMoved: (arrival) => { shown(arrival); logLine(`wow follow: at ${arrival.node}`); },
    onGone: (gone) => { shown(gone); logLine(`wow follow: stopped (${gone.reason})`); },
  });
  const arrive = () => {
    keep?.stop();
    keep = null;
    if (disposed) return Promise.resolve();
    const hash = location.hash;
    return applyJoinArrival({ hostUrl, camera: built.camera, hash, fetch: fetchWow })
    .then((arrival) => {
      if (disposed || !arrival) return;
      shown(arrival);
      logLine(arrival.arrived ? `wow arrival: at ${arrival.node}` : `wow arrival: ${arrival.reason}`);
      if (location.hash !== hash) return;
      if (arrival.arrived && arrival.follow != null) keep = keepCamera(hash, arrival);
    })
    .catch((e) => logLine(`wow arrival ERROR: ${(e && e.message) || e}`));
  };
  void arrive();
  // A fragment change is no page load: arriving again at a new `#join=` or `#follow=user.{id}` is up to this page.
  listen(window, "hashchange", () => { void arrive(); });
  return {dispose(){if(disposed)return;disposed=true;keep?.stop();placementMount?.dispose();portalMount?.dispose();}};
}
