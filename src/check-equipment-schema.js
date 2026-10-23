'use strict';

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_ASSET_BASE_URL,
    EQUIPMENT_SCHEMA,
    sampleEquippedItems,
    validateEquippedItems,
    augmentHandoffPacket,
    augmentEnvelopeWithEquipment,
    buildEquipmentReconstructorPlan,
} = require('./equipment-foundation');
const { buildBoxesAndRampsCollisionSpike } = require('./collision-spike');

const EVIDENCE_DIR = path.join(__dirname, '..', 'diagnostics');

function writeJson(name, obj)
{
    fs.mkdirSync(EVIDENCE_DIR, { recursive : true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(obj, null, 2));
}

function main()
{
    const sample = sampleEquippedItems(DEFAULT_ASSET_BASE_URL);
    const validation = validateEquippedItems(sample);
    const packet = augmentHandoffPacket({
        handoff_id : 'schema-check-handoff',
        native_teleportxr_teleport : false,
        avatar_context : {
            avatar_id : 'avatar-local-001',
            continuity_id : 'avatar-local-001',
            state_revision : 1,
        },
    });
    const roundTrip = JSON.parse(JSON.stringify(packet.avatar_context.equippedItems));
    const roundTripValidation = validateEquippedItems(roundTrip);
    const envelopeResult = augmentEnvelopeWithEquipment({
        envelope : {
            claim_boundary : {
                application_level_handoff : true,
                native_teleportxr_teleport : false,
                first_party_teleportxr_browser_rendering : false,
                standards_conformance : false,
            },
            standards_payloads : {
                universal_manifest : { facets : {} },
                oma3_iwps : {},
            },
        },
        field_provenance : {},
        meta : { leg : 'schema-check' },
    }, packet);

    const output = {
        generated_at : new Date().toISOString(),
        schema : EQUIPMENT_SCHEMA,
        validation,
        round_trip_validation : roundTripValidation,
        sample_equippedItems : sample,
        augmented_packet_avatar_context : packet.avatar_context,
        iwps_assets_scaffold : packet.assets,
        envelope_mapping : {
            universal_manifest_avatar_equipment :
                envelopeResult.envelope.standards_payloads.universal_manifest.facets.avatar_equipment,
            iwps_assets : envelopeResult.envelope.standards_payloads.oma3_iwps.assets,
        },
        collision_spike : buildBoxesAndRampsCollisionSpike(),
        phase_touchpoints : buildEquipmentReconstructorPlan(),
        checks : {
            equippedItems_schema_ok : validation.ok,
            equippedItems_round_trip_ok : roundTripValidation.ok,
            claim_boundary_preserved :
                envelopeResult.envelope.claim_boundary.native_teleportxr_teleport === false
                && envelopeResult.envelope.claim_boundary.first_party_teleportxr_browser_rendering === false
                && envelopeResult.envelope.claim_boundary.standards_conformance === false,
            has_held_item : sample.some(item => item.mode === 'held'),
            has_worn_item : sample.some(item => item.mode === 'worn'),
        },
    };
    writeJson('equipment-schema-check.json', output);
    const ok = Object.values(output.checks).every(Boolean);
    console.log('=== EQUIPMENT SCHEMA CHECK ===');
    for (const [name, pass] of Object.entries(output.checks)) console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}`);
    console.log(`RESULT: ${ok ? 'ALL CHECKS PASS' : 'FAILURES PRESENT'}`);
    return ok;
}

if (require.main === module)
{
    process.exit(main() ? 0 : 1);
}

module.exports = { main };
