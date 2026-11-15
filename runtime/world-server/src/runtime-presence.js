'use strict';
const { WOW_PRESENCE_USER_ID_BASE, PRESENCE_SWEEP_INTERVAL_MS, PRESENCE_HEARTBEAT_HINT_MS,
    PRESENCE_MAX_PLAYERS, PRESENCE_DEPART_TOMBSTONE_MS } = require('./runtime-presence-policy');
const { presenceString, presencePosition, presenceEntrySummary, liveWowPresenceUsers,
    wowUserEvent, fabricPresenceSummary, presenceEntry } = require('./runtime-presence-projection');

/**
 * One registry and one expiry timer per world; projections never remove entries. nextUserId() is the world's one User id
 * allocator: presence takes its ids from it, and so does the identity handshake (runtime-handshake.js, through
 * runtime.nextWowUserId), so that no two users of one world share an id.
 */
class RuntimePresence
{
    constructor({ locationId, placements, publish, project, emitEvent, proofBoundary })
    {
        this.locationId = locationId;
        this.placements = placements;
        this.publish = publish;
        this.project = project;
        this.emitEvent = emitEvent;
        this.proofBoundary = proofBoundary;
        this.registry = new Map();
        this.tombstones = new Map();
        this.timer = null;
        this.sequence = 0;
        this.blocked = 0;
    }

    nextUserId() { return WOW_PRESENCE_USER_ID_BASE + (++this.sequence); }
    emitUserEvent(type, entry) { this.emitEvent(wowUserEvent(type, entry, this.locationId, this.proofBoundary)); }
    users() { return liveWowPresenceUsers(this.livePresenceEntries(Date.now())); }
    size() { return this.registry.size; }
    entries() { return Array.from(this.registry.values()); }

    clear()
    {
        this.registry.clear();
        this.tombstones.clear();
        this.blocked = 0;
        this.stopPresenceSweeper();
    }

    summary(facts)
    {
        const now = Date.now();
        return fabricPresenceSummary(this.livePresenceEntries(now), {
            active_tombstones : Array.from(this.tombstones.values()).filter(expiresAt => expiresAt > now).length,
            resurrections_blocked : this.blocked,
        }, facts, now);
    }
    pruneTombstones(nowMs)
    {
        for (const [ playerId, expiresAt ] of this.tombstones)
        {
            if (expiresAt <= nowMs) this.tombstones.delete(playerId);
        }
    }

    presenceDepartedRecently(playerId)
    {
        const expiresAt = this.tombstones.get(playerId) || 0;
        return expiresAt > Date.now();
    }

    livePresenceEntries(nowMs)
    {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        return Array.from(this.registry.values())
            .filter(entry => entry.expires_at_ms > now)
            .sort((x, y) => x.registered_at_ms - y.registered_at_ms);
    }

    presenceConnectedClientsProjection()
    {
        const now = Date.now();
        return this.livePresenceEntries(now).map(entry => presenceEntrySummary(entry, now));
    }

    syncConnectedClients(nowMs)
    {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        this.project(this.livePresenceEntries(now).map(entry => presenceEntrySummary(entry, now)));
    }

    sweepPresenceRegistry(reason)
    {
        const now = Date.now();
        this.pruneTombstones(now);
        const expired = [];
        const expiredEntries = [];
        for (const [ playerId, entry ] of this.registry)
        {
            if (entry.expires_at_ms <= now)
            {
                this.registry.delete(playerId);
                expired.push(playerId);
                expiredEntries.push(entry);
            }
        }
        if (expired.length)
        {
            this.syncConnectedClients(now);
            this.publish('presence-expired:' + expired.join(',').slice(0, 60));
            for (const entry of expiredEntries) this.placements.unplacePresenceUser(entry);
            for (const entry of expiredEntries) this.emitUserEvent('user_left', entry);
            console.log('[Presence][' + this.locationId + '] EXPIRED ' + JSON.stringify({
                players : expired, reason : reason || 'ttl_sweep',
            }));
        }
        if (this.registry.size === 0) this.stopPresenceSweeper();
        return expired;
    }

    startPresenceSweeper()
    {
        if (this.timer) return;
        this.timer = setInterval(
            () => this.sweepPresenceRegistry('ttl_sweep'), PRESENCE_SWEEP_INTERVAL_MS);
        if (this.timer && typeof this.timer.unref === 'function')
            this.timer.unref();
    }

