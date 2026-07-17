// End-to-end test of the parametric study runner with a stubbed vscode API.
// Run: node test/study.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---- stub the vscode module before loading extension code ----------------
const vscodeStub = {
    window: {
        createOutputChannel: () => ({
            clear() {},
            show() {},
            appendLine(line) {
                if (process.env.VERBOSE) console.log('  |', line);
            },
        }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async (m) => {
            throw new Error('showErrorMessage: ' + m);
        },
        withProgress: async (_opts, task) =>
            task(
                { report() {} },
                { isCancellationRequested: false, onCancellationRequested() {} }
            ),
        showQuickPick: async () => undefined,
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key, def) => def,
        }),
        openTextDocument: async () => ({}),
    },
    ProgressLocation: { Notification: 15, Window: 10 },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...args);
};
require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: vscodeStub,
};

const { StudyRunner, parseCsv } = require('../out/parametric');

// ---- parseCsv ------------------------------------------------------------
{
    const rows = parseCsv('a, b ,name\n1,2,first\n# comment\n3,4,second\n');
    assert.deepStrictEqual(rows, [
        { a: '1', b: '2', name: 'first' },
        { a: '3', b: '4', name: 'second' },
    ]);
}

// ---- full study run ------------------------------------------------------
(async () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'foamstudy-'));
    const caseDir = path.join(tmp, 'template');
    fs.mkdirSync(path.join(caseDir, 'system'), { recursive: true });
    // Minimal fake case: controlDict with a substitution token.
    fs.writeFileSync(
        path.join(caseDir, 'system', 'controlDict'),
        'application dummy;\nendTime @endTime@;\nvalue @speed@;\n'
    );
    // Fake run script writes proof it ran with the substituted file present.
    fs.writeFileSync(
        path.join(caseDir, 'Allrun'),
        '#!/bin/sh\ngrep -q "@" system/controlDict && exit 1\ncp system/controlDict result.txt\n',
        { mode: 0o755 }
    );
    // Post script copies the result outside, then the runner deletes the case.
    fs.writeFileSync(
        path.join(caseDir, 'post.sh'),
        '#!/bin/sh\nmkdir -p "$CASE_DIR/../../results"\ncp result.txt "$CASE_DIR/../../results/$CASE_NAME.txt"\n',
        { mode: 0o755 }
    );
    fs.writeFileSync(
        path.join(caseDir, 'openfoam-case.json'),
        JSON.stringify({
            study: {
                table: [
                    { name: 'slow', speed: '5', endTime: '10' },
                    { name: 'fast', speed: '20', endTime: '30' },
                    { name: 'turbo', speed: '99', endTime: '50' },
                ],
                apply: { mode: 'substitute' },
                post: { script: 'post.sh', deleteCase: true },
                maxParallel: 2,
            },
        })
    );

    await new StudyRunner().run(caseDir);

    const results = fs
        .readdirSync(path.join(caseDir, 'results'))
        .sort();
    assert.deepStrictEqual(results, ['fast.txt', 'slow.txt', 'turbo.txt']);
    const fast = fs.readFileSync(
        path.join(caseDir, 'results', 'fast.txt'),
        'utf8'
    );
    assert.ok(fast.includes('endTime 30;'));
    assert.ok(fast.includes('value 20;'));
    // deleteCase: true → copies removed after post.
    const remaining = fs.readdirSync(path.join(caseDir, 'studyCases'));
    assert.deepStrictEqual(remaining, []);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('All study tests passed.');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
