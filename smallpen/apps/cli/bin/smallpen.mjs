#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  canonicalJSON,
  compileDraftMerge,
  createCatalog,
  createCompareView,
  createInitializationState,
  diffDrafts,
  designTokenWarningsForBatch,
  draftFromSnapshot,
  explainEffectiveToken,
  importTokens,
  listEffectiveTokens,
  readDesignView,
  prepareOperationBatch,
  resolveEffectiveToken,
  searchEffectiveTokens,
  SmallPenError,
  SMALLPEN_FORMAT_CAPABILITIES,
} from "@smallpen/core";
import {
  applyOperationBatch,
  createEvidence,
  defaultLibraryCacheRoot,
  importDraft,
  importFontVariant,
  importMedia,
  initializeWorkspace,
  inspectFont,
  inspectMedia,
  openPackage,
  openRemoteLibrary,
  openWorkspace,
  removeMedia,
  replayRecordedBatch,
  resolveWorkspace,
  sfntToWoff,
} from "@smallpen/local-package";

import { COMMAND_NAMES, printHelp } from "./help.mjs";
import { warningOutput } from "./warning-output.mjs";

const FLAG_OPTIONS = new Set([
  "--apply",
  "--base64",
  "--confirm",
  "--confirm-unmatched",
  "--diff",
  "--dry-run",
  "--explain",
  "--help",
  "--include-image",
  "--json",
  "-h",
]);
const COMMAND_OPTIONS = {
  version: ["--json"],
  apply: ["--batch", "--confirm-unmatched", "--diff", "--dry-run", "--explain", "--json", "--warning-detail"],
  catalog: ["--context", "--json"],
  component: ["--component-id", "--json"],
  compare: ["--json", "--selector"],
  discover: [
    "--context",
    "--context-profile",
    "--format",
    "--json",
    "--limit",
    "--locale",
    "--offset",
    "--presentation",
    "--scenario",
    "--screen",
  ],
  "draft-compile": ["--batch-id", "--draft", "--json", "--selections"],
  "draft-diff": ["--after", "--json"],
  "effective-token": ["--context", "--json", "--package-id", "--token-id"],
  evidence: [
    "--context",
    "--context-profile",
    "--format",
    "--json",
    "--output",
    "--presentation",
    "--scale",
    "--scenario",
    "--screen",
  ],
  "inspect-view": [
    "--base64",
    "--context",
    "--context-profile",
    "--include-image",
    "--json",
    "--locale",
    "--output",
    "--presentation",
    "--scale",
    "--scenario",
    "--screen",
  ],
  "render-matrix": ["--contexts", "--json", "--output", "--scale"],
  impact: ["--json", "--package-id", "--path", "--token-id"],
  flow: ["--batch-id", "--confirm-unmatched", "--diff", "--dry-run", "--explain", "--intent", "--json", "--warning-detail"],
  page: ["--batch-id", "--confirm-unmatched", "--diff", "--dry-run", "--explain", "--intent", "--json", "--warning-detail"],
  token: ["--batch-id", "--confirm-unmatched", "--diff", "--dry-run", "--explain", "--intent", "--json", "--warning-detail"],
  "explain-token": ["--context", "--json", "--package-id", "--token-id"],
  init: ["--answer", "--answers", "--confirm", "--json", "--locale", "--state"],
  "import-draft": ["--input", "--json", "--kind", "--package-id"],
  "import-tokens": [
    "--apply",
    "--batch-id",
    "--dry-run",
    "--input",
    "--json",
    "--select",
    "--set-name",
  ],
  inspect: ["--json"],
  "import-font": [
    "--family",
    "--file",
    "--font-id",
    "--json",
    "--media-path",
    "--name",
    "--style",
    "--variant-id",
    "--weight",
  ],
  "import-media": ["--file", "--json", "--media-id", "--media-path", "--name"],
  "library-refresh": ["--interval", "--json", "--library", "--max-events"],
  watch: ["--interval", "--json", "--max-events"],
  list: ["--json", "--kind", "--limit", "--offset"],
  read: ["--json"],
  "remove-media": ["--json", "--media-id"],
  "read-view": [
    "--context",
    "--context-profile",
    "--format",
    "--json",
    "--limit",
    "--locale",
    "--offset",
    "--presentation",
    "--scenario",
    "--screen",
  ],
  render: [
    "--context",
    "--context-profile",
    "--format",
    "--json",
    "--output",
    "--presentation",
    "--scale",
    "--scenario",
    "--screen",
  ],
  repair: [
    "--action",
    "--asset",
    "--asset-kind",
    "--batch-id",
    "--conflict",
    "--foundation",
    "--json",
    "--replacement-asset-id",
    "--replacement-package-id",
  ],
  "search-components": ["--json", "--limit", "--query"],
  "search-tokens": [
    "--color",
    "--context",
    "--json",
    "--limit",
    "--query",
    "--type",
    "--value",
  ],
  tokens: ["--context", "--json"],
  validate: ["--json"],
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new SmallPenError(
      "missing_option_value",
      `${name} requires a value`,
      { option: name },
    );
  }
  return value;
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new SmallPenError(
        "missing_option_value",
        `${name} requires a value`,
        { option: name },
      );
    }
    values.push(value);
  }
  return values;
}

function flag(args, name) {
  return args.includes(name);
}

function validateCommandArguments(command, args) {
  const allowed = new Set([
    ...(COMMAND_OPTIONS[command] ?? []),
    "--help",
    "-h",
  ]);
  for (let index = 2; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("-")) {
      throw new SmallPenError(
        "unexpected_argument",
        `Unexpected positional argument: ${value}`,
        { argument: value, command },
      );
    }
    if (!allowed.has(value)) {
      throw new SmallPenError("unknown_option", `Unknown option: ${value}`, {
        command,
        option: value,
        validOptions: [...allowed].sort(),
      });
    }
    if (!FLAG_OPTIONS.has(value)) index += 1;
  }
}

function parseJson(source, code, details = {}) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SmallPenError(code, `Invalid JSON: ${error.message}`, details);
  }
}

function contextSelection(args) {
  return Object.fromEntries(
    options(args, "--context").map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new SmallPenError(
          "invalid_context_argument",
          "--context requires AXIS_ID=VALUE_ID",
          { value },
        );
      }
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

function integerOption(args, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new SmallPenError(
      "invalid_integer_option",
      `${name} requires an integer from 0 through ${maximum}`,
      { maximum, name, value },
    );
  }
  return parsed;
}

function numberOption(args, name, fallback) {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new SmallPenError(
      "invalid_number_option",
      `${name} requires a finite number`,
      { name, value },
    );
  }
  return parsed;
}

function designSelector(args, viewFormat) {
  return {
    ...(options(args, "--context").length > 0
      ? { context: contextSelection(args) }
      : {}),
    ...(option(args, "--context-profile")
      ? { contextProfileId: option(args, "--context-profile") }
      : {}),
    ...(viewFormat ?? option(args, "--format")
      ? { viewFormat: viewFormat ?? option(args, "--format") }
      : {}),
    ...(option(args, "--presentation")
      ? { presentationId: option(args, "--presentation") }
      : {}),
    ...(option(args, "--scenario")
      ? { scenarioId: option(args, "--scenario") }
      : {}),
    ...(option(args, "--screen")
      ? { screenId: option(args, "--screen") }
      : {}),
  };
}

function printJson(value) {
  process.stdout.write(
    `${JSON.stringify(
      value,
      (_key, child) =>
        child instanceof Map
          ? Object.fromEntries(
              [...child.entries()].sort(([left], [right]) =>
                String(left).localeCompare(String(right)),
              ),
            )
          : child,
      2,
    )}\n`,
  );
}

