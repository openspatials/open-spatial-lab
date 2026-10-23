#!/usr/bin/env node
// additive adversarial regression gate for SOM
// branch authorization, mediated inter-service messaging, and chain reuse.

import {
  buildSomBranchAuthorizationFacet,
  buildInterServiceAuthorizationFacet,
  createSomTree,
  registerSomAuthorization,
  somWrite,
  somSnapshot,
  createMediatedChannel,
  registerFabricService,
  sendInterServiceMessage,
  createSomGatingSession,
  sealSomGatingSession,
} from "./som-branch-auth.mjs";
import { createReceiptChain } from "./receipt-hub.mjs";
import { verifyReceiptChain } from "./bilateral-chain.mjs";
import { generateKeyPair } from "../signing/ed25519.mjs";

const NOW = "2026-07-05T12:00:00.000Z";
const INVENTORY = "did:web:factory.example:inventory";
const SAFETY = "did:web:factory.example:safety";
const NAVIGATION = "did:web:factory.example:navigation";
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

function manifest(subject, facets) {
  return { subject, facets };
}

function somManifest(serviceDid, readScopes, writeScopes) {
  return manifest(serviceDid, [buildSomBranchAuthorizationFacet({ serviceDid, readScopes, writeScopes })]);
}

function channelManifest(channels) {
  return manifest("did:web:factory.example:mediator", [buildInterServiceAuthorizationFacet({ channels })]);
}

function denied(decision) {
  return decision?.allowed === false && decision?.applied === false;
}

console.log("runtime SOM branch auth + inter-service gating — ADVERSARIAL HARDENING HARNESS");
console.log("=================================================================================");
console.log("Attacking sibling escape, scope widening, authority confusion, gate bypass, and chain splice/truncation.\n");

const inventoryManifest = somManifest(INVENTORY, ["/factory/floor-2/**"], ["/factory/floor-2/inventory/**"]);
const tree = createSomTree({ branches: ["/factory/floor-2/inventory", "/factory/floor-2/safety"] });
registerSomAuthorization(tree, inventoryManifest);
const own = somWrite(tree, { serviceDid: INVENTORY, path: "/factory/floor-2/inventory/item-7", value: { count: 7 }, at: NOW });
expect("AV-0", "legitimate in-branch write control", own.allowed === true && own.applied === true, "the named branch remains writable", "critical", `control returned allowed=${own.allowed}`);

const beforeSibling = somSnapshot(tree);
const sibling = somWrite(tree, { serviceDid: INVENTORY, path: "/factory/floor-2/safety/override", value: { forged: true }, at: NOW });
expect(
  "AV-1",
  "sibling-branch escape",
  denied(sibling) && somSnapshot(tree) === beforeSibling,
  "the safety sibling stays untouched",
  "critical",
  `sibling allowed=${sibling.allowed}, treeChanged=${somSnapshot(tree) !== beforeSibling}`
);

const branchRoot = somWrite(tree, { serviceDid: INVENTORY, path: "/factory/floor-2/inventory", value: "root-overwrite" });
const parent = somWrite(tree, { serviceDid: INVENTORY, path: "/factory/floor-2", value: "parent-overwrite" });
expect("AV-2", "branch-root and parent widening", denied(branchRoot) && denied(parent), "trailing /** authorizes descendants only", "critical", `root=${branchRoot.allowed}, parent=${parent.allowed}`);

const malformedPaths = [
  "/factory/floor-2/inventory/../safety/override",
  "/factory/floor-2/inventory/*",
  "/factory/floor-2/inventory/%2e%2e/safety",
  "/factory/floor-2/inventory\\safety",
];
const malformedDecisions = malformedPaths.map((path) => somWrite(tree, { serviceDid: INVENTORY, path, value: "forged" }));
expect("AV-3", "dot/wildcard/encoded/backslash concrete-path confusion", malformedDecisions.every(denied), "every malformed path authorizes nothing", "critical", malformedDecisions.map((d) => `${d.path}:${d.allowed}`).join(", "));

let malformedGlobRejected = false;
try {
  buildSomBranchAuthorizationFacet({ serviceDid: INVENTORY, writeScopes: ["/factory/**/safety"] });
} catch {
  malformedGlobRejected = true;
}
expect("AV-4", "mid-pattern globstar scope widening", malformedGlobRejected, "unsupported glob grammar is rejected at claim construction", "critical", "a mid-pattern ** scope was built");

