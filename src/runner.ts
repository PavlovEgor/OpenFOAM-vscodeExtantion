import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadCaseConfig, updateCaseConfig } from './config';

type ScriptKind = 'run' | 'clean';

const CONVENTIONAL: Record<ScriptKind, string> = {
    run: 'Allrun',
    clean: 'Allclean',
};
const GENERATED: Record<ScriptKind, string> = {
    run: '.Allrun',
    clean: '.Allclean',
};
const CONFIG_KEY: Record<ScriptKind, 'runScript' | 'cleanScript'> = {
    run: 'runScript',
    clean: 'cleanScript',
};
const TEMPLATE_SETTING: Record<ScriptKind, string> = {
    run: 'defaultAllrun',
    clean: 'defaultAllclean',
};

/** Executable regular files in the case root (candidate run/clean scripts). */
export function findExecutables(caseDir: string): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(caseDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const result: string[] = [];
    for (const e of entries) {
        if (!e.isFile()) {
            continue;
        }
        const full = path.join(caseDir, e.name);
        try {
            fs.accessSync(full, fs.constants.X_OK);
            result.push(e.name);
        } catch {
            // not executable
        }
    }
    return result.sort();
}

/**
 * Decide which script the button should execute:
 * 1. explicit choice stored in openfoam-case.json;
 * 2. the conventional Allrun/Allclean if present;
 * 3. the only executable in the case, if there is exactly one;
 * 4. several executables -> ask the user (choice is remembered);
 * 5. nothing -> generate a hidden default script from the template setting.
 */
export async function resolveScript(
    caseDir: string,
    kind: ScriptKind
): Promise<string | undefined> {
    const config = loadCaseConfig(caseDir);
    const configured = config[CONFIG_KEY[kind]];
    if (configured && fs.existsSync(path.join(caseDir, configured))) {
        return configured;
    }

    if (fs.existsSync(path.join(caseDir, CONVENTIONAL[kind]))) {
        return CONVENTIONAL[kind];
    }

    const executables = findExecutables(caseDir).filter(
        (name) => name !== CONVENTIONAL[kind === 'run' ? 'clean' : 'run']
    );
    if (executables.length === 1) {
        return executables[0];
    }
    if (executables.length > 1) {
        return chooseScript(caseDir, kind, executables);
    }

    return generateDefaultScript(caseDir, kind);
}

/** Show a QuickPick over the case executables and remember the answer. */
export async function chooseScript(
    caseDir: string,
    kind: ScriptKind,
    executables?: string[]
): Promise<string | undefined> {
    const candidates = executables ?? findExecutables(caseDir);
    const generated = GENERATED[kind];
    if (fs.existsSync(path.join(caseDir, generated))) {
        candidates.push(generated);
    }
    if (candidates.length === 0) {
        const created = generateDefaultScript(caseDir, kind);
        if (created) {
            vscode.window.showInformationMessage(
                `No executable scripts in the case — generated default ${created}.`
            );
        }
        return created;
    }
    const picked = await vscode.window.showQuickPick(
        [...new Set(candidates)].map((name) => ({
            label: name,
            description:
                name === CONVENTIONAL[kind]
                    ? 'conventional'
                    : name === generated
                      ? 'generated default'
                      : undefined,
        })),
        {
            placeHolder: `Select the ${kind} script for ${path.basename(caseDir)} (remembered in openfoam-case.json)`,
        }
    );
    if (!picked) {
        return undefined;
    }
    updateCaseConfig(caseDir, { [CONFIG_KEY[kind]]: picked.label });
    return picked.label;
}

/** Create the hidden default script from the user-editable template setting. */
function generateDefaultScript(
    caseDir: string,
    kind: ScriptKind
): string | undefined {
    const template = vscode.workspace
        .getConfiguration('openfoam')
        .get<string>(TEMPLATE_SETTING[kind]);
    if (!template) {
        return undefined;
    }
    const name = GENERATED[kind];
    const full = path.join(caseDir, name);
    if (!fs.existsSync(full)) {
        fs.writeFileSync(full, template, { mode: 0o755 });
    }
    fs.chmodSync(full, 0o755);
    return name;
}

/**
 * Run a script of the active case in a dedicated terminal so the user can
 * watch the output. One terminal per case, reused between runs.
 */
export class CaseRunner {
    private terminals = new Map<string, vscode.Terminal>();

    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.window.onDidCloseTerminal((t) => {
                for (const [dir, term] of this.terminals) {
                    if (term === t) {
                        this.terminals.delete(dir);
                    }
                }
            })
        );
    }

    async execute(caseDir: string, kind: ScriptKind): Promise<void> {
        const script = await resolveScript(caseDir, kind);
        if (!script) {
            return;
        }
        const full = path.join(caseDir, script);
        try {
            fs.accessSync(full, fs.constants.X_OK);
        } catch {
            fs.chmodSync(full, 0o755);
        }
        const term = this.getTerminal(caseDir);
        term.show(true);
        term.sendText(`./${script}`);
    }

    /** Send Ctrl-C to the case terminal to interrupt a running script. */
    stop(caseDir: string): void {
        const term = this.terminals.get(caseDir);
        if (term) {
            term.sendText('\x03', false); // Ctrl-C
            vscode.window.showInformationMessage(
                `Sent interrupt to "${term.name}".`
            );
        } else {
            vscode.window.showInformationMessage(
                'No running OpenFOAM terminal for the active case.'
            );
        }
    }

    private getTerminal(caseDir: string): vscode.Terminal {
        let term = this.terminals.get(caseDir);
        if (!term || term.exitStatus !== undefined) {
            term = vscode.window.createTerminal({
                name: `OpenFOAM: ${path.basename(caseDir)}`,
                cwd: caseDir,
            });
            this.terminals.set(caseDir, term);
        }
        return term;
    }
}
