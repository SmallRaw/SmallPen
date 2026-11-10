# SmallPen local workspace

SmallPen is a local-file design workspace built around strict `.smallpen` directory packages. Core, CLI, Background, the Penpot frontend integration, and Desktop use the same validated package model, deterministic revision, selectors, and typed Operation Batch contract.

It does not require PostgreSQL, Valkey, MinIO, LDAP, a collaboration server, MCP, or built-in AI Chat. Review comments and approval workflow belong to an external Review product and are not Canonical Package data.

## File and session model

- One `.smallpen` directory is one independent Canonical Package: a folder of HTML files. `index.html` names it and holds theme defaults, `tokens.css` holds Tokens and theme options, `components/*.html` the components, `pages/<Module>/<Page>[.mobile|.tablet].html` the pages, and `assets/` images and fonts. [HTML-FORMAT.md](docs/HTML-FORMAT.md) specifies the format.
- Agents design by editing these files and running `smallpen check`; the App writes its edits back to the same files in their canonical form. Names are identity; a system cache keeps ids stable across renames.
- Opening several packages creates several locators, sessions, and Package Tabs. It never merges files or builds a synthetic multi-root package.
- CLI calls never inherit those UI sessions: every package, selector, Context, target, and operation is explicit and no current selection survives across calls.
- An App save is a typed Operation Batch against `baseRevision`; the candidate files are encoded and checked in memory before an atomic replacement. Agent edits go through the `check` gate: passing changes are accepted, files with errors are rejected and can be reverted.
- External valid revisions reload automatically. Invalid or incompatible state retains the last valid read-only projection and enters Repair.
- Local Undo/Redo applies inverse Operation Batches; stale writers are rejected instead of overwriting newer work. An external revision clears Undo/Redo, because its entries target content that no longer exists; the workspace shows a notice when it drops any.

## Penpot UI reuse

The product UI is the existing Penpot frontend. SmallPen does not maintain a second editor shell:

- Penpot's workspace, canvas, layers/assets/tokens sidebar, floating toolbar, and design/prototype/inspect panels render the projected `.smallpen` file.
- `frontend/src/app/main/smallpen*` supplies a local profile/team/project, projects Canonical data into Penpot file data, routes supported persistence to Background, and resolves local Media and Fonts.
- SmallPen-specific changes are capability guards and local adapters around existing components. Realtime collaboration, remote history, comments, plugins, MCP, and built-in AI Chat stay off in the local profile.
- Unsupported Canonical reads and Penpot writes fail explicitly. They are not replaced with a parallel custom UI that only looks editable.
- Multiple packages remain independent sessions. Desktop opens each package in its own native window, with the same Penpot workspace inside every window.

Those upstream Penpot features remain unchanged outside the SmallPen profile.

## Runtime boundaries

- `packages/core/` is browser-safe business logic: strict validation, dependency and Context resolution, deterministic projections, Discovery Guides, Catalog, comparisons, and Operation preparation.
- `packages/core/src/html-format/` reads and writes the HTML files: one strict parser, one class vocabulary, one encoder; `check` reports each problem with file, line and column.
- `packages/local-package/` owns local reads (text in memory, asset bytes on demand), atomic writes, watching, multi-package sessions, rendering, evidence, and commit serialization.
- `packages/penpot-adapter/` maps supported completed Penpot changes to typed SmallPen Operations.
- `apps/cli/` is the complete public Agent surface and never starts Web or Background.
- `apps/background/` exposes session-scoped local HTTP services used by the Penpot adapter.
- `apps/web/` starts the shared local services, serves the compiled frontend, proxies Google Fonts, and provides local directory browsing. Desktop uses the same host with its native file dialogs. The editor stays in the frontend.
- Web and Background bind to loopback only. They answer only `127.0.0.1`, `localhost`, or `[::1]` Host headers with their own port (`forbidden_host` otherwise), which blocks DNS rebinding. Web accepts only loopback origins on its own port; Background grants CORS to plain-HTTP loopback origins (`forbidden_origin` otherwise).
- These checks stop web pages, not local programs. There is no per-launch token: any process or other user on the same machine can read the Background URL from the Web index page and act as you. Run SmallPen only on a single-user machine.
- `frontend/src/app/main/smallpen*` is the bounded CLJS integration. Unsupported Penpot reads and writes fail explicitly rather than pretending to persist.

