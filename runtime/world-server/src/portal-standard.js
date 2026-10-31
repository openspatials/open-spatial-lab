'use strict';

/*
 * What a world publishes so that any Web of Worlds client, the main demo included, can show its portals and
 * previews from its data alone:
 *
 *   - an arrival node for each portal it hosts: where a visitor who comes through that portal stands. A portal
 *     leading here names it in its destination (`{base}#join=node.{n}`).
 *   - its room as graph nodes, drawn the way the demo page draws the same room: the same size, colours, grid and
 *     lights, so what a portal shows of the room is what a visitor finds on arrival.
 */

const { translationMatrix, multiplyMatrices, rotationYMatrix, invertAffine } = require('./spatial-graph');

// How far in front of its portal a visitor arrives: the crossing's trigger depth (0.8 m) plus clearance (0.25 m).
// The walk-through has always landed here; outside the trigger, so the arrival cannot fire the portal back.
const ARRIVAL_STAND_OFF_M = 1.05;
const ARRIVAL_ROLE = 'portal-arrival';

/** The highest walkable surface under (x, z) in an authored graph, or 0 when the graph declares none. */
function groundHeightAt(authoredGraph, x, z)
{
    const nodes = authoredGraph && Array.isArray(authoredGraph.nodes) ? authoredGraph.nodes : [];
    const terminal = nodes.map(node => node && node.webofworlds_extension && node.webofworlds_extension.airport_terminal).find(Boolean);
    const surfaces = terminal && Array.isArray(terminal.walkable_surfaces) ? terminal.walkable_surfaces : [];
    let top = null;
    for (const surface of surfaces)
    {
        if (surface.classification !== 'walkable') continue;
        const inside = Math.abs(x - surface.center_m[0]) <= surface.size_m[0] / 2 && Math.abs(z - surface.center_m[2]) <= surface.size_m[2] / 2;
        const height = surface.center_m[1] + surface.size_m[1] / 2;
        if (inside && (top === null || height > top)) top = height;
    }
    return top === null ? 0 : top;
}

/**
 * One arrival node per portal, after all the world's other seeded nodes (so their ids do not move): in front of
 * the portal along its heading `yaw`, on the ground, with its +Z (the way a visitor faces) into the world.
 */
function portalArrivalSeeds(portals, yaw, authoredGraph)
{
    const forward = [ Math.sin(yaw), 0, Math.cos(yaw) ];
    return portals.map((portal, index) => {
        const at = portal.trigger && Array.isArray(portal.trigger.position) ? portal.trigger.position : [ 0, 0, 0 ];
        const x = Number(at[0]) + forward[0] * ARRIVAL_STAND_OFF_M;
        const z = Number(at[2]) + forward[2] * ARRIVAL_STAND_OFF_M;
        return {
            label : 'Arrival at ' + (portal.label || portal.portal_id),
            names : [ 'wow-portal-' + (index + 1) + '-arrival', ARRIVAL_ROLE ],
            localTransform : multiplyMatrices(translationMatrix([ x, groundHeightAt(authoredGraph, x, z), z ]), rotationYMatrix(yaw)),
            webofworlds_extension : { role : ARRIVAL_ROLE, portal_id : portal.portal_id },
        };
    });
}

/** A colour as three.js multiplies it: in linear light, back to an sRGB hex string. */
function shadeHex(hex, factor)
{
    const toLinear = (v) => (v <= 0.04045 ? v * 0.0773993808 : Math.pow(v * 0.9478672986 + 0.0521327014, 2.4));
    const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 0.41666) - 0.055);
    return [ 0, 2, 4 ].map((i) => {
        const value = toSrgb(toLinear(parseInt(hex.slice(i, i + 2), 16) / 255) * factor);
        return Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
    }).join('');
}

