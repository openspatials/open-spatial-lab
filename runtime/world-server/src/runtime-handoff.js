'use strict';
const { readNumber } = require('./runtime-projection-values');
const { buildHandoffPacket } = require('./runtime-handoff-packet');
/** Owns the existing avatar/session handoff mutations; arrival is synchronous unless the explicit fault is selected. */
class RuntimeHandoff
{
    constructor({ avatar, session, debug, identity, readPortals, resolvePortal, placementOf,
        departPresence, presenceCount, publish, getState, syncHostedPlacements, arrivalCommitMode })
    {
        this.avatar = avatar;
        this.session = session;
        this.debug = debug;
        this.identity = identity;
        this.readPortals = readPortals;
        this.resolvePortal = resolvePortal;
        this.placementOf = placementOf;
        this.departPresence = departPresence;
        this.presenceCount = presenceCount;
        this.publish = publish;
        this.getState = getState;
        this.syncHostedPlacements = syncHostedPlacements;
        this.arrivalCommitMode = arrivalCommitMode;
    }
    applyMovement(raw)
    {
        const input = raw && typeof raw === 'object' ? raw : {};
        const fwd = readNumber(input.forward, 0);
        const strafe = readNumber(input.strafe, 0);
        const turn = readNumber(input.turn, 0);
        this.avatar.transform.rotation_y += turn * 0.15;
        const yaw = this.avatar.transform.rotation_y;
        const speed = 0.2;
        this.avatar.transform.position[0] += (Math.sin(yaw) * fwd + Math.cos(yaw) * strafe) * speed;
        this.avatar.transform.position[2] += (Math.cos(yaw) * fwd - Math.sin(yaw) * strafe) * speed;
        this.debug.last_input_source = String(input.source || 'movement_input').slice(0, 80);
        this.publish();
        this.syncHostedPlacements();
        return this.getState();
    }

    placedPortalExitShape(added, wowId)
    {
        const at = this.placementOf(added.node_id);
        const position = at ? at.position.slice() : [ 0, 0, 0 ];
        return {
            portal_id : String(wowId),
            source_location_id : this.identity.LOCATION_ID,
            source_world_id : this.identity.WORLD_ID,
            target_location_id : null,
            target_world_id : null,
            target_base_url : added.destination || null,
            trigger : { position : position, radius_m : 1.25 },
            arrival : { position : position, rotation_y : at ? at.yaw : 0 },
        };
    }

    recordPortalExitIntent(portalId, playerId)
    {
        const placed = this.resolvePortal(portalId);
        const portal = placed && placed.added ? this.placedPortalExitShape(placed.added, placed.wowId)
            : this.readPortals().find(entry => entry.portal_id === portalId) || this.readPortals()[0];
        if (!portal)
            throw new Error('no portal configured on ' + this.identity.LOCATION_ID);
        const presenceDeparture = playerId
            ? this.departPresence({ player_id : playerId, reason : 'portal_exit_intent' })
            : null;
        const now = new Date().toISOString();
        const handoffId = this.identity.LOCATION_ID + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
        const packet = buildHandoffPacket(portal, this.avatar, this.debug.state_revision, this.identity, { handoffId, now });
        packet.presence_departure = {
            _claim : 'runtime: the origin departs the crossing player from its OWN '
                + 'presence registry in the same transaction that authorizes the exit — the '
                + 'registry never depends on a separate best-effort goodbye packet',
            player_id : playerId || null,
            requested : !!playerId,
            departed : presenceDeparture ? presenceDeparture.departed : false,
            registered_player_count : presenceDeparture
                ? presenceDeparture.registered_player_count
                : this.presenceCount(),
        };
        this.debug.handoff.last_exit_intent = {
            handoff_id : handoffId,
            target_location_id : portal.target_location_id,
            target_world_id : portal.target_world_id,
            target_base_url : portal.target_base_url,
            exited_at : now,
            presence_departed : packet.presence_departure.departed,
            presence_player_id : playerId || null,
        };
        this.debug.last_input_source = 'portal-exit-intent';
        this.publish();
        console.log('[PortalHandoff][' + this.identity.LOCATION_ID + '] EXIT_INTENT '
            + JSON.stringify(this.debug.handoff.last_exit_intent));
        return packet;
    }

