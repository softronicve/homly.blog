/**
 * homly.js — a tiny reactive Web Components framework.
 *
 * Vanilla JavaScript, zero dependencies and no build step: it runs straight in
 * the browser. State is reactive through fine-grained signals, the DOM is wired
 * with `data-*` attributes, and each component is a Custom Element that loads
 * its HTML and CSS from sibling files.
 *
 * @version 1.9.0
 * @license MIT
 */

/**
 * Static helpers that power the framework: template loading, the reactive store,
 * DOM binding and the click dispatcher.
 */
export class Homly {
  /**
   * Cache of fetched templates/stylesheets, keyed by resolved URL.
   * @type {Map<string, string>}
   */
  static templateCache = new Map();

  /**
   * In-flight requests, keyed by URL. Lets simultaneous callers for the same URL
   * share a single `fetch` (request collapsing) instead of each firing its own.
   * @type {Map<string, Promise<string>>}
   */
  static pendingRequests = new Map();

  /**
   * Row store for each node rendered by a `data-for`, so a `data-action` fired from
   * inside a row can tell which item it belongs to. A WeakMap, so removing the row is
   * enough to drop the entry — no bookkeeping on teardown.
   * @type {WeakMap<HTMLElement, Object>}
   */
  static listItems = new WeakMap();

