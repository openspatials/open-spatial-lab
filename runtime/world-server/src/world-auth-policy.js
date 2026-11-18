'use strict';

/*
 * Iteration 6 (permissions): which scope each request needs, and what a reader sees of people.
 *
 * SCOPES. Four, each named for the requests it gates (the roadmap's "Iteration 6. Permissions"):
 *   read      GET and HEAD of the World, User, View, Portal, Spatial and Node resources, and of every other read
 *             route a world serves (its presence, debug state, region, assets, placement policy);
 *   observe   the event streams (/events, and the full-state stream /runtime-state);
 *   write     node POST, PUT and DELETE, and every other write route (portal placement, demo moves, reset);
 *   enter     joining (POST /wow/user) and leaving (DELETE /wow/user/{userId}, own user only), and the Lab's own
 *             presence and crossing routes, which are how a player enters and leaves.
 * A grant names a scope and a resource. The resource is the world ("world"), the world's User resources ("users"),
 * or one node ("wow/spatial/{g}/node/{n}", relative to the world's base URL, as the request path names it):
 *   - GET /wow/user/{userId} needs a read grant that names the User resources, and a read grant for the rest of the
 *     world does not cover them. That read grant is also the presence grant: a reader without it sees no person on
 *     any path (the people below).
 *   - A node write (POST, PUT or DELETE of /wow/spatial/{g}/node/{n}) needs a write grant that names that node, or
 *     one that names the world. A write grant on one node covers no other node (not its children either: a POST
 *     under n is a write on n, a PUT or DELETE of a child is a write on the child).
 *   - Observe and enter grants cover a world: they name "world" only. Read names "world" or "users".
 *   (grantProblem says which pairs a grant may name; covers says which granted resource covers which needed one.)
 * Open, with no token: GET /healthz (liveness only), OPTIONS (preflights carry no credentials), the protected
 * resource metadata and the authorization server's metadata and token endpoint (world-auth.js serves those).
 *
 * PEOPLE. A reader who does not hold the presence grant is shown no person:
 *   - the lists of people (users, occupancy.avatars, session.connected_clients, region avatars) are emptied; the
 *     counts stay;
 *   - every member that names a person (player_id, client_id, continuity_id, display_name, userId, user_id,
 *     wow_user_id, the user object of an event) is removed wherever it sits;
 *   - a node that places a person in the world's graph (the Lab's presence places each person present as a node
 *     whose webofworlds_extension.role is "user-placement") keeps its place but names nobody: its label is "User",
 *     its User resource and the names that carry the user's id are left out. This holds in every Web of Worlds
 *     answer (a Node, the nodes a POST made) and in every event (iteration 7: a world that includes this one shows
 *     its nodes to its own viewers);
 *   - a user event (user_joined, user_left) still arrives, with its revision, time and type, without the user and
 *     without the User URLs, so every observer sees every revision.
 */

const SCOPES = Object.freeze([ 'read', 'observe', 'write', 'enter' ]);
/** The resources a grant may name: the world, its User resources, or one node (the template). */
const RESOURCES = Object.freeze([ 'world', 'users', 'wow/spatial/{g}/node/{n}' ]);
const NODE_RESOURCE = /^wow\/spatial\/[^/]+\/node\/[^/]+$/;
const isNode = (r) => NODE_RESOURCE.test(String(r));
/** Whether `resource` is one a grant may name (an entry of RESOURCES, the node template filled in). */
const isResource = (resource) => resource === 'world' || resource === 'users' || isNode(resource);
/** Why a grant of `scope` cannot name `resource`, or null when it can. */
function grantProblem(scope, resource)
{
    if (!isResource(resource)) return 'a grant names the resource world, users or one node (wow/spatial/{g}/node/{n}), not ' + JSON.stringify(resource);
    if (resource === 'users' && scope !== 'read') return 'only a read grant names the User resources';
    if (isNode(resource) && scope !== 'write') return 'only a write grant names one node; ' + scope + ' grants cover a world';
    return null;
}
/** Whether a grant that names `granted` covers a request that needs `needed`: the same resource, or a node of the world. */
function covers(granted, needed)
{
    if (granted === needed) return true;
    return granted === 'world' && isNode(needed);
}

/** The routes a player enters and leaves through (POST): enter. */
const ENTER_ROUTES = new Set([
    '/wow/user',
    '/fabric/presence/register', '/fabric/presence/heartbeat', '/fabric/presence/depart',
    '/portal/exit-intent', '/portal/arrival', '/wow/portal/exit', '/wow/portal/arrival',
]);
/** Read routes open to anyone: liveness only. */
const OPEN_READS = new Set([ '/healthz' ]);
const USER_PATH = /^\/wow\/user\/[^/]+$/;
const READ_METHODS = new Set([ 'GET', 'HEAD' ]);

