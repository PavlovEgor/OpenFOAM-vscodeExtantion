/**
 * Incremental parser for OpenFOAM solver logs.
 *
 * Pure module (no vscode imports) so it can be unit-tested with plain node.
 * Feed it chunks of text in order; it keeps an internal partial-line buffer
 * and emits structured events describing residuals, time steps, etc.
 */

export interface ResidualPoint {
    /** Simulation time of the step this residual belongs to. */
    time: number;
    /** First initial residual of the field within the time step. */
    initial: number;
    final: number;
    iterations: number;
}

export interface CustomMonitor {
    name: string;
    /** Regex with at least one capture group; group 1 is the value. */
    regex: string;
    /** If true and value is numeric, it is plotted as a series. */
    plot?: boolean;
}

export interface ParserState {
    /** Current simulation time (last `Time = ...` seen). */
    currentTime: number | null;
    /** Number of time steps seen so far. */
    stepCount: number;
    executionTime: number | null;
    clockTime: number | null;
    continuity: { local: number; global: number; cumulative: number } | null;
    /** Latest textual value per custom monitor. */
    monitorValues: Record<string, string>;
    finished: boolean;
    /** Fields for which a residual was already recorded in the current step. */
    seenThisStep: Set<string>;
    partialLine: string;
}

/** Timing event without a timestamp; the caller stamps arrival time. */
export interface RawTimingEvent {
    kind: 'stepStart' | 'exec' | 'marker';
    name?: string;
    simTime?: number;
    execTime?: number;
}

export interface TimingMarkerDef {
    name: string;
    regex: string;
}

export interface ParseUpdate {
    /** New residual points, keyed by field name (Ux, p, k, ...). */
    residuals: Map<string, ResidualPoint[]>;
    /** New points for numeric custom monitors, keyed by monitor name. */
    monitorSeries: Map<string, { time: number; value: number }[]>;
    /** Line-order events for wall-clock phase timing. */
    timingEvents: RawTimingEvent[];
    stateChanged: boolean;
}

const RE_TIME = /^Time = ([0-9eE+.\-]+)s?\s*$/;
const RE_SOLVE =
    /^(?:[\w:]+):\s+Solving for ([\w.:()]+), Initial residual = ([\d.eE+\-]+), Final residual = ([\d.eE+\-]+), No Iterations (\d+)/;
const RE_CONTINUITY =
    /^time step continuity errors : sum local = ([\d.eE+\-]+), global = ([\d.eE+\-]+), cumulative = ([\d.eE+\-]+)/;
const RE_EXEC = /^ExecutionTime = ([\d.eE+\-]+) s\s+ClockTime = ([\d.eE+\-]+) s/;
const RE_END = /^End$/;

export function createParserState(): ParserState {
    return {
        currentTime: null,
        stepCount: 0,
        executionTime: null,
        clockTime: null,
        continuity: null,
        monitorValues: {},
        finished: false,
        seenThisStep: new Set(),
        partialLine: '',
    };
}

export function parseChunk(
    state: ParserState,
    chunk: string,
    customMonitors: CustomMonitor[] = [],
    timingMarkers: TimingMarkerDef[] = []
): ParseUpdate {
    const update: ParseUpdate = {
        residuals: new Map(),
        monitorSeries: new Map(),
        timingEvents: [],
        stateChanged: false,
    };

    const compiledTiming: { name: string; re: RegExp }[] = [];
    for (const tm of timingMarkers) {
        try {
            compiledTiming.push({ name: tm.name, re: new RegExp(tm.regex) });
        } catch {
            // invalid user regex — skip
        }
    }

    const text = state.partialLine + chunk;
    const lines = text.split('\n');
    // Last element is either '' (chunk ended with \n) or a partial line.
    state.partialLine = lines.pop() ?? '';

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        let m = RE_TIME.exec(line);
        if (m) {
            state.currentTime = parseFloat(m[1]);
            state.stepCount++;
            state.seenThisStep.clear();
            update.timingEvents.push({
                kind: 'stepStart',
                simTime: state.currentTime,
            });
            update.stateChanged = true;
            continue;
        }

        m = RE_SOLVE.exec(line);
        if (m && state.currentTime !== null) {
            const field = m[1];
            // Every solve line is a timing marker (p may be solved several
            // times per step — all of them count towards p's time).
            update.timingEvents.push({ kind: 'marker', name: field });
            // Only the first solve of a field per step (e.g. p is solved
            // several times in SIMPLE) — standard convention for residual plots.
            if (!state.seenThisStep.has(field)) {
                state.seenThisStep.add(field);
                const point: ResidualPoint = {
                    time: state.currentTime,
                    initial: parseFloat(m[2]),
                    final: parseFloat(m[3]),
                    iterations: parseInt(m[4], 10),
                };
                if (!update.residuals.has(field)) {
                    update.residuals.set(field, []);
                }
                update.residuals.get(field)!.push(point);
                update.stateChanged = true;
            }
            continue;
        }

        m = RE_CONTINUITY.exec(line);
        if (m) {
            state.continuity = {
                local: parseFloat(m[1]),
                global: parseFloat(m[2]),
                cumulative: parseFloat(m[3]),
            };
            update.stateChanged = true;
            continue;
        }

        m = RE_EXEC.exec(line);
        if (m) {
            state.executionTime = parseFloat(m[1]);
            state.clockTime = parseFloat(m[2]);
            update.timingEvents.push({
                kind: 'exec',
                execTime: state.executionTime,
            });
            update.stateChanged = true;
            continue;
        }

        if (RE_END.test(line)) {
            state.finished = true;
            update.stateChanged = true;
            continue;
        }

        for (const tm of compiledTiming) {
            if (tm.re.test(line)) {
                update.timingEvents.push({ kind: 'marker', name: tm.name });
            }
        }

        for (const mon of customMonitors) {
            let re: RegExp;
            try {
                re = new RegExp(mon.regex);
            } catch {
                continue;
            }
            const mm = re.exec(line);
            if (mm && mm[1] !== undefined) {
                state.monitorValues[mon.name] = mm[1];
                update.stateChanged = true;
                if (mon.plot && state.currentTime !== null) {
                    const v = parseFloat(mm[1]);
                    if (isFinite(v)) {
                        if (!update.monitorSeries.has(mon.name)) {
                            update.monitorSeries.set(mon.name, []);
                        }
                        update.monitorSeries
                            .get(mon.name)!
                            .push({ time: state.currentTime, value: v });
                    }
                }
            }
        }
    }

    return update;
}
