/**
 * Wall-clock timing of solver phases, measured from the arrival times of log
 * lines — the solver and the case are never touched.
 *
 * Model: within one time step, the interval between consecutive tracked
 * events is attributed to the later event (a "Solving for X" line is printed
 * right after X is solved, so the interval ending at it covers assembling and
 * solving X). A step spans from its "Time = ..." line to the next one, so
 * function-object output after ExecutionTime lands in "other". Shares are
 * fractions of the step span; the absolute step duration is calibrated with
 * the solver's own ExecutionTime delta when available.
 *
 * Only steps observed live are timed: events read from pre-existing log
 * content arrive in one burst and carry no timing information, so the
 * accumulator stays disabled until the monitor has caught up with the file.
 */

export interface TimingMarker {
    name: string;
    /** Regular expression; a matching log line marks the end of this phase. */
    regex: string;
}

/** Event emitted by the log parser, timestamped by the monitor on arrival. */
export interface TimingEvent {
    kind: 'stepStart' | 'exec' | 'marker';
    name?: string;
    simTime?: number;
    execTime?: number;
    ts: number;
}

export interface TimingStep {
    simTime: number | null;
    /** Fraction of the step span per tracked name (0..1). */
    shares: Record<string, number>;
    /** Fraction not attributed to any tracked marker. */
    other: number;
    /** Step span measured from line arrival times. */
    rawMs: number;
    /** Calibrated absolute duration from ExecutionTime deltas, seconds. */
    execDeltaS: number | null;
    /** True when the step was too fast for arrival times to be trusted. */
    skipped: boolean;
}

export class TimingAccumulator {
    private enabled = false;
    private stepStartTs: number | null = null;
    private stepSimTime: number | null = null;
    private lastEventTs = 0;
    private tracked = new Map<string, number>();
    private stepExecTime: number | null = null;
    private prevExecTime: number | null = null;

    constructor(private readonly minStepMs: number) {}

    /** Called once the monitor has caught up with the existing log content. */
    enable(): void {
        this.enabled = true;
        this.resetStep();
    }

    /** Called when the monitor stops or re-reads the file from scratch. */
    disable(): void {
        this.enabled = false;
        this.resetStep();
    }

    private resetStep(): void {
        this.stepStartTs = null;
        this.stepSimTime = null;
        this.tracked.clear();
        this.stepExecTime = null;
    }

    /**
     * Feed one timestamped event; returns a finalized step when this event
     * closes one (i.e. on the next step's start), null otherwise.
     */
    push(event: TimingEvent): TimingStep | null {
        if (!this.enabled) {
            // Keep the ExecutionTime trail even through historical content so
            // the first live step can be calibrated.
            if (event.kind === 'exec' && event.execTime !== undefined) {
                this.prevExecTime = event.execTime;
            }
            return null;
        }
        switch (event.kind) {
            case 'stepStart': {
                const finalized =
                    this.stepStartTs !== null ? this.finalize(event.ts) : null;
                this.stepStartTs = event.ts;
                this.stepSimTime = event.simTime ?? null;
                this.lastEventTs = event.ts;
                this.tracked.clear();
                this.stepExecTime = null;
                return finalized;
            }
            case 'marker': {
                if (this.stepStartTs === null || !event.name) {
                    // Mid-step attach: wait for a full step.
                    return null;
                }
                const dt = event.ts - this.lastEventTs;
                this.lastEventTs = event.ts;
                this.tracked.set(
                    event.name,
                    (this.tracked.get(event.name) ?? 0) + dt
                );
                return null;
            }
            case 'exec': {
                if (event.execTime === undefined) {
                    return null;
                }
                if (this.stepStartTs === null) {
                    this.prevExecTime = event.execTime;
                } else {
                    this.stepExecTime = event.execTime;
                }
                return null;
            }
        }
    }

    private finalize(endTs: number): TimingStep {
        const rawMs = endTs - this.stepStartTs!;
        const execDeltaS =
            this.stepExecTime !== null && this.prevExecTime !== null
                ? this.stepExecTime - this.prevExecTime
                : null;
        if (this.stepExecTime !== null) {
            this.prevExecTime = this.stepExecTime;
        }
        if (rawMs < this.minStepMs) {
            return {
                simTime: this.stepSimTime,
                shares: {},
                other: 0,
                rawMs,
                execDeltaS,
                skipped: true,
            };
        }
        const shares: Record<string, number> = {};
        let sum = 0;
        for (const [name, ms] of this.tracked) {
            const share = ms / rawMs;
            shares[name] = share;
            sum += share;
        }
        return {
            simTime: this.stepSimTime,
            shares,
            other: Math.max(0, 1 - sum),
            rawMs,
            execDeltaS,
            skipped: false,
        };
    }
}
