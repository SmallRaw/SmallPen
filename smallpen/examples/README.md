# Common components package

`common-components.smallpen` is a complete SmallPen package written in the
HTML format ([HTML-FORMAT.md](../docs/HTML-FORMAT.md)). Open any file in an
editor: `tokens.css` holds the Tokens and their Light and Dark options,
`components/<Name>.html` one component each and
`pages/Showcase/*.html` the pages. The Design
System sheet is drawn from these files when the package opens; it is never
saved as a second copy.

## Contents

| Family | Source variants | Light + Dark samples |
| --- | ---: | ---: |
| Card | 2 | 4 |
| Button | 3 styles × 4 contents × 4 states = 48 | 96 |
| Title | page / section / dialog = 3 | 6 |
| Input | default / focus / error = 3 | 6 |
| Badge | neutral / success / danger = 3 | 6 |
| Dialog | confirm / form = 2 | 4 |
| Total | 61 | 122 |

Button contents are text only, leading icon, trailing icon and icon only.
States are default, hover, pressed and disabled; they are drawn states, not
working browser controls. Dialog is built from Title, Input and Button
copies. Colors and type use Tokens and resolve separately in Light and Dark.

`pages/Showcase/Composition example.html` is an ordinary page made of copies
of the same components. Its Save button overrides the Label part; the Button
component still says Continue. Text uses the bundled Source Sans Pro, so
`check --render` measures it with the font the App draws.

## Try it

From `smallpen/`, work on a copy so the example stays as it is:

```sh
cp -R examples/common-components.smallpen /tmp/demo.smallpen
node apps/cli/bin/smallpen.mjs check /tmp/demo.smallpen --render
node apps/cli/bin/smallpen.mjs view /tmp/demo.smallpen --page "Showcase/Composition example"
node apps/cli/bin/smallpen.mjs export /tmp/demo.smallpen --page "Showcase/Composition example" --format png --output /tmp/demo.png
```

Edit a file, run `check` again, and `check --revert` puts back any file it
rejects. To open the copy in the App, see the Browser editor section of the
[README](../README.md).
