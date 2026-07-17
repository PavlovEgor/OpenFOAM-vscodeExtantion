import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { CaseConfig, StudyConfig, loadCaseConfig, saveCaseConfig } from './config';
import { resolveScript } from './runner';

type ParamRow = Record<string, string>;

interface CaseJob {
    index: number;
    row: ParamRow;
    dir: string;
    name: string;
}

/** Parse a simple CSV (comma-separated, first row = headers, no quoting games). */
export function parseCsv(text: string): ParamRow[] {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
    if (lines.length < 2) {
        return [];
    }
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
        const values = line.split(',').map((v) => v.trim());
        const row: ParamRow = {};
        headers.forEach((h, i) => {
            row[h] = values[i] ?? '';
        });
        return row;
    });
}

function loadTable(caseDir: string, study: StudyConfig): ParamRow[] {
    if (Array.isArray(study.table)) {
        return study.table.map((row) => {
            const out: ParamRow = {};
            for (const [k, v] of Object.entries(row)) {
                out[k] = String(v);
            }
            return out;
        });
    }
    const file = path.resolve(caseDir, study.table);
    return parseCsv(fs.readFileSync(file, 'utf8'));
}

function sanitize(s: string): string {
    return s.replace(/[^A-Za-z0-9_.+\-]/g, '_');
}

function caseName(row: ParamRow, index: number): string {
    if (row.name) {
        return sanitize(row.name);
    }
    const parts = Object.entries(row)
        .slice(0, 3)
        .map(([k, v]) => `${sanitize(k)}=${sanitize(v)}`);
    return `case_${String(index).padStart(3, '0')}_${parts.join('_')}`;
}

/** Copy the template case, skipping outputs and previous study results. */
function copyCase(srcDir: string, dstDir: string, casesDirName: string): void {
    fs.mkdirSync(dstDir, { recursive: true });
    const skip = new Set([casesDirName, 'postProcessing']);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        if (/^processor\d+$/.test(entry.name)) continue;
        if (/^log\./.test(entry.name)) continue;
        const src = path.join(srcDir, entry.name);
        const dst = path.join(dstDir, entry.name);
        fs.cpSync(src, dst, { recursive: true });
    }
}

/** Replace @param@ tokens in the case's text files. */
function substituteTokens(
    caseDir: string,
    row: ParamRow,
    files?: string[]
): number {
    let replaced = 0;
    const targets: string[] = [];
    if (files && files.length > 0) {
        for (const f of files) {
            const full = path.join(caseDir, f);
            if (fs.existsSync(full)) targets.push(full);
        }
    } else {
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (!e.name.startsWith('.')) walk(full);
                } else if (e.isFile() && fs.statSync(full).size < 1_000_000) {
                    targets.push(full);
                }
            }
        };
        walk(caseDir);
    }
    for (const file of targets) {
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        if (!text.includes('@')) continue;
        let changed = false;
        for (const [key, value] of Object.entries(row)) {
            const token = `@${key}@`;
            if (text.includes(token)) {
                text = text.split(token).join(value);
                changed = true;
                replaced++;
            }
        }
        if (changed) {
            fs.writeFileSync(file, text);
        }
    }
    return replaced;
}

function paramEnv(row: ParamRow, job: CaseJob): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(row)) {
        env[`PARAM_${k.replace(/[^A-Za-z0-9_]/g, '_')}`] = v;
    }
    env.PARAMS_JSON = JSON.stringify(row);
    env.CASE_DIR = job.dir;
    env.CASE_NAME = job.name;
    env.CASE_INDEX = String(job.index);
    return env;
}

