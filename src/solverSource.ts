import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readApplication } from './caseManager';
import { loadCaseConfig } from './config';

/** Locate the OpenFOAM installation directory. */
export function findProjectDir(): string | undefined {
    const configured = vscode.workspace
        .getConfiguration('openfoam')
        .get<string>('projectDir');
    if (configured && fs.existsSync(configured)) {
        return configured;
    }
    if (process.env.WM_PROJECT_DIR && fs.existsSync(process.env.WM_PROJECT_DIR)) {
        return process.env.WM_PROJECT_DIR;
    }
    // Common install locations, newest version first.
    for (const base of ['/usr/lib/openfoam', '/opt/openfoam', '/opt']) {
        try {
            const entries = fs
                .readdirSync(base)
                .filter((e) => /^openfoam[-\d.v]*\d/i.test(e))
                .sort()
                .reverse();
            for (const e of entries) {
                const dir = path.join(base, e);
                if (fs.existsSync(path.join(dir, 'applications'))) {
                    return dir;
                }
            }
        } catch {
            // base does not exist
        }
    }
    return undefined;
}

/** Breadth-first search for `<app>.C` below the given roots. */
function findSolverFile(roots: string[], app: string): string | undefined {
    const target = `${app}.C`;
    const queue = [...roots.filter((r) => fs.existsSync(r))];
    let visited = 0;
    while (queue.length > 0 && visited < 20000) {
        const dir = queue.shift()!;
        visited++;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && e.name === target) {
                return full;
            }
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'lnInclude') {
                queue.push(full);
            }
        }
    }
    return undefined;
}

/**
 * Resolve an explicit `solverPath` from openfoam-case.json to a source file.
 * Accepts a .C file or a directory; directories are searched for `<app>.C`,
 * then for any solver-looking .C file.
 */
export function resolveExplicitSolverPath(
    caseDir: string,
    solverPath: string,
    app: string | undefined
): string | undefined {
    if (solverPath === '~' || solverPath.startsWith('~/')) {
        solverPath = path.join(os.homedir(), solverPath.slice(1));
    }
    const full = path.isAbsolute(solverPath)
        ? solverPath
        : path.resolve(caseDir, solverPath);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(full);
    } catch {
        return undefined;
    }
    if (stat.isFile()) {
        return full;
    }
    if (stat.isDirectory()) {
        if (app && fs.existsSync(path.join(full, `${app}.C`))) {
            return path.join(full, `${app}.C`);
        }
        const candidates = fs
            .readdirSync(full)
            .filter((f) => f.endsWith('.C'))
            .sort();
        if (candidates.length > 0) {
            return path.join(full, candidates[0]);
        }
    }
    return undefined;
}

/**
 * The remote authority (e.g. "ssh-remote+host", "wsl+Ubuntu") of the current
 * session, taken from a workspace folder URI — the API exposes no direct
 * "full authority" property, only vscode.env.remoteName.
 */
function currentRemoteAuthority(): string | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === 'vscode-remote') {
            return folder.uri.authority;
        }
    }
    return undefined;
}

/**
 * Build a URI for the folder that stays on the machine the extension runs
 * on. Under a remote session (SSH, WSL, dev container) a plain file: URI
 * would make the new window open a *local* folder — the vscode-remote
 * scheme with the current authority keeps it on the remote host.
 */
export function folderUriForCurrentHost(
    fsPath: string,
    remoteAuthority: string | undefined = currentRemoteAuthority()
): vscode.Uri {
    if (remoteAuthority) {
        return vscode.Uri.from({
            scheme: 'vscode-remote',
            authority: remoteAuthority,
            path: fsPath,
        });
    }
    return vscode.Uri.file(fsPath);
}

/**
 * Open the solver's directory in a separate VSCode window. VSCode itself
 * deduplicates: if a window already has this folder open, that window is
 * brought to front instead of creating a new one (forceNewWindow only
 * applies when the folder is not open anywhere yet).
 */
async function openSolverWindow(sourceFile: string): Promise<void> {
    const dir = path.dirname(sourceFile);
    await vscode.commands.executeCommand(
        'vscode.openFolder',
        folderUriForCurrentHost(dir),
        { forceNewWindow: true }
    );
}

export async function openSolverSource(caseDir: string): Promise<void> {
    const app = readApplication(caseDir);

    // An explicit solverPath in openfoam-case.json wins over the automatic
    // search — the case may use a custom solver outside the installation.
    const configured = loadCaseConfig(caseDir).solverPath;
    if (configured) {
        const file = resolveExplicitSolverPath(caseDir, configured, app);
        if (!file) {
            vscode.window.showWarningMessage(
                `solverPath "${configured}" in openfoam-case.json does not point to a .C file or a directory containing one.`
            );
            return;
        }
        await openSolverWindow(file);
        return;
    }
    if (!app) {
        vscode.window.showWarningMessage(
            'Could not read the "application" entry from system/controlDict.'
        );
        return;
    }
    const projectDir = findProjectDir();
    if (!projectDir) {
        vscode.window.showWarningMessage(
            'OpenFOAM installation not found. Set "openfoam.projectDir" in settings.'
        );
        return;
    }
    const file = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: `Searching source of ${app}…`,
        },
        async () =>
            findSolverFile(
                [
                    path.join(projectDir, 'applications', 'solvers'),
                    path.join(projectDir, 'applications', 'utilities'),
                    path.join(projectDir, 'applications'),
                ],
                app
            )
    );
    if (!file) {
        vscode.window.showWarningMessage(
            `Source file ${app}.C not found under ${projectDir}/applications.`
        );
        return;
    }
    await openSolverWindow(file);
}
