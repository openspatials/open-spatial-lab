'use strict';

/*
 * Iteration 2, reads and writes across worlds.
 *
 *   I4   conditional reads: 304 when nothing changed; 200 with a new entity tag after B moves node n,
 *        and A shows the move
 *   I4b  lost updates: a PUT with a stale If-Match gets 412; the client reads again, retries, and the
 *        second write succeeds without undoing the other writer's change
 */

const { run } = require('../arch-i1/lib');
const w = require('./worlds');
const { baseScene, placementsVia } = require('./scenario');

const at = (inc, record) => inc.transformPoint(record.world, [0, 0, 0]);
const withoutChildren = (node) => { const copy = Object.assign({}, node); delete copy.children; return copy; };

async function readChecks(ports) {
  // ---- I4 ---------------------------------------------------------------------------------------------
  const tagChangesEveryTime = { serverEdits: { server: [['            const etag = wowEtag(type, body);', '            const etag = wowEtag(type, body + Math.random());']] } };
  const clientNeverRevalidates = { clientEdits: [['    if (kept && kept.etag) headers["If-None-Match"] = kept.etag;\n', '']] };
  await run('I4', 'read again with If-None-Match, every unchanged resource answers 304; after B moves node n, the reads that hold n answer 200 with a new entity tag and A shows n at its new place', async (impl) => {
    const s = await baseScene(impl, ports);
    try {
      const failures = [];
      const reader = s.inc.createWowReader({ fetch });
      await s.compose({ reader });
      const firstCount = reader.log.length;
      const again = await s.compose({ reader, revalidate: true });
      const second = reader.log.slice(firstCount);
      const notModified = second.filter((e) => e.status === 304).length;
      if (!second.length || notModified !== second.length) failures.push(`unchanged: ${notModified} of ${second.length} reads answered 304`);
      const [nY1] = placementsVia(again, s.urls.n, s.urls.Y);
      if (!nY1) return { ok: false, detail: 'n is not shown under Y' };
      const tagBefore = reader.cache.get(s.urls.n).etag;

      // B moves node n (a plain write at B, with no precondition).
      const before = await s.B.node(1, s.ids.n);
      const moved = await s.B.put(1, s.ids.n, Object.assign(withoutChildren(before.json), { localTransform: w.translation(3, 0, 0) }));
      if (moved.status !== 200) return { ok: false, detail: 'B could not move n: ' + moved.status };

      const thirdStart = reader.log.length;
      const after = await s.compose({ reader, revalidate: true });
      const third = reader.log.slice(thirdStart);
      const changed = third.filter((e) => e.status === 200);
      const nRead = third.find((e) => e.url === s.urls.n);
      if (!nRead || nRead.status !== 200) failures.push('the read of node n (under Y) answered ' + (nRead ? nRead.status : 'nothing'));
      if (nRead && reader.cache.get(s.urls.n).etag === tagBefore) failures.push('node n kept its old entity tag');
      const untouched = third.filter((e) => e.url === s.A.spatialUrl(1));
      if (!untouched.length || untouched.some((e) => e.status !== 304)) failures.push('A\'s own Spatial did not answer 304 after B\'s change');
      const [nY2] = placementsVia(after, s.urls.n, s.urls.Y);
      const [nX2] = placementsVia(after, s.urls.n, s.urls.X);
      const yAt = at(s.inc, after.registry.get(s.urls.Y)[0]);
      const xAt = at(s.inc, after.registry.get(s.urls.X)[0]);
      if (!nY2 || Math.abs(at(s.inc, nY2)[0] - yAt[0] - 0.03) > 1e-12) failures.push('under Y, n is not 0.03 m along x after the move');
      if (!nX2 || Math.abs(at(s.inc, nX2)[0] - xAt[0] - 3) > 1e-12) failures.push('under X, n is not 3 m along x after the move');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `unchanged: ${notModified}/${second.length} reads 304; after the move ${changed.length} reads 200 with new tags, ${third.length - changed.length} still 304; n now 0.03 m along Y's x and 3 m along X's` };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a B whose entity tag changes on every read', impl: tagChangesEveryTime },
    { name: 'a client that never sends If-None-Match', impl: clientNeverRevalidates },
  ]);

  // ---- I4b --------------------------------------------------------------------------------------------
  const ignoresIfMatch = { serverEdits: { server: [[
    '                        if (ifMatchFails(req, current ? readableNode(graphIdOf(spatialID), current) : null))',
    '                        if (false && ifMatchFails(req, current ? readableNode(graphIdOf(spatialID), current) : null))',
  ]] } };
  const retriesWithStaleTag = { clientEdits: [['    node = null; // read again: someone else changed it\n    etag = null;\n', '']] };
  await run('I4b', 'a PUT to node n with a stale If-Match gets 412; the client reads n again and retries, the second write succeeds, and the other writer\'s change is kept', async (impl) => {
    const s = await baseScene(impl, ports);
    try {
      const failures = [];
      // Writer 1 reads n.
      const read1 = await s.B.node(1, s.ids.n);
      const staleTag = read1.headers.etag;
      // Writer 2 moves n.
      const writer2 = await s.inc.writeNodeSafely(s.urls.n, (node) => Object.assign(withoutChildren(node), { localTransform: w.translation(4, 0, 0) }), { fetch });
      if (writer2.status !== 200) failures.push('writer 2 could not move n: ' + writer2.statuses.join(', '));
      // Writer 1 writes with the tag it read: refused.
      const stale = await s.B.put(1, s.ids.n, Object.assign(withoutChildren(read1.json), { label: 'node n (renamed)' }), { 'If-Match': staleTag });
      if (stale.status !== 412) failures.push('a PUT with a stale If-Match answered ' + stale.status);
      // Writer 1 through the client: starts from its stale read, gets 412, reads again, retries.
      const writer1 = await s.inc.writeNodeSafely(s.urls.n, (node) => Object.assign(withoutChildren(node), { label: 'node n (renamed)' }), { fetch, etag: staleTag, node: read1.json });
      if (writer1.status !== 200 || writer1.statuses.join(',') !== 'PUT 412,GET 200,PUT 200') failures.push('the retry went: ' + writer1.statuses.join(', '));
      const final = (await s.B.node(1, s.ids.n)).json;
      if (!final || final.label !== 'node n (renamed)') failures.push('writer 1\'s change is missing');
      if (!final || final.localTransform[12] !== 4) failures.push('writer 2\'s move was lost (x = ' + (final && final.localTransform[12]) + ')');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `stale If-Match: 412; client retry: ${writer1.statuses.join(', ')}; both changes kept` };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a B that ignores If-Match on PUT', impl: ignoresIfMatch },
    { name: 'a client that retries with the stale tag instead of reading again', impl: retriesWithStaleTag },
  ]);
}

module.exports = { readChecks };
