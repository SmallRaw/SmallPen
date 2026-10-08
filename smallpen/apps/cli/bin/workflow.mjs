export const CLI_RULES = Object.freeze({
  purpose:
    "CLI operation rules. Read the selected command and input schema; pass explicit locators and returned IDs.",
  selection: {
    appStateIndependent: true,
    defaults:
      "No --theme: use each project's group defaults, never the App's active selection. Libraries without stored defaults use the real Default option, else the first option in library order.",
    precedence:
      "Project defaults < explicitly requested Scenario themes < explicit --theme. Override only named groups; unspecified groups keep defaults. Presentation chooses structure and does not implicitly choose a theme.",
    dimensions:
      "Groups and options are project-defined. Platform, language, light/dark, brand and density are examples, never required dimensions or fixed flags. --locale changes CLI labels only.",
    writes:
      "token theme default --theme Group/Option explicitly saves a project default; the App's own active selection changes only in the App (or with a set-active-token-themes operation through advanced apply). View, validate and export never save a selection.",
  },
  actions: {
    settings:
      "Work by name: every listed write takes Token paths ({path} binds a Token), theme options as Group/Option and component, page, element, canvas, color and font names; the CLI makes IDs, node tables and coordinates. Names never repeat: siblings, pages, components, canvases, theme options and assets each have their own; \"Name [2]\" picks one of a name stored twice so it can be renamed. Only advanced apply takes IDs. All writes are atomic; --dry-run/--explain/--diff preview without writing.",
    definitions:
      "token theme list returns groups/options/defaults; token list --definitions [--group GROUP] reads stored option values; token list/show/explain resolve values and sources.",
    flows:
      "flow list shows starts and links by page and element name; flow link adds a link, flow unlink removes an element's links, flow start --page makes a start and --remove undoes it.",
    view: "view looks at anything by name: nothing (whole package), --tokens/--token, --components/--component [--variant --element], --pages/--page [--platform --element]; --as text|wireframe|png|issues. Outlines collapse component internals and group repeated instances. changes --since REVISION lists, by name, what changed after a revision, including edits made in the App.",
    validate:
      "validate checks canonical validity and reports scoped text/layout/contrast issues separately. status valid means valid data, not complete visual approval. Always read issueCount, visualStatus and coverage.skipped. Pagination does not reduce the checked scope.",
    export:
      "export saves text, page/component/region wireframe or PNG and returns its path/hash/bytes. Pass the same target and themes used for validation.",
  },
  modelling: {
    tokenLayers:
      "Token names may have project-defined primitive/semantic/component layers; theme groups are independent dimensions, not name layers. Same-name tokens override in library set order (last active set wins). Token bindings reference stable token IDs; literals are also valid node values.",
    tokenWrites:
      "Write Tokens by name with token set: value applies wherever no option has its own value, values set named Group/Option options. Add and change theme options with token theme add/rename/default/delete --theme Group/Option. Resolve freely supplied combinations with --theme; do not create a separate saved-combination object.",
    componentVariants:
      "Component variants describe properties/states. Instance text overrides change content for one placement. They are distinct from token theme groups. Component edits affect its shared definition; instance overrides affect one placement.",
    presentations:
      "A Screen has a Base Presentation and optional different structures. Presentations store structure; token options resolve bound values and do not switch node trees or component variants. Context Axes describe finite non-token choices. Existing Scenarios describe page targets/actions; they are optional and are not required to select Token combinations.",
    platforms:
      "Split platform differences by kind. Values (font size, spacing) go to a Token theme group such as Viewport: Desktop / Mobile; without a saved default (token theme default) or an option named Default, its first option is the default, so list the platform you design first first. Structure or visibility inside a component (sidebar vs bottom tabs, a hidden action) goes to a Platform variant property on that component; shared page shells make good components with a Platform property. A whole page laid out differently is another Presentation. Add Platform only to components whose structure differs: on every component it multiplies variants. Checking a platform's Presentation, pass its theme option with --theme; view and validate hint when one exists but is not selected, or when an instance uses another platform's variant.",
    packages:
      "project init creates a blank self-contained package with one canvas and no pages, Tokens or components (page draw makes the first page); --name names the package and its file. In foundation-product layout write shared Tokens/themes/components to Foundation, pages/instances/Scenarios to Product. Read Product to resolve both; Product cannot edit Foundation components.",
    designSystem:
      "Generated from canonical token and component data; do not draw a duplicate design-system Screen. view/export --design-system inspects it. Representative samples do not prove every variant/combination was checked.",
  },
  output: {
    budgetBytes: 8192,
    strategy:
      "Discover IDs and read compact text/issues first; request one target or region before expanding data with pagination or --full. Use a text wireframe for unclear spatial relations. Decode JSON strings, keep LF newlines and spaces, display monospace without soft wrapping. Only request PNG inspection when text/wireframes are insufficient and the caller supports image input; verify the current PNG against renderHash; temporary paths are unique per call. Outline page.total/hasMore counts text lines; wireframe is complete with lineCount. Large complete results use resultFile.path (JSON) and resultFile.text.path for exact LF/space text. Use jq/rg/sed to read just what is needed. --full expands data, --stdout explicitly permits large stdout. All temporary files share one system temporary folder and the format smallpen-TIMESTAMP-UUID-KIND.ext. Each call cleans CLI files with mtime older than 30 minutes, skipping active calls. Consume within 30 minutes; concurrent invocations have separate results. --output retains a chosen deliverable. Omitted stdout detail never means a check passed.",
    imagePolicy:
      "view defaults to a text outline; export defaults to a text wireframe, including with --full. PNG requires export --format png. The CLI cannot detect the caller's image capability and returns artifact paths by default. Models without image input must use text/wireframes for review; they may export PNG deliverables but must not open/embed them or claim visual inspection.",
    protocol:
      "All stdout JSON is compact, including --full. Default directories expose only public identity, ownership, selection and count fields; read one target for its description or definition. Omit normal public visibility and false deprecation; actual private restrictions, deprecation and replacements remain actionable. Internal object fields never become public directory fields automatically. schema command project list or component list/search documents the output contract. token theme list omits unrelated stored App selection unless --full is explicitly requested. This omission policy must not discard meaningful design values such as 0, false, empty text or a node's hidden state.",
    writes:
      "Choose a unique --batch-id before retryable writes; reuse it only with identical input. Read changed fields and changeReportPath for exact before/after values. reverseEdit describes a new revision-guarded write, not history rollback. After later changes restore only the intended current fields with a new edit; never force stale snapshots. Inspect changed/noChange, revisions and scoped reuseReminders. Existing IDs on put operations usually replace the whole object; use update operations for partial edits.",
  },
});
