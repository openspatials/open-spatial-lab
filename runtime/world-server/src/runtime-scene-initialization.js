'use strict';
const { RESTRICTED_OBJECT_COLOR, HIDDEN_OBJECT_COLOR, ACCESS_DEMO_SIZE_M } = require('./runtime-scene-policy');
function demoDefaultSceneObjects(locationId)
{
    const access = (object_id, shape, color, position) => ({ object_id, shape, size_m : ACCESS_DEMO_SIZE_M, color, position });
    if (locationId === 'location-b')
    {
        return [
            access('obj-b-cube-1', 'box', RESTRICTED_OBJECT_COLOR, [ -2.8, 0.5, -1.4 ]),
            access('obj-b-sphere-1', 'sphere', HIDDEN_OBJECT_COLOR, [ -1.2, 0.5, -1.0 ]),
            { object_id : 'obj-b-cube-2', shape : 'box', size_m : 0.6, color : '#c65ccd', position : [ -0.8, 0.3, 2.6 ] },
        ];
    }
    if (locationId === 'location-lobby')
    {
        return [
            access('obj-lobby-bench-1', 'box', RESTRICTED_OBJECT_COLOR, [ -3.4, 0.5, -1.2 ]),
            access('obj-lobby-bench-2', 'box', HIDDEN_OBJECT_COLOR, [ 1.1, 0.5, 1.7 ]),
        ];
    }
    return [
        access('obj-a-cube-1', 'box', RESTRICTED_OBJECT_COLOR, [ -1.4, 0.5, 0.6 ]),
        access('obj-a-sphere-1', 'sphere', HIDDEN_OBJECT_COLOR, [ 1.4, 0.5, 0.6 ]),
        { object_id : 'obj-a-cube-2', shape : 'box', size_m : 0.6, color : '#8a7dff', position : [ -1.2, 0.3, -2.2 ] },
    ];
}
function authoredGraphSceneObjects(graph)
{
    if (!graph || !Array.isArray(graph.nodes)) return [];
    const rootId = Number(graph.root);
    return graph.nodes
        .filter(node => node && Number(node.id) !== rootId && node.label !== '__wow_internal_root')
        .map(node => {
            const transform = Array.isArray(node.localTransform) ? node.localTransform : [];
            const extension = node.webofworlds_extension && typeof node.webofworlds_extension === 'object'
                ? JSON.parse(JSON.stringify(node.webofworlds_extension))
                : null;
            const accent = Number(extension && extension.accent);
            return {
                object_id : 'wow-node-' + node.id,
                node_id : Number(node.id),
                label : String(node.label || ('WoW node ' + node.id)),
                shape : 'box',
                size_m : 0.5,
                color : Number.isFinite(accent)
                    ? '#' + Math.max(0, Math.min(0xffffff, accent)).toString(16).padStart(6, '0')
                    : '#8fc7d9',
                position : [
                    Number(transform[12]) || 0,
                    Number(transform[13]) || 0,
                    Number(transform[14]) || 0,
                ],
                spatial_asset_uri : node.spatialAssetURI || null,
                authored_wow_content : true,
                webofworlds_extension : extension,
            };
        });
}

module.exports = { demoDefaultSceneObjects, authoredGraphSceneObjects };
