/**
 * source-mutations.js.
 *
 * WHY THIS EXISTS
 * ===============
 * A negative control has to confront the proof with the ACTUAL defect, in the ACTUAL code path.
 * learned that the hard way: its first negative control faked the post-crossing panel from
 * inside the page on a rAF loop, that loop RACED the app's own per-frame gate, and the result was
 * incoherent — the pixel assertion saw a panel over 74% of the centre while the scene-graph
 * assertions saw none, in the same run. A negative control that is itself a race proves nothing.
 *
 * So did the honest thing instead: `git stash push -- web/app.js`, run the proof against
 * the genuinely un-fixed code, `git stash pop`. It went red, hard. But it also flagged the hazard:
 * that stash briefly reverted ANOTHER LANE'S uncommitted work in the same file, and today three
 * lanes are live in web/app.js at once.
 *
 * This is the same negative control without the hazard: the pre-fix source is reconstructed
 * IN FLIGHT, in the dev server, for one isolated run. Nothing on disk is touched, no other lane
 * is disturbed, and the mutation is a source edit — not an in-page monkeypatch that can race the
 * app's own update.
 *
 * SAFETY
 * ======
 * - OFF unless `OSL_SOURCE_MUTATION` names a mutation in this table. Default behaviour is
 *   byte-identical.
 * - REFUSED on the local demo ports (8143 / 18151-18153) — see serve.js.
 * - If the anchor it edits is absent or appears more than once, it THROWS. A mutation that silently
 *   fails or edits an ambiguous seam would produce a negative control that "passed" — i.e. exactly
 *   the false green this change exists to kill.
 * - It prints a loud banner every time it fires. Mutated code must never be mistaken for shipped
 *   code.
 */

'use strict';

