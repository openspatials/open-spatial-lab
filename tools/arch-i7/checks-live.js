'use strict';

/*
 * Iteration 7: B's game, live in A, and A's viewers acting on it under B's permissions.
 *
 *   W1   a viewer of A sees B's ball move: at every update of its client, the ball's position in A, through each of
 *        the two including nodes (1:10 on the table, and full size at the distant site), equals B's server state
 *        transformed by the including node, at most one ball step behind B
 *   W2   viewer V1 presses B's button: the write goes to the button's URL at B, with If-Match and the token B issued
 *        by exchange ("host A acts for V1"), whose write grant names the button node alone (the same token is refused
 *        on the light); B's light toggles, and B's own visitor and A's other viewer V2 both see it
 *   W2b  V1 and V2 press at the same moment, from the same entity tag: one write succeeds, the other gets 412, reads
 *        again and retries, so both presses count and the light ends where it started
 *   W3   V3 holds no write grant at B: the press is refused (403), the refusal is in V3's client state, and V3's
 *        client still shows the button and the light as B holds them
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const serverEdit = (file, from, to) => ({ serverEdits: { [file]: [[from, to]] } });
const clientEdit = (from, to) => ({ clientEdits: [[from, to]] });
const press = (node) => ({ properties: Object.assign({}, node.properties || {}, { presses: (Number(node.properties && node.properties.presses) || 0) + 1 }) });
const propsIn = (live, url) => Object.values(lab.recordsOf(live.composition, url)).map((r) => r.properties || {});

async function liveChecks(ports) {
  // ---- W1 -----------------------------------------------------------------------------------------------
  await run('W1', 'a viewer of A sees B\'s ball move: at each update its position in A, through the table (1:10) and the distant site, equals B\'s server state transformed by the including node, at most one ball step behind B', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const v = await lab.viewer(s, 'viewer-v1');
      const from = v.updates.length;
      const firstStep = s.B.game.log().length;
      await lab.sleep(3200);
      await lab.settle([v], 300);
      const log = s.B.game.log();
      const mul = v.inc.multiply;
      const gameLocal = s.B.game.state().game;
      const including = { [s.urls.onTable]: lab.matrixOf(s.A, s.ids.onTable, mul), [s.urls.distant]: lab.matrixOf(s.A, s.ids.distant, mul) };
      const expected = (via, entry) => v.inc.transformPoint(mul(including[via], gameLocal), entry.position);
      const failures = [];
      const lags = [];
      const seen = { [s.urls.onTable]: new Set(), [s.urls.distant]: new Set() };
      const window = v.updates.slice(from).filter((u) => u.gameLog > firstStep);
      for (const u of window) {
        for (const via of Object.keys(including)) {
          const shown = u.balls[via];
          if (!shown) { failures.push('an update shows no ball through ' + via); continue; }
          let index = -1;
          for (let i = u.gameLog - 1; i >= 0; i -= 1) if (lab.near(shown, expected(via, log[i]), 1e-6)) { index = i; break; }
          if (index === -1) { failures.push('through ' + via + ' the ball is at ' + JSON.stringify(shown) + ', no state B logged'); continue; }
          lags.push(u.gameLog - 1 - index);
          seen[via].add(index);
        }
      }
      const worst = lags.length ? Math.max(...lags) : null;
      const steps = log.length - firstStep;
      if (steps < 10) failures.push('B\'s ball took only ' + steps + ' steps');
      for (const via of Object.keys(seen)) if (seen[via].size < Math.floor(steps / 2)) failures.push('through ' + via + ' the viewer saw ' + seen[via].size + ' of B\'s ' + steps + ' ball steps');
      if (worst === null || worst > 1) failures.push('the ball shown was up to ' + worst + ' steps behind B');
      const last = v.updates[v.updates.length - 1];
      const end = log[log.length - 1];
      for (const via of Object.keys(including)) if (!lab.near(last && last.balls[via], expected(via, end), 1e-6)) failures.push('at the end through ' + via + ' the ball is at ' + JSON.stringify(last && last.balls[via]) + ', B has it at ' + JSON.stringify(expected(via, end)));
      const detail = failures.length ? failures.slice(0, 4).join('; ')
        : steps + ' ball steps, ' + window.length + ' updates; every position equals B\'s state through the including node (table ' + seen[s.urls.onTable].size + ' and distant site ' + seen[s.urls.distant].size + ' distinct steps seen), at most ' + worst + ' step behind; last ball at the distant site x=' + last.balls[s.urls.distant][0].toFixed(4);
      return { ok: failures.length === 0, detail, loadSensitive: failures.length > 0 && worst !== null && worst > 1 };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client that reads B\'s ball once and does not follow B\'s events', impl: clientEdit('          if (named.some((u) => reader.cache.has(u))) return recompose(evt);', '          if (false) return recompose(evt);') },
    { name: 'a game that moves the ball only in memory (B\'s server state never changes)', impl: serverEdit('runtime-game.js', '        const r = runtime.updateSpatialNode(graph, ids.ball, { localTransform : at(...position) }, flat);', '        const r = { ok : true };') },
  ]);

  // ---- W2 -----------------------------------------------------------------------------------------------
  await run('W2', 'viewer V1 presses B\'s button: one PUT to the button\'s URL at B with If-Match and B\'s exchanged token "host A acts for V1", which writes the button node alone; B\'s light toggles, and B\'s own visitor and A\'s other viewer V2 both see it', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const visitor = await lab.visitorOfB(s);
      const v1 = await lab.viewer(s, 'viewer-v1');
      const v2 = await lab.viewer(s, 'viewer-v2');
      const failures = [];
      const seen = [];
      const before = s.B.game.state();
      const result = await v1.live.write(s.urls.button, press);
      await lab.settle([v1, v2], 600);
      await visitor.observer.idle();
      const after = s.B.game.state();
      const puts = s.B.log.filter((r) => r.method === 'PUT' && r.url === s.B.prefix + '/' + lab.nodeRef(s.B.game.ids.button));
      const put = puts[0];
      if (result.status !== 200) failures.push('the press answered ' + result.status + ' (' + (result.statuses || []).join(', ') + ')');
      if (puts.length !== 1 || !put.ifMatch) failures.push('B received ' + puts.length + ' PUT(s) of the button, the first ' + (put && put.ifMatch ? 'with' : 'without') + ' If-Match');
      const bearer = put && put.authorization ? put.authorization.replace(/^Bearer\s+/i, '') : null;
      const c = bearer ? lab.i6.claimsOf(bearer) : null;
      if (!(c && c.iss === s.B.auth.issuer && c.sub === 'viewer-v1' && JSON.stringify(lab.i6.actorsOf(c)) === JSON.stringify([s.A.base]))) failures.push('the press carried ' + (c ? 'a token of ' + c.iss + ' for ' + c.sub + ' with actors ' + JSON.stringify(lab.i6.actorsOf(c)) : 'no token') + ', not B\'s token for host A acting for viewer-v1');
      const entry = s.B.auth.decisions().filter((d) => d.method === 'PUT' && /node\/\d+$/.test(d.path)).pop();
      if (!entry || entry.decision !== 'allowed' || entry.subject !== 'viewer-v1' || entry.actors[0] !== s.A.base) failures.push('B\'s log of the press: ' + JSON.stringify(entry || null));
      if (!(after.presses === before.presses + 1 && after.on === !before.on)) failures.push('B: presses ' + before.presses + ' -> ' + after.presses + ', light ' + before.on + ' -> ' + after.on);
      if (visitor.light.value !== after.on) failures.push('B\'s own visitor sees the light ' + visitor.light.value + ', B has ' + after.on);
      const v2Light = propsIn(v2.live, s.urls.light);
      if (v2Light.length !== 2 || !v2Light.every((p) => p.on === after.on)) failures.push('A\'s other viewer V2 shows the light ' + JSON.stringify(v2Light.map((p) => p.on)) + ', B has ' + after.on);
      const onLight = await s.B.req('PUT', lab.nodeRef(s.B.game.ids.light), { properties: { on: !after.on } }, bearer);
      if (onLight.status !== 403) failures.push('the same token wrote the light: ' + onLight.status + ' (its write grant should name the button alone)');
      seen.push('PUT button ' + result.status + ' with If-Match ' + put.ifMatch + ' and B\'s token sub ' + c.sub + ' act ' + JSON.stringify(c.act) + ' scope "' + c.scope + '"');
      seen.push('B: presses ' + before.presses + ' -> ' + after.presses + ', light ' + before.on + ' -> ' + after.on + '; B\'s visitor sees ' + visitor.light.value + ', V2 sees ' + JSON.stringify(v2Light.map((p) => p.on)) + ' (table, distant site)');
      seen.push('the same token on the light: ' + onLight.status);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client that writes without the world\'s token', impl: clientEdit('  const auth = bearerFor(opts.token, nodeUrl);', '  const auth = {};') },
    { name: 'a node write grant that covers every node (the token also writes the light)', impl: serverEdit('world-auth-policy.js', "    return granted === 'world' && isNode(needed);", "    return (granted === 'world' || isNode(granted)) && isNode(needed);") },
    { name: 'a game whose light does not follow the button', impl: serverEdit('runtime-game.js', '        if (evt && evt.type === \'node_updated\' && evt.node && evt.node.id === ids.button) setImmediate(follow);', '        if (false) setImmediate(follow);') },
  ]);

  // ---- W2b ----------------------------------------------------------------------------------------------
  await run('W2b', 'V1 and V2 press at the same moment from the same entity tag: one PUT answers 200, the other 412, reads again and retries with 200; both presses count and the light ends where it started', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const v1 = await lab.viewer(s, 'viewer-v1');
      const v2 = await lab.viewer(s, 'viewer-v2');
      const failures = [];
      const before = s.B.game.state();
      const read = async (v) => {
        const r = await fetch(s.urls.button, { headers: { Accept: lab.WOW, Authorization: 'Bearer ' + v.tokens.b } });
        return { etag: r.headers.get('etag'), node: await r.json() };
      };
      const [r1, r2] = await Promise.all([read(v1), read(v2)]);
      if (r1.etag !== r2.etag) failures.push('the two reads gave different tags');
      const [w1, w2] = await Promise.all([v1.live.write(s.urls.button, press, r1), v2.live.write(s.urls.button, press, r2)]);
      await lab.settle([v1, v2], 600);
      const after = s.B.game.state();
      const paths = [w1.statuses.join(' '), w2.statuses.join(' ')].sort();
      if (!(w1.status === 200 && w2.status === 200)) failures.push('the presses ended ' + w1.status + ' and ' + w2.status);
      if (JSON.stringify(paths) !== JSON.stringify(['PUT 200', 'PUT 412 GET 200 PUT 200'])) failures.push('the presses went ' + JSON.stringify(paths) + ', not one PUT 200 and one PUT 412, read again, PUT 200');
      if (after.presses !== before.presses + 2) failures.push('B counted ' + (after.presses - before.presses) + ' of the 2 presses');
      if (after.on !== before.on) failures.push('the light ended ' + after.on + ', it started ' + before.on);
      const shown = propsIn(v1.live, s.urls.light).concat(propsIn(v2.live, s.urls.light));
      if (!shown.every((p) => p.on === after.on)) failures.push('the viewers show the light ' + JSON.stringify(shown.map((p) => p.on)));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'one press "' + paths[0] + '", the other "' + paths[1] + '"; B: presses ' + before.presses + ' -> ' + after.presses + ', light ' + before.on + ' -> ' + after.on + ' (where it started), both viewers show it' };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client that writes without If-Match', impl: clientEdit('"If-Match": etag, ', '') },
  ]);

  // ---- W3 -----------------------------------------------------------------------------------------------
  await run('W3', 'V3 holds no write grant at B: its press is refused (403), the refusal is in its client state, and its client still shows the button and the light as B holds them', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const v3 = await lab.viewer(s, 'viewer-v3');
      const failures = [];
      const before = s.B.game.state();
      const result = await v3.live.write(s.urls.button, press);
      await lab.settle([v3], 500);
      const after = s.B.game.state();
      const refusal = v3.live.refusals.find((r) => r.node === s.urls.button);
      if (result.status !== 403) failures.push('the press answered ' + result.status);
      if (!refusal || refusal.status !== 403) failures.push('the client state holds no refusal of the press: ' + JSON.stringify(v3.live.refusals));
      if (after.presses !== before.presses || after.on !== before.on) failures.push('B changed: presses ' + before.presses + ' -> ' + after.presses);
      const buttons = propsIn(v3.live, s.urls.button);
      const lights = propsIn(v3.live, s.urls.light);
      if (!buttons.length || !buttons.every((p) => p.presses === after.presses)) failures.push('V3\'s client shows the button at ' + JSON.stringify(buttons.map((p) => p.presses)) + ' presses, B has ' + after.presses);
      if (!lights.length || !lights.every((p) => p.on === after.on)) failures.push('V3\'s client shows the light ' + JSON.stringify(lights.map((p) => p.on)) + ', B has ' + after.on);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'press ' + (result.statuses || []).join(', ') + '; client refusals ' + JSON.stringify(v3.live.refusals.map((r) => r.status)) + '; it shows ' + buttons.map((p) => p.presses).join(', ') + ' presses and the light ' + lights.map((p) => p.on).join(', ') + ', as B holds them' };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client that shows its refused press as done', impl: clientEdit('    if (accepted) showWritten(nodeUrl, result.node);', '    showWritten(nodeUrl, result.node || result.sent);') },
  ]);
}

module.exports = { liveChecks };
