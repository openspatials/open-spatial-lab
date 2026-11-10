// Writes web/x3d-worlds/environments/sky-gradient.hdr: a small deterministic equirectangular sky gradient in Radiance
// RGBE, the one environment the own-X3D document route admits (x3dEnvironment=sky-gradient.hdr). No download, no
// licence: every byte comes from this script.
//   node tools/x3d/make-sky-gradient-hdr.mjs           write the file, print its size and SHA256, then self-test
//   node tools/x3d/make-sky-gradient-hdr.mjs --check   self-test only (the file must exist and equal a fresh build)
//
// Image: 64x32, rows top (+Y) to bottom. Rows 0-15 are sky, from the zenith [1, 1.5, 2] down to the horizon
// [0.375, 0.4375, 0.5]; rows 16-31 are ground [0.125, 0.09375, 0.0625]. Those three colours are exact in RGBE; the
// rows between zenith and horizon are within one mantissa step. Scanlines are new-style run-length encoded.
//
// The self-test decodes the written file with runtime/scene-core/public/x3d/rgbe-decoder.mjs and compares known
// pixels, decodes a flat-scanline and a literal-run encoding of other pixels, and expects malformed input refused.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeRgbe } from "../../runtime/scene-core/public/x3d/rgbe-decoder.mjs";

const CODE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKY_GRADIENT_PATH = join(CODE, "web", "x3d-worlds", "environments", "sky-gradient.hdr");
export const WIDTH = 64, HEIGHT = 32;
export const ZENITH = [1, 1.5, 2], HORIZON = [0.375, 0.4375, 0.5], GROUND = [0.125, 0.09375, 0.0625];

/** Linear radiance of pixel (x, y), rows from the top. */
export function skyGradientPixel(_x, y) {
  if (y >= HEIGHT / 2) return GROUND;
  const t = y / (HEIGHT / 2 - 1);
  return ZENITH.map((z, i) => z + (HORIZON[i] - z) * t);
}

function rgbe([r, g, b]) {
  const v = Math.max(r, g, b);
  if (!(v > 1e-32)) return [0, 0, 0, 0];
  let e = Math.floor(Math.log2(v)) + 1, m = v / 2 ** e;
  if (m >= 1) { m /= 2; e += 1; } else if (m < 0.5) { m *= 2; e -= 1; }
  const scale = (m * 256) / v;
  return [Math.floor(r * scale), Math.floor(g * scale), Math.floor(b * scale), e + 128];
}

/** New-style RLE of one channel plane: runs of 4 or more as 128+n, the rest as literal dumps of up to 128. */
function rlePlane(plane) {
  const out = [];
  let i = 0;
  while (i < plane.length) {
    let runStart = i, runLen = 0;
    while (runStart < plane.length) {
      runLen = 1;
      while (runStart + runLen < plane.length && runLen < 127 && plane[runStart + runLen] === plane[runStart]) runLen += 1;
      if (runLen >= 4) break;
      runStart += runLen;
    }
    const found = runStart < plane.length;
    const literalEnd = found ? runStart : plane.length;
    while (i < literalEnd) { const n = Math.min(128, literalEnd - i); out.push(n, ...plane.slice(i, i + n)); i += n; }
    if (found) { out.push(128 + runLen, plane[runStart]); i = runStart + runLen; }
  }
  return out;
}

/** An RGBE file for width x height pixels from pixel(x, y); `flat` writes four bytes per pixel instead of RLE. */
export function encodeRgbe(width, height, pixel, { flat = false } = {}) {
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, "ascii")];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) row.push(rgbe(pixel(x, y)));
    if (flat) { parts.push(Buffer.from(row.flat())); continue; }
    const line = [2, 2, width >> 8, width & 255];
    for (let c = 0; c < 4; c += 1) line.push(...rlePlane(row.map((p) => p[c])));
    parts.push(Buffer.from(line));
  }
  return Buffer.concat(parts);
}

