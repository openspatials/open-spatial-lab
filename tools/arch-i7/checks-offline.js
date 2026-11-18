'use strict';

/*
 * Iteration 7: B offline, and a world inside a world inside a world.
 *
 *   W6   B's server stops: A's viewer shows a placeholder ("unreachable") at both nodes that include B and keeps
 *        running (a change of A's own table reaches it). When B returns on the same address, the client reconnects
 *        with since=<the last revision it had of B> (iteration 3's resume), never from revision 0, and shows B's
 *        game live again.
 *   W7   B includes world D: A's viewer sees D through B, at level 2 within A's nesting limit (3), where A's
 *        including node, B's including node and D's node put it, and live (a change of D reaches it). A viewer whose
 *        nesting limit is 1 is refused D, and its client state shows the refusal ("nesting limit") at B's node.
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const clientEdit = (from, to) => ({ clientEdits: [[from, to]] });
const observeEdit = (from, to) => ({ observeEdits: [[from, to]] });
const inclusionsOf = (v, target) => v.live.composition.inclusions.filter((i) => i.target === target);

async function offlineChecks(ports) {
  // ---- W6 -----------------------------------------------------------------------------------------------
  await run('W6', 'B\'s server stops: A\'s viewer shows "unreachable" at both nodes that include B and keeps running (A\'s own change reaches it); when B returns the client reconnects with since=<its last revision of B>, not from 0, and shows B\'s game live again', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const v = await lab.viewer(s, 'viewer-v1');
      await lab.settle([v], 600);
      const failures = [];
      const seen = [];
      const stream = v.live.streams.get(s.B.base);
      await s.B.close();
      const stoppedAt = Date.now();
      const lastRevision = stream ? stream.state.revision : null;
      let placeholder = false;
      try {
        await lab.until(() => { const inc = inclusionsOf(v, s.B.worldUrl()); return inc.length === 2 && inc.every((i) => i.status === 'unreachable'); }, 6000, 'the placeholder');
        placeholder = true;
      } catch (e) { failures.push('6 s after B stopped the viewer shows B as ' + JSON.stringify(inclusionsOf(v, s.B.worldUrl()).map((i) => i.status))); }
      const ballsWhileDown = v.live.composition.nodes.filter((n) => n.url === s.urls.ball).length;
      if (placeholder && ballsWhileDown) failures.push('with B unreachable the viewer still shows ' + ballsWhileDown + ' ball(s)');
      const moved = await s.A.req('PUT', lab.nodeRef(s.ids.table), { localTransform: lab.translation(4.5, 0, 3) }, s.tokens.opA);
      let running = false;
      try {
        await lab.until(() => { const t = v.live.composition.nodes.find((n) => n.url === s.urls.table); return t && t.world[12] === 4.5; }, 5000, 'A\'s own change');
        running = true;
      } catch (e) { failures.push('with B down, A\'s own change (PUT ' + moved.status + ') did not reach the viewer'); }
      // B stays down a while, so the client keeps trying its stream meanwhile.
      await lab.sleep(1500);
      seen.push('B stopped at revision ' + lastRevision + '; placeholder ' + JSON.stringify(inclusionsOf(v, s.B.worldUrl()).map((i) => i.status)) + '; A\'s table moved and shown: ' + running);
      s.B = await s.B.again();
      const returnedAt = Date.now();
      try {
        await lab.until(() => {
          const inc = inclusionsOf(v, s.B.worldUrl());
          const balls = lab.ballPlacements(v.live.composition, s);
          return inc.length === 2 && inc.every((i) => i.status === 'included') && s.B.game.log().length >= 3 && Object.keys(balls).length === 2 && v.updates.some((u) => u.at > returnedAt && u.gameLog >= 3);
        }, 10000, 'B shown live again');
      } catch (e) { failures.push('10 s after B returned the viewer shows B as ' + JSON.stringify(inclusionsOf(v, s.B.worldUrl()).map((i) => i.status))); }
      // B's stream (D's, which the viewer reaches through B, is a stream of its own).
      const bEvents = s.B.base.replace(/^http/, 'ws') + 'events';
      const attempts = v.requests.filter((r) => r.at > stoppedAt && r.url.startsWith(bEvents));
      const resumes = attempts.map((r) => r.url);
      const whileDown = attempts.filter((r) => r.at < returnedAt).length;
      if (whileDown < 2) failures.push('while B was down the client tried its stream ' + whileDown + ' time(s)');
      const sinces = resumes.map((u) => (/[?&]since=(\d+)/.exec(u) || [])[1]).map((x) => (x === undefined ? null : Number(x)));
      if (!resumes.length) failures.push('the client never reconnected to B\'s stream');
      else if (!sinces.every((x) => x === lastRevision)) failures.push('the client reconnected with since=' + JSON.stringify(sinces) + ', its last revision of B was ' + lastRevision + ' (' + resumes.join(' ') + ')');
      seen.push(resumes.length + ' reconnect attempt(s) to B\'s stream (' + whileDown + ' while B was down), each with since=' + JSON.stringify([...new Set(sinces)]) + '; B is shown again ("included"), the ball live');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client that starts over from revision 0', impl: observeEdit('"since=" + state.revision;', '"since=0";') },
    { name: 'a client that keeps showing B when B stops (no placeholder)', impl: clientEdit('    if (was !== undefined && (was === "live") !== (state.status === "live")) recompose({ type: "status", base, status: state.status });', '') },
    { name: 'a client whose stream gives up after a connection that never opens (Node\'s WebSocket sends no close then)', impl: observeEdit('    socket.onerror = () => { if (socket.readyState !== 1) end(); };', '    socket.onerror = () => {};') },
    { name: 'a client that closes the stream of a world that stopped answering (it never resumes)', impl: clientEdit('!composition.streams.includes(base) && !unreachable.has(base)', '!composition.streams.includes(base)') },
  ]);

  // ---- W7 -----------------------------------------------------------------------------------------------
  await run('W7', 'B includes world D: A\'s viewer sees D through B at level 2, within A\'s nesting limit, where the three including frames put it, and live; a viewer whose nesting limit is 1 is refused D, and its client state shows "nesting limit" at B\'s node', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const v = await lab.viewer(s, 'viewer-v1');
      const vLimited = await lab.viewer(s, 'viewer-v2', { nestingLimit: 1 });
      const failures = [];
      const seen = [];
      const mul = v.inc.multiply;
      const windowInB = lab.matrixOf(s.B, s.ids.windowToD, mul);
      const markerInD = () => lab.matrixOf(s.D, s.D.marker, mul);
      // Where D's marker belongs in A through each of A's two inclusions of B: A's node, B's node, D's node.
      const expected = () => [s.ids.onTable, s.ids.distant].map((id) => { const m = mul(mul(lab.matrixOf(s.A, id, mul), windowInB), markerInD()); return [m[12], m[13], m[14]]; });
      const placed = () => v.live.composition.nodes.filter((n) => n.url === s.urls.marker);
      /** Whether the marker's records match the expected places one to one. */
      const matches = (records) => { const want = expected(); return records.length === 2 && want.every((w) => records.some((r) => lab.near(r.world.slice(12, 15), w, 1e-6))); };
      const check = (label) => {
        const records = placed();
        if (records.length !== 2) { failures.push(label + ': the viewer shows D\'s marker ' + records.length + ' time(s), not through both of A\'s inclusions of B'); return []; }
        for (const r of records) {
          const graph = v.live.composition.graphs.find((g) => g.instance === r.instance);
          if (r.depth !== 2 || !graph || graph.via !== s.B.nodeUrl(s.ids.windowToD)) failures.push(label + ': D\'s marker at level ' + r.depth + ' through ' + (graph && graph.via));
        }
        if (!matches(records)) failures.push(label + ': D\'s marker at ' + JSON.stringify(records.map((r) => r.world.slice(12, 15))) + ', expected ' + JSON.stringify(expected()));
        return records.map((r) => r.world.slice(12, 15).map((x) => Number(x.toFixed(4))));
      };
      const first = check('at the start');
      const moved = await s.D.req('PUT', lab.nodeRef(s.D.marker), { localTransform: lab.translation(-0.5, 0.25, 2) });
      try {
        await lab.until(() => matches(placed()), 5000, 'D\'s change through B');
      } catch (e) { failures.push('D\'s marker moved (PUT ' + moved.status + '), and the viewer did not show it within 5 s'); }
      const second = check('after D changed');
      const limited = inclusionsOf(vLimited, s.D.worldUrl());
      if (limited.length !== 2 || !limited.every((i) => i.status === 'nesting limit' && i.node === s.B.nodeUrl(s.ids.windowToD))) failures.push('with nesting limit 1 the viewer shows D as ' + JSON.stringify(limited.map((i) => [i.status, i.node])));
      if (vLimited.live.composition.nodes.some((n) => n.url === s.urls.marker)) failures.push('with nesting limit 1 the viewer still shows D\'s marker');
      seen.push('D\'s marker at level 2 through both inclusions of B: ' + JSON.stringify(first) + ', after D moved it ' + JSON.stringify(second));
      seen.push('nesting limit 1: ' + JSON.stringify(limited.map((i) => i.status + ' at ' + i.node.replace(/^.*\/w\/b\//, '{B}/') + ' (' + i.detail + ')')));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client with no nesting limit', impl: clientEdit('    else if (depth > nestingLimit) blocked = INCLUSION_STATUS.NESTING_LIMIT;\n', '') },
    { name: 'a client that puts a world included inside an included world at its own world\'s origin (B\'s including node left out)', impl: clientEdit('      await walk(root.body, rootUrl, multiply(record.world, g.placement), g.placement, {', '      await walk(root.body, rootUrl, multiply(ctx.depth > 0 ? IDENTITY.slice() : record.world, g.placement), g.placement, {') },
  ]);
}

module.exports = { offlineChecks };
