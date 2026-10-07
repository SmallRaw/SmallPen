# SmallPen local workspace

SmallPen is a local-file design workspace built around strict `.smallpen` directory packages. Core, CLI, Background, the Penpot frontend integration, and Desktop use the same validated package model, deterministic revision, selectors, and typed Operation Batch contract.

It does not require PostgreSQL, Valkey, MinIO, LDAP, a collaboration server, MCP, or built-in AI Chat. Review comments and approval workflow belong to an external Review product and are not Canonical Package data.

## File and session model

- One `.smallpen` directory is one independent Canonical Package with one `manifest.json` and explicitly indexed entries.
- A Product may reference exactly one same-workspace Foundation by permanent Package ID and relative path.
- Opening several packages creates several locators, sessions, and Package Tabs. It never merges files or builds a synthetic multi-root package.
- CLI calls never inherit those UI sessions: every package, selector, Context, target, and operation is explicit and no current selection survives across calls.
- Every write is a complete typed Operation Batch against `baseRevision`. The full candidate is validated before an atomic filesystem replacement.
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
- `packages/local-package/` owns local reads, atomic writes, watching, multi-package sessions, Draft import, rendering, evidence, and commit serialization.
- `packages/penpot-adapter/` maps supported completed Penpot changes to typed SmallPen Operations.
- `apps/cli/` is the complete public Agent surface and never starts Web or Background.
- `apps/background/` exposes session-scoped local HTTP services used by the Penpot adapter.
- `apps/web/` only serves a compiled `frontend/resources/public` tree, emits the Penpot workspace URL, proxies Google Fonts files and stylesheets, and handles the native open-file control route. It contains no product UI implementation.
- Web and Background bind to loopback only. They answer only `127.0.0.1`, `localhost`, or `[::1]` Host headers with their own port (`forbidden_host` otherwise), which blocks DNS rebinding. Web accepts only loopback origins on its own port; Background grants CORS to plain-HTTP loopback origins (`forbidden_origin` otherwise).
- These checks stop web pages, not local programs. There is no per-launch token: any process or other user on the same machine can read the Background URL from the Web index page and act as you. Run SmallPen only on a single-user machine.
- `frontend/src/app/main/smallpen*` is the bounded CLJS integration. Unsupported Penpot reads and writes fail explicitly rather than pretending to persist.

## Install and run

Materialize the eight local workspace links without lifecycle scripts:

```sh
cd smallpen
npm ci --ignore-scripts
```

Start the Background for one package:

```sh
node apps/background/bin/smallpen-background.mjs test/fixtures/roundtrip.smallpen
```

The process prints its session-scoped `backend` URL. Build the Penpot frontend, then serve that exact frontend tree against the Background session:

```sh
cd ../frontend
pnpm run build:app
cd ../smallpen
node apps/web/bin/smallpen-web.mjs \
  http://127.0.0.1:43127/<session-id> \
  --frontend-root ../frontend/resources/public
```

Open the emitted `frontend` URL. The root origin is always the SmallPen Home entry. Background and package-session details never appear in the address bar.

On supported browsers, **Open Package** selects a local folder and saves edits
there. Other browsers offer **Upload folder…**, which opens a copy under
`imports/` beside the App's state file. Select the folder containing
`manifest.json`; the limit is 50 MB and 2000 files. Both appear in recent
Packages. You can also enter a Package path on the SmallPen server.
Desktop opens and saves the original directory.
On macOS, if the browser disables a `.smallpen` package, select its parent
folder containing just that Package.

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
version. All four packages are configured for public access. Other workspace
packages remain private.

Build the standalone Alpha directory with `npm run build:cli`. The resulting
`dist/SmallPen-CLI` directory includes Unix and Windows launchers and all
SmallPen JavaScript modules; it requires Node.js 24 or newer on `PATH`.

Use **CI** (`.github/workflows/smallpen.yml`) in GitHub
Actions. Click **Run workflow**; there are no custom inputs. Every run builds
CLI and Desktop, then publishes npm packages after all checks pass.
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

The workflow runs shared checks, then CLI packaging and the shared frontend
build in parallel. Desktop consumes that frontend artifact and builds on its
own platform runners (macOS arm64 and Windows x64). CLI install verification
runs on Linux, macOS and Windows; npm tarballs are uploaded and published only
once, from Linux. Only after every selected platform passes can npm publication
start. Web and Linux Desktop are not enabled yet.
There is one workflow, with Test, CLI, Frontend, Desktop and Publish jobs.
The old Alpha entry and nested product workflows have been removed.
Do not rerun a historical old-workflow run to test the new pipeline: start a
new run from a branch that contains these files. GitHub's manual entry also
needs the workflow file on the repository's default branch.

