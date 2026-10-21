'use strict';

/*
 * Iteration 1, frames and GeoPose: checks F1, F2, F3, F3b, F4 and F5.
 *
 * Each compares the runtime module (web/wow-geopose.js) with a plain double-precision reference
 * written in another language (tools/arch-i1/reference-*.py), then runs the same check against
 * mutants that break the thing it claims to measure.
 */

const fs = require('fs');
const path = require('path');
const { ROOT, run, loadMutant, python, mulberry32 } = require('./lib');

const RAD = Math.PI / 180;
const ZERO = { yaw: 0, pitch: 0, roll: 0 };
const G1 = { position: { lat: 47.7, lon: -122.3, h: 11.5 }, angles: ZERO };
const G2_POINT = { lat: 47.7, lon: -122.2986676811, h: 11.5 };
const dms = (d, m, s) => d + m / 60 + s / 3600;
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const MODULE = 'web/wow-geopose.js';

function readReference() {
  const out = python('reference-geodesy.py');
  const num = (text) => Number(text);
  const f1 = out.match(/F1\s+east (\S+)\s+north (\S+)\s+up (\S+)/);
  const f2 = out.match(/F2\s+x (\S+) m\s+y (\S+) mm\s+z (\S+) mm/);
  const f5 = out.match(/F5\s+200 seeds: per-axis max (\S+) mm; 3-D max (\S+) mm; median range (\S+)-(\S+) m; smallest max (\S+) m/);
  if (!f1 || !f2 || !f5) throw new Error('reference-geodesy.py output not recognised');
  return {
    f1: { east: num(f1[1]), north: num(f1[2]), up: num(f1[3]) },
    f2: { x: num(f2[1]), y: num(f2[2]) / 1000, z: num(f2[3]) / 1000 },
    f5: { axisMm: num(f5[1]), threeDMm: num(f5[2]), medianLow: num(f5[3]), medianHigh: num(f5[4]), smallestMax: num(f5[5]) },
  };
}

function readOrientationReference() {
  const rows = {};
  for (const row of python('reference-orientation.py').trim().split('\n')) {
    const parts = row.split(' ');
    rows[parts[1]] = parts.slice(2).map(Number);
  }
  return rows;
}

