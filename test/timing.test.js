// Tests of the wall-clock timing accumulator.
// Run: node test/timing.test.js
const assert = require('assert');
const { TimingAccumulator } = require('../out/timing');

const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---- full step with calibration ------------------------------------------
{
    const acc = new TimingAccumulator(100);
    // Historical content (pre-catch-up): only the ExecutionTime trail counts.
    assert.strictEqual(
        acc.push({ kind: 'exec', execTime: 100.0, ts: 0 }),
        null
    );
    assert.strictEqual(
        acc.push({ kind: 'marker', name: 'Ux', ts: 10 }),
        null
    );
    acc.enable();

    assert.strictEqual(
        acc.push({ kind: 'stepStart', simTime: 1, ts: 1000 }),
        null
    );
    acc.push({ kind: 'marker', name: 'Ux', ts: 1100 }); // 100 ms
    acc.push({ kind: 'marker', name: 'Uy', ts: 1150 }); //  50 ms
    acc.push({ kind: 'marker', name: 'p', ts: 1300 }); // 150 ms
    acc.push({ kind: 'marker', name: 'p', ts: 1380 }); //  80 ms (second solve)
    acc.push({ kind: 'exec', execTime: 100.5, ts: 1400 });

    const st = acc.push({ kind: 'stepStart', simTime: 2, ts: 1500 });
    assert.ok(st && !st.skipped);
    assert.strictEqual(st.simTime, 1);
    assert.strictEqual(st.rawMs, 500);
    assert.ok(close(st.shares.Ux, 0.2));
    assert.ok(close(st.shares.Uy, 0.1));
    assert.ok(close(st.shares.p, 0.46)); // both p solves summed
    assert.ok(close(st.other, 0.24)); // tail incl. exec print & fn objects
    const total =
        st.shares.Ux + st.shares.Uy + st.shares.p + st.other;
    assert.ok(close(total, 1));
    assert.ok(close(st.execDeltaS, 0.5)); // calibrated by ExecutionTime delta

    // ---- too-fast step is skipped ------------------------------------
    acc.push({ kind: 'marker', name: 'Ux', ts: 1520 });
    acc.push({ kind: 'exec', execTime: 100.55, ts: 1530 });
    const st2 = acc.push({ kind: 'stepStart', simTime: 3, ts: 1540 });
    assert.ok(st2 && st2.skipped);
    assert.strictEqual(st2.rawMs, 40);

    // ---- step without an ExecutionTime line: no calibration ----------
    acc.push({ kind: 'marker', name: 'Ux', ts: 1800 });
    const st3 = acc.push({ kind: 'stepStart', simTime: 4, ts: 2040 });
    assert.ok(st3 && !st3.skipped);
    assert.strictEqual(st3.rawMs, 500);
    assert.strictEqual(st3.execDeltaS, null);
    assert.ok(close(st3.shares.Ux, 0.52)); // (1800-1540)/500
    assert.ok(close(st3.other, 0.48));
}

// ---- disable clears the in-flight step -----------------------------------
{
    const acc = new TimingAccumulator(100);
    acc.enable();
    acc.push({ kind: 'stepStart', simTime: 1, ts: 0 });
    acc.push({ kind: 'marker', name: 'Ux', ts: 200 });
    acc.disable(); // e.g. the panel was hidden / log re-read
    acc.enable();
    // A marker with no step start is ignored, not attributed.
    assert.strictEqual(acc.push({ kind: 'marker', name: 'Uy', ts: 300 }), null);
    acc.push({ kind: 'stepStart', simTime: 2, ts: 400 });
    acc.push({ kind: 'marker', name: 'p', ts: 600 });
    const st = acc.push({ kind: 'stepStart', simTime: 3, ts: 800 });
    assert.ok(st && !st.skipped);
    assert.deepStrictEqual(Object.keys(st.shares), ['p']);
    assert.ok(close(st.shares.p, 0.5));
}

// ---- burst arrival (all identical timestamps) is skipped -----------------
{
    const acc = new TimingAccumulator(100);
    acc.enable();
    acc.push({ kind: 'stepStart', simTime: 1, ts: 5000 });
    acc.push({ kind: 'marker', name: 'Ux', ts: 5000 });
    const st = acc.push({ kind: 'stepStart', simTime: 2, ts: 5000 });
    assert.ok(st && st.skipped);
}

console.log('All timing tests passed.');