const duplicateAuthTree = createSomTree({ branches: ["/factory/floor-2/inventory", "/factory/floor-2/safety"] });
registerSomAuthorization(duplicateAuthTree, inventoryManifest);
let duplicateAuthorizationRejected = false;
try {
  registerSomAuthorization(duplicateAuthTree, somManifest(INVENTORY, [], ["/factory/floor-2/safety/**"]));
} catch {
  duplicateAuthorizationRejected = true;
}
const widenedWrite = somWrite(duplicateAuthTree, { serviceDid: INVENTORY, path: "/factory/floor-2/safety/override", value: "forged" });
expect(
  "AV-5",
  "out-of-order duplicate authorization widens a registered service",
  duplicateAuthorizationRejected && denied(widenedWrite),
  "a second claim cannot replace the first service scope",
  "critical",
  `duplicateRejected=${duplicateAuthorizationRejected}, widenedWrite=${widenedWrite.allowed}`
);

const exactTriple = { sourceService: SAFETY, targetCategory: "navigation", messageType: "hazard-reroute" };
const channel = createMediatedChannel({ authorizationManifest: channelManifest([exactTriple]) });
registerFabricService(channel, { did: SAFETY, category: "safety" });
const navService = registerFabricService(channel, { did: NAVIGATION, category: "navigation" });
registerFabricService(channel, { did: "did:web:factory.example:advertising", category: "advertising" });
const delivered = sendInterServiceMessage(channel, { from: SAFETY, targetCategory: "navigation", messageType: "hazard-reroute", payload: { aisle: 7 }, at: NOW });
expect("AV-6", "exact authorized inter-service triple control", delivered.allowed && delivered.delivered && navService.inbox.length === 1, "the exact named triple is delivered", "critical", `allowed=${delivered.allowed}, delivered=${delivered.delivered}`);

const wrongTriples = [
  { from: "did:web:factory.example:advertising", targetCategory: "navigation", messageType: "hazard-reroute" },
  { from: SAFETY, targetCategory: "commerce", messageType: "hazard-reroute" },
  { from: SAFETY, targetCategory: "navigation", messageType: "ad-push" },
];
const wrongDecisions = wrongTriples.map((request) => sendInterServiceMessage(channel, { ...request, payload: { forged: true } }));
expect("AV-7", "source/target/message authority confusion", wrongDecisions.every((d) => !d.allowed && !d.delivered), "all three members must match exactly", "critical", wrongDecisions.map((d) => `${d.reason}:${d.allowed}`).join(", "));

const ghostChannel = createMediatedChannel({ authorizationManifest: channelManifest([{ sourceService: "did:web:ghost", targetCategory: "navigation", messageType: "hazard-reroute" }]) });
registerFabricService(ghostChannel, { did: NAVIGATION, category: "navigation" });
const ghost = sendInterServiceMessage(ghostChannel, { from: "did:web:ghost", targetCategory: "navigation", messageType: "hazard-reroute", payload: {} });
expect("AV-8", "authorized-but-unregistered sender", !ghost.allowed && !ghost.delivered, "a channel claim does not register or authenticate its source", "critical", `ghost sender allowed=${ghost.allowed}`);

const duplicateServiceChannel = createMediatedChannel({ authorizationManifest: channelManifest([exactTriple]) });
const originalSafety = registerFabricService(duplicateServiceChannel, { did: SAFETY, category: "safety" });
let duplicateServiceRejected = false;
try {
  registerFabricService(duplicateServiceChannel, { did: SAFETY, category: "attacker-controlled" });
} catch {
  duplicateServiceRejected = true;
}
expect(
  "AV-9",
  "duplicate service-DID registration overwrite",
  duplicateServiceRejected && duplicateServiceChannel.services.get(SAFETY) === originalSafety,
  "an already registered identity cannot be replaced",
  "critical",
  `duplicateRejected=${duplicateServiceRejected}, identityPreserved=${duplicateServiceChannel.services.get(SAFETY) === originalSafety}`
);

const closedChannel = createMediatedChannel();
registerFabricService(closedChannel, { did: SAFETY, category: "safety" });
registerFabricService(closedChannel, { did: NAVIGATION, category: "navigation" });
const noManifest = sendInterServiceMessage(closedChannel, { from: SAFETY, targetCategory: "navigation", messageType: "hazard-reroute", payload: {} });
expect("AV-10", "missing inter-service authorization manifest", !noManifest.allowed && !noManifest.delivered, "zero claims means zero channels", "critical", `missing manifest allowed=${noManifest.allowed}`);