function runScript(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    logStream: fs.WriteStream,
    children: Set<ChildProcess>,
    token: vscode.CancellationToken
): Promise<number> {
    return new Promise((resolve, reject) => {
        if (token.isCancellationRequested) {
            reject(new Error('cancelled'));
            return;
        }
        const child = spawn('/bin/sh', ['-c', command], { cwd, env });
        children.add(child);
        child.stdout.pipe(logStream, { end: false });
        child.stderr.pipe(logStream, { end: false });
        child.on('error', (err) => {
            children.delete(child);
            reject(err);
        });
        child.on('close', (code) => {
            children.delete(child);
            resolve(code ?? -1);
        });
    });
}

export class StudyRunner {
    private output = vscode.window.createOutputChannel('OpenFOAM Study');
    private running = false;

    async run(caseDir: string): Promise<void> {
        if (this.running) {
            vscode.window.showWarningMessage(
                'A parametric study is already running.'
            );
            return;
        }
        const config = loadCaseConfig(caseDir);
        const study = config.study;
        if (!study) {
            const choice = await vscode.window.showWarningMessage(
                'No "study" section in openfoam-case.json.',
                'Create template'
            );
            if (choice) {
                await initStudy(caseDir);
            }
            return;
        }

        let rows: ParamRow[];
        try {
            rows = loadTable(caseDir, study);
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to read parameter table: ${err}`
            );
            return;
        }
        if (rows.length === 0) {
            vscode.window.showWarningMessage('Parameter table is empty.');
            return;
        }

        const casesDirName = study.casesDir ?? 'studyCases';
        const casesRoot = path.join(caseDir, casesDirName);
        fs.mkdirSync(casesRoot, { recursive: true });

        const defaultParallel = vscode.workspace
            .getConfiguration('openfoam')
            .get<number>('study.maxParallel', 2);
        const maxParallel = Math.max(1, study.maxParallel ?? defaultParallel);

        const runCmd =
            study.run ?? (await resolveScript(caseDir, 'run')) ?? './Allrun';

        this.running = true;
        this.output.clear();
        this.output.show(true);
        this.output.appendLine(
            `Parametric study: ${rows.length} cases, ${maxParallel} in parallel`
        );

        const children = new Set<ChildProcess>();
        let failed = 0;
        let done = 0;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'OpenFOAM parametric study',
                    cancellable: true,
                },
                async (progress, token) => {
                    token.onCancellationRequested(() => {
                        this.output.appendLine('Cancellation requested — stopping…');
                        for (const child of children) {
                            child.kill('SIGTERM');
                        }
                    });

                    const jobs: CaseJob[] = rows.map((row, i) => ({
                        index: i,
                        row,
                        name: caseName(row, i),
                        dir: path.join(casesRoot, caseName(row, i)),
                    }));

                    const queue = [...jobs];
                    const workers = Array.from(
                        { length: Math.min(maxParallel, jobs.length) },
                        async () => {
                            while (queue.length > 0 && !token.isCancellationRequested) {
                                const job = queue.shift()!;
                                try {
                                    await this.runOne(
                                        caseDir,
                                        job,
                                        study,
                                        runCmd,
                                        casesDirName,
                                        children,
                                        token
                                    );
                                } catch (err) {
                                    failed++;
                                    this.output.appendLine(
                                        `[${job.name}] FAILED: ${err}`
                                    );
                                }
                                done++;
                                progress.report({
                                    message: `${done}/${jobs.length} (${failed} failed)`,
                                    increment: 100 / jobs.length,
                                });
                            }
                        }
                    );
                    await Promise.all(workers);
                }
            );
        } finally {
            this.running = false;
        }
        this.output.appendLine(
            `Study finished: ${done} processed, ${failed} failed.`
        );
        vscode.window.showInformationMessage(
            `Parametric study finished: ${done - failed}/${done} cases succeeded.`
        );
    }

    private async runOne(
        templateDir: string,
        job: CaseJob,
        study: StudyConfig,
        runCmd: string,
        casesDirName: string,
        children: Set<ChildProcess>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const log = (msg: string) =>
            this.output.appendLine(`[${job.name}] ${msg}`);

        log(`params: ${JSON.stringify(job.row)}`);
        if (fs.existsSync(job.dir)) {
            fs.rmSync(job.dir, { recursive: true, force: true });
        }
        copyCase(templateDir, job.dir, casesDirName);
        // The study config itself is not needed inside copies.
        fs.rmSync(path.join(job.dir, 'openfoam-case.json'), { force: true });

        const logStream = fs.createWriteStream(
            path.join(job.dir, 'study-run.log')
        );
        try {
            // 1. Adapt the copy to this parameter row.
            if (study.apply.mode === 'substitute') {
                const n = substituteTokens(job.dir, job.row, study.apply.files);
                log(`substituted ${n} token occurrence(s)`);
            } else {
                const script = study.apply.script;
                if (!script) {
                    throw new Error(
                        'study.apply.mode is "script" but no apply.script given'
                    );
                }
                log(`apply: ${script}`);
                const code = await runScript(
                    toCommand(script),
                    job.dir,
                    paramEnv(job.row, job),
                    logStream,
                    children,
                    token
                );
                if (code !== 0) {
                    throw new Error(`apply script exited with ${code}`);
                }
            }

            // 2. Run the case.
            log(`run: ${runCmd}`);
            const code = await runScript(
                toCommand(runCmd),
                job.dir,
                paramEnv(job.row, job),
                logStream,
                children,
                token
            );
            if (code !== 0) {
                throw new Error(`run script exited with ${code}`);
            }
            log('run finished');

            // 3. Optional post-processing (+ case deletion to save disk).
            if (study.post?.script) {
                log(`post: ${study.post.script}`);
                const postCode = await runScript(
                    toCommand(study.post.script),
                    job.dir,
                    paramEnv(job.row, job),
                    logStream,
                    children,
                    token
                );
                if (postCode !== 0) {
                    throw new Error(`post script exited with ${postCode}`);
                }
                if (study.post.deleteCase) {
                    logStream.close();
                    fs.rmSync(job.dir, { recursive: true, force: true });
                    log('case deleted after post-processing');
                    return;
                }
            }
        } finally {
            if (!logStream.closed) {
                logStream.close();
            }
        }
    }
}

function toCommand(script: string): string {
    // Bare relative script names must be ./-prefixed for sh.
    if (!script.includes('/') && !script.includes(' ')) {
        return `./${script}`;
    }
    return script;
}

/** Create a study skeleton: sample CSV, apply script and config section. */
export async function initStudy(caseDir: string): Promise<void> {
    const csvPath = path.join(caseDir, 'study.csv');
    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(
            csvPath,
            'name,inletVelocity,endTime\nslow,5,100\nfast,20,100\n'
        );
    }
    const postPath = path.join(caseDir, 'studyPost.sh');
    if (!fs.existsSync(postPath)) {
        fs.writeFileSync(
            postPath,
            `#!/bin/sh
# Post-processing hook for a parametric-study case.
# Runs inside the finished case copy. Available environment:
#   CASE_DIR, CASE_NAME, CASE_INDEX, PARAM_<name>, PARAMS_JSON
# Save whatever you need to keep OUTSIDE the case, e.g.:
#   RESULTS_DIR="$CASE_DIR/../../studyResults"
#   mkdir -p "$RESULTS_DIR"
#   cp -r postProcessing "$RESULTS_DIR/$CASE_NAME"
exit 0
`,
            { mode: 0o755 }
        );
    }
    const config: CaseConfig = loadCaseConfig(caseDir);
    if (!config.study) {
        config.study = {
            table: 'study.csv',
            apply: { mode: 'substitute' },
            casesDir: 'studyCases',
            maxParallel: 2,
        };
        saveCaseConfig(caseDir, config);
    }
    const doc = await vscode.workspace.openTextDocument(
        path.join(caseDir, 'openfoam-case.json')
    );
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
        'Study template created: edit study.csv and put @paramName@ tokens into the case files (mode "substitute"), or switch apply.mode to "script".'
    );
}