const MUTATIONS = {
  /**
   *PRE-FIX. The post-crossing opaque panel.
   *
   * The fix is `updatePortalApertureOcclusion()` (web/app.js): it hides a portal fill surface
   * whose plane SEPARATES the camera from the player's own avatar — the geometry of "I have just
   * come through this portal and I am now looking at the back of it". Before it existed, a
   * 1.76 x 2.74 m DoubleSide ellipse sat ~2.5 m in front of the third-person camera at every
   * arrival and filled the screen.
   *
   * The mutation makes the gate do NOTHING AT ALL — it neither suppresses nor restores. That is
   * the faithful pre-fix state: before this function did not exist, and nothing in the app
   * set `visible` on these surfaces per frame. The aperture is created with no `.visible`
   * assignment at all (web/app.js:1746-1752 — it is visible by default, and the gate may only
   * SUBTRACT), so a no-op gate hands the panel straight back.
   *
   * The first version of this mutation kept the per-frame `restore()`, and that was WRONG in a
   * way worth recording: a per-frame visible-setter the pre-fix app never had RACED own
   * `holdPortalFills()` machinery, and silently neutered its PIXEL assertion [C] — the negative
   * control reported "panel 0% of the centre" while the scene-graph assertions [A]/[B]/[D] were
   * screaming. An unfaithful negative control is just another way to be lied to. The rest of
   * app.js — including the other lanes' live edits — is untouched.
   */
  'panel-gate-off': {
    file: 'app.js',
    describes: 'runtime PRE-FIX: the portal-aperture occlusion gate never suppresses (the post-crossing opaque panel is back)',
    anchor:
      'function updatePortalApertureOcclusion(position, target, cameraMode) {\n' +
      '  const impl = scene && scene._impl;\n' +
      '  const candidates = impl ? portalApertureOcclusionCandidates(impl) : [];\n' +
      '  const restore = () => {\n' +
      '    for (const mesh of candidates) mesh.visible = mesh.userData.portalSurfaceWanted !== false;\n' +
      '  };\n',
    inject:
      '  /* runtime NEGATIVE CONTROL (OSL_SOURCE_MUTATION=panel-gate-off) — pre-runtime behaviour:\n' +
      '     this gate DID NOT EXIST. So it does nothing: it does not suppress, and it does not\n' +
      '     restore either (a per-frame visible-setter the pre-fix app never had would race any\n' +
      '     validation that holds the fills hidden to measure them). void restore() keeps the closure\n' +
      '     referenced without calling it. */\n' +
      '  void restore;\n' +
      '  portalApertureOcclusionDebug = {\n' +
      '    active: false,\n' +
      '    reason: "MUTATED:panel-gate-off",\n' +
      '    camera_mode: cameraMode || null,\n' +
      '    candidate_count: candidates.length,\n' +
      '    surfaces: [],\n' +
      '  };\n' +
      '  return portalApertureOcclusionDebug;\n',
  },

  /**
   *PRE-FIX. The crossing ghost.
   *
   * Before 076 the crossing's presence hand-off was fire-and-forget: `_departPresence(origin)`
   * was called WITHOUT `await`, `_registerPresence(destination)` went out on the very next line,
   * and the exit-intent carried no player_id — so the ORIGIN server had no idea the player had
   * left and the registry's only cleanup was a lost-packet-prone goodbye POST plus a 10-second
   * TTL. The player stayed listed in the world they had just left; the through-ring proxy layer
   * draws LIVE presence membership (portal-spatial-preview.mjs `_destinationAvatars`), so
   * that stale registration was RENDERED as a capsule of the player still standing on the far
   * side of the portal — and as a second copy of themselves when they stepped back.
   *
   * This reverts BOTH halves of the fix, at the wire: no player_id on the exit-intent (so the
   * origin server never departs the player as part of authorizing the exit) and an un-awaited,
   * unordered depart/register pair (so the crossing races its own goodbye). The server-side
   * tombstone stays in the tree — it cannot manufacture the ghost, it can only ever REFUSE a
   * resurrection — which is exactly what a faithful negative control wants: the defect being
   * reintroduced is the CLIENT lifecycle, and it must show up in the SERVER's registry anyway.
   */
  'crossing-depart-fire-and-forget': {
    file: 'live-adapter-portal-traversal-controller.mjs',
    describes:
      'runtime PRE-FIX: the crossing departs the origin fire-and-forget and tells the origin server ' +
      'nothing (the stale-presence ghost / two copies / through-ring proxy are back)',
    edits: [
      {
        anchor:
          '        ...(registration && registration.supported && identity && identity.player_id\n' +
          '          ? { player_id: identity.player_id }\n' +
          '          : {}),\n',
        replace:
          '        /* runtime NEGATIVE CONTROL (OSL_SOURCE_MUTATION=crossing-depart-fire-and-forget):\n' +
          '           pre-fix — the exit-intent carried NO player_id, so the ORIGIN server never\n' +
          '           departed the crossing player from its own registry. */\n',
      },
      {
        anchor:
          '      await presence.departPresence({ base: fromEndpoint.proxy_base, reason: "portal_departure" });\n' +
          '      const destinationRegistration = await presence.registerPresence({ spawnReason: "portal_arrival" });\n',
        replace:
          '      /* runtime NEGATIVE CONTROL: pre-fix — fire-and-forget depart, register on the very\n' +
          '         next line. The two POSTs race, nothing confirms the departure, and the origin\n' +
          '         keeps the player until its goodbye lands (or its 10s TTL fires). */\n' +
          '      presence.departPresence({ base: fromEndpoint.proxy_base, reason: "portal_departure" });\n' +
          '      const destinationRegistration = presence.registerPresence({ spawnReason: "portal_arrival" });\n',
      },
    ],
  },

  /** Part A negative arm: remove only the controlled player_id
   * supplied to the portal-preview manager. The same live/snapshot inputs,
   * render path, real peer, and pixels remain; the self proxy comes back. */
  'runtime-self-filter-off': {
    file: 'app.js',
    describes:
      'runtime NEGATIVE: the portal preview receives no controlled player_id, so a deliberately ' +
      'delivered same-identity avatar renders as a self ghost while the real peer still renders',
    anchor:
      '    isHandoffInFlight: () => adapter._portalTraversalController?.inFlight?.() === true,\n' +
      '    controlledPlayerId: () => adapter.controlledIdentity().player_id,\n',
    replace:
      '    isHandoffInFlight: () => adapter._portalTraversalController?.inFlight?.() === true,\n' +
      '    /* runtime NEGATIVE CONTROL: controlled identity withheld from proxy creation. */\n' +
      '    controlledPlayerId: () => null,\n',
  },

  /** Part B negative arm: the /events frame reaches the browser and is
   * recorded, but the targeted cache/render invalidation is skipped. Poll,
   * stale, and TTL fallbacks remain intact and eventually reconcile it. */
  'runtime-event-consumer-off': {
    file: 'live-adapter-fabric-prefetch-controller.mjs',
    describes:
      'runtime NEGATIVE: user_left reaches the browser but targeted player_id invalidation is disabled; ' +
      'the departed proxy remains until an explicit poll/stale/TTL fallback',
    anchor:
      '  removePresencePlayer({ playerId, targetLocationId, endpointKey, receivedAtMs } = {}) {\n',
    inject:
      '    /* runtime NEGATIVE CONTROL: prove the event arrived, then faithfully omit the new\n' +
      '       consumer/cache invalidation so the stale proxy survives until fallback. */\n' +
      '    const mutatedReceivedAtMs = receivedAtMs == null ? this._nowMs() : receivedAtMs;\n' +
      '    return {\n' +
      '      prefetch_presence_removed: 0, prefetch_snapshot_removed: 0,\n' +
      '      lobby_occupancy_removed: 0, affected_portal_keys: [],\n' +
      '      mutation: "runtime-event-consumer-off", invalidation_skipped: true,\n' +
      '      next_poll_due_at_ms: mutatedReceivedAtMs + 2000,\n' +
      '    };\n' +
      '    void playerId; void targetLocationId; void endpointKey;\n',
    // The accepted deterministic harness still calls the mutation helper
    // with the Patch-13 peer-reducer source. Keep that can-fail command live
    // without moving canonical invalidation back out of the Patch-14 owner: the
    // served negative mutates both the controller and this upstream callback,
    // while the focused Patch-14 proof mutates the controller directly.
    compatibility_files: {
      'live-adapter-peer-presence-reducer.mjs': {
        anchor:
          '    const external = onExternalPresenceDeparture({ ...input, playerId, targetLocationId, receivedAtMs });\n',
        replace:
          '    /* runtime NEGATIVE CONTROL compatibility arm: omit the external cache consumer. */\n' +
          '    const external = {\n' +
          '      prefetch_presence_removed: 0, prefetch_snapshot_removed: 0,\n' +
          '      lobby_occupancy_removed: 0, invalidation_skipped: true,\n' +
          '      next_poll_due_at_ms: receivedAtMs + 2000,\n' +
          '    };\n',
      },
    },
  },
};

