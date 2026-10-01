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

- `smallpen schema` is the self-description of every write input: operation
  types, fields, allowed values, examples, inverses, and the node, Token,
  Component Set, Instance, Presentation, Screen, Scenario, Context, batch, and
  init shapes. It is generated from the validators and its examples are tested
- unknown operation types and unknown fields fail with the allowed names and a
  suggestion; no error names `undefined` instead of the missing field; a batch
  that changes nothing reports `changed: false` and `noChange`
- `apply` remains the atomic low-level contract
- high-level page/node commands compile to the same Operation Batch; an
  INSTANCE node in a `page`/`flow` intent may carry `overrides`, which compile to
  `set-instance-override` operations in the same batch
- `init --confirm` returns the Package ids and paths, the default Screen,
  Presentation, and root node ids, and the seeded starter Tokens and Component
  Sets; `put-token`/`put-component-set` with an existing id replace it whole
- flow commands create nodes and connections using stable IDs
- Token commands create, update, bind, rename, and activate values
- `set-instance-override` / `clear-instance-override` write one field of one
  component occurrence (`overridePath` `<sourceNodeId>:<field>`, or
  `<nestedInstanceId>__<sourceNodeId>:<field>` inside a nested instance; fields
  `fills`, `name`, `opacity`, `text`, `visible`) and leave the shared definition
  alone
- every Operation Batch write (`apply`, `flow`, `page`, `token`) supports
  dry-run, explain (`--explain` returns per-operation targets plus a canonical
  before/after field diff of every changed entry), validation, and exact inverse
  output; explain and diff never write. `import-tokens` reviews by default and
  validates with `--apply --dry-run`. File imports (`import-media`,
  `import-font`) and `remove-media` validate before writing and return the exact
  inverse batch. The default reply keeps `inverseBatch` (the documented undo
  contract); `--inverse-out FILE` saves it to a file and `--compact` replaces it
  and `guidance` with a short `summary`
- repeated batch identities replay idempotently: the same batchId with the same
  baseRevision and operations returns the recorded confirmation
  (`alreadyApplied: true`) without a second write while the Package is still at
  the recorded revision; if the batch's effect was undone (the Package is back
  at its baseRevision) the retry applies it again as a new write; if later
  writes moved the Package elsewhere the retry is rejected (`batch_superseded`,
  with `committedRevision` and `currentRevision`). The same batchId with a
  different baseRevision or different operations is rejected
  (`batch_id_conflict`). `flow`, `page`, `token`, and `import-tokens` rebuild
  their batch from the current revision, so rerunning one with the same
  `--batch-id` and input after success returns `alreadyApplied: true` under the
  same rules
- hard-coded design styles return Token-reuse warnings and exact binding advice;
  raw width/height values without an exact or near (10%) Token are counted in
  `warningSummary.suppressed` instead of listed. The advice never gates a write
  and `validate` does not repeat it
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
   Localized labels follow `--locale`, else `LC_ALL`/`LC_MESSAGES`/`LANG`
   (`zh*` selects Chinese, anything else English).
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
