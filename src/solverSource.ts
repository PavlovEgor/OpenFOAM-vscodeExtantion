import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readApplication } from './caseManager';

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

export async function openSolverSource(caseDir: string): Promise<void> {
    const app = readApplication(caseDir);
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
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false });
    // Open the solver directory in the explorer sidebar is intrusive;
    // instead surface the path so the user can explore siblings (createFields.H etc).
    vscode.window.setStatusBarMessage(
        `Solver source: ${path.dirname(file)}`,
        8000
    );
}
