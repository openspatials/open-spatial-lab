# Mutation Evidence

Copyright 2026 Open Spatial Lab contributors. SPDX-License-Identifier: Apache-2.0.

The normal corpus run and a deliberate in-memory mutation were executed on 2026-07-14. No corpus file is changed by mutation mode.

## Normal gate

Command:

```bash
node wow-spec/conformance-fixtures/run.mjs
```

Observed result:

```text
RESULT PASS (44/44 fixtures; D1-D8 cross-linked; standards_conformance remains unclaimed)
```

Exit status: `0`.

## Deliberate mutation

Command:

```bash
node wow-spec/conformance-fixtures/run.mjs --mutate schema-world-rich-valid
```

Observed result:

```text
FAIL schema-world-rich-valid -> GAP: expected accept, validator rejected: $: expected object
RESULT FAIL (43/44 fixtures passed; 1 gate error(s))
- schema-world-rich-valid: expected accept, validator rejected: $: expected object
```

Exit status: `1`.

This proves the runner is a can-fail gate rather than a print-only status report.

## Independent compatibility check

The 36 schema-backed fixtures in `schema-cases.json` and `endpoint-cases.json` were also evaluated against the project's full AJV validator. Observed result: `36` evaluated, `0` outcome mismatches.
