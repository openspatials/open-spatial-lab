'use strict';

const DEFAULT_ASSET_BASE_URL = 'http://127.0.0.1:8143/assets';

const VRM_ATTACHMENT_POINTS = new Set([
    'hips',
    'spine',
    'chest',
    'upperChest',
    'neck',
    'head',
    'leftShoulder',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightShoulder',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
]);

const EQUIPMENT_SCHEMA = {
    location : 'avatar_context.equippedItems[]',
    um_iwps_mapping : {
        universal_manifest : 'standards_payloads.universal_manifest.facets.avatar_equipment.equippedItems',
        iwps : 'standards_payloads.oma3_iwps.assets.equippedItems',
    },
    item : {
        itemId : 'stable local item identifier; not a cross-server catalog key in Phase 0B',
        assetUri : 'absolute URI to a glTF/GLB asset fetchable by a naive destination',
        attachmentPoint : 'VRM normalized bone name, e.g. rightHand or head',
        localTransform : {
            position : '[x,y,z] meters, local to attachmentPoint',
            quaternion : '[x,y,z,w] quaternion, local to attachmentPoint',
            scale : '[x,y,z] local scale',
        },
        mode : 'held | worn',
    },
};

function clone(obj)
{
    return JSON.parse(JSON.stringify(obj));
}

function sampleEquippedItems(assetBaseUrl = DEFAULT_ASSET_BASE_URL)
{
    const base = String(assetBaseUrl).replace(/\/+$/, '');
    return [
        {
            itemId : 'equip-hammer',
            assetUri : `${base}/equip-hammer.glb`,
            attachmentPoint : 'rightHand',
            localTransform : {
                position : [ 0.06, -0.02, -0.08 ],
                quaternion : [ 0, 0.382683, 0, 0.92388 ],
                scale : [ 0.45, 0.45, 0.45 ],
            },
            mode : 'held',
            label : 'War hammer',
        },
        {
            itemId : 'equip-hat',
            assetUri : `${base}/equip-hat.glb`,
            attachmentPoint : 'head',
            localTransform : {
                position : [ 0, 0.09, 0.03 ],
                quaternion : [ 0, 0, 0, 1 ],
                scale : [ 0.62, 0.22, 0.18 ],
            },
            mode : 'worn',
            label : 'Wide-brim explorer hat',
        },
    ];
}

function validateEquippedItems(items)
{
    const errors = [];
    if (!Array.isArray(items))
    {
        return { ok : false, errors : [ 'equippedItems must be an array' ] };
    }
    const modes = new Set();
    for (const [index, item] of items.entries())
    {
        const path = `equippedItems[${index}]`;
        if (!item || typeof item !== 'object')
        {
            errors.push(`${path} must be an object`);
            continue;
        }
        if (!item.itemId || typeof item.itemId !== 'string') errors.push(`${path}.itemId must be a string`);
        if (!item.assetUri || typeof item.assetUri !== 'string') errors.push(`${path}.assetUri must be a string`);
        else
        {
            try
            {
                const parsed = new URL(item.assetUri);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'data:')
                    errors.push(`${path}.assetUri must use http, https, or data`);
            }
            catch (e)
            {
                errors.push(`${path}.assetUri must be an absolute URI`);
            }
        }
        if (!VRM_ATTACHMENT_POINTS.has(item.attachmentPoint))
            errors.push(`${path}.attachmentPoint must be a VRM normalized bone name`);
        if (item.mode !== 'held' && item.mode !== 'worn') errors.push(`${path}.mode must be held or worn`);
        else modes.add(item.mode);
        const t = item.localTransform || {};
        if (!isNumberArray(t.position, 3)) errors.push(`${path}.localTransform.position must be [x,y,z]`);
        const q = t.quaternion || t.rotation;
        if (!isNumberArray(q, 4)) errors.push(`${path}.localTransform.quaternion must be [x,y,z,w]`);
        if (!isNumberArray(t.scale, 3)) errors.push(`${path}.localTransform.scale must be [x,y,z]`);
    }
    if (!modes.has('held')) errors.push('equippedItems must include one held item for Phase 0B');
    if (!modes.has('worn')) errors.push('equippedItems must include one worn item for Phase 0B');
    return { ok : errors.length === 0, errors };
}

