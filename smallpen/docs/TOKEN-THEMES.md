# Token themes contract

Updated 2026-10-04. User decision: themes have one mechanism, Penpot's token
sets and themes ("Form A"), the model Penpot's token manager, Tokens Studio and
DTCG `$themes` share. Token `$extensions.smallpen.contextValues` on theme-kind
Context Axes are no longer how a theme is written; Packages that use them still
load and render as before. Context Axes remain for non-token choices such as
viewport, platform, density or locale.

## 1. The library

A Package has at most one token library: the `manifest.entries.tokens` entry
whose value has `sets` and `themes` arrays.

```json
{
  "id": "tlib_acme",
  "sets": [{ "id": "tset_base", "name": "base", "description": "",
             "tokens": [{ "id": "tok_color_brand", "name": "color.brand",
                          "type": "color", "value": "#6750a4", "description": "" }] },
           { "id": "tset_theme_dark", "name": "theme/dark", "description": "",
             "tokens": [{ "id": "tok_color_brand_dark", "name": "color.brand",
                          "type": "color", "value": "#d0bcff", "description": "" }] }],
  "themes": [{ "id": "theme_theme_dark", "group": "Theme", "name": "Dark",
               "setIds": ["tset_base", "tset_theme_dark"],
               "description": "", "externalId": "", "isSource": false }],
  "activeThemeIds": ["theme_theme_dark"],
  "activeSetIds": ["tset_base"]
}
```

