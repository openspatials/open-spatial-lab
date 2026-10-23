'use strict';

/*
 * Graph anchors: where each spatial graph of a world sits on Earth.
 *
 * No Web of Worlds operation writes a GeoPose, so a graph's anchor is part of the server's
 * configuration. It is a fixture file or object of this shape:
 *
 *   { "graphs": [ { "id": 1, "geoPose": { "position": { "lat": 47.7, "lon": -122.3, "h": 11.5 },
 *                                          "angles": { "yaw": 0, "pitch": 0, "roll": 0 } } } ] }
 *
 * Graph 1 is the world's default graph. A graph other than graph 1 may leave out its
 * geoPose: it then has no anchor.
 *
 * Every anchor is read through the one GeoPose reader (web/wow-geopose.js), the same code the
 * browser uses on `Spatial.geoPose`. A fixture the reader refuses stops the server from starting,
 * with the reader's named error, rather than serving a placement nobody checked.
 */

const fs = require('fs');
const geo = require('../../../web/wow-geopose.js');

class AnchorFixtureError extends Error {
    constructor(code, where, message)
    {
        super(code + ' at ' + where + ': ' + message);
        this.name = 'AnchorFixtureError';
        this.code = code;
        this.path = where;
    }
}

/**
 * @param {string|object} source   a path to a fixture file, or the fixture object itself
 * @returns {Map<number, object|null>}  graph id -> GeoPose (`lon` spelling, as read), or null for no anchor
 */
function loadAnchors(source)
{
    let doc = source;
    if (typeof source === 'string')
    {
        try { doc = JSON.parse(fs.readFileSync(source, 'utf8')); }
        catch (error) { throw new AnchorFixtureError('ANCHOR_FIXTURE_UNREADABLE', source, error.message); }
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.graphs) || doc.graphs.length === 0)
        throw new AnchorFixtureError('ANCHOR_FIXTURE_FORMAT', '$', 'expected { graphs: [ { id, geoPose } ] } with at least one graph');
    const anchors = new Map();
    doc.graphs.forEach((graph, index) => {
        const at = 'graphs[' + index + ']';
        if (!graph || !Number.isInteger(graph.id) || graph.id < 1)
            throw new AnchorFixtureError('ANCHOR_FIXTURE_GRAPH_ID', at + '.id', 'a graph id is an integer from 1');
        if (anchors.has(graph.id))
            throw new AnchorFixtureError('ANCHOR_FIXTURE_GRAPH_ID', at + '.id', 'graph id ' + graph.id + ' appears twice');
        // A world's other graphs may have no anchor: they are not placed on Earth, and a host that
        // includes the whole world does not show them. Graph 1 always has one, because it is where the
        // world itself is found.
        if (graph.id !== 1 && (graph.geoPose === null || graph.geoPose === undefined))
        {
            anchors.set(graph.id, null);
            return;
        }
        const read = geo.readGeoPose(graph.geoPose);
        if (!read.ok)
            throw new AnchorFixtureError(read.error.code, at + '.geoPose' + (read.error.path ? '.' + read.error.path : ''), read.error.message);
        for (const warning of read.warnings)
            console.warn('[spatial-anchor] ' + at + '.geoPose.' + warning.path + ': ' + warning.code + ' (' + warning.message + ')');
        anchors.set(graph.id, read.geoPose);
    });
    return anchors;
}

module.exports = { loadAnchors, AnchorFixtureError };
