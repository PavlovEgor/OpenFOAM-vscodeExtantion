// Plain-node test of the log parser: node test/parser.test.js
const assert = require('assert');
const { createParserState, parseChunk } = require('../out/logParser');

const SAMPLE = `Time = 921

DILUPBiCGStab:  Solving for Ux, Initial residual = 0.011561, Final residual = 7.91169e-06, No Iterations 2
DILUPBiCGStab:  Solving for Uy, Initial residual = 0.0114781, Final residual = 7.79187e-06, No Iterations 2
DILUPBiCGStab:  Solving for Uz, Initial residual = 0.00119269, Final residual = 6.95708e-07, No Iterations 2
GAMG:  Solving for p, Initial residual = 0.0141443, Final residual = 1.38408e-06, No Iterations 14
GAMG:  Solving for p, Initial residual = 0.000335491, Final residual = 9.31426e-08, No Iterations 12
GAMG:  Solving for p, Initial residual = 5.39986e-05, Final residual = 5.59142e-08, No Iterations 5
time step continuity errors : sum local = 5.6109e-06, global = 1.07922e-06, cumulative = -0.00078058
DILUPBiCGStab:  Solving for epsilon, Initial residual = 0.000210451, Final residual = 2.10578e-07, No Iterations 2
DILUPBiCGStab:  Solving for k, Initial residual = 0.00520385, Final residual = 9.17771e-07, No Iterations 2
ExecutionTime = 852.91 s  ClockTime = 853 s

yPlus yPlus write:
    patch pipe y+ : min = 12.6268, max = 608.561, average = 549.672
Time = 922

DILUPBiCGStab:  Solving for Ux, Initial residual = 0.0115971, Final residual = 7.28341e-06, No Iterations 2
GAMG:  Solving for p, Initial residual = 0.0134703, Final residual = 1.10938e-06, No Iterations 13
ExecutionTime = 853.84 s  ClockTime = 854 s
`;

// 1. Whole-text parse.
{
    const state = createParserState();
    const upd = parseChunk(state, SAMPLE, [
        { name: 'y+ max', regex: 'max = (\\S+), average', plot: true },
    ]);
    assert.strictEqual(state.currentTime, 922);
    assert.strictEqual(state.stepCount, 2);
    assert.strictEqual(state.executionTime, 853.84);
    assert.strictEqual(state.clockTime, 854);
    assert.ok(Math.abs(state.continuity.cumulative - -0.00078058) < 1e-12);

    const ux = upd.residuals.get('Ux');
    assert.strictEqual(ux.length, 2);
    assert.strictEqual(ux[0].time, 921);
    assert.strictEqual(ux[0].initial, 0.011561);
    assert.strictEqual(ux[1].time, 922);

    // Only the FIRST p solve per step is recorded.
    const p = upd.residuals.get('p');
    assert.strictEqual(p.length, 2);
    assert.strictEqual(p[0].initial, 0.0141443);
    assert.strictEqual(p[1].initial, 0.0134703);

    assert.ok(upd.residuals.has('epsilon'));
    assert.ok(upd.residuals.has('k'));

    // Custom monitor scraped and plotted.
    assert.strictEqual(state.monitorValues['y+ max'], '608.561');
    const series = upd.monitorSeries.get('y+ max');
    assert.strictEqual(series.length, 1); // yPlus block appears once in SAMPLE
    assert.strictEqual(series[0].value, 608.561);
    assert.strictEqual(series[0].time, 921);
}

// 2. Chunked parse (split mid-line) must give identical results.
{
    const state = createParserState();
    const all = new Map();
    for (let i = 0; i < SAMPLE.length; i += 37) {
        const upd = parseChunk(state, SAMPLE.slice(i, i + 37));
        for (const [f, pts] of upd.residuals) {
            if (!all.has(f)) all.set(f, []);
            all.get(f).push(...pts);
        }
    }
    assert.strictEqual(state.stepCount, 2);
    assert.strictEqual(all.get('Ux').length, 2);
    assert.strictEqual(all.get('p').length, 2);
    assert.strictEqual(all.get('p')[0].initial, 0.0141443);
}

// 3. Transient-style "Time = 2e-05s" with trailing s.
{
    const state = createParserState();
    parseChunk(state, 'Time = 2e-05s\n');
    assert.strictEqual(state.currentTime, 2e-5);
}

// 4. "End" marks the run finished.
{
    const state = createParserState();
    parseChunk(state, 'Time = 1\nEnd\n');
    assert.strictEqual(state.finished, true);
}

console.log('All parser tests passed.');
