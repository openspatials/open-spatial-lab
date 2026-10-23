#!/usr/bin/env node
// additive adversarial regression gate for the
// demo-local statusRef resolver and the RP1 active-required fail-closed policy.

import {
  buildStatusEndpointResponse,
  evaluateStatusRef,
  makeDemoStatusAuthority,
  REASON_CURSOR_REGRESSION,
  REASON_MANIFEST_ID_MISMATCH,
} from "./statusref-resolution.mjs";

const MANIFEST_ID = "urn:uuid:runtime-statusref";
const STATUS_REF = "https://status.demo.local/manifests/statusref";
const UPDATED_AT = "2026-07-05T12:00:00.000Z";
let resistedCount = 0;
const findings = [];

function resisted(id, title, detail) {
  resistedCount += 1;
  console.log(`[${id}] ${title}`);
  console.log(`      RESISTED: ${detail}`);
}

function vulnerable(id, title, severity, repro) {
  findings.push({ id, title, severity, repro });
  console.log(`[${id}] ${title}`);
  console.log(`      ⚠️VULNERABLE (${severity}): ${repro}`);
}

function expect(id, title, safe, detail, severity, repro) {
  if (safe) resisted(id, title, detail);
  else vulnerable(id, title, severity, repro);
}

function body(status, cursor = "v10", manifestId = MANIFEST_ID) {
  return buildStatusEndpointResponse({ manifestId, status, updatedAt: UPDATED_AT, ...(cursor === undefined ? {} : { cursor }) });
}

function run({ status = "active", cursor = "v10", manifestId = MANIFEST_ID, responseManifestId = MANIFEST_ID, httpStatus = 200, transport, statusRef = STATUS_REF, policy = "active-required", lastSeenCursor, revocationCursor } = {}) {
  const wire = transport || (() => ({ httpStatus, body: body(status, cursor, responseManifestId) }));
  return evaluateStatusRef({ statusRef, manifestId, revocationCursor, lastSeenCursor, transport: wire, policy });
}

function denied(result) {
  return result?.result === "reject" && result?.outcome === "rejected";
}

console.log("runtime statusRef resolution — ADVERSARIAL HARDENING HARNESS");
console.log("================================================================");
console.log("Attacking stale/cached status, TOCTOU, malformed transport, missing binding, policy downgrade, and status confusion.\n");

const active = run();
expect("AV-0", "confirmed active status control", active.result === "accept" && active.revocationStatus === "active", "a bound 200 response with active status remains accepted", "critical", `control returned ${active.result}/${active.revocationStatus}`);

const revoked = run({ status: "revoked" });
expect("AV-1", "revoked status treated as active", denied(revoked) && revoked.revocationStatus === "revoked", "revoked is preserved and rejected", "critical", `revoked returned ${revoked.result}/${revoked.revocationStatus}`);

const suspended = run({ status: "suspended" });
expect("AV-2", "suspended/revoked confusion under active-required", denied(suspended) && suspended.revocationStatus === "suspended", "suspended is distinct but still not active and therefore rejected", "critical", `suspended returned ${suspended.result}/${suspended.revocationStatus}`);

const failures = [
  run({ transport: () => null }),
  run({ transport: () => { throw new Error("network"); } }),
  run({ httpStatus: 404 }),
  run({ httpStatus: 503 }),
  run({ transport: () => ({ httpStatus: 200, body: { manifestId: MANIFEST_ID, status: "active" } }) }),
];
expect("AV-3", "unreachable/404/503/malformed endpoint fail-open", failures.every(denied), "every unresolvable status remains unchecked and rejected under active-required", "critical", failures.map((r) => `${r.reason}:${r.result}`).join(", "));

const missingRef = evaluateStatusRef({ manifestId: MANIFEST_ID, transport: () => ({ httpStatus: 200, body: body("active") }), policy: "active-required" });
const insecureRef = run({ statusRef: "http://status.demo.local/manifests/runtime" });
expect("AV-4", "missing or non-HTTPS statusRef", denied(missingRef) && denied(insecureRef), "unbound/insecure resolution cannot confirm active", "critical", `missing=${missingRef.result}, insecure=${insecureRef.result}`);

const mismatch = run({ responseManifestId: "urn:uuid:other-manifest" });
expect("AV-5", "status response swapped across manifests", denied(mismatch) && mismatch.reason === REASON_MANIFEST_ID_MISMATCH, "response manifestId must match the evaluated manifest", "critical", `mismatch returned ${mismatch.result}/${mismatch.reason}`);

const missingManifestBinding = evaluateStatusRef({ statusRef: STATUS_REF, transport: () => ({ httpStatus: 200, body: body("active") }), policy: "active-required" });
expect(
  "AV-6",
  "missing evaluated manifestId binding",
  denied(missingManifestBinding) && missingManifestBinding.reason === REASON_MANIFEST_ID_MISMATCH,
  "an active response cannot be accepted when there is no manifest identity to bind",
  "critical",
  `missing manifestId returned ${missingManifestBinding.result}/${missingManifestBinding.revocationStatus}`
);