/** Names of the mutations this table knows. */
function mutationNames() {
  return Object.keys(MUTATIONS);
}

/**
 * Apply the active mutation to a file about to be served, if any.
 *
 * A mutation is either a single edit ({anchor, inject} — append after the anchor —
 * or {anchor, replace} — swap the anchor out), or a list of them under `edits`
 * (reverting a fix that spans two call sites in one file needs
 * more than one edit, and a PARTIAL revert would be the worst possible negative
 * control — half the bug, silently). EVERY anchor must be found exactly once or the
 * whole serve throws: see the absent/ambiguous guard below.
 *
 * @param {string} relPath  path relative to web/, e.g. "app.js"
 * @param {Buffer} buf      the file's real bytes
 * @returns {Buffer}        the bytes to serve (the same Buffer when no mutation applies)
 */
function applySourceMutation(relPath, buf) {
  const name = process.env.OSL_SOURCE_MUTATION;
  if (!name) return buf;
  const mutation = MUTATIONS[name];
  if (!mutation) {
    throw new Error(
      `OSL_SOURCE_MUTATION="${name}" is not a known mutation (known: ${mutationNames().join(', ')}). ` +
      'Refusing to serve: a mutation that silently does nothing produces a negative control that ' +
      'passes for the wrong reason.'
    );
  }
  const fileMutation = relPath === mutation.file
    ? mutation
    : mutation.compatibility_files && mutation.compatibility_files[relPath];
  if (!fileMutation) return buf;

  const edits = Array.isArray(fileMutation.edits)
    ? fileMutation.edits
    : [ { anchor : fileMutation.anchor, inject : fileMutation.inject, replace : fileMutation.replace } ];

  let out = buf.toString('utf8');
  for (const edit of edits) {
    const firstAnchorAt = out.indexOf(edit.anchor);
    const repeatedAnchorAt = firstAnchorAt === -1 ? -1 : out.indexOf(edit.anchor, firstAnchorAt + 1);
    if (firstAnchorAt === -1 || repeatedAnchorAt !== -1) {
      const anchorFailure = firstAnchorAt === -1 ? 'NOT FOUND' : 'AMBIGUOUS';
      throw new Error(
        `OSL_SOURCE_MUTATION="${name}": anchor ${anchorFailure} in web/${mutation.file}. The code it reverts has ` +
        'moved, changed, or become ambiguous. REFUSING to serve source under a mutation flag — a negative control ' +
        'that quietly ran against the FIXED code would report "the validation did not catch the bug" and be ' +
        'believed. Re-anchor src/source-mutations.js against the current source.\n' +
        `  ${anchorFailure === 'NOT FOUND' ? 'missing' : 'ambiguous'} anchor: ${JSON.stringify(edit.anchor.slice(0, 120))}...`
      );
    }
    out = out.replace(
      edit.anchor,
      typeof edit.replace === 'string' ? edit.replace : edit.anchor + edit.inject
    );
  }
  console.log(
    `[frontend] *** SOURCE MUTATION ACTIVE: ${name} -> web/${relPath} (${edits.length} edit(s)) ***\n` +
    `[frontend] *** ${mutation.describes}\n` +
    '[frontend] *** This is a NEGATIVE CONTROL. The code being served is NOT the code in the tree.'
  );
  return Buffer.from(out, 'utf8');
}

module.exports = { applySourceMutation, mutationNames };
