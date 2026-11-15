# Iteration 3 overlay

Three patches against the Web of Worlds files in `wow-spec/upstream/wowapi-d39a1a0/` (WoWAPI `main` is d39a1a0).
They are the edits proposed upstream for iteration 3, "Live state and observation with no session". They
apply after the iteration 1 and iteration 2 patches. The vendored files stay unmodified.

- `OpenSpatialWorld.API.yaml.patch`: the World API.
- `OpenSpatialWorld.README.md.patch`: the World README.
- `OpenSpatialWorld.context.jsonld.patch`: a new file, `specification/OpenSpatialWorld/schema/context.jsonld`, beside
  `world.schema.json`.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

## What they change

World API:

1. **Events.** The event stream simpleWorlds already ships (`user_joined`, `user_left`, `node_created`,
   `node_updated`, `node_deleted`) is written into the description. A world that offers it MUST list it under
   `services.events`. Each event MUST carry `type` and:
   - `revision`: this world's count of its changes, one higher for each;
   - `time`: the server's UTC time of the change (RFC 3339);
   - `urls`: every resource whose representation changed, relative to the world's base URL. That is the
     User for a user event, the node and every ancestor that embeds it for a node event, and `wow/world`,
     which reports the revision.

   The payload is simpleWorlds': `user_joined` carries `user`, `user_left` `userId`, `node_created` and
   `node_updated` the whole `node`, and `node_deleted` `nodeId`. Whether it should carry the whole node or a JSON
   Patch is left open. A new `Event` schema gives the payload, with `required: [type, revision, time, urls]`. simpleWorlds today creates a Guest user for each `/events` connection and announces it
   with `user_joined` (`packages/wow-backend/src/index.ts`, lines 30 to 51, at `d2bda3e`). The offered text says
   subscribing creates no user, so simpleWorlds would change.
2. **Resume.** A client MAY resume with `since=<revision>`. A world that can no longer replay from there MUST
   send `resync` with its current revision, and the client MUST then re-read. The revision MUST survive
   restarts, and `World.revision` reports the current one.
3. **No-op writes.** A write that changes nothing MUST NOT produce a revision or an event.
4. **Service list.** `World.services.events` names the event stream, relative to the base URL. This replaces
   a separate service file.
5. **Stream authentication.** A world MAY require authorization for its stream. The token MUST then be the
   stream's first message, the JSON text `{"type": "auth", "token": "<access token>"}`, and MUST NOT appear in a
   URL. The world MUST close a stream without a valid token within 5 seconds, and MUST refuse a stream from an
   origin its policy does not allow.
6. **Data on nodes.** `Node.properties` is optional: a JSON-LD node object whose `@type`, expanded through its
   `@context`, types the node. The context is its own document, `schema/context.jsonld`, beside
   `world.schema.json`. Its terms (`Environment`, `temperature`) and its namespace are provisional. A node typed
   `wow:Environment` belongs, with its subtree, to its world's environment, which does not apply when another
   world includes it.
7. **Data points.** A data point is a resource URL with a JSON Pointer fragment, which the media type of
   iteration 2 allows. The pointer MUST NOT pass through `children`. Reading, conditional reading and
   subscribing MUST NOT create a user.

README:

- The preview line, cut off at "experence world without", is completed: "experience the world without
  joining it: a preview MUST NOT create an additional user, but user-based authorization still applies".
- New line: reading, conditional reading and subscribing to a world's events MUST NOT create a user.
- The README already carries the BCP 14 paragraph once, from iteration 2; iteration 3 does not add a second.

`required` lists: `World` keeps no required member, so a world without a graph, an event stream or a revision
stays valid; `World.revision` and `World.services` are optional, and the members of `services` are strings, which
carry no list. `Node` keeps `[id]`. The new `Event` requires `[type, revision, time, urls]`; every event the lab's
world servers send carries them.

## Apply

Apply iterations 1 and 2 first, then these, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && (for p in wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch wow-spec/overlays/iteration-3/*.patch; do patch -d "$copy" -p1 < "$p" || exit 1; done) && echo "$copy"
```

`npm run arch-i3-proof` applies them with its own applier. It validates the patched World API against the
OpenAPI 3.0 schema (check W1). It also checks that the text offered here is the contract this lab serves,
that the served context holds the offered terms, and that the world servers behave as described, `required`
lists and the `Event` schema included (check W2). Check W3 checks the key words, the `required` lists above
(offered on both GeoPose forms, served, and built into `wow-spec/generated/schema.json`), and that the World API,
the World README and this file each carry the BCP 14 paragraph once. `npm run arch-overlays-proof` runs W1 to W3
with no browser.

Nothing here has been sent upstream.
