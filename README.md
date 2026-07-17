# OpenFOAM Case Tools

A VSCode extension for comfortable work with OpenFOAM cases: one-click run and
clean, a live convergence monitor with residual plots, dictionary syntax
highlighting, jump-to-solver-source, and parametric studies.

## Features

### Status bar

When an OpenFOAM case (a folder containing `system/controlDict`) is found in
the workspace, buttons appear in the status bar:

| Button | Action |
|---|---|
| `🧪 <case name>` | pick the active case (when there are several) |
| `▶ Run` | run the case |
| `⌫ Clean` | clean the case |
| `📈 Residuals` | open the convergence monitor |
| `📄 Solver` | open the solver source code |

### Run and clean

Script resolution (identical for Run and Clean):

1. the script set in `openfoam-case.json` (`runScript` / `cleanScript`);
2. the conventional `Allrun` / `Allclean`, if present in the case;
3. the only executable file in the case root;
4. several executables — a quick-pick list (the choice is remembered);
5. nothing at all — a hidden `.Allrun` / `.Allclean` is generated from a
   template (editable via the `openfoam.defaultAllrun` /
   `openfoam.defaultAllclean` settings).

The script runs in a VSCode terminal whose working directory is the case.
Interrupt it with **OpenFOAM: Stop Run** (sends Ctrl-C).

### Convergence monitor

**OpenFOAM: Open Convergence Monitor** opens a panel split into two panes:
the left one plots initial residuals (log scale) for every field
(Ux, Uy, Uz, p, k, epsilon, …); the right one shows a textual summary —
current Time, step count, ExecutionTime/ClockTime, continuity errors and the
last residual of each field.

- The log is read **only while the panel is open and visible** — no resources
  are wasted otherwise.
- By default the newest `log.*` file is followed; pick a specific file from
  the dropdown or pin one in the config (`logFile`).
- A checkbox next to each field in the info pane (or a click on the legend)
  hides/shows its series; hovering the chart shows values at the cursor.
- If `system/fvSolution` defines `residualControl` (either the SIMPLE scalar
  form `p 1e-2;` or the PIMPLE dictionary form with `tolerance`), each
  criterion is drawn as a dashed line in the color of its field. The pattern
  `U` covers `Ux/Uy/Uz`; quoted regex patterns like `"(k|epsilon)"` are
  supported. Criteria can be switched off globally with the "Show on chart"
  checkbox or individually in the "residualControl criteria" block. When the
  case defines no `residualControl`, nothing is drawn and the block is hidden.
- Custom values can be scraped from the log via `openfoam-case.json`:

```json
{
    "monitors": [
        {
            "name": "Courant max",
            "regex": "Courant Number mean: \\S+ max: (\\S+)",
            "plot": true
        }
    ]
}
```

`regex` is a regular expression with one capture group; the value is shown in
the info pane, and with `"plot": true` (when numeric) it is also plotted.

### Case config — `openfoam-case.json`

Created with **OpenFOAM: Edit Case Config** in the case root. All paths are
relative to the case unless absolute. A JSON schema is attached, so VSCode
validates the file and offers completions.

| Field | Meaning |
|---|---|
| `runScript` / `cleanScript` | scripts behind the Run / Clean buttons |
| `logFile` | log file the monitor follows (default: newest `log.*`) |
| `solverPath` | explicit solver source for the Solver button (see below) |
| `monitors` | extra values scraped from the log |
| `study` | parametric study definition |

### Jump to solver source

**OpenFOAM: Open Solver Source Code** reads the `application` entry from
`system/controlDict`, locates the solver sources in the OpenFOAM installation
(searched under `$WM_PROJECT_DIR/applications`; the installation path can be
overridden with the `openfoam.projectDir` setting) and opens the solver's
directory **in a separate VSCode window**. If a window with that folder is
already open, it is brought to front instead of opening a duplicate.

Remote sessions (Remote-SSH, WSL, dev containers) are supported: the new
window opens the folder on the same host the case lives on, not on the local
machine.

If the case uses a **custom solver** (or the automatic search picks the wrong
one), set `solverPath` in `openfoam-case.json` — it takes priority over the
automatic search:

```json
{
    "solverPath": "~/solvers/myPisoFoam/myPisoFoam.C"
}
```

`solverPath` may be:

- a path to the `.C` file itself, or
- a directory — then `<application>.C` is preferred, falling back to the
  first `.C` file inside;
- absolute or relative to the case directory.

### Parametric studies

1. **OpenFOAM: Create Parametric Study Template** creates `study.csv`,
   `studyPost.sh` and a `study` section in the config.
2. The parameter table is a CSV file (first row — parameter names; a `name`
   column sets the case name) or an inline array of objects in the JSON.
3. How a case copy is adapted to one parameter row:
   - `"mode": "substitute"` — every `@paramName@` token in the copied case
     files is replaced with the row value (e.g. `endTime @endTime@;` in
     `controlDict`);
   - `"mode": "script"` — your script runs inside the copy; parameters are
     available as `PARAM_<name>`, `PARAMS_JSON`, `CASE_DIR`, `CASE_NAME`,
     `CASE_INDEX` environment variables.
4. **OpenFOAM: Run Parametric Study** creates the copies in `studyCases/`,
   runs them concurrently (`maxParallel`), reports progress in the
   "OpenFOAM Study" output channel and can be cancelled from the notification.
5. Optional post-processing: `study.post.script` runs inside each finished
   case; with `"deleteCase": true` the copy is removed after successful
   post-processing — for large sweeps that do not fit on disk.

Example:

```json
{
    "study": {
        "table": "study.csv",
        "apply": { "mode": "substitute" },
        "post": { "script": "studyPost.sh", "deleteCase": false },
        "casesDir": "studyCases",
        "maxParallel": 4
    }
}
```

### Highlighting and completion

OpenFOAM dictionaries (`controlDict`, `fvSchemes`, files under `0/`,
`system/`, `constant/`, …) get syntax highlighting: keywords, boundary
condition types, schemes, linear solvers, dimension sets `[0 2 -2 0 0 0 0]`,
`$macros` and `#include` directives. Completion is offered for common
keywords.

## Building and installing

```bash
npm install
npm run compile        # or npm run watch during development
# debug: press F5 (Extension Development Host)
# package:
npx @vscode/vsce package --no-dependencies
code --install-extension openfoam-case-tools-<version>.vsix
```

After installing a new version of the extension, reload the VSCode window
(**Developer: Reload Window**).

## Tests

Plain-node tests, no VSCode instance required:

```bash
node test/parser.test.js       # solver log parser
node test/fvSolution.test.js   # residualControl extraction
node test/solverPath.test.js   # explicit solverPath resolution
node test/webview.test.js      # monitor webview smoke test (fake DOM)
node test/study.test.js        # parametric study engine (stubbed vscode API)
```
