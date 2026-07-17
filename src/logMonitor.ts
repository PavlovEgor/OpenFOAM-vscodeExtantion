import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
    createParserState,
    parseChunk,
    CustomMonitor,
    ParserState,
    ResidualPoint,
} from './logParser';
import { TimingAccumulator, TimingMarker, TimingStep } from './timing';

export interface MonitorSnapshot {
    logFile: string | null;
    availableLogs: string[];
    time: number | null;
    stepCount: number;
    executionTime: number | null;
    clockTime: number | null;
    continuity: { local: number; global: number; cumulative: number } | null;
    monitorValues: Record<string, string>;
    finished: boolean;
    running: boolean;
}

export interface MonitorUpdate {
    residuals: Record<string, ResidualPoint[]>;
    monitorSeries: Record<string, { time: number; value: number }[]>;
    /** Finalized wall-clock timing of steps observed live. */
    timingSteps: TimingStep[];
    snapshot: MonitorSnapshot;
    /** True when the file was reset (truncated/switched) — clear old data. */
    reset: boolean;
}

/**
 * Tails an OpenFOAM log file and turns it into chart-ready updates.
 *
 * Deliberately does no work unless started: the monitor panel starts it when
 * it becomes visible and stops it when hidden/closed, so no user resources
 * are spent reading logs nobody is looking at.
 */
export class LogMonitor extends EventEmitter {
    private state: ParserState = createParserState();
    private offset = 0;
    private watcher: fs.FSWatcher | null = null;
    private dirWatcher: fs.FSWatcher | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingResiduals = new Map<string, ResidualPoint[]>();
    private pendingMonitorSeries = new Map<
        string,
        { time: number; value: number }[]
    >();
    private pendingReset = false;
    private reading = false;
    private readAgain = false;
    private pendingTimingSteps: TimingStep[] = [];
    private readonly timing: TimingAccumulator;
    /** False while the pre-existing log content is being read in a burst. */
    private caughtUp = false;

    /** Currently followed file (absolute) or null. */
    private logFile: string | null = null;
    /** When true, automatically switch to the newest log.* file. */
    followNewest = true;

    constructor(
        private readonly caseDir: string,
        private customMonitors: CustomMonitor[],
        private readonly updateIntervalMs: number,
        private readonly pinnedLogFile?: string,
        private timingMarkers: TimingMarker[] = [],
        timingMinStepMs = 100
    ) {
        super();
        this.timing = new TimingAccumulator(timingMinStepMs);
        if (pinnedLogFile) {
            this.followNewest = false;
        }
    }

    start(): void {
        this.stop();
        const file = this.pinnedLogFile
            ? path.resolve(this.caseDir, this.pinnedLogFile)
            : this.newestLog();
        this.switchTo(file, true);
        // Watch the case dir so a new log.* appearing (fresh run) is picked up.
        try {
            this.dirWatcher = fs.watch(this.caseDir, () => {
                if (this.followNewest) {
                    const newest = this.newestLog();
                    if (newest && newest !== this.logFile) {
                        this.switchTo(newest, true);
                    }
                }
            });
        } catch {
            // case dir vanished; ignore
        }
        // fs.watch can miss appends on some filesystems (WSL, network mounts),
        // so poll as a safety net.
        this.pollTimer = setInterval(() => this.readNew(), 1000);
    }

