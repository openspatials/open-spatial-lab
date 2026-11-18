# Iteration 5 overlay (stage A: the identity handshake)

One patch against the World API in `wow-spec/upstream/wowapi-d39a1a0/` (WoWAPI `main` is d39a1a0):
`OpenSpatialWorld.API.yaml.patch`. It is the edit proposed upstream for stage A of iteration 5, "Carried
identity", and it applies after the iteration 1, 2, 3 and 4 patches, on both GeoPose forms of iteration 1
(with and without the two rotation sentences). Its hunks touch no line that differs between the two forms,
so one patch serves both. The vendored files stay unmodified.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

A user manifest overlay (the claim names, and the text that claims are proven by reference) is not here.
Stage B (issued items, consent before the avatar) is not here either.

## What it changes

1. **World.identity.** Who the world is: the base URL it stands behind. A visitor's agent MUST check that it
   is the base URL it is about to post to before it discloses anything.
2. **World.claims.** The claims the world asks a visitor for when the visitor joins, each a claim name marked
   required or optional. A visitor's agent MUST send only these. When `issuers` is present, the claim MUST
   count only when one of those issuers signed it. A claim is "issuer-verified" only when an issuer the world
   lists signed it. A credential from any other issuer, the visitor's own key included, MUST leave the claim
   "self-asserted". The claim names are provisional.
3. **World.issues.** The credential types the world issues. It MAY be empty (it is, until stage B).
4. **POST /wow/user.** Joining. The body (`UserJoin`) MUST carry a signed manifest holding only the claims
   the world asks for, and a holder proof made for this world and this visit. The answer (`JoinAnswer`) states
   the outcome (proceed, proceed-in-part or deny), the claims satisfied and not satisfied, each marked required
   or optional, and the User the visitor now is (not on deny). A required claim not satisfied MUST give deny.
   A world MUST record every outcome. The answer MUST NOT grant a permission, and names no scope. 201 for
   proceed and proceed-in-part, 403 for deny, 400 for a body that is not a join, 404 for a world that takes no
   joins.
5. **A paragraph on joining** in the API's description. Joining is OPTIONAL for a world. A world that states
   `identity` MUST also state `claims` and `issues`. A world that states no identity takes no joins, and the
   rules of the paragraph do not apply to it. The agent MUST check `identity.base` before it discloses anything. Claim values, and anything else about the visitor, MUST NOT appear in a URL. What is
   made for one world and one visit (the pointer, the signatures, the holder proof and its nonce) MUST NOT be
   reused for another world, and the claim values a world asks for are disclosed to that world. It does not
   say that nothing in a join can identify the visitor: the claim values themselves go to every world that
   asks for them.
6. **Following, beside the join.** A paragraph in the API's description. A page opened at a world's URL with
   `#follow` MUST join that world as a new or existing user, as a page opened at that URL does, and the
   fragment's verb MUST be matched case-insensitively. With `#follow=user.{id}` the client MUST place the
   visitor at the node that places that user (`User.node`) and MUST keep the visitor there while that user
   moves. When that user is no longer present, the client SHOULD stop following and leave the visitor where it
   stands.
7. **Departing, beside the join.** A paragraph in the API's description, and the same text on
   `DELETE /wow/user/{userId}`. The delete MUST end that user's visit: afterwards the user MUST no longer be
   present. A world that offers an event stream MUST send `user_left` for that user on it, once. The world MUST
   NOT remove the record of that user's join outcome.
8. **The pilot statement, `User.pilot`.** A join carries `pilot` (`UserJoin`), the visitor's statement of
   who is at the controls: `human` (a person), `agent` (software acting alone) or `hybrid` (a person and
   software together). A world MUST copy it onto the User it makes, as `User.pilot`, and MUST NOT supply
   `human`, `agent` or `hybrid` when the visitor stated none. A join whose `pilot` is present with another
   value MUST be answered with deny and the reason. A world MUST NOT refuse a join only because it states no
   pilot. It MUST record and show that join as not stated (`User.pilot` is `unstated`), and it MUST NOT treat
   it as human. The value is the visitor's statement, not proof of who is at the controls: a world and a
   client MUST treat it as a statement only. A client MUST show a user whose pilot is `hybrid` as an agent,
   and one whose pilot is `unstated` as not stated, wherever it shows that user's name or label. `pilot` is
   not in `UserJoin`'s `required` list and has no type there, so that a join without it, or with any other
   value, reaches the world, which answers it and records the outcome like every other.

`required` lists: `World` keeps no required member, and neither does `World.identity`, so a world that states
no identity, claims or issues is still valid. `UserJoin` requires `[manifest, proof]`, and `JoinAnswer`
`[outcome, satisfied, not_satisfied]`. Each claim item, as asked for in `World.claims` and as answered in
`JoinAnswer.satisfied` and `JoinAnswer.not_satisfied`, requires `[name, required]`. `reason`, `user`, `trust`
and `issuers` stay optional: a proceed has no reason, a deny names no User, and a claim without `issuers`
accepts any signer.

## Naming: `claims`, not `requires`

The iteration 5 order and the roadmap call the field `requires`. Elsewhere `requires` already names a list of
features that a receiving world has to understand before it accepts an arrival: there the arriving side states
what the world supports. Here the world states what the visitor presents. One word would carry two meanings,
so the overlay uses `claims`. The order allows another name.

## Formats given by reference

The patch names no manifest format and no holder-proof format; both are given "by reference". The lab's own
shapes, in `web/wow-handshake.mjs`, are a proposal for the proof, not a conformance claim for any manifest
format.

## Apply

Apply iterations 1 to 4 first, then this, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && (for p in wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch wow-spec/overlays/iteration-3/*.patch wow-spec/overlays/iteration-4/*.patch wow-spec/overlays/iteration-5/*.patch; do patch -d "$copy" -p1 < "$p" || exit 1; done) && echo "$copy"
```

For the form without the rotation sentences, use the iteration 1 and iteration 2 patches in their
`without-rotation-sentences/` folders; the iteration 3, 4 and 5 patches are the same.

`npm run arch-i5-proof` applies it with its own applier, on both forms. It validates the patched World API
against the OpenAPI 3.0 schema (check W1). It also checks that the text offered here is the contract this lab
serves and that the world servers behave as described, `user_joined` and `user_left` on the event stream included (check W2). Checks SE1 (following, in a browser) and SE2 (departing) check the behaviour itself. Check ID10 checks the pilot
statement: the world copies it onto the User, refuses a join with another value, lets a join without one
proceed with `User.pilot` `unstated` (never `human`) and records it so, and a client shows `hybrid` as an
agent and `unstated` as not stated; W2 checks that `GET /wow/user/{id}` carries it on the wire, `unstated`
included. Check W3 checks the key words, that the joining paragraph makes joining opt-in and states no rule
for every world, and the `required` lists above, on both GeoPose forms of iteration 1, offered, served and built, and that the World API
and this file each carry the BCP 14 paragraph once. Check W4 checks that no line added by any overlay of
iterations 1 to 5, in either form, names another project, an implementation, an implementation's own labels
or a person. `npm run arch-overlays-proof` runs W1 to W4 with no browser.

Nothing here has been sent upstream.