function inspect(snapshot) {
  return {
    annotations: [...snapshot.domain.annotations.values()],
    components: [
      ...[...snapshot.domain.componentSets.values()].map(
        ({ axes, deprecated, id, name, variants, visibility }) => ({
          axes,
          deprecated,
          id,
          kind: "set",
          name,
          variants: variants.map(({ id: variantId, selection }) => ({
            id: variantId,
            selection,
          })),
          visibility,
        }),
      ),
      ...[...snapshot.domain.locatedComponents.values()].map(
        ({ id, mainNodeId, name, path, presentationId, screenId }) => ({
          id,
          kind: "located",
          mainNodeId,
          name,
          path,
          presentationId,
          screenId,
        }),
      ),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    contexts: {
      axes: [...snapshot.domain.contextAxes.values()],
      profiles: [...snapshot.domain.contextProfiles.values()],
    },
    draft: snapshot.manifest.draft
      ? structuredClone(snapshot.manifest.draft)
      : undefined,
    flows: [...snapshot.domain.flows.values()],
    formatCapabilities: SMALLPEN_FORMAT_CAPABILITIES,
    guidance: {
      beforeDesigning: [
        {
          args: {
            packagePath: snapshot.locator,
            query: "<intended-component-name-or-purpose>",
          },
          operation: "smallpen.search-components",
        },
        {
          args: {
            packagePath: snapshot.locator,
            value: "<intended-style-value>",
          },
          operation: "smallpen.search-tokens",
        },
      ],
      stateless: true,
    },
    package: {
      dependencies: structuredClone(snapshot.manifest.dependencies ?? []),
      id: snapshot.manifest.packageId,
      name: snapshot.manifest.name,
      revision: snapshot.revision,
      role: snapshot.manifest.role,
    },
    requirements: [...snapshot.domain.requirements.values()],
    scenarios: [...snapshot.domain.scenarios.values()],
    screens: snapshot.manifest.entries.screens.map((entry) => {
      const screen = snapshot.entries[entry];
      return {
        basePresentationId: screen.basePresentationId,
        id: screen.id,
        name: screen.name,
        presentations: screen.presentations.map((presentation) => ({
          id: presentation.id,
          name: presentation.name,
          nodeCount: Object.keys(presentation.nodes).length,
          rootId: presentation.rootId,
        })),
      };
    }),
    tokens: [...snapshot.domain.tokens.values()].map(
      ({ contextValues, id, overrideOf, path, type, visibility }) => ({
        contextValues,
        id,
        overrideOf,
        path,
        type,
        visibility,
      }),
    ),
  };
}

function listDomain(snapshot, kind) {
  const groups = {
    components: [
      ...snapshot.domain.componentSets.values(),
      ...snapshot.domain.locatedComponents.values(),
    ],
    contexts: [
      ...snapshot.domain.contextAxes.values(),
      ...snapshot.domain.contextProfiles.values(),
    ],
    flows: [...snapshot.domain.flows.values()],
    presentations: snapshot.manifest.entries.screens.flatMap((entry) =>
      snapshot.entries[entry].presentations.map((presentation) => ({
        ...presentation,
        nodes: undefined,
        screenId: snapshot.entries[entry].id,
      })),
    ),
    requirements: [...snapshot.domain.requirements.values()],
    scenarios: [...snapshot.domain.scenarios.values()],
    screens: snapshot.manifest.entries.screens.map(
      (entry) => snapshot.entries[entry],
    ),
    tokens: [...snapshot.domain.tokens.values()],
  };
  if (kind === "all") {
    return Object.entries(groups).flatMap(([group, values]) =>
      values.map((value) => ({ group, item: value })),
    );
  }
  if (!Object.hasOwn(groups, kind)) {
    throw new SmallPenError("invalid_list_kind", `Unknown list kind: ${kind}`, {
      validValues: ["all", ...Object.keys(groups)],
    });
  }
  return groups[kind].map((item) => ({ group: kind, item }));
}

async function tokenWorkspace(packagePath) {
  const workspace = await openWorkspace(packagePath, {
    libraryCacheRoot: defaultLibraryCacheRoot(),
  });
  return {
    foundation: workspace.foundation,
    libraries: workspace.libraries ?? [],
    product: workspace.product,
  };
}

function resolveCliWorkspace(packagePath) {
  return resolveWorkspace(packagePath, {
    libraryCacheRoot: defaultLibraryCacheRoot(),
  });
}

async function tokenAdviceWorkspace(packagePath) {
  const resolution = await resolveCliWorkspace(packagePath);
  if (resolution.status === "ready") return resolution.workspace;
  return {
    foundation: resolution.foundation,
    product: resolution.product,
  };
}

function workspaceRevisions(product, foundation, libraries = []) {
  return {
    ...(foundation ? { foundationRevision: foundation.revision } : {}),
    ...(libraries.length > 0
      ? {
          libraryRevisions: Object.fromEntries(
            libraries.map((library) => [
              library.manifest.packageId,
              library.revision,
            ]),
          ),
        }
      : {}),
    productRevision: product.revision,
    revision: product.revision,
  };
}

function tokenReference(args, product) {
  const assetId = option(args, "--token-id");
  if (!assetId) {
    throw new SmallPenError(
      "missing_token_id",
      "Token read requires --token-id TOK",
      { nextOperations: [{ operation: "smallpen.tokens", args: {} }] },
    );
  }
  return {
    assetId,
    packageId: option(args, "--package-id") ?? product.manifest.packageId,
  };
}

async function writeAtomic(path, value) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.smallpen-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value);
    await rename(temporary, output);
    return output;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// SP-042/SP-043: every write supports an explain/diff preview computed from the
// same prepared candidate that the atomic write would use; nothing is written.
const EXPLAIN_TARGET_FIELDS = [
  "assetId",
  "componentSetId",
  "entry",
  "field",
  "mediaId",
  "nodeId",
  "presentationId",
  "screenId",
  "tokenId",
  "type",
  "variantId",
];

function explainBatch(before, prepared, batch) {
  const explain = (batch.operations ?? []).map((operation, index) => {
    const target = Object.fromEntries(
      EXPLAIN_TARGET_FIELDS.filter((field) => operation[field] !== undefined).map(
        (field) => [field, operation[field]],
      ),
    );
    return { index, type: operation.type, target };
  });
  const diff = [
    ...prepared.result.changedFiles.map((entry) => {
      const beforeEntry = before.entries[entry];
      const afterEntry = prepared.snapshot.entries[entry];
      if (beforeEntry === undefined || afterEntry === undefined) {
        return { entry, replaced: true };
      }
      const changes = {};
      for (const key of new Set([
        ...Object.keys(beforeEntry),
        ...Object.keys(afterEntry),
      ])) {
        const beforeValue = beforeEntry[key];
        const afterValue = afterEntry[key];
        if (
          JSON.stringify(beforeValue ?? null) !==
          JSON.stringify(afterValue ?? null)
        ) {
          changes[key] = {
            after: afterValue ?? null,
            before: beforeValue ?? null,
          };
        }
      }
      return { changes, entry };
    }),
    ...prepared.result.deletedFiles.map((entry) => ({ deleted: true, entry })),
  ];
  return { diff, explain };
}

async function applyBatch(packagePath, batch, args) {
  const detail = option(args, "--warning-detail") ?? "compact";
  if (!["compact", "full"].includes(detail)) {
    throw new SmallPenError("invalid_warning_detail", "--warning-detail must be compact or full", {
      validValues: ["compact", "full"],
    });
  }
  if (batch.blobs !== undefined) {
    throw new SmallPenError(
      "invalid_blob_writes",
      "CLI Operation Batch JSON cannot contain binary blob writes",
    );
  }
  // 通用 apply 仍然能修复处于 Repair 的 Product；Token 建议不能变成写入门禁。
  const { foundation, product } = await tokenAdviceWorkspace(packagePath);
  let prepared;
  try {
    prepared = await prepareOperationBatch(product, batch);
  } catch (error) {
    if (error?.code === "stale_revision") {
      const replayed = await replayRecordedBatch(packagePath, batch);
      if (replayed) return replayed;
    }
    throw error;
  }
  const warnings = designTokenWarningsForBatch(prepared.snapshot, batch, {
    foundation,
  });
  // Import warnings have their own schema and are not design-style advice.
  const advice = args[0] === "import-tokens"
    ? { warnings }
    : warningOutput(warnings, detail, { confirmUnmatched: flag(args, "--confirm-unmatched") });
  if (flag(args, "--explain") || flag(args, "--diff")) {
    // explain/diff are read-only previews in any combination; neither flag
    // writes, with or without --dry-run (CLI-AI-TOPIC: "explain and diff
    // never write").
    return {
      ...prepared.result,
      ...explainBatch(product, prepared, batch),
      dryRun: true,
      ...advice,
    };
  }
  if (flag(args, "--dry-run")) {
    return { ...prepared.result, dryRun: true, ...advice };
  }
  return {
    ...(await applyOperationBatch(packagePath, batch)),
    ...advice,
  };
}

function searchValue(args) {
  const color = option(args, "--color");
  const source = option(args, "--value");
  if (color !== undefined && source !== undefined) {
    throw new SmallPenError(
      "ambiguous_token_search_value",
      "search-tokens accepts only one of --color or --value",
    );
  }
  if (color !== undefined) return { type: "color", value: color };
  if (source === undefined) return {};
  try {
    return { value: JSON.parse(source) };
  } catch {
    return { value: source };
  }
}