## Browser editor

The independent npm package is `@smallpen/web`. It includes the browser
editor and local file service; it does not install the AI CLI or Electron.
Requires Node.js 24 or newer. After publication:

```sh
npx @smallpen/web
# Or open a package directly:
npx @smallpen/web ./project.smallpen
```

The service opens your default browser. **Open Package** browses folders
on the machine running the service, and edits save to the original folder.
**New Package** creates a folder at the location you select. Browser file
permissions and uploads are not needed. Ctrl+C stops the service;
`--no-open` prints the URL without opening a browser, and `--port NUMBER`
sets a local port.

Build from source with installed frontend dependencies:

```sh
cd smallpen
npm ci --ignore-scripts
cd ../frontend
pnpm run build:app
cd ../smallpen
npm run build:web
node dist/SmallPen-Web/bin/smallpen-web.cjs
```

The build outputs a publishable npm package in `dist/SmallPen-Web`, with
compiled frontend assets and bundled runtime dependencies. To create a
local tarball:

```sh
npm pack ./dist/SmallPen-Web --ignore-scripts --pack-destination ./dist
```

The source workspace remains private; only this built distribution is
published as `@smallpen/web`. Other integrations can still use browser
folder access or upload copies through `servePenpotFrontend` without the
local directory picker.

The equivalent route shape is:

```text
http://127.0.0.1:43128/?screen=workspace&file-id=<file-uuid>&page-id=<page-uuid>&layout=layers
```

The stable File ID resolves the Package through SmallPen's durable recent-file registry. A closed Package is reopened when the ID is known and its local locator is still available; an unknown or unavailable File ID returns to Home. A fixed local Team UUID exists only inside the Penpot compatibility adapter and is not part of the URL or SmallPen domain model.

## Electron Desktop

Desktop uses one Electron entry point for macOS arm64 and Windows x64.
It shares the Penpot frontend and one local service process across windows.
There is no Swift, C#, WebView2, separate Node executable, or preload bridge.
GPU acceleration and Chromium sandboxing stay enabled.

Build on the target platform, with Node 24 and compiled frontend assets:

```sh
cd smallpen
npm ci --ignore-scripts
npm ci --ignore-scripts --workspaces=false --prefix apps/desktop/tools
npm run --workspace @smallpen/desktop build
```

**Migration status:** the shared shell, separate build-tool lockfile and CI
pipeline are present. Local dependency preflight and npm advisory checks do
not replace a complete dependency review. The Electron applications have not
yet been runtime-verified here. Treat a release as a trial until both platform
jobs pass: CI tests Home, editor startup and service shutdown before uploading.

The output is `apps/desktop/dist/SmallPen.app` on macOS or
`apps/desktop/dist/SmallPen-Windows-x64/SmallPen.exe` on Windows. Distribute
the whole Windows folder, not the executable alone. No separate Node or
WebView2 installation is required. Windows may show SmartScreen warnings;
MSI installation and Windows file associations are not included yet.
An existing output is not overwritten: move it aside or pass a new
`--output` path after `npm run --workspace @smallpen/desktop build --`.

The Alpha application has no Developer ID signature and is not notarized. Its
build uses only a certificate-free ad-hoc signature to keep the application
bundle internally valid. macOS may require the user to approve its first
launch from Privacy & Security.

Electron supplies Chromium and Node. A shared utility process hosts SmallPen
services on ephemeral loopback ports. The window code restricts navigation
and permissions. Only required application modules enter `app.asar`; frontend
assets stay outside it. Build tools never enter the application payload.
See [the runtime notes](docs/electron-runtime.md) for official sources and the
measurement plan. No measured memory, CPU or startup improvement is claimed.

You can also open a package directly:

```sh
apps/desktop/dist/SmallPen.app/Contents/MacOS/SmallPen ./workspace/product.smallpen
```

Cmd/Ctrl+O opens a package; Cmd/Ctrl+N creates one. Each package has its own
window and session. Home can become a package window. Open selects a
`.smallpen` directory; New refuses to overwrite an existing path.

## CLI Agent surface

The public npm entry package is `smallpen` (`apps/npm-cli`). Its thin launcher
delegates to `@smallpen/cli` (`apps/cli`), which owns the implementation and
Node.js runtime check. Users install with `npm install -g smallpen` and run
`smallpen --help`.

