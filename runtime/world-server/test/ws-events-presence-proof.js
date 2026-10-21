'use strict';

/*
 * `WS /events` realtime + presence-as-WoW-users
 * ACCEPTANCE PROOF. Node core only. Boots ONE 041 server on an ISOLATED port
 * (default 19715; override with PROOF_PORT), connects a real RFC6455 `/events`
 * WS client, and drives the honesty-critical acceptance from the task §4:
 *
 *   1. WS /events UPGRADES (labeled non-canonical convention now served).
 *   2. On connect it sends a `hello` snapshot (current live occupancy).
 *   3. Presence register  -> user_joined  + /wow/user/{id} resolves the player
 *      (real occupancy) + /wow/world extension lists the player.
 *   4. Node CRUD (POST/PUT/DELETE /wow/spatial/.../node) -> node_created /
 *      node_updated / node_deleted, ids matching the HTTP responses.
 *   5. Presence depart   -> user_left + /wow/user/{id} now 404 (ghost-free).
 *   6. TTL EXPIRY        -> user_left + /wow/user/{id} 404 (no ghost survives).
 *   7. Two players       -> exactly two live users, no self-duplication.
 *   8. Every /events envelope carries the proof_boundary flags (honesty).
 *
 * Envelope shape matches the conformance fixture
 * (tools/wow-conformance/fixtures.js): { type, ts, user|node:{id}, ... }.
 *
 * Runs on an isolated port; NEVER touches the live demo ports (8143 /
 * 18151-18153). No git, no heavy e2e battery.
 */

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const { start } = require('../src/server');
const { get, post, put, del } = require('../src/http-client');

const PORT = Number(process.env.PROOF_PORT || 19715);
const BASE = 'http://127.0.0.1:' + PORT;
const EVENT_TYPES = new Set([ 'user_joined', 'user_left', 'node_created', 'node_updated', 'node_deleted' ]);

let passed = 0, failed = 0;
const results = [];
async function check(id, desc, fn)
{
    try { await fn(); passed++; results.push({ id, status : 'PASS' }); console.log('PASS  ' + id + '  ' + desc); }
    catch (err) { failed++; results.push({ id, status : 'FAIL', error : err.message }); console.log('FAIL  ' + id + '  ' + desc + '  -> ' + err.message); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Connect a real WS /events client; collect JSON frames + expose waitFor(). */
function connectEvents(port, path)
{
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(
                'GET ' + (path || '/events') + ' HTTP/1.1\r\n' +
                'Host: 127.0.0.1:' + port + '\r\n' +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n');
        });
        const frames = [];
        const waiters = [];
        let buf = Buffer.alloc(0);
        let handshakeDone = false;
        let settled = false;

        function pump(frame)
        {
            frames.push(frame);
            for (let i = waiters.length - 1; i >= 0; i--)
            {
                if (waiters[i].predicate(frame))
                {
                    clearTimeout(waiters[i].timer);
                    waiters.splice(i, 1)[0].resolve(frame);
                }
            }
        }

        const api = {
            frames,
            waitFor(predicate, timeoutMs, label)
            {
                const existing = frames.find(predicate);
                if (existing) return Promise.resolve(existing);
                return new Promise((res, rej) => {
                    const timer = setTimeout(() => {
                        const idx = waiters.findIndex(w => w.timer === timer);
                        if (idx !== -1) waiters.splice(idx, 1);
                        rej(new Error('waitFor timeout (' + (label || 'frame') + ') after ' + timeoutMs + 'ms; seen types: '
                            + JSON.stringify(frames.map(f => f.type))));
                    }, timeoutMs || 3000);
                    waiters.push({ predicate, resolve : res, timer });
                });
            },
            close() { try { sock.destroy(); } catch (e) {} },
        };

        sock.on('data', chunk => {
            buf = Buffer.concat([ buf, chunk ]);
            if (!handshakeDone)
            {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx === -1) return;
                handshakeDone = true;
                const head = buf.slice(0, idx).toString('utf8');
                buf = buf.slice(idx + 4);
                if (!settled) { settled = true; head.includes(' 101 ') ? resolve(api) : reject(new Error('no WS upgrade: ' + head.split('\r\n')[0])); }
            }
            while (buf.length >= 2)
            {
                const b1 = buf[1];
                let len = b1 & 0x7f;
                let offset = 2;
                if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
                else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); offset = 10; }
                if (buf.length < offset + len) break;
                const payload = buf.slice(offset, offset + len).toString('utf8');
                buf = buf.slice(offset + len);
                try { pump(JSON.parse(payload)); } catch (e) { /* ignore non-JSON */ }
            }
        });
        sock.on('error', err => { if (!settled) { settled = true; reject(err); } });
    });
}

function assertBoundary(evt, where)
{
    const pb = evt && evt.proof_boundary;
    assert.ok(pb, 'proof_boundary present on ' + where);
    assert.strictEqual(pb.application_level_handoff, true, 'application_level_handoff on ' + where);
    assert.strictEqual(pb.native_teleportxr_teleport, false, 'native_teleportxr_teleport on ' + where);
    assert.strictEqual(pb.first_party_teleportxr_browser_rendering, false, 'first_party render flag on ' + where);
    assert.strictEqual(pb.standards_conformance, false, 'standards_conformance:false on ' + where);
}

