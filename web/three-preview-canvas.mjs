/** Three.js presentation of plain world/preview descriptions. */
import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";

export function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = trial;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  lines.forEach((entry, index) => ctx.fillText(entry, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

export function ensurePortalPreviewTexture(impl) {
  if (!impl || !impl.directionalPortalAperture) return null;
  if (!impl.portalPreviewCanvas) {
    impl.portalPreviewCanvas = document.createElement("canvas");
    impl.portalPreviewCanvas.width = 1024;
    impl.portalPreviewCanvas.height = 1024;
    impl.portalPreviewTexture = new THREE.CanvasTexture(impl.portalPreviewCanvas);
    if ("SRGBColorSpace" in THREE) impl.portalPreviewTexture.colorSpace = THREE.SRGBColorSpace;
    impl.portalPreviewTexture.minFilter = THREE.LinearFilter;
    impl.portalPreviewTexture.magFilter = THREE.LinearFilter;
    impl.portalPreviewMaterial = new THREE.MeshBasicMaterial({
      map: impl.portalPreviewTexture,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
    });
    impl.portalPreviewLabelCanvas = document.createElement("canvas");
    impl.portalPreviewLabelCanvas.width = 768;
    impl.portalPreviewLabelCanvas.height = 192;
    impl.portalPreviewLabelTexture = new THREE.CanvasTexture(impl.portalPreviewLabelCanvas);
    if ("SRGBColorSpace" in THREE) impl.portalPreviewLabelTexture.colorSpace = THREE.SRGBColorSpace;
    impl.portalPreviewLabelTexture.minFilter = THREE.LinearFilter;
    impl.portalPreviewLabelTexture.magFilter = THREE.LinearFilter;
    impl.portalPreviewLabelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: impl.portalPreviewLabelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    impl.portalPreviewLabelSprite.name = "portal-preview-readable-label";
    impl.portalPreviewLabelSprite.renderOrder = 50;
    impl.directionalPortalGroup.add(impl.portalPreviewLabelSprite);
  }
  return {
    canvas: impl.portalPreviewCanvas,
    texture: impl.portalPreviewTexture,
    material: impl.portalPreviewMaterial,
    aperture: impl.directionalPortalAperture,
    labelCanvas: impl.portalPreviewLabelCanvas,
    labelTexture: impl.portalPreviewLabelTexture,
    labelSprite: impl.portalPreviewLabelSprite,
  };
}

export function drawPortalPreviewLabel(canvas, preview) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const sourceType = preview && preview.source_type ? preview.source_type : "none";
  const targetLocation = preview && preview.location_id ? preview.location_id : "unknown-target";
  const targetPortal = preview && preview.target_portal_id ? preview.target_portal_id : "unknown-portal";
  const isLive = isLivePreviewSourceType(sourceType);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(8, 12, 26, 0.82)";
  ctx.strokeStyle = isLive ? "#46d18a" : "#ffcc55";
  ctx.lineWidth = 8;
  ctx.roundRect(8, 8, w - 16, h - 16, 28);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 42px ui-monospace, Menlo, monospace";
  ctx.fillText(
    sourceType === "child_fabric_live_render_texture"
      ? "CHILD FABRIC ATTACHED"
      : isLive
        ? "LIVE TARGET VIEW"
        : "LABELED TARGET FALLBACK",
    w / 2,
    68
  );
  ctx.font = "700 28px ui-monospace, Menlo, monospace";
  ctx.fillStyle = isLive ? "#46d18a" : "#ffcc55";
  ctx.fillText(sourceType, w / 2, 112);
  ctx.font = "24px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#dbe8ff";
  ctx.fillText(`${targetLocation} · ${targetPortal}`, w / 2, 150);
}

export function isLivePreviewSourceType(sourceType) {
  return sourceType === "live_target_render_texture" || sourceType === "child_fabric_live_render_texture";
}

export function drawPrefetchedRegionPreview(canvas, preview, fp) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const region = fp && fp.region ? fp.region : {};
  const totals = region.totals || {};
  const occupancy = fp && fp.presence ? fp.presence.occupancy : null;
  const targetLocation = preview && preview.location_id ? preview.location_id : "destination";
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#101a33");
  bg.addColorStop(1, "#1c1226");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = "center";
  ctx.fillStyle = "#8fd0ff";
  ctx.font = "700 44px ui-monospace, Menlo, monospace";
  ctx.fillText("PREFETCHED REGION", w / 2, 84);
  ctx.font = "26px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#dbe8ff";
  ctx.fillText(`${targetLocation} · labeled snapshot (not a live render)`, w / 2, 126);
  // mid-stream the totals are not committed yet — say
  // what is on screen honestly (accumulated chunk entities so far).
  const streaming = region.streaming && region.streaming.active ? region.streaming : null;
  const countLine =
    totals.region_entities != null
      ? `${totals.region_entities} of ${totals.fabric_entities} entities in portal neighborhood`
      : streaming
        ? `streaming: ${streaming.entity_count} entities · chunk ${streaming.chunks_loaded} (near ring first)`
        : "region payload pending";
  ctx.fillText(countLine, w / 2, 162);
  const occLine = occupancy
    ? `${(occupancy.avatars || []).length} known present · arrivals ${occupancy.arrival_count}`
    : "occupancy pending";
  ctx.fillStyle = "#ffd166";
  ctx.fillText(occLine, w / 2, 198);
  const age = region.age_ms != null ? `${Math.round(region.age_ms / 100) / 10}s old` : "";
  if (age) {
    ctx.fillStyle = "#9fb0d0";
    ctx.font = "22px ui-monospace, Menlo, monospace";
    ctx.fillText(`region ${age} · read-only before crossing`, w / 2, 230);
  }

  // Top-down mini-map of the 12x12 destination room around its anchor portal.
  const mapSize = Math.min(w, h) * 0.55;
  const mapX = (w - mapSize) / 2;
  const mapY = h * 0.30;
  const roomM = 12;
  const toMap = (pos) => [
    mapX + ((Number(pos && pos[0]) || 0) + roomM / 2) * (mapSize / roomM),
    mapY + ((Number(pos && pos[2]) || 0) + roomM / 2) * (mapSize / roomM),
  ];
  ctx.strokeStyle = "rgba(219,232,255,0.5)";
  ctx.lineWidth = 3;
  ctx.strokeRect(mapX, mapY, mapSize, mapSize);
  // region circle
  const regionInfo = region.region || {};
  if (Array.isArray(regionInfo.center)) {
    const [cx, cy] = toMap(regionInfo.center);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(70,209,138,0.7)";
    ctx.setLineDash([10, 8]);
    ctx.arc(cx, cy, (Number(regionInfo.radius_m) || 5) * (mapSize / roomM), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // destination anchor portal
  const portalPose = region.destination_portal || null;
  if (portalPose && Array.isArray(portalPose.trigger_position)) {
    const [px, py] = toMap(portalPose.trigger_position);
    ctx.beginPath();
    ctx.strokeStyle = "#ffbd69";
    ctx.lineWidth = 5;
    ctx.ellipse(px, py, 14, 22, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // destination spawn
  const spawn = region.destination_spawn || null;
  if (spawn && Array.isArray(spawn.position)) {
    const [sx, sy] = toMap(spawn.position);
    ctx.fillStyle = "#8fd0ff";
    ctx.fillRect(sx - 6, sy - 6, 12, 12);
  }
  // region entities at their true planar positions, in their own colors
  for (const entity of Array.isArray(region.entities) ? region.entities : []) {
    const [ex, ey] = toMap(entity.position);
    ctx.beginPath();
    ctx.fillStyle = entity.color || "#ffffff";
    ctx.arc(ex, ey, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "#9fb0d0";
  ctx.font = "20px ui-monospace, Menlo, monospace";
  ctx.fillText("local validation · roi_standard_conformance:false", w / 2, mapY + mapSize + 42);
}

export function drawLabeledPortalPreview(canvas, preview) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const sourceType = preview && preview.source_type ? preview.source_type : "none";
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#28345c");
  bg.addColorStop(0.5, "#151b31");
  bg.addColorStop(1, "#553318");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = "#d9f4ff";
  ctx.lineWidth = 3;
  for (let i = -5; i <= 5; i += 1) {
    const x = w / 2 + i * 72;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.32);
    ctx.lineTo(w / 2 + i * 125, h * 0.82);
    ctx.stroke();
  }
  for (let j = 0; j < 7; j += 1) {
    const y = h * 0.36 + j * 64;
    ctx.beginPath();
    ctx.moveTo(w * 0.18, y);
    ctx.lineTo(w * 0.82, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(w / 2, h * 0.50);
  ctx.strokeStyle = "#ffbd69";
  ctx.fillStyle = "rgba(255, 177, 77, 0.14)";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.ellipse(0, 0, 185, 310, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-125, 0);
  ctx.lineTo(125, 0);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = sourceType === "live_target_render_texture" ? "#46d18a" : "#ffcc55";
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.5, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
