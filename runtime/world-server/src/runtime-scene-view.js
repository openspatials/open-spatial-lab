'use strict';
const { clone, readNumber } = require('./runtime-projection-values');
const { DEMO_WORLD_BASE_COLOR, DEMO_PORTAL_LOADING_BRAND, demoExtensionBoundary } = require('./runtime-scene-policy');
const { FABRIC_PORTAL_FRAME_PRESETS, FABRIC_PORTAL_FRAME_WIDTH_M, FABRIC_PORTAL_FRAME_HEIGHT_M,
    FABRIC_PORTAL_TRIGGER_DEPTH_M } = require('./runtime-projection-policy');
const { portalSharedEdge } = require('./runtime-portal-policy');
const { objectsSeenFromAnotherWorld } = require('./runtime-fabric-region');
const { primitiveAssetAccess } = require('./wow-asset');
const { getWowProofBoundary } = require('./runtime-world-projection');
function loadingPointers(brand, baseHex, identity)
{
    return {
        'metaverse.portal.loadingScreen' : {
            href : '/demo/portal-view?resolution=snapshot3d',
            value : {
                headline : 'Entering ' + identity.TITLE,
                background_hex : baseHex,
                accent_hex : brand.accent_hex || '#9fb0d0',
            },
        },
        'metaverse.portal.loadingBranding' : {
            href : '/demo/portal-view',
            value : {
                world_title : identity.TITLE,
                location_id : identity.LOCATION_ID,
                world_id : identity.WORLD_ID,
                brand_color_hex : brand.accent_hex || '#9fb0d0',
                tagline : brand.tagline || '',
            },
        },
        'metaverse.portal.loadingInstructions' : {
            href : '/demo/portal-view',
            value : {
                instructions : Array.isArray(brand.instructions) ? brand.instructions.slice() : [],
            },
        },
        'metaverse.portal.estimatedLoadTime' : {
            href : '/demo/portal-view',
            value : {
                estimated_load_ms : Number(brand.estimated_load_ms) || 2500,
            },
        },
    };
}
class RuntimeSceneView
{
    constructor({ readObjects, readPortals, avatar, attachPoint, identity })
    {
        this.readObjects = readObjects;
        this.readPortals = readPortals;
        this.avatar = avatar;
        this.attachPoint = attachPoint;
        this.identity = identity;
    }
    demoPortalPose(portalArg)
    {
        const portal = portalArg || this.readPortals()[0] || null;
        if (!portal) return null;
        const preset = FABRIC_PORTAL_FRAME_PRESETS[this.identity.LOCATION_ID] || { forward : [ 0, 0, 1 ] };
        return {
            portal_id : portal.portal_id,
            trigger_position : (portal.trigger && portal.trigger.position || [ 2.8, 0, -2.8 ]).slice(),
            trigger_radius_m : readNumber(portal.trigger && portal.trigger.radius_m, 1.25),
            forward : preset.forward.slice(),
            width_m : FABRIC_PORTAL_FRAME_WIDTH_M,
            height_m : FABRIC_PORTAL_FRAME_HEIGHT_M,
            trigger_depth_m : FABRIC_PORTAL_TRIGGER_DEPTH_M,
            target_location_id : portal.target_location_id || null,
            target_world_id : portal.target_world_id || null,
            shared_edge : portalSharedEdge(portal),
        };
    }

    demoPortalLoadingContent()
    {
        const brand = DEMO_PORTAL_LOADING_BRAND[this.identity.LOCATION_ID] || {};
        const baseHex = DEMO_WORLD_BASE_COLOR[this.identity.LOCATION_ID] || '#20242e';
        return {
            demo_extension : true,
            standards_conformance : false,
            label : 'runtime DEMO EXTENSION — destination loading-content pointers '
                + '(metaverse.portal.* names from the TeleportVR/UM integration packet; '
                + 'demonstration-only, NOT a published UM/IWPS/WoW spec surface)',
            pointer_host : this.identity.LOCATION_ID,
            pointer_names : [
                'metaverse.portal.loadingScreen',
                'metaverse.portal.loadingBranding',
                'metaverse.portal.loadingInstructions',
                'metaverse.portal.estimatedLoadTime',
            ],
            consent_key : 'metaverse.portal.preloadContent',
            pointers : loadingPointers(brand, baseHex, this.identity),
            consent : {
                key : 'metaverse.portal.preloadContent',
                granted : true,
                scope : 'demo',
                note : 'demo consent — the source world MAY preload/render this destination '
                    + 'loading content before the handshake completes',
            },
        };
    }

    getSceneObjects()
    {
        return clone(Object.assign({
            ok : true,
            location_id : this.identity.LOCATION_ID,
            world_id : this.identity.WORLD_ID,
            version : this.attachPoint.version,
            updated_at : this.attachPoint.updated_at,
            objects : this.readObjects(),
            portal_pose : this.demoPortalPose(),
        }, demoExtensionBoundary()));
    }

