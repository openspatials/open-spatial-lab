'use strict';
const { clone } = require('./runtime-projection-values');
/** One state revision and subscriber set; snapshots project live presence without deleting entries. */
class RuntimeSnapshot
{
    constructor(state, connectedClients)
    {
        this.state = state;
        this.connectedClients = connectedClients;
        this.revision = 0;
        this.subscribers = new Set();
    }
    publish(reason)
    {
        if (reason !== undefined) this.state.debug.last_input_source = reason;
        this.bumpRevision();
        this.notifySubscribers();
    }
    bumpRevision()
    {
        this.revision += 1;
        this.state.debug.state_revision = this.revision;
    }

    notifySubscribers()
    {
        const snapshot = this.getState();
        for (const subscriber of this.subscribers)
        {
            try
            {
                subscriber(snapshot);
            }
            catch (err)
            {
                console.error('runtime-state subscriber failed: ' + err.message);
            }
        }
    }

    getState()
    {
        const snapshot = clone(this.state);
        snapshot.session.connected_clients = this.connectedClients();
        return snapshot;
    }

    getDebugState()
    {
        const snapshot = clone({
            location : this.state.location,
            world : this.state.world,
            portals : this.state.portals,
            session : this.state.session,
            avatar : this.state.avatar,
            server_tick : this.state.server_tick,
            debug : this.state.debug,
        });
        snapshot.session.connected_clients = this.connectedClients();
        return snapshot;
    }

    subscribe(fn)
    {
        this.subscribers.add(fn);
        try { fn(this.getState()); } catch (err) { /* ignore initial */ }
        return () => { this.subscribers.delete(fn); };
    }

    subscriberCount()
    {
        return this.subscribers.size;
    }
}
function createRuntimeSnapshot(state, connectedClients)
{
    const owner = new RuntimeSnapshot(state, connectedClients);
    return {
        bumpRevision : owner.bumpRevision.bind(owner),
        notifySubscribers : owner.notifySubscribers.bind(owner),
        getState : owner.getState.bind(owner),
        getDebugState : owner.getDebugState.bind(owner),
        subscribe : owner.subscribe.bind(owner),
        subscriberCount : owner.subscriberCount.bind(owner),
        publish : owner.publish.bind(owner),
    };
}

module.exports = { createRuntimeSnapshot };
