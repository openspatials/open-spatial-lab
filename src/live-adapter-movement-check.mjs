import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const root = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fileURLToPath(new URL('..', import.meta.url)));
const context = createContext({ console, EventTarget, Event, CustomEvent, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL,
  Date, Uint8Array, ArrayBuffer, Buffer, atob, btoa, structuredClone, setTimeout, clearTimeout, performance: { now: () => 1000 } });
const modules = new Map();
const appliedControls = [];
const renderOnly = () => { throw new Error('rendering outside movement fixture'); };
const pendingModules = new Map();
function load(path) {
  if (!pendingModules.has(path)) pendingModules.set(path, loadModule(path));
  return pendingModules.get(path);
}
async function loadModule(path) {
  if (path.endsWith('/web/vendor/scene-core/frontend-contract.js')) path = resolve(root, 'runtime/scene-core/public/frontend-contract.js');
  if (modules.has(path)) return modules.get(path);
  let fake = null;
  if (path.endsWith('/three.module.js')) fake = await import(pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js')));
  if (path.endsWith('/clip-library.mjs')) fake = { loadAvatarLibrary: renderOnly, createAvatarInstance: renderOnly };
  if (path.endsWith('/avatar-motion.mjs')) fake = { AvatarMotion: renderOnly };
  if (path.endsWith('/solvers.mjs')) fake = { SolverStack: renderOnly };
  if (path.endsWith('/equipment.mjs')) fake = { Equipment: renderOnly, loadItemLibrary: renderOnly };
  if (path.endsWith('/gltf-webp-support.mjs')) fake = {};
  if (path.endsWith('/avatar-equipment-layer.js')) fake = { DEFAULT_AVATAR_VARIANT: 'collection-adam', AVATAR_VARIANTS: {} };
  const nativeModule = path.endsWith('.mjs') && !path.endsWith('/actionforge-avatar.mjs') && !path.endsWith('-binding.mjs') && !path.includes('/live-adapter-movement');
  if (fake || nativeModule) {
    const native = fake || await import(pathToFileURL(path));
    const mod = new SyntheticModule(Object.keys(native), function () { for (const key of Object.keys(native)) this.setExport(key, native[key]); }, { context, identifier: path });
    modules.set(path, mod); return mod;
  }
  let source = readFileSync(path, 'utf8');
  const mutations = {
    '--dt-control': ['clamp(Number(deltaSeconds) || 0, 0, 0.05)', 'clamp(Number(deltaSeconds) || 0, 0, 0.5)'],
    '--cadence-control': ['this._serverSyncMs >= 250', 'this._serverSyncMs >= 500'],
    '--ground-control': ['frame.p[0] = frame.previousPosition[0]; frame.p[2] = frame.previousPosition[2];', 'frame.p[0] = frame.p[0]; frame.p[2] = frame.p[2];'],
    '--runtime-control': ['loco.update(dt,', 'loco.update(0,'],
    '--spawn-control': ['adoptSurface(surface);', 'void surface;'],
  };
  for (const [flag, [before, after]] of Object.entries(mutations)) if (process.argv.includes(flag) && source.includes(before)) { source = source.replace(before, after); appliedControls.push(flag); }
  const mod = new SourceTextModule(source, { context, identifier: path }); modules.set(path, mod);
  await mod.link(ref => load(resolve(dirname(path), ref))); return mod;
}
const module = await load(resolve(root, 'web/live-adapter.js')); await module.evaluate();
for (const flag of process.argv.filter(arg => arg.endsWith('-control'))) assert.equal(appliedControls.filter(value => value === flag).length, 1, flag + ' exact mutation anchor');
const { LiveAdapter } = module.namespace;
const { createTuning, Locomotion } = await import(pathToFileURL(resolve(root, 'web/avatar/runtime/locomotion.mjs')));
const { createAirportWalkableSurfaceContract } = await import(pathToFileURL(resolve(root, 'web/airport-walkable-surface.mjs')));
const { createPortalTraversalHandoffController } = await import(pathToFileURL(resolve(root, 'web/live-adapter-portal-traversal-controller.mjs')));
const { portalFrameForLocation } = await import(pathToFileURL(resolve(root, 'web/live-adapter-portal-geometry.mjs')));
const clean = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const surfaceGraph = { nodes: [{ webofworlds_extension: { airport_terminal: { walkable_surfaces: [{ surface_id: 'raised-floor', classification: 'walkable', shape: 'box', center_m: [0, 1, 0], size_m: [1, 2, 1] }] } } }] };
const surface = createAirportWalkableSurfaceContract(surfaceGraph);
const tuning = createTuning({ clips: { walk: { speed_mps: 1, duration_s: 1, left_touchdown_phase: 0 }, jog: { speed_mps: 4, duration_s: 1, left_touchdown_phase: 0 }, jumpStart: { takeoff_time_s: 0.2 }, jumpLand: { settle_time_s: 0.2, duration_s: 0.4 } } });
function host() {
  const h = new EventTarget(), trace = [], posts = []; Object.setPrototypeOf(h, LiveAdapter.prototype);
  Object.assign(h, { role: 'player', clientMode: 'player', _startsEmbodied: true, _noDefaultEquipment: true, base: '/api/a', activeEndpointKey: 'a',
    world: { location_id: 'a', avatar: { avatar_id: 'a', continuity_id: 'person', spawn_position: [0, 0, 0], rotation_y: 0 }, portals: [] },
    state: { phase: 'idle', avatar: { avatar_id: 'a', position: [0, 0, 0], rotation_y: 0 }, controls: { moving: false, grounded: true } },
    _runCalibration: null, _avatarLocomotion: null, _avatarLocomotionTuning: null, _jumpVelocity: 0, _serverSyncMs: 0, _movementBounds: null, _airportWalkableSurface: null,
    _transport: { getJson: async () => { throw new Error('unexpected GET'); }, postJson: async (url, body) => { posts.push({ url, body: clean(body) }); } },
    _portalTraversalController: { inTransition: () => false }, _updatePortalStatus: () => trace.push('portal'), _emit: () => trace.push('emit'), _maybeBroadcastPlayerPose: value => trace.push(['pose', value || null]),
  });
  return { h, trace, posts };
}
const records = {};
const record = (name, x) => { records[name] = clean({ avatar: x.h.state.avatar, controls: x.h.state.controls, jump: x.h._jumpVelocity, sync: x.h._serverSyncMs, trace: x.trace, posts: x.posts }); };

{
  const x = host(), { h } = x; const controls = h.state.controls;
  h.stepAvatar({ forward: true }, -1); h.stepAvatar({ forward: true }, NaN); assert.equal(x.trace.length, 0);
  h.stepAvatar({ forward: true }, 1); near(h.state.avatar.position[2], -0.07, 'dt must cap at 50ms');
  assert.equal(h.state.controls, controls, 'one host controls object');
  for (let i = 0; i < 4; i++) h.stepAvatar({ forward: true }, 0.05);
  assert.equal(x.posts.length, 1, 'movement posts at 250ms'); assert.deepEqual(x.posts[0].body, { forward: 1, strafe: 0, turn: 0, source: 'browser-real-avatar-controls' });
  assert.equal('position' in x.posts[0].body, false, 'historical server input is not client pose'); record('fallback-cadence', x);
}
{
  const x = host(), { h } = x; h._wowLocalWalk = true;
  h.setRunCalibration({ run_cycle_speed: 1.5, run_cycle_distance: 3 });
  assert.throws(() => h.setRunCalibration({ run_cycle_speed: 2, run_cycle_distance: 3 }), /hard envelope/);
  const calibration = h._runCalibration;
  assert.throws(() => h.setRunCalibration({ run_cycle_speed: 1, run_cycle_distance: 0 }), /non-near-zero/); assert.equal(h._runCalibration, calibration);
  for (let i = 0; i < 5; i++) h.stepAvatar({ forward: true, right: true, run: true, camera_yaw: 0 }, 0.05);
  near(Math.hypot(...[h.state.avatar.position[0], h.state.avatar.position[2]]), 1.125, 'diagonal speed normalized'); assert.equal(x.posts.length, 0); record('calibrated-local-diagonal', x);
}
{
  const x = host(), { h } = x; h._airportWalkableSurface = surface; h.state.avatar.position = [0.49, 2, 0];
  h.stepAvatar({ right: true }, 0.05); near(h.state.avatar.position[0], 0.49, 'unclassified planar move refused');
  assert.equal(h.state.controls.ground_query_reason, 'outside_classified_walkable_surface_planar_move_rejected'); assert.equal(h.state.controls.speed_mps, 0);
  record('refused-ground', x);
  h.state.avatar.position = [9, 2, 0]; const before = x.trace.length; h.stepAvatar({ forward: true }, 0.05); assert.equal(x.trace.length, before, 'invalid current ground stops the step');
}
{
  const x = host(), { h } = x; h._airportWalkableSurface = surface; h.state.avatar.position = [0, 2, 0];
  h.stepAvatar({ jump: true }, 0.05); near(h.state.avatar.position[1], 2.18625, 'real vertical integration'); assert.equal(h.state.controls.grounded, false);
  for (let i = 0; i < 30; i++) h.stepAvatar({}, 0.05);
  near(h.state.avatar.position[1], 2, 'jump lands on classified top'); assert.equal(h._jumpVelocity, 0); record('fallback-jump-land', x);
  h.state.avatar.position[1] = 4; h.state.controls.grounded = false;
  for (let i = 0; i < 30; i++) h.stepAvatar({}, 0.05); near(h.state.avatar.position[1], 2, 'fall lands on classified top');
}
{
  const x = host(), { h } = x; h.setAvatarLocomotionTuning(tuning);
  h.stepAvatar({ forward: true, camera_yaw: 0 }, 0.05); near(h.state.avatar.position[2], 0.02, 'runtime acceleration'); assert.ok(h._avatarLocomotion instanceof Locomotion);
  const loco = h._avatarLocomotion; h.state.avatar.position = [2, 0, 2]; h._runtimeLocomotion(h.state.avatar, 0); assert.equal(h._avatarLocomotion, loco); near(loco.position.x, 2, 'runtime follows host relocation');
  h._movementBounds = { minX: 1.99, maxX: 2.01, minZ: 1.99, maxZ: 2.01 }; h.stepAvatar({ forward: true, camera_yaw: 0 }, 0.05);
  near(loco.position.z, 2.01, 'runtime respects bounds'); near(loco.speed, 0.2, 'runtime trims speed at wall');
  h._movementBounds = null; for (let i = 0; i < 5; i++) h.stepAvatar({ forward: true, camera_yaw: 0 }, 0.05); assert.equal(x.posts.length, 1); record('runtime-walk-bounds', x);
  h.setAvatarLocomotionTuning(null); assert.equal(h._avatarLocomotion, null);
}
{
  const x = host(), { h } = x; h.setAvatarLocomotionTuning(tuning); h._airportWalkableSurface = surface;
  h.state.avatar.position = [0.49, 2, 0]; h.state.avatar.rotation_y = Math.PI / 2;
  h.stepAvatar({ forward: true, camera_yaw: Math.PI / 2 }, 0.05);
  near(h.state.avatar.position[0], 0.49, 'runtime rejects unclassified surface'); assert.equal(h._avatarLocomotion.speed, 0);
  assert.equal(h.state.controls.ground_query_ok, false); record('runtime-refused-ground', x);
}
{
  const x = host(), { h } = x;
  assert.throws(() => h.spawnWowLocalAvatar({ spatialID: 'world-airport-terminal' }), /contract invalid/);
  assert.equal(h._airportWalkableSurface?.ok, false, 'invalid spawn retains the attempted surface contract');
  h._airportWalkableSurface = null; h._movementBounds = { minX: -1, maxX: 1, minZ: -0.01, maxZ: 1 };
  h.stepAvatar({ forward: true }, 0.05); near(h.state.avatar.position[2], -0.01, 'legacy walk bounds');
  near(h.state.controls.last_planar_delta[2], -0.07, 'legacy diagnostic delta remains requested displacement'); record('invalid-spawn-and-legacy-bounds', x);
}
{
  const x = host(), { h } = x; h.setAvatarLocomotionTuning(tuning); const phases = [];
  for (let i = 0; i < 50; i++) { h.stepAvatar({ jump: i === 0 }, 0.05); phases.push(h.state.controls.motion?.phase); }
  for (const phase of ['crouch', 'push', 'air', 'land']) assert.ok(phases.includes(phase), 'runtime jump phase ' + phase);
  assert.equal(h._avatarLocomotion.phase, 'none', 'runtime settles without another active publication');
  near(h.state.avatar.position[1], 0, 'runtime jump lands'); assert.equal(h.state.controls.grounded, true); record('runtime-jump', x);
}
{
  const x = host(), { h } = x; h._wowResolved = { spatialID: 'world-airport-terminal', graph: surfaceGraph };
  h.spawnWowLocalAvatar({ spawn: [0, 99, 0, 0.7], bounds: { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 } });
  near(h.state.avatar.position[1], 2, 'spawn uses surface'); assert.equal(h.state.avatar.locomotion.grounded, true);
  h._navigator = {}; assert.equal(h.applyRestoredPose({ position: [0.2, 99, 0.1], rotation_y: 1 }), true); near(h.state.avatar.position[1], 2, 'restore uses surface');
  assert.equal(h.applyRestoredPose({ position: [9, 0, 0] }), false); h.state.phase = 'departed'; assert.equal(h.applyRestoredPose({ position: [0, 0, 0] }), false); record('spawn-restore', x);
}
{
  const x = host(), { h } = x; h.setAvatarLocomotionTuning(tuning); h.state.phase = 'departed';
  h.stepAvatar({ forward: true, jump: true }, 0.05); assert.equal(h.state.controls.motion.speed_mps, 0); assert.equal(x.posts.length, 0);
  h._portalTraversalController.inTransition = () => true;
  h._stepPortalTransition = dt => { h.state.controls.moving = true; h.state.controls.last_planar_delta = [dt, 0, 0]; };
  h.stepAvatar({}, 0.05); assert.equal(h.state.controls.motion.speed_mps, 1); assert.equal(h._avatarLocomotion, null); record('transition-and-guard', x);
}
{
  const x = host(), { h } = x; const no = () => {};
  const frame = portalFrameForLocation({ portalId: 'p', locationId: 'a', triggerPosition: [0, 0, 0], triggerRadius: 1, targetLocationId: 'b' });
  const portal = { portal_id: 'p', frame, target_frame: frame, trigger: { position: [0, 0, 0], radius_m: 1 }, target_location_id: 'b', wow_resource: {} }; h.world.portal = portal; h.world.portals = [portal];
  const controller = createPortalTraversalHandoffController({ handoffPhases: { IDLE: 'idle', ARRIVED: 'arrived', PORTAL_ACTIVE: 'portal_active' }, provenance: { LIVE: 'live' },
    transport: h._transport, readHostSnapshot: () => ({ world: h.world, avatar: h.state.avatar, controls: h.state.controls, phase: h.state.phase, clientMode: 'player' }),
    applyTraversalPatch: patch => { for (const key of ['avatar', 'controls', 'phase']) if (key in patch) h.state[key] = patch[key]; },
    emitState: no, log: no, policy: { evaluateRp1Gate: () => ({ decision: 'allow' }) }, validation: { transformSnapshot: avatar => ({ position: avatar.position.slice(), rotation_y: avatar.rotation_y }) },
    movement: { speedMps: 1.4, facingSemanticsFromDelta: () => 'forward' }, crossingGate: async () => ({ ok: false, kind: 'unavailable' }),
  });
  h._portalTraversalController = controller; controller.beginTransition({ portal }); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(controller.inTransition(), false); assert.equal(h.state.phase, 'idle'); assert.equal(x.posts.length, 0);
  h.stepAvatar({ back: true }, 0.05); near(h.state.avatar.position[2], 0.07, 'refused crossing retains walk-away movement'); record('refused-crossing-walk-away', x); controller.cancel();
}
console.log(JSON.stringify({ passed: true, contracts: Object.keys(records), records }, null, 2));