    stop(): void {
        this.watcher?.close();
        this.watcher = null;
        this.dirWatcher?.close();
        this.dirWatcher = null;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /** Explicitly follow a different log file (user picked from dropdown). */
    selectLog(fileName: string | 'auto'): void {
        if (fileName === 'auto') {
            this.followNewest = true;
            this.switchTo(this.newestLog(), true);
        } else {
            this.followNewest = false;
            this.switchTo(path.resolve(this.caseDir, fileName), true);
        }
    }

    setCustomMonitors(monitors: CustomMonitor[]): void {
        this.customMonitors = monitors;
    }

    setTimingMarkers(markers: TimingMarker[]): void {
        this.timingMarkers = markers;
    }

    availableLogs(): string[] {
        try {
            return fs
                .readdirSync(this.caseDir)
                .filter((f) => f.startsWith('log.') || f.endsWith('.log'))
                .sort();
        } catch {
            return [];
        }
    }

    snapshot(): MonitorSnapshot {
        return {
            logFile: this.logFile ? path.basename(this.logFile) : null,
            availableLogs: this.availableLogs(),
            time: this.state.currentTime,
            stepCount: this.state.stepCount,
            executionTime: this.state.executionTime,
            clockTime: this.state.clockTime,
            continuity: this.state.continuity,
            monitorValues: this.state.monitorValues,
            finished: this.state.finished,
            running: this.isLogGrowing(),
        };
    }

    private newestLog(): string | null {
        let best: string | null = null;
        let bestTime = -1;
        for (const f of this.availableLogs()) {
            const full = path.join(this.caseDir, f);
            try {
                const mtime = fs.statSync(full).mtimeMs;
                if (mtime > bestTime) {
                    bestTime = mtime;
                    best = full;
                }
            } catch {
                // raced with deletion
            }
        }
        return best;
    }

    private switchTo(file: string | null, reset: boolean): void {
        this.watcher?.close();
        this.watcher = null;
        this.logFile = file;
        if (reset) {
            this.state = createParserState();
            this.offset = 0;
            this.pendingResiduals.clear();
            this.pendingMonitorSeries.clear();
            this.pendingReset = true;
            // The upcoming backlog read arrives in one burst — its line
            // arrival times carry no information, so timing is suspended
            // until the file is caught up with.
            this.caughtUp = false;
            this.timing.disable();
        }
        if (!file) {
            this.scheduleFlush();
            return;
        }
        try {
            this.watcher = fs.watch(file, () => this.readNew());
        } catch {
            // file may not exist yet
        }
        this.readNew();
    }

    private isLogGrowing(): boolean {
        if (!this.logFile) {
            return false;
        }
        try {
            const age = Date.now() - fs.statSync(this.logFile).mtimeMs;
            return age < 5000 && !this.state.finished;
        } catch {
            return false;
        }
    }

    private readNew(): void {
        if (!this.logFile) {
            return;
        }
        if (this.reading) {
            this.readAgain = true;
            return;
        }
        this.reading = true;
        fs.stat(this.logFile, (err, stats) => {
            if (err) {
                this.reading = false;
                return;
            }
            if (stats.size < this.offset) {
                // File truncated (case re-run) — start over.
                this.reading = false;
                this.switchTo(this.logFile, true);
                return;
            }
            if (stats.size === this.offset) {
                this.reading = false;
                this.finishRead();
                return;
            }
            const stream = fs.createReadStream(this.logFile!, {
                start: this.offset,
                end: stats.size - 1,
                encoding: 'utf8',
            });
            stream.on('data', (chunk) => {
                const arrivedAt = Date.now();
                const update = parseChunk(
                    this.state,
                    chunk as string,
                    this.customMonitors,
                    this.timingMarkers
                );
                for (const ev of update.timingEvents) {
                    const step = this.timing.push({ ...ev, ts: arrivedAt });
                    if (step) {
                        this.pendingTimingSteps.push(step);
                    }
                }
                for (const [field, points] of update.residuals) {
                    if (!this.pendingResiduals.has(field)) {
                        this.pendingResiduals.set(field, []);
                    }
                    this.pendingResiduals.get(field)!.push(...points);
                }
                for (const [name, points] of update.monitorSeries) {
                    if (!this.pendingMonitorSeries.has(name)) {
                        this.pendingMonitorSeries.set(name, []);
                    }
                    this.pendingMonitorSeries.get(name)!.push(...points);
                }
            });
            stream.on('end', () => {
                this.offset = stats.size;
                this.reading = false;
                this.scheduleFlush();
                this.finishRead();
            });
            stream.on('error', () => {
                this.reading = false;
            });
        });
    }

    private finishRead(): void {
        if (this.readAgain) {
            this.readAgain = false;
            this.readNew();
            return;
        }
        // Fully caught up with the file — line arrival times are meaningful
        // from now on, so wall-clock timing may start.
        if (!this.caughtUp) {
            this.caughtUp = true;
            this.timing.enable();
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            const update: MonitorUpdate = {
                residuals: Object.fromEntries(this.pendingResiduals),
                monitorSeries: Object.fromEntries(this.pendingMonitorSeries),
                timingSteps: [...this.pendingTimingSteps],
                snapshot: this.snapshot(),
                reset: this.pendingReset,
            };
            this.pendingResiduals.clear();
            this.pendingMonitorSeries.clear();
            this.pendingTimingSteps = [];
            this.pendingReset = false;
            this.emit('update', update);
        }, this.updateIntervalMs);
    }
}
