/**
 * rgbe-decoder.mjs: a pure Radiance RGBE (.hdr) decoder for host environment resolvers.
 *
 * Input: the file's bytes (ArrayBuffer, a typed array or a DataView). Output: the environment contract shape
 * { kind: "equirect-linear-rgb", width, height, data: Float32Array } with rows from top (+Y) to bottom and three
 * linear radiance values per pixel. No DOM and no three.js: it runs the same in a page and in Node.
 *
 * Admitted: a "#?" signature line, optional FORMAT=32-bit_rle_rgbe (any other FORMAT is refused), the standard
 * "-Y height +X width" orientation, and scanlines that are flat (four bytes per pixel) or new-style run-length
 * encoded. Old-style run-length encoding, other orientations, truncated or overlong data are refused with an error
 * that says what was wrong. A pixel is mantissa * 2^(exponent - 136), the convention three.js's RGBELoader uses;
 * exponent 0 is black.
 */

const MAX_HEADER_BYTES = 65536;
const MAX_SIDE = 32767;
const MAX_PIXELS = 1 << 24;

function bytesOf(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("RGBE input must be an ArrayBuffer or a typed array");
}

/** One header line from `at`, without its newline; null when no newline comes within the header limit. */
function lineAt(bytes, at) {
  const end = Math.min(bytes.length, at + MAX_HEADER_BYTES);
  for (let i = at; i < end; i += 1) {
    if (bytes[i] === 0x0a) {
      let text = "";
      for (let k = at; k < i; k += 1) text += String.fromCharCode(bytes[k]);
      return { text, next: i + 1 };
    }
  }
  return null;
}

function readHeader(bytes) {
  const first = lineAt(bytes, 0);
  if (!first || !first.text.startsWith("#?")) throw new Error("RGBE header must start with a #? signature line (e.g. #?RADIANCE)");
  let at = first.next;
  for (;;) {
    if (at > MAX_HEADER_BYTES) throw new Error(`RGBE header is longer than ${MAX_HEADER_BYTES} bytes`);
    const line = lineAt(bytes, at);
    if (!line) throw new Error("RGBE header ends before the blank line that closes it");
    at = line.next;
    const text = line.text.trim();
    if (text === "") break;
    if (text.startsWith("FORMAT=") && text !== "FORMAT=32-bit_rle_rgbe")
      throw new Error(`RGBE format ${JSON.stringify(text.slice(7))} is not supported (only 32-bit_rle_rgbe)`);
  }
  const size = lineAt(bytes, at);
  if (!size) throw new Error("RGBE file ends before its resolution line");
  const match = /^-Y (\d+) \+X (\d+)$/.exec(size.text.trim());
  if (!match) throw new Error(`RGBE resolution line ${JSON.stringify(size.text.slice(0, 40))} is not the standard "-Y <height> +X <width>"`);
  const height = Number(match[1]), width = Number(match[2]);
  if (!(width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE) || width * height > MAX_PIXELS)
    throw new Error(`RGBE size ${width}x${height} is outside 1..${MAX_SIDE} per side and ${MAX_PIXELS} pixels`);
  return { width, height, at: size.next };
}

/** One new-style run-length encoded scanline into `row` (width * 4 bytes, channel planes interleaved back). */
function readRleScanline(bytes, at, width, row, y) {
  for (let channel = 0; channel < 4; channel += 1) {
    let x = 0;
    while (x < width) {
      if (at >= bytes.length) throw new Error(`RGBE data ends inside scanline ${y}`);
      let count = bytes[at++];
      if (count > 128) {
        count -= 128;
        if (x + count > width) throw new Error(`RGBE run of ${count} overruns scanline ${y} at x ${x}`);
        if (at >= bytes.length) throw new Error(`RGBE data ends inside scanline ${y}`);
        const value = bytes[at++];
        for (let k = 0; k < count; k += 1) row[(x++) * 4 + channel] = value;
      } else {
        if (count === 0) throw new Error(`RGBE scanline ${y} holds a zero-length run`);
        if (x + count > width) throw new Error(`RGBE literal of ${count} overruns scanline ${y} at x ${x}`);
        if (at + count > bytes.length) throw new Error(`RGBE data ends inside scanline ${y}`);
        for (let k = 0; k < count; k += 1) row[(x++) * 4 + channel] = bytes[at++];
      }
    }
  }
  return at;
}

/** Decodes Radiance RGBE bytes to { kind: "equirect-linear-rgb", width, height, data } (rows top to bottom). */
export function decodeRgbe(input) {
  const bytes = bytesOf(input);
  const { width, height, at: start } = readHeader(bytes);
  const data = new Float32Array(width * height * 3);
  const row = new Uint8Array(width * 4);
  let at = start;
  for (let y = 0; y < height; y += 1) {
    if (at + 4 > bytes.length) throw new Error(`RGBE data ends before scanline ${y} of ${height}`);
    const rle = width >= 8 && width <= MAX_SIDE && bytes[at] === 2 && bytes[at + 1] === 2 && (bytes[at + 2] & 0x80) === 0;
    if (rle) {
      const encoded = (bytes[at + 2] << 8) | bytes[at + 3];
      if (encoded !== width) throw new Error(`RGBE scanline ${y} says width ${encoded}, the header says ${width}`);
      at = readRleScanline(bytes, at + 4, width, row, y);
    } else {
      if (at + width * 4 > bytes.length) throw new Error(`RGBE data ends inside flat scanline ${y}`);
      for (let x = 0; x < width; x += 1) {
        const p = at + x * 4;
        if (bytes[p] === 1 && bytes[p + 1] === 1 && bytes[p + 2] === 1)
          throw new Error(`RGBE scanline ${y} uses old-style run-length encoding, which is not supported`);
      }
      row.set(bytes.subarray(at, at + width * 4));
      at += width * 4;
    }
    for (let x = 0; x < width; x += 1) {
      const e = row[x * 4 + 3], out = (y * width + x) * 3;
      if (e === 0) { data[out] = 0; data[out + 1] = 0; data[out + 2] = 0; continue; }
      const scale = 2 ** (e - 136);
      data[out] = row[x * 4] * scale; data[out + 1] = row[x * 4 + 1] * scale; data[out + 2] = row[x * 4 + 2] * scale;
    }
  }
  if (at !== bytes.length) throw new Error(`RGBE file has ${bytes.length - at} unexpected bytes after the last scanline`);
  return { kind: "equirect-linear-rgb", width, height, data };
}
