'use strict';

const fs = require('fs');

/** One world's persisted revision and bounded in-memory event journal. */
class RuntimeEvents
{
    constructor(worldId, replayLimit)
    {
        this.worldId = worldId;
        this.limit = Number.isInteger(replayLimit) && replayLimit >= 0 ? replayLimit : 1000;
        this.subscribers = new Set();
        this.replay = [];
        this.changedAt = new Map();
        this.file = null;
        this.revision = 0;
        this.time = null;
    }

    loadRevision(file)
    {
        this.file = file;
        try {
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (doc && Number.isInteger(doc.revision) && doc.revision >= 0) {
                this.revision = doc.revision;
                this.time = doc.time || null;
            }
        } catch (error) { /* A new world starts at revision zero. */ }
    }

    saveRevision()
    {
        if (!this.file) return;
        try {
            const tmp = this.file + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ osl_world_revision : true,
                world_id : this.worldId, revision : this.revision, time : this.time }) + '\n', 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (error) {
            console.warn('[world-revision] save failed (' + this.worldId + '): ' + error.message);
        }
    }

    emitWowEvent(event)
    {
        this.revision += 1;
        this.time = new Date().toISOString();
        event.revision = this.revision;
        event.time = this.time;
        event.ts = this.time;
        event.urls = Array.from(new Set((event.urls || []).concat([ 'wow/world' ])));
        for (const url of event.urls) this.changedAt.set(url, this.time);
        this.saveRevision();
        this.replay.push(event);
        if (this.replay.length > this.limit) this.replay.splice(0, this.replay.length - this.limit);
        for (const subscriber of this.subscribers) {
            try { subscriber(event); }
            catch (error) { console.error('runtime-state event subscriber failed: ' + error.message); }
        }
    }

    eventsSince(since)
    {
        if (!Number.isInteger(since) || since < 0 || since > this.revision)
            return { resync : true, revision : this.revision };
        if (since === this.revision) return { events : [] };
        const first = this.replay.length ? this.replay[0].revision : this.revision + 1;
        if (since + 1 < first) return { resync : true, revision : this.revision };
        return { events : this.replay.filter(event => event.revision > since) };
    }

    currentRevision() { return { revision : this.revision, time : this.time }; }
    lastChangeOf(url) { return this.changedAt.get(url) || null; }
    eventSubscriberCount() { return this.subscribers.size; }

    subscribeEvents(listener)
    {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }
}

function createRuntimeEvents({ worldId, replayLimit })
{
    const journal = new RuntimeEvents(worldId, replayLimit);
    return {
        loadRevision : journal.loadRevision.bind(journal),
        emitWowEvent : journal.emitWowEvent.bind(journal),
        eventsSince : journal.eventsSince.bind(journal),
        currentRevision : journal.currentRevision.bind(journal),
        lastChangeOf : journal.lastChangeOf.bind(journal),
        subscribeEvents : journal.subscribeEvents.bind(journal),
        eventSubscriberCount : journal.eventSubscriberCount.bind(journal),
    };
}

module.exports = { createRuntimeEvents };
