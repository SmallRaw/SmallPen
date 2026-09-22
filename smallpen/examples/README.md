# Common components review package

`common-components.smallpen` extends the previous review package without changing it. It stores canonical Tokens, component definitions and an ordinary composed screen; the Design System sheet is generated at load time, never saved as a second copy of those shapes.

## Contents

| Family | Source variants | Light + Dark samples |
| --- | ---: | ---: |
| Card (existing) | 2 | 4 |
| Button | 3 styles × 4 contents × 4 states = 48 | 96 |
| Title | page / section / dialog = 3 | 6 |
| Input | default / focus / error = 3 | 6 |
| Badge | neutral / success / danger = 3 | 6 |
| Dialog | confirm / form = 2 | 4 |
| Total | 61 | 122 |

Button contents are text-only, leading icon, trailing icon and icon-only. States are default, hover, pressed and disabled. These are drawn state specimens, not executable browser controls. Dialog is a real composite of Title, Input and Button instances. Added colors and typography are Token-bound and resolve separately for Light and Dark. Existing Card definitions are preserved, including their existing literal fills.

`Composition example · Desktop` is an ordinary screen containing instances of the same definitions. Its Save changes button uses a local text override; the Button source still says Continue. Pages is the composition overview, not another component family.

## Rebuild and serve

From `smallpen/`, with an existing Design System fixture/review package:

```sh
node scripts/build-common-components-demo.mjs SOURCE_PACKAGE NEW_DESTINATION
node apps/cli/bin/smallpen.mjs validate NEW_DESTINATION --json
node e2e/_serve-dse-delivery.mjs NEW_DESTINATION 43129
```

The builder validates before writing and refuses to overwrite an existing destination. The demo assumes the base fixture's color/light, color/dark, radius/md and typography/md Token IDs. No dependencies are installed.

## Verification (2026-09-22)

- Package validation: valid, no warnings.
- SmallPen suite: 434 tests passed, no failures.
- Browser: composed screen and Light/Dark form Dialog render with complete nested text/fields/buttons.
- Fixed Web conversion of nested component definitions and generated samples; canonical entries remain unchanged by projection. Generated sheet edits retain the occurrence-aware mapping. Derived children on the separate native Components page do not acquire unsafe direct canonical write mappings.
