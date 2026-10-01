# Changelog

## Unreleased

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