const staleFloor = run({ cursor: "v4", revocationCursor: "v9" });
expect("AV-7", "issuance-floor stale active replay", denied(staleFloor) && staleFloor.reason === REASON_CURSOR_REGRESSION, "a lower cursor cannot resurrect active status", "critical", `v4 below v9 returned ${staleFloor.result}/${staleFloor.reason}`);

const missingCursorAtFloor = evaluateStatusRef({
  statusRef: STATUS_REF,
  manifestId: MANIFEST_ID,
  revocationCursor: "v9",
  transport: () => ({ httpStatus: 200, body: buildStatusEndpointResponse({ manifestId: MANIFEST_ID, status: "active", updatedAt: UPDATED_AT }) }),
  policy: "active-required",
});
expect(
  "AV-8",
  "cursor floor bypass via omitted response cursor",
  denied(missingCursorAtFloor) && missingCursorAtFloor.reason === REASON_CURSOR_REGRESSION,
  "when a floor exists, a response without comparable cursor diagnostics remains unchecked and denied",
  "critical",
  `cursorless active response returned ${missingCursorAtFloor.result}/${missingCursorAtFloor.revocationStatus}`
);

const cachedFloor = run({ cursor: "v8", revocationCursor: "v5", lastSeenCursor: "v12" });
expect("AV-9", "cached high-water mark rollback", denied(cachedFloor) && cachedFloor.reason === REASON_CURSOR_REGRESSION, "the higher last-seen cursor defeats cached active rollback", "critical", `v8 after v12 returned ${cachedFloor.result}/${cachedFloor.reason}`);

const unexpectedStatuses = [201, 204, 302].map((httpStatus) => run({ httpStatus }));
expect(
  "AV-10",
  "unexpected 2xx/3xx status with an active body",
  unexpectedStatuses.every(denied),
  "only the specified 200 response is resolution diagnostics",
  "high",
  unexpectedStatuses.map((r, i) => `${[201, 204, 302][i]}:${r.result}`).join(", ")
);

let unknownPolicyRejected = false;
try {
  run({ policy: "fail-open" });
} catch {
  unknownPolicyRejected = true;
}
expect("AV-11", "unknown policy downgrade", unknownPolicyRejected, "unknown policy tokens are rejected", "critical", "policy=fail-open was evaluated");

let paddedPolicyRejected = false;
try {
  run({ policy: "spec-default " });
} catch {
  paddedPolicyRejected = true;
}
expect("AV-12", "shape-coerced spec-default downgrade", paddedPolicyRejected, "a near-match cannot silently select the permissive policy", "critical", "policy=spec-default<space> was accepted");

const swappedStatusRef = run({
  statusRef: "https://status.demo.local/manifests/other",
  responseManifestId: "urn:uuid:other-manifest",
});
expect("AV-13", "post-sign statusRef swap to another active manifest", denied(swappedStatusRef) && swappedStatusRef.reason === REASON_MANIFEST_ID_MISMATCH, "identity binding prevents a swapped status endpoint from elevating trust", "critical", `swapped statusRef returned ${swappedStatusRef.result}`);

const revokedAgain = run({ status: "revoked" });
const suspendedAgain = run({ status: "suspended" });
expect(
  "AV-14",
  "revoked/suspended status confusion",
  denied(revokedAgain) && denied(suspendedAgain) && revokedAgain.revocationStatus !== suspendedAgain.revocationStatus,
  "both deny while receipts retain the distinct status",
  "high",
  `revoked=${revokedAgain.revocationStatus}/${revokedAgain.result}, suspended=${suspendedAgain.revocationStatus}/${suspendedAgain.result}`
);

const authority = makeDemoStatusAuthority({ now: () => UPDATED_AT });
authority.register(MANIFEST_ID, { status: "active", cursor: 9 });
const authorityRef = authority.statusRefFor(MANIFEST_ID);
const beforeRevoke = evaluateStatusRef({ statusRef: authorityRef, manifestId: MANIFEST_ID, revocationCursor: "v9", transport: authority.transport, policy: "active-required" });
authority.revoke(MANIFEST_ID);
const afterRevoke = evaluateStatusRef({ statusRef: authorityRef, manifestId: MANIFEST_ID, revocationCursor: "v9", lastSeenCursor: "v9", transport: authority.transport, policy: "active-required" });
expect(
  "AV-15",
  "mid-session revoke TOCTOU",
  beforeRevoke.result === "accept" && denied(afterRevoke) && afterRevoke.revocationStatus === "revoked",
  "the next resolution observes the monotone revoked record and rejects",
  "critical",
  `before=${beforeRevoke.result}, after=${afterRevoke.result}/${afterRevoke.revocationStatus}`
);

console.log("\n================================================================");
console.log(`VECTORS: ${resistedCount + findings.length}   RESISTED: ${resistedCount}   FINDINGS: ${findings.length}`);
if (findings.length === 0) console.log("VERDICT: SOUND — every hard statusRef vector resisted.");
else {
  console.log("VERDICT: FINDINGS — revocation/status defects remain:");
  for (const finding of findings) console.log(`  - [${finding.id}] (${finding.severity.toUpperCase()}) ${finding.title}`);
  process.exitCode = 1;
}
