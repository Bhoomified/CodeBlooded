/**
 * state.js -- Central state store with pub/sub.
 * Uses EventTarget for type-safe, leak-free subscriptions.
 * @module state
 */

/**
 * Create a new reactive store.
 * @returns {Store}
 *
 * @example
 *   const store = createStore();
 *   store.subscribe('run:complete', data => console.log(data));
 *   store.set('health', { status: 'ready' });  // fires 'change:health'
 *   store.emit('run:complete', { ... });
 */
export function createStore() {
  /** @type {Map<string, any>} */
  const data = new Map();
  const bus = new EventTarget();
  let batchDepth = 0;
  /** @type {CustomEvent[]} */
  let pendingEvents = [];

  function dispatch(event) {
    if (batchDepth > 0) {
      pendingEvents.push(event);
    } else {
      bus.dispatchEvent(event);
    }
  }

  return {
    /**
     * Get a state value by key.
     * @param {string} key
     * @returns {any}
     */
    get(key) {
      return data.get(key);
    },

    /**
     * Set a state value. Fires 'change:{key}'.
     * @param {string} key
     * @param {any} value
     */
    set(key, value) {
      data.set(key, value);
      dispatch(new CustomEvent(`change:${key}`, { detail: value }));
    },

    /**
     * Subscribe to an event. Returns an unsubscribe function.
     * @param {string} event - e.g. 'change:health', 'run:complete'
     * @param {function} callback - receives event.detail
     * @returns {function} unsubscribe
     */
    subscribe(event, callback) {
      const handler = (e) => callback(e.detail);
      bus.addEventListener(event, handler);
      return () => bus.removeEventListener(event, handler);
    },

    /**
     * Emit a named event with arbitrary data.
     * @param {string} event
     * @param {any} [detail]
     */
    emit(event, detail) {
      dispatch(new CustomEvent(event, { detail }));
    },

    /**
     * Batch multiple state changes: events are deferred until fn returns.
     * Useful for atomic updates that should trigger listeners once.
     * @param {function} fn
     */
    batch(fn) {
      batchDepth++;
      try {
        fn();
      } finally {
        batchDepth--;
        if (batchDepth === 0) {
          const queued = pendingEvents;
          pendingEvents = [];
          for (const evt of queued) bus.dispatchEvent(evt);
        }
      }
    },

    /**
     * Snapshot the full state (for debugging / export).
     * @returns {Object}
     */
    snapshot() {
      const out = {};
      for (const [k, v] of data) out[k] = v;
      return out;
    },
  };
}
