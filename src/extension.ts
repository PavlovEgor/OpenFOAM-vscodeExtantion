import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CaseManager } from './caseManager';
import { CaseRunner, chooseScript } from './runner';
import { MonitorPanel } from './monitorPanel';
import { openSolverSource } from './solverSource';
import { StudyRunner, initStudy } from './parametric';
import { CONFIG_FILENAME, loadCaseConfig, saveCaseConfig } from './config';
import { registerCompletion } from './completion';

export function activate(context: vscode.ExtensionContext): void {
    const cases = new CaseManager(context);
    const runner = new CaseRunner(context);
    const study = new StudyRunner();

    // ---------------------------------------------------------- status bar
    const sbCase = makeItem(100, 'openfoam.selectCase');
    const sbRun = makeItem(99, 'openfoam.runCase', '$(play) Run', 'Run OpenFOAM case');
    const sbClean = makeItem(98, 'openfoam.cleanCase', '$(clear-all) Clean', 'Clean OpenFOAM case');
    const sbMonitor = makeItem(97, 'openfoam.openMonitor', '$(graph-line) Residuals', 'Open convergence monitor');
    const sbSolver = makeItem(96, 'openfoam.openSolverSource', '$(file-code) Solver', 'Open solver source code');
    const items = [sbCase, sbRun, sbClean, sbMonitor, sbSolver];
    context.subscriptions.push(...items);

    function makeItem(
        priority: number,
        command: string,
        text?: string,
        tooltip?: string
    ): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            priority
        );
        item.command = command;
        if (text) {
            item.text = text;
        }
        if (tooltip) {
            item.tooltip = tooltip;
        }
        return item;
    }

    function refreshStatusBar(): void {
        const dir = cases.activeCase;
        if (dir) {
            sbCase.text = `$(beaker) ${path.basename(dir)}`;
            sbCase.tooltip = `Active OpenFOAM case: ${dir}\nClick to switch`;
            items.forEach((i) => i.show());
        } else {
            sbCase.text = '$(beaker) OpenFOAM';
            sbCase.tooltip = 'Select an OpenFOAM case';
            sbCase.show();
            items.slice(1).forEach((i) => i.hide());
        }
    }

    cases.onDidChangeActiveCase(refreshStatusBar);

    // Auto-detect on startup (only show buttons when a case exists).
    cases.findCases().then((found) => {
        if (!cases.activeCase && found.length === 1) {
            cases.setActiveCase(found[0]);
        }
        vscode.commands.executeCommand(
            'setContext',
            'openfoam.hasCase',
            found.length > 0
        );
        refreshStatusBar();
    });

    // ------------------------------------------------------------ commands
    const register = (
        command: string,
        handler: (...args: unknown[]) => unknown
    ) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(command, handler)
        );

    register('openfoam.selectCase', async (resource?: unknown) => {
        // Invoked from the explorer context menu with a folder URI.
        if (resource instanceof vscode.Uri) {
            const dir = resource.fsPath;
            if (fs.existsSync(path.join(dir, 'system', 'controlDict'))) {
                cases.setActiveCase(dir);
                return;
            }
            vscode.window.showWarningMessage(
                `${path.basename(dir)} has no system/controlDict — not an OpenFOAM case.`
            );
            return;
        }
        await cases.pickCase();
    });

    register('openfoam.runCase', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await runner.execute(dir, 'run');
        }
    });

    register('openfoam.cleanCase', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await runner.execute(dir, 'clean');
        }
    });

    register('openfoam.stopRun', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            runner.stop(dir);
        }
    });

    register('openfoam.chooseRunScript', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await chooseScript(dir, 'run');
        }
    });

    register('openfoam.chooseCleanScript', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await chooseScript(dir, 'clean');
        }
    });

    register('openfoam.openMonitor', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            MonitorPanel.open(context, dir);
        }
    });

    register('openfoam.openSolverSource', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await openSolverSource(dir);
        }
    });

    register('openfoam.editCaseConfig', async () => {
        const dir = await cases.requireActiveCase();
        if (!dir) {
            return;
        }
        const file = path.join(dir, CONFIG_FILENAME);
        if (!fs.existsSync(file)) {
            saveCaseConfig(dir, loadCaseConfig(dir));
        }
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
    });

    register('openfoam.study.init', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await initStudy(dir);
        }
    });

    register('openfoam.study.run', async () => {
        const dir = await cases.requireActiveCase();
        if (dir) {
            await study.run(dir);
        }
    });

    registerCompletion(context);
    refreshStatusBar();
}

export function deactivate(): void {
    // Terminals and watchers are disposed via context.subscriptions.
}
