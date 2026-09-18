/**
 * Small, dependency-free event bus for runtime events.
 *
 * Events are deliberately named strings rather than Mineflayer events so the
 * execution layer can be tested without a live bot and can consume events
 * from Mineflayer, the world model, or a future live driver equally.
 */
export class EventBus {
    constructor() {
        this.handlers = new Map();
        this.history = [];
        this.maxHistory = 256;
    }

    on(type, handler) {
        if (typeof handler !== 'function') throw new TypeError('EventBus handler must be a function');
        const list = this.handlers.get(type) ?? [];
        list.push(handler);
        this.handlers.set(type, list);
        return () => this.off(type, handler);
    }

    once(type, handler) {
        let off = null;
        off = this.on(type, async event => {
            off?.();
            return handler(event);
        });
        return off;
    }

    off(type, handler) {
        const list = this.handlers.get(type);
        if (!list) return false;
        const next = list.filter(candidate => candidate !== handler);
        if (next.length) this.handlers.set(type, next);
        else this.handlers.delete(type);
        return next.length !== list.length;
    }

    async publish(type, data = {}, { source = 'runtime' } = {}) {
        const event = {
            type,
            data,
            source,
            at: Date.now(),
        };
        this.history.push(event);
        if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
        const handlers = [...(this.handlers.get(type) ?? []), ...(this.handlers.get('*') ?? [])];
        const results = await Promise.allSettled(handlers.map(handler => handler(event)));
        return { event, results };
    }

    recent(type = null, limit = 20) {
        const events = type ? this.history.filter(event => event.type === type) : this.history;
        return events.slice(-Math.max(0, limit)).map(event => ({ ...event }));
    }

    clear() {
        this.history.length = 0;
    }
}