/**
 * A demo room as graph nodes, the same room the demo page draws (runtime/scene-core/public/canonical-world-content.js):
 * a square floor in the world's color, a back wall and a left wall, a grid, an ambient light and a key light, and a
 * view node at its middle facing the walls. The shapes are labeled OSL primitives (`osl-primitive:`), and the lights
 * labeled `osl-light:` nodes. The key light's node sits on the demo page's light direction, near enough for a preview
 * to reach it: a directional light depends only on that direction.
 */
function roomSeedNodes(room)
{
    const size = Number(room.size_m) || 12;
    const height = Number(room.wall_height_m) || 5;
    const base = /^#?[0-9a-f]{6}$/i.test(String(room.color || '')) ? String(room.color).replace('#', '') : '3aa0ff';
    // A unit shape scaled to (sx, sy, sz) and moved to (x, y, z), as a column-major localTransform.
    const placed = (sx, sy, sz, x, y, z) => [ sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1 ];
    const node = (name, label, transform, uri, color) => ({
        label : label,
        names : [ name, 'room' ],
        localTransform : transform,
        spatialAssetURI : uri,
        ...(color ? { appearanceURI : 'osl-color:' + color } : {}),
        webofworlds_extension : { role : 'room' },
    });
    return [
        node('room-floor', 'Room floor', placed(size, 0.02, size, 0, -0.01, 0), 'osl-primitive:box?size_m=1', shadeHex(base, 0.35)),
        node('room-grid', 'Room grid', placed(1, 1, 1, 0, 0.002, 0), 'osl-primitive:grid?size_m=' + size + '&divisions=' + size),
        node('room-wall-back', 'Room back wall', placed(size, height, 0.05, 0, height / 2, -size / 2), 'osl-primitive:box?size_m=1', shadeHex(base, 0.55)),
        node('room-wall-left', 'Room left wall', placed(0.05, height, size, -size / 2, height / 2, 0), 'osl-primitive:box?size_m=1', shadeHex(base, 0.55)),
        node('room-light-ambient', 'Room ambient light', placed(1, 1, 1, 0, 0, 0), 'osl-light:ambient?intensity=0.75'),
        node('room-light-key', 'Room key light', placed(1, 1, 1, 2, 4, 3), 'osl-light:directional?intensity=0.9'),
        // The middle of the room, facing the walls as the demo page's camera does: where a preview of this world is
        // seen from (World.preview names it).
        { label : 'Room view', names : [ 'room-view', 'room' ], localTransform : [ -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1 ], webofworlds_extension : { role : 'room' } },
    ];
}

// A Player's first view is the portals, with nothing of a destination loading yet: the start
// pose keeps this far outside each portal's loading circle, for the avatar's body and a margin.
const START_CLEARANCE_M = 0.45 + 0.25;

/**
 * How far from the portals' centre, along `forward`, a world's start pose stands: at least `minimum`, and far enough
 * that it lies outside every portal's loading circle (`radius(portal)`) by START_CLEARANCE_M.
 */
function startDistanceClearOfPortals(portals, centre, forward, minimum, radius)
{
    let distance = minimum;
    for (const portal of portals)
    {
        const at = portal.trigger && Array.isArray(portal.trigger.position) ? portal.trigger.position : centre;
        const dx = Number(at[0]) - centre[0];
        const dz = Number(at[2]) - centre[2];
        const reach = radius(portal) + START_CLEARANCE_M;
        const along = dx * forward[0] + dz * forward[2];
        const across = Math.hypot(dx - along * forward[0], dz - along * forward[2]);
        if (across < reach) distance = Math.max(distance, along + Math.sqrt(reach * reach - across * across));
    }
    return distance;
}

/**
 * Link the worlds of one process: a configured portal's destination then names the arrival node of its counterpart
 * in the world it leads to. `runtimes` is each world's runtime. The link reads the destination at every request, so
 * a re-seeded graph stays right.
 */