    commitArrival(handoff, now)
    {
        const target = handoff.target || {};
        const context = handoff.avatar_context || {};
        const arrivalPosition = Array.isArray(target.arrival_position)
            ? target.arrival_position.slice(0, 3).map(v => readNumber(v, 0))
            : [ 0, 0, 3.6 ];
        this.avatar.avatar_id = String(context.avatar_id || this.avatar.avatar_id).slice(0, 80);
        this.avatar.continuity_id =
            String(context.continuity_id || context.avatar_id || this.avatar.continuity_id).slice(0, 80);
        this.avatar.display_name = String(context.display_name || this.avatar.display_name).slice(0, 80);
        this.avatar.transform.position = arrivalPosition;
        this.avatar.transform.rotation_y = readNumber(target.arrival_rotation_y, Math.PI);
        this.avatar.transform.orientation = [ 0, 0, 0, 1 ];
        this.syncHostedPlacements();
        this.avatar.handoff_context = {
            handoff_id : String(handoff.handoff_id || 'unknown').slice(0, 120),
            source_location_id : String((handoff.source && handoff.source.location_id) || '').slice(0, 80),
            source_world_id : String((handoff.source && handoff.source.world_id) || '').slice(0, 80),
            source_session_id : String((handoff.source && handoff.source.session_id) || '').slice(0, 80),
            previous_transform : context.transform || null,
            arrived_at : now,
        };
        this.session.arrival_count += 1;
        this.session.handoff_bootstrap = JSON.parse(JSON.stringify(this.avatar.handoff_context));
        this.debug.handoff.last_handoff_id = this.avatar.handoff_context.handoff_id;
        this.debug.handoff.last_arrival = {
            handoff_id : this.avatar.handoff_context.handoff_id,
            source_location_id : this.avatar.handoff_context.source_location_id,
            source_world_id : this.avatar.handoff_context.source_world_id,
            preserved_avatar_id : this.avatar.avatar_id,
            continuity_id : this.avatar.continuity_id,
            arrived_at : now,
        };
        this.debug.last_input_source = 'portal-arrival';
        this.publish();
        console.log('[PortalHandoff][' + this.identity.LOCATION_ID + '] ARRIVAL '
            + JSON.stringify(this.debug.handoff.last_arrival));
    }

    recordPortalArrival(packet)
    {
        const handoff = packet && typeof packet === 'object' ? packet : {};
        const target = handoff.target || {};
        if (target.world_id && target.world_id !== this.identity.WORLD_ID)
            throw new Error('handoff target world ' + target.world_id + ' does not match ' + this.identity.WORLD_ID);
        if (target.location_id && target.location_id !== this.identity.LOCATION_ID)
            throw new Error('handoff target location ' + target.location_id + ' does not match ' + this.identity.LOCATION_ID);

        const now = new Date().toISOString();

        if (this.arrivalCommitMode === 'deferred')
        {
            setTimeout(() => this.commitArrival(handoff, now), 0);
            return { ok : true, deferred : true, handoff_id : handoff.handoff_id };
        }

        this.commitArrival(handoff, now);
        return this.getState();
    }
}
function createRuntimeHandoff(options)
{
    const owner = new RuntimeHandoff(options);
    return {
        applyMovement : owner.applyMovement.bind(owner),
        recordPortalExitIntent : owner.recordPortalExitIntent.bind(owner),
        recordPortalArrival : owner.recordPortalArrival.bind(owner),
    };
}

module.exports = { createRuntimeHandoff };