    demoPortalViewColor()
    {
        const pose = this.demoPortalPose();
        const anchor = pose ? pose.trigger_position : [ 2.8, 0, -2.8 ];
        const parse = hex => {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
            const n = m ? parseInt(m[1], 16) : 0x808080;
            return [ (n >> 16) & 255, (n >> 8) & 255, n & 255 ];
        };
        const base = parse(DEMO_WORLD_BASE_COLOR[this.identity.LOCATION_ID] || '#20242e');
        let r = base[0] * 2, g = base[1] * 2, b = base[2] * 2, w = 2;
        for (const obj of objectsSeenFromAnotherWorld(this.readObjects()))
        {
            if (!obj.color) continue;
            const c = parse(obj.color);
            const dx = (obj.position[0] || 0) - anchor[0];
            const dz = (obj.position[2] || 0) - anchor[2];
            const weight = 1 / (1 + Math.hypot(dx, dz));
            r += c[0] * weight; g += c[1] * weight; b += c[2] * weight; w += weight;
        }
        const toHex = v => Math.max(0, Math.min(255, Math.round(v / w))).toString(16).padStart(2, '0');
        return '#' + toHex(r) + toHex(g) + toHex(b);
    }

    getPortalView(resolution)
    {
        const res = String(resolution || 'snapshot3d');
        const base = Object.assign({
            ok : true,
            location_id : this.identity.LOCATION_ID,
            world_id : this.identity.WORLD_ID,
            version : this.attachPoint.version,
            updated_at : this.attachPoint.updated_at,
            resolution : res,
            resolution_ladder : [ 'color', 'snapshot3d', 'splats' ],
        }, demoExtensionBoundary());
        base.metaverse_portal = this.demoPortalLoadingContent();
        if (res === 'color')
        {
            return clone(Object.assign(base, {
                status : 'available',
                value : {
                    color_hex : this.demoPortalViewColor(),
                    derivation : 'world base tint blended with hosted object colors, '
                        + 'weighted 1/(1+planar distance to the portal)',
                },
            }));
        }
        if (res === 'snapshot3d')
        {
            return clone(Object.assign(base, {
                status : 'available',
                value : {
                    kind : '3d_snapshot',
                    room : { size_m : [ 12, 12 ], base_color : DEMO_WORLD_BASE_COLOR[this.identity.LOCATION_ID] || '#20242e' },
                    portal : this.demoPortalPose(),
                    objects : objectsSeenFromAnotherWorld(this.readObjects()),
                    avatar_position : this.avatar.transform.position.slice(),
                },
            }));
        }
        if (res === 'splats')
        {
            return clone(Object.assign(base, {
                status : 'stub_not_implemented',
                label : 'SPLATS RUNG — STUBBED. Highest resolution (gaussian splats) is '
                    + 'deliberately NOT implemented in this demo; shown only as the ladder\'s top rung.',
                value : null,
            }));
        }
        return null;
    }

    getUmAttachPoint()
    {
        return clone(Object.assign({
            ok : true,
            attach_point_id : 'um-attach-point-' + this.identity.LOCATION_ID,
            model : 'reloadable_hosted_point',
            model_note : 'Demo interpretation of the documented UM attach-point fallback: '
                + 'the Universal Manifest ATTACHES to this server-hosted point and clients '
                + 'RE-READ (reload) it on demand; the UM/server does NOT stream it. Each GET '
                + 'is a fresh reload of current server truth. Project-local model — not '
                + 'defined by any published UM/IWPS/WoW spec.',
            location_id : this.identity.LOCATION_ID,
            world_id : this.identity.WORLD_ID,
            version : this.attachPoint.version,
            updated_at : this.attachPoint.updated_at,
            last_change : this.attachPoint.last_change,
            portal_pose : this.demoPortalPose(),
            metaverse_portal : this.demoPortalLoadingContent(),
            resolutions : {
                color : { status : 'available', href : '/demo/portal-view?resolution=color' },
                snapshot3d : { status : 'available', href : '/demo/portal-view?resolution=snapshot3d' },
                splats : {
                    status : 'stub_not_implemented',
                    href : '/demo/portal-view?resolution=splats',
                    label : 'highest rung — stubbed, not working yet (labeled)',
                },
            },
            value : this.attachPointValue(),
            proof_boundary : getWowProofBoundary(),
        }, demoExtensionBoundary()));
    }

    attachPointValue()
    {
        const value = this.getPortalView('snapshot3d').value;
        value.objects = clone(this.readObjects()).map(obj => Object.assign(obj, {
            asset_access : primitiveAssetAccess(this.readObjects(), obj.object_id),
        }));
        return value;
    }

    hostedObjectAccessOfNode(node)
    {
        const names = node && Array.isArray(node.names) ? node.names : [];
        const obj = this.readObjects().find(o => o.object_id === names[0]);
        if (!obj || obj.authored_wow_content) return null;
        return { access : primitiveAssetAccess(this.readObjects(), obj.object_id), size_m : Number(obj.size_m) || 0 };
    }
}
function createRuntimeSceneView(options)
{
    const reader = new RuntimeSceneView(options);
    return {
        demoPortalPose : reader.demoPortalPose.bind(reader),
        getSceneObjects : reader.getSceneObjects.bind(reader),
        getPortalView : reader.getPortalView.bind(reader),
        getUmAttachPoint : reader.getUmAttachPoint.bind(reader),
        hostedObjectAccessOfNode : reader.hostedObjectAccessOfNode.bind(reader),
    };
}

module.exports = { createRuntimeSceneView };
