// Smoke-test of media/monitor.js in a minimal fake DOM: loads the script,
// feeds it controls/update messages and fails on any thrown error.
// Two scenarios: the current HTML shell, and an outdated shell without the
// criteria elements (extension updated without a window reload).
// Run: node test/webview.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeElement(tag) {
    const el = {
        tagName: tag,
        children: [],
        style: { cssText: '' },
        listeners: {},
        hidden: false,
        checked: false,
        value: '',
        title: '',
        className: '',
        id: '',
        type: '',
        clientWidth: 800,
        clientHeight: 400,
        width: 0,
        height: 0,
        offsetWidth: 100,
        offsetHeight: 50,
        options: [],
        appendChild(child) {
            this.children.push(child);
            if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
                this.options.push(child);
                if (this.options.length === 1) this.value = child.value;
            }
            return child;
        },
        append(...nodes) {
            for (const n of nodes) this.children.push(n);
        },
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        dispatch(type, event) {
            for (const fn of this.listeners[type] || []) fn(event);
        },
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 800, height: 400 };
        },
        getContext() {
            return new Proxy(
                {},
                {
                    get(target, prop) {
                        if (!(prop in target)) target[prop] = () => {};
                        return target[prop];
                    },
                    set(target, prop, value) {
                        target[prop] = value;
                        return true;
                    },
                }
            );
        },
    };
    let text = '';
    Object.defineProperty(el, 'textContent', {
        get: () => text,
        set: (v) => {
            text = v;
            el.children = [];
            if (el.tagName === 'SELECT') el.options = [];
        },
    });
    return el;
}

const BASE_IDS = [
    'chart', 'legend', 'log-select', 'status', 'time', 'steps', 'exec',
    'clock', 'cont-local', 'cont-global', 'cont-cum', 'residual-list',
    'monitors-block', 'monitor-list', 'splitter', 'info-pane',
    'chart-title', 'chart-header',
];
const CRITERIA_IDS = ['criteria-block', 'criteria-list', 'show-controls'];

function boot(withCriteriaIds) {
    const ids = {};
    const create = (id) => {
        const tag =
            id === 'chart' ? 'CANVAS'
            : id === 'log-select' ? 'SELECT'
            : id === 'show-controls' ? 'INPUT'
            : 'DIV';
        ids[id] = makeElement(tag);
        ids[id].id = id;
        if (id === 'show-controls') ids[id].checked = true;
    };
    for (const id of BASE_IDS) create(id);
    if (withCriteriaIds) for (const id of CRITERIA_IDS) create(id);

    const messageListeners = [];
    const posted = [];
    const documentStub = {
        // Missing ids return null, like a real outdated DOM.
        getElementById: (id) => ids[id] || null,
        createElement: (tag) => makeElement(tag.toUpperCase()),
        createTextNode: (t) => ({ tagName: '#text', textContent: t }),
        body: makeElement('BODY'),
        documentElement: makeElement('HTML'),
    };
    const sandbox = {
        document: documentStub,
        window: {
            addEventListener(type, fn) {
                if (type === 'message') messageListeners.push(fn);
            },
            innerWidth: 1200,
            innerHeight: 800,
            devicePixelRatio: 1,
        },
        acquireVsCodeApi: () => ({
            postMessage: (m) => posted.push(m),
            getState: () => undefined,
            setState: () => {},
        }),
        getComputedStyle: () => ({
            getPropertyValue: (name) =>
                name.startsWith('--series') ? '#2a78d6' : 'system-ui',
        }),
        requestAnimationFrame: (fn) => {
            fn();
            return 1;
        },
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
        console,
    };
    sandbox.globalThis = sandbox;
    const code = fs.readFileSync(
        path.join(__dirname, '..', 'media', 'monitor.js'),
        'utf8'
    );
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox); // throws if the script errors at load
    return {
        ids,
        posted,
        send: (data) => messageListeners[0]({ data }),
        infoPane: ids['info-pane'],
    };
}

const CONTROLS = [
    { pattern: 'p', tolerance: 1e-2 },
    { pattern: 'U', tolerance: 1e-3 },
    { pattern: '(k|epsilon|omega|f|v2)', tolerance: 1e-3 },
];

function makeUpdate() {
    return {
        type: 'update',
        update: {
            reset: true,
            residuals: {
                Ux: [
                    { time: 1, initial: 0.1, final: 1e-5, iterations: 3 },
                    { time: 2, initial: 0.05, final: 1e-5, iterations: 3 },
                ],
                p: [
                    { time: 1, initial: 0.3, final: 1e-6, iterations: 10 },
                    { time: 2, initial: 0.2, final: 1e-6, iterations: 9 },
                ],
                k: [{ time: 1, initial: 0.2, final: 1e-6, iterations: 2 }],
            },
            monitorSeries: {},
            snapshot: {
                logFile: 'log.simpleFoam',
                availableLogs: ['log.simpleFoam'],
                time: 2,
                stepCount: 2,
                executionTime: 1.5,
                clockTime: 2,
                continuity: { local: 1e-6, global: 1e-7, cumulative: -1e-4 },
                monitorValues: {},
                finished: false,
                running: true,
            },
        },
    };
}

// --------------------------- scenario 1: current HTML with criteria elements
{
    const dom = boot(true);
    assert.strictEqual(dom.posted.length, 1);
    assert.strictEqual(dom.posted[0].type, 'ready');

    dom.send({ type: 'controls', controls: CONTROLS });
    dom.send(makeUpdate());

    const resRows = dom.ids['residual-list'].children;
    assert.strictEqual(resRows.length, 3);
    assert.strictEqual(resRows[0].children[0].tagName, 'INPUT');

    assert.strictEqual(dom.ids['criteria-block'].hidden, false);
    assert.strictEqual(dom.ids['criteria-list'].children.length, 3);

    // Toggles must not throw.
    resRows[0].children[0].checked = false;
    resRows[0].children[0].dispatch('change');
    dom.ids['show-controls'].checked = false;
    dom.ids['show-controls'].dispatch('change');

    // No residualControl -> block hidden.
    dom.send({ type: 'controls', controls: [] });
    assert.strictEqual(dom.ids['criteria-block'].hidden, true);
}

// ------------- scenario 2: outdated HTML shell without criteria elements —
// the script must build them dynamically instead of crashing.
{
    const dom = boot(false);
    assert.strictEqual(dom.posted.length, 1);
    assert.strictEqual(dom.posted[0].type, 'ready');

    // The dynamically built criteria block was appended to the info pane.
    const dynBlock = dom.infoPane.children[dom.infoPane.children.length - 1];
    assert.ok(dynBlock);
    assert.strictEqual(dynBlock.className, 'info-block');
    assert.strictEqual(dynBlock.hidden, true);

    dom.send({ type: 'controls', controls: CONTROLS });
    dom.send(makeUpdate());
    assert.strictEqual(dynBlock.hidden, false);
    const dynList = dynBlock.children[dynBlock.children.length - 1];
    assert.strictEqual(dynList.children.length, 3);
}

console.log('All webview smoke tests passed.');