Downloadable artifacts are retained for **1 day**: a standalone CLI archive
and macOS/Windows archives with SHA-256 checksums and source commit.
Frontend transfer artifacts are deleted after all consumers finish.
Npm transfer artifacts are deleted only after publication succeeds; failed
or skipped publication keeps them for 1 day so the same packages can be retried.
macOS is only ad-hoc signed; no Apple
Developer account, signing secrets, notarization or GitHub Release is required.
Desktop archives are uploaded before smoke tests, so a failed test does not
prevent downloading a build for diagnosis. An uploaded archive is not proof
that the App works: check the Desktop job result before using it.
The smoke tests launch those applications, check Home and the editor, then
verify that their local service has stopped. Startup stages, process output
and test results are uploaded only on failure and retained for 1 day; test profiles and documents
stay on the runner. A failed desktop test still blocks npm publication.

### Enable npm publication

The four public package names are `@smallpen/core`, `@smallpen/local-package`,
`@smallpen/cli`, and `smallpen`. Configure a GitHub Actions trusted publisher
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
# Alpha installs are explicit; they do not replace the stable latest tag.
npm install -g smallpen@alpha
smallpen --help

# Once a stable version is published:
npm install -g smallpen
```

If npm publication stops partway, rerun the failed job within artifact
retention. Already published versions are skipped only when their integrity
matches exactly; a mismatch stops the run before any upload. Publication
does not wait for the registry to show new versions and does not check or
move dist-tags of versions already published. Expired
artifacts require a new build. npm cannot atomically publish four packages,
so a failed run can leave some dependencies published; versions are never
overwritten or automatically unpublished.

Run `node apps/cli/bin/smallpen.mjs --help` for the object groups and shared
commands. Expand one step at a time:

```sh
smallpen help token
smallpen help token show
smallpen schema command token show --json
smallpen token show PACKAGE --token-id ID
```

Project, theme, Token, component, page, configuration, asset, media, font and
prototype flow commands use `OBJECT ACTION PACKAGE`. `view`, `export` and
`validate` are the shared design reads, exports and checks. Advanced batches,
drafts and remote library operations are under `advanced`. Previous flat
commands remain compatibility aliases, outside ordinary discovery.

The CLI's help/schema explains its operations without a Skill. The independently
installable [application design Skill](skills/README.md) supplies requirements,
design-system reuse and review rules. Run `npm run build:skills` to generate it
from `skill-src` and the CLI contract; `build:cli` also includes it. Animation
materials and character boards remain drafts for later work. See
[CLI and Skill responsibilities](docs/CLI-SKILLS.md).


`theme list` frequently reads groups/options/defaults. Unspecified groups use
project defaults; explicit `--theme GROUP/OPTION` only selects that call. The
App and CLI share those rules. CLI reads never change App selection or save a
combination. `token set` writes Tokens by name and `theme add|rename|default|
delete` edit options named `Group/Option`; no IDs or token Sets are needed.

`view` looks at anything by name (`--page`, `--component`, `--token`,
`--canvas`) as text, wireframe, PNG or issues. `export` saves a wireframe or,
with `--format png`, a PNG. Image inspection requires an image-capable caller.
`validate` checks every version of a page or variant of a component unless one
is named. Read skipped coverage.

No command takes an ID except `advanced apply` (an exact batch, such as the
undo batch a write returns; `schema operation TYPE` documents its operations)
and `project repair`. Writes use the same atomic engine and revision checks.
Choose `--batch-id` before retryable writes; reverse edits are explicit new
writes, not history rollback.

JSON is compact, with an 8 KiB stdout budget. `--full` expands data; large
results use searchable temporary files with hashes. `--stdout` permits large
stdout. Random names in one OS temporary folder prevent concurrent calls from
colliding; each call cleans recognized files older than 30 minutes. `--output`
retains deliverables outside that temporary tree.

See [CLI reference](CLI-AI-TOPIC.md) for the command groups, selectors, writes,
prototype interactions and output rules.

## Figma Draft workflow

Import always creates a new independent Draft package. Figma structured clipboard HTML is decoded from its embedded Kiwi schema; FRAME, RECTANGLE, TEXT, Component Set, Component, and Instance semantics are preserved where supported. SVG and PNG are explicit flat IMAGE fallbacks. Provenance and every known loss are stored in the Draft manifest.

```sh
node apps/cli/bin/smallpen.mjs import-draft ./workspace/import-1.smallpen \
  --kind figma --input clipboard.html --package-id pkg_figma_draft --json

node apps/cli/bin/smallpen.mjs draft-diff ./workspace/import-1.smallpen \
  --after ./workspace/import-2.smallpen --json

node apps/cli/bin/smallpen.mjs draft-compile ./workspace/product.smallpen \
  --draft ./workspace/import-2.smallpen --selections selections.json --json
```

Reimport writes another Draft file and never overwrites Product or Foundation. `draft-compile` emits, but does not apply, an Operation Batch for explicitly selected matching nodes and fields. Review that batch, then pass it to `apply`; normal stale-revision protection still applies.

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
