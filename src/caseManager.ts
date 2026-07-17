import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tracks OpenFOAM cases in the workspace (directories containing
 * system/controlDict) and which one is currently "active" — the one the
 * Run/Clean/Monitor buttons operate on.
 */
export class CaseManager {
    private _activeCase: string | undefined;
    private readonly _onDidChangeActiveCase = new vscode.EventEmitter<
        string | undefined
    >();
    readonly onDidChangeActiveCase = this._onDidChangeActiveCase.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        const saved = context.workspaceState.get<string>('openfoam.activeCase');
        if (saved && isCaseDir(saved)) {
            this._activeCase = saved;
        }
    }

    get activeCase(): string | undefined {
        return this._activeCase;
    }

    setActiveCase(dir: string | undefined): void {
        this._activeCase = dir;
        this.context.workspaceState.update('openfoam.activeCase', dir);
        vscode.commands.executeCommand(
            'setContext',
            'openfoam.hasCase',
            !!dir
        );
        this._onDidChangeActiveCase.fire(dir);
    }

    /** Find all case directories in the workspace. */
    async findCases(): Promise<string[]> {
        const found = await vscode.workspace.findFiles(
            '**/system/controlDict',
            '{**/node_modules/**,**/processor*/**,**/postProcessing/**}',
            200
        );
        const dirs = found
            .map((uri) => path.dirname(path.dirname(uri.fsPath)))
            .filter((d, i, arr) => arr.indexOf(d) === i)
            .sort();
        return dirs;
    }

    /**
     * Ensure there is an active case, auto-detecting or asking the user when
     * necessary. Returns undefined if the user cancelled or nothing found.
     */
    async requireActiveCase(): Promise<string | undefined> {
        if (this._activeCase && isCaseDir(this._activeCase)) {
            return this._activeCase;
        }
        const cases = await this.findCases();
        if (cases.length === 0) {
            vscode.window.showWarningMessage(
                'No OpenFOAM case found in the workspace (no system/controlDict).'
            );
            return undefined;
        }
        if (cases.length === 1) {
            this.setActiveCase(cases[0]);
            return cases[0];
        }
        return this.pickCase(cases);
    }

    async pickCase(cases?: string[]): Promise<string | undefined> {
        const all = cases ?? (await this.findCases());
        if (all.length === 0) {
            vscode.window.showWarningMessage(
                'No OpenFOAM case found in the workspace (no system/controlDict).'
            );
            return undefined;
        }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const picked = await vscode.window.showQuickPick(
            all.map((dir) => ({
                label: path.basename(dir),
                description: wsRoot ? path.relative(wsRoot, dir) : dir,
                dir,
            })),
            { placeHolder: 'Select the active OpenFOAM case' }
        );
        if (picked) {
            this.setActiveCase(picked.dir);
            return picked.dir;
        }
        return undefined;
    }
}

export function isCaseDir(dir: string): boolean {
    try {
        return fs.statSync(path.join(dir, 'system', 'controlDict')).isFile();
    } catch {
        return false;
    }
}

/** Read the `application` entry from system/controlDict. */
export function readApplication(caseDir: string): string | undefined {
    try {
        const text = fs.readFileSync(
            path.join(caseDir, 'system', 'controlDict'),
            'utf8'
        );
        const m = /^\s*application\s+([A-Za-z0-9_.]+)\s*;/m.exec(text);
        return m?.[1];
    } catch {
        return undefined;
    }
}