function linkPortalArrivals(runtimes)
{
    const byLocation = new Map(runtimes.map(runtime => [ runtime.LOCATION_ID, runtime ]));
    for (const runtime of runtimes)
    {
        runtime.setPortalJoinResolver((portal) => {
            const destination = byLocation.get(portal.target_location_id);
            return destination ? destination.portalArrivalNodeId(portal.target_portal_id) : null;
        });
    }
}

/** A node's placement in its graph: the transforms from the graph's root down to it, multiplied. */
function composedTransform(store, nodeId)
{
    let m = null;
    let at = store.getNode(nodeId, { form : 'flat' });
    for (let guard = 0; at && guard < 256; guard += 1)
    {
        const local = Array.isArray(at.localTransform) && at.localTransform.length === 16 ? at.localTransform : translationMatrix([ 0, 0, 0 ]);
        m = m ? multiplyMatrices(local, m) : local.slice();
        at = Number.isInteger(at.parent) ? store.getNode(at.parent, { form : 'flat' }) : null;
    }
    return m;
}

/** An active radius: a number of meters above 0 and at most 100, null for none, false when it is neither. */
function activeRadiusOf(value)
{
    if (value === undefined || value === null) return null;
    const r = Number(value);
    return Number.isFinite(r) && r > 0 && r <= 100 ? r : false;
}

/**
 * The portals a world holds beyond its configuration, each placed by one of its nodes: { node_id, destination, label,
 * active_radius_m }. `deps` are the world's own: its count of configured portals, how it finds a portal by id, its
 * nodes, and its proof boundary.
 */
function createPlacedPortals({ configuredCount, resolvePortal, storeOfNode, nodeRef, geoPoseOfNode, proofBoundary })
{
    const placed = [];
    return {
        at : index => placed[index],
        count : () => configuredCount() + placed.length,

        /**
         * Lab authoring: a portal placed by an existing node, leading to `destination` (an entry URL) or nowhere.
         * `active_radius_m`, when given, is the distance at which the portal wakes for a visitor and loads its
         * preview; without it the portal is always awake.
         */
        add(spec)
        {
            const nodeId = Number(spec && spec.node_id);
            if (!Number.isInteger(nodeId) || !storeOfNode(nodeId)) return { ok : false, error : 'node_not_found' };
            const radius = activeRadiusOf(spec.active_radius_m);
            if (radius === false) return { ok : false, error : 'invalid_active_radius' };
            placed.push({
                node_id : nodeId,
                destination : typeof spec.destination === 'string' && spec.destination ? spec.destination : null,
                label : String(spec.label || 'Portal'),
                active_radius_m : radius,
            });
            return { ok : true, id : configuredCount() + placed.length };
        },

        /**
         * Lab authoring: change a portal added by node (its destination, label, active radius, or the node that
         * places it). The portals a world's configuration declares are not changed here.
         */
        update(idOrAlias, spec)
        {
            const hit = resolvePortal(idOrAlias);
            if (!hit) return { ok : false, status : 404, error : 'portal_not_found' };
            if (!hit.added) return { ok : false, status : 409, error : 'configured_portal', message : 'this portal comes from the world\'s configuration; only placed portals change here' };
            const next = Object.assign({}, hit.added);
            if (spec.node_id !== undefined)
            {
                const nodeId = Number(spec.node_id);
                if (!Number.isInteger(nodeId) || !storeOfNode(nodeId)) return { ok : false, status : 422, error : 'node_not_found' };
                next.node_id = nodeId;
            }
            if (spec.destination !== undefined)
            {
                if (spec.destination !== null && typeof spec.destination !== 'string') return { ok : false, status : 422, error : 'invalid_destination' };
                next.destination = spec.destination ? spec.destination : null;
            }
            if (spec.label !== undefined) next.label = String(spec.label || 'Portal');
            if (spec.active_radius_m !== undefined)
            {
                const radius = activeRadiusOf(spec.active_radius_m);
                if (radius === false) return { ok : false, status : 422, error : 'invalid_active_radius' };
                next.active_radius_m = radius;
            }
            Object.assign(hit.added, next);
            return { ok : true, id : hit.wowId };
        },

        /** GET /wow/portal/{id} for a portal added by node: where it leads, the node that places it, its derived GeoPose. */
        resource(added, wowId)
        {
            const store = storeOfNode(added.node_id);
            const geoPose = store ? geoPoseOfNode(added.node_id) : undefined;
            return {
                id : wowId,
                label : added.label,
                ...(added.destination ? { destination : added.destination } : {}),
                ...(store ? { node : nodeRef(store, added.node_id) } : {}),
                ...(geoPose ? { geoPose } : {}),
                ...(added.active_radius_m != null ? { active_radius_m : added.active_radius_m } : {}),
                // placed with the placement tool, so the tool may move and change it (a configured portal answers 409)
                placed : true,
                proof_boundary : proofBoundary(),
            };
        },
    };
}

