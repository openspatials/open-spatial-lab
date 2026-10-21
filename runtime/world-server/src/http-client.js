'use strict';

// Tiny promise HTTP client (Node core only) for tests / exercise scripts.
const http = require('http');

function request(method, url, body)
{
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Connection' : 'close' };
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        const req = http.request({
            hostname : u.hostname,
            port : u.port,
            path : u.pathname + u.search,
            method,
            agent : false, // no keep-alive: avoids lingering sockets against a closed test server
            headers,
        }, res => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => {
                let json = null;
                try { json = out ? JSON.parse(out) : null; } catch (e) { json = { _raw : out }; }
                resolve({ status : res.statusCode, headers : res.headers, json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const get = (url) => request('GET', url);
const post = (url, body) => request('POST', url, body);
// PUT/DELETE for the /wow/spatial node-CRUD acceptance checks.
const put = (url, body) => request('PUT', url, body);
const del = (url, body) => request('DELETE', url, body);

module.exports = { request, get, post, put, del };