const malformedChannelManifest = manifest("did:web:mediator", [{
  "@id": "urn:facet:malformed-channel",
  "@type": ["um:Facet", "rp1:InterServiceAuthorization"],
  entity: { authorizedChannels: [{ sourceService: SAFETY, messageType: "hazard-reroute" }] },
}]);
const malformedChannel = createMediatedChannel({ authorizationManifest: malformedChannelManifest });
registerFabricService(malformedChannel, { did: SAFETY, category: "safety" });
registerFabricService(malformedChannel, { did: NAVIGATION, category: "navigation" });
const malformedTriple = sendInterServiceMessage(malformedChannel, { from: SAFETY, targetCategory: "navigation", messageType: "hazard-reroute", payload: {} });
expect("AV-11", "malformed authorization triple", !malformedTriple.allowed && malformedChannel.channels.length === 0 && malformedChannel.malformedChannels.length === 1, "a partial triple is reported and authorizes nothing", "critical", `channels=${malformedChannel.channels.length}, allowed=${malformedTriple.allowed}`);

const eventChain = createReceiptChain({ subject: "did:web:factory.example:review" });
const minimizedChannel = createMediatedChannel({ authorizationManifest: channelManifest([exactTriple]), eventChain });
registerFabricService(minimizedChannel, { did: SAFETY, category: "safety" });
registerFabricService(minimizedChannel, { did: NAVIGATION, category: "navigation" });
sendInterServiceMessage(minimizedChannel, { from: SAFETY, targetCategory: "navigation", messageType: "hazard-reroute", payload: { secret: "must-not-land" }, at: NOW });
expect("AV-12", "message payload smuggled into the review chain", !JSON.stringify(eventChain.events).includes("must-not-land"), "only minimized decision fields reach the chain", "high", "message payload appeared in a receipt-chain event");

const keyPair = await generateKeyPair();

async function sealedSession(label) {
  const serviceDid = `did:web:factory.example:${label}`;
  const branch = `/lab/${label}/service`;
  const session = createSomGatingSession({
    subject: `did:web:factory.example:user:${label}`,
    serviceManifests: [somManifest(serviceDid, [`/lab/${label}/**`], [`${branch}/**`])],
    branches: [branch, `/lab/${label}/sibling`],
  });
  const allowed = somWrite(session.tree, { serviceDid, path: `${branch}/own`, value: { ok: true }, at: NOW });
  const blocked = somWrite(session.tree, { serviceDid, path: `/lab/${label}/sibling/escape`, value: { forged: true }, at: NOW });
  const sealed = await sealSomGatingSession(session, {
    manifestId: `urn:manifest:${label}`,
    evaluatorDid: `did:web:factory.example:mediator:${label}`,
    privateKeyInput: keyPair.privateKey,
    now: NOW,
  });
  return { session, sealed, allowed, blocked };
}

const firstSession = await sealedSession("alpha");
const truncated = structuredClone(firstSession.session.hashChain);
truncated.links = [];
const truncationReport = await verifyReceiptChain(truncated, { expectChainId: firstSession.session.hashChain.chainId });
expect("AV-13", "sealed SOM-chain tail truncation", !truncationReport.valid, "the reused runtime seal anchor rejects removal of the SOM summary link", "critical", `empty sealed chain verified with length=${truncationReport.length}`);

const secondSession = await sealedSession("beta");
const spliced = structuredClone(firstSession.session.hashChain);
spliced.links[0] = structuredClone(secondSession.session.hashChain.links[0]);
const spliceReport = await verifyReceiptChain(spliced, { expectChainId: firstSession.session.hashChain.chainId });
expect("AV-14", "foreign SOM-chain splice", !spliceReport.valid, "foreign chainId/hash/seal diagnostics is rejected at the SOM boundary", "critical", "a foreign SOM summary link verified in the original chain");

const summaryEvents = firstSession.sealed.summaryReceipt.events || [];
expect(
  "AV-15",
  "allowed and denied branch decisions reuse one verified chain",
  firstSession.allowed.allowed && denied(firstSession.blocked) && firstSession.sealed.chainReport.valid && summaryEvents.some((e) => e.eventType === "capability-granted") && summaryEvents.some((e) => e.eventType === "capability-denied"),
  "both outcomes are preserved on the one sealed runtime chain",
  "critical",
  `allowed=${firstSession.allowed.allowed}, blocked=${firstSession.blocked.allowed}, chainValid=${firstSession.sealed.chainReport.valid}, events=${summaryEvents.length}`
);

console.log("\n=================================================================================");
console.log(`VECTORS: ${resistedCount + findings.length}   RESISTED: ${resistedCount}   FINDINGS: ${findings.length}`);
if (findings.length === 0) console.log("VERDICT: SOUND — every hard SOM/channel/chain vector resisted.");
else {
  console.log("VERDICT: FINDINGS — scope or authority bypasses remain:");
  for (const finding of findings) console.log(`  - [${finding.id}] (${finding.severity.toUpperCase()}) ${finding.title}`);
  process.exitCode = 1;
}