Publish in this order: `@smallpen/core`, `@smallpen/local-package`,
`@smallpen/cli`, then `smallpen`. Each package pins the exact version of the
packages it depends on; `release.mjs prepare` updates those pins with the
version. These four CLI packages are configured for public access.
`@smallpen/web` is published separately from its generated distribution.
Other workspace packages remain private.

PNG screenshots, evidence, and text measurement use the App's shared
WASM/Skia runtime and node projection. The CLI loads this library under Node;
it does not install or start the App, Electron, or a browser. There is no
separate CLI painter or fallback renderer.

Build the frontend once, including `smallpen-render`, then run
`pnpm run build:app:assets` and `pnpm run build:app:renderer` in `frontend/`
before packaging the CLI. The package includes the runtime. Packaging checks
that its kernel matches the App bundle. Tests use at most four parallel files
to bound the memory used by native rendering modules. CLI and Web share one
Linux packaging job, with one install/startup check for each product. Each
Desktop platform checks its own packaged App.
CI uses `npm run test:ci` for data, layout, text and rendering regressions plus
one complete CLI workflow. `npm test` keeps the full CLI command and help
matrix for local checks. New non-CLI regression files enter CI automatically.
The base suite does not repeat standalone release packaging or start a Web
service through npm exec. The frontend build checks translations with its
existing dependencies.

Build the standalone Alpha directory with `npm run build:cli`. The resulting
`dist/SmallPen-CLI` directory includes Unix and Windows launchers and all
SmallPen JavaScript modules; it requires Node.js 24 or newer on `PATH`.

Use **CI** (`.github/workflows/smallpen.yml`) in GitHub
Actions. Click **Run workflow**; there are no custom inputs. Every run builds
CLI, Web and Desktop. npm publication follows the CLI/Web package checks
without waiting for Desktop or Render parity.
CI reads the version from
`smallpen/package.json` and derives the npm channel: `alpha`, `beta`, `rc`,
or `latest` for a stable version. There are no version or channel inputs.
All workspace versions, internal dependencies and lock entries must agree;
CI fails before building if they differ. All products share that version and
the selected source commit.

To bump a release, run `node smallpen/scripts/release.mjs prepare VERSION CHANNEL`
from the repository root, review and commit the manifest and lock changes,
then run CI on that commit. CI never chooses a new version. Use a new version
when publishing changed package contents; npm versions cannot be overwritten.

The workflow validates committed versions before building the shared frontend
once. Test runs the data/rendering regressions and one CLI workflow. CLI and
Web share one Linux job: pack and install the CLI once, build its standalone
archive, then pack Web and check its offline install and service startup.
All five npm tarballs travel together in one artifact to Publish npm. Render
parity compares CLI, SVG and WebGL once on Linux. Desktop builds and checks
the actual macOS arm64 and Windows x64 Apps on their own runners. npm
publication depends on the CLI/Web job, which follows Frontend and Test.
Desktop and Render parity report their results independently; CI finishes
after all jobs end. Linux Desktop is not enabled yet.
Frontend, Test, CLI and Web, Render parity, Desktop on two platforms, and
Publish npm handle the builds and checks; a final cleanup job removes transfer
artifacts. Shared checks are not repeated for each operating system. The full
local test command remains available.
The old Alpha entry and nested product workflows have been removed.
Do not rerun a historical old-workflow run to test the new pipeline: start a
new run from a branch that contains these files. GitHub's manual entry also
needs the workflow file on the repository's default branch.

Downloadable artifacts are retained for **1 day**: a standalone CLI archive
and macOS/Windows archives with SHA-256 checksums and source commit.
After all checks and npm publication succeed, cleanup removes the internal
frontend and npm transfer artifacts, leaving only the three user downloads.
On branches where publication is skipped, cleanup follows the checks. Failed
or cancelled runs keep transfer artifacts for 1 day so failed jobs can reuse
the same frontend and npm packages without a full rebuild.
Render comparison images and App startup logs are uploaded only on
failure and also expire after 1 day. Already-compressed release archives use
no extra upload compression.
macOS is only ad-hoc signed; no Apple
Developer account, signing secrets, notarization or GitHub Release is required.
Desktop archives are uploaded before smoke tests, so a failed test does not
prevent downloading a build for diagnosis. An uploaded archive is not proof
that the App works: check the Desktop job result before using it.
The smoke tests launch those applications, check Home and the editor, then
verify that their local service has stopped. Startup stages, process output
and test results are uploaded only on failure and retained for 1 day; test profiles and documents
stay on the runner. A failed desktop test fails CI but does not block npm
publication.

