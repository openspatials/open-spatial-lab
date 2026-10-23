'use strict';

function buildBoxesAndRampsCollisionSpike()
{
    let threeMeshBvhResolved = false;
    let threeMeshBvhPath = null;
    try
    {
        threeMeshBvhPath = require.resolve('three-mesh-bvh');
        threeMeshBvhResolved = true;
    }
    catch (e)
    {
        threeMeshBvhPath = null;
    }

    return {
        library : 'three-mesh-bvh',
        mode : threeMeshBvhResolved ? 'available' : 'scaffolded-no-installed-dependency',
        resolved_path : threeMeshBvhPath,
        scene_mesh_scope : '043/057 boxes-and-ramps static world mesh',
        avatar_collision_proxy : {
            type : 'capsule',
            radius_m : 0.35,
            segment : {
                start : [ 0, 0.35, 0 ],
                end : [ 0, 1.55, 0 ],
            },
        },
        static_collision_shapes : [
            { id : 'origin-floor', type : 'box', center : [ 0, -0.05, 0 ], size : [ 8, 0.1, 8 ] },
            { id : 'portal-ramp', type : 'ramp', from : [ 1.2, 0, -1.2 ], to : [ 2.8, 0.45, -2.8 ], width : 1.2 },
            { id : 'arrival-floor', type : 'box', center : [ 0, -0.05, 3.6 ], size : [ 8, 0.1, 8 ] },
        ],
        graft_point : 'Phase 1 replaces AvatarModel free moveTo with capsule-vs-BVH resolved step before portal trigger evaluation.',
        vanilla_three_import_shape : [
            "import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';",
            'THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;',
            'THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;',
            'THREE.Mesh.prototype.raycast = acceleratedRaycast;',
        ],
    };
}

module.exports = { buildBoxesAndRampsCollisionSpike };