    stopPresenceSweeper()
    {
        if (this.timer)
        {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    registerPresence(body, via)
    {
        this.sweepPresenceRegistry('pre_register');
        const input = body && typeof body === 'object' ? body : {};
        const playerId = presenceString(input.player_id, '', 120);
        if (!playerId)
            throw new Error('player_id required');
        if (!this.registry.has(playerId) && this.registry.size >= PRESENCE_MAX_PLAYERS)
            throw new Error('presence registry full (' + PRESENCE_MAX_PLAYERS + ')');
        const now = Date.now();
        const previous = this.registry.get(playerId) || null;
        const entry = presenceEntry(input, previous,
            previous ? previous.wow_user_id : this.nextUserId(), now, via);
        const ttl = entry.ttl_ms;
        this.registry.set(playerId, entry);
        this.tombstones.delete(playerId);
        this.startPresenceSweeper();
        this.syncConnectedClients(now);
        this.publish('presence-register:' + playerId.slice(0, 60));
        if (!previous) this.emitUserEvent('user_joined', entry);
        if (!previous) this.placements.placePresenceUser(entry); else this.placements.movePresenceUser(entry);
        console.log('[Presence][' + this.locationId + '] REGISTER ' + JSON.stringify({
            player_id : playerId, display_name : entry.display_name,
            via : entry.registered_via, ttl_ms : ttl, registry_size : this.registry.size,
        }));
        return JSON.parse(JSON.stringify({
            ok : true,
            registered : true,
            location_id : this.locationId,
            player : presenceEntrySummary(entry, now),
            ttl_ms : ttl,
            heartbeat_interval_hint_ms : PRESENCE_HEARTBEAT_HINT_MS,
            registered_player_count : this.registry.size,
        }));
    }

    unregisteredHeartbeat(body, playerId)
    {
        if (this.presenceDepartedRecently(playerId))
        {
            this.blocked += 1;
            console.log('[Presence][' + this.locationId + '] HEARTBEAT_AFTER_DEPART_IGNORED '
                + JSON.stringify({ player_id : playerId, registry_size : this.registry.size }));
            return JSON.parse(JSON.stringify({
                ok : true, registered : false, departed : true, upserted : false,
                location_id : this.locationId, player_id : playerId,
                reason : 'departed_recently',
                note : 'runtime: a heartbeat in flight at departure may not '
                    + 'resurrect a departed player; re-register explicitly to return',
                registered_player_count : this.registry.size,
            }));
        }
        const out = this.registerPresence(body, 'heartbeat_upsert');
        out.upserted = true;
        return out;
    }

    heartbeatPresence(body)
    {
        this.sweepPresenceRegistry('pre_heartbeat');
        const input = body && typeof body === 'object' ? body : {};
        const playerId = presenceString(input.player_id, '', 120);
        if (!playerId)
            throw new Error('player_id required');
        const entry = this.registry.get(playerId);
        if (!entry) return this.unregisteredHeartbeat(body, playerId);
        const now = Date.now();
        entry.last_seen_at = new Date(now).toISOString();
        entry.last_seen_ms = now;
        entry.expires_at_ms = now + entry.ttl_ms;
        entry.heartbeat_count += 1;
        const position = presencePosition(input.position);
        if (position) entry.position = position;
        if (Number.isFinite(Number(input.rotation_y))) entry.rotation_y = Number(input.rotation_y);
        this.placements.movePresenceUser(entry);
        this.syncConnectedClients(now);
        return JSON.parse(JSON.stringify({
            ok : true,
            registered : true,
            location_id : this.locationId,
            player : presenceEntrySummary(entry, now),
            ttl_ms : entry.ttl_ms,
            heartbeat_interval_hint_ms : PRESENCE_HEARTBEAT_HINT_MS,
            registered_player_count : this.registry.size,
        }));
    }

    departPresence(body)
    {
        const input = body && typeof body === 'object' ? body : {};
        const playerId = presenceString(input.player_id, '', 120);
        if (!playerId)
            throw new Error('player_id required');
        const departingEntry = this.registry.get(playerId) || null;
        const removed = this.registry.delete(playerId);
        const now = Date.now();
        this.pruneTombstones(now);
        this.tombstones.set(playerId, now + PRESENCE_DEPART_TOMBSTONE_MS);
        if (removed)
        {
            this.syncConnectedClients(now);
            this.publish('presence-depart:' + playerId.slice(0, 60));
            if (departingEntry) this.placements.unplacePresenceUser(departingEntry);
            if (departingEntry) this.emitUserEvent('user_left', departingEntry);
            console.log('[Presence][' + this.locationId + '] DEPART ' + JSON.stringify({
                player_id : playerId,
                reason : presenceString(input.reason, 'unspecified', 80),
                registry_size : this.registry.size,
            }));
        }
        if (this.registry.size === 0) this.stopPresenceSweeper();
        return JSON.parse(JSON.stringify({
            ok : true,
            departed : removed,
            known : removed,
            location_id : this.locationId,
            player_id : playerId,
            registered_player_count : this.registry.size,
        }));
    }
}

function createRuntimePresence(options)
{
    const owner = new RuntimePresence(options);
    return {
        nextUserId : owner.nextUserId.bind(owner),
        registerPresence : owner.registerPresence.bind(owner),
        heartbeatPresence : owner.heartbeatPresence.bind(owner),
        departPresence : owner.departPresence.bind(owner),
        stopPresenceSweeper : owner.stopPresenceSweeper.bind(owner),
        livePresenceEntries : owner.livePresenceEntries.bind(owner),
        presenceConnectedClientsProjection : owner.presenceConnectedClientsProjection.bind(owner),
        users : owner.users.bind(owner),
        size : owner.size.bind(owner),
        entries : owner.entries.bind(owner),
        clear : owner.clear.bind(owner),
        summary : owner.summary.bind(owner),
    };
}

module.exports = { createRuntimePresence };
