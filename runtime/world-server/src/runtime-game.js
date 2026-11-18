'use strict';

/*
 * Iteration 7 (a running world inside a world): a small live game that a world runs on its own server. It runs only
 * when the world's config asks for it (cfg.game, an object); a world without cfg.game never loads it.
 *
 * The game is three nodes under one node, "game", in one graph (graph 1 by default), made at the first start and
 * found again by label after a restart:
 *   ball     moves on a circle under the server's logic, one step each tick; its localTransform is the server state
 *   button   properties.presses counts the presses; a visitor presses it with a node PUT that raises presses by one
 *            (with If-Match, so two presses at the same moment both count)
 *   light    properties.on follows the button: each counted press toggles it (on when presses is odd)
 * Every change is an ordinary node write, so every reader and every event stream of the world sees it. The game
 * keeps a log of the ball's steps (tick, revision, position in the graph's frame) for the proof.
 */

const DEFAULTS = Object.freeze({ graph : 1, interval_ms : 200, radius_m : 0.4137, height_m : 0.0613, step_deg : 7.3 });
const LABELS = Object.freeze({ game : 'game', ball : 'ball', button : 'button', light : 'light' });
const IDENTITY = Object.freeze([ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ]);
const at = (x, y, z) => [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 ];

/** The ball's position in the game node's frame at a tick. */
function ballAt(opts, tick)
{
    const angle = (tick * opts.step_deg * Math.PI) / 180;
    return [ Number((opts.radius_m * Math.cos(angle)).toFixed(6)), opts.height_m, Number((opts.radius_m * Math.sin(angle)).toFixed(6)) ];
}

function createGame(runtime, spec)
{
    const opts = Object.assign({}, DEFAULTS, spec && typeof spec === 'object' ? spec : {});
    const graph = String(opts.graph);
    const flat = { form : 'flat' };

    function childByLabel(parentId, label)
    {
        const parent = runtime.getSpatialNode(graph, parentId, flat);
        for (const id of (parent && Array.isArray(parent.children) ? parent.children : []))
        {
            const child = runtime.getSpatialNode(graph, typeof id === 'object' ? id.id : id, flat);
            if (child && child.label === label) return child.id;
        }
        return null;
    }
    function make(parentId, label, body)
    {
        const found = childByLabel(parentId, label);
        if (found !== null) return found;
        const r = runtime.createSpatialNodes(graph, parentId, [ Object.assign({ label }, body) ], flat);
        if (!r.ok || !r.value || !r.value[0]) throw new Error('the game could not make its ' + label + ' node: ' + (r.error || r.status));
        return r.value[0].id;
    }

    const root = runtime.getSpatialDescriptor(graph).rootNodeID;
    const ids = {};
    ids.game = make(root, LABELS.game, { localTransform : at(0, 0.8, 0) });
    ids.ball = make(ids.game, LABELS.ball, { localTransform : at(...ballAt(opts, 0)) });
    ids.button = make(ids.game, LABELS.button, { localTransform : at(0.3, 0.02, -0.3), properties : { presses : 0 } });
    ids.light = make(ids.game, LABELS.light, { localTransform : at(-0.3, 0.25, -0.3), properties : { on : false } });

    const log = [];
    let tick = 0;
    let stopped = false;

    function step()
    {
        if (stopped) return;
        tick += 1;
        const position = ballAt(opts, tick);
        const r = runtime.updateSpatialNode(graph, ids.ball, { localTransform : at(...position) }, flat);
        if (r.ok) log.push({ tick, revision : runtime.currentRevision().revision, position });
    }

    /** The light follows the button's count of presses: on when it is odd. */
    function follow()
    {
        if (stopped) return;
        const button = runtime.getSpatialNode(graph, ids.button, flat);
        const light = runtime.getSpatialNode(graph, ids.light, flat);
        if (!button || !light) return;
        const presses = Number(button.properties && button.properties.presses) || 0;
        const on = presses % 2 === 1;
        if (!!(light.properties && light.properties.on) === on) return;
        runtime.updateSpatialNode(graph, ids.light, { properties : Object.assign({}, light.properties || {}, { on }) }, flat);
    }

    // A change of the light is written after the button's event has reached every subscriber, so events stay in
    // revision order on every stream.
    const unsubscribe = runtime.subscribeEvents((evt) => {
        if (evt && evt.type === 'node_updated' && evt.node && evt.node.id === ids.button) setImmediate(follow);
    });
    follow();
    const timer = setInterval(step, opts.interval_ms);

    return {
        ids : Object.assign({}, ids),
        graph,
        /** The ball's steps so far: { tick, revision, position } (position in the game node's frame). */
        log : () => log.slice(),
        /** The game's state as its server holds it now. */
        state()
        {
            const node = (id) => runtime.getSpatialNode(graph, id, flat);
            const button = node(ids.button);
            const light = node(ids.light);
            return {
                revision : runtime.currentRevision().revision,
                game : node(ids.game).localTransform.slice(),
                ball : node(ids.ball).localTransform.slice(),
                presses : Number(button.properties && button.properties.presses) || 0,
                on : !!(light.properties && light.properties.on),
            };
        },
        stop()
        {
            stopped = true;
            clearInterval(timer);
            unsubscribe();
        },
    };
}

module.exports = { createGame, ballAt, IDENTITY };
