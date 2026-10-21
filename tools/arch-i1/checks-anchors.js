'use strict';

/*
 * Iteration 1, anchors: F2 end to end (two world servers, one fixture each), F4 on the server (the
 * reader refuses a bad fixture and the server does not start), and G1 (every resource's GeoPose is
 * the local position put through real geodesy).
 */

const path = require('path');
const { ROOT, run } = require('./lib');
const { boot } = require('./harness');
const { httpReq } = require('./lib');

const geo = require(path.join(ROOT, 'web', 'wow-geopose.js'));
const FIXTURES = path.join(__dirname, 'fixtures');
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const GET = (port, p) => httpReq('GET', port, p);

async function anchorChecks(ports) {
  // ---- F2 end to end. Role a is served G2 and role lobby G1, so a server that ignores its fixture is wrong.
  const ignoresFixture = { runtime: [['const SPATIAL_ANCHORS = loadAnchors(cfg.spatial_anchor_fixture !== undefined ? cfg.spatial_anchor_fixture : cfg.spatial_anchors);', 'const SPATIAL_ANCHORS = loadAnchors(cfg.spatial_anchors);']] };
  const coarseAnchor = { runtime: [['            geoPose : clone(WORLD_ANCHOR), // the graph\'s anchor, as read from the fixture', '            geoPose : { position : { lat : WORLD_ANCHOR.position.lat, lon : Number(WORLD_ANCHOR.position.lon.toFixed(5)), h : WORLD_ANCHOR.position.h }, angles : WORLD_ANCHOR.angles },']] };
  await run('F2h', "two world servers, one anchor fixture each: the client reads both Spatial.geoPose values and finds G2 100.0000033 m east of G1, with the curvature", async (impl) => {
    const a = await boot('a', ports.next(), { edits: impl.edits, config: { spatial_anchor_fixture: path.join(FIXTURES, 'anchor-g2.json') } });
    const b = await boot('lobby', ports.next(), { edits: impl.edits, config: { spatial_anchor_fixture: path.join(FIXTURES, 'anchor-g1.json') } });
    try {
      const read = async (server) => {
        const r = await GET(server.port, '/wow/spatial/1');
        if (r.status !== 200 || !r.json) throw new Error('GET /wow/spatial/1: ' + r.status + ' ' + r.body.slice(0, 100));
        const parsed = geo.readGeoPose(r.json.geoPose);
        if (!parsed.ok) throw new Error('the Spatial geoPose is refused by the reader: ' + parsed.error.code);
        return parsed.geoPose;
      };
      const g2 = await read(a);
      const g1 = await read(b);
      const [x, y, z] = geo.geographicToLocal(g1, g2.position);
      const tol = 0.00005;
      return {
        ok: close(x, 100.0000033, tol) && close(y, -0.0007825, tol) && close(z, -0.0008599, tol),
        detail: `G2 in G1: x ${x.toFixed(7)} m, y ${(y * 1e3).toFixed(4)} mm, z ${(z * 1e3).toFixed(4)} mm`,
      };
    } finally { await a.close(); await b.close(); }
  }, { edits: null }, [
    { name: 'a server that ignores its anchor fixture', impl: { edits: ignoresFixture } },
    { name: 'a server that serves its anchor rounded to 5 decimals of a degree', impl: { edits: coarseAnchor } },
  ]);

  // ---- F4 on the server: the reader decides what a server may serve ---------------------------------
  const pose = (position) => ({ graphs: [{ id: 1, geoPose: { position, angles: { yaw: 0, pitch: 0, roll: 0 } } }] });
  const refused = [
    ['a lon and lan that disagree', pose({ lat: 1, lon: 2, lan: 3, h: 0 }), 'GEOPOSE_LON_LAN_CONFLICT'],
    ['a latitude of 95', pose({ lat: 95, lon: 0, h: 0 }), 'GEOPOSE_LATITUDE_OUT_OF_RANGE'],
    ['a missing height', pose({ lat: 1, lon: 2 }), 'GEOPOSE_MISSING_MEMBER'],
    ['a graph id of 0', { graphs: [{ id: 0, geoPose: { position: { lat: 1, lon: 2, h: 0 }, angles: { yaw: 0, pitch: 0, roll: 0 } } }] }, 'ANCHOR_FIXTURE_GRAPH_ID'],
    ['no graphs', { graphs: [] }, 'ANCHOR_FIXTURE_FORMAT'],
  ];
  const skipsReader = { anchor: [['const read = geo.readGeoPose(graph.geoPose);', 'const read = { ok: true, geoPose: graph.geoPose, warnings: [] };']] };
  await run('F4s', 'the world server loads its anchor through the shared reader: a fixture the reader refuses stops the server with the reader\'s named error, and a lan fixture is served as lon', async (impl) => {
    const failures = [];
    for (const [name, fixture, code] of refused) {
      let started = null;
      try { started = await boot('a', ports.next(), { edits: impl.edits, config: { spatial_anchors: fixture } }); }
      catch (error) { if (error.code !== code) failures.push(name + ': error ' + (error.code || error.message) + ', wanted ' + code); continue; }
      await started.close();
      failures.push(name + ': the server started');
    }
    const lan = await boot('a', ports.next(), { edits: impl.edits, config: { spatial_anchors: pose({ lat: 47.7, lan: -122.3, h: 11.5 }) } });
    try {
      for (const resource of ['/wow/world', '/wow/user/1', '/wow/view/1', '/wow/portal/1', '/wow/spatial/1']) {
        const r = await GET(lan.port, resource);
        const position = r.json && r.json.geoPose && r.json.geoPose.position;
        if (!position || position.lon === undefined) failures.push(resource + ' has no lon');
        if (position && Object.prototype.hasOwnProperty.call(position, 'lan')) failures.push(resource + ' emits the deprecated lan');
      }
    } finally { await lan.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `${refused.length} bad fixtures refused by name; a lan fixture is read and served as lon on 5 resources` };
  }, { edits: null }, [{ name: 'a server that does not use the reader', impl: { edits: skipsReader } }]);

  // ---- G1. Every resource's GeoPose is its local position put through real geodesy ----------------------
  const flatMapping = { runtime: [['        const pose = wowGeo.localPoseToGeoPose(WORLD_ANCHOR, local, Number(yawRad) || 0, Number(pitchRad) || 0);', '        const pose = { position : { lat : -local[2], lon : local[0], h : local[1] }, angles : { yaw : (Number(yawRad) || 0) * 180 / Math.PI, pitch : (Number(pitchRad) || 0) * 180 / Math.PI, roll : 0 } };']] };
  await run('G1', 'the GeoPose of a portal and of the view is its local position converted by real geodesy: converted back through EPSG 9837, it returns the local position to 0.2 mm', async (impl) => {
    const s = await boot('a', ports.next(), { edits: impl.edits, config: { spatial_anchor_fixture: path.join(FIXTURES, 'anchor-g1.json') } });
    try {
      const anchor = geo.readGeoPose(require(path.join(FIXTURES, 'anchor-g1.json')).graphs[0].geoPose).geoPose;
      const failures = [];
      // World A's portal 1 sits at local (2.8, 0, -2.8), from the world's configuration.
      const portal = await GET(s.port, '/wow/portal/1');
      const [x, y, z] = geo.geographicToLocal(anchor, portal.json.geoPose.position);
      if (![x - 2.8, y - 0, z + 2.8].every((d) => Math.abs(d) < 0.0002)) failures.push(`portal 1 came back at (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)}), wanted (2.8, 0, -2.8)`);
      // The view's local position is in its own resource; its geoPose must convert back to it.
      const view = await GET(s.port, '/wow/view/1');
      const local = view.json.webofworlds_extension.local_camera && view.json.webofworlds_extension.local_camera.position;
      if (!local) failures.push('the view resource carries no local camera position to compare with');
      else {
        const back = geo.geographicToLocal(anchor, view.json.geoPose.position);
        if (!back.every((v, i) => Math.abs(v - local[i]) < 0.0002)) failures.push(`the view came back at (${back.map((v) => v.toFixed(4)).join(', ')}), wanted (${local.join(', ')})`);
      }
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'portal 1 and the view convert back to their local positions' };
    } finally { await s.close(); }
  }, { edits: null }, [{ name: 'the old mapping: local metres copied into lat, lon and h', impl: { edits: flatMapping } }]);

  // ---- G2. Every world server serves its own anchor as its World and Spatial location --------------------
  // The airport's world also reads authored data, which once held a placeholder location. The anchor
  // fixture is the one source: all four roles must serve it, and what they serve must be valid.
  // The mutant is the airport as it was: authored data that carries the old placeholder location, and a runtime that lets it win.
  const placeholderAuthored = () => {
    const graph = JSON.parse(JSON.stringify(require(path.join(ROOT, 'web', 'worlds', 'denver-skyport.json'))));
    graph.world.geoPose = { position: { lat: 0, lan: 0, h: 0 }, angles: { yaw: 0, pitch: 0, roll: 0 } };
    return graph;
  };
  const authoredWins = { edits: { runtime: [['            // The anchor fixture is the one source of the world\'s location. Authored data does not set it.\n            geoPose : projected.geoPose,\n', '']] }, airportAuthored: placeholderAuthored };
  const { SPATIAL_ANCHORS } = require(path.join(ROOT, 'runtime', 'world-server', 'src', 'config.js'));
  const { createValidator } = require(path.join(ROOT, 'wow-spec', 'validate'));
  const validator = createValidator();
  await run('G2', 'all four world servers (A, B, lobby, airport) serve their configured anchor as the World and the Spatial location, and the World validates against the contract', async (impl) => {
    const failures = [];
    for (const role of ['a', 'b', 'lobby', 'airport']) {
      const config = role === 'airport' && impl.airportAuthored ? { authored_wow_graph: impl.airportAuthored() } : undefined;
      const s = await boot(role, ports.next(), { edits: impl.edits, config });
      try {
        const expected = geo.readGeoPose(SPATIAL_ANCHORS[role].graphs[0].geoPose).geoPose;
        const world = await GET(s.port, '/wow/world');
        const spatial = await GET(s.port, '/wow/spatial/1');
        if (world.status !== 200 || spatial.status !== 200) { failures.push(role + ': status ' + world.status + '/' + spatial.status); continue; }
        const verdict = validator.validateResponse('world', world.json);
        if (!verdict.valid) failures.push(role + ': the World is not valid: ' + String(verdict.errorsText).slice(0, 100));
        const read = geo.readGeoPose(world.json.geoPose);
        if (!read.ok) { failures.push(role + ': the World geoPose is refused by the reader: ' + read.error.code); continue; }
        if (JSON.stringify(read.geoPose) !== JSON.stringify(expected)) failures.push(role + ': the World geoPose is ' + JSON.stringify(world.json.geoPose.position) + ', not the configured anchor');
        if (JSON.stringify(world.json.geoPose) !== JSON.stringify(spatial.json.geoPose)) failures.push(role + ': the World and the Spatial disagree');
      } finally { await s.close(); }
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 3).join('; ') : '4 roles: the World and the Spatial carry the configured anchor, and the World is valid' };
  }, { edits: null }, [{ name: 'a server whose authored data overrides the anchor (the airport as it was)', impl: authoredWins }]);
}

module.exports = { anchorChecks };
