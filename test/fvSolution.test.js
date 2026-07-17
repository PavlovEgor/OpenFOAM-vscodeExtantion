// Plain-node test: node test/fvSolution.test.js
const assert = require('assert');
const fs = require('fs');
const { parseResidualControls, matchControl } = require('../out/fvSolution');

// 1. SIMPLE scalar form with a quoted regex pattern (pitzDaily style).
{
    const text = `
SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent      yes;

    residualControl
    {
        p               1e-2;
        U               1e-3;
        "(k|epsilon|omega|f|v2)" 1e-3;
    }
}
`;
    const controls = parseResidualControls(text);
    assert.strictEqual(controls.length, 3);
    assert.deepStrictEqual(controls[0], { pattern: 'p', tolerance: 0.01 });
    assert.deepStrictEqual(controls[1], { pattern: 'U', tolerance: 0.001 });
    assert.strictEqual(controls[2].pattern, '(k|epsilon|omega|f|v2)');

    // Matching: exact, vector component, regex, and a miss.
    assert.strictEqual(matchControl('p', controls).tolerance, 0.01);
    assert.strictEqual(matchControl('Ux', controls).tolerance, 0.001);
    assert.strictEqual(matchControl('Uz', controls).tolerance, 0.001);
    assert.strictEqual(matchControl('epsilon', controls).tolerance, 0.001);
    assert.strictEqual(matchControl('T', controls), null);
    assert.strictEqual(matchControl('p_rgh', controls), null);
}

// 2. PIMPLE dictionary form (tolerance/relTol).
{
    const text = `
PIMPLE
{
    residualControl
    {
        U
        {
            tolerance   1e-5;
            relTol      0;
        }
        "(p|p_rgh)"
        {
            tolerance   5e-4;
            relTol      0;
        }
    }
}
`;
    const controls = parseResidualControls(text);
    assert.strictEqual(controls.length, 2);
    assert.deepStrictEqual(controls[0], { pattern: 'U', tolerance: 1e-5 });
    assert.strictEqual(matchControl('p_rgh', controls).tolerance, 5e-4);
}

// 3. No residualControl at all -> empty (nothing gets drawn).
{
    const controls = parseResidualControls(
        'SIMPLE\n{\n    nNonOrthogonalCorrectors 0;\n}\n'
    );
    assert.deepStrictEqual(controls, []);
}

// 4. Comments must not confuse the parser.
{
    const text = `
SIMPLE
{
    // residualControl { p 999; }
    /* residualControl { U 999; } */
    residualControl
    {
        p 1e-4; // target
    }
}
`;
    const controls = parseResidualControls(text);
    assert.deepStrictEqual(controls, [{ pattern: 'p', tolerance: 1e-4 }]);
}

// 5. The real pitzDaily fvSolution from the local OpenFOAM installation.
{
    const file =
        '/usr/lib/openfoam/openfoam2412/tutorials/incompressible/simpleFoam/pitzDaily/system/fvSolution';
    if (fs.existsSync(file)) {
        const controls = parseResidualControls(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(controls.length, 3);
        assert.strictEqual(matchControl('Ux', controls).tolerance, 1e-3);
        assert.strictEqual(matchControl('k', controls).tolerance, 1e-3);
    }
}

console.log('All fvSolution tests passed.');
