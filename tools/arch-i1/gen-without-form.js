'use strict';
/*
 * Generate the without-rotation-sentences form of the iteration 1 overlay from the current with-form patches.
 * Only the two rotation sentences change; every other line, hunk header and line count stays as it is.
 *
 * It also generates the without-form of the iteration 2 World patch: its hunk 1 removes and re-adds iteration 1's
 * Frames line, so only that removed and re-added line loses the axes sentence.
 *
 *   node gen-without-form.js [code root]
 *
 * Each replacement must match exactly once in the patch it names, or the script stops and writes nothing.
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.resolve(__dirname, '..', '..');
const from = path.join(root, 'wow-spec', 'overlays', 'iteration-1');
const to = path.join(from, 'without-rotation-sentences');

// The rotation order: "applied about the local axes z, y and x in that order" becomes "as OGC GeoPose 1.0 Basic-YPR defines them".
// The line break moves with it, so the patch keeps its line count.
const ORDER = ['in degrees, applied about the\n+        local axes z, y and x in that order.', 'in degrees, as OGC GeoPose 1.0 Basic-YPR\n+        defines them.'];
// The axes at zero angles: ": at zero angles +X is east, +Y up and +Z south" is taken out of the frame paragraph.
const AXES = ["A Spatial's GeoPose anchors its origin: at zero angles +X is east, +Y up and +Z south.", "A Spatial's GeoPose anchors its origin."];

// The same sentence in iteration 2's hunk 1, once on the removed Frames line and once on the re-added one.
const FRAMES = 'Frames. All coordinates MUST be in meters, right-handed, +Y up. ';
const AXES_REMOVED = ['-    ' + FRAMES + AXES[0], '-    ' + FRAMES + AXES[1]];
const AXES_ADDED = ['+    ' + FRAMES + AXES[0], '+    ' + FRAMES + AXES[1]];

const from2 = path.join(root, 'wow-spec', 'overlays', 'iteration-2');
const to2 = path.join(from2, 'without-rotation-sentences');

const PLAN = [
  [from, to, 'OpenSpatialWorld.API.yaml.patch', [ORDER, AXES]],
  [from, to, 'OpenSpatialAsset.API.yaml.patch', [ORDER]],
  [from2, to2, 'OpenSpatialWorld.API.yaml.patch', [AXES_REMOVED, AXES_ADDED]],
];

const out = [];
for (const [dir, target, file, swaps] of PLAN) {
  let text = fs.readFileSync(path.join(dir, file), 'utf8');
  const lines = text.split('\n').length;
  for (const [a, b] of swaps) {
    const count = text.split(a).length - 1;
    if (count !== 1) { process.stderr.write(file + ': "' + a.slice(0, 50) + '" matches ' + count + ' times, expected 1\n'); process.exit(1); }
    text = text.replace(a, () => b);
  }
  if (text.split('\n').length !== lines) { process.stderr.write(file + ': line count changed\n'); process.exit(1); }
  out.push([target, file, text]);
}
for (const [target, file, text] of out) {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, file), text);
  process.stdout.write('wrote ' + path.join(target, file) + '\n');
}
