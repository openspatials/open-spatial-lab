/*
 * A label drawn on a canvas in the page: rows of text on a panel with a border. A canvas needs no font file and no
 * 'unsafe-eval' (X3D Text under X_ITE does), so the same label shows under three.js, X3DOM and X_ITE.
 */

/**
 * The first line large, the others smaller. A line shrinks to fit the width down to a floor, then wraps at spaces.
 * Returns the canvas, or null where there is no document to draw in.
 */
export function drawLabelCanvas(doc, lines, style, { width = 1024 } = {}) {
  if (!doc || typeof doc.createElement !== "function") return null;
  const PAD = 28;
  const measure = doc.createElement("canvas").getContext("2d");
  if (!measure) return null;
  const font = (size) => `bold ${size}px ui-monospace, Menlo, monospace`;
  const rows = [];
  lines.forEach((line, i) => {
    let size = i === 0 ? 76 : 48;
    const min = i === 0 ? 52 : 40;
    measure.font = font(size);
    while (measure.measureText(line).width > width - 2 * PAD && size > min) {
      size -= 2;
      measure.font = font(size);
    }
    let row = "";
    for (const word of String(line).split(" ")) {
      const next = row ? `${row} ${word}` : word;
      if (row && measure.measureText(next).width > width - 2 * PAD) { rows.push({ text: row, size }); row = word; }
      else row = next;
    }
    rows.push({ text: row, size });
  });
  const height = PAD * 2 + rows.reduce((sum, r) => sum + r.size * 1.3, 0);
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = style.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let y = PAD;
  for (const r of rows) {
    ctx.font = font(r.size);
    ctx.fillText(r.text, width / 2, y + (r.size * 1.3) / 2);
    y += r.size * 1.3;
  }
  return canvas;
}