### Enable npm publication

The five public package names are `@smallpen/core`, `@smallpen/local-package`,
`@smallpen/cli`, `smallpen`, and `@smallpen/web`. Configure a GitHub Actions trusted publisher
in **each package's npm settings**:

- Organization/user: `SmallRaw`
- Repository: `SmallPen`
- Workflow filename: `smallpen.yml`
- Environment: `npm`

Create the matching GitHub environment `npm`; configure required reviewers
and permitted release branches there. The publication job uses OIDC and
`id-token: write`, not an `NPM_TOKEN` secret or GitHub Packages. For a package
that does not exist on npm yet, bootstrap its first publication under your
own npm account before configuring its trusted publisher.

For publication, start **CI** with **Run workflow**. It publishes
the exact tested tarballs in dependency order. Stable versions use `latest`;
prerelease versions must match `alpha`, `beta` or `rc`.

```sh
# The stable version (latest tag):
npm install -g smallpen
smallpen --help

# Alpha installs are explicit; they do not replace the stable latest tag.
npm install -g smallpen@alpha
```

If npm publication stops partway, rerun the failed job within artifact
retention. Already published versions are skipped only when their integrity
matches exactly; a mismatch stops the run before any upload. Publication
does not wait for the registry to show new versions and does not check or
move dist-tags of versions already published. Expired
artifacts require a new build. npm cannot atomically publish five packages,
so a failed run can leave some dependencies published; versions are never
overwritten or automatically unpublished.

Agents read, search and edit the package files themselves. The CLI does only
what needs its parser or renderer:

```sh
smallpen init ./acme --json                       # blank package
smallpen check PACKAGE                            # after every edit; the gate
smallpen check PACKAGE --revert [--file PATH]     # put rejected files back
smallpen check PACKAGE --render [--page P]        # plus rendering checks
smallpen view PACKAGE --page P --as png|spec|wireframe
smallpen export PACKAGE --format png|html|spec ...
smallpen changes PACKAGE --since REVISION         # what people changed in the App
smallpen token list PACKAGE [--theme G/O]         # resolved Token values
```

`check` is the gate for direct edits. A passing check (or an App save) is the
accepted version, kept in the system cache. When files have errors, the
changed files that keep the package valid are accepted and the files with
errors are rejected; an error in an unchanged file is pinned on the shared
file (tokens.css, index.html, a component, an asset) whose change caused it.
`check --revert` puts the rejected files back to the accepted version and
removes rejected new files, under the package write lock; `--file PATH` limits
that to one agent's files when several agents edit one package.

A font is one TTF, OTF or WOFF file per weight/style in `assets/fonts/`,
declared with `@font-face` in `tokens.css`. App and CLI use the
same native font resource loader. Browser WOFF and native SFNT are derived
without rebuilding glyphs, in a content-keyed system cache outside the Package,
beside the history cache. The cache retains at most 128 MiB;
damaged or missing entries are rebuilt, and a cache write failure does not
prevent rendering. Opening and rendering add no font blobs and leave the design
revision unchanged. WOFF2-only imports report `unsupported_font_conversion`.

The CLI's help/schema explains its operations without a Skill. The independently
installable [application design Skill](skills/README.md) guides complete screens
and prototype flows, or reusable components and content previews. It reads the
project's specifications and supplies design-system reuse and review rules.
Find the delivered Skill with `smallpen help skills --json`. Run
`npm run build:skills` to generate it from `skill-src` and the CLI contract;
standalone and npm CLI builds include it. Animation
materials and character boards remain drafts for later work. See
[CLI and Skill responsibilities](docs/CLI-SKILLS.md).


`token list` reads resolved values and the theme groups/options. Unspecified groups use
project defaults; explicit `--theme GROUP/OPTION` only selects that call. The
App and CLI share those rules. CLI reads never change App selection or save a
combination. Tokens and options are edited in `tokens.css`; a project default
is the `data-GROUP` attribute on `index.html`'s `<html>`.

Sizes follow the App's rules in the files too: `w-[n]` or a size Token fixes
an axis, `w-full` fills a flex parent's room, and `w-fit` hugs content.

