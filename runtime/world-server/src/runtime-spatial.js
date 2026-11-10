'use strict';
const { createSpatialGraphStore, translationMatrix } = require('./spatial-graph');

/** Selects the existing graph stores and preserves mutation publication order. */
class RuntimeSpatial
{
    constructor({ worldId, locationId, title, anchors, seedBuilder, publish, emitEvent, proofBoundary })
    {
        this.locationId = locationId;
        this.anchors = anchors;
        this.publish = publish;
        this.emitEvent = emitEvent;
        this.proofBoundary = proofBoundary;
        this.primary = createSpatialGraphStore({ spatialId : worldId, graphId : 1,
            acceptedIds : [ worldId, locationId, 'default', 'world' ], seedBuilder });
        this.stores = [ this.primary ].concat(Array.from(anchors.keys())
            .filter(id => id !== 1).sort((a, b) => a - b).map(id => createSpatialGraphStore({
                spatialId : worldId + '.graph-' + id, graphId : id, acceptedIds : [],
                ids : this.primary.ids, rootId : this.primary.ids.issue(),
                seedBuilder : () => ({ root : { label : title + ' - graph ' + id,
                    names : [ worldId + '.graph-' + id ], localTransform : translationMatrix([ 0, 0, 0 ]) }, nodes : [] }),
            })));
    }

    resetToSeed() { for (const store of this.stores) store.resetToSeed(); }
    listSpatialNodes()
    {
        const out = [];
        for (const store of this.stores) for (const node of store.listNodes()) out.push({ graphId : store.graphId, node : node });
        return out;
    }

    spatialGraphIds()
    {
        return this.stores.map(store => store.graphId);
    }

    spatialResolve(spatialID)
    {
        return this.stores.find(store => store.matches(spatialID)) || null;
    }

    getSpatialGraphRoot(spatialID, opts)
    {
        const store = this.spatialResolve(spatialID);
        return store ? store.getRoot(opts) : null;
    }

    getSpatialDescriptor(spatialID)
    {
        const store = this.spatialResolve(spatialID);
        if (!store) return null;
        const root = store.getRoot({ form : 'flat' });
        const rootNodeID = root ? root.id : store.rootId;
        const anchor = this.anchors.get(store.graphId);
        return {
            id : store.graphId,
            rootNodeID : rootNodeID,
            // the graph's anchor, as read from the fixture; a graph with no anchor has no geoPose
            ...(anchor ? { geoPose : JSON.parse(JSON.stringify(anchor)) } : {}),
            // LABELED, NON-CANONICAL additive members.
            webofworlds_extension : {
                x_osl_extension : true,
                spatial_id : store.spatialId,
                accepted_ids : store.acceptedIds,
                root_node_endpoint : '/wow/spatial/' + store.graphId + '/node/' + rootNodeID,
                note : 'The graph id is the integer `id`. The world id and the location id in `accepted_ids` are '
                    + 'deprecated aliases that still resolve. The root node is at root_node_endpoint.',
            },
            proof_boundary : this.proofBoundary(),
        };
    }

    getSpatialNode(spatialID, nodeId, opts)
    {
        const store = this.spatialResolve(spatialID);
        return store ? store.getNode(nodeId, opts) : null;
    }

    createSpatialNodes(spatialID, parentId, incoming, opts)
    {
        const store = this.spatialResolve(spatialID);
        if (!store) return { ok : false, status : 404, error : 'spatial_graph_not_found', spatialID : spatialID };
        const r = store.createChildren(parentId, incoming, opts);
        if (r.ok)
        {
            this.publish('wow-spatial-node-create');
            // one node_created per created node on /events.
            for (const node of (r.value || [])) this.emitEvent(this.nodeEvent('node_created', store.spatialId, node, this.nodeUrls(store, node.id)));
        }
        return r;
    }

