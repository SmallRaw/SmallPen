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
- Local Undo/Redo applies inverse Operation Batches; stale writers are rejected instead of overwriting newer work.

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
- `apps/web/` only serves a compiled `frontend/resources/public` tree, emits the Penpot workspace URL, and handles the native open-file control route. It contains no product UI implementation.
- `frontend/src/app/main/smallpen*` is the bounded CLJS integration. Unsupported Penpot reads and writes fail explicitly rather than pretending to persist.

## Install and run

Materialize the seven local workspace links without lifecycle scripts:

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

The equivalent route shape is:

```text
http://127.0.0.1:43128/#/workspace?file-id=<file-uuid>&page-id=<page-uuid>&layout=layers
```

The stable File ID resolves the Package through SmallPen's durable recent-file registry. A closed Package is reopened when the ID is known and its local locator is still available; an unknown or unavailable File ID returns to Home. A fixed local Team UUID exists only inside the Penpot compatibility adapter and is not part of the URL or SmallPen domain model.

## Native Desktop

On macOS, build one self-contained local application:

```sh
cd smallpen
npm run --workspace @smallpen/desktop build:macos
open apps/desktop/dist/SmallPen.app
```

The Alpha application has no Developer ID signature and is not notarized. Its
build uses only a certificate-free ad-hoc signature to keep the application
bundle internally valid. macOS may require the user to approve its first
launch from Privacy & Security.

The bundle contains its own Node runtime, the SmallPen Core/local adapter services, and the compiled Penpot frontend. Cocoa/WKWebView provides native windows and the file picker; every service binds to an ephemeral loopback port, remote navigation is blocked, and the child host stops with the app. No separately installed Node, database, container, collaboration service, MCP service, or web login is required.

You can also open a package directly:

```sh
apps/desktop/dist/SmallPen.app/Contents/MacOS/SmallPen ./workspace/product.smallpen
```

Cmd+O opens another independent `.smallpen` in another native window. Each window runs the original Penpot workspace components and keeps its own package-session ID. Registering the built app with macOS also enables opening `.smallpen` packages from Finder.

## CLI Agent surface

Build the standalone Alpha directory with `npm run build:cli`. The resulting
`dist/SmallPen-CLI` directory includes Unix and Windows launchers and all
SmallPen JavaScript modules; it requires Node.js 24 or newer on `PATH`.

The manually triggered `SmallPen Alpha` GitHub Actions workflow compiles the
current Penpot frontend, runs the SmallPen tests, and retains two downloadable
artifacts for 30 days: `SmallPen-CLI.tar.gz` and the unsigned
`SmallPen-macOS-arm64-unsigned.zip` application for Apple Silicon Macs.

Run `node apps/cli/bin/smallpen.mjs --help` for the full contract. Every main command supports stable JSON output and actionable errors.

```sh
# Guided Foundation + Product creation
node apps/cli/bin/smallpen.mjs init ./workspace --json

# Validate, inspect, discover, and render the same Canonical model
node apps/cli/bin/smallpen.mjs validate ./workspace/product.smallpen --json
node apps/cli/bin/smallpen.mjs read-view ./workspace/product.smallpen --json
node apps/cli/bin/smallpen.mjs discover ./workspace/product.smallpen --json
node apps/cli/bin/smallpen.mjs catalog ./workspace/product.smallpen --json
node apps/cli/bin/smallpen.mjs search-tokens ./workspace/product.smallpen --color '#6750a4' --json
node apps/cli/bin/smallpen.mjs search-components ./workspace/product.smallpen --query button --json
# AI view: PNG base64 and structure in stdout, without image files
node apps/cli/bin/smallpen.mjs inspect-view ./workspace/product.smallpen --include-image --json
# Intentional persistent export for a human review
node apps/cli/bin/smallpen.mjs evidence ./workspace/product.smallpen --output review --json

# Apply one reviewed current-revision batch atomically
node apps/cli/bin/smallpen.mjs apply ./workspace/product.smallpen --batch batch.json --json
node apps/cli/bin/smallpen.mjs repair ./workspace/product.smallpen --json
```

Other public reads include `inspect`, `list`, `read`, `compare`, `tokens`, `search-tokens`, `search-components`, `effective-token`, `explain-token`, and `render`. Public binary entries for an existing Product are `import-media` (PNG/JPEG/GIF/WebP/SVG with content-addressed blobs), `remove-media`, and `import-font` (TTF/OTF convert to WOFF; WOFF imports as-is; WOFF2 reaches an explicit conversion boundary). `library-refresh` re-fetches one declared URL Library into its verified cache, `watch` streams NDJSON revision events for local changes, and `apply --explain` previews every write with per-operation targets and a canonical before/after diff without writing. Token search includes visible Foundation Tokens, searches every finite Web/Desktop/theme Context unless one is explicit, and ranks exact or nearby color and numeric values. Component search includes complete Product and public Foundation candidates with legal variants. Write results contain non-blocking `design_token_not_used` plus an exact `recommendedBinding` when a value resolves to a Token, or `design_token_value_unmatched` when no Token resolves to the raw value and the hard-coding requires confirmation.

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

Image commands (`render`, `evidence`, `inspect-view --include-image`, and `render-matrix`) return one JSON response with bare PNG base64 by default, even without `--json`. They do not create image files, evidence JSON files, matrix directories, or temporary images unless `--output` explicitly requests an export. `render` returns the image at the top level, `evidence` and `inspect-view` use `image`, and `render-matrix` uses an ordered `images` array. `inspect-view --base64` is only needed when an explicit `--output` requests a file and the client also wants inline bytes.

The CLI `evidence` command returns a PNG and evidence from the same deterministic projection; `--output PREFIX` exports them as `PREFIX.png` and `PREFIX.json`. JSON includes the Package ID, revision/package hash, resolved selector, render hash, viewport, node-to-image regions, Semantic Tree, and renderer diagnostics. Evidence is suitable for an external Review workflow; it does not add comments or approval state to `.smallpen`.

An image-capable client should decode the current response and verify the decoded PNG's SHA-256 against `renderHash`, keeping its revision and selector attached. Base64 text is not itself visual QA. On an error, do not reuse a previous response or file; explicit exports can leave older files in place and multi-file export is not transactional. Exported files are caller-owned and are not automatically cleaned. This image-delivery contract does not disable independent remote-library package caching or prevent a caller from deliberately saving stdout.

Package reads retain the existing concurrency guard: a reusable empty sibling `.<package>.write-lock` directory remains after its temporary ownership records are released. It contains no rendered image and does not grow per preview. Inline image delivery does not bypass package locking or interrupted-commit recovery.

## Verification

Run focused SmallPen gates from this directory:

```sh
npm test
npm run pack:check
npm run test:e2e
npm run test:desktop
```

The Web E2E loads the real Penpot frontend, asserts the original workspace component surfaces, edits opacity through Penpot's layer panel, verifies the Canonical file write, and proves the workspace remains alive after persistence. The Desktop smoke builds the ad-hoc-signed Alpha app bundle, confirms the Penpot assets are embedded, launches a real package through WKWebView, and confirms clean shutdown.
