export const CLI_RULES = Object.freeze({
  purpose:
    "CLI operation rules. A package is HTML files you read, search and edit directly; the CLI checks and renders them, resolves Tokens, exports and reports changes. help rules format and help rules classes describe the files.",
  start: [
    "Create a package with init (index.html and tokens.css), then edit its files: Tokens in tokens.css, components in components/<Name>.html, pages in pages/<Module>/<Page>[.mobile|.tablet].html. Define only what the task needs; a complete Token inventory or component library is not a prerequisite.",
    "After every edit run smallpen check PACKAGE: each problem is one line, file:line:column severity code message, with the fix. A passing check is the accepted version; with errors, the changed files that keep the package valid are accepted and the files with errors are rejected; check --revert [--file PATH] puts rejected files back to the accepted version. check --render also draws the pages and components (or the --page/--component named) and reports text overflow, bounds, overlaps and contrast; read its coverage and skipped checks. Look with view by name: --as spec for constraints and sources, wireframe for structure, PNG for appearance. Find pages, components, assets and links by reading the files.",
    "Continue after App edits with changes --since REVISION (every read reports a revision), then read the affected files before editing again. export is for retained deliverables, with an offline HTML review optional.",
  ],
  selection: {
    appStateIndependent: true,
    defaults:
      "No --theme: use each project's group defaults (data-GROUP=\"option\" on index.html's <html>), never the App's active selection. A group without a default uses its option named default, else its first option.",
    precedence:
      "Project defaults < explicit --theme. Override only named groups; unspecified groups keep defaults. A page version chooses structure and does not choose a theme.",
    dimensions:
      "Groups and options are project-defined (lowercase): :root[data-GROUP=\"option\"] blocks in tokens.css. Platform, language, light/dark, brand and density are examples, never required dimensions or fixed flags. --locale changes CLI labels only.",
    writes:
      "Change a project default by editing the data-GROUP attribute on index.html's <html>; the App's own active selection changes only in the App. check, view and export never save a selection.",
  },
  actions: {
    settings:
      "Everything is named: elements by data-name (unique among siblings), pages by their file path (Module/Page), components by name, Tokens by CSS variable. Files hold no IDs or coordinates that layout derives. Styles are classes only (no style attribute, <style> or <script>); Token classes such as bg-brand bind a Token, bracket classes such as w-[240px] are literal values.",
    definitions:
      "token list resolves every Token under the project defaults or --theme, follows aliases, and lists the theme groups and options; --token NAME narrows it, --definitions [--group GROUP] reads each option block's stored values. token export writes values for application code: --by GROUP one file per option, --format css as custom properties with aliases kept. token list --unused names Tokens no page or component uses; each row says in how many pages, components or other Tokens it is used.",
    flows:
      "Links are data-click=\"Module/Page\" (or back, overlay:PAGE, close-overlay, a URL; data-hover, data-press, data-mouse-enter, data-mouse-leave, data-after-delay for other triggers) on an element; a page that starts a prototype flow has data-flow=\"name\" on <body>. A link opens the same platform's version of the page, or its desktop version when it has none. spec lists each element's links with their options (position, animation). Search the page files for data-click, data-hover and data-flow to list them.",
    view: "view looks at anything by name: nothing (whole package), --tokens/--token, --components/--component [--variant --element], --pages/--page [--platform --element]; --as text|spec|wireframe|png|issues. Text navigates; spec implements and traces sources; wireframe shows structure; PNG reviews appearance. changes --since REVISION lists, by name, what changed after a revision, whoever changed the files.",
    validate:
      "check reports format and rule problems without rendering; check --render also renders and reports text/layout/contrast problems. No rendering problems is not visual approval. Read render.issueCount and render.coverage.skipped; coverage.targetCount counts the versions/variants actually checked.",
    export:
      "export saves a page/component/region specification, wireframe or PNG. --format png --evidence writes all three from one native solve. --format html --canvas NAME --output DIR exports an offline page/state review with native images, measured hotspots, declared navigation, spec and evidence. One theme combination is exported. Output must be new/empty and outside source Packages; index is written last. Compare layout.hash, target, themes and revision.",
  },
  modelling: {
    tokenLayers:
      "A Token is a CSS variable whose prefix sets its type: --color-, --spacing-, --size-, --radius-, --border-, --shadow-, --opacity-, --type- (font shorthand), --font-, --font-weight-, --text-, --tracking-, --string-, --flag-. Aliases are var(--other-token). A later theme block overrides a value by name.",
    tokenWrites:
      ":root holds base values; :root[data-GROUP=\"option\"] holds that option's overrides. Bind with classes (bg-brand, p-4, rounded-md, type-label), data-text=\"save\" for --string-save and data-visible=\"badge\" for --flag-badge.",
    componentVariants:
      "components/NAME.html holds only <sp-component> elements, no <html> or <head>. <sp-component name props=\"Prop: a | b\"> holds the shared element; <sp-variant when=\"Prop: b\"> changes it for matching variants (later classes win). A part in a rule is found by data-name and changes its class, its words or data-text, or a copy's props; a deeper part is written inside its parents as in the component (<div data-name=\"Info\"><p data-name=\"Title\">…</p></div>), the same for a copy's overrides; a copy restated in a rule (<sp-use data-name=\"X\" props=…>) replaces that copy's props and overrides for those variants, so write every override it needs there; links and data-visible stay on the shared element (show or hide a part with hidden / shown). A part without data-name is named after its text (<p>Continue</p> is Continue), so write data-name on parts that rules or copies change. Ellipse, group, mask and <svg> are page-only; icons in components are <img>. A copy is <sp-use component props>, as big as its component unless w-/h- say otherwise; its children override named parts (classes, text). Variants describe properties/states; copy overrides change one placement. --variant takes the same props text: \"Style: secondary; Size: sm\".",
    presentations:
      "A page has one file per platform version: Page.html (desktop), Page.mobile.html, Page.tablet.html. Token options resolve bound values and do not switch node trees or component variants.",
    platforms:
      "Split platform differences by kind. Values (font size, spacing) go to a theme group such as viewport. Structure inside a component goes to a Platform property on that component. A whole page laid out differently is another platform file. Check a platform's version with its theme option via --theme.",
    packages:
      "init creates a blank package: index.html (name, package id, theme defaults) and tokens.css. Pages and components are files you add. A package stands alone: its pages use its own components and Tokens; packages do not share components (no foundation, product or library split), so copy a component file to reuse it elsewhere. Fonts and images go in assets/ (fonts in assets/fonts/, declared with @font-face in tokens.css).",
    designSystem:
      "Generated from Token and component data; do not write a duplicate design-system page. view/export --design-system inspects it; view PACKAGE --component NAME --as png displays every variant of that component.",
  },
  output: {
    budgetBytes: 8192,
    strategy:
      "Choose one page/component/variant/element. Read spec for implementation: authored fixed/fill/hug constraints, native bounds, field-level Token and component sources, overrides and node diagnostics. Read wireframe for spatial orientation; its character grid is approximate. Read PNG for appearance when the caller supports images. Specification, wireframe and PNG use native App layout; compare layout.hash, revision and selection. Unknown geometry stays ?/partial with a reason. Coverage applies only to the selected size/themes/state. --element expands details; --full expands the selected tree. Read resultFile.text.path for exact text, resultFile.path for complete JSON. Temporary paths expire after 30 minutes; --output retains deliverables.",
    imagePolicy:
      "view defaults to a text outline; implementation starts with view --as spec. A PNG cannot prove Token bindings or sizing intent. A specification cannot prove visual quality. Models without image input must use spec/issues for structural checks; they may export PNG but must not claim visual inspection.",
    protocol:
      "All stdout JSON is compact, including --full. Directories expose names, ownership, selection and counts; read one target for its definition.",
    writes:
      "Edit files directly; check after each edit. The App rewrites a page or component file in the standard layout when a person saves a change in it; other files keep their layout. Read changes --since before editing a file the App may have changed.",
  },
});
