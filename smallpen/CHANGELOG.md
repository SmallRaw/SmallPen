# Changelog

## Unreleased

### Work by name
- Theme options are named `Group/Option` everywhere, as in Token values:
  `theme add --theme Viewport/Desktop --theme Viewport/Mobile` adds options
  (a new group's first option is its default), and `theme rename`,
  `theme default` and `theme delete` take the same names. `theme list`
  shows option names; IDs and token Sets need `--full`. The JSON-intent
  `theme create/update/delete` and `token create/update` actions are gone.
- `token delete --path NAME` and `token show|explain --path NAME` work by
  Token name.
- `token set` creates or changes many Tokens in one call by path: `value`
  applies wherever no option has its own value, `values` set named
  `Group/Option`s. The CLI picks the token Set; agents never name one.
  `token list` rows list the values that differ under other options;
  `--type` filters. `theme list` and `token list` show token Sets only
  with `--full`.
- `component define` builds a whole component from a base element tree,
  properties and per-variant changes. `page draw` draws a page, or one
  container, from named elements and component instances, with a module
  prefix and a platform. Values in braces bind Tokens; sizes take numbers,
  `fill`/`100%` or `hug`; the CLI measures text and keeps element IDs and
  interactions across redraws. An instance with a longer label grows.
- `flow link --from "Page / Element" --to Page` and `flow start --page Page`
  set prototype links without IDs.
- `view` outlines list flex children in the order they appear.
- Every remaining edit has a name-based form: `page rename|delete` (with
  `--element` for one element, `--platform` for one version),
  `component rename|delete` (`--element` renames an element in every
  variant, `--variant` deletes one), `flow list`, `flow unlink`,
  `flow start --remove`, `asset set|delete --color|--typography`,
  `media delete --media` and `font delete --font`.
- The CLI no longer takes IDs. Removed: `read`, `project show`,
  `component show`, `component-edit`, `page show|create|add|update`, the
  `config` group, `flow show|update|delete|test`, `asset create|update`,
  `render`, `evidence`, `render-matrix`, `inspect-view`, `read-view`,
  `compare`, `discover`, `remove-media`, and every `--screen-id`,
  `--component-id`, `--variant-id`, `--node-id`, `--token-id`, `--asset-id`,
  `--media-id`, `--font-id` and `--scenario-id` option. `export` and
  `validate` name their target as `view` does (`--page`, `--platform`,
  `--element`, `--component`, `--variant`); `validate` checks every version
  or variant unless one is named. `advanced apply` (undo batches) and
  `project repair` keep theirs. IDs stay inside the package and the App.
- Names never repeat. Sibling elements, pages, components (Foundation and
  Library ones included), canvases, theme options and colors each keep
  their own name. A rename (CLI or App) or an App copy that takes a used
  page, component, canvas or sibling element name is numbered, as a copied
  folder is ("Card 2"); the reply lists it under `renamed` and the App shows
  the new name. Two siblings given one name in an intent fail with
  `duplicate_name`.
- Only grouped commands run (plus `view`, `changes`, `export`, `validate`,
  `help`, `schema`, `version`). Old flat names such as `apply`, `inspect`,
  `list` or `catalog` fail with `unknown_command` and name their grouped
  path (`advanced apply`, `project show`, `project list`, `component list`).
  `project show` reads the package name, revision and counts.
- Replies leave IDs out: no `id`, `packageId`, `screenId`, `nodeId`,
  `affectedIds` and the like unless `--full` is passed. `token impact`
  names pages, components and elements; diagnostics name elements;
  `component search` lists variants as `State=idle` and always gives a
  `page draw` element to place the component. Unnamed elements
  are numbered ("Hi", "Hi 2"). Names an older file repeats show in
  `validate` and `view --as issues`; `"Tasks / List [2]"` picks one to
  rename.
- A Foundation cannot delete a component or Token that a Product next to
  it still uses (`used_elsewhere` lists where).
- A page that other pages link to cannot be deleted until its links are
  removed.

### Look at anything by name, learn what changed
- `view` takes names: nothing for the whole package, `--tokens` or
  `--token PREFIX`, `--components` or `--component NAME` (every variant)
  with `--variant "Style=secondary"` and `--element NAME`, `--pages` or
  `--page NAME` with `--platform` and `--element`. `--as text|wireframe|
  png|issues` picks the form. Outlines and issues name elements instead of
  showing node IDs (`--full` shows them); unknown names fail with the names
  that exist. Preview limits become one note instead of many issues.
- `changes PACKAGE --since REVISION` lists, by name, what changed after a
  revision: themes, Tokens with old and new values, component variants and
  elements, page elements and links, and who made each edit (app or cli).
  It leaves out what auto layout decides (a flex child's place, a filled
  or hugging size), and its recent-edit list names only real design
  changes, so the App's theme switch or text re-measure lists none.
  It also lists canvases added, renamed or removed, pages put on another
  canvas, a business flow's new page order, links added or removed by
  element, and pages that became or stopped being a start.
  It rebuilds the earlier revision from the batch history, so edits made in
  the App reach the agent. Without `--since` it lists recent edits.
  Changes inside a placed component copy name the element, the variant
  (`Style=primary → Style=secondary`) and the values; a value that followed
  a Token shows the Token's name (`Label text text.task.new → "Add task"`).
- `component define` measures text per variant; a smaller variant no longer
  shrinks the label box of the others.
- The design system page shows a Token once when every theme gives it the
  same value, and can draw a part: only Tokens, only components, or every
  variant of one component.
- The "inside a component" note no longer appears on issues outside
  components.

### The App and the CLI share one Token binding
- Every attribute a Token applies to in the App is a binding the CLI reads
  and writes, from one table (`token-attributes.mjs`): fill, stroke color
  and width, each corner (`radiusTopLeft` ... or all as `cornerRadius`),
  width, height, min/max width and height, padding, margin, gaps, font
  family, size and weight, letter spacing, line height, text case, text
  decoration, typography, opacity, rotation, shadow and x/y. Before, only
  padding, gaps, shadow and stroke color crossed over; a fill or radius
  Token applied in the App was a bare name the CLI read as a literal value.
- Tokens applied in the App are stored as bindings; names an older App
  stored still bind by name. Bindings the CLI writes show as applied Tokens
  in the App's design panel.
- `page draw` and `component define` take `radius` as one value or four
  corners, `margin`, `minWidth`/`maxWidth`/`minHeight`/`maxHeight`,
  `letterSpacing`, `textTransform`, `textDecoration`, and Tokens for
  `lineHeight` and `rotation`.

### Pages share a canvas, laid out by business flow
- Every page now sits on one canvas by default, because Penpot links and
  prototype flows only reach boards on the same page. The CLI lays it out:
  each business flow (module) is a block of rows, one row per platform,
  pages left to right in flow order (from the flow start along its links),
  a page's versions lined up in one column, more room between flows. No
  board ever overlaps another; nobody sets canvas coordinates.
- Canvases are explicit when someone splits them: `page draw` takes
  `canvas`, `canvas put --page P --canvas C` moves a page, `canvas rename`,
  `canvas list`, and `view --canvas NAME --as text|wireframe|png|issues`.
  `page move --page P --direction left|right` reorders a page in its flow.
  The manifest stores them as `canvases` (`put-canvases`).
- In the App a canvas is one Penpot page holding all its boards. Dragging a
  board reorders its flow; adding, renaming, moving and deleting a Penpot
  page adds, renames, moves and deletes a canvas (deleting removes the pages
  on it, as Penpot does). A shape dropped outside every board belongs to the
  nearest board. Drawing a new top-level board and copying a whole canvas in
  the App are refused with a message to use the CLI.

### The CLI places elements
- In a container without auto layout, `page draw` places children so they
  do not overlap: unplaced ones stack with the container's gap, `place`
  puts one next to a sibling (`"below Header"`, `{rightOf: "Sidebar",
  gap: 24}`), and x/y only pins one.
- `page move --element NAME --direction up|down|left|right [--steps N]`
  rearranges by direction: in auto layout it changes the order; otherwise
  the element swaps places with its neighbour on that side, keeping the
  gap. The agent never computes coordinates.

### Copies, stroke sides and one translation layer
- A placed copy overrides what Penpot lets a copy change: fill, stroke,
  text and its style, width and height, radius, shadow, opacity, name and
  visibility, plus its own Token bindings and a nested copy's variant. In
  `page draw`, `set: {"Label.fontSize": 18, "stroke": "{color.accent}",
  "Icon.props": {"Size": "lg"}}`; a Token value is the copy's own binding.
  A Token applied to a copy's child in the App is the same binding; editing
  that value by hand drops it. The earlier `textToken`/`visibleToken`
  overrides are folded into the one `tokenBindings` override.
- A stroke can have a width per side (`widthTop` ... `widthLeft`, Penpot's
  per-side stroke width), each bindable (`strokeWidthTop` ...); `page draw`
  takes `"stroke": {"width": [top, right, bottom, left]}` and PNGs draw it.
- The App translates no binding itself: the Background sends each node's
  applied Tokens, computed by core from the one table the adapter also
  uses, and the App's capability list is generated from core
  (`npm run build:web-capabilities`, checked by a test).

### Strings and flags are Tokens
- A node's text can bind a `string` Token and its visibility a `boolean`
  Token, so UI text lives in a Language theme group like any other Token
  value and an element can show or hide per option. Penpot stores these
  types but applies them to no layer; SmallPen resolves them in every
  projection, the App included.
- `page draw` and `component define` bind them with `"text":
  "{text.path}"` and `"visible": "{flag.path}"`; an instance label takes
  `"text": {"Label": "{text.path}"}` (stored as a `textToken` override).
  A Token of the wrong type fails before writing.
- Editing bound text or visibility in the App keeps the person's value and
  drops that one binding, as Penpot does for other Token attributes.
- `token export [--type string] [--by Language] [--format json|flat]`
  writes one file per option for application code.
- Text the fonts cannot draw (a language without glyphs) is now an issue
  (`text_missing_glyphs`) that says to import a covering font.
- A language the bundled Latin font cannot draw, such as Chinese, is the
  project's choice of font: import one into the package with `font import`
  and use it with the new `fontFamily` element field, by name or through a
  font-family Token (`"fontFamily": "{font.family.base}"`). Text no font
  can draw is a `text_missing_glyphs` issue until then.
- Page and element names with Chinese or other non-ASCII letters get
  distinct, stable IDs (a short hash of the name) instead of colliding.

### Text reviews that say what each thing is
- `view` outlines name components and write variants as Property=value.
  Copies of one component share a line that lists only what differs, and
  visual values left unbound show as `literal`. Token sources list path and
  value only (`--full` adds references), so a page outline fits in stdout.
- `view --component-id` starts with the component's properties and what
  each one changes, then the main variant's structure.
- `validate` tolerates sub-pixel line-height rounding, checks text contrast
  against the paint right under the text, names where each issue is, and
  reports a problem inside a component once with its copies counted.
- `view` and `validate` hint when a platform's Presentation is checked
  without that platform's theme option, or uses another platform's variant.
  Hints are not issues. `help rules platforms` explains themes, Platform
  variants and Presentations.
- Write reminders name only the Token equal to a literal value.

### One Design System page for the CLI and the editor
- SmallPen core now lays out the generated Design System page
  (`design-system-page.mjs`). The Background serves the page tree with its
  data, and the editor draws that tree, so the page in Penpot and
  `smallpen render --design-system` match.
- The page reads top to bottom: Tokens, then components. It shows every
  Token once. Each color family is a headed row of rounded swatches per
  theme, and small families share a line. Typography is set at its own size,
  largest first. Spacing shows as solid bars, and radius, borders and shadows
  sit three to a row. Component cards caption their axes once, label each
  sample by what differs, and span more columns when they hold many samples.
  Columns are added as content grows.
- A Product's page also shows the Foundation Component Sets its Screens
  use. They are read-only there: an edit is refused with
  `foundation_components_read_only`, as Foundation Tokens already were.
- `render --design-system [--locale en|zh_cn|zh_hant]` renders the page to
  PNG. The help tells agents to check tokens and components with it rather
  than drawing a specimen Screen.
- The editor fetches the page data it was missing since the data moved to
  `/v1/design-system-refs`, so the page is no longer empty.
- Home: the recent Package list scrolls, and each card shows the end of its
  path, so copies with the same name can be told apart.

## 0.1.0-alpha.6 (2026-10-02)

A blind AI built a full design system (66 tokens, 11 component sets, six
screens, light and dark) with the CLI, and the result was compared pixel by
pixel with the Penpot editor. This release closes the gaps it found; CLI
renders and Penpot now differ by under 1% per screen in both themes, apart
from text antialiasing.

### Themes use token sets and themes (ADR 0005)
- Themes now use one mechanism, Penpot's token sets and themes, the same model
  as Penpot's token manager, Tokens Studio and DTCG `$themes`. New operations
  `put-token-set`, `put-set-token`, `put-token-theme`, `delete-token-set` and
  `delete-token-theme` have exact inverses.
- `--theme GROUP/NAME` selects themes for one read on render, evidence,
  inspect-view, tokens, search-tokens and the other token reads; scenarios
  may store themes. `search-tokens` reports which themes it searched and
  accepts `--all-themes`.
- `init` now creates one self-contained Package by default; `--layout
  foundation-product` keeps the linked pair. Theme answers create sets and
  themes. A Product selects its Foundation's themes by id and layers its own
  sets on top (see `docs/TOKEN-THEMES.md`).
- `contextValues` on tokens and theme-kind Context axes still load but warn
  as deprecated. `smallpen migrate-themes <package> --output <path>` upgrades
  a Package or linked pair by copy; on the test design system every screen
  renders byte-identical before and after.
- In Penpot, a Product's token manager and Design System page show the
  Foundation's sets and themes read-only, theme switching saves the Product's
  selection with exact undo, and edits of Foundation tokens are refused with
  a clear message.

### Rendering and Penpot fidelity
- Shadows have one shape (`offsetX`, `offsetY`, `blur`, `spread`, `color`);
  `{x, y}` writes are refused with a suggested fix, and older packages still
  load. The CLI honours offsets and spread, blurs like CSS, clips shadows,
  draws every shadow, and antialiases rectangle and ellipse edges.
- Penpot's SVG drop-shadow filter lost its `result` and `in2` attributes, so
  shadows rendered twice as dark and only the first one drew; this upstream
  bug is fixed in `ui/shapes/filters.cljs`.
- Instances without fills no longer get a white background in Penpot;
  shadows from packages appear in Penpot; nested boards no longer become
  separate View mode screens.
- Opening a Package or its Design System page no longer writes, and no empty
  commits are sent. A Foundation library now loads in its Product, so its
  components appear in Assets and can be dropped.

### Native Penpot variants
- Component Sets with axes appear in Penpot as native variant containers:
  axes are variant properties, and copies show property dropdowns.
- Switching a copy's variant saves as `select-instance-variant` and keeps
  the overrides that still apply. Adding, deleting, reordering and
  combining variants, adding or renaming properties and changing values
  save by rebuilding the Component Set from the edited state, with exact
  undo; results the format cannot hold are refused with a translated
  message.
- Resizing a copy saves; children follow Penpot's constraint rules.
- A Foundation value rename is followed by open dependent Products in their
  own undoable batch. A Product whose instance selects a missing variant
  still opens: the instance draws the closest variant, and the Product
  enters Repair with `smallpen repair --action select-instance-variant`.

### Fixes from the blind test
- The CLI renders curve and arc path commands, Penpot's seven stroke caps at
  their stroke-scaled sizes, dash patterns, stroke alignment, and constraint
  and flex placement for resized copies, all matching Penpot.
- `lineHeight` is always a multiple of font size; Figma imports convert pixel
  and percent line heights and letter spacing.
- A token whose path collides with another token or group is refused; a
  write that would orphan an instance is refused, and `validate` lists stale
  instances.
- Errors state the received value and the allowed values; schema and help
  document variant node types, node ids, shadows, line height, caps, dashes
  and constraints.
- Repair conflicts point at the right screen when node ids repeat.

## 0.1.0-alpha.5 (2026-10-02)

0.1.0-alpha.4 was prepared but never published; its changes ship here.

Rebased onto upstream Penpot `develop` (8b2ec216e). This release is a
review and hardening pass; the Package format is unchanged.

### Penpot integration
- Upstream behaviour is unchanged outside SmallPen: view mode shows nested
  boards and starts at the flow's first board again, the colour picker keeps
  typed hex values, and shared design-system components, the tokens icon,
  history rows and settings no longer change for every Penpot user.
- SmallPen code moved out of upstream files into `app.main.smallpen.*`
  namespaces; our diff in upstream-owned code shrank by about 70 percent and
  SmallPen translations sit in one block at the end of each `.po` file.
- Canvas drags, text typed straight after creating a text box, and pasted,
  dropped or uploaded images (including non-Latin file names) now save.
- One rejected change no longer stops autosave for the session: it is
  dropped, reported, and the view returns to the saved Package.
- A pending local edit no longer overwrites a newer external change on the
  same field; the server refuses it and the user keeps a warning.
- A second tab on the same Package follows the first; an external change
  clears local Undo/Redo and says so.
- Rotation, flips and paths use one parent-relative transform in Penpot, the
  adapter and the CLI renderer, so all three draw the same picture.
- Component instance children can be edited: text, fills, opacity,
  visibility and names save as instance overrides, and Reset overrides,
  undo, delete, undo of delete and drops from Assets keep the canonical
  `instance` form. Geometry and stroke overrides still fail explicitly.
- Removed fills stay removed, duplicated shapes get their own identity, and
  Design System page path edits save to the source node.
- All SmallPen text is translated (English, Simplified and Traditional
  Chinese); `frontend/scripts/check-smallpen-i18n.js` checks the keys.
- The Settings sidebar in SmallPen shows only local settings; preferences the
  Package cannot store fail explicitly. Opening the token matrix no longer
  writes. Legacy `#/design-system` links now open Home; use
  `?screen=smallpen-design-system&file-id=…`.

### Packages, CLI and services
- Revisions no longer depend on the host locale; package or batch data can no
  longer reach `Object.prototype`; entry paths that collide by case or use
  Windows-reserved names are refused; deep values and trees fail typed.
  Keys now sort by code point, so a Package whose keys mix upper and lower
  case gets a new revision and key order on its next write; a session still
  holding the old revision gets one `stale_revision`.
- Batch replay keys on base revision and operations; a batch undone back to
  its base applies again; a superseded batch fails with `batch_superseded`.
- Commits sync to disk, hard-link unchanged files, never write through
  symlinks, FIFOs or foreign lock folders, and clean up after a killed
  writer. Reads work on read-only folders.
- Opening a Package no longer writes; Products follow Foundation and Library
  changes, including through chains and after repairs.
- Token import reserves existing ids, keeps Penpot numeric exports, and warns
  about anything it drops instead of failing at apply time.
- Remote Libraries are bounded by time, size and entry count and refuse
  private network hosts unless `SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS=1`.
- The Kiwi, PNG, GIF, JPEG and WebP decoders are bounded; long text and
  blurred layers render without whole-canvas memory or time costs.
- The Web host only proxies Google font files and stylesheets; both servers
  check Host and Origin, require JSON bodies, survive malformed requests and
  shut down promptly. These checks stop web pages, not local programs.
- New instance override operations, `set-instance-override` and
  `clear-instance-override`; CLI help and `CLI-AI-TOPIC.md` describe the
  replay rules and new error codes.
- Desktop opens relative paths from a second launch, survives a bad path at
  startup and focuses an already open Package.
- CI pins actions to commits, publishes only from `develop` or tags, checks
  translations, and renders text and images in the release smoke test.

### CLI for AI agents
- New `smallpen schema [topic]` prints every operation, node, token,
  component-set, instance, presentation, scenario and init answer format with
  a working JSON example. Writes are checked against the same schemas, and a
  test applies every example, so help and behaviour cannot drift apart.
- Command help carries real JSON examples; top-level help has a worked
  example from tokens to a dark render and says which Package each write
  targets. `put-token` and `put-component-set` with an existing id replace it.
- Errors name the missing field and its expected shape, list allowed values
  and valid ids, and suggest near misses (`textAlign` → `textStyle.textAlign`).
  Unknown fields are refused instead of ignored; a batch that changes nothing
  returns `changed: false`.
- `init` returns package, screen, presentation and root node ids and the
  seeded tokens and components; answers accumulate with `--state`; labels and
  output follow the host locale (Chinese only for `zh*`).
- `page` and `flow` intents accept instance `overrides`; `--compact` and
  `--inverse-out` shorten write replies; size advice only lists close token
  matches; a missing font is reported once with the `import-font` command.
- Instance override paths are checked against Foundation and Library
  components too; `update-presentation` accepts `viewport`.
- In a blind test, a fresh AI built the same small design system from help
  alone in about 40 commands with no failed writes, against about 100 mostly
  failed guesses before.

### Tokens on strokes and shadows
- Stroke colours bind to tokens (`stroke`, `strokes.N`) and follow the active
  theme in Penpot, the CLI renderer and token advice. Applying or detaching a
  colour token on a stroke in Penpot saves the binding.
- Shadow tokens apply, survive reload and render with the right offset and
  colour; bindings to a missing paint or a token of the wrong type fail at
  write time.
- Component variant previews apply their token bindings; generated
  Components and Design System pages cannot be renamed, moved or deleted.
- Penpot's per-side stroke widths, stroke-width and font-weight tokens, moving
  a just-dropped copy, and flex layouts with `column-reverse` or centred
  overflow now save and reload correctly.

## 0.1.0-alpha.3 and earlier

- Use Penpot's native `file-id`, `page-id`, and `layout` workspace URL shape without exposing Team, Background, Package Session, or local path details; stable File IDs restore recently opened Packages and missing files return Home.
- Replaced database-backed SmallPen persistence with strict local `.smallpen` Foundation, Product, and Draft packages, deterministic revisions, and atomic typed Operation Batches.
- Added same-workspace Foundation resolution, Effective Tokens, finite Context cascade, Screen Presentations, Scenarios, Interactions, requirements, Flows, Catalog, comparisons, Discovery Guides, and explicit Repair semantics.
- Added the complete JSON-first CLI Agent surface, local Background, package watcher, multi-package sessions, and a dependency-free host for the compiled Penpot frontend.
- Added stateless Product/Foundation Token and Component search across every finite design Context, including nearest color or numeric Token values and complete inherited Component variants, plus write-time exact-match and unmatched-value warnings with binding recommendations.
- Added an Electron Desktop app for macOS arm64 and Windows x64 with the original Penpot workspace assets, a native package picker, one shared loopback-only service process, and one native Penpot window per package.
- Added one manually triggered CI workflow that tests and uploads the standalone CLI and certificate-free, unnotarized macOS and Windows applications, then publishes the four public npm packages through trusted publishing.
- Added bounded CLJS adapters that project Canonical data into Penpot's existing canvas, layers, toolbar, and inspector components and route supported persistence back to atomic local Operations.
- Added independent Figma structured clipboard Draft import, SVG/PNG IMAGE fallbacks, provenance, Loss Reports, semantic Draft diff, and selected current-revision merge compilation.
- Added deterministic PNG plus JSON evidence from one projection. Review remains external; collaboration, comments, MCP, plugins, remote history, and built-in AI Chat are disabled by default in the SmallPen capability profile.
