---
name: smallpen-animation-assets
description: Prepare named artwork, separated visual assets and canvas layouts in SmallPen for use by animation tools such as HyperFrames. Use when the deliverable is an animation asset pack or source layout, rather than a rendered video.
---

# SmallPen Animation Assets

Prepare the requested visual source material for downstream animation. SmallPen supplies design and media artifacts; the consuming tool owns the timeline, audio and final video render.

## Agree on the handoff

Use the supplied animation brief. Ask only about missing information that affects the assets: the consumer, canvas dimensions or aspect ratio, style, scene roles, independently moving parts, required transparency and deliverable format.

Identify which parts must move or be replaced separately. Preserve supplied artwork and branding. A background, character, prop, title and accent are possible roles, not a required asset checklist. Do not expand a request for a few assets into a complete video project.

## Build the sources

Inspect existing Tokens, components and media. Reuse definitions for repeated colors, typography, titles or badges when useful. Keep independently moving elements as separate named nodes or media assets rather than flattening the entire scene into one image.

Use available image-generation or drawing tools when new artwork is needed, then import individual outputs with the CLI. Preserve original transparent source files where supplied. Do not promise transparent crop export, vector export or arbitrary layer replacement without verifying the installed tool's capabilities.

Place the assets on a named source canvas with agreed bounds, scale and positions. Use reusable components and variants for repeated visual elements. Token groups may represent useful style alternatives; they do not define a video timeline or arbitrary scene changes.

If prototype triggers or page transitions are part of the request, configure them through `flow` and test explicit steps. Their stored animation settings are not a rendered-video proof and are not automatically a HyperFrames timeline.

## Export and check the handoff

Use the caller's CLI path or `smallpen` on PATH. Read `help OBJECT ACTION` and its exact input schema before writing. Store JSON inputs in files and discover IDs before updating. For a new source package, the current initializer's business Brief may be a tool gap; do not fabricate application requirements to conceal it.

Check organization with compact text or wireframes. Inspect image output only with an image-capable tool. Validate the requested target and read skipped coverage. For requested alternatives, pass the same explicit `--theme GROUP/OPTION` combination to view, validation and export; omitted groups use project defaults, not a remembered App or CLI selection.

Export each needed asset or region with a stable output name and `--output`, keeping final deliverables in one directory. Check actual pixel dimensions and any required alpha channel. If the output cannot preserve the required format or transparency, report the concrete limit and provide supported source assets where available; do not present a flattened screenshot as separated layers.

Write a concise handoff index with file paths, roles, pixel dimensions, and canvas bounds/positions or intended anchors where the consumer needs them. Record relevant revisions, hashes and selected alternatives from actual outputs. Use the consumer's existing format when one is supplied; do not invent a universal interchange schema.

Deliver the package and agreed source files. State which animation work remains in the downstream tool. No other SmallPen skill, HyperFrames plugin or external account is required just to prepare this asset pack.