- Active sets: the union of `setIds` of the themes in `activeThemeIds`; when
  `activeThemeIds` is empty, `activeSetIds` (Penpot's hidden theme).
- Name resolution: walk `sets` in array order and, for each active set, map
  every token name to that token. A later set overrides an earlier one with the
  same name. Theme order does not matter; set order does.
- A name is either a token or a group, never both (Penpot's
  `token-name-path-exists?`): `color.brand` and `color.brand.hover` cannot
  coexist in a Package. `put-set-token`, `put-token-set` and `put-token`
  reject a new collision with `token_name_collision`; `validate` warns about
  existing ones. `replace-token-library` (the editor's save) does not check,
  since Penpot itself allows the pair across sets.
- Bindings (`tokenBindings`) reference a token id. A binding to a library
  token resolves through that token's name to the winning active token, so
  nodes bind the base id (`tok_color_brand`) and the active theme decides the
  value. Aliases (`"{color.brand}"`) resolve by name the same way.
- One theme per group is active. A theme path is `group/name`.
- DTCG token files (other `tokens` entries) stay supported: their tokens are
  always active, resolve by path, and lose to a library token of the same name.

## 2. Layouts

Default: one self-contained Package (`role: "foundation"`, no dependency) with
the library, Components and Screens. `smallpen init` creates it.

Advanced: a Foundation + Product pair (`init --layout foundation-product`).

## 3. Foundation + Product

1. **Ownership.** The Foundation owns the library: sets, themes, its own
   project defaults (`defaultThemeIds`) and App selection (`activeThemeIds`). The Product may have its own library (init seeds
   one empty set `product`, active through `activeSetIds`, and no themes).
2. **Selection (stored).** The Product stores which Foundation themes it uses
   on its dependency, by Foundation theme id:

   ```json
   "dependencies": [{ "packageId": "pkg_acme_foundation",
                      "path": "acme-foundation.smallpen",
                      "activeThemeIds": ["theme_theme_dark"] }]
   ```

   - Ids are the Foundation library's permanent `theme_...` ids, qualified by
     the dependency's `packageId`: stable across renames of group or name.
   - Absent: the Foundation library's own `activeThemeIds` apply.
   - Present and empty: no Foundation theme is active; the Foundation's
     `activeSetIds` apply.
   - An id the Foundation no longer has is ignored at read time;
     `set-active-token-themes` rejects unknown paths.
3. **Resolution for Product reads.** Foundation active sets are computed from
   the Product's selection (not the Foundation's). The Product's own active
   sets then sit on top by name: the effective name space is the Foundation's
   active sets in Foundation set order, followed by the Product's active sets
   in Product set order, last wins. This applies to bindings to Foundation
   tokens and to aliases inside Foundation tokens. When a Product token wins,
   the resolution reports `sourcePackageId` = the Product and
   `sourceChain` = `[{role:"target"}, {role:"set-override"}]`.
   Product DTCG `overrideOf` tokens keep working and win over both.
4. **Theme namespace.** Product and Foundation themes share one group
   namespace. Selecting a theme turns off every other theme of its group in
   both libraries. A theme path present in both is ambiguous
   (`ambiguous_token_theme`); `init` and `migrate-themes` never create one.
   Set names must not collide between the two libraries.
5. **Writes.** `set-active-token-themes {themePaths}` on the Product takes the
   whole selection: paths of the Product's own themes go to its library's
   `activeThemeIds`, Foundation paths go to `dependencies[0].activeThemeIds`.
   The inverse is `set-foundation-dependency` with the previous dependency plus
   a `restore-canonical-entry` of the Product library. The write needs the
   Foundation: the CLI passes it, and a local write of this operation without
   it (the Web backend) loads it from the dependency path.
6. **Foundation edits** (sets, tokens, themes) are written to the Foundation
   (`put-token-set`, `put-set-token`, `put-token-theme`, `delete-token-set`,
   `delete-token-theme`, `set-token-value`, `remove-token`).

### Variants a Product uses

A Product Instance names its Foundation Component Set and the variant values
it selects (`instance.variant`). Variants keep their ids when their values
change, so:

- A value rename in the Foundation (Penpot's variant panel or
  `put-component-set`) re-points the Instances of every Product open in the
  same session to the same variant, in one batch per Product with its own
  undo.
- An Instance whose selection no variant has any more (a deleted variant, or
  a rename made while the Product was closed) never makes the Product
  unreadable. It renders with the closest variant (Penpot's variant
  distance: earlier Axes weigh more; the first variant when nothing matches),
  reads report `stale_instance_variant`, and the Product enters Repair
  (`missing_variant`, `degraded: true`). Penpot opens it read-only with a
  notice; `smallpen repair` offers `select-instance-variant` (closest variant,
  or `--selection`), `retarget-reference` and `remove-dependent-usage`.

## 4. Reads choose themes without writing

The project default and the App's current selection are separate. A library may
store `defaultThemeIds`, one theme per group. `init` saves its declared defaults;
`theme` can change them explicitly. Older libraries use a real `Default` option,
or the first option in library order, independently of `activeThemeIds`. Reads
never migrate or rewrite older packages. App edits retain defaults by stable ID;
renaming an option preserves them. Deleting an option falls back to a remaining
Default/first option without leaving a dangling default ID.
With no themes, CLI reads use independent `defaultSetIds` (init: base); legacy
libraries without that field use all sets in library order. `activeSetIds`
remains the App's current selection and cannot change those CLI defaults.

`themes PACKAGE` lists groups/options/defaults/set IDs cheaply. `selection` and
option `active` flags describe this call; `appSelection` describes stored App
selection. `theme add|rename|default|delete --theme Group/Option` edit them
by name; the low-level `schema theme-intent` remains for the App planners. New
groups create a real Group/Default set and paired theme; option copies get
independent Token IDs. Groups and names are arbitrary project dimensions. Theme,
platform and language examples do not define mandatory parameters.
New `init` Set paths keep the supplied group/option labels, including spaces;
only stable IDs use normalized names. Existing packages keep their Set paths.
Adding an option to a legacy group preserves that group's native App path,
instead of creating a second domain with a differently cased name.
Renames update saved Scenario theme paths in the edited package. Deletion fails
while a local Scenario selects a removed option. Saved paths in other packages
need explicit maintenance in their owning package.

`--theme GROUP/NAME` (repeatable, one per group) on `render`, `evidence`,
`inspect-view`, `read-view`, `discover`, `tokens`, `search-tokens`,
`effective-token`, `explain-token`, `catalog`, `compare`, `impact`,
`search-components`, `render-matrix`, `view`, `export`, `validate`, `themes`
overrides project defaults for that call only. Unspecified groups keep their
defaults. The Product uses its Foundation's project defaults rather than the
stored dependency active selection. Unknown themes fail
with `unknown_token_theme` and `validThemes` (and `validGroups` or `group`);
two themes of one group fail with `duplicate_token_theme_group`. A Scenario may
store `themes: ["Theme/Dark"]`; explicit `--scenario-id` overlays them onto the
defaults, then explicit `--theme` overrides named groups in that result.
A Presentation alone does not select themes. CLI reads, checks and exports never
change App state or save this combination. `tokens` and `inspect-view` list
`themes[]` with `active` and `owner` for the temporary view.

### Create and edit values like the App

`token PACKAGE --intent FILE --json` accepts these intents (`schema token-intent`):

```json
{"action":"create-row","group":"Brand","name":"color.accent",
 "type":"color","value":"#6750a4","description":"Accent color"}
```

```json
{"action":"set-value","group":"Brand","option":"Ocean",
 "name":"color.accent","value":"#006699"}
```

The App matrix and CLI call the same core planners. Creating a row creates an
independent Token in every option Set of the native group (`Brand/Default`,
`Brand/Ocean`, etc.), with the same initial fields and distinct IDs. It does not
write the base or other dependency Sets a theme activates. Existing cells reject
the whole creation; use `set-value` to edit a value.

Writing one cell preserves its ID, type, description and other fields. Filling
an empty cell creates a new ID, using an existing row's name/type/description in
this group. There is no global row object and no empty-cell fallback to Default.
Same-name Tokens in different groups remain independent. A later selected Set
can still override the effective value by name, in library Set order.

`tokens PACKAGE --definitions [--group Brand] --json` returns stored Token
objects, their owner, Set ID, group and option. An absent cell has no item.
`tokens PACKAGE --theme Brand/Ocean --json` returns effective values for that
temporary combination. Omitted groups use their defaults. No read saves a
combination or changes App selection; no separate combination object is added.
Write names first match exact native group/option names, then a unique match
that ignores case. Ambiguous matches require an exact name and list choices.
`--definitions` cannot take `--theme` or `--context`. Lower-level
`{ "operations": [...] }` intents remain available for exact ID operations,
ungrouped Sets, bindings and DTCG files. App commits retain native undo and Token
propagation; CLI commits retain batch validation, retry identity and inverses.

`search-tokens` searches project defaults unless explicitly overridden, like every other
read, and returns `themeScope {mode: active|explicit|all, selections}` naming
the themes it searched. `--all-themes` searches every selection of one theme
per group (at most 64; `capped` says when more exist) and tags each item with
`themes[]`, the selections in which it has that value. `--theme` and
`--all-themes` together fail with `conflicting_theme_options`.

## 5. Penpot projection (frontend)

For a Product file, project one Penpot tokens-lib:

- Sets: the Foundation's sets (Foundation order) followed by the Product's
  sets (Product order), with their token ids and names. Foundation sets and
  themes are read-only in the Product file; edits belong to the Foundation.
- Themes: the Foundation's themes followed by the Product's themes.
- Active themes: the paths of the Foundation themes in the Product's effective
  selection (rule 3.2) plus the Product library's active themes. When none is
  active, the hidden theme holds the Foundation's and the Product's
  `activeSetIds`.
- Switching a theme in the Product's token manager is one
  `set-active-token-themes` with the whole new selection of paths.
- Resolved values must equal `smallpen tokens <product> --theme GROUP/NAME ...
  --json` when CLI and App explicitly use the same selection.

For a self-contained Package the library projects as it is today.

Generated Design System page (Penpot): `createWorkspaceRuntime(product,
{foundation})` rebuilds the Product's runtime so `runtime.designSystemRefs`
holds the Foundation's sets first, then the Product's, the combinations of
both libraries' themes, and resolved values; the Foundation's sets are active
per the Product's selection. Foundation Cells are `readOnly: true`,
`writable: false`, `ownerPackageId` = the Foundation, and keyed
`<foundation packageId>:<tokenId>`. A Product theme that repeats a Foundation
theme id or group/name is left out with a `design_system_theme_conflict`
diagnostic. The background server builds it on every commit and on every
read of the page data, so a Foundation change shows without reopening the
Product; a build failure falls back to the Product's own Cells with
`design_system_foundation_unavailable`. Runtime ids of the Product do not
change. `GET /v1/workspace` leaves `runtime.designSystemRefs` and
`runtime.reverseDesignSystem` out and sets `runtime.designSystemRefsDeferred`;
the page reads its data from `GET /v1/design-system-refs` (optional
`revision`, answered with 409 `stale_revision` when it is not the current
one, and `combination`, which keeps that combination's Cells and samples and
those shown for all combinations). The answer is in the compact wire form
`format: "compact-1"` (apps/background/src/web-projection.mjs
`compactDesignSystemRefs`): each sample node's source keeps only its own
fields, and the Web merges the sample's fields back. Background JSON answers
and the Web host's bundles are compressed (br or gzip) when the client
accepts it. Libraries travel without either field. A
Component Set whose bound Tokens resolve alike in every combination gets one
sample per variant with `combinationId: null` and `allCombinations: true`.

Design System workbench and canvas (core): pass the Foundation as
`options.foundation` to `enumerateWorkbenchCombinations`,
`validateWorkbenchCombination`, `createWorkbenchPreview`, `buildCanvasScene`
and `collectCanvasTokenCatalog`. Domains then come from
`listTokenThemes(product, foundation)`: one domain per group across both
Packages, each variant with its `packageId`, the current theme from the
Product's selection. A combination selection is `{domainId, themeId,
packageId?}`. Canvas rows mark `observed` by `(packageId, setId)`, and
Foundation rows are `active` per the Product's selection. Without the
Foundation a Product offers only its own themes.

## 6. Writes and compatibility

- New operations: `put-token-set` (creates the library when missing; a new set
  of a library without themes starts active), `put-set-token`,
  `put-token-theme`, `delete-token-set` (themes stop listing it),
  `delete-token-theme`. All invert with `restore-canonical-entry`.
- `put-token` on the library entry fails `token_library_entry` (use
  `put-set-token`). `remove-token` removes a library token; `deprecate-token`
  on one fails `unsupported_token_deprecation`.
- `put-token` with `contextValues` is accepted with warning
  `context_values_deprecated`. `--context` keeps resolving them.
- Shadows are `{offsetX, offsetY, blur, spread, color}` (optional `opacity`,
  `inset`, `hidden`, `style`, `id`; Penpot's `offset-x`/`offset-y` and string
  lengths are accepted). Writes reject `{x, y}` with `invalid_shadow_shape` and
  a `suggestion`; inverse `restore-canonical-entry` is exempt. Packages that
  contain `{x, y}` still load; the renderer reads them as offsets and reports
  `legacy_shadow_shape`; `import-tokens` converts Tokens Studio `x`/`y`.

## 7. Migration (ADR 0003)

`smallpen migrate-themes <package> --output <new>` copies the Package, or the
Product with its Foundation into a new workspace directory, and converts:

- each theme-kind axis to a theme group named after the axis: set `base` with
  every Token's default value (ids, names and bindings unchanged), one set per
  axis value `<axis>/<value>` holding that value's contextValues as Tokens of
  the same name with id `<base id>__<value>`, one theme per value activating
  `[base, its set]`, the default value's theme active;
- DTCG token files into the library (an existing library keeps its sets after
  the new ones; its empty themes in a migrated group are removed, with the
  empty sets only they used);
- the Product's dependency `activeThemeIds` to the default themes; its empty
  themes in a migrated group, and the empty sets only they used (the seeded
  `Theme/Default`), are removed (`empty_theme_removed`, `empty_set_removed`);
- Scenario contexts on migrated axes to Scenario `themes`;
- legacy `{x, y}` shadows to `{offsetX, offsetY}`.

Tokens with a rule on a non-theme axis or on more than one axis, Product
`overrideOf` tokens, tokens without a base value, and paths that are not token
names stay DTCG tokens and are listed in `context_values_not_migrated`
warnings; a theme axis they still use stays as a Context Axis
(`theme_axis_kept`).