  /**
   * Fetch a text resource (an HTML template or a CSS file), cached by URL.
   *
   * Three layers, in order:
   *  1. Cache hit  — returns the stored text (so re-mounting a component never refetches).
   *  2. In-flight  — returns the pending promise, so N components asking for the same
   *                  URL at once trigger a single network request (request collapsing).
   *  3. New        — fetches, stores the result in the cache and clears the pending entry.
   *
   * On a network/HTTP error the pending entry is cleared (so a later call can retry)
   * and the error propagates to the caller (handled by the component's error boundary).
   *
   * @param {string} url - URL of the resource to fetch.
   * @returns {Promise<string>} The resource body as text.
   */
  static loadTemplate(url) {
    if (this.templateCache.has(url)) {
      if (Homly._level()) Homly._log('✓', 'cache HIT ' + url);
      return Promise.resolve(this.templateCache.get(url));
    }
    if (this.pendingRequests.has(url)) {
      if (Homly._level()) Homly._log('⇉', 'collapse ' + url);
      return this.pendingRequests.get(url);
    }
    if (Homly._level()) Homly._log('↓', 'fetch ' + url);

    const request = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} al cargar ${url}`);
        return response.text();
      })
      .then((text) => {
        this.templateCache.set(url, text);
        this.pendingRequests.delete(url);
        return text;
      })
      .catch((err) => {
        this.pendingRequests.delete(url);   // permitir reintento en el próximo montaje
        throw err;
      });

    this.pendingRequests.set(url, request);
    return request;
  }

  /**
   * Create a reactive store with one signal per key of the initial state.
   *
   * Each signal keeps its own set of subscribers and notifies them synchronously
   * when its value changes. The returned `state` is a Proxy, so you can read and
   * write values directly (`store.state.key = value`).
   *
   * @param {Object<string, *>} initialState - Initial keys and values.
   * @returns {{ state: Object, signals: Object<string, { subscribe: Function, set: Function, get: Function }>, computed: Function }}
   *   `state` (the reactive proxy), `signals` (the raw per-key signals), and
   *   `computed(name, depKeys, fn)` to register a derived signal as a store key.
   */
  static createStore(initialState) {
    const signals = {};

    /**
     * Create a writable signal under `key`. Used for the initial state and by
     * `store.resource`, which registers its own keys after the store exists.
     *
     * @param {string} key - Store key the signal is exposed under.
     * @param {*} initial - Starting value.
     * @returns {{ subscribe: Function, set: Function, get: Function }}
     */
    const addSignal = (key, initial) => {
      const subscribers = new Set();
      let value = initial;

      return (signals[key] = {
        /**
         * Subscribe to changes of this key. Runs immediately with the current value.
         * @param {(value: *) => void} fn - Callback invoked on every change.
         * @param {AbortSignal} [abortSignal] - When aborted, removes the subscription.
         */
        subscribe: (fn, abortSignal) => {
          subscribers.add(fn);
          if (abortSignal) {
            abortSignal.addEventListener('abort', () => subscribers.delete(fn), { once: true });
          }
          fn(value);
        },
        /**
         * Update the value and notify subscribers. No-op if the value is unchanged.
         * @param {*} newVal - The new value.
         */
        set: (newVal) => {
          if (value === newVal) return;
          if (Homly._level() === 'verbose') Homly._log('✎', 'signal ' + key + ': ' + Homly._fmt(value) + ' → ' + Homly._fmt(newVal));
          value = newVal;
          subscribers.forEach(fn => fn(value));
        },
        /** @returns {*} The current value. */
        get: () => value,
      });
    };

    for (const key in initialState) addSignal(key, initialState[key]);

    // Proxy so the store can be read/written as `store.state.key`.
    const stateProxy = new Proxy({}, {
      get(_, prop) { return signals[prop] ? signals[prop].get() : undefined; },
      set(_, prop, val) {
        if (signals[prop]) signals[prop].set(val);
        return true;
      },
    });

    const store = { state: stateProxy, signals };

    /**
     * Register a computed signal as a key of this store. Its dependencies are
     * other keys of the same store, so `data-bind="name"`, `store.state.name`
     * and `globalStores` pick it up like any plain signal.
     *
     * @param {string} name - Key under which the computed is exposed.
     * @param {string[]} depKeys - Keys of this store the computed derives from.
     * @param {(...values: *[]) => *} fn - Pure function of the deps' values.
     * @returns {{ subscribe: Function, get: Function, set: Function }} The computed.
     */
    store.computed = (name, depKeys, fn) => {
      const derived = Homly.computed(depKeys.map((key) => signals[key]), fn, undefined, name);
      signals[name] = derived;
      return derived;
    };

    /**
     * Register an async resource as **three** keys of this store: `name` (the value),
     * `name + 'Loading'` (boolean) and `name + 'Error'` (the thrown error, or null).
     * They are plain signals, so `data-for="items"`, `data-if="itemsLoading"` and
     * `data-bind="itemsError"` work with no new directives.
     *
     * The fetcher re-runs whenever a dep changes. Each run aborts the previous one and
     * carries a token, so **a late response can never overwrite a newer one** — the
     * classic bug of a slow first request landing after a fast second one.
     *
     * On failure the error is published and the last good value is kept, so a flaky
     * refresh doesn't blank out a list that is already on screen.
     *
     * @param {string} name - Key for the value; `${name}Loading` / `${name}Error` come along.
     * @param {string[]} depKeys - Keys of this store the fetcher depends on. `[]` loads once.
     * @param {(...values: *[]) => Promise<*>} fetcher - Receives the deps' values plus a
     *   trailing `{ signal }` to hand to `fetch`. Throw to populate `${name}Error`
     *   (`fetch` does not throw on a 4xx/5xx — check `response.ok` yourself).
     * @param {{ debounce?: number }} [opts] - `debounce` in ms groups rapid dep changes
     *   into a single request (typing in a filter). The first load is never delayed.
     * @returns {{ refresh: () => Promise<void> }} `refresh` re-runs it by hand (retry buttons).
     */
    store.resource = (name, depKeys, fetcher, { debounce = 0 } = {}) => {
      const data = addSignal(name, null);
      const loading = addSignal(name + 'Loading', false);
      const error = addSignal(name + 'Error', null);

      let controller = null;
      let timer = null;
      let token = 0;

      const run = async () => {
        controller?.abort();
        controller = new AbortController();
        const mine = ++token;
        const { signal } = controller;

        loading.set(true);
        try {
          const value = await fetcher(...depKeys.map((key) => signals[key].get()), { signal });
          if (mine !== token) return;              // llegó tarde: ya hay otro run en curso
          error.set(null);
          data.set(value);
        } catch (err) {
          if (mine !== token || signal.aborted) return;   // abortado por nosotros, no es un fallo
          if (Homly._level()) Homly._warn('resource ' + name + ': ' + err.message);
          error.set(err);
        } finally {
          if (mine === token) loading.set(false);
        }
      };

      const trigger = debounce
        ? () => { clearTimeout(timer); timer = setTimeout(run, debounce); }
        : run;

      // subscribe() es eager, así que dispararía un run por cada dep al registrarse.
      // Se ignoran esas primeras llamadas y se hace un único run inicial, sin debounce.
      let primed = false;
      depKeys.forEach((key) => signals[key].subscribe(() => { if (primed) trigger(); }));
      primed = true;
      run();

      // ponytail: un fetch en vuelo no se aborta al desmontar. El store local muere con el
      // componente y la respuesta cae en el vacío; si algún día hace falta cortarlo antes,
      // el hook es pasar this.signal acá y encadenarlo al controller.
      return { refresh: run };
    };

    return store;
  }

  /**
   * Create a read-only signal derived from other signals. Dependencies are
   * explicit: pass the source signals and a pure function of their values. The
   * computed re-evaluates whenever any dependency changes and notifies its own
   * subscribers only if the result actually changed (=== check), so it composes
   * with `bindView` and `state` like any other signal.
   *
   * @param {Array<{ subscribe: Function, get: Function }>} deps - Source signals.
   * @param {(...values: *[]) => *} fn - Pure function of the deps' current values.
   * @param {AbortSignal} [abortSignal] - When aborted, unsubscribes from the deps.
   * @param {string} [label] - Optional name for verbose dev logs (set by store.computed).
   * @returns {{ subscribe: Function, get: Function, set: Function }} A read-only
   *   signal — its `set` throws, since computeds are derived, not written by hand.
   */
  static computed(deps, fn, abortSignal, label) {
    const subscribers = new Set();
    const evaluate = () => fn(...deps.map((dep) => dep.get()));
    let value = evaluate();

    const recompute = () => {
      const next = evaluate();
      if (next === value) return;
      if (Homly._level() === 'verbose') Homly._log('↳', 'computed ' + (label ? label + ' ' : '') + 'recompute: ' + Homly._fmt(value) + ' → ' + Homly._fmt(next));
      value = next;
      subscribers.forEach((notify) => notify(value));
    };
    deps.forEach((dep) => dep.subscribe(recompute, abortSignal));

    return {
      subscribe: (notify, signal) => {
        subscribers.add(notify);
        if (signal) signal.addEventListener('abort', () => subscribers.delete(notify), { once: true });
        notify(value);
      },
      get: () => value,
      set: () => { throw new Error('Las computed signals son de solo lectura'); },
    };
  }

  /**
   * Wire a container's DOM to a store using declarative `data-*` attributes:
   *
   * - `data-bind="key"` — write the value as the element's text content.
   * - `data-if="key"` — toggle the `hidden` attribute from the value's truthiness.
   * - `data-bind-class="class:key"` — add/remove a class from the value's truthiness.
   * - `data-bind-attr="attr:key"` — bind an attribute (e.g. `href`) to the value.
   * - `data-model="key"` — two-way binding for input/textarea/select/checkbox.
   *
   * Every subscription/listener is tied to `signal`, so it is cleaned up when the
   * component disconnects.
   *
   * @param {HTMLElement} container - Root element to scan for bindings.
   * @param {{ signals: Object, state: Object }} store - Store from {@link Homly.createStore}.
   * @param {AbortSignal} signal - Abort signal used to tear down listeners/subscriptions.
   */
  static bindView(container, store, signal) {
    container.querySelectorAll('[data-bind]').forEach(el => {
      const key = el.getAttribute('data-bind');
      if (store.signals[key]) {
        store.signals[key].subscribe((val) => {
          const newVal = val !== undefined ? String(val) : '';
          if (el.textContent !== newVal) el.textContent = newVal;
        }, signal);
      }
    });

    container.querySelectorAll('[data-if]').forEach(el => {
      const key = el.getAttribute('data-if');
      if (store.signals[key]) {
        store.signals[key].subscribe((val) => {
          if (!!val) el.removeAttribute('hidden');
          else el.setAttribute('hidden', '');
        }, signal);
      }
    });

    container.querySelectorAll('[data-bind-class]').forEach(el => {
      const [className, key] = el.getAttribute('data-bind-class').split(':');
      if (store.signals[key]) {
        store.signals[key].subscribe((val) => {
          if (val) el.classList.add(className);
          else el.classList.remove(className);
        }, signal);
      }
    });

    container.querySelectorAll('[data-bind-attr]').forEach(el => {
      const [attr, key] = el.getAttribute('data-bind-attr').split(':');
      if (store.signals[key]) {
        store.signals[key].subscribe((val) => {
          if (val === undefined || val === null || val === '') el.removeAttribute(attr);
          else el.setAttribute(attr, val);
        }, signal);
      }
    });

    // Two-way binding: data-model="key" on input / textarea / select / checkbox.
    container.querySelectorAll('[data-model]').forEach(el => {
      const key = el.getAttribute('data-model');
      if (!store.signals[key]) return;
      const isCheckbox = el.type === 'checkbox';

      // State -> UI
      store.signals[key].subscribe((val) => {
        if (isCheckbox) el.checked = !!val;
        else if (el.value !== val) el.value = val != null ? val : ''; // guard: keep the caret in place
      }, signal);

      // UI -> State
      const evt = (el.tagName === 'SELECT' || isCheckbox) ? 'change' : 'input';
      const handler = (e) => { store.state[key] = isCheckbox ? e.target.checked : e.target.value; };
      el.addEventListener(evt, handler);
      signal?.addEventListener('abort', () => el.removeEventListener(evt, handler), { once: true });
    });
  }

  /**
   * Render a keyed list from a `<template data-for="arrayKey" data-key="field">`.
   * For each item in the store's array signal it clones the template, gives the
   * clone its own store (so the inner `data-*` bindings resolve against the item's
   * fields) and reconciles by key on every array change: existing items reuse their
   * node (updating only changed fields), new keys are created and gone keys removed.
   * An optional `data-index="name"` exposes the 0-based position as a reactive field.
   *
   * @param {HTMLElement} container - Element to scan for `template[data-for]`.
   * @param {{ signals: Object }} store - Store whose array signals back the lists.
   * @param {AbortSignal} signal - Aborted on disconnect; tears down all item bindings.
   */
  static bindList(container, store, signal) {
    if (!store) return;
    container.querySelectorAll('template[data-for]').forEach((tpl) => {
      const arrayKey = tpl.getAttribute('data-for');
      const keyField = tpl.getAttribute('data-key');
      const indexName = tpl.getAttribute('data-index');
      if (!keyField) throw new Error(`data-for="${arrayKey}" requiere data-key`);
      const arraySignal = store.signals[arrayKey];
      if (!arraySignal) {
        if (Homly._level()) Homly._warn('data-for="' + arrayKey + '": no existe la señal \'' + arrayKey + '\' en el store');
        return;
      }
      // Each item's markup must have a single root element: only firstElementChild is
      // mounted, so extra top-level siblings are silently dropped. Warn under HOM_DEBUG.
      if (Homly._level() && tpl.content.childElementCount > 1) {
        Homly._warn('data-for="' + arrayKey + '": el <template> debe tener un solo elemento raíz por ítem; se ignoran los demás');
      }

      const rendered = new Map();   // keyValue -> { node, itemStore, controller }

      arraySignal.subscribe((items) => {
        const list = Array.isArray(items) ? items : [];
        const seen = new Set();
        let ref = tpl;   // anchor: clones live right after the template, in order

        list.forEach((item, i) => {
          const k = item[keyField];
          seen.add(k);
          let entry = rendered.get(k);
          if (entry) {
            for (const field in item) entry.itemStore.state[field] = item[field];
            if (indexName) entry.itemStore.state[indexName] = i;
          } else {
            const controller = new AbortController();
            const itemStore = Homly.createStore(indexName ? { ...item, [indexName]: i } : { ...item });
            // Bind through a throwaway wrapper so the item's ROOT element directives
            // count too: bindView scans descendants, so a directive on the root node
            // (e.g. data-bind-attr on the <article>) would be skipped if we bound the
            // node directly. As a descendant of the wrapper, the root gets bound.
            const wrapper = document.createElement('div');
            wrapper.appendChild(tpl.content.cloneNode(true));
            Homly.bindView(wrapper, itemStore, controller.signal);
            const node = wrapper.firstElementChild;
            Homly.listItems.set(node, itemStore);   // para que las acciones sepan de qué fila salieron
            entry = { node, itemStore, controller };
            rendered.set(k, entry);
          }
          if (ref.nextSibling !== entry.node) ref.parentNode.insertBefore(entry.node, ref.nextSibling);
          ref = entry.node;
        });

        for (const [k, entry] of rendered) {
          if (!seen.has(k)) { entry.controller.abort(); entry.node.remove(); rendered.delete(k); }
        }
      }, signal);

      // On disconnect, tear down every item's bindings/listeners promptly.
      signal?.addEventListener('abort', () => {
        for (const entry of rendered.values()) entry.controller.abort();
      }, { once: true });
    });
  }

  /**
   * Keep a set of store keys in sync with the URL's query string, so a filtered list
   * has a shareable address and survives a reload.
   *
   * Runs URL → store immediately, so call it **before** `store.resource(...)`: that way
   * the first request already uses the filters from the URL instead of fetching with the
   * defaults and then refetching.
   *
   * The value written back is typed after the store's initial value: a key that starts
   * as a number comes back as a number, and one that starts as a boolean comes back as a
   * boolean. Without that, `pagina` would return from the URL as the string `'2'` and
   * `pagina + 1` would quietly produce `'21'`.
   *
   * Keys sitting at their default are dropped from the URL, so a pristine view stays a
   * clean `/propiedades` instead of `/propiedades?q=&orden=precio`.
   *
   * Updates use `replaceState`: typing in a filter must not stack one history entry per
   * keystroke. Navigating away and coming back still restores the filters, because the
   * URL was replaced in place and `popstate` re-reads it.
   *
   * @param {{ signals: Object, state: Object }} store - Store from {@link Homly.createStore}.
   * @param {string[]} keys - Store keys to mirror in the query string.
   * @param {AbortSignal} [signal] - Aborted on disconnect; drops the listeners.
   */
  static bindQuery(store, keys, signal) {
    const defaults = {};
    for (const key of keys) {
      if (store.signals[key]) defaults[key] = store.signals[key].get();
      else if (Homly._level()) Homly._warn("bindQuery: no existe la señal '" + key + "' en el store");
    }

    const cast = (key, raw) => {
      const def = defaults[key];
      if (typeof def === 'number') return Number(raw);
      if (typeof def === 'boolean') return raw !== 'false';
      return raw;
    };

    // URL → store. Una clave ausente vuelve a su default (así el botón atrás limpia
    // un filtro que ya no está en la URL, en vez de dejarlo pegado).
    const read = () => {
      const qs = new URLSearchParams(location.search);
      for (const key in defaults) {
        store.signals[key].set(qs.has(key) ? cast(key, qs.get(key)) : defaults[key]);
      }
    };

    // store → URL.
    const write = () => {
      const qs = new URLSearchParams(location.search);
      for (const key in defaults) {
        const value = store.signals[key].get();
        if (value === defaults[key] || value === '' || value == null || value === false) qs.delete(key);
        else qs.set(key, value);
      }
      const search = qs.toString();
      const next = location.pathname + (search ? '?' + search : '') + location.hash;
      if (next !== location.pathname + location.search + location.hash) {
        history.replaceState(history.state, '', next);
      }
    };

    read();

    let primed = false;   // subscribe es eager: la primera llamada no es un cambio real
    for (const key in defaults) store.signals[key].subscribe(() => { if (primed) write(); }, signal);
    primed = true;

    addEventListener('popstate', read);
    signal?.addEventListener('abort', () => removeEventListener('popstate', read), { once: true });
  }

  /**
   * Set the document title and `<meta>` tags, creating each tag the first time and
   * updating it afterwards (so calling this on every navigation never duplicates them).
   * A key with an empty or null value removes its tag.
   *
   * ⚠️ **This is not an SEO feature.** Social scrapers (WhatsApp, Twitter, Slack) don't
   * run JavaScript, so a tag written here after hydration doesn't exist for them. For
   * link previews and indexing, the tags have to be in the HTML the server sends — which
   * is what the router's prerender adoption is for. What this *does* fix is the browser
   * tab and the history entry saying the right thing while you move around the SPA.
   *
   * `og:*` keys are written as `property`, everything else as `name`, matching what the
   * Open Graph and Twitter specs expect.
   *
   * @param {Object<string, ?string>} tags - `title` sets `document.title`; every other
   *   key becomes a `<meta>` tag, e.g. `{ title, description, 'og:image' }`.
   */
  static head(tags) {
    for (const key in tags) {
      const value = tags[key];

      if (key === 'title') {
        if (value != null) document.title = value;
        continue;
      }

      const attr = key.startsWith('og:') ? 'property' : 'name';
      let tag = document.head.querySelector('meta[' + attr + '="' + key + '"]');

      if (value == null || value === '') {
        tag?.remove();
        continue;
      }
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute(attr, key);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', value);
    }
  }

  /**
   * Find the `data-for` row a node belongs to: the nearest ancestor (the node itself
   * included) that {@link Homly.bindList} registered. Nearest wins, so a click inside a
   * nested list resolves to the inner row, not the outer one.
   *
   * @param {HTMLElement} el - Node the event came from.
   * @returns {?Object} The row's store, or undefined when the node isn't inside a list.
   */
  static _itemFor(el) {
    for (let node = el; node; node = node.parentElement) {
      const item = Homly.listItems.get(node);
      if (item) return item;
    }
  }

  /**
   * Current dev-logging level, read live from `globalThis.HOM_DEBUG`.
   * Returns null (off), 'basic' or 'verbose'. Off returns immediately, so guarding
   * a call-site with `if (Homly._level())` costs ~nothing when logging is disabled.
   * @returns {null | 'basic' | 'verbose'}
   */
  static _level() {
    const v = globalThis.HOM_DEBUG;
    if (!v) return null;
    return v === 'verbose' ? 'verbose' : 'basic';
  }

  /** Dev log line: `[homly] <glyph> <msg>`. Call guarded by `_level()`. */
  static _log(glyph, msg) { console.log('[homly] ' + glyph + ' ' + msg); }

  /** Dev warning: `[homly] ⚠ <msg>`. Call guarded by `_level()`. */
  static _warn(msg) { console.warn('[homly] ⚠ ' + msg); }

  /** Compact value formatter for verbose logs (avoids dumping big objects). */
  static _fmt(v) {
    if (Array.isArray(v)) return '[' + v.length + ']';
    if (v && typeof v === 'object') return '{…}';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
  }

  /**
   * Attach a single delegated click listener that maps `data-action="name"`
   * clicks to handlers in `actions`. The listener is removed when
   * `context.signal` aborts.
   *
   * While an async action runs, the framework manages the target's loading
   * state automatically: it disables the control, adds the `is-loading` class
   * and, if the target has a `data-loading-text` attribute, swaps its text for
   * that label. When the action settles, the state is restored. The original
   * text is only restored if the action did not change it itself — so a handler
   * can leave a final label (e.g. "Sent!") and the framework won't overwrite it.
   *
   * When the click came from inside a `data-for` row, the row's store is added to the
   * context as `item`, so a per-row button knows what it operates on without stamping
   * ids on the markup and reading them back.
   *
   * @param {HTMLElement} container - Element the listener is attached to.
   * @param {Object<string, (target: HTMLElement, context: Object) => void>} actions - Handlers by action name.
   * @param {{ signal?: AbortSignal, host?: HTMLElement }} [context] - Passed as the second argument to each handler.
   */
  static attachDispatcher(container, actions, context = {}) {
    const handler = async (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const actionName = target.getAttribute('data-action');
      const action = actions[actionName];
      if (!action) return;

      const item = Homly._itemFor(target);
      const ctx = item ? { ...context, item } : context;

      const loadingText = target.getAttribute('data-loading-text');
      const originalText = target.textContent;
      const isControl = target.tagName === 'BUTTON' || target.tagName === 'INPUT';

      if (loadingText !== null) target.textContent = loadingText;
      if (isControl) target.disabled = true;
      target.classList.add('is-loading');

      try {
        await action(target, ctx);
      } finally {
        if (isControl) target.disabled = false;
        target.classList.remove('is-loading');
        // Restaurar el texto solo si la acción no lo cambió ella misma.
        if (loadingText !== null && target.textContent === loadingText) {
          target.textContent = originalText;
        }
      }
    };
    container.addEventListener('click', handler);
    if (context.signal) {
      context.signal.addEventListener('abort', () => container.removeEventListener('click', handler), { once: true });
    }
  }
}

// Seed HOM_DEBUG once at load from the URL (?homly-debug[=verbose]) or localStorage
// (HOM_DEBUG), unless it's already set on the global (an inline script wins). Priming
// it here lets the very first hydration see the flag; everything else reads it live
// via Homly._level().
(() => {
  if (globalThis.HOM_DEBUG !== undefined) return;
  let raw;
  try {
    const qs = new URLSearchParams(globalThis.location?.search || '');
    if (qs.has('homly-debug')) raw = qs.get('homly-debug') || 'true';
    else raw = globalThis.localStorage?.getItem('HOM_DEBUG') ?? undefined;
  } catch (_) { /* sandboxed / no DOM: stay off */ }
  if (raw == null) return;
  const v = String(raw).toLowerCase();
  if (v === 'verbose') globalThis.HOM_DEBUG = 'verbose';
  else if (v === 'false' || v === '0' || v === '') { /* explicit off */ }
  else globalThis.HOM_DEBUG = true;
})();

/**
 * Base class for Homly components. Extend it and override the getters
 * (`templateUrl`, `styleUrl`/`styles`, `basePath`, `store`, `actions`) and the
 * lifecycle hooks (`onMount`, `onUnmount`).
 *
 * On connect it performs "smart hydration": if the element already has content
 * (e.g. server-rendered), it is kept; otherwise the template is loaded. Scoped
 * CSS is injected only once (marked with `data-homly-scope`), and the DOM is
 * then wired to the store and the action dispatcher.
 *
 * @extends HTMLElement
 */
export class HomlyComponent extends HTMLElement {
  constructor() {
    super();
    this.controller = new AbortController();
    /** @type {AbortSignal} Aborted on disconnect; tears down bindings and listeners. */
    this.signal = this.controller.signal;
  }

  /**
   * Lifecycle hook. Wraps hydration in an error boundary: if anything throws
   * (e.g. a template fails to load over the network), it logs the error and
   * renders a placeholder instead of leaving the component's DOM broken.
   * @returns {Promise<void>}
   */
  async connectedCallback() {
    try {
      await this._hydrate();
    } catch (err) {
      console.error(`[homly] fallo montando <${this.localName}>`, err);
      this.renderError(err);
    }
  }

  /**
   * Load/hydrate the template and scoped CSS, then wire reactivity. Called by
   * `connectedCallback` inside an error boundary.
   * @returns {Promise<void>}
   */
  async _hydrate() {
    const _t0 = performance.now();
    const resolve = (path) => (this.basePath ? new URL(path, this.basePath).href : path);

    // Smart hydration: only fetch the HTML if the element is empty; if it already
    // has content (pre-render / SSR), leave it untouched. The scoped CSS is added
    // unless the content already shipped its own <style data-homly-scope>.
    const needsTemplate = this.children.length === 0 && (this.templateUrl || this.template);
    const needsStyle = !this.querySelector('style[data-homly-scope]') && (this.styleUrl || this.styles);

    // Fetch HTML and CSS up front (in parallel) so we can apply both in a single
    // synchronous step. If we set innerHTML and then `await` the stylesheet, the
    // browser may paint the unstyled HTML in between — a flash of unstyled content
    // (e.g. a position:fixed modal showing for a frame). Awaiting both first and
    // applying them with no await in between guarantees the first paint is styled.
    const [tplText, cssFile] = await Promise.all([
      needsTemplate && this.templateUrl ? Homly.loadTemplate(resolve(this.templateUrl)) : Promise.resolve(null),
      needsStyle && this.styleUrl ? Homly.loadTemplate(resolve(this.styleUrl)) : Promise.resolve(null),
    ]);

    // innerHTML replaces children, so set it first and then prepend the <style>.
    if (needsTemplate) {
      this.innerHTML = this.templateUrl ? tplText : this.template();
    }
    if (needsStyle) {
      const cssText = this.styleUrl ? cssFile : this.styles;
      if (cssText) {
        const styleBlock = document.createElement('style');
        styleBlock.setAttribute('data-homly-scope', '');
        styleBlock.textContent = `@scope {\n${cssText}\n}`;
        this.prepend(styleBlock);
      }
    }

    if (Homly._level()) {
      const _s = this.store;
      if (_s !== undefined && _s !== this.store) {
        Homly._warn(this.localName + ': store no memoizado (devuelve una instancia nueva por acceso) — usá get store(){ return this._store ??= … }');
      }
    }

    // Wire the DOM to reactivity: shared (global) stores first, then the local store.
    if (this.globalStores) {
      this.globalStores.forEach(gStore => Homly.bindView(this, gStore, this.signal));
    }
    if (this.store) Homly.bindView(this, this.store, this.signal);
    if (this.actions) Homly.attachDispatcher(this, this.actions, { signal: this.signal, host: this });
    if (this.store) Homly.bindList(this, this.store, this.signal);
    if (this.onMount) this.onMount();
    // First activation, after the template has rendered. Under a keep-alive router
    // `onMount` runs once but `onActivate` runs again every time the element is
    // shown back; here we fire the first one (re-activations come from the router).
    if (this.onActivate) this.onActivate();
    if (Homly._level()) Homly._log('⬆', this.localName + ' hydrated in ' + (performance.now() - _t0).toFixed(1) + 'ms');
  }

  /** Lifecycle hook: abort all subscriptions/listeners and call `onUnmount` if defined. */
  disconnectedCallback() {
    this.controller.abort();
    if (Homly._level()) Homly._log('✕', this.localName + ' unmount');
    if (this.onUnmount) this.onUnmount();
  }

  /**
   * Render a fallback when hydration fails (the error boundary). Override this
   * in a subclass to customise the message or markup.
   * @param {Error} err - The error thrown during hydration.
   */
  renderError(err) {
    this.innerHTML = '<div data-homly-error role="alert" style="padding:12px 14px;'
      + 'border:1px solid #d9534f;border-radius:8px;color:#d9534f;'
      + 'font:14px/1.45 system-ui,sans-serif">No se pudo cargar este contenido. '
      + 'Intentá recargar la página.</div>';
  }

  /** @returns {?string} URL of the HTML template, resolved against `basePath` when set. */
  get templateUrl() { return null; }
  /** @returns {?string} URL of a CSS file; injected scoped with `@scope`. */
  get styleUrl() { return null; }
  /** @returns {?string} Inline CSS string (alternative to `styleUrl`). */
  get styles() { return null; }
  /** @returns {?string} Base URL for resolving relative paths (usually `import.meta.url`). */
  get basePath() { return null; }
  /** @returns {?(() => string)} Function returning an HTML string (alternative to `templateUrl`). */
  get template() { return null; }
  /** @returns {?{ state: Object, signals: Object }} The component's reactive store. */
  get store() { return null; }
  /** @returns {?Object<string, Function>} Map of action names to handlers. */
  get actions() { return null; }
  /** @returns {?Array<{ state: Object, signals: Object }>} Shared stores bound in addition to `store`. */
  get globalStores() { return null; }

  // Optional lifecycle hooks (define them as methods on your subclass):
  //   onMount()      — once, after the template renders.
  //   onActivate()   — when the element becomes visible (first mount + every time
  //                    a keep-alive router shows it again).
  //   onDeactivate() — when a keep-alive router hides it (navigating away).
  //   onUnmount()    — when the element is removed from the DOM.
}

/**
 * Minimal SPA router. It swaps the content of a root element on navigation,
 * intercepts `<a data-router-link>` clicks, and supports per-route lazy loading
 * (code splitting).
 *
 * Routes can carry `:param` segments (`/blog/:slug`). Static routes always win over
 * dynamic ones, and each matched param is handed to the component as an attribute
 * (`<blog-post slug="hola-mundo">`) — no new API to learn, just `this.getAttribute()`.
 *
 * With `{ keepAlive: true }` each visited route's element is kept mounted and
 * toggled with `display` instead of being destroyed: returning to a route is
 * instant, with its DOM, state and scroll preserved. The router calls the
 * component's `onActivate`/`onDeactivate` hooks on show/hide; use `evict(path)`
 * to drop a cached route (which fires its `onUnmount`).
 */
export class HomlyRouter {
  /**
   * @param {string} rootId - id of the element whose content is swapped per route.
   * @param {{ keepAlive?: boolean }} [opts] - keepAlive preserves each visited route's element.
   */
  constructor(rootId, { keepAlive = false } = {}) {
    this.root = document.getElementById(rootId);
    /** @type {Object<string, { tag: string, loader: ?Function }>} */
    this.routes = {};
    this.keepAlive = keepAlive;
    /** @type {Map<string, { el: HTMLElement, scrollY: number }>} */
    this.alive = new Map();
    /** @type {Set<Object>} Routes already prefetched, so a hover only downloads once. */
    this.prefetched = new Set();
    this.current = null;

    window.addEventListener('popstate', () => this.handleRoute(window.location.pathname));

    document.body.addEventListener('click', e => {
      const link = e.target.closest('a[data-router-link]');
      if (!link || !HomlyRouter._handles(e, link)) return;
      e.preventDefault();
      this.navigate(link.getAttribute('href'));
    });

    // Prefetch on hover (and on focus, so tabbing gets the same head start): by the
    // time the click lands, the route's chunk is usually already there. One delegated
    // listener each, not one per link — links come and go with every navigation.
    for (const type of ['pointerover', 'focusin']) {
      document.body.addEventListener(type, e => {
        const link = e.target.closest?.('a[data-router-link]');
        if (link && link.origin === location.origin) this.prefetch(link.pathname);
      });
    }
  }

  /**
   * Whether the router should take over this click, or step aside and let the browser
   * navigate on its own.
   *
   * It steps aside for:
   *  - **Another origin.** `pushState` to a different origin throws a SecurityError, so a
   *    shared nav that points at sibling sites has to fall through to a real navigation.
   *  - **`target` or `download`.** The author already said where this should open.
   *  - **A modified or non-primary click.** ⌘/Ctrl/Shift-click and middle-click mean
   *    "new tab/window", and swallowing them is the fastest way to feel broken.
   *
   * @param {MouseEvent} e - The click.
   * @param {HTMLAnchorElement} link - The `a[data-router-link]` that was hit.
   * @returns {boolean}
   */
  static _handles(e, link) {
    return link.origin === location.origin
      && !link.hasAttribute('target')
      && !link.hasAttribute('download')
      && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
      && (e.button ?? 0) === 0;
  }

  /**
   * Run a route's lazy loader ahead of time. Called on hover/focus, and safe to call by
   * hand for a route you know is coming next.
   *
   * Each route is prefetched at most once; templates and CSS are already deduped by
   * {@link Homly.loadTemplate}. A prefetch that fails is swallowed on purpose — it is
   * best-effort, and navigating there for real runs the loader again.
   *
   * @param {string} path - Path to warm up.
   */
  prefetch(path) {
    const { route } = this._resolve(path);
    if (!route.loader || this.prefetched.has(route)) return;

    this.prefetched.add(route);
    if (Homly._level()) Homly._log('⇢', 'prefetch ' + path);
    Promise.resolve(route.loader()).catch(() => {});
  }

  /**
   * Register a route. The path may contain `:param` segments (`/blog/:slug`), whose
   * values are passed to the component as attributes.
   *
   * @param {string} path - URL path (e.g. `/contact`, `/blog/:slug`).
   * @param {string} componentTag - Custom element tag to render (e.g. `homly-contact-page`).
   * @param {?(() => Promise<*>)} [loader] - Optional dynamic import run before render (code splitting).
   */
  add(path, componentTag, loader = null) {
    // HTML lowercases attribute names, so `:userId` would only be readable as
    // getAttribute('userid') — a silent miss. Warn once, at registration.
    if (Homly._level() && /:[^/]*[A-Z]/.test(path)) {
      Homly._warn('ruta "' + path + '": los params con mayúsculas se leen en minúscula '
        + "(getAttribute('userid'), no 'userId') — usá kebab-case");
    }
    this.routes[path] = { tag: componentTag, loader };
  }

  /**
   * Match a path against a route pattern with `:param` segments. Pure and DOM-free
   * on purpose, so the matching rules can be unit-tested outside a browser.
   *
   * Segment counts must be equal, so `/blog/:slug` matches `/blog/hola` but neither
   * `/blog` nor `/blog/a/b`. An empty segment (`/blog/`) does not match either.
   *
   * @param {string} pattern - e.g. `/blog/:slug`.
   * @param {string} path - e.g. `/blog/hola-mundo`.
   * @returns {?Object<string, string>} Decoded params, or null when it doesn't match.
   */
  static matchRoute(pattern, path) {
    const pat = pattern.split('/');
    const seg = path.split('/');
    if (pat.length !== seg.length) return null;

    const params = {};
    for (let i = 0; i < pat.length; i++) {
      if (pat[i][0] === ':') {
        if (!seg[i]) return null;                        // `/blog/` no es un slug válido
        params[pat[i].slice(1)] = decodeURIComponent(seg[i]);
      } else if (pat[i] !== seg[i]) {
        return null;
      }
    }
    return params;
  }

  /**
   * Resolve a path: exact match first (so a static route always beats a dynamic one),
   * then the registered `:param` patterns in declaration order, then `/404`.
   *
   * @param {string} path
   * @returns {{ route: { tag: string, loader: ?Function }, params: Object<string, string>, pattern: ?string }}
   */
  _resolve(path) {
    if (this.routes[path]) return { route: this.routes[path], params: {}, pattern: path };

    for (const pattern in this.routes) {
      if (!pattern.includes(':')) continue;
      const params = HomlyRouter.matchRoute(pattern, path);
      if (params) return { route: this.routes[pattern], params, pattern };
    }

    return { route: this.routes['/404'] || { tag: 'div', loader: null }, params: {}, pattern: null };
  }

  /**
   * Build the route's element with its params as attributes. `setAttribute` never
   * parses HTML, so a path segment can't inject markup the way an interpolated
   * `innerHTML` string could.
   *
   * @param {string} tag
   * @param {Object<string, string>} params
   * @returns {HTMLElement}
   */
  static _create(tag, params) {
    const el = document.createElement(tag);
    for (const key in params) el.setAttribute(key, params[key]);
    return el;
  }

  /**
   * Navigate to a path with `pushState` (no full reload).
   * @param {string} path
   */
  navigate(path) {
    window.history.pushState({}, '', path);
    this.handleRoute(path);
  }

  /**
   * Resolve a route: run its lazy loader (if any), then render its tag into root.
   * On the initial resolution, adopts a matching prerendered element already in
   * the outlet (hydrating it in place) instead of recreating it; locked to the
   * first call. Falls back to a `/404` route or an empty `<div>`.
   * @param {string} path
   * @returns {Promise<void>}
   */
  async handleRoute(path) {
    // In-page `#hash` links fire popstate with the *same* pathname. Re-rendering
    // and resetting scroll here would cancel the browser's native anchor scroll,
    // so bail when the resolved route hasn't changed (the first call always runs).
    if (this._lastPath === path) return;
    this._lastPath = path;

