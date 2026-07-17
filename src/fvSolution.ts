/**
 * Extraction of residualControl convergence criteria from system/fvSolution.
 * Pure module (no vscode imports) so it can be unit-tested with plain node.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ResidualControl {
    /** Field name or OpenFOAM regex pattern, e.g. "p" or "(k|epsilon|omega)". */
    pattern: string;
    tolerance: number;
}

function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

/** Return the content between the '{' at `openIndex` and its matching '}'. */
function balancedBlock(text: string, openIndex: number): string | null {
    if (text[openIndex] !== '{') {
        return null;
    }
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        if (text[i] === '{') {
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(openIndex + 1, i);
            }
        }
    }
    return null;
}

/**
 * Parse every residualControl block found in the given fvSolution text.
 * Supports both forms:
 *   residualControl { p 1e-2; "(k|epsilon)" 1e-3; }               (SIMPLE)
 *   residualControl { U { tolerance 1e-5; relTol 0; } }           (PIMPLE)
 */
export function parseResidualControls(text: string): ResidualControl[] {
    const clean = stripComments(text);
    const out: ResidualControl[] = [];
    const re = /\bresidualControl\s*(\{)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
        const block = balancedBlock(clean, m.index + m[0].length - 1);
        if (block !== null) {
            parseEntries(block, out);
        }
    }
    return out;
}

function parseEntries(block: string, out: ResidualControl[]): void {
    let i = 0;
    const n = block.length;
    const skipWs = () => {
        while (i < n && /\s/.test(block[i])) i++;
    };
    while (i < n) {
        skipWs();
        if (i >= n) break;
        // Key: quoted regex or bare word.
        let key: string;
        if (block[i] === '"') {
            const end = block.indexOf('"', i + 1);
            if (end < 0) break;
            key = block.slice(i + 1, end);
            i = end + 1;
        } else {
            const start = i;
            while (i < n && !/[\s{};"]/.test(block[i])) i++;
            key = block.slice(start, i);
            if (!key) {
                i++;
                continue;
            }
        }
        skipWs();
        if (block[i] === '{') {
            // Dictionary form: take its "tolerance" entry.
            const sub = balancedBlock(block, i);
            if (sub === null) break;
            i += sub.length + 2;
            const tm = /\btolerance\s+([\d.eE+\-]+)\s*;/.exec(sub);
            if (tm) {
                const tol = parseFloat(tm[1]);
                if (isFinite(tol)) {
                    out.push({ pattern: key, tolerance: tol });
                }
            }
        } else {
            // Scalar form: value up to ';'.
            const end = block.indexOf(';', i);
            if (end < 0) break;
            const tol = parseFloat(block.slice(i, end).trim());
            i = end + 1;
            if (isFinite(tol)) {
                out.push({ pattern: key, tolerance: tol });
            }
        }
    }
}

/**
 * Find the control matching a residual field name from the log (Ux, p, k...).
 * A pattern matches by exact name, as an anchored regex, or against the base
 * name of a vector component (pattern "U" matches Ux/Uy/Uz).
 */
export function matchControl(
    field: string,
    controls: ResidualControl[]
): ResidualControl | null {
    for (const c of controls) {
        if (c.pattern === field) {
            return c;
        }
        if (/[xyz]$/.test(field) && c.pattern === field.slice(0, -1)) {
            return c;
        }
        try {
            if (new RegExp(`^(?:${c.pattern})$`).test(field)) {
                return c;
            }
        } catch {
            // pattern is not a valid JS regex — ignore
        }
    }
    return null;
}

/** Read residualControl criteria of a case; [] when none are defined. */
export function readResidualControls(caseDir: string): ResidualControl[] {
    try {
        const text = fs.readFileSync(
            path.join(caseDir, 'system', 'fvSolution'),
            'utf8'
        );
        return parseResidualControls(text);
    } catch {
        return [];
    }
}
