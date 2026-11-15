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
 * A graph may also carry an `extent`, { "min": [x, y, z], "max": [x, y, z] }: the box the graph
 * occupies, in meters, in the graph's frame. It is served as `Spatial.extent`. An extent that is not
 * two corners of three finite numbers, or whose `min` exceeds `max` on any axis, is refused with
 * status 422 and a named reason, and the server does not start.
 *
 * Every anchor is read through the one GeoPose reader (web/wow-geopose.js), the same code the
 * browser uses on `Spatial.geoPose`. A fixture the reader refuses stops the server from starting,
 * with the reader's named error, rather than serving a placement nobody checked.
 */

const fs = require('fs');
const geo = require('../../../web/wow-geopose.js');

class AnchorFixtureError extends Error {
    constructor(code, where, message, status)
    {
        super(code + ' at ' + where + ': ' + message);
        this.name = 'AnchorFixtureError';
        this.code = code;
        this.path = where;
        this.reason = message;
        if (status !== undefined) this.status = status;
    }
}

/** The fixture document: a path to a fixture file is read, an object is taken as it is. */
function readFixture(source)
{
    let doc = source;
    if (typeof source === 'string')
    {
        try { doc = JSON.parse(fs.readFileSync(source, 'utf8')); }
        catch (error) { throw new AnchorFixtureError('ANCHOR_FIXTURE_UNREADABLE', source, error.message); }
    }
    return doc;
}

/**
 * @param {string|object} source   a path to a fixture file, or the fixture object itself
 * @returns {Map<number, object|null>}  graph id -> GeoPose (`lon` spelling, as read), or null for no anchor
 */
function loadAnchors(source)
{
    const doc = readFixture(source);
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

/**
 * One graph's extent: { min: [x, y, z], max: [x, y, z] }, in meters, in the graph's frame.
 * @returns {{ ok: true, extent: object } | { ok: false, status: 422, error: string, reason: string }}
 */
function readExtent(value)
{
    const corner = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
    if (!value || typeof value !== 'object' || !corner(value.min) || !corner(value.max))
        return { ok : false, status : 422, error : 'SPATIAL_EXTENT_FORMAT',
            reason : 'an extent is { min: [x, y, z], max: [x, y, z] }, each corner three finite numbers in meters' };
    for (let axis = 0; axis < 3; axis += 1)
        if (value.min[axis] > value.max[axis])
            return { ok : false, status : 422, error : 'SPATIAL_EXTENT_MIN_EXCEEDS_MAX',
                reason : 'min exceeds max on the ' + 'xyz'[axis] + ' axis (' + value.min[axis] + ' > ' + value.max[axis] + ')' };
    return { ok : true, extent : { min : value.min.slice(), max : value.max.slice() } };
}

/**
 * The extents of a fixture that loadAnchors accepts.
 * @param {string|object} source   a path to a fixture file, or the fixture object itself
 * @returns {Map<number, object>}  graph id -> extent, for each graph that has one
 */
function loadExtents(source)
{
    const doc = readFixture(source);
    const extents = new Map();
    doc.graphs.forEach((graph, index) => {
        if (graph.extent === undefined || graph.extent === null) return;
        const read = readExtent(graph.extent);
        if (!read.ok) throw new AnchorFixtureError(read.error, 'graphs[' + index + '].extent', read.reason, read.status);
        extents.set(graph.id, read.extent);
    });
    return extents;
}

module.exports = { loadAnchors, loadExtents, readExtent, AnchorFixtureError };
