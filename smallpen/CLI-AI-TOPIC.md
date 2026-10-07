# SmallPen CLI

The CLI reads, edits, checks and exports local `.smallpen` design packages.
Each call is independent: no current page, remembered theme combination or
cross-call selection. No Code Mode runtime is included.

## Discover only what is needed

```sh
smallpen help
smallpen help token
smallpen help token show
smallpen schema command token show --json
```

Root help lists objects and common commands. Object help lists its actions.
Action help lists its options and the exact input-schema queries. Schemas and
argument validation share the same definitions. `--help` and `-h` work at
both object and action levels. `--version` prints the version.

The CLI is usable through help/schema without a Skill. The independently
installable [application design Skill](skills/README.md) supplies task-specific
questions, production rules and review criteria. It is generated from the CLI
contract and scene templates. Character boards and animation assets remain
drafts. See [CLI/Skill responsibilities](docs/CLI-SKILLS.md).

## Objects and actions

| Object          | Actions                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `project`       | `init`, `show`, `list`, `watch`, `repair`, `migrate`                                  |
| `theme`         | `list`, `add`, `rename`, `default`, `delete`                                          |
| `token`         | `list`, `show`, `search`, `explain`, `set`, `delete`, `impact`, `export`, `import`    |
| `canvas`        | `list`, `rename`, `put`                                                               |
| `component`     | `list`, `search`, `define`, `rename`, `delete`                                        |
| `page`          | `list`, `draw`, `move`, `rename`, `delete`                                            |
| `asset`         | `list`, `set`, `delete`                                                               |
| `media`, `font` | `list`, `import`, `delete`                                                            |
| `flow`          | `list`, `link`, `start`, `unlink`                                                     |
| `advanced`      | `apply`, `import-draft`, `draft-diff`, `draft-compile`, `library-refresh`, `discover` |

Actions take a package path after the action: `smallpen page list PACKAGE`.
`project init` takes a `.smallpen` path or a new workspace directory and creates a blank canvas without a business brief.
Every action names things the way outlines show them: pages ("Tasks / List"),
elements ("Card / Title"), components, variants ("Style=ghost"), canvases,
colors ("Brand/Primary") and fonts. No action needs an ID.

Names never repeat. Sibling elements, pages, components, canvases, theme
options and colors each have their own name. A rename that takes a used name,
in the CLI or the App, is numbered as a copied folder is ("Card 2", "Card 3")
and the reply lists it under `renamed`. Two siblings given one name in a
`page draw` or `component define` intent fail with `duplicate_name`. Unnamed elements take
their text or component name, numbered when it repeats ("Hi", "Hi 2"). A name
an older file stores twice shows up in `view --as issues` and `validate`; pick
one as `"Tasks / List [2]"` and rename it.

`view`, `changes`, `export` and `validate` are shared commands. `view` reads
the resolved design by name; `changes --since REVISION` lists what changed,
including edits made in the App.

No command takes an ID except `advanced apply`, which runs an exact batch
such as the undo batch every write returns, and `project repair`, which picks
from the choices it offers. Replies leave IDs out as well (`--full` shows the
stored data with them). IDs still exist inside the package and the App. Only
the grouped commands above and `view`, `changes`, `export`, `validate`,
`help`, `schema` and `version` run; an old flat name such as `apply` or
`inspect` fails and names its grouped path (`advanced apply`, `project show`).

## Themes and Tokens

`theme list PACKAGE` reads groups, options and project defaults. Any selected
combination in its reply comes only from that call's arguments and defaults.
It is not remembered. Omitted groups use their project defaults; an explicit
Scenario overlays its saved themes, and explicit `--theme GROUP/OPTION` overrides
only named groups. The CLI uses the App's shared default/override rules and
leaves the App's active selection unchanged.

Groups are project-defined. Platform, language, brand, density and light/dark
are examples, never required dimensions. `--locale` changes CLI labels only.
A page configuration chooses structure and does not silently choose themes.
Theme options are named `Group/Option` everywhere. `theme add --theme
Viewport/Tablet` adds an option (and its group when new); `theme rename`,
`theme default` and `theme delete` take the same names. `theme default`
explicitly changes a project default.

`token list` reads effective values; `token show` resolves one Token;
`token explain` reports its sources. `token list --definitions [--group GROUP]`
reads stored option values. `token set` writes Tokens by name: `value` applies
wherever no option has its own value, `values` set named `Group/Option`s.
`token delete --path NAME` removes a Token. Agents never name token Sets or
IDs.

Same-name Tokens override in active Set order: the last active Set wins.
Bind stable base Token IDs. A Token name cannot also be a name-group prefix.
Broken references prevent destructive removal. Advanced batches handle exact
Token IDs, bindings, ungrouped Sets and explicit App selection changes.

## Writes