    const { route, params, pattern } = this._resolve(path);
    if (Homly._level()) {
      Homly._log('⚡', 'route ' + (this.current ?? '∅') + ' → ' + path
        + (pattern && pattern !== path ? ' (' + pattern + ')' : ''));
    }
    if (route.loader) await route.loader();

    // Adopt prerendered DOM on the initial route resolution: if the loader's
    // define() just upgraded an element already in the outlet (smart hydration
    // wired it), reuse it instead of wiping. Locked to the first call.
    const adopt = !this._hasHydrated
      && this.root.firstElementChild
      && this.root.firstElementChild.localName === route.tag;
    this._hasHydrated = true;
    if (adopt && Homly._level()) {
      Homly._log('⚓', 'adopt ' + route.tag);
      // The element was already upgraded (and onMount already ran) by the time we get
      // here, so we can't back-fill its params: prerendered markup has to carry them.
      for (const key in params) {
        if (!this.root.firstElementChild.hasAttribute(key)) {
          Homly._warn('adopt ' + route.tag + ': falta el atributo "' + key
            + '" en el HTML prerenderizado — escribilo en el markup');
        }
      }
    }

    // Default: destroy and recreate (fires onUnmount → onMount on every navigation).
    if (!this.keepAlive) {
      if (adopt) return;                              // adopt: don't wipe, keep scroll
      this.root.replaceChildren(HomlyRouter._create(route.tag, params));
      window.scrollTo(0, 0);
      return;
    }

