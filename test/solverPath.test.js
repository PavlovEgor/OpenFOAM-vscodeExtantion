// Test of the explicit solverPath resolution (openfoam-case.json).
// Run: node test/solverPath.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// solverSource imports vscode — stub it before loading.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...args);
};
require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: {
        workspace: { getConfiguration: () => ({ get: () => '' }) },
        window: {},
    },
};

const { resolveExplicitSolverPath } = require('../out/solverSource');

// Under the home dir so the tilde-expansion case (6) is actually exercised.
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.solverpath-test-'));
const caseDir = path.join(tmp, 'case');
const solverDir = path.join(tmp, 'solvers', 'myFoam');
fs.mkdirSync(caseDir, { recursive: true });
fs.mkdirSync(solverDir, { recursive: true });
fs.writeFileSync(path.join(solverDir, 'createFields.C'), '');
fs.writeFileSync(path.join(solverDir, 'myFoam.C'), '');

// 1. Direct file path (absolute).
assert.strictEqual(
    resolveExplicitSolverPath(caseDir, path.join(solverDir, 'myFoam.C'), 'myFoam'),
    path.join(solverDir, 'myFoam.C')
);

// 2. Directory + application name -> <app>.C preferred.
assert.strictEqual(
    resolveExplicitSolverPath(caseDir, solverDir, 'myFoam'),
    path.join(solverDir, 'myFoam.C')
);

// 3. Directory without a matching app -> first .C file alphabetically.
assert.strictEqual(
    resolveExplicitSolverPath(caseDir, solverDir, 'otherFoam'),
    path.join(solverDir, 'createFields.C')
);

// 4. Relative to the case directory.
assert.strictEqual(
    resolveExplicitSolverPath(caseDir, '../solvers/myFoam', 'myFoam'),
    path.join(solverDir, 'myFoam.C')
);

// 5. Nonexistent path -> undefined (the command shows a warning).
assert.strictEqual(
    resolveExplicitSolverPath(caseDir, '/no/such/path', 'myFoam'),
    undefined
);

// 6. Tilde expansion.
const rel = path.relative(os.homedir(), path.join(solverDir, 'myFoam.C'));
if (!rel.startsWith('..')) {
    assert.strictEqual(
        resolveExplicitSolverPath(caseDir, '~/' + rel, 'myFoam'),
        path.join(solverDir, 'myFoam.C')
    );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All solverPath tests passed.');