/** The grant a request needs as part a gave it, before node writes name their node. */
function worldNeedOf(method, path)
{
    const m = String(method || '').toUpperCase();
    const p = String(path || '').replace(/\/+$/, '') || '/';
    if (m === 'OPTIONS') return null;
    if (READ_METHODS.has(m))
    {
        if (OPEN_READS.has(p)) return null;
        if (USER_PATH.test(p)) return { scope : 'read', resource : 'users' };
        return { scope : 'read', resource : 'world' };
    }
    if (m === 'POST' && ENTER_ROUTES.has(p)) return { scope : 'enter', resource : 'world' };
    if (m === 'DELETE' && USER_PATH.test(p)) return { scope : 'enter', resource : 'world', ownUser : decodeURIComponent(p.slice('/wow/user/'.length)) };
    return { scope : 'write', resource : 'world' };
}

const NODE_PATH = /^\/wow\/spatial\/([^/]+)\/node\/([^/]+)$/;
/**
 * The grant a request needs: { scope, resource, ownUser? }, or null when it needs none. `path` is relative to the
 * world's base path. DELETE /wow/user/{userId} also names the user, which must be the requester's own. A node write
 * names its node (wow/spatial/{g}/node/{n}).
 */
function needOf(method, path)
{
    const need = worldNeedOf(method, path);
    const node = NODE_PATH.exec(String(path || '').replace(/\/+$/, ''));
    if (need && need.scope === 'write' && node) return { scope : 'write', resource : 'wow/spatial/' + decodeURIComponent(node[1]) + '/node/' + decodeURIComponent(node[2]) };
    return need;
}

/** What an event stream needs. */
const STREAM_NEED = Object.freeze({ scope : 'observe', resource : 'world' });
/** The presence grant: a read grant that names the world's User resources. */
const PRESENCE_GRANT = Object.freeze({ scope : 'read', resource : 'users' });

/** Members that name a person. */
const PERSON_MEMBERS = new Set([ 'player_id', 'client_id', 'continuity_id', 'display_name', 'userId', 'user_id', 'wow_user_id' ]);
/** Lists of people. */
const PEOPLE_LISTS = new Set([ 'users', 'avatars', 'connected_clients' ]);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const userUrl = (u) => /(^|\/)wow\/user\/[^/]+$/.test(String(u));

/** Whether a value is a node that places a person (the Lab's presence placement). */
const placesPerson = (v) => isObject(v) && isObject(v.webofworlds_extension) && v.webofworlds_extension.role === 'user-placement';
/** That node naming nobody, its other members passed through `walk`. */
function withoutPlacedPerson(node, walk)
{
    const out = {};
    for (const [ key, member ] of Object.entries(node))
    {
        if (key === 'label') { out.label = 'User'; continue; }
        if (key === 'names' && Array.isArray(member)) { out.names = member.filter((n) => !/^wow-user-/.test(String(n))); continue; }
        if (key === 'webofworlds_extension') { const ext = Object.assign({}, member); delete ext.resource; out[key] = ext; continue; }
        out[key] = walk(member);
    }
    return out;
}
/** A copy of `value` in which no node that places a person names that person; nothing else changes. */
function withoutPlacedPeople(value)
{
    if (Array.isArray(value)) return value.map(withoutPlacedPeople);
    if (!isObject(value)) return value;
    if (placesPerson(value)) return withoutPlacedPerson(value, withoutPlacedPeople);
    const out = {};
    for (const [ key, member ] of Object.entries(value)) out[key] = withoutPlacedPeople(member);
    return out;
}

/** A copy of `value` with no person in it (the rules above). A list of people keeps no entry; a count stays. */
function withoutPeople(value)
{
    if (Array.isArray(value)) return value.map(withoutPeople);
    if (!isObject(value)) return value;
    if (placesPerson(value)) return withoutPlacedPerson(value, withoutPeople);
    const out = {};
    for (const [ key, member ] of Object.entries(value))
    {
        if (PERSON_MEMBERS.has(key)) continue;
        if (key === 'user' && isObject(member)) continue;
        if (PEOPLE_LISTS.has(key) && Array.isArray(member)) { out[key] = []; continue; }
        if (key === 'urls' && Array.isArray(member)) { out[key] = member.filter((u) => !userUrl(u)); continue; }
        out[key] = withoutPeople(member);
    }
    return out;
}

/** An event as an observer without the presence grant receives it: the same revision, no person. */
function anonymousEvent(evt)
{
    return withoutPeople(evt);
}

/**
 * The World resource as a reader without the presence grant reads it: the Lab's extension lists the people
 * present (webofworlds_extension.users, source presence-registry); they are left out, the world's own hosted
 * avatar and every count stay. The World's own members are not touched, so it stays a valid World.
 */
function worldWithoutPeople(world)
{
    if (!isObject(world) || !isObject(world.webofworlds_extension) || !Array.isArray(world.webofworlds_extension.users)) return world;
    const ext = Object.assign({}, world.webofworlds_extension, {
        users : world.webofworlds_extension.users.filter((u) => !(isObject(u) && u.source === 'presence-registry')),
    });
    return Object.assign({}, world, { webofworlds_extension : ext });
}

module.exports = { SCOPES, RESOURCES, isResource, grantProblem, covers, needOf, STREAM_NEED, PRESENCE_GRANT, withoutPeople, withoutPlacedPeople, anonymousEvent, worldWithoutPeople, ENTER_ROUTES };