```sh
smallpen help page draw
smallpen schema page-draw --json
smallpen page draw PACKAGE --intent page.json --batch-id draw-settings
smallpen page rename PACKAGE --page "Tasks / List" --to Overview
smallpen page delete PACKAGE --page Overview --element "Card / Badge"
smallpen component rename PACKAGE --component Button --element Label --to Text
smallpen asset set PACKAGE --color Brand/Primary --value "#1f6feb"
```

The action help identifies its input format. `token set`, `component define`
and `page draw` read a small JSON intent; their schemas include examples. The
other actions take only options. `schema operation TYPE` documents an operation
inside an advanced batch; `schema batch` documents the revision-guarded batch
wrapper. Unknown fields fail before writing.

Every design write uses the existing atomic engine. `--dry-run`, `--explain`
and `--diff` preview supported writes without committing. Choose a stable
`--batch-id` before a retryable write and reuse it only with identical input.
Retries replay the confirmed result; conflicting or superseded identities fail.
The local ledger retains at most 500 identities.

Read `changed`, `noChange`, revisions and warning counts. `changeReportPath`
contains exact before/after values. `reverseEdit` describes a new write guarded
by the confirmed revision, not history rollback. `--inverse-out FILE` retains it.
After later edits, restore only intended current fields in a new edit; never
force an old snapshot by changing its base revision.

Prefer Tokens for reusable styles. Reuse warnings offer matching Tokens and
components without forcing a design choice. Keep variants within a component;
use instance overrides to change one placement's text or other supported fields.

## View, check and export

`view` names its target: nothing for the whole package, `--page`, `--component`,
`--token`, `--canvas`, with `--platform`, `--variant` and `--element` to narrow
it. `--as text` (default), `wireframe`, `png` or `issues` picks the form.

`validate` takes the same names. A page checks every version and a component
every variant unless `--platform` or `--variant` names one; it never
enumerates theme combinations. Pagination limits findings, not checked scope. Read `dataStatus`, `visualStatus`, issue counts and
`coverage.skipped`: valid data does not prove complete visual approval.
Unsupported layout modes and renderer limitations are reported explicitly.

`export` defaults to a text wireframe, including with `--full`. Choose
`--format text` or explicitly request `--format png`. For page PNGs,
`--evidence` adds review evidence. Its targets are named as `view` names them. `--design-system`
uses the generated Token/component page; do not draw a duplicate specimen page.

Inspect PNGs only when text/wireframes are insufficient and the caller supports
image input. Models without image input can export PNG deliverables but must
review text/wireframes. The CLI returns real paths, dimensions, revisions and
hashes. Always use the current response and verify its hash. Images are never
included inline unless `--base64` is explicit.

Text wireframes preserve LF newlines and spaces. Decode JSON strings before
displaying them in monospace without soft wrapping.

## Prototype interactions

`flow list` shows starts and links by page and element name.
`flow link --from "Page / Element" --to Page [--on click]` adds a link;
`flow unlink --from "Page / Element" [--to Page] [--on click]` removes it.
`flow start --page Page` makes a start and `--remove` undoes it. Links only
work between pages on one canvas, so by default every page shares one. A page
other pages link to cannot be deleted until those links are removed.

## Small output and temporary files

All stdout JSON is compact. Lists default to 20 items. Public directories expose
identity, ownership, relevant selection and counts; target reads expose exact
editable data. Normal visibility and false deprecation are omitted, while actual
restrictions and replacements remain visible. Stored fields do not automatically
become public fields. Design values such as `0`, `false` and empty text remain exact.

`--full` expands selected data but keeps the 8 KiB stdout budget. Large results
are saved in full to `resultFile.path` with bytes and SHA-256. Large outlines and
wireframes also have `resultFile.text.path`. Search with `rg`, or read selected
JSON fields with `jq`. `--stdout` explicitly permits large stdout.

Temporary files use one private folder under the operating system's `os.tmpdir()`
on Linux, macOS and Windows. Names follow `smallpen-TIMESTAMP-UUID-KIND.ext`.
Concurrent calls have distinct files. Each invocation removes recognized files
older than 30 minutes while protecting active calls. Unrelated files are untouched.
`--output` and `--inverse-out` retain deliverables outside the CLI temporary tree.
Consume temporary results within 30 minutes. Windows uses the current user's
ACLs; unsafe or inaccessible temporary storage returns an explicit error.

Schemas return `cliVersion` and `contractRevision`. Mutable reads return package
and workspace revisions. Cache by those revisions plus selectors, themes, format,
locale and pagination; theme changes can change a view without a package change.

Errors contain a typed code, an executable recovery query and `writeState`:
`not-applied`, `committed` or `unknown`. Check committed or uncertain outcomes
before retrying. Stale revisions and unsupported changes never justify using an
older result or claiming a check passed.