async function frameChecks() {
  const real = require(path.join(ROOT, MODULE));
  const reference = readReference();
  const orientation = readOrientationReference();

  // ---- F1. The outside check: IOGP Guidance Note 7-2, EPSG method 9837 ----------------------
  const iogp = {
    origin: { position: { lat: 55, lon: 5, h: 200 }, angles: ZERO },
    point: { lat: dms(53, 48, 33.82), lon: dms(2, 7, 46.38), h: 73 },
    expected: { east: -189013.869, north: -128642.040, up: -4220.171 },
  };
  const sphere = loadMutant(MODULE, [
    ['a: 6378137.0,', 'a: 6371008.8,'],
    ['e2: (1 / 298.257223563) * (2 - 1 / 298.257223563),', 'e2: 0,'],
  ]);
  await run('F1', 'EPSG 9837 worked example (IOGP 7-2) reproduced to 1 mm, and equal to the Python reference', (impl) => {
    const [x, y, z] = impl.geographicToLocal(iogp.origin, iogp.point);
    const got = { east: x, north: -z, up: y };
    const worst = Math.max(...['east', 'north', 'up'].map((k) => Math.abs(got[k] - iogp.expected[k])));
    const fromPython = Math.max(...['east', 'north', 'up'].map((k) => Math.abs(got[k] - reference.f1[k])));
    return {
      ok: worst <= 0.001 && fromPython <= 0.0006,
      detail: `east ${got.east.toFixed(3)} north ${got.north.toFixed(3)} up ${got.up.toFixed(3)}; worst miss ${(worst * 1000).toFixed(3)} mm`,
    };
  }, real, [{ name: 'spherical Earth (radius 6,371,008.8 m)', impl: sphere }]);

  // ---- F2. Real curvature ---------------------------------------------------------------------
  const flat = loadMutant(MODULE, [[
    'return ecefToLocal(frameFromGeoPose(anchor), ecef(point.lat, point.lon, point.h));',
    'return [(point.lon - anchor.position.lon) * 111320 * Math.cos(anchor.position.lat * RAD), point.h - anchor.position.h, -(point.lat - anchor.position.lat) * 111320];',
  ]]);
  await run('F2', "G2's origin in G1's frame is 100.0000033 m east, with the Earth's curvature in y and z", (impl) => {
    const [x, y, z] = impl.geographicToLocal(G1, G2_POINT);
    const tol = 0.00005; // 0.05 mm
    const fixed = close(x, 100.0000033, tol) && close(y, -0.0007825, tol) && close(z, -0.0008599, tol);
    const agree = close(x, reference.f2.x, tol) && close(y, reference.f2.y, tol) && close(z, reference.f2.z, tol);
    return { ok: fixed && agree, detail: `x ${x.toFixed(7)} m, y ${(y * 1e3).toFixed(4)} mm, z ${(z * 1e3).toFixed(4)} mm` };
  }, real, [{ name: 'flat inverse (111,320 m per degree x cos latitude)', impl: flat }]);

  // ---- F3. Axis mapping and yaw ---------------------------------------------------------------
  const axesIn = (impl, angles) => {
    const g2 = { position: G2_POINT, angles };
    const frame1 = impl.frameFromGeoPose(G1);
    const frame2 = impl.frameFromGeoPose(g2);
    return frame2.axes.flatMap((axis) => impl.directionInFrame(frame1, axis));
  };
  const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  await run('F3', "at zero angles G1 is X east, Y up, Z south; with yaw 90 degrees G2's +X points north, turned by the convergence", (impl) => {
    const frame = impl.frameFromGeoPose(G1);
    const enu = impl.enuAxes(G1.position.lat, G1.position.lon);
    const zeroOk = maxDiff(frame.axes[0], enu.east) < 1e-12 && maxDiff(frame.axes[1], enu.up) < 1e-12
      && maxDiff(frame.axes[2], enu.north.map((v) => -v)) < 1e-12;
    const got = axesIn(impl, { yaw: 90, pitch: 0, roll: 0 });
    const expected = [-1.720e-5, 1.35e-10, -0.99999999985];
    const printed = maxDiff(got.slice(0, 3), orientation.yaw90.slice(0, 3));
    const nearPrinted = close(got[0], expected[0], 1e-8) && close(got[1], expected[1], 1e-9) && close(got[2], expected[2], 1e-9);
    return {
      ok: zeroOk && printed < 1e-9 && nearPrinted,
      detail: `+X of G2 in G1 = (${got[0].toExponential(4)}, ${got[1].toExponential(4)}, ${got[2].toFixed(11)}); agrees with the reference to ${printed.toExponential(1)}`,
    };
  }, real, [{
    name: 'positive yaw turns the other way',
    impl: loadMutant(MODULE, [['senses: Object.freeze({ yaw: 1, pitch: 1, roll: 1 })', 'senses: Object.freeze({ yaw: -1, pitch: 1, roll: 1 })']]),
  }]);

  // ---- F3b. Pitch (and roll, and all three together) ------------------------------------------
  await run('F3b', 'with pitch 10 degrees, and with yaw 30, pitch 10 and roll 5, the runtime and the quaternion reference agree to 1e-9', (impl) => {
    const a = maxDiff(axesIn(impl, { yaw: 0, pitch: 10, roll: 0 }), orientation.pitch10);
    const b = maxDiff(axesIn(impl, { yaw: 30, pitch: 10, roll: 5 }), orientation.mixed);
    const angles = { yaw: 33.3, pitch: -41.5, roll: 12.25 };
    const back = impl.anglesFromRotation(impl.rotationFromAngles(angles));
    const round = Math.max(Math.abs(back.yaw - angles.yaw), Math.abs(back.pitch - angles.pitch), Math.abs(back.roll - angles.roll));
    return {
      ok: a < 1e-9 && b < 1e-9 && round < 1e-9,
      detail: `pitch 10: ${a.toExponential(1)}; mixed: ${b.toExponential(1)}; angle round trip: ${round.toExponential(1)}. The sense and order are an assumption (ROTATION_CONVENTION in web/wow-geopose.js): both paths share it, so this check cannot detect a wrong one.`,
    };
  }, real, [{
    name: 'pitch about east instead of north',
    impl: loadMutant(MODULE, [['const pitch = turn(1, k.pitch * (angles.pitch || 0) * RAD);', 'const pitch = turn(0, k.pitch * (angles.pitch || 0) * RAD);']]),
  }]);

  // ---- F5. Why positions stay local -----------------------------------------------------------
  const frame = real.frameFromGeoPose(G1);
  const sweep = (storeAsFloat32, seeds) => {
    const stats = { axis: 0, threeD: 0, medianLow: Infinity, smallestMax: Infinity };
    for (let seed = 1; seed <= seeds; seed += 1) {
      const rng = mulberry32(seed);
      const earthErrors = [];
      let points = 0;
      while (points < 1000) {
        const p = [(rng() * 2 - 1) * 5000, (rng() * 2 - 1) * 5000, (rng() * 2 - 1) * 5000];
        if (Math.hypot(...p) > 5000) continue;
        points += 1;
        const stored = storeAsFloat32(p);
        const errors = stored.map((v, i) => Math.abs(v - p[i]));
        stats.axis = Math.max(stats.axis, ...errors);
        stats.threeD = Math.max(stats.threeD, Math.hypot(...errors));
        const w = real.localToEcef(frame, p);
        earthErrors.push(Math.hypot(...w.map((c) => Math.fround(c) - c)));
      }
      earthErrors.sort((x, y) => x - y);
      stats.medianLow = Math.min(stats.medianLow, earthErrors[earthErrors.length >> 1]);
      stats.smallestMax = Math.min(stats.smallestMax, earthErrors[earthErrors.length - 1]);
    }
    return stats;
  };
  await run('F5', 'float32 positions relative to the graph hold to 0.245 mm; as Earth-centred coordinates they are off by 0.16 m', (impl) => {
    const s = sweep(impl.storeAsFloat32, 200);
    const pyAxis = reference.f5.axisMm / 1000;
    const pyOk = pyAxis <= 0.000245 && reference.f5.threeDMm / 1000 < 0.00028 && reference.f5.medianLow > 0.1 && reference.f5.smallestMax > 0.25;
    return {
      ok: s.axis <= 0.000245 && s.threeD < 0.00028 && s.medianLow > 0.1 && s.smallestMax > 0.25 && pyOk,
      detail: `200 seeds: local per-axis max ${(s.axis * 1e3).toFixed(4)} mm, 3-D max ${(s.threeD * 1e3).toFixed(4)} mm; Earth-centred median at least ${s.medianLow.toFixed(3)} m, smallest max ${s.smallestMax.toFixed(3)} m`,
    };
  }, { storeAsFloat32: (p) => p.map(Math.fround) }, [{
    name: 'positions flattened to Earth-centred coordinates before float32',
    impl: { storeAsFloat32: (p) => real.ecefToLocal(frame, real.localToEcef(frame, p).map(Math.fround)) },
  }]);

  // ---- R1. The reference script prints what was recorded when it was written --------------------------
  // reference-output.txt is the output recorded with reference-geodesy.py. If the two ever differ, the
  // numbers the checks above lean on are not the numbers they were specified with.
  const printedLines = fs.readFileSync(path.join(__dirname, 'reference-output.txt'), 'utf8').trimEnd().split('\n');
  await run('R1', "the reference script, run here, prints the 12 lines recorded in reference-output.txt", (impl) => {
    const got = python('reference-geodesy.py').trimEnd().split('\n');
    const want = impl.printed;
    const differing = want.map((line, i) => (got[i] === line ? null : `line ${i + 1}: printed "${got[i]}", wanted "${line}"`)).filter(Boolean);
    if (got.length !== want.length) differing.push(`${got.length} lines printed, wanted ${want.length}`);
    return { ok: differing.length === 0, detail: differing.length ? differing.slice(0, 2).join('; ') : `${got.length} lines, identical` };
  }, { printed: printedLines }, [
    { name: 'a printed line that differs in the last digit', impl: { printed: printedLines.map((line, i) => (i === 0 ? line.replace('-189013.869', '-189013.870') : line)) } },
    { name: 'a printed line missing', impl: { printed: printedLines.slice(1) } },
  ]);

  return { real, reference, orientation };
}