export const buildSkyGradient = () => encodeRgbe(WIDTH, HEIGHT, skyGradientPixel);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Throws on the first wrong result; returns one line per part that passed. */
export function selfTest(file = SKY_GRADIENT_PATH) {
  const lines = [];
  const bytes = readFileSync(file);
  const fresh = buildSkyGradient();
  if (!fresh.equals(bytes)) throw new Error(`${file} differs from a fresh build (${bytes.length} vs ${fresh.length} bytes)`);
  const image = decodeRgbe(bytes);
  if (image.kind !== "equirect-linear-rgb" || image.width !== WIDTH || image.height !== HEIGHT || !(image.data instanceof Float32Array) || image.data.length !== WIDTH * HEIGHT * 3)
    throw new Error(`decoded ${image.kind} ${image.width}x${image.height} with ${image.data?.length} values, not equirect-linear-rgb ${WIDTH}x${HEIGHT}`);
  const at = (x, y) => Array.from(image.data.subarray((y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3));
  for (const [x, y, want] of [[0, 0, ZENITH], [63, 0, ZENITH], [17, 15, HORIZON], [0, 16, GROUND], [40, 31, GROUND]]) {
    const got = at(x, y);
    if (got.some((v, i) => v !== want[i])) throw new Error(`pixel (${x}, ${y}) decoded ${got}, not exactly ${want}`);
  }
  for (const y of [3, 7, 11]) {
    const got = at(5, y), want = skyGradientPixel(5, y), step = Math.max(...want) / 128;
    if (got.some((v, i) => Math.abs(v - want[i]) > step)) throw new Error(`pixel (5, ${y}) decoded ${got}, not within ${step} of ${want}`);
  }
  if (!(at(0, 0)[2] > at(0, 15)[2] && at(0, 15)[2] > at(0, 31)[2])) throw new Error("the decoded gradient is not brightest at the top row");
  lines.push(`file ${bytes.length} bytes equals a fresh build; decoded ${image.width}x${image.height}; exact zenith, horizon and ground pixels; rows 3, 7, 11 within one mantissa step; top brighter than horizon brighter than ground`);
  // Flat scanlines and literal runs: a varying image that the RLE writer must dump as literals.
  const varying = (x, y) => [((x * 7 + y * 3) % 13 + 1) / 8, ((x * 5 + y) % 11 + 1) / 16, ((x + y * 9) % 7 + 1) / 4];
  const flat = decodeRgbe(encodeRgbe(12, 3, varying, { flat: true }));
  const rle = decodeRgbe(encodeRgbe(12, 3, varying));
  if (flat.width !== 12 || flat.height !== 3) throw new Error(`flat image decoded as ${flat.width}x${flat.height}`);
  for (let i = 0; i < flat.data.length; i += 1) if (flat.data[i] !== rle.data[i]) throw new Error(`flat and RLE decodes differ at value ${i}: ${flat.data[i]} vs ${rle.data[i]}`);
  const p = varying(4, 2), q = Array.from(flat.data.subarray((2 * 12 + 4) * 3, (2 * 12 + 4) * 3 + 3)), s = Math.max(...p) / 128;
  if (q.some((v, i) => Math.abs(v - p[i]) > s)) throw new Error(`flat pixel (4, 2) decoded ${q}, not within ${s} of ${p}`);
  lines.push("a 12x3 varying image decodes the same from flat and literal-run RLE scanlines, within one mantissa step");
  // Malformed input.
  const text = (s) => Buffer.from(s, "ascii");
  const header = (w, h) => text(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
  const cases = [
    ["no signature", text("RADIANCE\n\n-Y 1 +X 1\n\x80\x80\x80\x81"), /#\? signature/],
    ["other format", text("#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n\x80\x80\x80\x81"), /not supported/],
    ["unclosed header", text("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n"), /blank line/],
    ["other orientation", text("#?RADIANCE\n\n+Y 1 +X 1\n\x80\x80\x80\x81"), /resolution line/],
    ["zero size", text("#?RADIANCE\n\n-Y 0 +X 4\n"), /outside/],
    ["truncated flat", Buffer.concat([header(4, 2), Buffer.alloc(20, 0x40)]), /ends inside flat scanline 1/],
    ["truncated RLE", fresh.subarray(0, fresh.length - 3), /ends inside scanline 31/],
    ["trailing bytes", Buffer.concat([fresh, Buffer.from([0])]), /unexpected bytes/],
    ["RLE width mismatch", Buffer.concat([header(8, 1), Buffer.from([2, 2, 0, 9])]), /says width 9/],
    ["RLE overrun", Buffer.concat([header(8, 1), Buffer.from([2, 2, 0, 8, 128 + 9, 1])]), /overruns scanline 0/],
    ["RLE zero count", Buffer.concat([header(8, 1), Buffer.from([2, 2, 0, 8, 0])]), /zero-length run/],
    ["old-style RLE", Buffer.concat([header(2, 1), Buffer.from([64, 64, 64, 129, 1, 1, 1, 1])]), /old-style/],
    ["not bytes", "#?RADIANCE", /ArrayBuffer or a typed array/],
  ];
  for (const [name, input, message] of cases) {
    let error = null;
    try { decodeRgbe(input); } catch (caught) { error = caught; }
    if (!error) throw new Error(`malformed input "${name}" was accepted`);
    if (!message.test(error.message)) throw new Error(`malformed input "${name}" was refused for another reason: ${error.message}`);
  }
  lines.push(`${cases.length} malformed inputs refused, each with its own message`);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--check")) {
    const bytes = buildSkyGradient();
    mkdirSync(dirname(SKY_GRADIENT_PATH), { recursive: true });
    writeFileSync(SKY_GRADIENT_PATH, bytes);
    console.log(`wrote ${SKY_GRADIENT_PATH}: ${bytes.length} bytes, sha256 ${sha256(bytes)}`);
  } else {
    const bytes = readFileSync(SKY_GRADIENT_PATH);
    console.log(`${SKY_GRADIENT_PATH}: ${bytes.length} bytes, sha256 ${sha256(bytes)}`);
  }
  for (const line of selfTest()) console.log(`PASS  ${line}`);
}