    updateSpatialNode(spatialID, nodeId, node, opts)
    {
        const store = this.spatialResolve(spatialID);
        if (!store) return { ok : false, status : 404, error : 'spatial_graph_not_found', spatialID : spatialID };
        const before = store.getNode(nodeId, { form : 'flat' });
        const ancestorsBefore = before ? this.nodeUrls(store, before.id) : [];
        const r = store.updateNode(nodeId, node, opts);
        if (r.ok)
        {
            // A write that leaves the node as it was is no change: no revision and no event.
            if (JSON.stringify(before) === JSON.stringify(store.getNode(nodeId, { form : 'flat' }))) return Object.assign(r, { unchanged : true });
            this.publish('wow-spatial-node-update');
            // node_updated on /events, naming the node and every ancestor that embeds it, before and after a move.
            this.emitEvent(this.nodeEvent('node_updated', store.spatialId, r.value, ancestorsBefore.concat(this.nodeUrls(store, r.value.id))));
        }
        return r;
    }

    deleteSpatialNode(spatialID, nodeId)
    {
        const store = this.spatialResolve(spatialID);
        if (!store) return { ok : false, status : 404, error : 'spatial_graph_not_found', spatialID : spatialID };
        const existing = store.getNode(nodeId, { form : 'flat' });
        const above = existing && Number.isInteger(existing.parent) ? this.nodeUrls(store, existing.parent) : [];
        const r = store.deleteNode(nodeId);
        if (r.ok)
        {
            this.publish('wow-spatial-node-delete');
            // one node_deleted per removed id (whole subtree).
            for (const id of ((r.value && r.value.deleted) || []))
                this.emitEvent(this.nodeEvent('node_deleted', store.spatialId, { id : id }, [ 'wow/spatial/' + store.graphId + '/node/' + id ].concat(above)));
        }
        return r;
    }

    nodeUrls(store, nodeId)
    {
        const urls = [];
        let cursor = store.getNode(nodeId, { form : 'flat' });
        for (let steps = 0; cursor && steps < 10000; steps += 1)
        {
            urls.push('wow/spatial/' + store.graphId + '/node/' + cursor.id);
            cursor = Number.isInteger(cursor.parent) ? store.getNode(cursor.parent, { form : 'flat' }) : null;
        }
        return urls;
    }

    storeOfNode(nodeId)
    {
        return this.stores.find(store => store.getNode(nodeId, { form : 'flat' })) || null;
    }

    nodeEvent(type, spatialID, node, urls)
    {
        const n = node && typeof node === 'object' ? node : {};
        const evt = {
            type : type,
            ts : new Date().toISOString(),
            // As simpleWorlds sends them: node_created and node_updated carry the whole node, node_deleted its nodeId.
            node : type === 'node_deleted' ? { id : n.id } : JSON.parse(JSON.stringify(n)),
            spatialID : spatialID,
            urls : urls || [],
            location_id : this.locationId,
            proof_boundary : this.proofBoundary(),
        };
        if (type === 'node_deleted') evt.nodeId = n.id;
        return evt;
    }
}

function nodeRef(store, nodeId) { return 'wow/spatial/' + store.graphId + '/node/' + nodeId; }

function createRuntimeSpatial(options)
{
    const owner = new RuntimeSpatial(options);
    return {
        primary : owner.primary,
        nodeRef,
        resetToSeed : owner.resetToSeed.bind(owner),
        listSpatialNodes : owner.listSpatialNodes.bind(owner),
        spatialGraphIds : owner.spatialGraphIds.bind(owner),
        spatialResolve : owner.spatialResolve.bind(owner),
        getSpatialGraphRoot : owner.getSpatialGraphRoot.bind(owner),
        getSpatialDescriptor : owner.getSpatialDescriptor.bind(owner),
        getSpatialNode : owner.getSpatialNode.bind(owner),
        createSpatialNodes : owner.createSpatialNodes.bind(owner),
        updateSpatialNode : owner.updateSpatialNode.bind(owner),
        deleteSpatialNode : owner.deleteSpatialNode.bind(owner),
        storeOfNode : owner.storeOfNode.bind(owner),
    };
}

module.exports = { createRuntimeSpatial };
