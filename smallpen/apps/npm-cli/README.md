# smallpen

Command-line interface for SmallPen, a local-file design workspace built on
strict `.smallpen` directory packages. It reads, validates, renders, and
edits packages through typed Operation Batches, with JSON output for agents.

Requires Node.js 24 or newer.

```sh
npm install -g smallpen@alpha
smallpen --help
# Guided: answer each returned question with its continuation command.
smallpen init ./workspace --json
smallpen validate ./workspace/product.smallpen --json
smallpen render ./workspace/product.smallpen --output product.png --json
```

Every command has its own help: `smallpen <command> --help`.

This package is a thin launcher for `@smallpen/cli`, which holds the
implementation.