`view` looks at anything by name (`--page`, `--component`, `--token`,
`--canvas`). Three design outputs serve different tasks:

| Output | Use | Limits |
| --- | --- | --- |
| `view --as spec` / `export --format spec` | Implement authored constraints; inspect native bounds, Token/component sources, overrides and node diagnostics | Cannot prove visual quality or infer undeclared business rules |
| `view --as wireframe` / `export --format wireframe` | Understand spatial structure | Character positions are approximate; read exact values in the specification |
| `view --as png` / `export --format png` | Review high-fidelity appearance | Pixels do not expose Token bindings or fill/hug intent; inspection needs image input |

`view --as text` remains a compact navigation outline. Start implementation
with a specification of one page/component/variant, then expand an `--element`
for font, color, border and interaction details. Actual bounds come from native
App layout; authored constraints and provenance remain separate. `?`/`partial`
means geometry is unavailable, with a reason, rather than a seed rectangle.
Line counts not exposed by the native API and undeclared business rules are
explicitly unknown. Read coverage; one selected size/state does not check others.

Compare `layout.hash`, revision and selection across outputs. For an exact
shared solve, `export --format png --evidence --output REVIEW` writes
`REVIEW.png`, `REVIEW.spec.txt`, `REVIEW.wireframe.txt` and `REVIEW.json`.
The fingerprint includes native geometry, themes, dependency revisions,
rendering runtime and font/media bytes. PNG scale is independent of layout.
`check --render` checks every version of a page or variant of a component unless one
is named. It writes JSON progress lines to stderr (total, current target and
completed count), keeping the final JSON result on stdout. Each target has a
30-second limit; use `--target-timeout MILLISECONDS` to change it. A timeout
names the target and lets later targets continue. Ctrl+C returns exit code
130 with completed findings and the remaining targets in coverage. A partial
or interrupted run does not certify the untested targets. Read skipped coverage.

No command takes an ID. App saves use one atomic engine with revision checks:
they encode the design in memory, check the result, then replace only the
files that changed; files the package does not know are never deleted.

`changes` reports `historyWindow`: the oldest retained revision, newest
revision, record count and `incompleteBatches`. History and batch replay retain
the newest records within both 500 batches and 32 MiB of UTF-8 JSON; older
records leave that window. These are temporary local caches, separate from the App's
in-memory Undo/Redo stack. Cache files and recovery backups stay outside
the project, so no Git ignore configuration is needed:

- macOS: `~/Library/Caches/SmallPen/history/`
- Windows: `%LOCALAPPDATA%/SmallPen/Cache/history/`
- Linux: `$XDG_CACHE_HOME/smallpen/history/` (default `~/.cache/smallpen/history/`)

The real project path and Package ID select a private cache directory shared
by App and CLI. Copies and moved projects start separate histories. After
7 days without writes, the next cache access clears its old files. OS cache
cleanup can also discard them; read the current design when a revision has
left the window. `SMALLPEN_HISTORY_CACHE_DIR` overrides the cache root for
test environments. Every revision a read, a check or a save reports is
remembered with its files, so `changes --since` compares files however they
changed: in the App, in an editor or by an agent.

The cache stores each inverse once and reconstructs its duplicate guidance
when replaying a confirmation. The next write also compacts older records.
A single inverse exceeding 32 MiB does not block saving the design: the caller
still receives the full inverse, and the cache retains the retry receipt
without it. The write reports `history.status=partial`,
`reason=inverse_exceeds_capacity` and `replayRetained=true`. Retrying the batch
replays that receipt without writing again; it cannot recover the uncached
inverse. `changes --since` still works, because it compares remembered
revisions rather than replaying inverses. App Undo/Redo still uses the
inverse received by its current session.

Unreadable history stays recoverable as `batches.json.unreadable-UUID.bak`
inside its cache directory; reading it returns `batch_history_unavailable`.
If a design saves but history storage fails, the write reports
`history.status=unavailable` and a warning instead of silently losing tracking.

JSON is compact, with an 8 KiB stdout budget. `--full` expands data; large
results use searchable temporary files with hashes. `--stdout` permits large
stdout. Random names in one OS temporary folder prevent concurrent calls from
colliding; each call cleans recognized files older than 30 minutes. `--output`
retains deliverables outside that temporary tree.

See [CLI reference](CLI-AI-TOPIC.md) for the command groups, selectors, writes,
prototype interactions and output rules.

