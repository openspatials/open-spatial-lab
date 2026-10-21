# OpenSpatialWorld Conformance Fixtures

Copyright 2026 Open Spatial Lab contributors. SPDX-License-Identifier: Apache-2.0.

This is a portable, dependency-free fixture set offered to the OpenSpatialWorld maintainers with no strings attached under Apache-2.0. It is pinned to the canonical schema surface at `WoWAPI@d39a1a0`; it does not claim that Open Spatial Lab or any other implementation is standards-conformant.

## Run

Node.js 20 or newer is the only runtime requirement:

```bash
node run.mjs
```

The runner exits zero only when every fixture produces its declared result, the six schema and six implemented endpoint families each retain minimal-valid, rich-valid, and negative coverage, all machine-readable files declare Apache-2.0, and D1–D9 each have an exercising fixture.

## Prove the gate can fail

Mutation mode corrupts one selected fixture without editing the corpus:

```bash
node run.mjs --mutate schema-world-rich-valid
```

That command must exit non-zero. It demonstrates that the normal green result is not a print-only report.

## Result classes

- `CONFORMANT` means the pinned schema accepted a positive fixture or rejected a negative fixture as expected.
- `DECLARED-DIVERGENCE(D#)` means the runnable fixture exercises a specifically named OSL departure; it is not cosmetic green.
- `RETIRED(D#)` means OSL once departed from the standard in a named way and no longer does. The fixture shows both sides agreeing, and says in which iteration the departure ended.
- `GAP` means the relevant canonical surface is absent or omitted in OSL.
- `SPEC-UNDER-CONSTRAINED` means the published schema permits a payload that a reader may reasonably expect to be too weak, most visibly `{}`.

The canonical schemas contain no required properties. Therefore `{}` is an explicit minimal-valid and `SPEC-UNDER-CONSTRAINED` result for World, User, Node, Portal, View, and Spatial. The suite never invents an RFC-2119 requirement to turn that observation into a rejection.

## Corpus layout

- `upstream-schema-subset.json` is the portable canonical subset consumed by the runner.
- `fixtures/schema-cases.json` covers World, User, Node, Portal, View, and Spatial.
- `fixtures/endpoint-cases.json` covers the six implemented GET endpoint families.
- `fixtures/divergence-cases.json` exercises D1–D9.
- `divergences.json` is the compact cross-link register derived from `wow-spec/OSL-WOW-CONTRACT.md` section 9.

## Boundaries

The evaluator implements only the JSON Schema keywords present in this pinned subset. It is not a replacement for a full JSON Schema implementation. Endpoint fixtures validate contract payloads offline; they do not make network requests or claim live-server conformance. `standards_conformance` remains `false` in Open Spatial Lab data.

See the full project-side rationale and upstream references in `../OSL-WOW-CONTRACT.md`.
