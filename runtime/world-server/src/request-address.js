'use strict';

/*
 * The address a browser on another machine reaches a world at.
 *
 * A lab bound to a network address (OSL_BIND_HOST, for example 0.0.0.0) with no OSL_PUBLIC_ORIGIN has world addresses
 * that say 127.0.0.1 (worlds.json), which is that browser's own machine. In that one case, what the lab tells a browser
 * names the host the browser used in its request. A lab bound to 127.0.0.1, and a live public lab, change nothing.
 *
 * The frontend passes the browser's host on to a world in X-Forwarded-Host, so a world read through /api/{key}/ answers
 * the same as a world read directly.
 */

const { bindHost } = require('./local-only');

const LOOPBACK = '127.0.0.1';
const HOST_NAME = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/;

/** The host name this request's browser used, when addresses must follow it; otherwise null. */
function requestHostName(req, env = process.env)
{
    if (String(env.OSL_PUBLIC_ORIGIN || '').trim() || bindHost(env) === LOOPBACK) return null;
    const raw = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
    let hostName = null;
    try { hostName = new URL('http://' + raw).hostname; } catch (e) { hostName = null; }
    return hostName && hostName !== LOOPBACK && HOST_NAME.test(hostName) ? hostName : null;
}

/** A JSON text with every loopback world address replaced by the request's host name. */
function asSeenFrom(req, text, env = process.env)
{
    const hostName = requestHostName(req, env);
    return hostName ? text.split('http://' + LOOPBACK + ':').join('http://' + hostName + ':') : text;
}

module.exports = { requestHostName, asSeenFrom };