/** What a world shows as a preview: { node_id, radius_m, image }, from its configuration or set by lab authoring. */
function createWorldPreview({ storeOfNode, nodeRef, listNodes })
{
    let declared = null;
    return {
        /** Lab authoring: what this world shows as a preview (an arrival node and radius, an image, or both). */
        set(spec)
        {
            if (!spec) { declared = null; return { ok : true }; }
            const byLabel = spec.node_label != null ? listNodes().find(node => node.label === spec.node_label) : null;
            const nodeId = spec.node_id != null ? Number(spec.node_id) : byLabel ? byLabel.id : null;
            if (nodeId != null && !storeOfNode(nodeId)) return { ok : false, error : 'node_not_found' };
            declared = {
                node_id : nodeId,
                radius_m : Number.isFinite(Number(spec.radius_m)) ? Number(spec.radius_m) : 10,
                image : typeof spec.image === 'string' && spec.image ? spec.image : null,
            };
            return { ok : true };
        },

        /** World.preview: the arrival node, the radius and the preview URL, or an image URL, relative to the base. */
        ofWorld()
        {
            const d = declared;
            if (!d) return undefined;
            const store = d.node_id != null ? storeOfNode(d.node_id) : null;
            const out = {};
            if (store) Object.assign(out, { node : nodeRef(store, d.node_id), radius_m : d.radius_m, url : 'wow/preview' });
            if (d.image) out.image = d.image;
            return Object.keys(out).length ? out : undefined;
        },

        /**
         * The preview: the arrival node and every node of its graph whose position lies within the radius
         * of it, each with its transform relative to the arrival node. The caller filters what a reader
         * may see.
         */
        get()
        {
            const d = declared;
            const store = d && d.node_id != null ? storeOfNode(d.node_id) : null;
            if (!store) return null;
            const arrival = composedTransform(store, d.node_id);
            const toArrival = invertAffine(arrival);
            // A zero scale on the arrival node or above it hides the node (glTF 2.0 3.5.3): its placement
            // has no inverse, so nothing can be placed relative to it.
            if (!toArrival) return { graphId : store.graphId, arrivalId : d.node_id, radius_m : d.radius_m, nodes : [], hidden : true };
            const nodes = [];
            for (const node of store.listNodes())
            {
                const m = composedTransform(store, node.id);
                const distance = Math.hypot(m[12] - arrival[12], m[13] - arrival[13], m[14] - arrival[14]);
                if (distance > d.radius_m) continue;
                nodes.push({ node : node, relative : multiplyMatrices(toArrival, m), distance : distance });
            }
            return { graphId : store.graphId, arrivalId : d.node_id, radius_m : d.radius_m, nodes : nodes, worldTransform : arrival };
        },
    };
}

module.exports = { ARRIVAL_STAND_OFF_M, ARRIVAL_ROLE, composedTransform, createPlacedPortals, createWorldPreview, groundHeightAt, portalArrivalSeeds, roomSeedNodes, startDistanceClearOfPortals, linkPortalArrivals };
