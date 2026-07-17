import * as fs from 'fs';
import * as path from 'path';
import { CustomMonitor } from './logParser';

/** Per-case settings, stored as `openfoam-case.json` in the case root. */
export interface CaseConfig {
    /** Relative path of the script the Run button executes. */
    runScript?: string;
    /** Relative path of the script the Clean button executes. */
    cleanScript?: string;
    /**
     * Log file the convergence monitor follows (relative to the case).
     * When omitted, the newest `log.*` file is followed automatically.
     */
    logFile?: string;
    /** Extra values scraped from the log and shown/plotted in the monitor. */
    monitors?: CustomMonitor[];
    study?: StudyConfig;
}

export interface StudyConfig {
    /**
     * Parameter table: path to a CSV file (first row = parameter names)
     * or an inline array of objects.
     */
    table: string | Record<string, string | number>[];
    /** How a copied case is adapted to one parameter row. */
    apply: {
        /**
         * "substitute": every `@name@` token in case text files is replaced
         * with the row value. "script": `script` is executed inside the copy
         * with parameters exported as PARAM_<NAME> env vars.
         */
        mode: 'substitute' | 'script';
        script?: string;
        /** Restrict substitution to these relative files (globs not needed). */
        files?: string[];
    };
    /** Script run in each case copy; defaults to the case run script. */
    run?: string;
    /** Optional post-processing performed after a case finishes. */
    post?: {
        script: string;
        /** Delete the case copy after successful post-processing. */
        deleteCase?: boolean;
    };
    /** Directory (relative to the case) where copies are created. */
    casesDir?: string;
    maxParallel?: number;
}

export const CONFIG_FILENAME = 'openfoam-case.json';

export function loadCaseConfig(caseDir: string): CaseConfig {
    const file = path.join(caseDir, CONFIG_FILENAME);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as CaseConfig;
    } catch {
        return {};
    }
}

export function saveCaseConfig(caseDir: string, config: CaseConfig): void {
    const file = path.join(caseDir, CONFIG_FILENAME);
    fs.writeFileSync(file, JSON.stringify(config, null, 4) + '\n');
}

export function updateCaseConfig(
    caseDir: string,
    patch: Partial<CaseConfig>
): CaseConfig {
    const config = { ...loadCaseConfig(caseDir), ...patch };
    saveCaseConfig(caseDir, config);
    return config;
}
