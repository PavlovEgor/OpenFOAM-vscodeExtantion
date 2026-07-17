import * as vscode from 'vscode';
import * as path from 'path';
import { LogMonitor } from './logMonitor';
import { loadCaseConfig } from './config';

/**
 * The convergence monitor: a webview split into a residual chart pane and a
 * textual info pane. Log tailing runs only while the panel is visible.
 */
export class MonitorPanel {
    private static panels = new Map<string, MonitorPanel>();

    static open(context: vscode.ExtensionContext, caseDir: string): void {
        const existing = MonitorPanel.panels.get(caseDir);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        MonitorPanel.panels.set(
            caseDir,
            new MonitorPanel(context, caseDir)
        );
    }

    private readonly panel: vscode.WebviewPanel;
    private monitor: LogMonitor | null = null;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly caseDir: string
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'openfoamMonitor',
            `Residuals: ${path.basename(caseDir)}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                ],
            }
        );
        this.panel.webview.html = this.html();

        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'ready') {
                this.startMonitor();
            } else if (msg.type === 'selectLog') {
                this.monitor?.selectLog(msg.file);
            }
        });

        // Core resource-saving behaviour: tail the log only while visible.
        this.panel.onDidChangeViewState(() => {
            if (this.panel.visible) {
                this.startMonitor();
            } else {
                this.monitor?.stop();
            }
        });

        this.panel.onDidDispose(() => {
            this.monitor?.stop();
            this.monitor = null;
            MonitorPanel.panels.delete(caseDir);
        });
    }

    private startMonitor(): void {
        const config = loadCaseConfig(this.caseDir);
        const interval = vscode.workspace
            .getConfiguration('openfoam')
            .get<number>('monitor.updateIntervalMs', 500);
        if (!this.monitor) {
            this.monitor = new LogMonitor(
                this.caseDir,
                config.monitors ?? [],
                interval,
                config.logFile
            );
            this.monitor.on('update', (update) => {
                this.panel.webview.postMessage({ type: 'update', update });
            });
        } else {
            this.monitor.setCustomMonitors(config.monitors ?? []);
        }
        this.monitor.start();
    }

    private html(): string {
        const webview = this.panel.webview;
        const js = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monitor.js')
        );
        const css = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monitor.css')
        );
        const nonce = Math.random().toString(36).slice(2);
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>OpenFOAM Residuals</title>
</head>
<body>
<div id="layout">
    <div id="chart-pane">
        <div id="chart-header">
            <span id="chart-title">Initial residuals</span>
            <span id="legend"></span>
        </div>
        <canvas id="chart"></canvas>
    </div>
    <div id="splitter"></div>
    <div id="info-pane">
        <div class="info-block">
            <div class="info-row"><span>Log</span>
                <select id="log-select"><option value="auto">auto (newest)</option></select>
            </div>
            <div class="info-row"><span>Status</span><b id="status">—</b></div>
            <div class="info-row"><span>Time</span><b id="time">—</b></div>
            <div class="info-row"><span>Steps parsed</span><b id="steps">—</b></div>
            <div class="info-row"><span>ExecutionTime</span><b id="exec">—</b></div>
            <div class="info-row"><span>ClockTime</span><b id="clock">—</b></div>
        </div>
        <div class="info-block">
            <h3>Continuity errors</h3>
            <div class="info-row"><span>sum local</span><b id="cont-local">—</b></div>
            <div class="info-row"><span>global</span><b id="cont-global">—</b></div>
            <div class="info-row"><span>cumulative</span><b id="cont-cum">—</b></div>
        </div>
        <div class="info-block">
            <h3>Last initial residuals</h3>
            <div id="residual-list"></div>
        </div>
        <div class="info-block" id="monitors-block" hidden>
            <h3>Custom monitors</h3>
            <div id="monitor-list"></div>
        </div>
        <p class="hint">Add custom values via <code>monitors</code> in
        <code>openfoam-case.json</code>: <code>{"name": "Courant max",
        "regex": "Courant Number mean: \\\\S+ max: (\\\\S+)", "plot": true}</code></p>
    </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
