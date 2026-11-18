'use strict';
/** Project current identities; delete delegates to the existing presence owner. */
const { WOW_GEOPOSE_MAPPING, WOW_LOCAL_USER_ID } = require('./runtime-projection-policy');
const { getWowProofBoundary } = require('./runtime-world-projection');
const { umSignOpenUserManifest, WOW_OPEN_USER_MANIFEST_DEMO_AGE, UM_IDENTITY_NONCANONICAL_LABEL } = require('./runtime-user-signing');
class RuntimeUsers
{
    constructor({ readAvatar, readPresence, depart, placements, spatial, geoPose, sessionId, worldId, locationId })
    {
        this.readAvatar = readAvatar;
        this.readPresence = readPresence;
        this.depart = depart;
        this.placements = placements;
        this.spatial = spatial;
        this.geoPose = geoPose;
        this.sessionId = sessionId;
        this.worldId = worldId;
        this.locationId = locationId;
    }
    getWowUser(userId)
    {
        const a = this.readAvatar();
        const accepted = [ String(WOW_LOCAL_USER_ID), a.avatar_id, a.continuity_id, 'me' ]
            .filter((alias, index, all) => all.indexOf(alias) === index);
        if (!userId || accepted.indexOf(String(userId)) !== -1)
        {
            const t = a.transform;
            const placed = this.placements.hostedNodeId('user') != null && this.spatial.storeOfNode(this.placements.hostedNodeId('user')) ? this.placements.hostedNodeId('user') : null;
            return {
                id : WOW_LOCAL_USER_ID, // number, per WoW User schema
                name : a.display_name,
                AvatarURI : '', // avatar is a client-side VRM/GLB; this node hosts no avatar asset
                ...(placed != null ? { node : this.spatial.nodeRef(this.spatial.primary, placed) } : {}),
                geoPose : this.placements.geoPoseOfNode(placed) || this.geoPose(t.position, t.rotation_y, 0),
                webofworlds_extension : {
                    avatar_id : a.avatar_id,
                    continuity_id : a.continuity_id,
                    display_name : a.display_name,
                    accepted_aliases : accepted,
                    local_transform : {
                        position : t.position.slice(),
                        rotation_y : t.rotation_y,
                        orientation : t.orientation.slice(),
                        scale : t.scale.slice(),
                    },
                    geopose_mapping : WOW_GEOPOSE_MAPPING,
                    source_session_id : a.handoff_context ? a.handoff_context.source_session_id : this.sessionId,
                    source_world_id : a.handoff_context ? a.handoff_context.source_world_id : this.worldId,
                    source_location_id : a.handoff_context ? a.handoff_context.source_location_id : this.locationId,
                    handoff_context : a.handoff_context,
                },
                proof_boundary : getWowProofBoundary(),
            };
        }
        return this.getWowPresenceUser(userId);
    }

    getWowPresenceUser(idOrPlayerId)
    {
        const key = String(idOrPlayerId == null ? '' : idOrPlayerId);
        if (!key) return null;
        const nowMs = Date.now();
        const entry = this.readPresence(nowMs)
            .find(e => String(e.wow_user_id) === key || e.player_id === key);
        if (!entry) return null;
        const pos = Array.isArray(entry.position) ? entry.position : [ 0, 0, 0 ];
        const yaw = Number.isFinite(entry.rotation_y) ? entry.rotation_y : 0;
        const placed = this.placements.presenceNodeId(entry.wow_user_id);
        const placedNode = placed != null && this.spatial.storeOfNode(placed) ? placed : null;
        return {
            id : entry.wow_user_id, // number, per WoW User schema
            name : entry.display_name,
            pilot : 'unstated', // a present user made no handshake, so it stated no pilot: never human
            AvatarURI : '', // client-side VRM/GLB avatar; no hosted asset
            ...(placedNode != null ? { node : this.spatial.nodeRef(this.spatial.primary, placedNode) } : {}),
            geoPose : this.placements.geoPoseOfNode(placedNode) || this.geoPose(pos, yaw, 0),
            webofworlds_extension : {
                source : 'presence-registry',
                player_id : entry.player_id,
                client_id : entry.client_id,
                avatar_id : entry.avatar_id,
                continuity_id : entry.continuity_id,
                display_name : entry.display_name,
                registered_at : entry.registered_at,
                last_seen_at : entry.last_seen_at,
                ttl_ms : entry.ttl_ms,
                expires_in_ms : Math.max(0, entry.expires_at_ms - nowMs),
                local_transform : {
                    position : pos.slice(),
                    rotation_y : yaw,
                },
                geopose_mapping : WOW_GEOPOSE_MAPPING,
                presence_scope : 'server-side-ttl-registry (local occupancy truth; not networked)',
            },
            proof_boundary : getWowProofBoundary(),
        };
    }

    async getWowUserSigned(userId)
    {
        const user = this.getWowUser(userId);
        if (!user) return null;
        const content = {
            name : user.name,
            age : WOW_OPEN_USER_MANIFEST_DEMO_AGE,
            avatarAssetURI : user.AvatarURI || '',
        };
        try {
            const signed = await umSignOpenUserManifest(content);
            return {
                ...user,
                open_user_manifest : signed,
                open_user_manifest_label : UM_IDENTITY_NONCANONICAL_LABEL,
            };
        } catch (e) {
            return {
                ...user,
                open_user_manifest : { ...content, signature : null },
                open_user_manifest_label :
                    'UNSIGNED / UNVERIFIED — UM identity signer unavailable ('
                    + ((e && e.message) || 'error') + '); degraded honestly.',
            };
        }
    }

    deleteWowUser(userId)
    {
        const a = this.readAvatar();
        const localAliases = [ String(WOW_LOCAL_USER_ID), a.avatar_id, a.continuity_id, 'me' ]
            .filter((alias, index, all) => all.indexOf(alias) === index);
        const key = String(userId == null ? '' : userId);
        if (!key || localAliases.indexOf(key) !== -1)
            return { ok : false, status : 400, error : 'invalid_user_value',
                reason : 'cannot_delete_local_hosted_identity', userId };
        const entry = this.readPresence(Date.now())
            .find(e => String(e.wow_user_id) === key || e.player_id === key);
        if (!entry)
            return { ok : false, status : 404, error : 'user_not_found', userId };
        const departed = this.depart({ player_id : entry.player_id, reason : 'deleted via DELETE /wow/user/' + key });
        return { ok : true, status : 200, value : { ok : true, deleted : true, userId, ...departed } };
    }
}
function createRuntimeUsers(options)
{
    const reader = new RuntimeUsers(options);
    return {
        getWowUser : reader.getWowUser.bind(reader),
        getWowUserSigned : reader.getWowUserSigned.bind(reader),
        deleteWowUser : reader.deleteWowUser.bind(reader),
    };
}

module.exports = { createRuntimeUsers };
