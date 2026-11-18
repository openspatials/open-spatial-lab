'use strict';

/*
 * Iteration 7, W4: B's visitors, as A's viewers see them.
 *
 *   W4   B's own visitor joins B (presence). V1, for whom B gives host A the presence grant (read on users, acting
 *        for V1), sees B's user_joined event with the visitor's id. V2, without it, sees the same event (the same
 *        revision) with no user id, and nothing V2's client holds of B (the nodes it shows, their labels and
 *        properties, the user events) names the visitor. A's viewers never appear in B: including creates no user,
 *        so B counts one user, its visitor, while A's viewers follow it.
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const serverEdit = (file, from, to) => ({ serverEdits: { [file]: [[from, to]] } });

async function peopleChecks(ports) {
  await run('W4', 'B\'s visitor joins: V1 (B gives host A the presence grant for V1) sees the user_joined event with the visitor\'s id; V2 (no presence grant) sees the same event with no user id and nothing that names the visitor; A\'s viewers never appear in B (B counts one user)', async (impl) => {
    const s = await lab.scene(impl, ports);
    try {
      const v1 = await lab.viewer(s, 'viewer-v1');
      const v2 = await lab.viewer(s, 'viewer-v2');
      const visitor = await lab.visitorOfB(s);
      await lab.settle([v1, v2], 900);
      const failures = [];
      // The visitor's User id, as B's operator (who holds the presence grant) reads it from B's World.
      const opWorld = await s.B.req('GET', 'wow/world', null, await s.B.token('operator'));
      const entry = ((opWorld.json && opWorld.json.webofworlds_extension && opWorld.json.webofworlds_extension.users) || []).find((u) => u && u.source === 'presence-registry');
      const id = entry ? entry.id : null;
      if (id === undefined || id === null) failures.push('B\'s World names no User id for its visitor: ' + JSON.stringify(entry));
      const joined = (v) => (v.live.people[s.B.base] || []).filter((e) => e.type === 'user_joined');
      const j1 = joined(v1);
      const j2 = joined(v2);
      if (j1.length !== 1 || j1[0].user !== id) failures.push('V1 saw user_joined ' + JSON.stringify(j1) + ', not one with the visitor\'s id ' + id);
      if (j2.length !== 1 || j2[0].user !== null) failures.push('V2 saw user_joined ' + JSON.stringify(j2) + ', not one with no user id');
      if (j1.length && j2.length && j1[0].revision !== j2[0].revision) failures.push('V1 saw the join at revision ' + j1[0].revision + ', V2 at ' + j2[0].revision);
      const fromB = (v) => JSON.stringify({
        nodes: v.live.composition.nodes.filter((n) => n.included).map((n) => ({ url: n.url, label: n.label, properties: n.properties })),
        people: v.live.people[s.B.base] || [],
      });
      const names = [lab.VISITOR.player_id, lab.VISITOR.display_name, 'wow/user/' + id + '"', 'wow-user-' + id + '"'];
      const leaks = names.filter((n) => fromB(v2).includes(n));
      if (leaks.length) failures.push('V2\'s client holds ' + JSON.stringify(leaks) + ' of B\'s visitor');
      const v1Sees = fromB(v1).includes(lab.VISITOR.display_name);
      if (!v1Sees) failures.push('V1, with the presence grant, is shown no node that names the visitor');
      const w = await s.B.req('GET', 'wow/world', null, await s.B.token('operator'));
      const count = w.json && w.json.users && w.json.users.active_user_count;
      const listed = ((w.json && w.json.webofworlds_extension && w.json.webofworlds_extension.users) || []).filter((u) => u && u.source === 'presence-registry');
      if (count !== 1) failures.push('B counts ' + count + ' users while A\'s two viewers follow it (its visitor is the one)');
      if (listed.length !== 1) failures.push('B lists ' + listed.length + ' people present: ' + JSON.stringify(listed).slice(0, 200));
      const detail = 'visitor user ' + id + ' joined at revision ' + (j1[0] && j1[0].revision) + '; V1 saw user ' + (j1[0] && j1[0].user) + ', V2 saw user ' + (j2[0] && j2[0].user)
        + '; V2\'s client names the visitor nowhere, V1\'s does; B counts ' + count + ' user(s) and lists ' + listed.length + ' while A\'s viewers follow it';
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail };
    } finally { await s.close(); }
  }, {}, [
    { name: 'user events with their ids to a reader without the presence grant', impl: serverEdit('world-auth-policy.js', '    return withoutPeople(evt);', '    return evt;') },
    { name: 'the node that places a person keeps its label for a reader without the presence grant', impl: serverEdit('world-auth-policy.js', "        if (key === 'label') { out.label = 'User'; continue; }\n", '') },
    { name: 'a world that counts the streams of A\'s viewers as users', impl: serverEdit('runtime-world-reader.js', '            activeUsers : this.presence.livePresenceEntries(Date.now()).length,', '            activeUsers : this.presence.livePresenceEntries(Date.now()).length + this.events.eventSubscriberCount(),') },
  ]);
}

module.exports = { peopleChecks };
