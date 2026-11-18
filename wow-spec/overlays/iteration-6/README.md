# Iteration 6 overlay (permissions: scopes, observers, withdrawal, delegation, hosts and grants on one node)

Three patches against `wow-spec/upstream/wowapi-d39a1a0/`:

- `OpenSpatialWorld.API.yaml.patch`, the World API, after the iteration 1 to 5 patches;
- `OpenSpatialAsset.API.yaml.patch`, the Asset API, after the iteration 1 patch;
- `OpenUserManifest.API.yaml.patch`, the User Manifest API, as vendored.

Each applies on both GeoPose forms of iteration 1 (with and without the two rotation sentences): no hunk touches a
line that differs between the forms, so one patch serves both. The vendored files stay unmodified.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

The edit follows one design: OAuth 2.0 bearer tokens, each bound to one world, grant records that each world
keeps for itself, and token exchange (RFC 8693) for a party that acts for another: an agent for a visitor, a helper
for an agent, or a host for a viewer of a world it includes.

## What it changes

1. **`components.securitySchemes`, in all three files.** One oauth2 scheme, `worldAuth`, with the four scopes. Its
   token URL is relative (`oauth/token`, against the world's base URL), since each world names its own authorization
   server; a client MAY instead use the token endpoint of the server that the world's protected resource metadata
   names.
2. **The scope of each operation.** In the World API: `read` for GET of the World, User, View, Portal, Spatial and
   Node resources; `write` for node POST, PUT and DELETE; `enter` for `POST /wow/user` (joining) and
   `DELETE /wow/user/{userId}` (leaving, own user only). The event stream needs `observe`; it is not an operation of
   the file, so the Authorization paragraph names it. In the Asset and User Manifest APIs: `read` for each operation.
   The web app at `/` stays open.
3. **401 and 403 answers.** Every operation that names a scope gains a 401 (no token, or a token that is expired or
   was issued for another world) and, where it had none, a 403 (the token's grants do not cover the request). On
   `POST /wow/user` the 403 already answers a deny; a 403 with `error="insufficient_scope"` in `WWW-Authenticate` is
   the other refusal, not a deny.
4. **The join answer names the scopes granted.** `JoinAnswer.scope` lists the scopes the world grants the visitor,
   space-delimited, each once. They MUST equal the grant records the world holds for that visitor. This extends the
   one handshake of iteration 5 in place; it is not a second handshake. The answer still grants no permission: the
   grant records do.
5. **The Authorization paragraph**, in the World API's description. A world MAY require a token. One that does:
   - MUST name its authorization servers in protected resource metadata (RFC 9728) at
     `{origin}/.well-known/oauth-protected-resource{path prefix}`, and a client MUST use it only when its `resource`
     equals the world's base URL;
   - binds each token to itself: the audience is its base URL (RFC 8707), compared exactly, so two worlds on one
     origin at `/w/b` and `/w/bb` refuse each other's tokens;
   - MUST keep its own grant records (a subject, a scope, a resource; they MAY expire or be withdrawn), and MUST
     read them at each request, so a withdrawn grant refuses the holder's next request;
   - grants on one node: a write grant MUST name one node, or the whole world, and one on a node MUST NOT cover
     another node; observe and enter grants MUST cover the whole world;
   - MUST need, for `GET /wow/user/{userId}`, a read grant that names the world's User resources, and MUST NOT show
     people to a reader without it: on the event stream, `user_joined` and `user_left` reach that observer without
     user ids, with their revision, so every observer still sees every revision;
   - answers no token with 401 and `WWW-Authenticate: Bearer` with no error code, an expired token or one for another
     world with 401 and `error="invalid_token"`, and a token whose grants do not cover the request with 403 and
     `error="insufficient_scope"` (RFC 6750, sections 3 and 3.1), the code in the header, not only in a body;
   - MUST NOT carry `resource_metadata` in the 401: RFC 9728, section 3.3 would then require the metadata's
     `resource` to equal the request's own URL, which differs from the base URL for every resource below it;
   - takes the token as the event stream's first message, because a browser cannot add a header to a WebSocket
     (the stream authentication paragraph of iteration 3), and MUST close the stream of a holder whose observe grant
     is withdrawn, or whose token expires, within 5 seconds;
   - MUST NOT accept a token in a URL;
   - the token-exchange profile (RFC 8693). Who may act: a party for which the world holds a grant record that lets
     it act for the party acted for (the subject, or the current actor of a chain). The world MAY issue such a
     token at its token endpoint, with the token of the party acted for as `subject_token` and a token of the actor
     as `actor_token`. The token MUST carry the `act` claim with the current actor outermost and each earlier actor
     nested in it (RFC 8693, section 4.1). The world MUST decide each request on the current actor's grant record,
     not on the subject's, and MUST log the subject and the whole chain with each decision. A record for acting MUST
     NOT cover the actor's requests with its own token, so a host writes into an included world only with a token
     that world issued by exchange (the viewer's token as the subject, the host by its base URL as the actor).
     Whose tokens a world accepts as the subject: its own, and those of an issuer it lists as trusted, whose
     audience is the world's base URL or the actor; any other, also from an issuer it has stopped trusting, MUST be
     refused with `error="invalid_request"` (RFC 8693, section 2.2.2);
   - MUST be served over HTTPS outside test environments.
   Sender-constrained tokens (DPoP, RFC 9449) are the next step, and are not yet required.
6. **OpenAPI 3.0.4 for the Asset and User Manifest files**, as the World file already is. This is the last §5.3.5
   erratum.

`required` lists: iteration 6 adds none. `JoinAnswer.scope` is optional, because a world that requires no token has
no grants to name.

## Apply

Apply iterations 1 to 5 first, then this, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && (for p in wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-1/OpenSpatialAsset.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch wow-spec/overlays/iteration-3/*.patch wow-spec/overlays/iteration-4/*.patch wow-spec/overlays/iteration-5/*.patch wow-spec/overlays/iteration-6/*.patch; do patch -d "$copy" -p1 < "$p" || exit 1; done) && echo "$copy"
```

For the form without the rotation sentences, use the iteration 1 and iteration 2 patches in their
`without-rotation-sentences/` folders; the iteration 3 to 6 patches are the same.

`npm run arch-i6-proof` applies it with its own applier, on both forms. Check W1 validates the three patched files
against the OpenAPI 3.0 schema and checks the version, the scheme and each operation's scope and answers. Check W2
checks that the text offered here is the contract served, and runs the G1 wire half against a world that requires a
token. Check W3 checks the key words and the BCP 14 paragraph. Check W4 checks that no line added by any overlay of
iterations 1 to 6 names another project, an implementation's own labels, a person or an outside identity format.
Checks G1 to G6 check the behaviour itself (G4 delegation and chains, G5 hosts and trusted issuers, G6 grants on
one node). `npm run arch-overlays-proof` runs W1 to W4 with the earlier iterations.

Nothing here has been sent upstream.