async function readOptionalJson(path) {
  try {
    return parseJson(
      await readFile(path, "utf8"),
      "invalid_initialization_state",
      { path },
    );
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function answerArguments(args) {
  return Object.fromEntries(
    options(args, "--answer").map((source) => {
      const separator = source.indexOf("=");
      if (separator <= 0 || separator === source.length - 1) {
        throw new SmallPenError(
          "invalid_initialization_answer_argument",
          "--answer requires QUESTION_ID=JSON",
          { value: source },
        );
      }
      const id = source.slice(0, separator);
      return [
        id,
        parseJson(
          source.slice(separator + 1),
          "invalid_initialization_answer_json",
          { questionId: id },
        ),
      ];
    }),
  );
}

async function interactiveInitialization(answersValue, statePath, locale) {
  const answers = structuredClone(answersValue);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let state = createInitializationState(answers, { locale, statePath });
    while (state.status === "needs_input") {
      const question = state.nextQuestion;
      process.stdout.write(`\n${question.reason}\n`);
      const recommendation = JSON.stringify(question.recommendation);
      let accepted = false;
      while (!accepted) {
        const raw = await terminal.question(
          `${question.label} [${recommendation}]: `,
        );
        let value;
        try {
          value =
            raw.trim().length === 0
              ? structuredClone(question.recommendation)
              : question.schema.type === "string"
                ? raw.trim()
                : parseJson(
                    raw,
                    "invalid_initialization_answer_json",
                    { questionId: question.id },
                  );
          const candidate = { ...answers, [question.id]: value };
          state = createInitializationState(candidate, { locale, statePath });
          Object.assign(answers, candidate);
          accepted = true;
        } catch (error) {
          process.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      await writeAtomic(
        statePath,
        canonicalJSON(
          state.status === "proposal"
            ? {
                answers: state.proposal.brief,
                proposal: state.proposal,
                status: state.status,
              }
            : { answers: state.answers, status: state.status },
        ),
      );
    }
    const answer = await terminal.question(
      `\nCreate ${state.proposal.packages.foundation.directoryName} and ${state.proposal.packages.product.directoryName}? [y/N]: `,
    );
    return {
      confirmed: /^y(?:es)?$/i.test(answer.trim()),
      state,
    };
  } finally {
    terminal.close();
  }
}

async function initializeCommand(workspacePath, args) {
  const explicitStatePath = option(args, "--state");
  const statePath = resolve(
    explicitStatePath ?? `${resolve(workspacePath)}.smallpen-init.json`,
  );
  // 只有调用者显式传回 --state 才恢复事务，普通调用永远从无状态输入开始。
  const persisted = explicitStatePath ? await readOptionalJson(statePath) : {};
  if (!isRecord(persisted)) {
    throw new SmallPenError(
      "invalid_initialization_state",
      "Initialization state must contain an object",
      { path: statePath },
    );
  }
  let fileAnswers = {};
  const answersPath = option(args, "--answers");
  if (answersPath) {
    fileAnswers = parseJson(
      await readFile(answersPath, "utf8"),
      "invalid_initialization_answers_json",
      { path: answersPath },
    );
  }
  const answers = {
    ...(persisted.answers ?? {}),
    ...fileAnswers,
    ...answerArguments(args),
  };
  const locale = option(args, "--locale") ?? "zh-TW";
  let state = createInitializationState(answers, {
    locale,
    statePath,
  });
  let interactiveConfirmation = false;
  if (!flag(args, "--json") && process.stdin.isTTY && process.stdout.isTTY) {
    const interactive = await interactiveInitialization(
      state.status === "needs_input" ? state.answers : state.proposal.brief,
      statePath,
      locale,
    );
    state = interactive.state;
    interactiveConfirmation = interactive.confirmed;
  }
  const stateDocument =
    state.status === "proposal"
      ? { answers: state.proposal.brief, proposal: state.proposal, status: state.status }
      : { answers: state.answers, status: state.status };
  await writeAtomic(statePath, canonicalJSON(stateDocument));
  if (state.status === "needs_input") {
    state.nextQuestion.continuation.args[1] = resolve(workspacePath);
    state.nextQuestion.continuation.args.push("--locale", locale);
    return { ...state, statePath };
  }
  const confirmation = {
    args: [
      "init",
      resolve(workspacePath),
      "--state",
      statePath,
      "--confirm",
      "--json",
      "--locale",
      locale,
    ],
    operation: "smallpen.init.confirm",
  };
  if (!flag(args, "--confirm") && !interactiveConfirmation) {
    return { ...state, confirmation, statePath };
  }
  const initialized = await initializeWorkspace(workspacePath, state.proposal, {
    confirmed: true,
  });
  await writeAtomic(
    statePath,
    canonicalJSON({
      answers: state.proposal.brief,
      initialized,
      proposal: state.proposal,
      status: "initialized",
    }),
  );
  return { ...initialized, statePath };
}

async function deliverImage(
  bundle,
  { product, foundation, libraries },
  output,
  includeBase64 = false,
) {
  return {
    diagnostics: bundle.render.diagnostics,
    height: bundle.render.height,
    mimeType: bundle.render.mimeType,
    packageId: product.manifest.packageId,
    renderHash: bundle.render.renderHash,
    ...workspaceRevisions(product, foundation, libraries),
    selection: bundle.evidence.selector,
    width: bundle.render.width,
    ...(output === undefined
      ? {}
      : { output: await writeAtomic(output, bundle.render.bytes) }),
    ...(output === undefined || includeBase64
      ? { base64: Buffer.from(bundle.render.bytes).toString("base64") }
      : {}),
  };
}

async function renderCommand(packagePath, args, evidenceOnly) {
  const requestedFormat = option(args, "--format");
  if (requestedFormat && requestedFormat !== "screenshot") {
    throw new SmallPenError(
      "invalid_render_format",
      "render and evidence only accept --format screenshot",
      { validValues: ["screenshot"] },
    );
  }
  const workspace = await tokenWorkspace(packagePath);
  const { foundation, libraries, product } = workspace;
  const bundle = await createEvidence(product, {
    foundation,
    libraries,
    scale: numberOption(args, "--scale", 1),
    selector: designSelector(args, "screenshot"),
  });
  const output = option(args, "--output");
  if (evidenceOnly && output !== undefined) {
    const imagePath = await writeAtomic(`${output}.png`, bundle.render.bytes);
    const evidencePath = await writeAtomic(
      `${output}.json`,
      canonicalJSON({
        ...bundle.evidence,
        ...workspaceRevisions(product, foundation, libraries),
      }),
    );
    return {
      ...bundle.evidence,
      ...workspaceRevisions(product, foundation, libraries),
      evidencePath,
      imagePath,
    };
  }
  const image = await deliverImage(bundle, workspace, output);
  return evidenceOnly
    ? {
        ...bundle.evidence,
        ...workspaceRevisions(product, foundation, libraries),
        image,
      }
    : image;
}

async function inspectViewCommand(packagePath, args) {
  const output = option(args, "--output");
  if (
    !flag(args, "--include-image") &&
    (output !== undefined || flag(args, "--base64"))
  ) {
    throw new SmallPenError(
      "missing_include_image",
      "--output and --base64 require --include-image; omit --output for an inline image without image files",
    );
  }
  const workspace = await tokenWorkspace(packagePath);
  const { foundation, libraries, product } = workspace;
  const selector = designSelector(args);
  const semantic = readDesignView(product, {
    foundation,
    libraries,
    locale: option(args, "--locale") ?? "zh-TW",
    selector: { ...selector, viewFormat: "semantic" },
  });
  const wireframe = readDesignView(product, {
    foundation,
    libraries,
    locale: option(args, "--locale") ?? "zh-TW",
    selector: { ...selector, viewFormat: "wireframe" },
  });
  const context = semantic.selection.context;
  const result = {
    components: createCatalog(product, { context, foundation, libraries })
      .components,
    packageId: product.manifest.packageId,
    ...workspaceRevisions(product, foundation, libraries),
    selection: semantic.selection,
    semanticTree: semantic.result,
    tokens: listEffectiveTokens(product, { context, foundation, libraries }),
    wireframe: wireframe.result,
  };
  if (flag(args, "--include-image")) {
    const bundle = await createEvidence(product, {
      foundation,
      libraries,
      scale: numberOption(args, "--scale", 1),
      selector: designSelector(args, "screenshot"),
    });
    result.image = await deliverImage(
      bundle,
      workspace,
      output,
      flag(args, "--base64"),
    );
  }
  return result;
}

async function renderMatrixCommand(packagePath, args) {
  const contextsPath = option(args, "--contexts");
  if (!contextsPath) {
    throw new SmallPenError(
      "missing_render_contexts",
      "render-matrix requires --contexts CONTEXTS.json",
    );
  }
  const contexts = parseJson(
    await readFile(contextsPath, "utf8"),
    "invalid_render_contexts_json",
    { path: contextsPath },
  );
  if (
    !Array.isArray(contexts) ||
    contexts.length === 0 ||
    contexts.length > 32
  ) {
    throw new SmallPenError(
      "invalid_render_contexts",
      "contexts must be an array containing 1 through 32 selectors",
    );
  }
  const workspace = await tokenWorkspace(packagePath);
  const { foundation, libraries, product } = workspace;
  const outputDirectory = option(args, "--output");
  const scale = numberOption(args, "--scale", 1);
  const images = [];
  for (const [index, selector] of contexts.entries()) {
    if (!isRecord(selector)) {
      throw new SmallPenError(
        "invalid_render_selector",
        "Each context selector must be an object",
        {
          index,
        },
      );
    }
    const bundle = await createEvidence(product, {
      foundation,
      libraries,
      scale,
      selector: { ...selector, viewFormat: "screenshot" },
    });
    const output =
      outputDirectory === undefined
        ? undefined
        : join(
            outputDirectory,
            `${String(index + 1).padStart(2, "0")}-${bundle.render.renderHash.slice(0, 12)}.png`,
          );
    images.push(await deliverImage(bundle, workspace, output));
  }
  return {
    count: images.length,
    images,
    packageId: product.manifest.packageId,
    ...workspaceRevisions(product, foundation, libraries),
  };
}

function tokenImpact(snapshot, tokenId, packageId) {
  const locations = [];
  const visit = (value, location) => {
    if (!isRecord(value)) return;
    if (isRecord(value.tokenBindings)) {
      for (const [field, binding] of Object.entries(value.tokenBindings)) {
        if (
          isRecord(binding) &&
          binding.assetId === tokenId &&
          (binding.packageId === undefined || binding.packageId === packageId)
        ) {
          locations.push({ ...location, field });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "tokenBindings") visit(child, { ...location, key });
    }
  };
  for (const entry of snapshot.manifest.entries.screens) {
    const screen = snapshot.entries[entry];
    for (const presentation of screen.presentations ?? []) {
      for (const node of Object.values(presentation.nodes ?? {})) {
        visit(node, {
          kind: "screen-node",
          nodeId: node.id,
          presentationId: presentation.id,
          screenId: screen.id,
        });
      }
    }
  }
  for (const entry of snapshot.manifest.entries.components ?? []) {
    const componentFile = snapshot.entries[entry];
    for (const component of componentFile.componentSets ?? []) {
      for (const variant of component.variants ?? []) {
        for (const node of Object.values(variant.nodes ?? {})) {
          visit(node, {
            componentId: component.id,
            kind: "component-node",
            nodeId: node.id,
            variantId: variant.id,
          });
        }
      }
    }
  }
  return locations.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function componentDetails(snapshot, componentId) {
  const component = snapshot.domain.componentSets.get(componentId);
  if (!component) {
    const located = snapshot.domain.locatedComponents.get(componentId);
    return located ? { ...structuredClone(located), kind: "located" } : undefined;
  }
  return {
    id: component.id,
    kind: "set",
    name: component.name,
    category: component.category,
    description: component.description,
    deprecated: component.deprecated,
    visibility: component.visibility,
    replaces: component.replaces,
    replacement: component.replacement,
    axes: component.axes,
    variants: component.variants.map(({ id, name, selection, visibility }) => ({
      id,
      name,
      selection,
      visibility,
    })),
    scenarios: [...snapshot.domain.scenarios.values()]
      .filter(
        (scenario) =>
          scenario.target.kind === "component" &&
          scenario.target.component.assetId === componentId,
      )
      .map(({ id, name, target }) => ({ id, name, target }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function selectedRepairConflict(resolution, args) {
  const index = integerOption(args, "--conflict", 0, resolution.conflicts.length - 1);
  const selected = resolution.conflicts[index];
  if (!selected) {
    throw new SmallPenError(
      "missing_repair_conflict",
      "Selected Repair conflict does not exist",
      { conflictCount: resolution.conflicts.length, index },
    );
  }
  return { index, selected };
}

async function repairOperations(resolution, conflict, action, args) {
  const choice = conflict.choices.find((candidate) => candidate.action === action);
  if (!choice) {
    throw new SmallPenError(
      "repair_action_not_offered",
      `Repair action is not offered for this conflict: ${action}`,
      { action, choices: conflict.choices },
    );
  }
  if (action === "remove-dependent-usage") {
    return [
      {
        action,
        referencePath: choice.referencePath,
        type: "repair-reference",
      },
    ];
  }
  if (action === "retarget-reference") {
    const packageId = option(args, "--replacement-package-id");
    const assetId = option(args, "--replacement-asset-id");
    if (!packageId || !assetId) {
      throw new SmallPenError(
        "missing_repair_replacement",
        "retarget-reference requires replacement Package and asset IDs",
      );
    }
    return [
      {
        action,
        referencePath: choice.referencePath,
        replacement: { assetId, packageId },
        type: "repair-reference",
      },
    ];
  }
  if (action === "choose-foundation") {
    const foundationPath = option(args, "--foundation");
    if (!foundationPath) {
      throw new SmallPenError(
        "missing_foundation_path",
        "choose-foundation requires --foundation PATH",
      );
    }
    const foundation = await openPackage(foundationPath);
    if (foundation.manifest.role !== "foundation") {
      throw new SmallPenError(
        "dependency_not_foundation",
        "Selected Package does not have the Foundation role",
      );
    }
    const dependencyPath = relative(
      dirname(resolution.product.locator),
      foundation.locator,
    );
    if (
      dependencyPath === "" ||
      dependencyPath.startsWith("..") ||
      isAbsolute(dependencyPath)
    ) {
      throw new SmallPenError(
        "foundation_path_outside_workspace",
        "Selected Foundation must stay inside the Product workspace",
        { foundationPath: foundation.locator },
      );
    }
    return [
      {
        dependency: {
          packageId: foundation.manifest.packageId,
          path: dependencyPath,
        },
        type: "set-foundation-dependency",
      },
    ];
  }
  if (action === "recreate-product-asset") {
    const kind = option(args, "--asset-kind");
    const assetPath = option(args, "--asset");
    if (!assetPath || !["component", "token"].includes(kind)) {
      throw new SmallPenError(
        "missing_recreated_asset",
        "recreate-product-asset requires --asset-kind token|component and --asset FILE",
      );
    }
    if (choice.assetKind && kind !== choice.assetKind) {
      throw new SmallPenError(
        "repair_asset_kind_mismatch",
        `Repair requires a ${choice.assetKind} replacement`,
        { actualKind: kind, expectedKind: choice.assetKind },
      );
    }
    const asset = parseJson(
      await readFile(assetPath, "utf8"),
      "invalid_recreated_asset_json",
      { path: assetPath },
    );
    const create =
      kind === "token"
        ? { ...asset, type: "put-token" }
        : { componentSet: asset.componentSet ?? asset, type: "put-component-set" };
    const assetId =
      kind === "token"
        ? asset.tokenId
        : (asset.componentSet ?? asset).id;
    return [
      create,
      {
        action: "retarget-reference",
        referencePath: choice.referencePath,
        replacement: {
          assetId,
          packageId: resolution.product.manifest.packageId,
        },
        type: "repair-reference",
      },
    ];
  }
  throw new SmallPenError(
    "unsupported_repair_action",
    `Unsupported Repair action: ${action}`,
  );
}

// SP-017: reusable candidates ship an executable insertion intent so an agent
// can place a legal variant instance without guessing node geometry.
function insertionAdvice(owner, product, component) {
  if (!owner || owner.remote) return undefined;
  const defaultScreenId = product.manifest.defaultScreenId;
  const screenEntry = defaultScreenId
    ? product.manifest.entries.screens.find(
        (candidate) => product.entries[candidate].id === defaultScreenId,
      )
    : product.manifest.entries.screens[0];
  if (!screenEntry) return undefined;
  const screen = product.entries[screenEntry];
  const presentation = screen.presentations.find(
    ({ id }) => id === screen.basePresentationId,
  );
  if (!presentation) return undefined;
  let dimensions;
  let variant = {};
  if (component.kind === "set") {
    const componentSet = owner.domain.componentSets.get(component.id);
    const legal = componentSet?.variants[0];
    if (!legal) return undefined;
    const rootNode = legal.nodes[legal.rootId];
    if (!rootNode) return undefined;
    dimensions = { height: rootNode.height, width: rootNode.width };
    variant = structuredClone(legal.selection);
  } else if (component.kind === "located") {
    const masterEntry = owner.manifest.entries.screens.find(
      (candidate) => owner.entries[candidate].id === component.screenId,
    );
    const masterPresentation = masterEntry
      ? owner.entries[masterEntry].presentations.find(
          ({ id }) => id === component.presentationId,
        )
      : undefined;
    const masterNode = masterPresentation?.nodes[component.mainNodeId];
    if (!masterNode) return undefined;
    dimensions = { height: masterNode.height, width: masterNode.width };
  } else {
    return undefined;
  }
  const instanceNode = {
    children: [],
    height: dimensions.height,
    id: `node_instance_${randomUUID().slice(0, 8)}`,
    instance: {
      component: { assetId: component.id, packageId: component.packageId },
      variant,
    },
    name: `${component.name} instance`,
    type: "INSTANCE",
    width: dimensions.width,
    x: 40,
    y: 40,
  };
  return {
    command: {
      argv: [
        "flow",
        product.locator,
        "--intent",
        "<recommendedInsertion.intent.json>",
        "--json",
      ],
    },
    intent: {
      nodes: [instanceNode],
      parentId: presentation.rootId,
      presentationId: presentation.id,
      screenId: screen.id,
    },
  };
}

// SP-018: deleting a shared Component is refused while known same-workspace
// consumers still use it. Unknown offline consumers are out of scope and are
// documented as such in the command help.
async function checkExternalComponentConsumers(packagePath, operations) {
  const componentIds = new Set();
  for (const operation of operations) {
    if (operation?.type === "delete-component" || operation?.type === "delete-component-set") {
      if (typeof operation.componentId === "string") {
        componentIds.add(operation.componentId);
      } else if (typeof operation.componentSetId === "string") {
        componentIds.add(operation.componentSetId);
      }
    }
  }
  if (componentIds.size === 0) return;
  const target = await openPackage(packagePath);
  if (target.manifest.role === "product") return;
  const root = dirname(resolve(packagePath));
  let siblings;
  try {
    siblings = (await readdir(root)).filter(
      (name) =>
        name.endsWith(".smallpen") && resolve(root, name) !== resolve(packagePath),
    );
  } catch {
    return;
  }
  const scanUsages = (snapshot) => {
    const usages = [];
    for (const entry of snapshot.manifest.entries.screens) {
      const screen = snapshot.entries[entry];
      for (const presentation of screen.presentations ?? []) {
        for (const node of Object.values(presentation.nodes ?? {})) {
          const assetId = node.instance?.component?.assetId
            ?? node.componentRef?.assetId;
          if (
            (node.componentId !== undefined && componentIds.has(node.componentId)) ||
            (assetId !== undefined && componentIds.has(assetId))
          ) {
            usages.push({ nodeId: node.id, presentationId: presentation.id, screenId: screen.id });
          }
        }
      }
    }
    return usages;
  };
  for (const sibling of siblings) {
    const locator = join(root, sibling);
    let consumer;
    try {
      consumer = await openPackage(locator);
    } catch {
      continue;
    }
    const declaresTarget = [
      ...(consumer.manifest.dependencies ?? []),
      ...(consumer.manifest.libraries ?? []),
    ].some((dependency) => dependency.packageId === target.manifest.packageId);
    if (!declaresTarget) continue;
    for (const usage of scanUsages(consumer)) {
      throw new SmallPenError(
        "component_in_use_external",
        `Component is still used by another workspace Package: ${consumer.manifest.packageId}`,
        {
          componentIds: [...componentIds].sort(),
          consumerLocator: locator,
          consumerPackageId: consumer.manifest.packageId,
          nextOperations: [
            {
              argv: [
                "apply",
                locator,
                "--batch",
                "<batch.json removing or retargeting the dependent instance>",
                "--json",
              ],
              operation: "smallpen.apply",
              when: "before-retrying-the-deletion",
            },
          ],
          usage,
        },
      );
    }
  }
}

// SP-038: every advertised Repair choice ships an owner-scoped, executable
// command so an agent can act on the choice directly.
function repairChoiceCommand(locator, productPackageId, conflictIndex, choice) {
  const base = [
    "repair",
    locator,
    "--conflict",
    String(conflictIndex),
    "--action",
    choice.action,
  ];
  if (choice.action === "retarget-reference") {
    // The broken reference's own owner cannot resolve it; default the
    // replacement to a Product-owned replacement asset (SP-038-A).
    base.push(
      "--replacement-package-id",
      productPackageId,
      "--replacement-asset-id",
      "<existing-replacement-asset-id>",
    );
  } else if (choice.action === "choose-foundation") {
    base.push("--foundation", "<path inside the workspace>");
  } else if (choice.action === "recreate-product-asset") {
    base.push(
      "--asset-kind",
      choice.assetKind ?? "token",
      "--asset",
      "<recreated-asset.json>",
    );
  }
  base.push("--json");
  return { argv: base };
}

async function repairCommand(packagePath, args) {
  const resolution = await resolveCliWorkspace(packagePath);
  if (resolution.status === "ready") {
    return {
      packageId: resolution.workspace.product.manifest.packageId,
      revision: resolution.workspace.product.revision,
      status: "ready",
    };
  }
  if (!option(args, "--action")) {
    const locator = resolve(packagePath);
    return {
      conflicts: resolution.conflicts.map((conflict, conflictIndex) => ({
        ...conflict,
        choices: (conflict.choices ?? []).map((choice) => ({
          ...choice,
          command: repairChoiceCommand(
            locator,
            resolution.product.manifest.packageId,
            conflictIndex,
            choice,
          ),
        })),
      })),
      packageId: resolution.product.manifest.packageId,
      revision: resolution.product.revision,
      status: "repair",
    };
  }
  const { index, selected } = selectedRepairConflict(resolution, args);
  const action = option(args, "--action");
  const operations = await repairOperations(resolution, selected, action, args);
  const result = await applyOperationBatch(resolution.product.locator, {
    baseRevision: resolution.product.revision,
    batchId: option(args, "--batch-id") ?? `repair_${randomUUID()}`,
    operations,
  });
  const next = await resolveCliWorkspace(packagePath);
  return {
    action,
    conflictIndex: index,
    result,
    status: next.status,
    ...(next.status === "repair" ? { conflicts: next.conflicts } : {}),
  };
}

async function main(args) {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(args[1]);
    return;
  }
  if (command === "version" || command === "--version") {
    if (flag(args, "--help") || flag(args, "-h")) {
      printHelp("version");
      return;
    }
    validateCommandArguments("version", ["version", "", ...args.slice(1)]);
    const { name, version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (flag(args, "--json")) printJson({ name, version });
    else process.stdout.write(`${version}\n`);
    return;
  }
  if (!COMMAND_NAMES.includes(command)) {
    throw new SmallPenError("unknown_command", `Unknown command: ${command}`, {
      validCommands: COMMAND_NAMES,
    });
  }
  if (flag(args, "--help") || flag(args, "-h")) {
    printHelp(command);
    return;
  }
  const packagePath = args[1];
  if (!packagePath || packagePath.startsWith("-")) {
    throw new SmallPenError(
      command === "init" ? "missing_workspace" : "missing_package",
      command === "init"
        ? "A workspace output directory is required"
        : "A .smallpen package path is required",
      { command },
    );
  }
  validateCommandArguments(command, args);

  if (command === "init") {
    printJson(await initializeCommand(packagePath, args));
    return;
  }
  if (command === "import-draft") {
    const inputPath = option(args, "--input");
    const kind = option(args, "--kind") ?? "figma";
    if (!inputPath) {
      throw new SmallPenError(
        "missing_draft_input",
        "import-draft requires --input FILE",
      );
    }
    const input = await readFile(inputPath);
    printJson(
      await importDraft({
        ...(kind === "figma"
          ? { html: input.toString("utf8") }
          : { bytes: new Uint8Array(input) }),
        kind,
        output: packagePath,
        packageId: option(args, "--package-id") ?? "pkg_figma_draft",
      }),
    );
    return;
  }
  if (command === "import-tokens") {
    const inputPath = option(args, "--input");
    if (!inputPath) {
      throw new SmallPenError(
        "missing_import_input",
        "import-tokens requires --input TOKENS.json",
      );
    }
    const document = parseJson(
      await readFile(inputPath, "utf8"),
      "invalid_import_json",
      { path: inputPath },
    );
    const { product: snapshot } = await tokenWorkspace(packagePath);
    const selection = options(args, "--select");
    const result = importTokens(snapshot, document, {
      selection: selection.length > 0 ? selection : undefined,
      setName: option(args, "--set-name"),
    });
    const review = {
      diff: result.diff,
      previousLibraryId: result.previousLibraryId,
      warnings: result.warnings,
    };
    if (!flag(args, "--apply")) {
      printJson({ ...review, dryRun: true, library: result.library });
      return;
    }
    printJson({
      ...(await applyBatch(packagePath, {
        baseRevision: snapshot.revision,
        batchId: option(args, "--batch-id") ?? `import_tokens_${randomUUID()}`,
        operations: result.operations,
      }, args)),
      ...review,
    });
    return;
  }
  if (command === "draft-diff") {
    const afterPath = option(args, "--after");
    if (!afterPath) {
      throw new SmallPenError(
        "missing_draft_after",
        "draft-diff requires --after AFTER.smallpen",
      );
    }
    printJson(
      diffDrafts(
        draftFromSnapshot(await openPackage(packagePath)),
        draftFromSnapshot(await openPackage(afterPath)),
      ),
    );
    return;
  }
  if (command === "draft-compile") {
    const draftPath = option(args, "--draft");
    const selectionsPath = option(args, "--selections");
    if (!draftPath || !selectionsPath) {
      throw new SmallPenError(
        "missing_draft_compile_input",
        "draft-compile requires --draft DRAFT.smallpen and --selections FILE",
      );
    }
    const selections = parseJson(
      await readFile(selectionsPath, "utf8"),
      "invalid_draft_selections_json",
      { path: selectionsPath },
    );
    printJson(
      compileDraftMerge(
        await openPackage(packagePath),
        draftFromSnapshot(await openPackage(draftPath)),
        selections,
        { batchId: option(args, "--batch-id") },
      ),
    );
    return;
  }
  if (command === "read") {
    const { blobs: _blobs, ...snapshot } = await openPackage(packagePath);
    printJson(snapshot);
    return;
  }
  if (command === "validate") {
    const resolution = await resolveCliWorkspace(packagePath);
    if (resolution.status === "repair") {
      throw new SmallPenError(
        "repair_required",
        "SmallPen workspace requires Repair",
        {
          conflicts: resolution.conflicts,
          nextOperations: [
            { args: { packagePath }, operation: "smallpen.repair" },
          ],
        },
      );
    }
    printJson({
      foundationRevision: resolution.workspace.foundation?.revision,
      packageId: resolution.workspace.product.manifest.packageId,
      revision: resolution.workspace.product.revision,
      status: "valid",
      warnings: resolution.warnings ?? [],
    });
    return;
  }
  if (command === "inspect") {
    printJson(inspect(await openPackage(packagePath)));
    return;
  }
  if (command === "list") {
    const snapshot = await openPackage(packagePath);
    const kind = option(args, "--kind") ?? "all";
    const offset = integerOption(args, "--offset", 0);
    const limit = integerOption(args, "--limit", 100, 100);
    const all = listDomain(snapshot, kind).sort((left, right) =>
      String(left.item.id ?? "").localeCompare(String(right.item.id ?? "")),
    );
    printJson({
      items: all.slice(offset, offset + limit),
      kind,
      page: {
        hasMore: offset + limit < all.length,
        limit,
        offset,
        total: all.length,
      },
      packageId: snapshot.manifest.packageId,
      revision: snapshot.revision,
    });
    return;
  }
  if (command === "tokens") {
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    const context = contextSelection(args);
    printJson({
      context,
      items: listEffectiveTokens(product, { context, foundation, libraries }),
      labels: { context: "設計狀態", items: "有效設計變數" },
      packageId: product.manifest.packageId,
      ...workspaceRevisions(product, foundation, libraries),
    });
    return;
  }
  if (command === "search-tokens") {
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    const query = option(args, "--query");
    const requestedType = option(args, "--type");
    const valueSearch = searchValue(args);
    if (
      requestedType !== undefined &&
      valueSearch.type !== undefined &&
      requestedType !== valueSearch.type
    ) {
      throw new SmallPenError(
        "conflicting_token_search_type",
        `--color requires Token type color, not ${requestedType}`,
        { impliedType: valueSearch.type, requestedType },
      );
    }
    if (
      query === undefined &&
      requestedType === undefined &&
      !Object.hasOwn(valueSearch, "value")
    ) {
      throw new SmallPenError(
        "missing_token_search",
        "search-tokens requires --color, --value, --query, or --type",
      );
    }
    const validTypes = SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes;
    const type = requestedType ?? valueSearch.type;
    if (type !== undefined && !validTypes.includes(type)) {
      throw new SmallPenError(
        "invalid_token_type",
        `Unsupported Token type: ${type}`,
        { type, validTypes },
      );
    }
    const limit = integerOption(args, "--limit", 20, 100);
    if (limit === 0) {
      throw new SmallPenError(
        "invalid_token_search_limit",
        "--limit must be between 1 and 100",
        { limit },
      );
    }
    printJson({
      ...searchEffectiveTokens(product, {
        ...valueSearch,
        ...(options(args, "--context").length > 0
          ? { context: contextSelection(args) }
          : {}),
        foundation,
        libraries,
        limit,
        query,
        type,
      }),
      packageId: product.manifest.packageId,
      ...workspaceRevisions(product, foundation, libraries),
    });
    return;
  }
  if (command === "read-view" || command === "discover") {
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    const read = readDesignView(product, {
      foundation,
      libraries,
      limit: integerOption(args, "--limit", 20, 100),
      locale: option(args, "--locale") ?? "zh-TW",
      offset: integerOption(args, "--offset", 0),
      selector: designSelector(args),
    });
    if (command === "discover") {
      printJson(read.discovery);
    } else if (read.format === "screenshot") {
      const bundle = await createEvidence(product, {
        foundation,
        libraries,
        scale: 1,
        selector: designSelector(args, "screenshot"),
      });
      printJson({
        ...read,
        result: {
          diagnostics: bundle.render.diagnostics,
          height: bundle.render.height,
          mimeType: bundle.render.mimeType,
          renderHash: bundle.render.renderHash,
          status: "rendered",
          width: bundle.render.width,
        },
      });
    } else {
      printJson(read);
    }
    return;
  }
  if (command === "catalog") {
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    printJson({
      ...createCatalog(product, {
        context: contextSelection(args),
        foundation,
        libraries,
      }),
      ...workspaceRevisions(product, foundation, libraries),
      warnings: (await resolveCliWorkspace(packagePath)).warnings ?? [],
    });
    return;
  }
  if (command === "search-components") {
    const query = option(args, "--query");
    if (!query || query.trim().length === 0) {
      throw new SmallPenError(
        "missing_component_search",
        "search-components requires --query TEXT",
      );
    }
    const limit = integerOption(args, "--limit", 20, 100);
    if (limit === 0) {
      throw new SmallPenError(
        "invalid_component_search_limit",
        "--limit must be between 1 and 100",
        { limit },
      );
    }
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    const catalog = createCatalog(product, { foundation, libraries });
    const normalized = query.trim().toLowerCase();
    const matches = catalog.components.filter((component) =>
      [component.id, component.name, component.category, component.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
    printJson({
      items: matches.slice(0, limit).map((component) => {
        const owner = [product, foundation, ...libraries].find(
          (snapshot) => snapshot?.manifest.packageId === component.packageId,
        );
        const argv = [
          "component",
          owner.locator,
          "--component-id",
          component.id,
          "--json",
        ];
        const command = ["smallpen", ...argv]
          .map((argument) =>
            /^[A-Za-z0-9_./-]+$/.test(argument)
              ? argument
              : `'${argument.replaceAll("'", "'\\''")}'`,
          )
          .join(" ");
        const insertion = insertionAdvice(owner, product, component);
        return {
          ...component,
          nextOperations: [{ argv, command, operation: "smallpen.component" }],
          ...(insertion ? { recommendedInsertion: insertion } : {}),
        };
      }),
      packageId: product.manifest.packageId,
      query,
      total: matches.length,
      ...workspaceRevisions(product, foundation, libraries),
    });
    return;
  }
  if (command === "component") {
    const componentId = option(args, "--component-id");
    if (!componentId) {
      throw new SmallPenError(
        "missing_component_id",
        "component requires --component-id CMP",
      );
    }
    const snapshot = /^https?:\/\//.test(packagePath)
      ? await openRemoteLibrary(packagePath, {
          cacheRoot: defaultLibraryCacheRoot(),
        })
      : await openPackage(packagePath);
    const component = componentDetails(snapshot, componentId);
    if (!component) {
      throw new SmallPenError("missing_component", "Component Set is not available", {
        componentId,
      });
    }
    printJson({
      component,
      packageId: snapshot.manifest.packageId,
      revision: snapshot.revision,
    });
    return;
  }
  if (command === "compare") {
    const selectors = options(args, "--selector").map((value) =>
      parseJson(value, "invalid_compare_selector", { value }),
    );
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    printJson(createCompareView(product, selectors, { foundation, libraries }));
    return;
  }
  if (command === "effective-token" || command === "explain-token") {
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    const reference = tokenReference(args, product);
    const context = contextSelection(args);
    const result =
      command === "explain-token"
        ? explainEffectiveToken(product, reference, { context, foundation, libraries })
        : resolveEffectiveToken(product, reference, { context, foundation, libraries });
    if (!result) {
      throw new SmallPenError("missing_token", "Token is not available", {
        reference,
      });
    }
    printJson(result);
    return;
  }
  if (command === "render" || command === "evidence") {
    printJson(await renderCommand(packagePath, args, command === "evidence"));
    return;
  }
  if (command === "inspect-view") {
    printJson(await inspectViewCommand(packagePath, args));
    return;
  }
  if (command === "render-matrix") {
    printJson(await renderMatrixCommand(packagePath, args));
    return;
  }
  if (command === "impact") {
    const { foundation, libraries, product } = await tokenWorkspace(packagePath);
    const tokenId = option(args, "--token-id");
    const tokenPath = option(args, "--path");
    const requestedPackageId = option(args, "--package-id");
    if ((tokenId === undefined) === (tokenPath === undefined)) {
      throw new SmallPenError(
        "missing_token_reference",
        "impact requires exactly one of --token-id or --path",
      );
    }
    const matches = [product, foundation, ...libraries]
      .filter(Boolean)
      .filter(
        (snapshot) =>
          requestedPackageId === undefined ||
          snapshot.manifest.packageId === requestedPackageId,
      )
      .flatMap((snapshot) => {
        const token = tokenId
          ? snapshot.domain.tokens.get(tokenId)
          : [...snapshot.domain.tokens.values()].find(
              (candidate) => candidate.path === tokenPath,
            );
        return token ? [{ snapshot, token }] : [];
      });
    if (matches.length === 0) {
      throw new SmallPenError("missing_token", "Token is not available", {
        packageId: requestedPackageId,
        tokenId,
        path: tokenPath,
      });
    }
    if (matches.length > 1) {
      throw new SmallPenError(
        "ambiguous_token_reference",
        "Token exists in more than one Package; specify --package-id",
        {
          packageIds: matches.map(({ snapshot }) => snapshot.manifest.packageId),
          tokenId,
          path: tokenPath,
        },
      );
    }
    const [{ snapshot: owner, token }] = matches;
    printJson({
      locations: tokenImpact(product, token.id, owner.manifest.packageId),
      ownerRevision: owner.revision,
      packageId: owner.manifest.packageId,
      ...workspaceRevisions(product, foundation, libraries),
      token: { id: token.id, path: token.path, type: token.type },
    });
    return;
  }
  if (command === "apply") {
    const batchPath = option(args, "--batch");
    if (!batchPath) {
      throw new SmallPenError(
        "missing_batch",
        "apply requires --batch BATCH.json",
      );
    }
    const batch = parseJson(
      await readFile(batchPath, "utf8"),
      "invalid_batch_json",
      { path: batchPath },
    );
    await checkExternalComponentConsumers(packagePath, batch.operations ?? []);
    printJson(await applyBatch(packagePath, batch, args));
    return;
  }
  if (command === "flow" || command === "page") {
    const intentPath = option(args, "--intent");
    if (!intentPath) {
      throw new SmallPenError(
        "missing_flow_intent",
        "flow requires --intent INTENT.json",
      );
    }
    const intent = parseJson(
      await readFile(intentPath, "utf8"),
      "invalid_flow_intent_json",
      { path: intentPath },
    );
    if (!isRecord(intent) || typeof intent.screenId !== "string") {
      throw new SmallPenError(
        "invalid_flow_intent",
        "flow intent requires screenId and nodes",
      );
    }
    if (!Array.isArray(intent.nodes) || intent.nodes.length === 0) {
      throw new SmallPenError(
        "invalid_flow_intent",
        "flow intent nodes must be a non-empty array",
      );
    }
    const { product: snapshot } = await tokenWorkspace(packagePath);
    const screenEntry = snapshot.manifest.entries.screens.find(
      (entry) => snapshot.entries[entry]?.id === intent.screenId,
    );
    if (!screenEntry) {
      throw new SmallPenError(
        "missing_screen",
        `Screen is not owned by this package: ${intent.screenId}`,
      );
    }
    const screen = snapshot.entries[screenEntry];
    const presentationId = intent.presentationId ?? screen.basePresentationId;
    const presentation = screen.presentations.find(
      (candidate) => candidate.id === presentationId,
    );
    if (!presentation) {
      throw new SmallPenError(
        "missing_presentation",
        `Presentation is not owned by this Screen: ${presentationId}`,
      );
    }
    // New flow nodes belong inside the presentation root by default. This keeps
    // the generated semantic tree and rendered view rooted at the existing
    // screen canvas; callers can pass parentId:null for an explicit root node.
    const parentId = intent.parentId === undefined
      ? presentation.rootId
      : intent.parentId;
    const operations = intent.nodes.map((node, index) => ({
      index: intent.index === undefined ? undefined : intent.index + index,
      node,
      parentId,
      presentationId,
      screenId: intent.screenId,
      type: "add-presentation-node",
    }));
    printJson(
      await applyBatch(packagePath, {
        baseRevision: snapshot.revision,
        batchId: option(args, "--batch-id") ?? `${command}_${randomUUID()}`,
        operations,
      }, args),
    );
    return;
  }
  if (command === "token") {
    const intentPath = option(args, "--intent");
    if (!intentPath) {
      throw new SmallPenError(
        "missing_token_intent",
        "token requires --intent INTENT.json",
      );
    }
    const intent = parseJson(
      await readFile(intentPath, "utf8"),
      "invalid_token_intent_json",
      { path: intentPath },
    );
    if (!isRecord(intent) || !Array.isArray(intent.operations) || intent.operations.length === 0) {
      throw new SmallPenError(
        "invalid_token_intent",
        "token intent operations must be a non-empty array",
      );
    }
    const { product: snapshot } = await tokenWorkspace(packagePath);
    printJson(
      await applyBatch(packagePath, {
        baseRevision: snapshot.revision,
        batchId: option(args, "--batch-id") ?? `token_${randomUUID()}`,
        operations: intent.operations,
      }, args),
    );
    return;
  }
  if (command === "import-media") {
    const mediaPath = option(args, "--file") ?? args[1];
    if (!mediaPath) {
      throw new SmallPenError(
        "missing_media_file",
        "import-media requires --file MEDIA_FILE",
      );
    }
    const bytes = new Uint8Array(await readFile(resolve(mediaPath)));
    const inspected = inspectMedia(bytes);
    const mediaId = option(args, "--media-id") ?? `media_${randomUUID()}`;
    const name = option(args, "--name") ?? mediaPath.split(/[\\/]/).pop();
    const print = await importMedia(packagePath, {
      bytes,
      height: inspected.height,
      id: mediaId,
      mimeType: inspected.mimeType,
      name,
      path: option(args, "--media-path") ?? "",
      width: inspected.width,
    });
    printJson({
      descriptor: print.descriptor,
      revision: print.result.revision,
    });
    return;
  }
  if (command === "remove-media") {
    const mediaId = option(args, "--media-id");
    if (!mediaId) {
      throw new SmallPenError(
        "missing_media_id",
        "remove-media requires --media-id MEDIA",
      );
    }
    const result = await removeMedia(packagePath, mediaId);
    printJson({ mediaId, removed: true, revision: result.revision });
    return;
  }
  if (command === "import-font") {
    const fontPath = option(args, "--file") ?? args[1];
    if (!fontPath) {
      throw new SmallPenError(
        "missing_font_file",
        "import-font requires --file FONT_FILE",
      );
    }
    const family = option(args, "--family");
    if (!family) {
      throw new SmallPenError(
        "missing_font_family",
        "import-font requires --family NAME",
      );
    }
    const bytes = new Uint8Array(await readFile(resolve(fontPath)));
    const signatureTtf = bytes[0] === 0x00 && bytes[1] === 0x01;
    const signatureOtf = bytes[0] === 0x4f && bytes[1] === 0x54;
    const signatureWoff = bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46;
    const signatureWoff2 = bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
    const files = {};
    if (signatureTtf) {
      inspectFont(bytes, "font/ttf");
      files.ttf = { bytes, mimeType: "font/ttf" };
      files.woff = {
        bytes: sfntToWoff(bytes, "font/ttf"),
        mimeType: "font/woff",
      };
    } else if (signatureOtf) {
      inspectFont(bytes, "font/otf");
      files.otf = { bytes, mimeType: "font/otf" };
      files.woff = {
        bytes: sfntToWoff(bytes, "font/otf"),
        mimeType: "font/woff",
      };
    } else if (signatureWoff2) {
      inspectFont(bytes, "font/woff2");
      files.woff2 = { bytes, mimeType: "font/woff2" };
      throw new SmallPenError(
        "unsupported_font_conversion",
        "WOFF2 cannot be converted without a WOFF2 decoder; supply TTF, OTF, or WOFF",
        { mimeType: "font/woff2" },
      );
    } else if (signatureWoff) {
      inspectFont(bytes, "font/woff");
      files.woff = { bytes, mimeType: "font/woff" };
    } else {
      inspectFont(bytes, undefined);
    }
    const fontId = option(args, "--font-id") ?? `font_${randomUUID()}`;
    const style = option(args, "--style") ?? "normal";
    const weight = Number(option(args, "--weight") ?? 400);
    const variantId = option(args, "--variant-id") ?? `fvar_${randomUUID()}`;
    const { result, variant } = await importFontVariant(packagePath, {
      family,
      files,
      fontId,
      id: variantId,
      name: option(args, "--name") ?? `${style}-${weight}`,
      style,
      weight,
    });
    printJson({
      fontId,
      files: variant.files,
      revision: result.revision,
      variantId: variant.id,
    });
    return;
  }
  if (command === "library-refresh") {
    const resolution = await resolveCliWorkspace(packagePath);
    if (resolution.status !== "ready") {
      throw new SmallPenError(
        "repair_required",
        "SmallPen workspace requires Repair",
        { conflicts: resolution.conflicts },
      );
    }
    const { libraries, product } = resolution.workspace;
    const selector = option(args, "--library");
    const declared = (product.manifest.libraries ?? []).filter(
      (library) => library.source?.type === "url",
    );
    const selected = selector
      ? declared.find(
          (library) =>
            library.packageId === selector || library.source.url === selector,
        )
      : declared[0];
    if (!selected) {
      throw new SmallPenError(
        "missing_library_source",
        "No declared URL Library matches --library",
        {
          declaredIds: declared.map((library) => library.packageId),
          selector,
        },
      );
    }
    const before = libraries.find(
      (library) => library.manifest.packageId === selected.packageId,
    );
    const refreshed = await openRemoteLibrary(selected.source.url, {
      cacheRoot: defaultLibraryCacheRoot(),
      expectedPackageId: selected.packageId,
      refresh: true,
    });
    printJson({
      after: {
        cache: refreshed.remote.cache,
        packageId: refreshed.manifest.packageId,
        revision: refreshed.revision,
      },
      before: before
        ? { packageId: before.manifest.packageId, revision: before.revision }
        : undefined,
      packageId: selected.packageId,
      revision: product.revision,
      sourceUrl: selected.source.url,
    });
    return;
  }
  if (command === "watch") {
    const interval = Math.max(100, Number(option(args, "--interval") ?? 500));
    // Default is unlimited: watch without --max-events must keep observing
    // (SP-041-A caught a fallback of 1 that exited after the first event).
    const maxEvents = integerOption(args, "--max-events", Number.POSITIVE_INFINITY, 10_000);
    const emit = (payload) =>
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    let previous;
    let events = 0;
    process.on("SIGINT", () => process.exit(0));
    for (;;) {
      try {
        const snapshot = await openPackage(packagePath);
        if (snapshot.revision !== previous) {
          previous = snapshot.revision;
          events += 1;
          emit({
            event: "revision",
            packageId: snapshot.manifest.packageId,
            revision: snapshot.revision,
          });
          if (maxEvents !== undefined && events >= maxEvents) return;
        }
      } catch (error) {
        events += 1;
        emit({
          code: error instanceof SmallPenError ? error.code : "internal_error",
          event: "invalid",
          message: error instanceof Error ? error.message : String(error),
        });
        if (maxEvents !== undefined && events >= maxEvents) return;
      }
      await delay(interval);
    }
  }
  if (command === "repair") {
    printJson(await repairCommand(packagePath, args));
  }
}

function errorDetails(error, args) {
  const details = error instanceof SmallPenError ? error.details : {};
  if (error?.code === "unknown_option" && typeof details.command === "string") {
    return {
      ...details,
      nextOperations: [
        { argv: [details.command, "--help"], operation: "smallpen.help" },
      ],
      recovery: "Read the command help and correct the option explicitly before retrying. No option was guessed and no operation was applied.",
    };
  }
  if (
    ["invalid_entry_json", "invalid_manifest_json"].includes(error?.code) &&
    typeof details.packagePath === "string"
  ) {
    return {
      ...details,
      entryPath: resolve(details.packagePath, details.entry ?? "manifest.json"),
      nextOperations: [
        {
          argv: ["validate", details.packagePath, "--json"],
          operation: "smallpen.validate",
          when: "after-restoring-valid-json",
        },
      ],
      recovery:
        "Preserve the damaged file, then restore known-good valid JSON at entryPath. After restoring it, execute the validation argv. Validation does not repair or rewrite invalid JSON.",
    };
  }
  if (error?.code === "missing_component_id" && typeof args[1] === "string") {
    const remote = /^https?:\/\//.test(args[1]);
    return {
      ...details,
      nextOperations: [
        ...(!remote
          ? [{
              argv: ["list", resolve(args[1]), "--kind", "components", "--json"],
              operation: "smallpen.list",
            }]
          : []),
        { argv: ["component", "--help"], operation: "smallpen.help" },
      ],
      recovery: remote
        ? "Supply --component-id from a linked Product's search-components result and retain that result's owner locator. component --help describes the detail command; list does not accept URL locators."
        : "List this owner Package's Component Sets, then retry component with the selected --component-id and the same Package path.",
    };
  }
  if (
    args[0] === "init" &&
    ["invalid_initialization_answer_json", "invalid_initialization_answer"].includes(error?.code) &&
    typeof details.questionId === "string"
  ) {
    const retry = [...args];
    retry[1] = resolve(retry[1]);
    const stateIndex = retry.indexOf("--state");
    if (stateIndex !== -1) retry[stateIndex + 1] = resolve(retry[stateIndex + 1]);
    let replaced = false;
    for (let index = 2; index < retry.length; index += 1) {
      if (retry[index] === "--answer" && retry[index + 1]?.startsWith(`${details.questionId}=`)) {
        retry[index + 1] = `${details.questionId}=<JSON>`;
        replaced = true;
      }
    }
    if (!replaced) retry.push("--answer", `${details.questionId}=<JSON>`);
    if (!retry.includes("--json")) retry.push("--json");
    if (!retry.includes("--locale")) retry.push("--locale", "zh-TW");
    return {
      ...details,
      nextOperations: [{ argv: retry, operation: "smallpen.init.answer" }],
      recovery: "Replace <JSON> with a valid JSON answer and execute the retry argv.",
    };
  }
  if (error?.code === "stale_revision") {
    const locator = typeof args[1] === "string" ? resolve(args[1]) : "<package>";
    const commands = [
      {
        argv: ["read", locator, "--json"],
        explanation: "Read the current revision and confirm no conflicting update is discarded.",
      },
      {
        argv: [
          "apply",
          locator,
          "--batch",
          "<rebuilt-intent.json>",
          "--json",
        ],
        explanation:
          "In the batch JSON set baseRevision to the actual revision and batchId to a new unique id, keep the remaining operations, then run this apply.",
      },
    ];
    const remainingIntent = Array.isArray(details.nextOperations)
      ? details.nextOperations.find(
          (operation) => operation.operation === "smallpen.apply.replay-intent",
        )?.args?.operations
      : undefined;
    return {
      ...details,
      ...(remainingIntent ? { remainingIntent } : {}),
      commands,
      nextOperations: Array.isArray(details.nextOperations)
        ? details.nextOperations
        : [
            {
              args: { expectedRevision: details.actualRevision },
              operation: "smallpen.refresh",
            },
            {
              args: {
                baseRevision: details.actualRevision,
                newBatchId: "<unique-id>",
              },
              operation: "smallpen.apply.replay-intent",
            },
          ],
      recovery:
        "The write was rejected atomically; nothing was applied. Read the actual revision, then rebuild the batch JSON with baseRevision set to that revision and a new unique batchId inside the JSON (apply takes no --batch-id option), and rerun apply --batch. Concurrent updates that are still needed must be re-applied on top.",
    };
  }
  if (error?.code === "missing_local_asset" && isRecord(details.reference)) {
    const locator = typeof args[1] === "string" ? resolve(args[1]) : "<package>";
    const assetId = details.reference.assetId;
    const isToken = typeof assetId === "string" && assetId.startsWith("tok_");
    const commands = [
      {
        argv: ["impact", locator, "--token-id", assetId, "--json"],
        explanation: "List every location that still binds this token.",
      },
      {
        argv: [
          "apply",
          locator,
          "--batch",
          "<batch.json with one clear-token-binding operation per impacted location>",
          "--json",
        ],
        explanation:
          "Build the clear-token-binding batch against the current revision with a new unique batchId in the JSON, run this apply, then retry the token removal as another apply --batch with its own new batchId.",
      },
    ];
    return {
      ...details,
      commands,
      nextOperations: [
        {
          argv: commands[0].argv,
          operation: "smallpen.impact",
        },
        {
          argv: commands[1].argv,
          operation: "smallpen.apply",
          when: "after-clearing-live-references",
        },
      ],
      recovery: isToken
        ? "The removal was rejected atomically because the token is still referenced. List the live bindings, then clear each binding with a clear-token-binding batch JSON (current baseRevision, new unique batchId in the JSON) via apply --batch, and retry the removal the same way."
        : "The removal was rejected atomically because the asset is still referenced. Remove or retarget the referencing usage with an apply --batch whose JSON carries the current baseRevision and a new unique batchId, then retry.",
    };
  }
  if (error?.code === "unknown_command") {
    return {
      ...details,
      nextOperations: [
        {
          args: [],
          argv: ["--help"],
          command: "smallpen --help",
          operation: "smallpen.help",
        },
      ],
    };
  }
  return details;
}

const cliArgs = process.argv.slice(2);
main(cliArgs).catch((error) => {
  printJson({
    error: {
      code: error instanceof SmallPenError ? error.code : "internal_error",
      details: errorDetails(error, cliArgs),
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
