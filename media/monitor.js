// Webview script for the OpenFOAM convergence monitor.
// Draws initial residuals (log y) and custom monitor series on a canvas,
// and renders the textual info pane.
(function () {
    'use strict';

    // Surface any script error as a visible banner instead of a silently
    // blank chart (e.g. when the extension was updated without a reload).
    window.addEventListener('error', (e) => {
        let banner = document.getElementById('of-error');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'of-error';
            banner.style.cssText =
                'position:fixed;top:0;left:0;right:0;z-index:99;' +
                'padding:5px 10px;background:#d03b3b;color:#fff;font-size:12px;';
            document.body.appendChild(banner);
        }
        banner.textContent =
            'Monitor script error: ' +
            (e.message || String(e)) +
            ' — try reloading the window (Developer: Reload Window).';
    });

    const vscode = acquireVsCodeApi();

    /** series name -> {points: [{t, v}], color, visible, isMonitor} */
    const series = new Map();
    let colorIndex = 0;

    /** residualControl criteria: [{pattern, tolerance}] from fvSolution. */
    let controls = [];
    let showControls = true;
    /** Field names whose individual criterion line is unchecked. */
    const hiddenControls = new Set();
    let lastSnap = null;

    /** Match a residual field (Ux, p, k…) against residualControl patterns. */
    function controlFor(field) {
        for (const c of controls) {
            if (c.pattern === field) return c;
            // Vector components: pattern "U" covers Ux/Uy/Uz.
            if (/[xyz]$/.test(field) && c.pattern === field.slice(0, -1)) {
                return c;
            }
            try {
                if (new RegExp('^(?:' + c.pattern + ')$').test(field)) {
                    return c;
                }
            } catch (e) {
                /* not a valid JS regex — ignore */
            }
        }
        return null;
    }

    const palette = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
        getComputedStyle(document.documentElement).getPropertyValue(
            `--series-${i}`
        )
    );

    function cssVar(name, fallback) {
        const v = getComputedStyle(document.body).getPropertyValue(name);
        return v ? v.trim() : fallback;
    }

    function seriesColor() {
        // Fixed assignment order; extra series reuse the last slot rather
        // than inventing hues.
        const styles = getComputedStyle(document.body);
        const idx = Math.min(colorIndex, 7);
        const c = styles.getPropertyValue(`--series-${idx + 1}`).trim();
        colorIndex++;
        return c || palette[idx] || '#888';
    }

    function getSeries(name, isMonitor) {
        let s = series.get(name);
        if (!s) {
            s = {
                points: [],
                color: seriesColor(),
                visible: true,
                isMonitor: !!isMonitor,
            };
            series.set(name, s);
            rebuildLegend();
        }
        return s;
    }

    // ------------------------------------------------------------------ DOM
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const legendEl = document.getElementById('legend');
    const logSelect = document.getElementById('log-select');

    const tooltip = document.createElement('div');
    tooltip.id = 'tooltip';
    document.body.appendChild(tooltip);

    logSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'selectLog', file: logSelect.value });
    });

    // -------------------------------------------------- tabs & timing pane
    // Built dynamically so the script works with any HTML shell version.
    const layoutEl = document.getElementById('layout');
    const tabBar = document.createElement('div');
    tabBar.id = 'tab-bar';
    const tabResiduals = document.createElement('button');
    tabResiduals.className = 'tab-btn active';
    tabResiduals.textContent = 'Residuals';
    const tabTiming = document.createElement('button');
    tabTiming.className = 'tab-btn';
    tabTiming.textContent = 'Timing';
    tabBar.append(tabResiduals, tabTiming);
    document.body.appendChild(tabBar); // CSS `order:-1` puts it on top

    const timingPane = document.createElement('div');
    timingPane.id = 'timing-pane';
    timingPane.hidden = true;

    const timingHeader = document.createElement('div');
    timingHeader.className = 'timing-header';
    function makeChip(label, pale) {
        const chip = document.createElement('span');
        chip.className = 'legend-item';
        const sw = document.createElement('span');
        sw.className = 'legend-swatch' + (pale ? ' chip-pale' : '');
        sw.style.background = 'var(--vscode-foreground)';
        chip.append(sw, document.createTextNode(label));
        return chip;
    }
    const timingSummary = document.createElement('span');
    timingSummary.className = 'timing-summary';
    timingSummary.textContent = 'No timed steps yet — measuring starts with the next live step';
    const timingReset = document.createElement('button');
    timingReset.className = 'timing-reset';
    timingReset.textContent = 'Reset stats';
    timingHeader.append(
        makeChip('last step', false),
        makeChip('average', true),
        timingSummary,
        timingReset
    );

    const timingCanvas = document.createElement('canvas');
    timingCanvas.id = 'timing-chart';
    const tctx = timingCanvas.getContext('2d');

    const timingHint = document.createElement('p');
    timingHint.className = 'hint';
    timingHint.textContent =
        'Share of wall-clock time per step, from log-line arrival times ' +
        '(absolute durations calibrated with ExecutionTime). Only steps ' +
        'observed live are measured. Add custom phases via "timingMarkers" ' +
        'in openfoam-case.json: {"name": "radiation", "regex": "Radiation solver"}';

    timingPane.append(timingHeader, timingCanvas, timingHint);
    document.body.appendChild(timingPane);

    function selectTab(which) {
        const showTiming = which === 'timing';
        tabTiming.className = 'tab-btn' + (showTiming ? ' active' : '');
        tabResiduals.className = 'tab-btn' + (showTiming ? '' : ' active');
        if (layoutEl) {
            layoutEl.style.display = showTiming ? 'none' : 'flex';
        }
        timingPane.hidden = !showTiming;
        if (showTiming) {
            requestTimingDraw();
        } else {
            requestDraw();
        }
    }
    tabResiduals.addEventListener('click', () => selectTab('residuals'));
    tabTiming.addEventListener('click', () => selectTab('timing'));

    /** Accumulated timing statistics — reset only on demand or panel close. */
    const timing = {
        order: [], // tracked names in first-seen order ('other' pinned last)
        sums: new Map(), // name -> sum of shares over measured steps
        last: null, // last measured TimingStep
        steps: 0,
        skipped: 0,
        colors: new Map(), // names that are not residual series
    };

    timingReset.addEventListener('click', () => {
        timing.order = [];
        timing.sums.clear();
        timing.last = null;
        timing.steps = 0;
        timing.skipped = 0;
        updateTimingSummary();
        requestTimingDraw();
    });

    function timingColor(name) {
        if (name === 'other') {
            return cssVar('--muted', '#898781');
        }
        const s = series.get(name);
        if (s) {
            return s.color; // same entity, same color as on the residual chart
        }
        if (!timing.colors.has(name)) {
            timing.colors.set(name, seriesColor());
        }
        return timing.colors.get(name);
    }

    function ingestTimingSteps(steps) {
        for (const st of steps) {
            if (st.skipped) {
                timing.skipped++;
                continue;
            }
            timing.steps++;
            timing.last = st;
            const entries = Object.entries(st.shares || {});
            entries.push(['other', st.other]);
            for (const [name, share] of entries) {
                if (name !== 'other' && !timing.order.includes(name)) {
                    timing.order.push(name);
                }
                timing.sums.set(name, (timing.sums.get(name) || 0) + share);
            }
        }
        updateTimingSummary();
        if (!timingPane.hidden) {
            requestTimingDraw();
        }
    }

    function updateTimingSummary() {
        const parts = [];
        if (timing.steps > 0) {
            parts.push(
                timing.steps + ' step' + (timing.steps === 1 ? '' : 's') + ' measured'
            );
            const last = timing.last;
            const dur =
                last.execDeltaS !== null ? last.execDeltaS : last.rawMs / 1000;
            parts.push('last ' + fmt(dur) + ' s');
        }
        if (timing.skipped > 0) {
            parts.push(timing.skipped + ' skipped (too fast to time)');
        }
        timingSummary.textContent =
            parts.length > 0
                ? parts.join(' · ')
                : 'No timed steps yet — measuring starts with the next live step';
    }

    function rebuildLegend() {
        legendEl.textContent = '';
        for (const [name, s] of series) {
            const item = document.createElement('span');
            item.className = 'legend-item' + (s.visible ? '' : ' off');
            const sw = document.createElement('span');
            sw.className = 'legend-swatch';
            sw.style.background = s.color;
            item.appendChild(sw);
            item.appendChild(document.createTextNode(name));
            item.addEventListener('click', () => {
                s.visible = !s.visible;
                rebuildLegend();
                if (lastSnap) updateInfo(lastSnap); // sync checkboxes
                requestDraw();
            });
            legendEl.appendChild(item);
        }
    }

    // -------------------------------------------------------------- messages
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'controls') {
            controls = msg.controls || [];
            renderCriteria();
            requestDraw();
            return;
        }
        if (msg.type !== 'update') {
            return;
        }
        const u = msg.update;
        if (u.reset) {
            series.clear();
            colorIndex = 0;
            rebuildLegend();
        }
        for (const [field, points] of Object.entries(u.residuals || {})) {
            const s = getSeries(field, false);
            for (const p of points) {
                s.points.push({ t: p.time, v: p.initial });
            }
        }
        for (const [name, points] of Object.entries(u.monitorSeries || {})) {
            const s = getSeries(name, true);
            for (const p of points) {
                s.points.push({ t: p.time, v: p.value });
            }
        }
        if (u.timingSteps && u.timingSteps.length > 0) {
            ingestTimingSteps(u.timingSteps);
        }
        updateInfo(u.snapshot);
        requestDraw();
    });

    function fmt(x) {
        if (x === null || x === undefined) return '—';
        if (typeof x !== 'number') return String(x);
        if (x === 0) return '0';
        const a = Math.abs(x);
        if (a >= 1e5 || a < 1e-3) return x.toExponential(3);
        return String(Math.round(x * 1e6) / 1e6);
    }

    function setText(id, value) {
        document.getElementById(id).textContent = value;
    }

    function updateInfo(snap) {
        lastSnap = snap;
        // Log file dropdown.
        const current = logSelect.value;
        const options = ['auto', ...(snap.availableLogs || [])];
        if (
            options.length !== logSelect.options.length ||
            [...logSelect.options].some((o, i) => o.value !== options[i])
        ) {
            logSelect.textContent = '';
            for (const o of options) {
                const opt = document.createElement('option');
                opt.value = o;
                opt.textContent =
                    o === 'auto' ? 'auto (newest)' : o;
                logSelect.appendChild(opt);
            }
            logSelect.value = options.includes(current) ? current : 'auto';
        }
        if (logSelect.value === 'auto' && snap.logFile) {
            logSelect.options[0].textContent = `auto (${snap.logFile})`;
        }

        const statusEl = document.getElementById('status');
        if (snap.finished) {
            statusEl.textContent = 'finished (End)';
            statusEl.className = '';
        } else if (snap.running) {
            statusEl.textContent = 'running';
            statusEl.className = 'running';
        } else {
            statusEl.textContent = snap.logFile ? 'idle' : 'no log file';
            statusEl.className = '';
        }

        setText('time', fmt(snap.time));
        setText('steps', String(snap.stepCount));
        setText(
            'exec',
            snap.executionTime === null ? '—' : fmt(snap.executionTime) + ' s'
        );
        setText(
            'clock',
            snap.clockTime === null ? '—' : fmt(snap.clockTime) + ' s'
        );
        setText('cont-local', snap.continuity ? fmt(snap.continuity.local) : '—');
        setText(
            'cont-global',
            snap.continuity ? fmt(snap.continuity.global) : '—'
        );
        setText(
            'cont-cum',
            snap.continuity ? fmt(snap.continuity.cumulative) : '—'
        );

        // Last residual per field, with a checkbox toggling the series.
        const resList = document.getElementById('residual-list');
        resList.textContent = '';
        for (const [name, s] of series) {
            if (s.isMonitor || s.points.length === 0) continue;
            const last = s.points[s.points.length - 1];
            const row = document.createElement('div');
            row.className = 'res-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = s.visible;
            cb.title = 'Show ' + name + ' on the chart';
            cb.addEventListener('change', () => {
                s.visible = cb.checked;
                rebuildLegend();
                requestDraw();
            });
            const sw = document.createElement('span');
            sw.className = 'legend-swatch';
            sw.style.background = s.color;
            const field = document.createElement('span');
            field.className = 'field';
            field.textContent = name;
            const val = document.createElement('b');
            val.textContent = fmt(last.v);
            row.append(cb, sw, field, val);
            resList.appendChild(row);
        }
        renderCriteria();

        // Custom monitors.
        const monBlock = document.getElementById('monitors-block');
        const monList = document.getElementById('monitor-list');
        const entries = Object.entries(snap.monitorValues || {});
        monBlock.hidden = entries.length === 0;
        monList.textContent = '';
        for (const [name, value] of entries) {
            const row = document.createElement('div');
            row.className = 'info-row';
            const label = document.createElement('span');
            label.textContent = name;
            const val = document.createElement('b');
            val.textContent = value;
            row.append(label, val);
            monList.appendChild(row);
        }
    }

    // -------------------------------------------------------------- criteria
    // The criteria elements may be absent when an older HTML shell serves a
    // newer script (extension updated, window not reloaded) — build them.
    let criteriaBlock = document.getElementById('criteria-block');
    let criteriaList = document.getElementById('criteria-list');
    let showControlsCb = document.getElementById('show-controls');
    if (!criteriaBlock || !criteriaList || !showControlsCb) {
        criteriaBlock = document.createElement('div');
        criteriaBlock.className = 'info-block';
        criteriaBlock.hidden = true;
        const heading = document.createElement('h3');
        heading.textContent = 'residualControl criteria';
        const row = document.createElement('div');
        row.className = 'info-row';
        const label = document.createElement('span');
        label.textContent = 'Show on chart';
        showControlsCb = document.createElement('input');
        showControlsCb.type = 'checkbox';
        showControlsCb.checked = true;
        row.append(label, showControlsCb);
        criteriaList = document.createElement('div');
        criteriaBlock.append(heading, row, criteriaList);
        const pane = document.getElementById('info-pane');
        if (pane) {
            pane.appendChild(criteriaBlock);
        }
    }
    showControlsCb.addEventListener('change', () => {
        showControls = showControlsCb.checked;
        requestDraw();
    });

    /** Criterion lines currently applicable: [{field, color, tolerance}]. */
    function activeCriteria() {
        const out = [];
        for (const [name, s] of series) {
            if (s.isMonitor) continue;
            const c = controlFor(name);
            if (c) {
                out.push({ field: name, color: s.color, tolerance: c.tolerance, series: s });
            }
        }
        return out;
    }

    function renderCriteria() {
        const items = activeCriteria();
        // Nothing to show unless the case actually defines residualControl.
        criteriaBlock.hidden = items.length === 0;
        criteriaList.textContent = '';
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'res-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !hiddenControls.has(item.field);
            cb.title = 'Show the ' + item.field + ' criterion line';
            cb.addEventListener('change', () => {
                if (cb.checked) hiddenControls.delete(item.field);
                else hiddenControls.add(item.field);
                requestDraw();
            });
            const sw = document.createElement('span');
            sw.className = 'legend-swatch dashed';
            sw.style.borderColor = item.color;
            const field = document.createElement('span');
            field.className = 'field';
            field.textContent = item.field;
            const val = document.createElement('b');
            val.textContent = fmt(item.tolerance);
            row.append(cb, sw, field, val);
            criteriaList.appendChild(row);
        }
    }

    // ---------------------------------------------------------------- chart
    let drawQueued = false;
    function requestDraw() {
        if (drawQueued) return;
        drawQueued = true;
        requestAnimationFrame(() => {
            drawQueued = false;
            draw();
        });
    }

    const MARGIN = { left: 52, right: 10, top: 8, bottom: 26 };

    function visibleSeries() {
        return [...series.entries()].filter(
            ([, s]) => s.visible && s.points.length > 0
        );
    }

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0) return;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const vis = visibleSeries();
        const muted = cssVar('--muted', '#898781');
        ctx.font =
            '11px ' + cssVar('--vscode-font-family', 'system-ui, sans-serif');
        if (vis.length === 0) {
            ctx.fillStyle = muted;
            ctx.textAlign = 'center';
            ctx.fillText(
                'Waiting for residual data…',
                w / 2,
                h / 2
            );
            return;
        }

        // Extents. Y is log10 of positive values.
        let tMin = Infinity,
            tMax = -Infinity,
            yMin = Infinity,
            yMax = -Infinity;
        for (const [, s] of vis) {
            for (const p of s.points) {
                if (p.t < tMin) tMin = p.t;
                if (p.t > tMax) tMax = p.t;
                if (p.v > 0) {
                    const ly = Math.log10(p.v);
                    if (ly < yMin) yMin = ly;
                    if (ly > yMax) yMax = ly;
                }
            }
        }
        // Criterion lines participate in the vertical extent so they are
        // always visible when enabled.
        if (showControls) {
            for (const c of activeCriteria()) {
                if (
                    c.series.visible &&
                    !hiddenControls.has(c.field) &&
                    c.tolerance > 0
                ) {
                    const ly = Math.log10(c.tolerance);
                    if (ly < yMin) yMin = ly;
                    if (ly > yMax) yMax = ly;
                }
            }
        }
        if (!isFinite(yMin)) {
            yMin = -6;
            yMax = 0;
        }
        yMin = Math.floor(yMin) - 0.05;
        yMax = Math.ceil(yMax) + 0.05;
        if (tMax === tMin) tMax = tMin + 1;

        const px = MARGIN.left,
            pw = w - MARGIN.left - MARGIN.right,
            py = MARGIN.top,
            ph = h - MARGIN.top - MARGIN.bottom;
        const X = (t) => px + ((t - tMin) / (tMax - tMin)) * pw;
        const Y = (ly) => py + (1 - (ly - yMin) / (yMax - yMin)) * ph;

        // Grid: decades on Y.
        ctx.strokeStyle = cssVar('--grid', '#e1e0d9');
        ctx.lineWidth = 1;
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let d = Math.ceil(yMin); d <= Math.floor(yMax); d++) {
            const y = Y(d);
            ctx.beginPath();
            ctx.moveTo(px, y);
            ctx.lineTo(px + pw, y);
            ctx.stroke();
            ctx.fillText('1e' + d, px - 6, y);
        }

        // X ticks: ~6 nice values.
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const step = niceStep((tMax - tMin) / 6);
        for (
            let t = Math.ceil(tMin / step) * step;
            t <= tMax + 1e-12;
            t += step
        ) {
            const x = X(t);
            ctx.beginPath();
            ctx.moveTo(x, py);
            ctx.lineTo(x, py + ph);
            ctx.strokeStyle = cssVar('--grid', '#e1e0d9');
            ctx.stroke();
            ctx.fillText(trimNum(t), x, py + ph + 6);
        }

        // Axes baseline.
        ctx.strokeStyle = cssVar('--axis', '#c3c2b7');
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + ph);
        ctx.lineTo(px + pw, py + ph);
        ctx.stroke();

        // Series lines (2px), decimated to ~2 points per horizontal pixel.
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        for (const [, s] of vis) {
            const pts = decimate(s.points, pw * 2);
            ctx.strokeStyle = s.color;
            ctx.beginPath();
            let started = false;
            for (const p of pts) {
                if (p.v <= 0) {
                    started = false;
                    continue;
                }
                const x = X(p.t);
                const y = Y(Math.log10(p.v));
                if (started) {
                    ctx.lineTo(x, y);
                } else {
                    ctx.moveTo(x, y);
                    started = true;
                }
            }
            ctx.stroke();
        }

        // residualControl criteria: dashed horizontal line per field, same
        // color as its series. Drawn only when the case defines them.
        if (showControls) {
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            for (const c of activeCriteria()) {
                if (
                    !c.series.visible ||
                    hiddenControls.has(c.field) ||
                    c.tolerance <= 0
                ) {
                    continue;
                }
                const y = Y(Math.log10(c.tolerance));
                if (y < py || y > py + ph) continue;
                ctx.strokeStyle = c.color;
                ctx.beginPath();
                ctx.moveTo(px, y);
                ctx.lineTo(px + pw, y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        }

        chartGeom = { tMin, tMax, X, Y, px, pw, py, ph };
    }

    let chartGeom = null;

    function decimate(points, maxPoints) {
        if (points.length <= maxPoints) return points;
        const stride = Math.ceil(points.length / maxPoints);
        const out = [];
        for (let i = 0; i < points.length; i += stride) {
            // Keep the max within the window so spikes stay visible.
            let best = points[i];
            for (
                let j = i;
                j < Math.min(i + stride, points.length);
                j++
            ) {
                if (points[j].v > best.v) best = points[j];
            }
            out.push(best);
        }
        out.push(points[points.length - 1]);
        return out;
    }

    function niceStep(raw) {
        if (!isFinite(raw) || raw <= 0) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / mag;
        if (n < 1.5) return mag;
        if (n < 3.5) return 2 * mag;
        if (n < 7.5) return 5 * mag;
        return 10 * mag;
    }

    function trimNum(t) {
        return Math.abs(t) >= 1e5 || (t !== 0 && Math.abs(t) < 1e-3)
            ? t.toExponential(1)
            : String(Math.round(t * 1e6) / 1e6);
    }

    // ------------------------------------------------------- timing chart
    let timingDrawQueued = false;
    function requestTimingDraw() {
        if (timingDrawQueued) return;
        timingDrawQueued = true;
        requestAnimationFrame(() => {
            timingDrawQueued = false;
            drawTiming();
        });
    }

    let timingGeom = null; // group hit-boxes for the tooltip

    function timingNames() {
        const names = [...timing.order];
        if (timing.sums.has('other')) {
            names.push('other');
        }
        return names;
    }

    function drawTiming() {
        const dpr = window.devicePixelRatio || 1;
        const w = timingCanvas.clientWidth;
        const h = timingCanvas.clientHeight;
        if (w === 0 || h === 0) return;
        if (timingCanvas.width !== w * dpr || timingCanvas.height !== h * dpr) {
            timingCanvas.width = w * dpr;
            timingCanvas.height = h * dpr;
        }
        tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        tctx.clearRect(0, 0, w, h);

        const muted = cssVar('--muted', '#898781');
        tctx.font =
            '11px ' + cssVar('--vscode-font-family', 'system-ui, sans-serif');
        const names = timingNames();
        if (timing.steps === 0 || names.length === 0) {
            tctx.fillStyle = muted;
            tctx.textAlign = 'center';
            tctx.fillText(
                timing.skipped > 0
                    ? 'Steps are too fast to time on this case'
                    : 'Waiting for the next live time step…',
                w / 2,
                h / 2
            );
            timingGeom = null;
            return;
        }

        const last = timing.last;
        const lastOf = (name) =>
            name === 'other' ? last.other : (last.shares[name] ?? 0);
        const avgOf = (name) => (timing.sums.get(name) || 0) / timing.steps;

        let maxShare = 0.0001;
        for (const name of names) {
            maxShare = Math.max(maxShare, lastOf(name), avgOf(name));
        }
        // Nice axis top: smallest of these that covers the data.
        const yTop =
            [0.1, 0.25, 0.5, 0.75, 1].find((v) => v >= maxShare) ?? 1;

        const MARGIN_T = { left: 46, right: 10, top: 8, bottom: 24 };
        const px = MARGIN_T.left,
            pw = w - MARGIN_T.left - MARGIN_T.right,
            py = MARGIN_T.top,
            ph = h - MARGIN_T.top - MARGIN_T.bottom;
        const Y = (v) => py + (1 - v / yTop) * ph;

        // Horizontal gridlines with % labels.
        tctx.strokeStyle = cssVar('--grid', '#e1e0d9');
        tctx.lineWidth = 1;
        tctx.fillStyle = muted;
        tctx.textAlign = 'right';
        tctx.textBaseline = 'middle';
        for (let i = 0; i <= 4; i++) {
            const v = (yTop / 4) * i;
            const y = Y(v);
            tctx.beginPath();
            tctx.moveTo(px, y);
            tctx.lineTo(px + pw, y);
            tctx.stroke();
            tctx.fillText(Math.round(v * 100) + '%', px - 6, y);
        }

        // Baseline.
        tctx.strokeStyle = cssVar('--axis', '#c3c2b7');
        tctx.beginPath();
        tctx.moveTo(px, py + ph);
        tctx.lineTo(px + pw, py + ph);
        tctx.stroke();

        const gw = pw / names.length;
        const barW = Math.max(6, Math.min(34, gw * 0.3));
        timingGeom = { groups: [], px, pw };

        const bar = (x, share, color, pale) => {
            const y = Y(share);
            const bh = py + ph - y;
            if (bh <= 0) return;
            tctx.fillStyle = color;
            tctx.globalAlpha = pale ? 0.45 : 1;
            tctx.beginPath();
            if (tctx.roundRect) {
                // Rounded only at the data end; anchored flat to the baseline.
                tctx.roundRect(x, y, barW, bh, [3, 3, 0, 0]);
            } else {
                tctx.rect(x, y, barW, bh);
            }
            tctx.fill();
            tctx.globalAlpha = 1;
        };

        tctx.textAlign = 'center';
        tctx.textBaseline = 'top';
        names.forEach((name, i) => {
            const cx = px + gw * i + gw / 2;
            const color = timingColor(name);
            bar(cx - barW - 1, lastOf(name), color, false);
            bar(cx + 1, avgOf(name), color, true);

            let label = name;
            const fits = (t) => {
                const m = tctx.measureText && tctx.measureText(t);
                const width = m && m.width ? m.width : t.length * 6;
                return width <= gw - 6;
            };
            while (label.length > 2 && !fits(label + '…')) {
                label = label.slice(0, -1);
            }
            tctx.fillStyle = muted;
            tctx.fillText(
                label === name ? name : label + '…',
                cx,
                py + ph + 5
            );
            timingGeom.groups.push({
                x0: px + gw * i,
                x1: px + gw * (i + 1),
                name,
            });
        });
    }

    function pct(v) {
        const p = v * 100;
        return (p < 10 ? p.toFixed(1) : Math.round(p)) + '%';
    }

    timingCanvas.addEventListener('mousemove', (e) => {
        if (!timingGeom || !timing.last) {
            tooltip.style.display = 'none';
            return;
        }
        const rect = timingCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const group = timingGeom.groups.find((g) => mx >= g.x0 && mx < g.x1);
        if (!group) {
            tooltip.style.display = 'none';
            return;
        }
        const name = group.name;
        const last = timing.last;
        const lastShare =
            name === 'other' ? last.other : (last.shares[name] ?? 0);
        const avgShare = (timing.sums.get(name) || 0) / timing.steps;
        tooltip.textContent = '';
        const head = document.createElement('div');
        head.className = 't-time';
        head.textContent = name;
        tooltip.appendChild(head);
        const rows = [
            ['last step', pct(lastShare)],
            ['average', pct(avgShare)],
        ];
        const durS = last.execDeltaS !== null ? last.execDeltaS : last.rawMs / 1000;
        rows.push(['last time', fmt(lastShare * durS) + ' s']);
        for (const [label, value] of rows) {
            const row = document.createElement('div');
            row.className = 't-row';
            const sw = document.createElement('span');
            sw.className = 'legend-swatch';
            sw.style.background = timingColor(name);
            const nm = document.createElement('span');
            nm.textContent = label;
            const val = document.createElement('span');
            val.className = 't-val';
            val.textContent = value;
            row.append(sw, nm, val);
            tooltip.appendChild(row);
        }
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth;
        const x =
            e.clientX + 14 + tw > window.innerWidth
                ? e.clientX - tw - 10
                : e.clientX + 14;
        tooltip.style.left = x + 'px';
        tooltip.style.top =
            Math.min(
                e.clientY + 12,
                window.innerHeight - tooltip.offsetHeight - 8
            ) + 'px';
    });
    timingCanvas.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
    });

    new ResizeObserver(requestTimingDraw).observe(timingCanvas);

    // -------------------------------------------------------------- tooltip
    canvas.addEventListener('mousemove', (e) => {
        if (!chartGeom) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        if (mx < chartGeom.px || mx > chartGeom.px + chartGeom.pw) {
            tooltip.style.display = 'none';
            return;
        }
        const t =
            chartGeom.tMin +
            ((mx - chartGeom.px) / chartGeom.pw) *
                (chartGeom.tMax - chartGeom.tMin);
        const rows = [];
        let snapT = null;
        for (const [name, s] of visibleSeries()) {
            const p = nearestPoint(s.points, t);
            if (!p) continue;
            if (snapT === null) snapT = p.t;
            rows.push({ name, color: s.color, v: p.v });
        }
        if (rows.length === 0) {
            tooltip.style.display = 'none';
            return;
        }
        tooltip.textContent = '';
        const head = document.createElement('div');
        head.className = 't-time';
        head.textContent = 'Time = ' + trimNum(snapT);
        tooltip.appendChild(head);
        for (const r of rows) {
            const row = document.createElement('div');
            row.className = 't-row';
            const sw = document.createElement('span');
            sw.className = 'legend-swatch';
            sw.style.background = r.color;
            const nm = document.createElement('span');
            nm.textContent = r.name;
            const val = document.createElement('span');
            val.className = 't-val';
            val.textContent = fmt(r.v);
            row.append(sw, nm, val);
            tooltip.appendChild(row);
        }
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth;
        const x =
            e.clientX + 14 + tw > window.innerWidth
                ? e.clientX - tw - 10
                : e.clientX + 14;
        tooltip.style.left = x + 'px';
        tooltip.style.top =
            Math.min(e.clientY + 12, window.innerHeight - tooltip.offsetHeight - 8) +
            'px';
    });
    canvas.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
    });

    function nearestPoint(points, t) {
        if (points.length === 0) return null;
        let lo = 0,
            hi = points.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (points[mid].t < t) lo = mid;
            else hi = mid;
        }
        return Math.abs(points[lo].t - t) < Math.abs(points[hi].t - t)
            ? points[lo]
            : points[hi];
    }

    // ------------------------------------------------------------- splitter
    const splitter = document.getElementById('splitter');
    const infoPane = document.getElementById('info-pane');
    let dragging = false;
    splitter.addEventListener('mousedown', () => {
        dragging = true;
        document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const width = Math.max(
            180,
            Math.min(window.innerWidth - 220, window.innerWidth - e.clientX)
        );
        infoPane.style.flexBasis = width + 'px';
        requestDraw();
    });
    window.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            document.body.style.cursor = '';
        }
    });

    new ResizeObserver(requestDraw).observe(canvas);

    vscode.postMessage({ type: 'ready' });
})();
