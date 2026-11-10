'use strict';
const { clone } = require('./runtime-projection-values');
const { DEMO_SCENE_OBJECT_LIMIT_M, DEMO_PORTAL_LIMIT_M, demoClampMeters } = require('./runtime-scene-policy');
const { translationMatrix, multiplyMatrices, rotationYMatrix } = require('./spatial-graph');
const { DEMO_REPUBLISH_DRIFT_AMPLITUDE_M } = require('./runtime-republish-policy');
class RuntimeSceneObjects
{
    constructor({ readObjects, replaceObjects, readPortals, defaultPortals, attachPoint, debug, spatial, placements, portalYaw, publish })
    {
        this.readObjects = readObjects;
        this.replaceObjects = replaceObjects;
        this.readPortals = readPortals;
        this.attachPoint = attachPoint;
        this.debug = debug;
        this.spatial = spatial;
        this.placements = placements;
        this.portalYaw = portalYaw;
        this.publish = publish;
        this.defaultObjects = clone(readObjects());
        this.defaultTriggers = defaultPortals.map(p => clone(p.trigger || {}));
        this.driftSeeds = this.readObjects().map((o, i) => ({
            object_id : o.object_id,
            home : (o.position || [ 0, 0, 0 ]).slice(),
            phase : (i * 1.7) % (Math.PI * 2),
            ampX : DEMO_REPUBLISH_DRIFT_AMPLITUDE_M * (0.6 + 0.4 * ((i * 0.37) % 1)),
            ampZ : DEMO_REPUBLISH_DRIFT_AMPLITUDE_M * (0.6 + 0.4 * ((i * 0.53) % 1)),
            rate : 0.6 + 0.5 * ((i * 0.29) % 1), // radians of phase advance per tick
        }));
    }
    resetScene()
    {
        this.replaceObjects(clone(this.defaultObjects));
        this.readPortals().forEach((portal, i) => {
            if (this.defaultTriggers[i]) portal.trigger = clone(this.defaultTriggers[i]);
        });
        this.demoBumpAttachPoint('reset');
    }
    demoBumpAttachPoint(reason)
    {
        this.attachPoint.version += 1;
        this.attachPoint.updated_at = new Date().toISOString();
        this.attachPoint.last_change = String(reason || 'update');
    }

    moveSceneObject(objectId, position)
    {
        const obj = this.readObjects().find(o => o.object_id === String(objectId || ''));
        if (!obj)
            throw new Error('unknown scene object ' + objectId);
        const p = Array.isArray(position) ? position : [];
        obj.position = [
            demoClampMeters(p[0], DEMO_SCENE_OBJECT_LIMIT_M, obj.position[0]),
            obj.position[1], // floor objects keep their resting height
            demoClampMeters(p[2], DEMO_SCENE_OBJECT_LIMIT_M, obj.position[2]),
        ];
        this.debug.last_input_source = 'demo-scene-object-move';
        this.demoBumpAttachPoint('scene_object_moved:' + obj.object_id);
        this.publish();
        return clone(obj);
    }

    movePortal(position)
    {
        const portal = this.readPortals()[0];
        if (!portal)
            throw new Error('no portal hosted by this node');
        const prev = (portal.trigger && portal.trigger.position) || [ 2.8, 0, -2.8 ];
        const p = Array.isArray(position) ? position : [];
        portal.trigger = Object.assign({}, portal.trigger, {
            position : [
                demoClampMeters(p[0], DEMO_PORTAL_LIMIT_M, prev[0]),
                0,
                demoClampMeters(p[2], DEMO_PORTAL_LIMIT_M, prev[2]),
            ],
        });
        const nodeId = this.placements.seededNodeId('wow-portal-1');
        if (nodeId != null) this.spatial.updateSpatialNode('1', nodeId, {
            localTransform : multiplyMatrices(translationMatrix(portal.trigger.position), rotationYMatrix(this.portalYaw())),
        }, { form : 'flat' });
        this.debug.last_input_source = 'demo-portal-move';
        this.demoBumpAttachPoint('portal_moved:' + portal.portal_id);
        this.publish();
        return clone(portal);
    }

    republishApplyAmbientDrift(republishTickCount)
    {
        for (const seed of this.driftSeeds)
        {
            const obj = this.readObjects().find(o => o.object_id === seed.object_id);
            if (!obj) continue;
            const t = seed.phase + republishTickCount * seed.rate;
            const nx = seed.home[0] + Math.cos(t) * seed.ampX;
            const nz = seed.home[2] + Math.sin(t) * seed.ampZ;
            obj.position = [
                demoClampMeters(nx, DEMO_SCENE_OBJECT_LIMIT_M, obj.position[0]),
                obj.position[1], // keep resting height
                demoClampMeters(nz, DEMO_SCENE_OBJECT_LIMIT_M, obj.position[2]),
            ];
        }
        this.debug.last_input_source = 'demo-republish-ambient-drift';
        this.demoBumpAttachPoint('republish_ambient_drift:tick_' + republishTickCount);
        this.publish();
    }
}
function createRuntimeSceneObjects(options)
{
    const owner = new RuntimeSceneObjects(options);
    return {
        moveSceneObject : owner.moveSceneObject.bind(owner),
        movePortal : owner.movePortal.bind(owner),
        resetScene : owner.resetScene.bind(owner),
        republishApplyAmbientDrift : owner.republishApplyAmbientDrift.bind(owner),
    };
}

module.exports = { createRuntimeSceneObjects };
