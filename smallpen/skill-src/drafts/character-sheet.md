---
name: smallpen-character-sheet
description: Create and organize character reference sheets in SmallPen with separately named views, expressions and costume references. Use for character design handoff, turnaround sheets and consistency references for comics or animation.
---

# SmallPen Character Sheet

Produce an editable reference canvas whose individual views remain separate assets and named regions.

## Define the reference

Read the user's character brief and supplied reference images. Ask about missing identity traits, style, required views or expressions, costume alternatives and downstream use when they change the result. Agree on the needed views; front, three-quarter, side and back are examples, not a mandatory set.

Preserve approved proportions, face, hair, costume details and palette. Record unresolved traits and provisional choices. Ask about inconsistent source references rather than silently creating different character identities.

## Make and arrange the material

Use SmallPen for the canvas, named frames, editable labels, media placement and exports. If new raster artwork is needed, use an available image-generation or drawing tool and import its outputs through the CLI. The SmallPen CLI itself does not turn a character brief into painted pixels. If no suitable image tool is available, report that limitation and work with supplied artwork.

Keep each approved view or expression as an individual media asset. Arrange them on the reference canvas with clear names and comparable scale, such as `Mira/front/neutral/base-outfit`. Use the project's language and requested naming conventions. An overview montage may accompany these assets; it does not replace the independent views.

Use shared components or Tokens for useful repeated annotations, layout spacing or palette references. A new angle is image or geometry content, not merely a Token value. Do not force application navigation, Desktop/Mobile pages, theme groups or unused UI components into the reference.

## Inspect and deliver

Use the caller's CLI path or `smallpen` on PATH. Discover the needed operation with `help OBJECT ACTION`, then read the input schema it returns. Put JSON input in files. Discover existing IDs before editing. The current initializer requires a business Brief; report any requirement that has no valid meaning for a new reference canvas rather than fabricating application requirements.

Read named frame outlines or wireframes first to check organization. Inspect character images with image-capable tools to verify proportions, costume, palette and identity across views. CLI geometry checks cannot prove character consistency; a text-only model must not claim that visual review.

For each view or region, use the same target and any explicit `--theme GROUP/OPTION` combination for `view`, `validate` and `export`. Otherwise use project defaults. No previous CLI or App selection is carried over. Read actual selection and skipped coverage.

Deliver one package, a named view index and the needed individual files. Use `--output` for retained exports in one directory. Include the overview only when useful or requested. Report missing views or unresolved consistency issues. Do not claim to have completed a comic, animated performance or video from a character reference sheet. No other SmallPen skill must be installed.
