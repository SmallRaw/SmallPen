# Changelog

## Unreleased

- Use Penpot's native `file-id`, `page-id`, and `layout` workspace URL shape without exposing Team, Background, Package Session, or local path details; stable File IDs restore recently opened Packages and missing files return Home.
- Replaced database-backed SmallPen persistence with strict local `.smallpen` Foundation, Product, and Draft packages, deterministic revisions, and atomic typed Operation Batches.
- Added same-workspace Foundation resolution, Effective Tokens, finite Context cascade, Screen Presentations, Scenarios, Interactions, requirements, Flows, Catalog, comparisons, Discovery Guides, and explicit Repair semantics.
- Added the complete JSON-first CLI Agent surface, local Background, package watcher, multi-package sessions, and a dependency-free host for the compiled Penpot frontend.
- Added stateless Product/Foundation Token and Component search across every finite design Context, including nearest color or numeric Token values and complete inherited Component variants, plus write-time exact-match and unmatched-value warnings with binding recommendations.
- Added a self-contained macOS Cocoa/WKWebView Desktop bundle with an embedded Node runtime, the original Penpot workspace assets, a native package picker, loopback-only services, and one native Penpot window per package.
- Added a manually triggered Alpha workflow that tests and uploads the standalone CLI plus a certificate-free, unnotarized macOS application.
- Added bounded CLJS adapters that project Canonical data into Penpot's existing canvas, layers, toolbar, and inspector components and route supported persistence back to atomic local Operations.
- Added independent Figma structured clipboard Draft import, SVG/PNG IMAGE fallbacks, provenance, Loss Reports, semantic Draft diff, and selected current-revision merge compilation.
- Added deterministic PNG plus JSON evidence from one projection. Review remains external; collaboration, comments, MCP, plugins, remote history, and built-in AI Chat are disabled by default in the SmallPen capability profile.