    // Keep-alive: hide the outgoing route (saving its scroll) and notify it.
    if (this.current && this.alive.has(this.current)) {
      const prev = this.alive.get(this.current);
      prev.scrollY = window.scrollY;
      prev.el.style.display = 'none';
      prev.el.onDeactivate?.();
      if (Homly._level()) Homly._log('⏸', prev.el.localName + ' deactivate');
    }

    // Show the incoming route: create it the first time, reuse it afterwards.
    let entry = this.alive.get(path);
    const isNew = !entry;
    if (Homly._level()) Homly._log(isNew ? '▷' : '▶', 'keep-alive ' + (isNew ? 'MISS' : 'HIT') + ' ' + path);
    if (isNew) {
      let el;
      if (adopt) {
        el = this.root.firstElementChild;             // adopt the prerendered element (already in the DOM)
      } else {
        el = HomlyRouter._create(route.tag, params);   // connectedCallback → onMount() → onActivate()
        this.root.appendChild(el);
      }
      entry = { el, scrollY: 0 };
      this.alive.set(path, entry);
    }
    entry.el.style.display = '';
    // Restore scroll on the next frame: scrolling synchronously right after the
    // display change clamps against a stale (not-yet-reflowed) document height.
    // On adoption we keep the entry scroll (deep-link / browser restore).
    if (!adopt) {
      const y = entry.scrollY;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
    if (!isNew) entry.el.onActivate?.();               // re-activation (first one came from connectedCallback)
    if (!isNew && Homly._level()) Homly._log('▶', entry.el.localName + ' activate');
    this.current = path;
  }

  /**
   * Drop a cached keep-alive route, removing its element (fires its `onUnmount`).
   * Useful to bound memory (e.g. an LRU when there are many routes).
   * @param {string} path
   */
  evict(path) {
    const entry = this.alive.get(path);
    if (entry) {
      entry.el.remove();
      if (Homly._level()) Homly._log('✕', 'evict ' + path);
      this.alive.delete(path);
      if (this.current === path) this.current = null;
    }
  }

  /** Render the route matching the current `location.pathname`. */
  start() {
    this.handleRoute(window.location.pathname);
  }
}
