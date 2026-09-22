# SmallPen AI CLI

## Objective

Give an AI agent a deterministic, local-first interface for reading, drawing,
editing, validating, and reviewing SmallPen designs without depending on the
Penpot UI.

## Command surfaces

### Read

- `inspect`, `list`, `read`, `discover`
- `read-view --format structure|semantic|wireframe|screenshot`
- `catalog`, `search-components`, `compare`
- `tokens`, `search-tokens`, `effective-token`, `explain-token`
- component, Token, context, flow, and impact queries
- `impact --token-id` / `impact --path` reports every bound node and field

### Write

- `apply` remains the atomic low-level contract
- high-level page/node commands compile to the same Operation Batch
- flow commands create nodes and connections using stable IDs
- Token commands create, update, bind, rename, and activate values
- every write supports dry-run, explain (`--explain` returns per-operation targets
  plus a canonical before/after field diff of every changed entry), validation,
  and exact inverse output; explain and diff never write
- repeated batch identities replay idempotently: the same batchId with the same
  operations returns the recorded confirmation (`alreadyApplied: true`) without a
  second write, while the same batchId with different operations is rejected
  (`batch_id_conflict`)
- hard-coded design styles return Token-reuse warnings and exact binding advice
- Token value advice searches every finite Context when the operation supplies no
  explicit Context and reports where each candidate resolves

### Review and preview

- deterministic PNG/evidence output
- `inspect-view --include-image` returns semantic tree, ASCII, Tokens,
  components, and an AI-readable PNG artifact in one JSON response
- image commands return bare PNG base64 in a single JSON response by default,
  without writing image files or temporary images; only explicit `--output`
  requests a file export
- decode the current response in an image-capable client, verify its PNG bytes
  against `renderHash` (SHA-256), and retain its revision and resolved selection;
  base64 text alone is not visual inspection, and errors never authorize reuse
  of an earlier file
- context matrix rendering for device, theme, language, and custom axes
- component and Token previews
- `watch <package>` is the public watch mode: NDJSON revision events for local
  external changes (`--max-events` bounds a run); rendering stays an explicit
  `render`/`evidence` call
- ASCII wireframes and semantic trees alongside screenshots

## Invariants

1. AI never writes raw Penpot data; it writes Canonical Operation Batches.
2. Every batch carries a base revision, stable batch ID, affected IDs, and an
   exact inverse batch.
3. Stale revisions return refresh/replay instructions rather than guessing.
4. Selectors are explicit and context resolution is deterministic.
5. `--json` output is the machine contract; human text is supplementary.
6. Preview output includes the resolved context, revision, and render hash.
7. Every call is self-contained: there is no current selection, current page,
   previous result, or cross-call session state.
8. Agents search Product and Foundation Tokens before writing style values;
   write-time warnings provide a deterministic backstop when they do not.

## Delivery order

1. Add high-level `page` and `flow` intent compilers.
2. Add Token CRUD, binding, and impact commands.
3. Add component/semantic query commands.
4. Add context-matrix and watch preview.
5. Add dry-run, diff, undo/redo, and end-to-end Agent fixtures.

## Acceptance

- an Agent can create a page containing nodes, Tokens, and a flowchart using
  only JSON CLI calls;
- the same design can be inspected as structure, semantic tree, ASCII, and
  PNG for every selected context;
- invalid, stale, conflicting, or unsupported changes fail atomically with a
  typed error and executable recovery instructions;
- all commands have standalone help and deterministic JSON tests.