async function main()
{
    const built = await start('a', { http_port : PORT });
    const WORLD = built.runtime.WORLD_ID; // 'demo-room-a'
    const spatial = 'world'; // an accepted alias for this node's graph

    let ev;
    try
    {
        // --- 1. WS /events upgrades + hello snapshot -------------------------
        ev = await connectEvents(PORT, '/events');
        await check('WS1', 'WS /events upgrades (labeled non-canonical convention now served)', async () => {
            const hello = await ev.waitFor(f => f.type === 'hello', 3000, 'hello');
            assert.ok(Array.isArray(hello.users), 'hello.users is an array');
            assert.strictEqual(hello.users.length, 0, 'hello shows zero occupancy at boot');
            assert.ok(/non-canonical/i.test(hello.convention || ''), 'hello labels the convention non-canonical');
            assertBoundary(hello, 'hello');
        });

        // --- 2. register -> user_joined + /wow/user reflects occupancy -------
        let p1UserId = null;
        await check('PJ1', 'presence register -> user_joined on /events', async () => {
            const r = await post(BASE + '/fabric/presence/register', { player_id : 'validation-player-1', display_name : 'Ada', avatar_id : 'ada-vrm' });
            assert.strictEqual(r.status, 201, 'register 201');
            const joined = await ev.waitFor(f => f.type === 'user_joined' && f.user && f.user.player_id === 'validation-player-1', 3000, 'user_joined p1');
            assert.ok(Number.isInteger(joined.user.id), 'user_joined carries an integer user.id');
            assert.strictEqual(joined.user.display_name, 'Ada', 'user_joined carries display_name');
            assertBoundary(joined, 'user_joined');
            p1UserId = joined.user.id;
        });

        await check('PU1', 'GET /wow/user/{mintedId} resolves the live presence player', async () => {
            const r = await get(BASE + '/wow/user/' + p1UserId);
            assert.strictEqual(r.status, 200, '/wow/user/' + p1UserId + ' is 200');
            assert.strictEqual(r.json.id, p1UserId, 'user resource id matches');
            assert.strictEqual(r.json.name, 'Ada', 'user resource name matches');
            assert.strictEqual(r.json.webofworlds_extension.source, 'presence-registry', 'labeled presence source');
            assertBoundary(r.json, '/wow/user presence resource');
        });

        await check('PU2', 'GET /wow/user/{player_id} also resolves the player', async () => {
            const r = await get(BASE + '/wow/user/validation-player-1');
            assert.strictEqual(r.status, 200, 'resolve by player_id');
            assert.strictEqual(r.json.id, p1UserId, 'same minted id');
        });

        await check('PW1', 'GET /wow/world surfaces the live presence player (extension users)', async () => {
            const r = await get(BASE + '/wow/world');
            assert.strictEqual(r.status, 200, '/wow/world 200');
            const users = r.json.webofworlds_extension.users;
            const hit = users.find(u => u.source === 'presence-registry' && u.id === p1UserId);
            assert.ok(hit, 'presence player listed in world extension users');
            assert.strictEqual(hit.player_id, 'validation-player-1', 'listed by player_id');
        });

        // --- 3. hosted-avatar user 1 unchanged (pre-015 projection intact) ---
        await check('PU3', 'GET /wow/user/1 still returns the hosted avatar (unchanged)', async () => {
            const r = await get(BASE + '/wow/user/1');
            assert.strictEqual(r.status, 200, '/wow/user/1 200');
            assert.strictEqual(r.json.id, 1, 'hosted avatar id 1');
            assert.strictEqual(r.json.webofworlds_extension.avatar_id, 'avatar-local-001', 'hosted avatar identity intact');
        });

        // --- 4. node CRUD -> node_created / node_updated / node_deleted ------
        let createdIds = [];
        await check('NC1', 'POST node -> node_created on /events (ids match HTTP response)', async () => {
            const body = [
                { label : 'validation-cube', names : [ 'validation-cube' ], localTransform : [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1 ], spatialAssetURI : 'osl-primitive:box' },
                { label : 'validation-cube-2', names : [ 'validation-cube-2' ], localTransform : [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 4,0,0,1 ] },
            ];
            const r = await post(BASE + '/wow/spatial/' + spatial + '/node/0', body);
            assert.strictEqual(r.status, 200, 'create 200');
            assert.ok(Array.isArray(r.json) && r.json.length === 2, 'two nodes created');
            createdIds = r.json.map(n => n.id);
            for (const id of createdIds)
            {
                const evt = await ev.waitFor(f => f.type === 'node_created' && f.node && f.node.id === id, 3000, 'node_created ' + id);
                assert.strictEqual(evt.spatialID, WORLD, 'node_created carries canonical spatialID');
                assertBoundary(evt, 'node_created');
            }
        });

        await check('NU1', 'PUT node -> node_updated on /events', async () => {
            const target = createdIds[0];
            const r = await put(BASE + '/wow/spatial/' + spatial + '/node/' + target, { label : 'validation-cube-renamed' });
            assert.strictEqual(r.status, 200, 'update 200');
            const evt = await ev.waitFor(f => f.type === 'node_updated' && f.node && f.node.id === target, 3000, 'node_updated');
            assert.strictEqual(evt.node.label, 'validation-cube-renamed', 'node_updated carries new label');
            assertBoundary(evt, 'node_updated');
        });

        await check('ND1', 'DELETE node -> node_deleted on /events', async () => {
            const target = createdIds[1];
            const r = await del(BASE + '/wow/spatial/' + spatial + '/node/' + target);
            assert.strictEqual(r.status, 200, 'delete 200');
            const evt = await ev.waitFor(f => f.type === 'node_deleted' && f.node && f.node.id === target, 3000, 'node_deleted');
            assertBoundary(evt, 'node_deleted');
        });

        // --- 5. explicit depart -> user_left + ghost-free /wow/user 404 ------
        await check('PL1', 'presence depart -> user_left + /wow/user/{id} now 404 (ghost-free)', async () => {
            const r = await post(BASE + '/fabric/presence/depart', { player_id : 'validation-player-1' });
            assert.strictEqual(r.status, 200, 'depart 200');
            const left = await ev.waitFor(f => f.type === 'user_left' && f.user && f.user.id === p1UserId, 3000, 'user_left depart');
            assertBoundary(left, 'user_left (depart)');
            const u = await get(BASE + '/wow/user/' + p1UserId);
            assert.strictEqual(u.status, 404, 'departed player no longer resolvable (no ghost)');
        });

        // --- 6. TTL expiry -> user_left + 404 (no ghost survives its TTL) ----
        await check('PT1', 'TTL expiry -> user_left + /wow/user/{id} 404 (ghost-free TTL)', async () => {
            const r = await post(BASE + '/fabric/presence/register', { player_id : 'validation-ttl', display_name : 'Grace', requested_ttl_ms : 1000 });
            assert.strictEqual(r.status, 201, 'short-ttl register 201');
            const joined = await ev.waitFor(f => f.type === 'user_joined' && f.user && f.user.player_id === 'validation-ttl', 3000, 'user_joined ttl');
            const ttlId = joined.user.id;
            // do NOT heartbeat -> sweeper expires within ~1-2s (sweep interval 1000ms)
            const left = await ev.waitFor(f => f.type === 'user_left' && f.user && f.user.id === ttlId, 5000, 'user_left expiry');
            assertBoundary(left, 'user_left (expiry)');
            const u = await get(BASE + '/wow/user/' + ttlId);
            assert.strictEqual(u.status, 404, 'TTL-expired player is not a ghost');
        });

        // --- 7. two players -> exactly two live users, no self-duplication ---
        await check('PD1', 'two players -> exactly two live users, no duplication', async () => {
            await post(BASE + '/fabric/presence/register', { player_id : 'dup-a', display_name : 'A' });
            await post(BASE + '/fabric/presence/register', { player_id : 'dup-b', display_name : 'B' });
            await ev.waitFor(f => f.type === 'user_joined' && f.user && f.user.player_id === 'dup-a', 3000, 'join dup-a');
            await ev.waitFor(f => f.type === 'user_joined' && f.user && f.user.player_id === 'dup-b', 3000, 'join dup-b');
            // re-register dup-a: MUST NOT emit a second join (ghost-free, no self-dup)
            const beforeJoins = ev.frames.filter(f => f.type === 'user_joined' && f.user.player_id === 'dup-a').length;
            await post(BASE + '/fabric/presence/register', { player_id : 'dup-a', display_name : 'A' });
            await delay(300);
            const afterJoins = ev.frames.filter(f => f.type === 'user_joined' && f.user.player_id === 'dup-a').length;
            assert.strictEqual(afterJoins, beforeJoins, 're-register emits no duplicate user_joined');
            const w = await get(BASE + '/wow/world');
            const presenceUsers = w.json.webofworlds_extension.users.filter(u => u.source === 'presence-registry');
            assert.strictEqual(presenceUsers.length, 2, 'exactly two live presence users (dup-a, dup-b)');
            const ids = presenceUsers.map(u => u.id);
            assert.strictEqual(new Set(ids).size, 2, 'no duplicated user ids');
        });

        // --- 8. every emitted envelope is a known type + carries a ts --------
        await check('EV1', 'every /events delta envelope is a known convention type with a ts', async () => {
            const deltas = ev.frames.filter(f => f.type !== 'hello');
            assert.ok(deltas.length > 0, 'delta events were emitted');
            for (const f of deltas)
            {
                assert.ok(EVENT_TYPES.has(f.type), 'known convention type: ' + f.type);
                assert.strictEqual(typeof f.ts, 'string', 'envelope carries ts');
            }
        });
    }
    finally
    {
        if (ev) ev.close();
        await built.closeAll();
    }

    console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + passed + ' passed, ' + failed + ' failed  (isolated port ' + PORT + ')');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('validation crashed:', err); process.exit(2); });