## Evidence

Image commands (`view --as png` and `export --format png`) return randomly
named temporary artifact paths by default.
`--output` chooses durable caller-owned files. `--base64` explicitly requests
inline PNG bytes; `--full` expands data and keeps PNG files. Only explicit
`--stdout` or `--base64` bypasses the stdout budget. Open the artifact only
when visual inspection is needed. Files live in one private folder under the Linux/macOS/Windows system temp
folder. Names use `smallpen-TIMESTAMP-UUID-KIND.ext`, with a fresh UUID per call.
Concurrent calls retain separate results. Every invocation cleans recognized CLI
files whose modification time is older than 30 minutes, skipping active calls.
Consume within 30 minutes and verify current hashes. Caller-owned exports remain
intact.
Temporary artifacts may also be removed by the OS;
use `--output` or `--inverse-out` for records that must survive cleanup.

The CLI `evidence` command returns a PNG and evidence from the same deterministic projection; `--output PREFIX` exports them as `PREFIX.png` and `PREFIX.json`. JSON includes the Package ID, revision/package hash, resolved selector, render hash, viewport, node-to-image regions, Semantic Tree, and renderer diagnostics. Evidence is suitable for an external Review workflow; it does not add comments or approval state to `.smallpen`.

Export an offline review directly from the Package's pages and declared prototype
connections:

```sh
node apps/cli/bin/smallpen.mjs export ./product.smallpen --format html \
  --canvas Pages --output ./review --json
```

Open `review/index.html` from the filesystem. The review groups pages by module,
searches names and versions, shows native PNGs, and links each page's specification,
wireframe and JSON evidence. Every page version in the selected canvas is included;
`--page NAME` includes all of that page's versions unless `--platform` selects one.
Without either selector, the Package must have exactly one canvas. `--theme` and
`--context` choose one combination for this call; export never expands all theme
combinations or changes the Package revision.

Hotspots use visible native geometry from the same solve as each page's artifacts.
Only declared click/navigation to exported page roots and previous-page actions
run. Overlays, other triggers, multiple actions on one source, targets outside the
selected scope and unavailable/hidden geometry are reported as unresolved in the
manifest; their positions or behavior are never guessed. This is a design review,
with no business input, data saving, recording or production application code.
`manifest.json` records scope, page/version/link counts, revisions, layout hashes
and artifact hashes. Output must be a new or empty directory outside source
Packages; existing files are never cleared. `index.html` is written last, so a
failed render leaves no completed review entry point.
Each page runs in an isolated native worker that is terminated before the next
page, so long reviews do not retain WASM font/shape caches across pages. JSON
progress lines go to stderr; stdout retains the final receipt. The included
project default page opens first, then declared prototype starts are the fallback.

An image-capable client should open the current artifact or decode explicitly
requested bytes and verify the PNG's SHA-256 against `renderHash`, keeping its
revision and selector attached. Base64 text is not itself visual QA. On an error,
do not reuse a previous response or file; exports can leave older files in place
and multi-file export is not transactional. Explicit exports are caller-owned.
Remote-library package caching remains independent.

Package reads retain the existing concurrency guard: a reusable empty sibling
`.<package>.write-lock` directory remains after its temporary ownership records
are released. It contains no rendered image and does not grow per preview.
Artifact and inline delivery use the same package locking and commit recovery.

Where the lock cannot be created, as on a read-only volume, reads proceed without it, and writes fail `package_not_writable` without touching the Package. An interrupted commit there still needs a writable location. A symlinked lock path fails `invalid_write_lock`.

## Verification

Run focused SmallPen gates from this directory:

```sh
npm test
npm run pack:check
npm run test:e2e
npm run test:desktop
```

The Web E2E loads the real Penpot frontend, asserts the original workspace component surfaces, edits opacity through Penpot's layer panel, verifies the Canonical file write, and proves the workspace remains alive after persistence. The Desktop smoke takes an already built Electron app (`apps/desktop/dist` by default, or a path argument), starts it once on Home and once on a copy of a real package, waits for each to report ready, and confirms that the shared service process has stopped after exit.

`--output` and `--inverse-out` must name paths outside the CLI temporary tree,
which is reserved for expiring CLI files. Windows uses the current user SID and
Windows ACLs; it requires Windows PowerShell and a temporary filesystem that
supports ACLs. Unsupported or inaccessible directories fail explicitly.
