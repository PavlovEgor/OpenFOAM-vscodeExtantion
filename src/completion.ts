import * as vscode from 'vscode';

/** Common OpenFOAM dictionary keywords offered as completions. */
const KEYWORDS: Record<string, string[]> = {
    control: [
        'application', 'startFrom', 'startTime', 'stopAt', 'endTime', 'deltaT',
        'writeControl', 'writeInterval', 'purgeWrite', 'writeFormat',
        'writePrecision', 'writeCompression', 'timeFormat', 'timePrecision',
        'runTimeModifiable', 'adjustTimeStep', 'maxCo', 'maxDeltaT', 'functions',
        'libs',
    ],
    schemes: [
        'ddtSchemes', 'gradSchemes', 'divSchemes', 'laplacianSchemes',
        'interpolationSchemes', 'snGradSchemes', 'wallDist', 'fluxRequired',
        'default', 'steadyState', 'Euler', 'backward', 'CrankNicolson',
        'localEuler', 'Gauss', 'linear', 'limitedLinear', 'linearUpwind',
        'upwind', 'LUST', 'vanLeer', 'Minmod', 'cellLimited', 'faceLimited',
        'leastSquares', 'corrected', 'limited', 'uncorrected', 'orthogonal',
        'bounded', 'meshWave',
    ],
    solution: [
        'solvers', 'solver', 'preconditioner', 'tolerance', 'relTol',
        'smoother', 'nSweeps', 'nPreSweeps', 'nPostSweeps', 'cacheAgglomeration',
        'nCellsInCoarsestLevel', 'agglomerator', 'mergeLevels', 'minIter',
        'maxIter', 'GAMG', 'PCG', 'PBiCG', 'PBiCGStab', 'smoothSolver',
        'diagonal', 'DIC', 'DILU', 'FDIC', 'GaussSeidel', 'symGaussSeidel',
        'DICGaussSeidel', 'SIMPLE', 'PISO', 'PIMPLE', 'nNonOrthogonalCorrectors',
        'nCorrectors', 'nOuterCorrectors', 'momentumPredictor',
        'consistent', 'residualControl', 'relaxationFactors', 'fields',
        'equations', 'pRefCell', 'pRefValue',
    ],
    fields: [
        'dimensions', 'internalField', 'boundaryField', 'type', 'value',
        'uniform', 'nonuniform', 'fixedValue', 'zeroGradient', 'noSlip',
        'calculated', 'inletOutlet', 'outletInlet', 'slip', 'empty',
        'symmetry', 'symmetryPlane', 'cyclic', 'cyclicAMI', 'wedge',
        'processor', 'totalPressure', 'pressureInletOutletVelocity',
        'fixedGradient', 'kqRWallFunction', 'epsilonWallFunction',
        'omegaWallFunction', 'nutkWallFunction', 'nutUWallFunction',
        'turbulentIntensityKineticEnergyInlet',
        'turbulentMixingLengthDissipationRateInlet', 'inletValue',
        'freestream', 'freestreamValue',
    ],
    misc: [
        'FoamFile', 'version', 'format', 'class', 'object', 'location', 'ascii',
        'binary', 'dictionary', 'volScalarField', 'volVectorField',
        'constant', 'system', 'RAS', 'LES', 'laminar', 'RASModel', 'LESModel',
        'simulationType', 'turbulence', 'printCoeffs', 'kEpsilon', 'kOmega',
        'kOmegaSST', 'realizableKE', 'SpalartAllmaras', 'transportModel',
        'Newtonian', 'nu', 'rho',
    ],
};

const ALL = Object.values(KEYWORDS).flat();

export function registerCompletion(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('openfoam', {
            provideCompletionItems() {
                return ALL.map((word) => {
                    const item = new vscode.CompletionItem(
                        word,
                        vscode.CompletionItemKind.Keyword
                    );
                    return item;
                });
            },
        })
    );
}