function isNumberArray(value, length)
{
    return Array.isArray(value) && value.length === length && value.every(v => Number.isFinite(v));
}

function augmentHandoffPacket(packet, opts = {})
{
    const out = clone(packet);
    const equippedItems = clone(opts.equippedItems || sampleEquippedItems(opts.assetBaseUrl));
    const check = validateEquippedItems(equippedItems);
    if (!check.ok) throw new Error('invalid equippedItems: ' + check.errors.join('; '));
    out.avatar_context = Object.assign({}, out.avatar_context || {}, {
        equippedItems,
        equipment_profile : 'msf.phase0b.avatar-equipment.v0',
    });
    out.assets = {
        avatar_equipment_profile : out.avatar_context.equipment_profile,
        equippedItems : equippedItems.map(item => ({
            itemId : item.itemId,
            assetUri : item.assetUri,
            mode : item.mode,
            attachmentPoint : item.attachmentPoint,
        })),
        note : 'IWPS assets placement scaffold; reference-only, no IWPS conformance claim.',
    };
    return out;
}

function augmentEnvelopeWithEquipment(envelopeResult, handoff)
{
    const envelope = clone(envelopeResult.envelope);
    const equippedItems = clone((handoff.avatar_context && handoff.avatar_context.equippedItems) || []);
    const check = validateEquippedItems(equippedItems);
    if (!check.ok) throw new Error('cannot map invalid equippedItems into envelope: ' + check.errors.join('; '));

    envelope.standards_payloads.universal_manifest.facets =
        Object.assign({}, envelope.standards_payloads.universal_manifest.facets || {}, {
            avatar_equipment : {
                profile : handoff.avatar_context.equipment_profile || 'msf.phase0b.avatar-equipment.v0',
                equippedItems,
                _conformance : 'NON-CONFORMANT: project-local equipment facet carried for Phase 0B validation only.',
            },
        });
    envelope.standards_payloads.oma3_iwps.assets = {
        _conformance : 'NON-CONFORMANT / REFERENCE-ONLY: IWPS asset slot scaffold for avatar-carried equipment; no IWPS endpoint is called.',
        equippedItems : equippedItems.map(item => ({
            itemId : item.itemId,
            assetUri : item.assetUri,
            mode : item.mode,
            attachmentPoint : item.attachmentPoint,
        })),
    };

    return {
        envelope,
        field_provenance : Object.assign({}, envelopeResult.field_provenance, {
            'standards_payloads.universal_manifest.facets.avatar_equipment.equippedItems' : {
                label : 'project-local',
                conformant : false,
                source : 'runtime equippedItems schema',
            },
            'standards_payloads.oma3_iwps.assets.equippedItems' : {
                label : 'reference',
                conformant : false,
                source : 'runtime IWPS assets scaffold',
            },
        }),
        meta : envelopeResult.meta,
    };
}

function buildEquipmentReconstructorPlan()
{
    return [
        'Phase 1: replace placeholder avatar in web scene with GLTFLoader + VRMLoaderPlugin from @pixiv/three-vrm.',
        'Phase 1: source-side equip attaches GLB item mesh to vrm.humanoid.getNormalizedBoneNode(item.attachmentPoint).',
        'Phase 2: source /portal/exit-intent path augments avatar_context.equippedItems and IWPS assets scaffold before relay.',
        'Phase 3: destination-side reconstructor lives at web/live-adapter.js applyArrival() -> packet.avatar_context.equippedItems -> fetch assetUri -> attach to normalized bone -> apply localTransform -> enable physics last.',
    ];
}

module.exports = {
    DEFAULT_ASSET_BASE_URL,
    EQUIPMENT_SCHEMA,
    VRM_ATTACHMENT_POINTS,
    sampleEquippedItems,
    validateEquippedItems,
    augmentHandoffPacket,
    augmentEnvelopeWithEquipment,
    buildEquipmentReconstructorPlan,
};
