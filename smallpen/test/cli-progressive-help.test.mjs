import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { COMMAND_CONTRACTS } from "../apps/cli/bin/command-contract.mjs";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
} from "../apps/cli/bin/command-tree.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
async function run(argv, code = 0) {
  // These semantic checks request complete values; file transport has its own integration tests.
  if (argv.includes("--full") && !argv.includes("--stdout"))
    argv = [...argv, "--stdout"];
  let result;
  try {
    result = {
      code: 0,
      ...(await promisify(execFile)(process.execPath, [cli, ...argv])),
    };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.equal(result.code, code, result.stdout || result.stderr);
  return {
    ...result,
    bytes: Buffer.byteLength(result.stdout),
    value: argv.includes("--json") ? JSON.parse(result.stdout) : undefined,
  };
}

test("the ordinary entry point lists commands and lets AI discover one command or workflow stage at a time", async () => {
  for (const argv of [[], ["--help"], ["help", "--json"]]) {
    const reply = await run(argv);
    assert.ok(reply.bytes < 8192, `${argv}: ${reply.bytes} bytes`);
    assert.doesNotMatch(
      reply.stdout,
      /Worked example|inverseBatchPath|context_values_deprecated/,
    );
    if (reply.value) {
      assert.ok(
        reply.value.commands.some(({ command }) => command === "project"),
      );
      assert.equal(reply.value.workflow, undefined);
    }
  }
});

test("technical rules expand only the requested topic; workflow is a compatibility alias", async () => {
  const index = await run(["help", "rules", "--json"]);
  assert.ok(index.bytes < 2560, `${index.bytes} bytes`);
  for (const rule of index.value.rules) {
    const detail = await run(rule.nextOperations[0].argv);
    assert.equal(detail.value.id, rule.id);
    assert.equal(detail.value.rules, undefined);
    assert.ok(detail.bytes < 3072, `${rule.id}: ${detail.bytes} bytes`);
    assert.ok(detail.value.notes.length);
  }
  const alias = await run(["help", "workflow", "--json"]);
  assert.deepEqual(alias.value, index.value);
  const manual = await run(["help", "rules", "--full", "--json"]);
  assert.equal(manual.value.selection.appStateIndependent, true);
  assert.equal(manual.value.stages, undefined);
});

test("command help includes conventional options; machine contracts remain separately queryable", async () => {
  // Top-level commands outside the groups (view, changes, export, ...).
  const topLevel = PUBLIC_COMMANDS.map(({ command }) => command).filter(
    (command) => !Object.hasOwn(COMMAND_GROUPS, command),
  );
  assert.ok(topLevel.includes("view") && topLevel.includes("schema"));
  for (const command of topLevel) {
    assert.ok(Object.hasOwn(COMMAND_CONTRACTS, command), command);
    const reply = await run(["help", command, "--json"]);
    assert.equal(reply.value.command, command);
    assert.ok(reply.bytes < 2048, `${command}: ${reply.bytes} bytes`);
    assert.equal(reply.value.parameters, undefined);
    assert.equal(reply.value.guidance, undefined);
    assert.ok(reply.value.usage.includes(`smallpen ${command}`));
    assert.ok(
      reply.value.nextOperations.some(({ argv }) => argv[0] === "schema"),
    );
    assert.equal(reply.stdout, `${JSON.stringify(reply.value)}\n`);
    for (const query of reply.value.nextOperations) await run(query.argv);
    const text = await run([command, "--help"]);
    assert.match(text.stdout, /--help/, command);
  }
  // Public routes (group actions) follow the same help contract.
  for (const { actions } of Object.values(COMMAND_GROUPS)) {
    for (const { name } of Object.values(actions)) {
      const argv = name.split(" ");
      const reply = await run(["help", ...argv, "--json"]);
      assert.equal(reply.value.command, name);
      assert.ok(reply.bytes < 2048, `${name}: ${reply.bytes} bytes`);
      assert.equal(reply.value.parameters, undefined);
      assert.ok(reply.value.usage.includes(`smallpen ${name}`));
      for (const query of reply.value.nextOperations) await run(query.argv);
      const text = await run([...argv, "--help"]);
      assert.match(text.stdout, /--help/, name);
    }
  }
  // Flat engine names no longer run; the error names a grouped path.
  const groupedNames = new Set(
    Object.values(COMMAND_GROUPS).flatMap(({ actions }) =>
      Object.values(actions).map(({ name }) => name),
    ),
  );
  const engines = new Set(
    Object.values(COMMAND_GROUPS).flatMap(({ actions }) =>
      Object.values(actions).map(({ engine }) => engine),
    ),
  );
  for (const engine of engines) {
    if (topLevel.includes(engine)) continue;
    const { error } = (await run([engine, "--json"], 1)).value;
    assert.equal(error.code, "unknown_command", engine);
    assert.equal(error.writeState, "not-applied", engine);
    assert.ok(groupedNames.has(error.details.suggestion), engine);
    assert.ok(!error.details.validCommands.includes(engine), engine);
  }
  const complete = await run(["help", "theme", "add", "--full", "--json"]);
  assert.ok(complete.value.parameters.theme.required);
  assert.ok(!complete.value.parameters.intent);
});

test("common rules are individually discoverable instead of repeated in every help", async () => {
  const index = await run(["help", "rules", "--json"]);
  assert.ok(index.bytes < 2048);
  for (const rule of index.value.rules) {
    const detail = await run(rule.nextOperations[0].argv);
    assert.equal(detail.value.id, rule.id);
    assert.equal(detail.value.rules, undefined);
    assert.ok(detail.bytes < 3072);
  }
  const themes = (await run(["help", "rules", "themes", "--json"])).value;
  assert.ok(themes.notes.some((note) => note.includes("Project defaults")));
});

test("write routes name a small input query with fields and an example", async () => {
  const topics = Object.values(COMMAND_GROUPS).flatMap(({ actions }) =>
    Object.values(actions)
      .filter(({ topic }) => topic && topic !== "batch")
      .map(({ name, topic }) => ({ name, topic })),
  );
  assert.ok(topics.length >= 3);
  for (const { name, topic } of topics) {
    const reply = await run(["schema", topic, "--json"]);
    assert.ok(reply.bytes < 4096, `${topic}: ${reply.bytes} bytes`);
    assert.equal(reply.value.topic, topic);
    assert.ok(reply.value.command.startsWith(name), `${topic}: ${name}`);
    assert.ok(Object.keys(reply.value.fields).length, topic);
    assert.ok(reply.value.example, topic);
  }
});

test("schema directories paginate and omit operation fields until requested", async () => {
  for (const topic of ["commands", "operations"]) {
    const first = (await run(["schema", topic, "--limit", "1", "--json"]))
      .value;
    assert.equal(first[topic].length, 1);
    assert.equal(first.page.hasMore, true);
    assert.equal(first[topic][0].required, undefined);
    const second = (await run(first.nextOperations[0].argv)).value;
    assert.equal(second.page.offset, 1);
    const full = (await run(["schema", topic, "--full", "--json"])).value;
    assert.equal(full[topic].length, first.page.total);
  }
});

test("help rejects unknown or extra topics and returns a small recovery query", async () => {
  for (const argv of [
    ["help", "workflow", "unknown"],
    ["help", "rules", "unknown"],
    ["help", "theme", "unused"],
    ["help", "workflow", "tokens", "extra"],
  ]) {
    const error = (await run([...argv, "--json"], 1)).value.error;
    assert.equal(error.writeState, "not-applied");
    assert.ok(error.details.nextOperations.length);
    await run(error.details.nextOperations[0].argv);
  }
});
