# smallpen

Command-line interface for SmallPen, a local-file design workspace. A
`.smallpen` package is a folder of HTML files that agents edit directly; the
CLI checks and renders them, resolves Tokens, exports deliverables and reports
what people changed in the App. Replies are JSON for agents.

Requires Node.js 24 or newer.

```sh
npm install -g smallpen
smallpen --help
smallpen init ./workspace --json
# edit the HTML files, then:
smallpen check ./workspace/workspace.smallpen
smallpen check ./workspace/workspace.smallpen --render
smallpen view ./workspace/workspace.smallpen --page Home --as png --json
```

Every command has its own help: `smallpen <command> --help`.

This package is a thin launcher for `@smallpen/cli`, which holds the
implementation.
