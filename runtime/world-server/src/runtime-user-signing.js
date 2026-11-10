'use strict';
/** Local demo identity adapter; cryptography remains in web/signing. Cache key is canonical content. */
const crypto = require('crypto');
const nodePath = require('path');
const { pathToFileURL } = require('url');

const UM_SIGNING_LIB_URL = pathToFileURL(
    nodePath.join(__dirname, '..', '..', '..', 'web', 'signing', 'index.mjs')).href;
let _umSigningLibPromise = null;
function umSigningLib()
{
    if (!_umSigningLibPromise) _umSigningLibPromise = import(UM_SIGNING_LIB_URL);
    return _umSigningLibPromise;
}
const UM_DEV_IDENTITY_SEED = new Uint8Array(crypto.createHash('sha256')
    .update('open-spatial-lab-local-identity-v1')
    .digest());
const WOW_OPEN_USER_MANIFEST_DEMO_AGE = 30;
const UM_IDENTITY_NONCANONICAL_LABEL =
    'non-canonical additive (x-osl-extension): REAL UM identity signature '
    + '(Ed25519 over JCS-RFC8785 canonical bytes; did:key). standards_conformance stays false; '
    + 'separate from the deferred .msf RS256/x5c engine spine.';
const _umSignedCache = new Map();

async function umSignOpenUserManifest(content)
{
    const lib = await umSigningLib();
    const canon = lib.canonicalizeToString(content);
    if (_umSignedCache.has(canon)) return _umSignedCache.get(canon);
    const signed = await lib.attachSignatureProfileA(content, UM_DEV_IDENTITY_SEED);
    _umSignedCache.set(canon, signed);
    return signed;
}

module.exports = { umSignOpenUserManifest, WOW_OPEN_USER_MANIFEST_DEMO_AGE, UM_IDENTITY_NONCANONICAL_LABEL };