// ---- F4. One GeoPose reader ---------------------------------------------------------------------
async function readerChecks(real) {
  const Ajv = require(path.join(ROOT, 'node_modules', 'ajv'));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'wow-spec', 'upstream', 'geopose', 'GeoPose.Basic.YPR.Schema.json'), 'utf8'));
  const validateYpr = new Ajv({ strict: false }).compile(schema);
  const pose = (position, angles) => ({ position, angles: angles || { yaw: 1, pitch: 2, roll: 3 } });

  const cases = [
    { name: 'lan is read as lon, with a deprecation warning', input: pose({ lat: 47.7, lan: -122.3, h: 11.5 }), ok: true, warn: 'GEOPOSE_LAN_DEPRECATED', lon: -122.3 },
    { name: 'lon and lan that agree are accepted, with the warning', input: pose({ lat: 1, lon: 2, lan: 2, h: 3 }), ok: true, warn: 'GEOPOSE_LAN_DEPRECATED', lon: 2 },
    { name: 'lon and lan that disagree are refused by name', input: pose({ lat: 1, lon: 2, lan: 3, h: 3 }), ok: false, code: 'GEOPOSE_LON_LAN_CONFLICT' },
    { name: 'latitude above 90 is refused', input: pose({ lat: 90.0001, lon: 0, h: 0 }), ok: false, code: 'GEOPOSE_LATITUDE_OUT_OF_RANGE' },
    { name: 'latitude -90 and longitude 180 are accepted', input: pose({ lat: -90, lon: 180, h: 0 }), ok: true, lon: 180 },
    { name: 'longitude below -180 is refused', input: pose({ lat: 0, lon: -180.5, h: 0 }), ok: false, code: 'GEOPOSE_LONGITUDE_OUT_OF_RANGE' },
    { name: 'a missing angles object is refused', input: { position: { lat: 0, lon: 0, h: 0 } }, ok: false, code: 'GEOPOSE_MISSING_MEMBER' },
    { name: 'a missing height is refused', input: pose({ lat: 0, lon: 0 }), ok: false, code: 'GEOPOSE_MISSING_MEMBER' },
    { name: 'a string number is refused', input: pose({ lat: '47.7', lon: 0, h: 0 }), ok: false, code: 'GEOPOSE_NOT_A_FINITE_NUMBER' },
    { name: 'a null number (what NaN becomes in JSON) is refused', input: pose({ lat: 0, lon: null, h: 0 }), ok: false, code: 'GEOPOSE_NOT_A_FINITE_NUMBER' },
    { name: 'a non-object is refused', input: 'north', ok: false, code: 'GEOPOSE_NOT_AN_OBJECT' },
  ];

  const verdicts = (impl) => {
    const failures = [];
    for (const c of cases) {
      const got = impl.readGeoPose(c.input);
      if (got.ok !== c.ok) { failures.push(c.name); continue; }
      if (c.ok) {
        if (c.lon !== undefined && got.geoPose.position.lon !== c.lon) failures.push(c.name + ' (lon)');
        if (c.warn && !got.warnings.some((w) => w.code === c.warn)) failures.push(c.name + ' (warning)');
        if (!validateYpr(got.geoPose)) failures.push(c.name + ' (the OGC Basic-YPR schema rejects the output)');
      } else if (got.error.code !== c.code) failures.push(c.name + ' (got ' + got.error.code + ')');
    }
    return failures;
  };
  const noConflictCheck = loadMutant(MODULE, [[
    'if (pos.lon !== undefined && pos.lon !== pos.lan) {\n        return fail(READ_ERRORS.LON_LAN_CONFLICT, "position", `lon (${pos.lon}) and lan (${pos.lan}) disagree`);\n      }',
    '',
  ]]);
  const noBounds = loadMutant(MODULE, [
    ['if (pos.lat < -90 || pos.lat > 90) return fail(READ_ERRORS.LAT_RANGE, "position.lat", `latitude ${pos.lat} is outside -90..90`);', ''],
  ]);
  await run('F4', 'one GeoPose reader: lan maps to lon, a lon and lan that disagree are refused, bounds are checked, and the OGC schema accepts what it returns', (impl) => {
    const failures = verdicts(impl);
    // The schema sets no bounds: it accepts a latitude of 200, which is why the reader checks bounds itself.
    const schemaAcceptsBadLatitude = validateYpr(pose({ lat: 200, lon: 0, h: 0 }));
    const schemaRequiresAngles = !validateYpr({ position: { lat: 0, lon: 0, h: 0 } });
    return {
      ok: failures.length === 0 && schemaAcceptsBadLatitude && schemaRequiresAngles,
      detail: failures.length ? 'wrong verdicts: ' + failures.join('; ') : `${cases.length} verdicts hold; the OGC Basic-YPR schema accepts latitude 200, so the reader's bounds are its own`,
    };
  }, real, [
    { name: 'a reader that skips the lon and lan conflict', impl: noConflictCheck },
    { name: 'a reader that skips the latitude bounds', impl: noBounds },
  ]);

  // The browser's ES-module face and the server's CommonJS face are the same object.
  const facade = await import(path.join(ROOT, 'web', 'wow-geopose.mjs'));
  await run('F4b', "the server and the browser read GeoPose through one implementation (web/wow-geopose.js)", (impl) => ({
    ok: impl.facade.readGeoPose === impl.real.readGeoPose && impl.facade.geographicToLocal === impl.real.geographicToLocal,
    detail: 'the ES-module face exports the same functions as require("web/wow-geopose.js")',
  }), { facade, real }, [{ name: 'a second copy of the reader', impl: { facade: { readGeoPose: (x) => real.readGeoPose(x), geographicToLocal: real.geographicToLocal }, real } }]);
}

module.exports = { frameChecks, readerChecks, G1, G2_POINT, ZERO };
