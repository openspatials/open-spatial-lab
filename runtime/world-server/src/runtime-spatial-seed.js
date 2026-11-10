'use strict';
const { translationMatrix, multiplyMatrices, rotationYMatrix } = require('./spatial-graph');
const { roomSeedNodes, portalArrivalSeeds } = require('./portal-standard');
const { hostedUserPose, playerViewPose, placementSeed } = require('./runtime-placements');

function objectSeeds(objects)
{
    const children = [];
    for (const obj of objects)
    {
        children.push({
            label : obj.label || obj.object_id,
            names : [ obj.object_id, obj.label, String(obj.shape || 'box') ]
                .filter((name, index, all) => name && all.indexOf(name) === index),
            localTransform : translationMatrix(obj.position),
            // Labeled OSL primitive URI — honestly a hosted primitive, NOT a
            // glTF asset.
            spatialAssetURI : obj.spatial_asset_uri || ('osl-primitive:'
                + encodeURIComponent(String(obj.shape || 'box'))
                + '?size_m=' + (Number(obj.size_m) || 0)),
            appearanceURI : obj.color ? 'osl-color:' + String(obj.color).replace('#', '') : undefined,
            webofworlds_extension : obj.authored_wow_content
                ? Object.assign({ authored_wow_content : true, authored_node_id : obj.node_id },
                    obj.webofworlds_extension || {})
                : undefined,
        });
    }
    return children;
}

function portalSeeds(portals, yaw, portalTraversalRule, portalReciprocalRule)
{
    const children = [];
    portals.forEach((portal, index) => {
        const wowId = index + 1;
        const trigger = portal.trigger || {};
        const targetWorldId = portal.target_world_id || portal.target_fixture?.spatial_id;
        const targetLocationId = portal.target_location_id || portal.target_fixture?.spatial_id;
        children.push({
            label : portal.label || ('Portal ' + portal.portal_id),
            names : [ portal.portal_id, 'portal', 'wow-portal-' + wowId ],
            // the portal's place and heading: GET /wow/portal/{id} derives its GeoPose from this node
            localTransform : multiplyMatrices(translationMatrix(trigger.position), rotationYMatrix(yaw)),
            spatialAssetURI : 'osl-portal:?' + [
                'target_world_id=' + encodeURIComponent(portal.target_world_id || ''),
                'target_location_id=' + encodeURIComponent(portal.target_location_id || ''),
                'target_base_url=' + encodeURIComponent(portal.target_base_url || ''),
                'target_portal_id=' + encodeURIComponent(portal.target_portal_id || ''),
            ].join('&'),
            webofworlds_extension : {
                role : 'portal',
                portal_id : portal.portal_id,
                portal_resource : '/wow/portal/' + wowId,
                // the RESOLVABLE DESTINATION: the target world's canonical
                // /wow/spatial graph id + endpoint (B composition-graph
                // reference — the minimal path that needs no spec change).
                target_spatial_id : targetWorldId || undefined,
                target_spatial_graph_endpoint : targetWorldId ? '/wow/spatial/1' : undefined,
                target_world_id : targetWorldId || undefined,
                target_location_id : targetLocationId || undefined,
                target_base_url : portal.target_base_url || undefined,
                traversal_mode : portalTraversalRule(portal).mode,
                reciprocal : portalReciprocalRule(portal),
                note : 'LABELED x-osl-extension. Destination is a composition-graph '
                    + 'reference to the sibling world\'s /wow/spatial graph — NOT a canonical '
                    + 'Node field, NOT a signed .msf reference. Rides legally on the open '
                    + 'canonical Node; surfaced by runtime.',
            },
        });
    });
    return children;
}

function buildSpatialSeedNodes({ objects, portals, avatar, room, title, worldId, locationId, yaw,
    authoredGraph, localUserId, playerViewId, cameraRig, portalTraversalRule, portalReciprocalRule })
{
    const children = objectSeeds(objects).concat(portalSeeds(portals, yaw, portalTraversalRule, portalReciprocalRule));
    children.push(placementSeed('user', localUserId, 'User ' + localUserId + ' (' + avatar.display_name + ')', hostedUserPose(avatar)));
    children.push(placementSeed('view', playerViewId, 'View ' + playerViewId + ' (player camera)', playerViewPose(avatar, cameraRig)));
    if (room && typeof room === 'object') children.push(...roomSeedNodes(room));
    children.push(...portalArrivalSeeds(portals, yaw, authoredGraph));
    return { root : { label : title + ' - spatial composition graph', names : [ worldId, locationId ],
        localTransform : translationMatrix([ 0, 0, 0 ]) }, nodes : children };
}

module.exports = { buildSpatialSeedNodes };
