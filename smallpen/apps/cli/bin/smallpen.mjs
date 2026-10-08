#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  componentDefineOperation,
  flowLinkIntent,
  flowStartIntent,
  pageDrawOperation,
  componentSetOperation,
  pageSetOperation,
  themeAddIntents,
  themeDefaultIntent,
  themeDeleteIntent,
  themeRenameIntent,
  tokenDeleteOperations,
  tokenOptionValues,
  tokenSetOperations,
  buildDesignSystemPage,
  canonicalJSON,
  listAssets,
  interactionIntentOperations,
  prototypeConnections,
  validatePrototypeChanges,
  checkOperationShape,
  compileDraftMerge,
  createCatalog,
  createSemanticTree,
  projectScreen,
  designChanges,
  designChangesText,
  elementMoveOperation,
  findComponent,
  canvasLayout,
  assetDeleteOperations,
  assetSetOperations,
  componentDeleteOperation,
  componentRenameOperation,
  duplicateNameIssues,
  checkNotUsedElsewhere,
  flowLinks,
  flowLinksText,
  flowStartRemoveOperation,
  flowUnlinkOperation,
  pageDeleteOperations,
  pageRenameOperations,
  placePageOnCanvas,
  renameCanvasOperation,
  reorderPageOperation,
  elementPath,
  findElement,
  findPage,
  findPresentation,
  findVariant,
  createCompareView,
  createInitializationState,
  createWorkspaceRuntime,
  designSystemPageOptions,
  diffDrafts,
  expandDesignSystemPage,
  locatedFamilySource,
  designTokenAdviceForBatch,
  defaultTokenWorkspace,
  draftFromSnapshot,
  explainEffectiveToken,
  formatWarningsForBatch,
  importTokens,
  INIT_LAYOUTS,
  listEffectiveTokens,
  variantLabel,
  listTokenDefinitions,
  listTokenThemes,
  packageFormatWarnings,
  tokenLibraryOf,
  prepareOperationBatch,
  resolveEffectiveToken,
  searchEffectiveTokens,
  selectTokenThemes,
  themeIntentOperations,
  SmallPenError,
  SMALLPEN_FORMAT_CAPABILITIES,
  staleInstanceDiagnostics,
} from "@smallpen/core";
import {
  applyOperationBatch,
  createEvidence,
  defaultLibraryCacheRoot,
  fontVariantName,
  importDraft,
  importFontVariant,
  importMedia,
  initializeBlankWorkspace,
  initializeWorkspace,
  inspectFont,
  migrateThemesByCopy,
  inspectMedia,
  openPackage,
  readBatchHistory,
  openRemoteLibrary,
  measureProjectionText,
  renderProjection,
  replayRecordedBatch,
  resolveWorkspace,
  sfntToWoff,
} from "@smallpen/local-package";

import { COMMAND_NAMES, commandGuidance, printHelp } from "./help.mjs";
import {
  COMMAND_CONTRACTS,
  commandContract,
  numericDefault,
  parameterExpectation,
  validateCommandArguments,
} from "./command-contract.mjs";
import { schemaTopic } from "./schema.mjs";
import { helpTopic, printBriefHelp } from "./help-topics.mjs";
import { CLI_RULES } from "./workflow.mjs";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
  routeCommand,
  publicGuidance,
  publicArgv,
  groupRoute,
  groupDefinition,
  commandMatch,
} from "./command-tree.mjs";
import {
  artifactDirectory,
  artifactPath,
  beginArtifacts,
  OUTPUT_LIMIT_BYTES,
  saveResult,
  releaseArtifacts,
} from "./result-files.mjs";
import {
  componentLookup,
  componentSummaryText,
  platformHints,
  localWireframe,
  specTree,
  outlineTree,
  selectedDesign,
  themeSettings,
  validateDesign,
} from "./design-output.mjs";
import { definitionReuseAdvice } from "./reuse-advice.mjs";
import { warningOutput } from "./warning-output.mjs";
import {
  discoverySummary,
  packageSummary,
  pageItems,
  viewSummary,
} from "./read-output.mjs";

let writeState = "not-applied";
async function trackedWrite(action) {
  writeState = "unknown";
  const result = await action();
  writeState = "committed";
  return result;
}
// Localized labels follow the environment unless --locale is given: any
// zh* locale selects the Chinese labels, everything else English.
function defaultLocale() {
  const source =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return /^zh/i.test(source) ? "zh-TW" : "en";
}

function tokenLabels(locale) {
  return /^zh/i.test(locale)
    ? { context: "設計狀態", items: "有效設計變數" }
    : { context: "Design Context", items: "Effective Tokens" };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Locale-independent order for JSON output: localeCompare follows the host
// LANG (Danish sorts "aa" after "ab"), which would reorder lists and pages.
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Caller-supplied input files fail with a typed error instead of a raw
// filesystem internal_error.
async function readInputFile(path, optionName, encoding) {
  try {
    return await readFile(path, encoding);
  } catch (error) {
    if (
      !["EACCES", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"].includes(error?.code)
    ) {
      throw error;
    }
    throw new SmallPenError(
      "unreadable_input_file",
      `${optionName} file cannot be read: ${error.message}`,
      { option: optionName, path: resolve(path), reason: error.code },
    );
  }
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
          "--context requires CONTEXT=VALUE",
          { value },
        );
      }
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

// Types and static ranges were checked at the command boundary. Only a
// package-dependent bound (the repair conflict count) is checked here.
function integerOption(args, name, maximum) {
  const value = option(args, name);
  const parsed =
    value === undefined
      ? numericDefault(args[0], name, flag(args, "--full"))
      : Number(value);
  if (maximum !== undefined && parsed > maximum) {
    throw new SmallPenError(
      "invalid_integer_option",
      `${name} exceeds the available target count`,
      { maximum, name, value },
    );
  }
  return parsed;
}

function numberOption(args, name) {
  return option(args, name) === undefined
    ? numericDefault(args[0], name, flag(args, "--full"))
    : Number(option(args, name));
}

function designSelector(args, viewFormat) {
  return {
    ...(options(args, "--context").length > 0
      ? { context: contextSelection(args) }
      : {}),
    ...(option(args, "--context-profile-id")
      ? { contextProfileId: option(args, "--context-profile-id") }
      : {}),
    ...((viewFormat ?? option(args, "--format"))
      ? { viewFormat: viewFormat ?? option(args, "--format") }
      : {}),
    ...(option(args, "--presentation-id")
      ? { presentationId: option(args, "--presentation-id") }
      : {}),
    ...(option(args, "--scenario-id")
      ? { scenarioId: option(args, "--scenario-id") }
      : {}),
    ...(option(args, "--screen-id")
      ? { screenId: option(args, "--screen-id") }
      : {}),
  };
}

// IDs are the package's and the App's, not the agent's: every command names
// things, so replies leave IDs out unless --full asks for the stored data.
// advanced apply and project repair work with exact operations and keep them;
// schema documents stored fields by their names.
const ID_KEY = /^(id|[a-z][A-Za-z]*Ids?)$/;
const emptied = (before, after) =>
  after && typeof after === "object" && !Array.isArray(after) && Object.keys(after).length === 0 &&
  before && typeof before === "object" && Object.keys(before).length > 0;
function withoutIds(value) {
  // An entry that held only IDs says nothing once they go: leave it out.
  if (Array.isArray(value))
    return value.map((child) => [child, withoutIds(child)]).filter(([before, after]) => !emptied(before, after)).map(([, after]) => after);
  if (!value || typeof value !== "object" || value instanceof Map || value instanceof Uint8Array) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key === "batchId" || !ID_KEY.test(key))
      .map(([key, child]) => [key, child, key === "argv" ? child : withoutIds(child)])
      .filter(([, before, after]) => !emptied(before, after))
      .map(([key, , after]) => [key, after]),
  );
}
function keepsIds(args) {
  return (
    flag(args, "--full") ||
    ["schema", "help", "version", "advanced", "apply", "repair", "--help", "-h", "--version"].includes(args[0]) ||
    (args[0] === "project" && args[1] === "repair") ||
    args.includes("--help")
  );
}

// A write by name answers what changed, what to look at and how to undo;
// hashes, counts and each advised value stay in --full.
function compactWriteReceipt(value, packagePath) {
  if (!value || typeof value !== "object" || typeof value.batchId !== "string" || value.error) return value;
  const out = { ...value };
  // Undo is a new write of the saved inverse batch against this revision.
  if (out.inverseBatchPath && !out.dryRun) {
    out.undo = {
      argv: ["advanced", "apply", packagePath, "--batch", out.inverseBatchPath],
      note: "A new write against this revision; it refuses if the package changed since. The file expires after 30 minutes.",
    };
  }
  delete out.reverseEdit;
  if (out.revision !== undefined) delete out.baseRevision;
  for (const key of ["inverseBatchHash", "changeReportHash", "affectedIdsCount", "changedFilesCount", "deletedFilesCount",
    "warningsCount", "warningCount", "inverseOperationCount", "diffCount"])
    delete out[key];
  if (Array.isArray(out.deletedFiles) && !out.deletedFiles.length) delete out.deletedFiles;
  // "textStyle" next to "textStyle.fontSize" on the same elements says it twice.
  if (Array.isArray(out.warnings))
    out.warnings = out.warnings.filter((warning, _index, all) => !all.some((other) => other !== warning && other.code === warning.code &&
      typeof other.field === "string" && typeof warning.field === "string" && other.field.startsWith(`${warning.field}.`) &&
      JSON.stringify((other.locations ?? []).map((location) => location.element)) === JSON.stringify((warning.locations ?? []).map((location) => location.element))));
  if (Array.isArray(out.warnings))
    out.warnings = out.warnings.map(({ locations, count, contextScope: _scope, valueSource: _source, match: _match, severity: _severity, ...warning }) => {
      const elements = [...new Set((locations ?? []).map((location) => location.element).filter(Boolean))];
      return {
        ...warning,
        ...(Array.isArray(warning.suggestions) && !warning.suggestions.length ? { suggestions: undefined } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(elements.length ? { elements } : {}),
      };
    });
  if (out.warningSummary)
    out.warningSummary = {
      total: out.warningSummary.total,
      ...(out.warningSummary.suppressed ? { suppressed: out.warningSummary.suppressed } : {}),
      ...(out.warningSummary.note ? { note: out.warningSummary.note } : {}),
    };
  return out;
}

function printJson(value) {
  // Every command that runs is public now: guidance names grouped paths.
  value = publicGuidance(value);
  const args = process.argv.slice(2);
  if (!keepsIds(args)) value = compactWriteReceipt(withoutIds(value), args[commandMatch(args)?.route ? commandMatch(args).length : 1]);
  const measuredOutput = [
    "help",
    "themes",
    "theme",
    "view",
    "export",
    "validate",
    "assets",
    "asset",
  ].includes(args[0]);
  const inline = flag(args, "--stdout") || flag(args, "--base64");
  const encode = (reply) =>
    JSON.stringify(reply, (_key, child) =>
      child instanceof Map
        ? Object.fromEntries(
            [...child.entries()].sort(([left], [right]) =>
              compareText(String(left), String(right)),
            ),
          )
        : child,
    );
  let json = encode(value);
  // Reserve room for the self-reported byte count on the primary AI surface.
  const limitBytes = OUTPUT_LIMIT_BYTES - (measuredOutput ? 64 : 0);
  if (!inline && Buffer.byteLength(json) + 1 > limitBytes) {
    // A large individual node, warning, or diagnostic must not defeat the
    // default budget. Preserve confirmations and recovery, never cut JSON text.
    const keys = [
      "package",
      "packageId",
      "revision",
      "productRevision",
      "foundationRevision",
      "libraryRevisions",
      "batchId",
      "alreadyApplied",
      "changed",
      "dryRun",
      "noChange",
      "inverseBatchPath",
      "inverseBatchHash",
      "changeReportHash",
      "warningCount",
      "warningsCount",
      "affectedIdsCount",
      "changedFilesCount",
      "deletedFilesCount",
      "diffCount",
      "inverseOperationCount",
      "changeReportPath",
      "reverseEdit",
      "summary",
      "warningSummary",
      "undoError",
      "counts",
      "count",
      "target",
      "selection",
      "page",
      "total",
      "kind",
      "query",
      "renderHash",
      "width",
      "height",
      "mimeType",
      "output",
      "imagePath",
      "evidencePath",
      "matrixPath",
      "status",
      "dataStatus",
      "visualStatus",
      "interactionStatus",
      "interactionIssueCount",
      "issueCount",
      "coverage",
      "reportPath",
      "tracePath",
      "connectionCount",
      "startCount",
      "stepCount",
      "requestedStepCount",
      "failedStep",
      "stateSaved",
      "textLayout",
      "statePath",
      "confirmation",
      "nextQuestion",
      "answersTemplate",
      "stateNotice",
      "packagePath",
      "foundationPath",
      "productPath",
      "packages",
    ];
    const resultFile = saveResult(
      `${JSON.stringify(JSON.parse(json), null, 2)}\n`,
    );
    const text = value.outline ?? value.wireframe;
    if (typeof text === "string") resultFile.text = saveResult(text, "txt");
    const brief = Object.fromEntries(
      keys
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, value[key]]),
    );
    const diagnosticSummary = (diagnostics = []) => ({
      diagnosticCount: diagnostics.length,
      ...(diagnostics.some(({ code }) =>
        /partial|unsupported|fallback|unresolved|missing|placeholder/.test(
          code,
        ),
      )
        ? { partialRender: true }
        : {}),
    });
    const imageReceipt = (image) => ({
      ...diagnosticSummary(image.diagnostics),
      ...Object.fromEntries(
        ["output", "renderHash", "width", "height", "mimeType"]
          .filter((key) => image[key] !== undefined)
          .map((key) => [key, image[key]]),
      ),
    });
    if (value.diagnostics)
      Object.assign(brief, diagnosticSummary(value.diagnostics));
    if (value.image) {
      brief.image = imageReceipt(value.image);
      Object.assign(brief, diagnosticSummary(value.image.diagnostics));
    }
    if (value.nextOperations) brief.nextOperations = value.nextOperations;
    if (value.images) {
      brief.images = value.images.map(imageReceipt);
      Object.assign(
        brief,
        diagnosticSummary(
          value.images.flatMap((image) => image.diagnostics ?? []),
        ),
      );
    }
    if (value.start) {
      const { presentationId, rootNode, screenId } = value.start;
      brief.start = { presentationId, rootNode, screenId };
    }
    if (value.error) {
      const details = value.error.details ?? {};
      brief.error = {
        code: value.error.code,
        writeState: value.error.writeState,
        message: value.error.message.slice(0, 1024),
        details: {
          ...Object.fromEntries(
            [
              "batchId",
              "baseRevision",
              "actualRevision",
              "currentRevision",
              "committedRevision",
              "correction",
              "recovery",
              "field",
              "path",
              "expected",
              "received",
              "suggestion",
              "operationIndex",
              "operationType",
              "schemaCommand",
            ]
              .filter((key) => details[key] !== undefined)
              .map((key) => [key, details[key]]),
          ),
          ...(details.commands && JSON.stringify(details.commands).length < 4096
            ? { commands: details.commands }
            : {}),
          nextOperations: (details.nextOperations ?? [])
            .slice(0, 3)
            .map(({ args: operationArgs, ...operation }) => ({
              ...operation,
              ...(operationArgs
                ? {
                    args: Object.fromEntries(
                      Object.entries(operationArgs).filter(
                        ([key, value]) =>
                          key !== "operations" &&
                          (JSON.stringify(value) ?? "").length < 1024,
                      ),
                    ),
                  }
                : {}),
            })),
        },
      };
    }
    if (value.images) brief.imageCount = value.images.length;
    if (Array.isArray(value.warnings))
      brief.warningCount = value.warningsCount ?? value.warnings.length;
    brief.resultFile = resultFile;
    brief.outputDetail = {
      omitted: true,
      bytes: Buffer.byteLength(json) + 1,
      limitBytes,
    };
    json = encode(brief);
    if (brief.matrixPath && Buffer.byteLength(json) + 1 > limitBytes) {
      delete brief.images;
      json = encode(brief);
    }
    for (const key of [
      "nextOperations",
      "package",
      "libraryRevisions",
      "selection",
      "counts",
      "target",
      "page",
      "query",
      "warningSummary",
      "summary",
      "stateNotice",
      "answersTemplate",
      "output",
      "imagePath",
      "evidencePath",
    ]) {
      if (Buffer.byteLength(json) + 1 <= limitBytes) break;
      delete brief[key];
      json = encode(brief);
    }
    if (Buffer.byteLength(json) + 1 > limitBytes && brief.error) {
      const { code, message, details } = brief.error;
      brief.error = {
        code,
        writeState: value.error.writeState,
        message,
        details: Object.fromEntries(
          [
            "batchId",
            "baseRevision",
            "actualRevision",
            "currentRevision",
            "committedRevision",
          ]
            .filter((key) => details[key] !== undefined)
            .map((key) => [
              key,
              typeof details[key] === "string"
                ? details[key].slice(0, 256)
                : details[key],
            ]),
        ),
      };
      json = encode(brief);
    }
    if (Buffer.byteLength(json) + 1 > limitBytes && brief.undoError) {
      const { code, reason, message } = brief.undoError;
      brief.undoError = { code, reason, message };
      json = encode(brief);
    }
    if (Buffer.byteLength(json) + 1 > limitBytes) {
      const keep = new Set([
        "resultFile",
        "outputDetail",
        "error",
        "batchId",
        "revision",
        "alreadyApplied",
        "changed",
        "dryRun",
        "noChange",
        "status",
        "dataStatus",
        "visualStatus",
        "interactionStatus",
        "issueCount",
        "diagnosticCount",
        "partialRender",
        "interactionIssueCount",
        "warningCount",
        "warningsCount",
        "imageCount",
        "count",
        "total",
        "connectionCount",
        "stepCount",
      ]);
      const fallback = Object.fromEntries(
        Object.entries(brief).filter(([key]) => keep.has(key)),
      );
      if (brief.coverage)
        fallback.coverage = {
          complete: brief.coverage.complete,
          skippedCount:
            brief.coverage.skippedCount ?? brief.coverage.skipped?.length,
          ...Object.fromEntries(
            Object.entries(brief.coverage).filter(
              ([key, value]) =>
                key !== "complete" &&
                key !== "skippedCount" &&
                (typeof value === "number" || typeof value === "boolean"),
            ),
          ),
        };
      json = encode(fallback);
    }
  }
  if (measuredOutput) {
    const measured = JSON.parse(json);
    measured.outputBytes = 0;
    for (let index = 0; index < 3; index++) {
      json = encode(measured);
      measured.outputBytes = Buffer.byteLength(json) + 1;
    }
    json = encode(measured);
  }
  process.stdout.write(`${json}\n`);
}

function pagination(args) {
  return {
    limit: integerOption(args, "--limit"),
    offset: integerOption(args, "--offset"),
  };
}

function viewPagination(args) {
  const full = flag(args, "--full");
  return {
    ...pagination(args),
    ...(full && !args.includes("--limit") ? { limit: undefined } : {}),
    full,
    nodeId: option(args, "--node-id"),
  };
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
    ].sort((left, right) => compareText(left.id, right.id)),
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

// --theme GROUP/NAME selects token themes for this read only: the
// workspace is viewed with those themes active, nothing is written.
// Reads go on when the only Repair is Instances that lost their variant:
// they draw with the closest variant and report a stale_instance_variant
// diagnostic, as the editor shows them.
// Renames number a name already taken ("List 2") the way App edits do: the
// shared batch step does it for both.
function renameNumbering(command) {
  return ["page-rename", "component-rename", "canvas-rename"].includes(command) ? { repeatedNames: "number" } : {};
}

// A write a retry can repeat safely: its command takes --batch-id.
function batchIdWrite(command) {
  return Object.hasOwn(COMMAND_CONTRACTS, command) && Boolean(commandContract(command).parameters.batchId);
}

async function readableWorkspace(packagePath) {
  const resolution = await resolveCliWorkspace(packagePath);
  if (resolution.status === "ready") return resolution.workspace;
  if (resolution.conflicts.every(({ degraded }) => degraded === true)) {
    return {
      foundation: resolution.foundation,
      libraries: resolution.libraries ?? [],
      product: resolution.product,
    };
  }
  throw new SmallPenError(
    "repair_required",
    "SmallPen workspace requires dependency Repair",
    { conflicts: resolution.conflicts },
  );
}

async function tokenWorkspace(packagePath, args = []) {
  const workspace = await readableWorkspace(packagePath);
  // Each call starts from project defaults, then an explicitly requested saved
  // Scenario, then explicit group overrides. Editor selection is never a base.
  const scenarioId = args.includes("--scenario-id")
    ? option(args, "--scenario-id")
    : undefined;
  const themes = options(args, "--theme");
  const defaults = defaultTokenWorkspace(workspace);
  const scenario = scenarioId
    ? workspace.product.domain.scenarios.get(scenarioId)
    : undefined;
  if (scenarioId && !scenario)
    throw new SmallPenError(
      "unknown_scenario",
      `Unknown Scenario: ${scenarioId}`,
    );
  const configured = selectTokenThemes(defaults, scenario?.themes ?? []);
  const selected = selectTokenThemes(configured, themes);
  return {
    foundation: selected.foundation,
    libraries: workspace.libraries ?? [],
    product: selected.product,
    appSelection: {
      themes: listTokenThemes(workspace.product, workspace.foundation)
        .filter(({ active }) => active)
        .map(({ path }) => path),
    },
  };
}

// Instances, in the Package and its Foundation, whose variant selection
// matches no variant of their Component Set.
function workspaceStaleInstances(resolution) {
  const {
    foundation,
    libraries = [],
    product,
  } = resolution.status === "ready" ? resolution.workspace : resolution;
  return [
    ...(foundation && foundation !== product
      ? [[foundation, { libraries }]]
      : []),
    [product, { foundation, libraries }],
  ].flatMap(([snapshot, options]) =>
    // The stored path and operation spell IDs; where and fix name the copy.
    // Selections and problems are keyed by axis IDs; variants lists them by name.
    staleInstanceDiagnostics(snapshot, options).map(({ path: _path, operationFix: _fix, problems: _problems, validSelections: _valid, selection: _selection, ...diagnostic }) => ({
      ...diagnostic,
      packageId: snapshot.manifest.packageId,
    })),
  );
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

const NAMED_TOKEN_WRITES = new Set([
  "theme-add",
  "theme-default",
  "theme-delete",
  "theme-rename",
  "token-delete",
  "token-set",
]);

// The token themes a read can select with --theme, and which are active.
function themeSummary(product, foundation) {
  return listTokenThemes(product, foundation).map(
    ({ active, id, owner, packageId, path }) => ({
      active,
      id,
      owner,
      packageId,
      path,
    }),
  );
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

// --path names a Token the way agents do; --token-id stays for links that
// carry an ID.
function tokenReference(args, product, others = []) {
  const path = option(args, "--path");
  if (path === undefined)
    return {
      assetId: option(args, "--token-id"),
      packageId: option(args, "--package-id") ?? product.manifest.packageId,
    };
  const requested = option(args, "--package-id");
  for (const snapshot of [product, ...others].filter(Boolean)) {
    if (requested && snapshot.manifest.packageId !== requested) continue;
    const token = [...snapshot.domain.tokens.values()].find(
      (candidate) => candidate.path === path,
    );
    if (token)
      return { assetId: token.id, packageId: snapshot.manifest.packageId };
  }
  throw new SmallPenError("missing_token", `No Token named ${path}`, { path });
}

async function writeAtomic(path, value) {
  const output = resolve(path);
  await mkdir(dirname(output), {
    recursive: true,
    ...(dirname(output) === artifactDirectory() ? { mode: 0o700 } : {}),
  });
  if (dirname(output) === artifactDirectory()) {
    const directory = await lstat(dirname(output));
    if (
      !directory.isDirectory() ||
      (process.getuid &&
        (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0))
    ) {
      throw new SmallPenError(
        "invalid_artifact_directory",
        "Temporary artifact directory must be an owned private directory",
      );
    }
  }
  const temporary = `${output}.smallpen-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
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
  "componentId",
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
      EXPLAIN_TARGET_FIELDS.filter(
        (field) => operation[field] !== undefined,
      ).map((field) => [field, operation[field]]),
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

// Save an explicit reverse edit, guarded by the confirmed revision. It is a
// new write through apply, never a command that rewinds package history.
async function writeReply(result, args) {
  if (result.alreadyApplied) result = { ...result, changed: false };
  const full = flag(args, "--full");
  const inverseOut = option(args, "--inverse-out");
  const inverseJson = result.inverseBatch
    ? `${JSON.stringify(result.inverseBatch, null, 2)}\n`
    : undefined;
  let inverseBatchPath;
  let changeReportPath;
  let undoError;
  const fileHashes = {
    ...(inverseJson
      ? {
          inverseBatchHash: createHash("sha256")
            .update(inverseJson)
            .digest("hex"),
        }
      : {}),
  };
  if ((inverseOut !== undefined || !full) && inverseJson && !result.dryRun) {
    try {
      inverseBatchPath = await writeAtomic(
        inverseOut ?? artifactPath("undo", "json"),
        inverseJson,
      );
    } catch (error) {
      // The canonical write already succeeded. Keep its confirmation even when
      // an auxiliary undo export cannot be saved; a retry must retain identity.
      const retry = [
        ...args.filter((arg) => !["--compact", "--full"].includes(arg)),
        "--full",
      ];
      const inverseIndex = retry.indexOf("--inverse-out");
      if (inverseIndex !== -1) retry.splice(inverseIndex, 2);
      if (
        batchIdWrite(args[0]) &&
        !retry.includes("--batch-id")
      )
        retry.push("--batch-id", result.batchId);
      undoError = {
        code: "inverse_output_failed",
        reason: error.code ?? "io_error",
        message:
          "The write is confirmed, but the reverse-edit file was not saved.",
        ...(args[0] === "apply" || batchIdWrite(args[0])
          ? {
              nextOperations: [
                {
                  argv: retry,
                  operation: `smallpen.${args[0]}`,
                  when: "while-still-at-the-confirmed-revision",
                },
              ],
            }
          : {
              ledgerPath: `${resolve(args[1])}.batches.json`,
              batchId: result.batchId,
            }),
      };
    }
  }
  if (result.diff && !result.dryRun && !result.alreadyApplied) {
    try {
      const report = canonicalJSON({
        batchId: result.batchId,
        baseRevision: result.baseRevision,
        revision: result.revision,
        operations: result.explain,
        entries: result.diff,
      });
      fileHashes.changeReportHash = createHash("sha256")
        .update(report)
        .digest("hex");
      changeReportPath = await writeAtomic(
        artifactPath("changes", "json"),
        report,
      );
    } catch (error) {
      // Failure to save supplementary evidence must not hide a confirmed write.
      undoError ??= {
        code: "change_report_output_failed",
        reason: error.code ?? "io_error",
        message:
          "The write is confirmed; exact differences remain in the --full reply.",
      };
    }
  }
  const reverseEdit = result.inverseBatch
    ? {
        newWrite: true,
        baseRevision: result.inverseBatch.baseRevision,
        ...(full && inverseBatchPath
          ? {
              inputPath: inverseBatchPath,
              argv: ["apply", args[1], "--batch", inverseBatchPath, "--json"],
            }
          : {}),
        guidance:
          "Verify inverseBatchHash and this baseRevision before applying; temporary files expire after 30 minutes. After later edits, read current fields and create a scoped reverse edit.",
      }
    : undefined;
  if (full) {
    return {
      ...result,
      ...fileHashes,
      ...(inverseBatchPath ? { inverseBatchPath } : {}),
      ...(changeReportPath ? { changeReportPath } : {}),
      ...(reverseEdit ? { reverseEdit } : {}),
      ...(undoError ? { undoError } : {}),
    };
  }
  const showDetails = flag(args, "--diff") || flag(args, "--explain");
  const {
    guidance: _guidance,
    inverseBatch,
    diff,
    explain,
    ...compactResult
  } = result;
  const rest = { ...compactResult, ...(showDetails ? { diff, explain } : {}) };
  const files =
    (result.changedFiles?.length ?? 0) + (result.deletedFiles?.length ?? 0);
  const warnings = result.warningSummary?.total ?? result.warnings?.length ?? 0;
  const verb = result.dryRun
    ? "Previewed"
    : result.alreadyApplied
      ? "Already applied"
      : "Applied";
  // Empty advice says nothing: leave it out of the short reply.
  if (!rest.reuseReminders?.length) delete rest.reuseReminders;
  if (!rest.reuseSummary?.total) delete rest.reuseSummary;
  return {
    ...rest,
    ...fileHashes,
    alreadyApplied: Boolean(result.alreadyApplied),
    changed: result.changed ?? !result.noChange,
    dryRun: Boolean(result.dryRun),
    ...Object.fromEntries(
      ["affectedIds", "changedFiles", "deletedFiles", "warnings", "explain"]
        .filter((key) => Array.isArray(rest[key]))
        .flatMap((key) => [
          [key, rest[key].slice(0, 20)],
          [`${key}Count`, rest[key].length],
        ]),
    ),
    ...(rest.diff
      ? {
          diff: rest.diff.slice(0, 20).map(({ changes, ...entry }) => ({
            ...entry,
            ...(changes ? { fields: Object.keys(changes) } : {}),
          })),
          diffCount: rest.diff.length,
        }
      : {}),
    ...(inverseBatch
      ? { inverseOperationCount: inverseBatch.operations.length }
      : {}),
    ...(inverseBatchPath ? { inverseBatchPath } : {}),
    ...(changeReportPath ? { changeReportPath } : {}),
    ...(reverseEdit ? { reverseEdit } : {}),
    ...(undoError ? { undoError } : {}),
    summary:
      `${verb} ${result.batchId}: revision ${result.revision}, ` +
      `${files} changed file(s), ` +
      `${warnings} warning(s).`,
  };
}

// A write by name says what it did in the words changes uses, from the
// same comparison.
async function applyBatch(packagePath, batch, args) {
  const before = publicSurface ? await openPackage(packagePath).catch(() => undefined) : undefined;
  const reply = await writeReply(await prepareAndApplyBatch(packagePath, batch, args), args);
  if (before && reply.changed && !reply.dryRun && !reply.alreadyApplied) {
    const text = designChangesText(designChanges(before, await openPackage(packagePath)));
    if (text !== "No design changes.") reply.done = text;
  }
  return reply;
}

async function prepareAndApplyBatch(packagePath, batch, args) {
  const detail = option(args, "--warning-detail") ?? "compact";
  if (!["compact", "full"].includes(detail)) {
    throw new SmallPenError(
      "invalid_warning_detail",
      "--warning-detail must be compact or full",
      {
        validValues: ["compact", "full"],
      },
    );
  }
  if (batch.blobs !== undefined) {
    throw new SmallPenError(
      "invalid_blob_writes",
      "CLI Operation Batch JSON cannot contain binary blob writes",
    );
  }
  // High-level commands rebuild their batch from the current revision, so a
  // retry with the same --batch-id after success carries the recorded result
  // as its base and may no longer prepare (its nodes already exist). Consult
  // the ledger first; previews never write and skip it.
  if (
    args[0] !== "apply" &&
    option(args, "--batch-id") !== undefined &&
    !flag(args, "--dry-run") &&
    !flag(args, "--explain") &&
    !flag(args, "--diff")
  ) {
    const replayed = await replayRecordedBatch(packagePath, batch, {
      rebuilt: true,
    });
    if (replayed) return replayed;
  }
  // 通用 apply 仍然能修复处于 Repair 的 Product；Token 建议不能变成写入门禁。
  const { foundation, libraries, product } =
    await tokenAdviceWorkspace(packagePath);
  let prepared;
  try {
    // Foundation and Library components let preparation check Instance
    // override paths that target them.
    prepared = await prepareOperationBatch(product, batch, {
      foundation,
      libraries,
    });
  } catch (error) {
    if (error?.code === "stale_revision") {
      const replayed = await replayRecordedBatch(packagePath, batch);
      if (replayed) return replayed;
    }
    throw error;
  }
  validatePrototypeChanges(product, prepared.snapshot);
  const { suppressed, warnings } = designTokenAdviceForBatch(
    prepared.snapshot,
    batch,
    {
      foundation,
      before: product,
    },
  );
  // A reminder names the Token to bind: an exact match alone, with just
  // its path, value and reference.
  const reuse = [
    ...warnings
      .filter(({ code }) => code === "design_token_not_used")
      .map(({ contextScope: _scope, suggestions, valueSource: _source, ...item }) => ({
        ...item,
        suggestions: suggestions
          .filter(({ exactValue }) => exactValue)
          .map(({ path, reference, value }) => ({ path, reference, value })),
      })),
    ...definitionReuseAdvice(product, batch, { foundation, libraries }),
  ];
  // Import warnings have their own schema and are not design-style advice.
  const advice =
    args[0] === "import-tokens"
      ? { warnings }
      : warningOutput(warnings, detail, {
          confirmUnmatched: flag(args, "--confirm-unmatched"),
          suppressed,
        });
  const formatWarnings = formatWarningsForBatch(batch);
  advice.reuseReminders = reuse.slice(0, 3);
  advice.reuseSummary = {
    total: reuse.length,
    shown: Math.min(reuse.length, 3),
    remaining: Math.max(0, reuse.length - 3),
    scope: "this-batch-only",
    note: "Advice, not a write gate. Search existing Tokens/components before creating new assets.",
  };
  if (formatWarnings.length > 0) {
    advice.warnings = [...formatWarnings, ...(advice.warnings ?? [])];
    if (advice.warningSummary) {
      advice.warningSummary = {
        ...advice.warningSummary,
        formatWarnings: formatWarnings.length,
        total: advice.warningSummary.total + formatWarnings.length,
      };
    }
  }
  const change = changeSummary(product, prepared, batch);
  if (flag(args, "--explain") || flag(args, "--diff")) {
    // explain/diff are read-only previews in any combination; neither flag
    // writes, with or without --dry-run (CLI-AI-TOPIC: "explain and diff
    // never write").
    return {
      ...prepared.result,
      ...explainBatch(product, prepared, batch),
      ...change,
      dryRun: true,
      ...advice,
    };
  }
  if (flag(args, "--dry-run")) {
    return { ...prepared.result, ...change, dryRun: true, ...advice };
  }
  return {
    // The Foundation lets a Product select the Foundation's token themes.
    ...(await trackedWrite(() =>
      applyOperationBatch(packagePath, batch, {
        dependencies: { foundation, libraries },
      }),
    )),
    baseRevision: product.revision,
    ...explainBatch(product, prepared, batch),
    ...change,
    ...advice,
  };
}

// A valid batch can still leave every byte as it was (for example a value
// that is already set). Say so instead of reporting a silent success.
function changeSummary(before, prepared, batch) {
  if (prepared.snapshot.revision !== before.revision) return { changed: true };
  return {
    changed: false,
    noChange: {
      code: "no_change",
      message:
        `The batch is valid but changes nothing: the ${batch.operations.length} ` +
        "operation(s) leave the Package at its current revision. Check the " +
        "targets and values (smallpen view PACKAGE --page NAME --json).",
    },
  };
}

function searchValue(args) {
  const color = option(args, "--color");
  const source = option(args, "--value");
  if (color !== undefined) return { type: "color", value: color };
  if (source === undefined) return {};
  try {
    return { value: JSON.parse(source) };
  } catch {
    return { value: source };
  }
}

async function initializeCommand(workspacePath, args) {
  const layout = option(args, "--layout") ?? "single";
  const answersPath = option(args, "--answers");
  // Compatibility for explicit complete briefs in older scripts. Public
  // project init never exposes this import, and no CLI mode asks questions.
  if (answersPath) {
    const answers = parseJson(
      await readInputFile(answersPath, "--answers", "utf8"),
      "invalid_initialization_answers_json",
      { path: answersPath },
    );
    if (!isRecord(answers)) {
      throw new SmallPenError(
        "invalid_initialization_answers_json",
        "--answers must contain a JSON object",
      );
    }
    const state = createInitializationState({
      ...answers,
      ...(args.includes("--layout")
        ? { foundationChoice: INIT_LAYOUTS[layout] }
        : {}),
    });
    if (state.status !== "proposal") {
      throw new SmallPenError(
        "incomplete_initialization_brief",
        "Legacy brief import requires all fields; use project init to create a blank package",
        {
          missing: state.pendingQuestionIds,
          nextOperations: [
            {
              operation: "smallpen.help",
              argv: ["help", "project", "init", "--json"],
            },
          ],
        },
      );
    }
    const initialized = await trackedWrite(() =>
      initializeWorkspace(workspacePath, state.proposal, { confirmed: true }),
    );
    return { ...initialized, ...(await initializedSummary(initialized)) };
  }
  // A blank package has no pages yet: page draw makes the first.
  const initialized = await trackedWrite(() =>
    initializeBlankWorkspace(workspacePath, {
      layout,
      name: option(args, "--name"),
      page: false,
    }),
  );
  const paths = [initialized.packagePath, initialized.foundationPath, initialized.productPath].filter(Boolean);
  const opened = await Promise.all(paths.map((path) => openPackage(path)));
  const summary = (snapshot) => ({ name: snapshot.manifest.name, path: snapshot.locator, revision: snapshot.revision });
  return {
    ...initialized,
    packages: initialized.packagePath
      ? { package: summary(opened[0]) }
      : { foundation: summary(opened[0]), product: summary(opened[1]) },
    next: "token set, component define, then page draw for the first page",
  };
}

// The init reply names every id the first writes need (Packages, Screen,
// root node, starter Tokens, token themes and Component Sets), so an Agent
// can start without reading the new files.
async function initializedSummary({
  foundationPath,
  packagePath,
  productPath,
}) {
  const single = packagePath !== undefined;
  const foundation = await openPackage(single ? packagePath : foundationPath);
  const product = single ? foundation : await openPackage(productPath);
  const screenEntry = product.manifest.entries.screens.find(
    (entry) => product.entries[entry].id === product.manifest.defaultScreenId,
  );
  const screen = product.entries[screenEntry];
  const presentation = screen.presentations.find(
    ({ id }) => id === screen.basePresentationId,
  );
  const root = presentation.nodes[presentation.rootId];
  const packageSummary = (snapshot) => ({
    packageId: snapshot.manifest.packageId,
    path: snapshot.locator,
    revision: snapshot.revision,
  });
  const library = tokenLibraryOf(foundation);
  const setOf = new Map(
    (library?.sets ?? []).flatMap((tokenSet) =>
      tokenSet.tokens.map((token) => [token.id, tokenSet]),
    ),
  );
  const themes = listTokenThemes(product, single ? undefined : foundation);
  const inactive = themes.find(({ active }) => !active);
  return {
    packages: single
      ? { package: packageSummary(foundation) }
      : {
          foundation: packageSummary(foundation),
          product: packageSummary(product),
        },
    start: {
      contextAxes: [...foundation.domain.contextAxes.values()].map(
        ({ defaultValue, id, name, values }) => ({
          defaultValue,
          id,
          name: name ?? id,
          values: values.map((value) => value.id),
        }),
      ),
      presentationId: presentation.id,
      rootNode: { height: root.height, id: root.id, width: root.width },
      scenarioIds: [...product.domain.scenarios.keys()].sort(compareText),
      screenId: screen.id,
    },
    seeded: {
      componentSets: [...foundation.domain.componentSets.values()].map(
        ({ axes, id, name, variants }) => ({
          axes: axes.map((axis) => axis.id),
          componentId: id,
          name,
          packageId: foundation.manifest.packageId,
          variants: variants.map((variant) => ({
            rootId: variant.rootId,
            selection: variant.selection,
            label: axes.map((axis) => `${axis.name}=${variant.selection?.[axis.id]}`).join(", "),
            variantId: variant.id,
          })),
        }),
      ),
      note:
        "Starter content. token set, component define and page draw change or replace it by " +
        "name; a theme option's own value is a token set value for that option. " +
        (single
          ? "Write everything to packages.package.path."
          : "Write Tokens, themes and Component Sets to packages.foundation.path; " +
            "write Screens and nodes to packages.product.path."),
      tokenSets: (library?.sets ?? []).map(({ id, name, tokens }) => ({
        name,
        setId: id,
        tokenCount: tokens.length,
      })),
      tokens: [...foundation.domain.tokens.values()].map(
        ({ filePath, id, path, rawValue, type }) => ({
          filePath,
          packageId: foundation.manifest.packageId,
          path,
          ...(setOf.has(id) ? { setId: setOf.get(id).id } : {}),
          tokenId: id,
          type,
          value: rawValue,
        }),
      ),
    },
    themes: themes.map(({ active, id, path, setIds }) => ({
      active,
      path,
      setIds,
      themeId: id,
    })),
    ...(inactive
      ? {
          themeUsage:
            `Read another theme without writing: smallpen view ${product.locator} ` +
            `--theme ${inactive.path} --json. Store the selection with set-active-token-themes.`,
        }
      : {}),
  };
}

// Diagnostics say where by element name, so they read without node IDs.
// Sizes the preview cannot compute become one note, and a font fallback
// one entry per missing family.
function nameDiagnostics(diagnostics = [], projection) {
  const nodes = projection?.nodes ?? {};
  const name = (id) => (Object.hasOwn(nodes, id) ? elementPath(nodes, projection.rootId, id) || nodes[id].name : undefined);
  const limits = diagnostics.filter((diagnostic) => diagnostic.code === "layout_projection_partial");
  const fallbacks = new Map();
  const rest = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "layout_projection_partial") continue;
    if (diagnostic.code === "font_render_fallback" && !diagnostic.availableFonts) {
      const family = diagnostic.details?.requestedFont ?? diagnostic.message;
      const entry = fallbacks.get(family);
      if (entry) {
        entry.count += 1;
        if (diagnostic.nodeId !== undefined) entry.nodeIds.push(diagnostic.nodeId);
        continue;
      }
      const first = { ...diagnostic, count: 1, nodeIds: diagnostic.nodeId !== undefined ? [diagnostic.nodeId] : [] };
      delete first.nodeId;
      fallbacks.set(family, first);
      rest.push(first);
      continue;
    }
    rest.push(diagnostic);
  }
  if (limits.length)
    rest.push({
      code: "layout_projection_partial",
      count: limits.length,
      message: `The local preview cannot compute some automatic sizes in ${limits.length} place${limits.length === 1 ? "" : "s"}; geometry there may differ in the App.`,
    });
  return rest.map((diagnostic) => {
    const at = diagnostic.nodeId ?? diagnostic.instanceId;
    const element = at !== undefined ? name(at) : undefined;
    const elements = Array.isArray(diagnostic.nodeIds) ? diagnostic.nodeIds.map(name).filter(Boolean) : undefined;
    // The stored path spells node IDs; the element name replaces it.
    const { path: _path, ...rest } = element ? diagnostic : { path: undefined, ...diagnostic };
    // A font missing from every text is one fact, not a list of texts.
    const listed = elements?.length > 3 ? { elements: elements.slice(0, 3), moreElements: elements.length - 3 } : elements?.length ? { elements } : {};
    return { ...rest, ...(element ? { element } : {}), ...listed };
  });
}

// The renderer reports one font_render_fallback per text node. Collapse them
// to one diagnostic per missing family that names the fonts it can draw and
// the import-font command that adds the missing one.
async function renderEvidence(product, options) {
  const bundle = await createEvidence(product, options);
  const fallbacks = new Map();
  const diagnostics = [];
  for (const diagnostic of bundle.render.diagnostics) {
    if (diagnostic.code !== "font_render_fallback") {
      diagnostics.push(diagnostic);
      continue;
    }
    const requestedFont =
      diagnostic.details?.requestedFont ??
      /substituted .+ for (.+)$/.exec(diagnostic.message)?.[1] ??
      "<family>";
    let collapsed = fallbacks.get(requestedFont);
    if (!collapsed) {
      collapsed = { diagnostic, nodeIds: [], paths: [], requestedFont };
      fallbacks.set(requestedFont, collapsed);
      diagnostics.push(collapsed);
    }
    if (diagnostic.nodeId !== undefined)
      collapsed.nodeIds.push(diagnostic.nodeId);
    if (diagnostic.path !== undefined) collapsed.paths.push(diagnostic.path);
  }
  if (fallbacks.size === 0) return bundle;
  const imported = [
    ...new Set(
      [options.foundation, ...(options.libraries ?? []), product]
        .filter(Boolean)
        .flatMap((snapshot) =>
          snapshot.manifest.entries.assets.flatMap((entry) =>
            (snapshot.entries[entry].fonts ?? []).map(({ family }) => family),
          ),
        ),
    ),
  ].sort(compareText);
  const availableFonts = [
    "Source Sans Pro (bundled)",
    ...imported.map((family) => `${family} (imported)`),
  ];
  const collapsedEntries = new Set(fallbacks.values());
  const explained = diagnostics.map((entry) => {
    if (!collapsedEntries.has(entry)) return entry;
    const { requestedFont } = entry;
    return {
      availableFonts,
      code: entry.diagnostic.code,
      nodeIds: entry.nodeIds,
      details: {
        ...entry.diagnostic.details,
        requestedFont,
        substituteFont:
          entry.diagnostic.details?.substituteFont ?? "Source Sans Pro",
      },
      message:
        `${entry.diagnostic.message} on ${entry.nodeIds.length} text node(s): ` +
        `${requestedFont} is neither bundled nor imported. Available fonts: ` +
        `${availableFonts.join(", ")}. Import ${requestedFont} with smallpen asset font import ` +
        "(once per weight/style; see nextOperations), or use an available family.",
      nextOperations: [
        {
          argv: [
            "import-font",
            product.locator,
            "--file",
            `<${requestedFont} .ttf|.otf|.woff file>`,
            "--family",
            requestedFont,
            "--weight",
            "<400|700|...>",
            "--json",
          ],
          operation: "smallpen.import-font",
        },
      ],
      nodeIds: entry.nodeIds,
      paths: entry.paths,
      requestedFont,
    };
  });
  bundle.render.diagnostics = explained;
  bundle.evidence.diagnostics = explained;
  return bundle;
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
    ...(includeBase64
      ? { base64: Buffer.from(bundle.render.bytes).toString("base64") }
      : {}),
  };
}

// The generated Design System page, the same node tree the editor draws:
// every Token Cell and representative samples of each Component Set.
// part narrows the page: {only, tokenPrefix, componentSetIds, allVariants}.
async function designSystemProjection(workspace, args, part) {
  const { foundation, libraries, product } = workspace;
  const runtime = await createWorkspaceRuntime(product, { foundation });
  const refs = { ...(runtime.designSystemRefs ?? {}) };
  const locale = option(args, "--locale") ?? "en";
  const sources = { foundation, libraries, locale };
  if (part?.tokenPrefix)
    refs.specimens = Object.fromEntries(
      Object.entries(refs.specimens ?? {}).filter(([, specimen]) =>
        tokenUnder(specimen.path, part.tokenPrefix),
      ),
    );
  if (part?.only === "tokens") {
    refs.componentSamples = [];
    refs.families = [];
  }
  if (part?.componentSetIds) {
    refs.componentSamples = (refs.componentSamples ?? []).filter((sample) =>
      part.componentSetIds.includes(sample.componentSetId),
    );
    refs.families = [];
  }
  const page = buildDesignSystemPage(refs, runtime.designSystem ?? {}, {
    ...designSystemPageOptions(product, sources),
    ...(part
      ? {
          only: part.only,
          minWidth: part.only === "tokens" ? 1400 : 960,
          minColumns: 1,
          ...(part.allVariants
            ? { allVariantsOf: new Set(part.componentSetIds) }
            : {}),
        }
      : {}),
  });
  const tree = expandDesignSystemPage(page, refs, {
    locatedNodes: (family) => locatedFamilySource(product, family, sources),
  });
  return tree;
}

async function renderDesignSystem(workspace, args) {
  const { product, foundation, libraries } = workspace;
  const tree = await designSystemProjection(workspace, args);
  const render = await renderProjection(product, tree, {
    foundation,
    libraries,
    scale: numberOption(args, "--scale"),
  });
  return {
    evidence: {
      selector: {
        designSystem: true,
        locale: option(args, "--locale") ?? "en",
      },
    },
    render,
  };
}

async function designForCommand(workspace, args) {
  if (flag(args, "--design-system")) {
    const projection = await designSystemProjection(workspace, args);
    return {
      projection,
      tree: createSemanticTree(workspace.product, projection),
      selection: {
        designSystem: true,
        locale: option(args, "--locale") ?? "en",
        ...themeSettings(workspace).selection,
      },
    };
  }
  return selectedDesign(workspace, designSelector(args), {
    componentId: option(args, "--component-id"),
    packageId: option(args, "--package-id"),
    variantId: option(args, "--variant-id"),
    nodeId: option(args, "--node-id"),
  });
}

async function designCommand(packagePath, args, override) {
  const workspace = await tokenWorkspace(packagePath, args);
  const design = override ?? (await designForCommand(workspace, args));
  const format =
    option(args, "--format") ?? (args[0] === "view" ? "outline" : "wireframe");
  const receipt = {
    packageId: workspace.product.manifest.packageId,
    ...workspaceRevisions(
      workspace.product,
      workspace.foundation,
      workspace.libraries,
    ),
    selection: design.selection,
    // Path and resolved value say what the selection resolves to; --full
    // adds each binding's reference and source. A PNG says it in pixels.
    ...(format === "png" && !flag(args, "--full") ? {} : {
      tokenSources: flag(args, "--full")
        ? design.tokenSources
        : design.tokenSources?.map(({ path, value }) => ({ path, value })),
    }),
    diagnostics: nameDiagnostics(design.projection.diagnostics ?? [], design.projection),
  };
  const hints = platformHints(workspace, design);
  if (hints.length) receipt.hints = hints;
  const textLayout = {
    lineEnding: "LF",
    monospace: true,
    preserveSpaces: true,
    wrap: false,
    reading:
      "Decode the JSON string before displaying; preserve newlines and alignment spaces in a monospace block. Text artifacts contain actual LF characters.",
  };
  const components = componentLookup(workspace);
  const structure = outlineTree(design.tree, design.projection, {
    components,
    full: flag(args, "--full"),
  });
  // A component reads as its properties and what each changes, then the
  // main variant's structure.
  // A chosen variant or element says so instead of "main variant".
  const chosen = design.selection?.componentId
    ? components({
        assetId: design.selection.componentId,
        packageId: design.selection.packageId,
      })?.variants.find(({ id }) => id === design.selection.variantId)
    : undefined;
  const chosenSet = chosen
    ? components({
        assetId: design.selection.componentId,
        packageId: design.selection.packageId,
      })
    : undefined;
  const heading = option(args, "--node-id")
    ? `Element in ${chosenSet ? variantLabel(chosenSet, chosen) : "the main variant"}:`
    : chosen && chosen.id !== chosenSet?.variants[0]?.id
      ? `Structure of ${variantLabel(chosenSet, chosen)}:`
      : undefined;
  const outline = design.component
    ? `${componentSummaryText(design.component, components, heading)}\n${structure}`
    : structure;
  if (args[0] === "view") {
    if (["structure", "semantic"].includes(format)) {
      const summary = viewSummary(
        {
          format,
          result: format === "semantic" ? design.tree : design.projection,
          selection: design.selection,
        },
        viewPagination(args),
      );
      return {
        ...receipt,
        format,
        result: summary.result,
        page: summary.result.page,
      };
    }
    const text =
      format === "wireframe"
        ? localWireframe(design, { full: flag(args, "--full") })
        : format === "spec"
          ? specTree(design.tree, design.projection, {
              components,
              tokenName: tokenNamer(workspace),
              stored: storedNodesOf(workspace, design.selection),
              heading: `Spec · px, x/y from the top-left of ${design.tree.root.name} · themes ${themeSettings(workspace).selection.themes.join(", ") || "defaults"} · {path} = Token`,
            })
          : outline;
    const lines = text.split("\n");
    // A page outline reads whole; long ones page at 80 lines.
    const offset = integerOption(args, "--offset"),
      limit =
        flag(args, "--full") && !args.includes("--limit")
          ? lines.length
          : args.includes("--limit") ? integerOption(args, "--limit") : 80;
    const rest = lines.length - offset - limit;
    return {
      ...receipt,
      format,
      ...(design.component ? { component: design.component } : {}),
      [format === "wireframe" ? "wireframe" : "outline"]:
        format === "wireframe"
          ? text
          : [...lines.slice(offset, offset + limit),
              ...(rest > 0 ? [`… ${rest} more line${rest === 1 ? "" : "s"}: add --offset ${offset + limit}`] : [])].join("\n"),
      ...(format === "outline" || format === "spec"
        ? {
            page: {
              unit: "lines",
              offset,
              limit,
              total: lines.length,
              hasMore: offset + limit < lines.length,
            },
          }
        : { lineCount: lines.length, textLayout }),
      contentBytes: Buffer.byteLength(text),
      nextOperations: [
        {
          argv: ["validate", packagePath, ...designArgs(args)],
          operation: "smallpen.validate",
        },
      ],
    };
  }
  if (format === "png") {
    const render = await renderProjection(
      workspace.product,
      design.renderProjection ?? design.projection,
      { ...workspace, crop: design.crop, scale: numberOption(args, "--scale") },
    );
    const output = await writeAtomic(
      option(args, "--output") ?? artifactPath("render", "png"),
      render.bytes,
    );
    const relevant = new Set([
      ...Object.keys(design.projection.nodes),
      ...(design.ancestors ?? []).map((node) => node.id),
    ]);
    return {
      ...receipt,
      output,
      bytes: render.bytes.length,
      width: render.width,
      height: render.height,
      mimeType: render.mimeType,
      renderHash: render.renderHash,
      ...(flag(args, "--base64")
        ? { imageBase64: Buffer.from(render.bytes).toString("base64") }
        : {}),
      diagnostics: nameDiagnostics(
        render.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code !== "layout_projection_partial" ||
            relevant.has(diagnostic.nodeId),
        ),
        design.renderProjection ?? design.projection,
      ),
    };
  }
  const text = `${JSON.stringify(receipt)}\n\n${format === "wireframe" ? localWireframe(design) : outline}\n`;
  const output = await writeAtomic(
    option(args, "--output") ?? artifactPath(format, "txt"),
    text,
  );
  return {
    ...receipt,
    output,
    bytes: Buffer.byteLength(text),
    mimeType: "text/plain",
    textLayout,
    artifactHash: createHash("sha256").update(text).digest("hex"),
  };
}

async function validationDesigns(workspace, args) {
  if (!flag(args, "--all")) return [await designForCommand(workspace, args)];
  const componentId = option(args, "--component-id"),
    screenId = option(args, "--screen-id");
  if (!componentId && !screenId)
    throw new SmallPenError(
      "missing_check_target",
      "--all requires one --component-id or one --screen-id; it never checks the whole project",
    );
  if (componentId) {
    const first = await designForCommand(workspace, args);
    const owner = [
      workspace.product,
      workspace.foundation,
      ...(workspace.libraries ?? []),
    ].find(
      (snapshot) => snapshot?.manifest.packageId === first.selection.packageId,
    );
    return owner.domain.componentSets.get(componentId).variants.map((variant) =>
      selectedDesign(workspace, designSelector(args), {
        componentId,
        packageId: first.selection.packageId,
        variantId: variant.id,
      }),
    );
  }
  const screen = workspace.product.manifest.entries.screens
    .map((entry) => workspace.product.entries[entry])
    .find((screen) => screen.id === screenId);
  if (!screen)
    throw new SmallPenError("missing_screen", `No Screen ${screenId}`);
  return screen.presentations.map((presentation) =>
    selectedDesign(workspace, {
      ...designSelector(args),
      screenId,
      presentationId: presentation.id,
    }),
  );
}

// Keep the same target and complete theme selection in follow-up commands.
function designArgs(args) {
  // Names, as the caller gave them; the IDs they stand for stay internal.
  const names = new Set([
    "--page",
    "--platform",
    "--component",
    "--variant",
    "--element",
    "--context",
    "--theme",
  ]);
  const result = [];
  for (let index = 2; index < args.length; index++) {
    if (names.has(args[index])) result.push(args[index], args[++index]);
    else if (args[index] === "--design-system") result.push(args[index]);
  }
  return [...result, "--json"];
}

async function renderCommand(packagePath, args, evidenceOnly) {
  const workspace = await tokenWorkspace(packagePath, args);
  const { foundation, libraries, product } = workspace;
  if (!evidenceOnly && flag(args, "--design-system")) {
    const bundle = await renderDesignSystem(workspace, args);
    const inline = flag(args, "--base64");
    const output =
      option(args, "--output") ??
      (inline ? undefined : artifactPath("render", "png"));
    return deliverImage(
      bundle,
      workspace,
      output,
      (inline && output === undefined) || flag(args, "--base64"),
    );
  }
  const bundle = await renderEvidence(product, {
    foundation,
    libraries,
    scale: numberOption(args, "--scale"),
    selector: designSelector(args, "screenshot"),
  });
  const full = flag(args, "--full");
  const inline = flag(args, "--base64");
  const output =
    option(args, "--output") ??
    (inline ? undefined : artifactPath("render", "png"));
  const evidenceJson = evidenceOnly
    ? canonicalJSON({
        ...bundle.evidence,
        ...workspaceRevisions(product, foundation, libraries),
      })
    : undefined;
  if (evidenceOnly && !inline) {
    const prefix = option(args, "--output");
    const imagePath = await writeAtomic(
      prefix === undefined ? output : `${prefix}.png`,
      bundle.render.bytes,
    );
    const evidencePath = await writeAtomic(
      prefix === undefined
        ? artifactPath("evidence", "json")
        : `${prefix}.json`,
      evidenceJson,
    );
    return {
      ...(full ? bundle.evidence : {}),
      diagnostics: nameDiagnostics(bundle.render.diagnostics, bundle.projection),
      renderHash: bundle.render.renderHash,
      selection: bundle.evidence.selector,
      packageId: product.manifest.packageId,
      ...workspaceRevisions(product, foundation, libraries),
      evidencePath,
      imagePath,
    };
  }
  if (evidenceOnly && output !== undefined) {
    const imagePath = await writeAtomic(`${output}.png`, bundle.render.bytes);
    const evidencePath = await writeAtomic(`${output}.json`, evidenceJson);
    return {
      ...bundle.evidence,
      ...workspaceRevisions(product, foundation, libraries),
      imagePath,
      evidencePath,
    };
  }
  const image = await deliverImage(
    bundle,
    workspace,
    output,
    (output === undefined && inline) || flag(args, "--base64"),
  );
  return evidenceOnly
    ? {
        ...bundle.evidence,
        ...workspaceRevisions(product, foundation, libraries),
        image,
      }
    : image;
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
          page: screen.name,
          platform: presentation.platform ?? presentation.name,
          element: elementPath(presentation.nodes, presentation.rootId, node.id) || node.name,
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
            component: component.name,
            variant: variantLabel(component, variant),
            element: elementPath(variant.nodes, variant.rootId, node.id) || node.name,
            nodeId: node.id,
            variantId: variant.id,
          });
        }
      }
    }
  }
  return locations.sort((left, right) =>
    compareText(JSON.stringify(left), JSON.stringify(right)),
  );
}

function catalogItemSummary(component, owners) {
  const owner = owners.find(
    (snapshot) => snapshot?.manifest.packageId === component.packageId,
  );
  const set = owner?.domain.componentSets.get(component.id);
  return {
    ...discoverySummary(component, set ?? component),
    // Variants by name, as view --variant takes them.
    ...(set?.axes?.length ? { variants: set.variants.map((variant) => variantLabel(set, variant)) } : {}),
  };
}

function selectedRepairConflict(resolution, args) {
  const index = integerOption(
    args,
    "--conflict",
    resolution.conflicts.length - 1,
  );
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
  const choice = conflict.choices.find(
    (candidate) => candidate.action === action,
  );
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
  if (action === "select-instance-variant") {
    // The closest variant unless --selection names another one.
    const selected = option(args, "--selection");
    const selection = selected
      ? parseJson(selected, "invalid_repair_selection", {
          option: "--selection",
        })
      : choice.selection;
    if (choice.componentSetId) {
      const instance = structuredClone(
        resolution.product.domain.componentSets
          .get(choice.componentSetId)
          ?.variants.find(({ id }) => id === choice.variantId)?.nodes[
          choice.nodeId
        ]?.instance,
      );
      return [
        {
          changes: { instance: { ...instance, variant: selection } },
          componentId: choice.componentSetId,
          nodeId: choice.nodeId,
          type: "update-component-node",
          unset: [],
          variantId: choice.variantId,
        },
      ];
    }
    return [
      {
        nodeId: choice.nodeId,
        presentationId: choice.presentationId,
        screenId: choice.screenId,
        selection,
        type: "select-instance-variant",
      },
    ];
  }
  if (action === "retarget-reference") {
    const packageId = option(args, "--replacement-package-id");
    const assetId = option(args, "--replacement-asset-id");
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
    if (choice.assetKind && kind !== choice.assetKind) {
      throw new SmallPenError(
        "repair_asset_kind_mismatch",
        `Repair requires a ${choice.assetKind} replacement`,
        { actualKind: kind, expectedKind: choice.assetKind },
      );
    }
    const asset = parseJson(
      await readInputFile(assetPath, "--asset", "utf8"),
      "invalid_recreated_asset_json",
      { path: assetPath },
    );
    const create =
      kind === "token"
        ? { ...asset, type: "put-token" }
        : {
            componentSet: asset.componentSet ?? asset,
            type: "put-component-set",
          };
    const assetId =
      kind === "token" ? asset.tokenId : (asset.componentSet ?? asset).id;
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

// SP-017: a reusable candidate says how to place it, by name: the element
// to add to a page draw intent, with a legal variant chosen.
function insertionAdvice(owner, product, component) {
  if (!owner || owner.remote || component.kind !== "set") return undefined;
  const set = owner.domain.componentSets.get(component.id);
  const legal = set?.variants[0];
  if (!legal) return undefined;
  const props = Object.fromEntries(
    (set.axes ?? [])
      .filter((axis) => legal.selection?.[axis.id] !== undefined)
      .map((axis) => [axis.name, legal.selection[axis.id]]),
  );
  return {
    element: { use: set.name, ...(Object.keys(props).length ? { props } : {}) },
    how: "Add this element to the children of a page draw intent; props pick the variant",
    nextOperations: [{ argv: ["schema", "page-draw", "--json"], operation: "smallpen.schema" }],
  };
}

// SP-018: deleting a shared Component is refused while known same-workspace
// consumers still use it. Unknown offline consumers are out of scope and are
// documented as such in the command help.
async function checkExternalComponentConsumers(packagePath, operations) {
  const componentIds = new Set();
  for (const operation of operations) {
    if (
      operation?.type === "delete-component" ||
      operation?.type === "delete-component-set"
    ) {
      if (typeof operation.componentId === "string") {
        componentIds.add(operation.componentId);
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
        name.endsWith(".smallpen") &&
        resolve(root, name) !== resolve(packagePath),
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
          const assetId =
            node.instance?.component?.assetId ?? node.componentRef?.assetId;
          if (
            (node.componentId !== undefined &&
              componentIds.has(node.componentId)) ||
            (assetId !== undefined && componentIds.has(assetId))
          ) {
            usages.push({
              nodeId: node.id,
              presentationId: presentation.id,
              screenId: screen.id,
            });
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
  } else if (choice.action === "select-instance-variant") {
    base.push("--selection", JSON.stringify(choice.selection));
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
    const staleInstances = workspaceStaleInstances(resolution);
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
      ...(staleInstances.length > 0 ? { staleInstances } : {}),
      status: "repair",
    };
  }
  const { index, selected } = selectedRepairConflict(resolution, args);
  const action = option(args, "--action");
  const operations = await repairOperations(resolution, selected, action, args);
  const result = await trackedWrite(() =>
    applyOperationBatch(resolution.product.locator, {
      baseRevision: resolution.product.revision,
      batchId: option(args, "--batch-id") ?? `repair_${randomUUID()}`,
      operations,
    }),
  );
  const next = await resolveCliWorkspace(packagePath);
  return {
    action,
    conflictIndex: index,
    result,
    status: next.status,
    ...(next.status === "repair" ? { conflicts: next.conflicts } : {}),
  };
}

function discoveryArguments(command, args) {
  const positional = [],
    options = [];
  const definitions = Object.values(commandContract(command).parameters);
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    options.push(value);
    const parameter = definitions.find(({ option }) => option === value);
    if (
      parameter &&
      parameter.type !== "boolean" &&
      args[index + 1] !== undefined
    )
      options.push(args[++index]);
  }
  validateCommandArguments(command, [command, "", ...options]);
  const commandOffset = command === "schema" && positional[0] === "command" ? 1 : 0;
  const matched = command === "help" || commandOffset ? commandMatch(positional.slice(commandOffset)) : undefined;
  const maximum = matched?.length ?? (commandOffset ? 3 : 2);
  const allowed = matched ? maximum + commandOffset : maximum;
  if (positional.length > allowed)
    throw new SmallPenError(
      "unexpected_argument",
      `Unexpected positional argument: ${positional[allowed]}`,
      {
        argument: positional[allowed],
        nextOperations: [
          { operation: `smallpen.${command}`, argv: [command, "--json"] },
        ],
      },
    );
  return matched
    ? [...positional.slice(0, commandOffset + 1), ...(positional.length > commandOffset + 1 ? [positional.slice(commandOffset + 1).join(" ")] : [])]
    : positional;
}

// Each Token's value under the other theme options, where it differs.
async function optionValuesFor(packagePath, args, items, { context, libraries }) {
  const raw = await readableWorkspace(packagePath);
  const chosen = options(args, "--theme");
  return tokenOptionValues(
    raw.foundation ?? raw.product,
    items.map((item) => ({ path: item.token.path, value: item.value })),
    (path) => {
      const group = path.split("/")[0];
      const selected = selectTokenThemes(
        { foundation: raw.foundation, product: raw.product },
        [...chosen.filter((theme) => theme.split("/")[0] !== group), path],
      );
      return new Map(
        listEffectiveTokens(selected.product, {
          context,
          foundation: selected.foundation,
          libraries,
        }).map((item) => [item.token.path, item.value]),
      );
    },
  );
}

function tokenUnder(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}.`);
}

// Options a delegated read keeps: the theme, locale, paging and PNG output.
function lookPass(args) {
  const out = [];
  for (const name of [
    "--theme",
    "--context",
    "--locale",
    "--limit",
    "--offset",
    "--scale",
    "--output",
  ])
    for (const value of options(args, name)) out.push(name, value);
  for (const name of ["--full", "--stdout"]) if (flag(args, name)) out.push(name);
  return out;
}

// The call without --as, to suggest another form of the same look.
function lookAgain(args, as) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--as") {
      index += 1;
      continue;
    }
    if (args[index] !== "--json") out.push(args[index]);
  }
  return [{ argv: [...out, "--as", as, "--json"], operation: "smallpen.view" }];
}

function lookResult(target, result, args, as) {
  const {
    nextOperations: _next,
    outline,
    format: _format,
    ...rest
  } = result;
  return {
    target,
    as,
    ...(outline !== undefined ? { text: outline } : {}),
    ...rest,
    nextOperations: lookAgain(args, as === "issues" ? "text" : "issues"),
  };
}

async function lookAt(packagePath, args, ids, target) {
  const as = option(args, "--as") ?? "text";
  const pass = lookPass(args);
  if (as === "issues") {
    const report = await validateCommand(packagePath, ["validate", packagePath, ...ids, ...pass]);
    const listed = lookIssueList(report.issues, args);
    return lookResult(
      target,
      flag(args, "--full")
        ? report
        : {
            issueCount: listed.issues.length,
            ...listed,
            ...(report.hints ? { hints: report.hints } : {}),
            revision: report.revision,
          },
      args,
      as,
    );
  }
  const argv =
    as === "png"
      ? ["export", packagePath, ...ids, "--format", "png", ...pass]
      : ["view", packagePath, ...ids, "--format", as === "wireframe" || as === "spec" ? as : "outline", ...pass];
  return lookResult(target, await designCommand(packagePath, argv), args, as);
}

// A design-system style sheet (Tokens, components, variants) as a
// wireframe or PNG.
async function lookSheet(packagePath, args, workspace, part, target) {
  const as = option(args, "--as") ?? "text";
  const projection = await designSystemProjection(workspace, args, part);
  const design = {
    projection,
    tree: createSemanticTree(workspace.product, projection),
    selection: { ...target, ...themeSettings(workspace).selection },
  };
  const argv =
    as === "png"
      ? ["export", packagePath, "--format", "png", ...lookPass(args)]
      : ["view", packagePath, "--format", "wireframe", ...lookPass(args)];
  return lookResult(target, await designCommand(packagePath, argv, design), args, as);
}

// Issues read by name: where says the element, IDs need --full. Preview
// limits (sizes the local renderer cannot compute) are the tool's, not the
// design's, so they become one note.
function lookIssueList(issues, args, target, describe) {
  const limits = issues.filter((issue) => issue.code === "layout_projection_partial");
  const design = issues.filter((issue) => issue.code !== "layout_projection_partial");
  const named = flag(args, "--full")
    ? design
    : design.map(({ nodeId: _node, otherNodeId: _other, unsupportedFields: _fields, target: inner, ...issue }) => {
        const detail = inner && describe ? describe(inner) : undefined;
        return {
          ...(target ? { target: detail ? `${target} (${detail})` : target } : {}),
          ...issue,
        };
      });
  return {
    issues: named,
    ...(limits.length
      ? {
          previewNote: `The local preview cannot compute some automatic sizes in ${limits.length} place${limits.length === 1 ? "" : "s"}; geometry there may differ in the App. Check those with the App or a PNG.`,
        }
      : {}),
  };
}

// Issues of several targets in one list; each issue says where it is.
async function lookIssues(packagePath, args, targets, target, extra = []) {
  const issues = [...extra];
  let checked = 0;
  let notes = 0;
  for (const { ids, where, describe } of targets) {
    const report = await validateCommand(packagePath, [
      "validate",
      packagePath,
      ...ids,
      "--full",
      ...lookPass(args).filter((item) => item !== "--full"),
    ]);
    checked += 1;
    const listed = lookIssueList(report.issues, args, where, describe);
    issues.push(...listed.issues);
    if (listed.previewNote) notes += 1;
  }
  const page = pageItems(issues, pagination(args));
  return {
    target,
    as: "issues",
    checked,
    issueCount: issues.length,
    issues: flag(args, "--full") ? issues : page.items,
    ...(flag(args, "--full") ? {} : { page: page.page }),
    ...(notes
      ? {
          previewNote: `The local preview cannot compute some automatic sizes in ${notes} of ${checked} targets; geometry there may differ in the App.`,
        }
      : {}),
    nextOperations: lookAgain(args, "text"),
  };
}

// Which variant or page version a --all report's issue came from.
const describeVariant = (set) => (selection) => {
  const variant = set.variants.find(({ id }) => id === selection.variantId);
  return variant ? variantLabel(set, variant) : undefined;
};
const describeVersion = (screen) => (selection) => {
  const presentation = screen.presentations.find(({ id }) => id === selection.presentationId);
  return presentation ? (presentation.platform ?? presentation.name) : undefined;
};

function lookComponentSets(workspace) {
  const sets = [];
  for (const owner of [workspace.product, workspace.foundation, ...(workspace.libraries ?? [])]) {
    if (!owner) continue;
    for (const set of owner.domain.componentSets.values())
      if (!sets.some((item) => item.set.id === set.id)) sets.push({ owner, set });
  }
  return sets;
}

function lookScreens(product) {
  return product.manifest.entries.screens.map((entry) => product.entries[entry]);
}

// Top-level element names of a Presentation, in reading order.
function topElements(presentation) {
  const root = presentation.nodes[presentation.rootId];
  const children = [...(root?.children ?? [])];
  if (root?.layout === "flex") children.reverse();
  return children.map((id) => presentation.nodes[id]?.name).filter(Boolean);
}

function componentLine({ set }) {
  const axes = set.axes.map((axis) => `${axis.name}: ${axis.domain.join("|")}`);
  return [set.name, ...axes, `${set.variants.length} variant${set.variants.length === 1 ? "" : "s"}`].join(" · ");
}

function pageLines(screen) {
  const versions = screen.presentations.map((presentation) => {
    const root = presentation.nodes[presentation.rootId];
    return `${presentation.platform ?? presentation.name} ${Math.round(root?.width ?? 0)}×${Math.round(root?.height ?? 0)}`;
  });
  const base =
    screen.presentations.find(({ id }) => id === screen.basePresentationId) ?? screen.presentations[0];
  return [
    `${screen.name} — ${versions.join(", ")}`,
    ...(base ? [`  ${topElements(base).join(", ") || "(empty)"}`] : []),
  ];
}

function formatTokenValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function lookTokens(packagePath, args, workspace, prefix) {
  const as = option(args, "--as") ?? "text";
  const target = prefix ? { token: prefix } : { tokens: "all" };
  if (as === "issues")
    throw new SmallPenError(
      "issues_not_for_tokens",
      "Issues check the layout of pages and components; read Tokens with --as text, wireframe or png",
    );
  const { product, foundation, libraries } = workspace;
  const context = contextSelection(args);
  const items = listEffectiveTokens(product, { context, foundation, libraries })
    .filter((item) => !prefix || tokenUnder(item.token.path, prefix))
    .sort((left, right) =>
      left.token.path.localeCompare(right.token.path, "en", { numeric: true }),
    );
  if (prefix && items.length === 0)
    throw new SmallPenError("unknown_token", `No Token named ${prefix} or under it`, {
      prefixes: [
        ...new Set(
          listEffectiveTokens(product, { context, foundation, libraries }).map(
            (item) => item.token.path.split(".")[0],
          ),
        ),
      ],
    });
  if (as !== "text")
    return lookSheet(packagePath, args, workspace, { only: "tokens", tokenPrefix: prefix }, target);
  const values = await optionValuesFor(packagePath, args, items, { context, libraries });
  const byType = new Map();
  for (const item of items) {
    if (!byType.has(item.token.type)) byType.set(item.token.type, []);
    byType.get(item.token.type).push(item);
  }
  const width = Math.max(...items.map((item) => item.token.path.length));
  const lines = [];
  for (const [type, members] of byType) {
    lines.push(`${type} (${members.length})`);
    for (const item of members) {
      const others = Object.entries(values.get(item.token.path) ?? {}).map(
        ([option, value]) => `${option} ${formatTokenValue(value)}`,
      );
      lines.push(
        `  ${item.token.path.padEnd(width)}  ${formatTokenValue(item.value)}${others.length ? `   ${others.join(" · ")}` : ""}`,
      );
    }
  }
  return {
    target,
    as,
    selection: themeSettings(workspace).selection,
    tokenCount: items.length,
    text: lines.join("\n"),
    nextOperations: lookAgain(args, "png"),
  };
}

// A whole canvas: every board where the canvas layout puts it, as one tree.
async function lookCanvas(packagePath, args, workspace, name) {
  const as = option(args, "--as") ?? "text";
  const { product, foundation, libraries } = workspace;
  const layout = canvasLayout(product.manifest, product.entries, product.runtime);
  const canvas = layout.find((item) => item.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!canvas)
    throw new SmallPenError("unknown_canvas", `No canvas ${name}`, { canvases: layout.map((item) => item.name) });
  const screens = new Map(product.manifest.entries.screens.map((entry) => [product.entries[entry].id, product.entries[entry]]));
  const target = { canvas: canvas.name, boards: canvas.boards.length };
  if (as === "issues")
    return lookIssues(packagePath, args, canvas.boards.map((board) => ({
      ids: ["--screen-id", board.screenId, "--presentation-id", board.presentationId],
      where: `${screens.get(board.screenId).name} (${board.platform})`,
    })), target);
  if (as === "text") {
    const flows = [];
    for (const board of canvas.boards) {
      let flow = flows.find((item) => item.name === board.flow);
      if (!flow) flows.push((flow = { name: board.flow, rows: new Map() }));
      if (!flow.rows.has(board.platform)) flow.rows.set(board.platform, []);
      flow.rows.get(board.platform).push(`${screens.get(board.screenId).name} ${Math.round(board.width)}×${Math.round(board.height)}`);
    }
    // Left to right; links between pages are flow list's.
    const lines = [`${canvas.name}`];
    for (const flow of flows) {
      lines.push(`  ${flow.name ? `${flow.name} row` : "Other pages"}`);
      for (const [platform, pages] of flow.rows) lines.push(`    ${platform}: ${pages.join(", ")}`);
    }
    return { target, as, text: lines.join("\n"), nextOperations: lookAgain(args, "png") };
  }
  const nodes = {};
  const roots = [];
  for (const board of canvas.boards) {
    const projected = projectScreen(product, board.screenId, {
      context: contextSelection(args),
      foundation,
      libraries,
      presentationId: board.presentationId,
    });
    const prefix = `${board.presentationId}::`;
    for (const [id, node] of Object.entries(projected.nodes))
      nodes[prefix + id] = { ...node, id: prefix + id, children: (node.children ?? []).map((child) => prefix + child) };
    const presentation = screens.get(board.screenId).presentations.find(({ id }) => id === board.presentationId);
    for (const root of Array.isArray(presentation.rootIds) ? presentation.rootIds : [presentation.rootId]) {
      const node = nodes[prefix + root];
      if (!node) continue;
      node.x = (node.x ?? 0) + board.dx;
      node.y = (node.y ?? 0) + board.dy;
      roots.push(prefix + root);
    }
  }
  const width = Math.max(1, ...roots.map((id) => nodes[id].x + nodes[id].width)) + 80;
  const height = Math.max(1, ...roots.map((id) => nodes[id].y + nodes[id].height)) + 80;
  for (const id of roots) Object.assign(nodes[id], { x: nodes[id].x + 40, y: nodes[id].y + 40 });
  nodes.canvas_root = {
    children: roots, fills: [{ color: "#e8e9ea", type: "solid" }], height, id: "canvas_root",
    name: canvas.name, type: "FRAME", visible: true, width, x: 0, y: 0,
  };
  const projection = { context: {}, diagnostics: [], nodes, rootId: "canvas_root" };
  const design = {
    projection,
    tree: createSemanticTree(product, projection),
    selection: { canvas: canvas.name, ...themeSettings(workspace).selection },
  };
  // A large canvas is scaled down to fit the renderer.
  const fit = Math.min(1, 8000 / Math.max(width, height));
  const scale = numberOption(args, "--scale") || fit;
  const argv =
    as === "png"
      ? ["export", packagePath, "--format", "png", "--scale", String(Math.min(scale, fit)), ...lookPass(args).filter((item, index, all) => item !== "--scale" && all[index - 1] !== "--scale")]
      : ["view", packagePath, "--format", "wireframe", ...lookPass(args)];
  return lookResult(target, await designCommand(packagePath, argv, design), args, as);
}

// The IDs a page or component named as view names it stands for. With
// every, a page without --platform means all its versions and a component
// without --variant all its variants (validate); otherwise the main ones.
// A located component (made in the App on a page) by "Path / Name" or name.
function findLocatedComponent({ product, foundation, libraries = [] }, name) {
  const normal = (text) => String(text).split("/").map((part) => part.trim().toLowerCase()).filter(Boolean).join("/");
  const wanted = normal(name);
  for (const owner of [product, foundation, ...libraries].filter(Boolean))
    for (const component of owner.domain.locatedComponents?.values() ?? []) {
      if (wanted !== normal([component.path, component.name].filter(Boolean).join("/")) && wanted !== normal(component.name)) continue;
      const entry = owner.manifest.entries.screens.find((item) => owner.entries[item]?.id === component.screenId);
      const screen = entry && owner.entries[entry];
      const presentation = screen?.presentations.find(({ id }) => id === component.presentationId);
      if (presentation) return { component, screen, presentation, name: component.name };
    }
  return undefined;
}

async function nameTargetArgs(packagePath, args, { every = false } = {}) {
  const page = option(args, "--page");
  const component = option(args, "--component");
  const element = option(args, "--element");
  if (page !== undefined && component !== undefined)
    throw new SmallPenError("too_many_view_targets", "Name one target: --page or --component");
  const needs = (name, parent) => {
    if (option(args, name) !== undefined && option(args, parent) === undefined)
      throw new SmallPenError("incomplete_view_target", `${name} needs ${parent}`);
  };
  needs("--platform", "--page");
  needs("--variant", "--component");
  if (element !== undefined && page === undefined && component === undefined)
    throw new SmallPenError("incomplete_view_target", "--element needs --page or --component");
  const workspace = await readableWorkspace(packagePath);
  if (page !== undefined) {
    const screen = findPage(workspace.product, page);
    const platform = option(args, "--platform");
    if (every && platform === undefined && element === undefined) return ["--screen-id", screen.id, "--all"];
    const presentation = findPresentation(screen, platform);
    return [
      "--screen-id", screen.id, "--presentation-id", presentation.id,
      ...(element !== undefined ? ["--node-id", findElement(presentation.nodes, presentation.rootId, element, screen.name)] : []),
    ];
  }
  if (component !== undefined) {
    const located = findLocatedComponent(workspace, component);
    if (located)
      return [
        "--screen-id", located.screen.id, "--presentation-id", located.presentation.id, "--node-id",
        element !== undefined ? findElement(located.presentation.nodes, located.component.mainNodeId, element, located.name) : located.component.mainNodeId,
      ];
    const lookups = {
      foundation: workspace.foundation !== workspace.product ? workspace.foundation : undefined,
      libraries: workspace.libraries ?? [],
    };
    const { owner, set } = findComponent(workspace.product, component, lookups);
    const owned = owner === workspace.product ? [] : ["--package-id", owner.manifest.packageId];
    const variantName = option(args, "--variant");
    if (every && variantName === undefined && element === undefined) return ["--component-id", set.id, ...owned, "--all"];
    const variant = findVariant(set, variantName);
    return [
      "--component-id", set.id, ...owned, "--variant-id", variant.id,
      ...(element !== undefined ? ["--node-id", findElement(variant.nodes, variant.rootId, element, set.name)] : []),
    ];
  }
  return [];
}

async function lookCommand(packagePath, args) {
  const as = option(args, "--as") ?? "text";
  const page = option(args, "--page");
  const component = option(args, "--component");
  const token = option(args, "--token");
  const canvasName = option(args, "--canvas");
  const targets =
    [page, component, token, canvasName].filter((value) => value !== undefined).length +
    ["--tokens", "--components", "--pages"].filter((name) => flag(args, name)).length;
  if (targets > 1)
    throw new SmallPenError(
      "too_many_view_targets",
      "Look at one thing per call: --page, --component, --token, --tokens, --components or --pages",
    );
  const needs = (name, parents, text) => {
    if (option(args, name) !== undefined && !parents.some((parent) => args.includes(parent)))
      throw new SmallPenError("incomplete_view_target", `${name} ${text}`);
  };
  needs("--variant", ["--component"], "needs --component");
  needs("--element", ["--page", "--component"], "needs --page or --component");
  needs("--platform", ["--page", "--pages"], "needs --page or --pages");
  const workspace = await tokenWorkspace(packagePath, args);
  const { product, foundation, libraries } = workspace;

  if (canvasName !== undefined) return lookCanvas(packagePath, args, workspace, canvasName);

  if (page !== undefined) {
    const screen = findPage(product, page);
    const presentation = findPresentation(screen, option(args, "--platform"));
    const element = option(args, "--element");
    const ids = ["--screen-id", screen.id, "--presentation-id", presentation.id];
    if (element !== undefined)
      ids.push("--node-id", findElement(presentation.nodes, presentation.rootId, element, screen.name));
    return lookAt(packagePath, args, ids, {
      page: screen.name,
      platform: presentation.platform ?? presentation.name,
      ...(element !== undefined ? { element } : {}),
    });
  }

  if (component !== undefined) {
    // A component made in the App on a page (a located component) is that
    // page element.
    const located = findLocatedComponent(workspace, component);
    if (located) {
      const element = option(args, "--element");
      const ids = ["--screen-id", located.screen.id, "--presentation-id", located.presentation.id, "--node-id",
        element !== undefined ? findElement(located.presentation.nodes, located.component.mainNodeId, element, located.name) : located.component.mainNodeId];
      return lookAt(packagePath, args, ids, { component: located.name, page: located.screen.name, ...(element !== undefined ? { element } : {}) });
    }
    const { owner, set } = findComponent(product, component, { foundation, libraries });
    const owned = owner === product ? [] : ["--package-id", owner.manifest.packageId];
    const variantText = option(args, "--variant");
    const element = option(args, "--element");
    // Reuse limits travel with the name: a private or deprecated component
    // says so, with its replacement.
    const limits = {
      ...(set.visibility && set.visibility !== "public" ? { visibility: set.visibility } : {}),
      ...(set.deprecated ? { deprecated: set.deprecated } : {}),
    };
    // The whole component: every variant on one sheet, issues in all of them.
    if (variantText === undefined && element === undefined) {
      const target = { component: set.name, variants: set.variants.length, ...limits };
      if (as === "png" || as === "wireframe")
        return lookSheet(packagePath, args, workspace, {
          only: "components",
          componentSetIds: [set.id],
          allVariants: true,
        }, target);
      if (as === "issues")
        return lookIssues(packagePath, args, [{ ids: ["--component-id", set.id, ...owned, "--all"], where: set.name, describe: describeVariant(set) }], target);
    }
    const variant = findVariant(set, variantText);
    const label = variantLabel(set, variant);
    const ids = ["--component-id", set.id, ...owned, "--variant-id", variant.id];
    if (element !== undefined)
      ids.push("--node-id", findElement(variant.nodes, variant.rootId, element, `${set.name} (${label})`));
    return lookAt(packagePath, args, ids, {
      component: set.name,
      ...(variantText !== undefined || element !== undefined ? { variant: label } : { variants: set.variants.length }),
      ...(element !== undefined ? { element } : {}),
      ...limits,
    });
  }

  if (token !== undefined || flag(args, "--tokens"))
    return lookTokens(packagePath, args, workspace, token);

  const sets = lookComponentSets(workspace);
  const screens = lookScreens(product);

  if (flag(args, "--components")) {
    const target = { components: sets.length };
    if (as === "png" || as === "wireframe")
      return lookSheet(packagePath, args, workspace, {
        only: "components",
        componentSetIds: sets.map(({ set }) => set.id),
      }, target);
    if (as === "issues")
      return lookIssues(packagePath, args, sets.map(({ owner, set }) => ({
        ids: ["--component-id", set.id, ...(owner === product ? [] : ["--package-id", owner.manifest.packageId]), "--all"],
        where: set.name,
        describe: describeVariant(set),
      })), target);
    // Components made in the App on a page are that page's elements.
    const located = [product, foundation, ...libraries].filter(Boolean).flatMap((owner) =>
      [...(owner.domain.locatedComponents?.values() ?? [])].map((component) => {
        const entry = owner.manifest.entries.screens.find((item) => owner.entries[item]?.id === component.screenId);
        return `${component.name} · on page ${entry ? owner.entries[entry].name : component.screenId}`;
      }));
    return {
      target: located.length ? { ...target, located: located.length } : target,
      as,
      text: [...sets.map(componentLine), ...located].join("\n") || "(no components)",
      nextOperations: lookAgain(args, "png"),
    };
  }

  if (flag(args, "--pages")) {
    const target = { pages: screens.length };
    const platform = option(args, "--platform");
    const versions = screens.flatMap((screen) => {
      if (platform === undefined) return [{ screen, presentation: findPresentation(screen) }];
      const presentation = screen.presentations.find((candidate) =>
        String(candidate.platform ?? candidate.name).toLowerCase() === platform.toLowerCase());
      return presentation ? [{ screen, presentation }] : [];
    });
    const idsOf = ({ screen, presentation }) => ["--screen-id", screen.id, "--presentation-id", presentation.id];
    const where = ({ screen, presentation }) => `${screen.name} (${presentation.platform ?? presentation.name})`;
    if (as === "issues")
      return lookIssues(packagePath, args, versions.map((version) => ({ ids: idsOf(version), where: where(version) })), target);
    if (as === "wireframe") {
      const parts = [];
      for (const version of versions) {
        const result = await designCommand(packagePath, ["view", packagePath, ...idsOf(version), "--format", "wireframe", ...lookPass(args)]);
        parts.push(`== ${where(version)} ==\n${result.wireframe}`);
      }
      const text = parts.join("\n\n");
      return { target, as, wireframe: text, lineCount: text.split("\n").length, nextOperations: lookAgain(args, "issues") };
    }
    if (as === "png") {
      const items = [];
      for (const version of versions) {
        const result = await designCommand(packagePath, [
          "export", packagePath, ...idsOf(version), "--format", "png",
          ...lookPass(args).filter((item, index, all) => item !== "--output" && all[index - 1] !== "--output"),
        ]);
        items.push({ page: where(version), output: result.output, width: result.width, height: result.height });
      }
      return { target, as, items, nextOperations: lookAgain(args, "issues") };
    }
    return {
      target,
      as,
      text: screens.flatMap(pageLines).join("\n") || "(no pages)",
      nextOperations: lookAgain(args, "wireframe"),
    };
  }

  // Nothing named: the whole package.
  const target = { package: product.manifest.name ?? product.manifest.packageId };
  if (as === "png" || as === "wireframe") return lookSheet(packagePath, args, workspace, undefined, target);
  if (as === "issues")
    return lookIssues(packagePath, args, [
      ...screens.map((screen) => ({ ids: ["--screen-id", screen.id, "--all"], where: screen.name, describe: describeVersion(screen) })),
      ...sets.map(({ owner, set }) => ({
        ids: ["--component-id", set.id, ...(owner === product ? [] : ["--package-id", owner.manifest.packageId]), "--all"],
        where: set.name,
        describe: describeVariant(set),
      })),
    ], target, packageNameIssues(workspace));
  const tokens = listEffectiveTokens(product, { context: contextSelection(args), foundation, libraries });
  const types = new Map();
  for (const item of tokens) types.set(item.token.type, (types.get(item.token.type) ?? 0) + 1);
  const themes = themeSettings(workspace).groups.map((group) =>
    `${group.name}: ${group.options
      .map((name) => {
        const short = name.slice(group.name.length + 1);
        return name === group.default ? `${short} (default)` : short;
      })
      .join(", ")}`);
  const canvasLines = canvasLayout(product.manifest, product.entries, product.runtime).map((canvas) =>
    `${canvas.name} (${[...new Set(canvas.boards.map((board) => board.screenId))].length} pages, ${[...new Set(canvas.boards.map((board) => board.flow))].length} row${new Set(canvas.boards.map((board) => board.flow)).size === 1 ? "" : "s"})`);
  const lines = [
    `Themes: ${themes.join(" · ") || "none"}`,
    `Canvases: ${canvasLines.join(" · ") || "none"}`,
    `Tokens (${tokens.length}): ${[...types].map(([type, count]) => `${type} ${count}`).join(", ") || "none"}`,
    `Components (${sets.length}):`,
    ...sets.map((item) => `  ${componentLine(item)}`),
    `Pages (${screens.length}):`,
    ...screens.flatMap(pageLines).map((line) => `  ${line}`),
  ];
  return {
    target,
    as,
    text: lines.join("\n"),
    nextOperations: [
      { argv: ["view", packagePath, "--tokens", "--json"], operation: "smallpen.view" },
      { argv: ["view", packagePath, "--components", "--as", "png", "--json"], operation: "smallpen.view" },
      { argv: ["view", packagePath, "--pages", "--as", "issues", "--json"], operation: "smallpen.view" },
    ],
  };
}

// changes: what changed since a revision the agent saw, by name. Each
// package's batch history holds the inverse of every write (the App's too),
// so the earlier revision is rebuilt in memory and compared; nothing is
// stored for the agent.
function idNames(snapshots, ids) {
  const names = new Set();
  for (const id of ids) {
    let name;
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      name =
        snapshot.domain.tokens.get(id)?.path ??
        snapshot.domain.componentSets.get(id)?.name ??
        snapshot.manifest.entries.screens
          .map((entry) => snapshot.entries[entry])
          .find((screen) => screen.id === id)?.name ??
        listTokenThemes(snapshot).find((theme) => theme.id === id)?.path;
      if (name) break;
    }
    if (name) names.add(name);
  }
  return [...names];
}

// The point in time a revision stands for: after the batch that produced
// it, or before the first batch that started from it.
function revisionCut(histories, since) {
  for (const history of histories) {
    const produced = history.find((entry) => entry.revision === since);
    if (produced) return { at: produced.committedAt, inclusive: false };
    const started = history.find((entry) => entry.baseRevision === since);
    if (started) return { at: started.committedAt, inclusive: true };
  }
  return null;
}

async function rebuildBefore(snapshot, history, cut) {
  const newer = history.filter((entry) =>
    cut.inclusive ? entry.committedAt >= cut.at : entry.committedAt > cut.at,
  );
  let old = snapshot;
  let complete = true;
  for (const entry of [...newer].reverse()) {
    if (!entry.inverseBatch) {
      complete = false;
      break;
    }
    old = (
      await prepareOperationBatch(old, {
        ...entry.inverseBatch,
        baseRevision: old.revision,
      })
    ).snapshot;
  }
  // A write that bypassed SmallPen leaves the newest recorded revision
  // behind the files.
  if (newer.length && newer.at(-1).revision !== snapshot.revision) complete = false;
  return { old, edits: newer, complete };
}

// What each of the newest recorded writes changed in the design, by name:
// step back one write at a time and compare. Keyed by the write's revision.
async function recentDesignChanges(snapshot, history, limit) {
  const result = new Map();
  let newer = snapshot;
  const entries = [...history].sort((left, right) => String(right.committedAt).localeCompare(String(left.committedAt))).slice(0, limit);
  for (const entry of entries) {
    if (!entry.inverseBatch || entry.revision !== newer.revision) break;
    try {
      const older = (await prepareOperationBatch(newer, { ...entry.inverseBatch, baseRevision: newer.revision })).snapshot;
      result.set(entry.revision, designChanges(older, newer).map((change) =>
        [change.name, change.element].filter(Boolean).join(" / ")));
      newer = older;
    } catch {
      break;
    }
  }
  return result;
}

async function changesCommand(packagePath, args) {
  const since = option(args, "--since");
  const workspace = await readableWorkspace(packagePath);
  const { product } = workspace;
  const foundation =
    workspace.foundation && workspace.foundation !== product ? workspace.foundation : undefined;
  const packages = [product, foundation].filter(Boolean);
  const histories = await Promise.all(
    packages.map((snapshot) => readBatchHistory(snapshot.locator ?? packagePath)),
  );
  const revisions = {
    revision: product.revision,
    ...(foundation ? { foundationRevision: foundation.revision } : {}),
  };
  if (since === undefined) {
    const limit = integerOption(args, "--limit") || 10;
    // A write that only touched bookkeeping (the App's active theme, a
    // text's measured width) changed nothing in the design: it lists none.
    const designed = await recentDesignChanges(product, histories[0], limit);
    const recent = histories
      .flat()
      .sort((left, right) => String(right.committedAt).localeCompare(String(left.committedAt)))
      .slice(0, limit)
      .map((entry) => ({
        at: entry.committedAt,
        by: entry.source,
        changed: (designed.get(entry.revision) ?? idNames(packages, entry.affectedIds)).slice(0, 8),
        before: entry.baseRevision,
      }));
    return {
      ...revisions,
      recent,
      note: "Pass a revision you saw (any read or write reports one) as --since to get what changed after it.",
    };
  }
  if (since === product.revision || since === foundation?.revision)
    return { ...revisions, since, changeCount: 0, text: "No design changes." };
  const cut = revisionCut(histories, since);
  if (!cut)
    throw new SmallPenError(
      "unknown_revision",
      "This revision is not in the recorded history; read the current design with view instead",
      {
        nextOperations: [
          { argv: ["changes", packagePath, "--json"], operation: "smallpen.changes" },
          { argv: ["view", packagePath, "--as", "text", "--json"], operation: "smallpen.view" },
        ],
      },
    );
  const rebuilt = await Promise.all(
    packages.map((snapshot, index) => rebuildBefore(snapshot, histories[index], cut)),
  );
  const [productThen, foundationThen] = rebuilt.map(({ old }) => old);
  const changes = designChanges(productThen, product, {
    beforeFoundation: foundation ? foundationThen : undefined,
    afterFoundation: foundation,
  });
  if (foundation)
    changes.push(
      ...designChanges(foundationThen, foundation).filter(
        (change) => change.kind === "component" || change.kind === "page",
      ),
    );
  const edits = rebuilt.flatMap(({ edits }) => edits);
  const by = {};
  for (const edit of edits) by[edit.source] = (by[edit.source] ?? 0) + 1;
  const firstPage = changes.find((change) => change.kind === "page" && change.change !== "removed");
  const firstComponent = changes.find((change) => change.kind === "component" && change.change !== "removed");
  return {
    ...revisions,
    since,
    edits: edits.length,
    by,
    ...(rebuilt.every(({ complete }) => complete)
      ? {}
      : { note: "Some edits were not recorded by SmallPen; this list may miss them. Read the design with view to be sure." }),
    changeCount: changes.length,
    text: designChangesText(changes),
    ...(flag(args, "--full") ? { changes } : {}),
    nextOperations: [
      ...(firstPage
        ? [{ argv: ["view", packagePath, "--page", firstPage.name.replace(/ \([^)]*\)$/, ""), "--as", "png", "--json"], operation: "smallpen.view" }]
        : []),
      ...(firstComponent
        ? [{ argv: ["view", packagePath, "--component", firstComponent.name.replace(/ \([^)]*\)$/, ""), "--as", "png", "--json"], operation: "smallpen.view" }]
        : []),
    ],
  };
}

// token export: resolved values as JSON, one file per option of a theme
// group, or one file under the call's selected options and project defaults.
function nestTokens(items) {
  const root = {};
  for (const { token, value } of items) {
    const parts = token.path.split(".");
    let at = root;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts.at(-1)] = value;
  }
  return root;
}

async function tokenExportCommand(packagePath, args) {
  const type = option(args, "--type");
  const prefix = option(args, "--token");
  const by = option(args, "--by");
  const format = option(args, "--format") ?? "json";
  const base = await tokenWorkspace(packagePath, args);
  // Without --by, one file of the values under the call's theme options.
  let versions = [{ name: "tokens", themes: [] }];
  if (by !== undefined) {
    const groups = themeSettings(base).groups;
    const group = groups.find(({ name }) => name.toLowerCase() === by.toLowerCase());
    if (!group)
      throw new SmallPenError("unknown_token_theme_group", `No theme group ${by}`, {
        groups: groups.map(({ name }) => name),
      });
    versions = group.options.map((path) => ({ name: path.slice(group.name.length + 1), themes: [path] }));
  }
  // Other groups keep the call's --theme choices or their defaults.
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--theme") {
      const value = args[index + 1];
      index += 1;
      if (by !== undefined && value.split("/")[0].toLowerCase() === by.toLowerCase()) continue;
      kept.push("--theme", value);
    }
  }
  const directory = resolve(
    option(args, "--output") ?? join(artifactDirectory({ create: true }), `tokens-${randomUUID()}`),
  );
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const version of versions) {
    const workspace = await tokenWorkspace(packagePath, [
      args[0],
      packagePath,
      ...kept,
      ...version.themes.flatMap((theme) => ["--theme", theme]),
    ]);
    const items = listEffectiveTokens(workspace.product, {
      foundation: workspace.foundation,
      libraries: workspace.libraries,
    })
      .filter((item) => !type || item.token.type === type)
      .filter((item) => !prefix || tokenUnder(item.token.path, prefix))
      .sort((left, right) => left.token.path.localeCompare(right.token.path, "en", { numeric: true }));
    const text = `${JSON.stringify(format === "flat" ? Object.fromEntries(items.map((item) => [item.token.path, item.value])) : nestTokens(items), null, 2)}\n`;
    const file = join(directory, `${version.name.replace(/[^\w.-]+/g, "-")}.json`);
    await writeFile(file, text);
    files.push({ ...(version.themes[0] ? { option: version.themes[0] } : {}), file, tokens: items.length });
  }
  return {
    format,
    ...(by !== undefined ? { by } : {}),
    // The theme options every file was resolved under.
    themes: themeSettings(base).selection.themes,
    directory,
    files,
    revision: base.product.revision,
  };
}

// canvas list: every canvas with its rows (one per module, "Tasks / ..."
// pages, in layout order) and their pages left to right, as the App shows
// them. Links between pages are flow list's.
async function canvasListCommand(packagePath) {
  const snapshot = await openPackage(packagePath);
  const screens = new Map(snapshot.manifest.entries.screens.map((entry) => [snapshot.entries[entry].id, snapshot.entries[entry]]));
  const canvases = canvasLayout(snapshot.manifest, snapshot.entries, snapshot.runtime).map((canvas) => {
    const rows = [];
    for (const board of canvas.boards) {
      const rowName = board.flow ? `${board.flow} row` : "Other pages";
      let row = rows.find((item) => item.name === rowName);
      if (!row) rows.push((row = { name: rowName, pages: [], platforms: [] }));
      const name = screens.get(board.screenId).name;
      if (!row.pages.includes(name)) row.pages.push(name);
      if (!row.platforms.includes(board.platform)) row.platforms.push(board.platform);
    }
    return { name: canvas.name, rows };
  });
  const text = canvases
    .map((canvas) => [`${canvas.name}`, ...canvas.rows.map((row) => `  ${row.name} [${row.platforms.join(", ")}]: ${row.pages.join(", ")}`)].join("\n"))
    .join("\n");
  return { canvases, text, revision: snapshot.revision };
}

// Packages next to this one that depend on it: Products of a Foundation,
// or packages that use it as a Library. A delete here must not break them.
async function dependentPackages(packagePath, snapshot) {
  const folder = dirname(resolve(packagePath));
  const found = [];
  let names = [];
  try {
    names = await readdir(folder);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.endsWith(".smallpen") || resolve(folder, name) === resolve(packagePath)) continue;
    try {
      const other = await openPackage(resolve(folder, name));
      const { packageId } = snapshot.manifest;
      if (
        other.manifest.dependencies?.some((dependency) => dependency.packageId === packageId) ||
        other.manifest.libraries?.some((library) => library.packageId === packageId)
      )
        found.push(other);
    } catch {
      // Not a readable package: nothing to protect.
    }
  }
  return found;
}

// The Foundation and Libraries a package's copies may come from.
function workspaceLookups(workspace) {
  return {
    foundation: workspace.foundation !== workspace.product ? workspace.foundation : undefined,
    libraries: workspace.libraries ?? [],
  };
}

// The text says every start and link once; --full adds them as fields.
async function flowListCommand(packagePath, args = []) {
  const workspace = await readableWorkspace(packagePath);
  const snapshot = workspace.product;
  const { starts, links } = flowLinks(snapshot, workspaceLookups(workspace));
  const named = {
    starts: starts.map(({ page, platform, name }) => ({ page, platform, name })),
    links: links.map(({ page, platform, element, on, action, to }) => ({ page, platform, element, on, action, ...(to ? { to } : {}) })),
  };
  return {
    text: flowLinksText(named),
    counts: { starts: starts.length, links: links.length },
    ...(flag(args, "--full") ? named : {}),
    revision: snapshot.revision,
  };
}

// Name-based edits: each names its target the way outlines show it and
// compiles to the operations the id-based commands write.
const NAMED_EDITS = new Set([
  "asset-delete",
  "asset-set",
  "component-delete",
  "component-rename",
  "flow-unlink",
  "font-delete",
  "media-delete",
  "page-delete",
  "page-rename",
]);

function namedEditIntent(command, args) {
  const pick = (pairs) =>
    Object.fromEntries(pairs.map(([key, name]) => [key, option(args, name)]).filter(([, value]) => value !== undefined));
  if (command === "asset-set" || command === "asset-delete") {
    const kind = option(args, "--color") !== undefined ? "colors" : "typographies";
    const intent = { kind, name: option(args, kind === "colors" ? "--color" : "--typography") };
    if (command === "asset-set") {
      const raw = option(args, "--value");
      intent.value = kind === "colors" ? raw : parseJson(raw, "invalid_typography");
    }
    return intent;
  }
  if (command === "media-delete") return { kind: "media", name: option(args, "--media") };
  if (command === "font-delete") return { kind: "fonts", name: option(args, "--font"), ...pick([["variant", "--variant"]]) };
  if (command === "flow-unlink") return pick([["from", "--from"], ["on", "--on"], ["to", "--to"], ["platform", "--platform"]]);
  if (command.startsWith("component-")) return pick([["component", "--component"], ["element", "--element"], ["to", "--to"], ["variant", "--variant"]]);
  return pick([["page", "--page"], ["to", "--to"], ["platform", "--platform"], ["element", "--element"]]);
}

async function namedEditOperations(command, snapshot, intent, packagePath) {
  if (command === "page-rename") return pageRenameOperations(snapshot, intent);
  if (command === "page-delete") return pageDeleteOperations(snapshot, intent);
  if (command === "flow-unlink") return [flowUnlinkOperation(snapshot, intent, workspaceLookups(await readableWorkspace(packagePath)))];
  if (command === "asset-set") return assetSetOperations(snapshot, intent);
  if (command.endsWith("-delete") && !command.startsWith("component")) return assetDeleteOperations(snapshot, intent);
  const workspace = await readableWorkspace(packagePath);
  const lookups = {
    foundation: workspace.foundation !== workspace.product ? workspace.foundation : undefined,
    libraries: workspace.libraries ?? [],
  };
  return [
    command === "component-rename"
      ? componentRenameOperation(snapshot, intent, lookups)
      : componentDeleteOperation(snapshot, intent, lookups),
  ];
}

// A page version by name: {page, platform}.
function versionName(snapshot, screenId, presentationId) {
  const entry = snapshot.manifest.entries.screens.find((item) => snapshot.entries[item]?.id === screenId);
  const screen = entry && snapshot.entries[entry];
  const presentation = screen?.presentations.find(({ id }) => id === presentationId);
  return screen ? { page: screen.name, ...(presentation ? { platform: presentation.platform ?? presentation.name } : {}) } : undefined;
}

// What a design selection is, by name: page and platform, or component and
// variant, so a reply without IDs still says what was checked.
function selectionNames({ product, foundation, libraries = [] }, selection = {}) {
  if (selection.screenId) {
    const entry = product.manifest.entries.screens.find((item) => product.entries[item]?.id === selection.screenId);
    const screen = entry && product.entries[entry];
    const presentation = screen?.presentations.find(({ id }) => id === selection.presentationId);
    return screen ? { page: screen.name, ...(presentation ? { platform: presentation.platform ?? presentation.name } : {}) } : {};
  }
  if (selection.componentId) {
    for (const owner of [product, foundation, ...libraries].filter(Boolean)) {
      const set = owner.domain.componentSets.get(selection.componentId);
      if (!set) continue;
      const variant = set.variants.find(({ id }) => id === selection.variantId);
      return { component: set.name, ...(variant ? { variant: variantLabel(set, variant) } : {}) };
    }
  }
  return {};
}

// Names stored twice in the package (pages, components, canvases, theme
// options, assets, sibling elements); they cannot be edited by name.
function packageNameIssues({ product, foundation }) {
  return duplicateNameIssues(product, { foundation: foundation !== product ? foundation : undefined });
}

// Nothing named: every page in every version and every component in every
// variant, as view --as issues checks them. A target that cannot be drawn
// (a broken reference) makes the package invalid and says where.
// The whole package, or one named page or component (`only`), in one short
// report by name.
async function validateWholePackage(packagePath, args, workspace, resolution, only) {
  const { product } = workspace;
  const pass = lookPass(args).filter((item) => item !== "--full");
  const targets = only ?? [
    ...product.manifest.entries.screens.map((entry) => product.entries[entry])
      .map((screen) => ({ ids: ["--screen-id", screen.id, "--all"], where: screen.name })),
    ...[...product.domain.componentSets.values()]
      .map((set) => ({ ids: ["--component-id", set.id, "--all"], where: set.name })),
  ];
  const targetLabel = (selection = {}) => {
    const named = selectionNames(workspace, selection);
    const label = [named.page ?? named.component, named.platform ?? named.variant].filter(Boolean);
    return label.length > 1 ? `${label[0]} (${label[1]})` : label[0] ?? "design";
  };
  const issues = [], checked = [], skipped = [], hints = [];
  let unreadable = 0;
  for (const target of targets) {
    try {
      const report = await validateTargets(workspace, ["validate", packagePath, ...target.ids, ...pass]);
      for (const issue of report.issues ?? []) {
        const named = selectionNames(workspace, issue.target ?? {});
        const at = [named.page ?? named.component ?? target.where, named.platform ?? named.variant].filter(Boolean);
        const { target: _target, ...rest } = issue;
        issues.push({ target: at.length > 1 ? `${at[0]} (${at[1]})` : at[0], ...rest });
      }
      checked.push(...(report.coverage?.targets ?? []));
      skipped.push(...(report.coverage?.skipped ?? []).map((skip) => ({ ...skip, label: targetLabel(skip.target) })));
      for (const hint of report.hints ?? [])
        if (!hints.some((other) => JSON.stringify(other) === JSON.stringify(hint))) hints.push(hint);
    } catch (error) {
      unreadable += 1;
      issues.push({
        target: target.where,
        code: error?.code ?? "unreadable_target",
        severity: "error",
        check: "read",
        message: `${target.where} cannot be drawn: ${error?.message ?? error}`,
      });
    }
  }
  // Sizes the local preview cannot compute are the tool's limit, not the
  // design's: one note instead of one issue each.
  const limits = issues.filter((issue) => issue.code === "layout_projection_partial");
  // The visual-intent reminder repeats per target and the preview limit has
  // its own note; neither is a check the tool skipped.
  const notChecked = skipped.filter((skip) => skip.check !== "visual-intent" && skip.code !== "layout_projection_partial");
  const design = [...(only ? [] : packageNameIssues(workspace)), ...issues.filter((issue) => issue.code !== "layout_projection_partial")];
  const full = flag(args, "--full");
  const page = pageItems(design, pagination(args));
  return {
    packageId: product.manifest.packageId,
    ...workspaceRevisions(product, workspace.foundation, workspace.libraries),
    status: unreadable ? "invalid" : "valid",
    dataStatus: unreadable ? "invalid" : "valid",
    visualStatus: design.length ? "issues" : "no-issues-found",
    issueCount: design.length,
    issues: full ? design : page.items,
    ...(full ? {} : { page: page.page }),
    ...(limits.length
      ? { previewNote: `The local preview cannot compute some automatic sizes in ${limits.length} place${limits.length === 1 ? "" : "s"}; geometry there may differ in the App.` }
      : {}),
    // The theme options every target was checked under.
    selection: { themes: themeSettings(workspace).selection.themes },
    coverage: {
      // Every target drawn and every check run on it.
      complete: unreadable === 0 && notChecked.length === 0,
      targetCount: checked.length,
      // By name, short: "Home (desktop)", "Button (Style=primary)".
      // Pages by version; components as one line each unless --full.
      targets: full ? checked.map(targetLabel) : Object.entries(checked.reduce((groups, selection) => {
        const named = selectionNames(workspace, selection);
        const key = named.component ? `component:${named.component}` : targetLabel(selection);
        (groups[key] ??= []).push(selection);
        return groups;
      }, {})).map(([key, list]) => key.startsWith("component:") && list.length > 1
        ? `${key.slice(10)} (${list.length} variants)` : targetLabel(list[0])),
      skippedCount: notChecked.length,
      // One line per kind of check the tool could not run, with where.
      skipped: Object.values(notChecked.reduce((groups, skip) => {
        const code = skip.code ?? skip.check ?? "skipped";
        const group = (groups[code] ??= { code, count: 0, reason: skip.reason ?? skip.message, where: [] });
        group.count += 1;
        const where = skip.element ? `${skip.label} / ${skip.element}` : skip.label;
        if (!group.where.includes(where)) group.where.push(where);
        return groups;
      }, {})).map((group) => ({
        ...group,
        where: full ? group.where : group.where.slice(0, 3),
        ...(!full && group.where.length > 3 ? { moreWhere: group.where.length - 3 } : {}),
      })),
    },
    ...(hints.length ? { hints } : {}),
    // Checks prove geometry, text fit and contrast, not taste.
    note: "Automated checks cannot prove a design looks right; look at the PNG of the combinations that matter.",
    warnings: [
      ...(resolution.warnings ?? []),
      ...[resolution.workspace?.foundation, resolution.workspace?.product].filter(Boolean).flatMap(packageFormatWarnings),
    ],
  };
}

async function namedContextArgs(packagePath, args) {
  const workspace = await readableWorkspace(packagePath);
  const axes = [workspace.foundation, workspace.product].filter(Boolean).flatMap((snapshot) => [...snapshot.domain.contextAxes.values()]);
  const same = (left, right) => String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--context" || index + 1 >= args.length) {
      out.push(args[index]);
      continue;
    }
    const value = args[(index += 1)];
    const separator = value.indexOf("=");
    const axisName = separator > 0 ? value.slice(0, separator) : value;
    const axis = axes.find((candidate) => candidate.id === axisName || same(candidate.name ?? candidate.id, axisName));
    if (!axis)
      throw new SmallPenError("invalid_context_selection", `No context ${axisName}`, { contexts: axes.map((candidate) => candidate.name ?? candidate.id) });
    const wanted = value.slice(separator + 1);
    const choice = axis.values.find((candidate) => candidate.id === wanted || same(candidate.name ?? candidate.id, wanted));
    if (!choice)
      throw new SmallPenError("invalid_context_selection", `${axis.name ?? axis.id} has no value ${wanted}`, { values: axis.values.map((candidate) => candidate.name ?? candidate.id) });
    out.push("--context", `${axis.id}=${choice.id}`);
  }
  return out;
}

// page set / component set: the target by name, the fields from --set
// FIELD=VALUE (a JSON value, else text) on top of an --intent {"set": {...}}.
async function setIntent(command, args) {
  const file = option(args, "--intent");
  const base = file ? parseJson(await readInputFile(file, "--intent", "utf8"), `invalid_${command.replace("-", "_")}_json`) : {};
  if (!isRecord(base)) throw new SmallPenError("invalid_set", "--intent holds {\"set\": {...}}");
  const set = { ...(isRecord(base.set) ? base.set : {}) };
  for (const assignment of options(args, "--set")) {
    const at = assignment.indexOf("=");
    if (at <= 0) throw new SmallPenError("invalid_set", `--set takes FIELD=VALUE, not ${assignment}`);
    const raw = assignment.slice(at + 1);
    let value = raw;
    // {color.surface} is a Token; other JSON is a value; the rest is text.
    if (!/^\{[^"{}]+\}$/.test(raw.trim()))
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    set[assignment.slice(0, at).trim()] = value;
  }
  const target = command === "page-set"
    ? { page: option(args, "--page") ?? base.page, platform: option(args, "--platform") ?? base.platform }
    : { component: option(args, "--component") ?? base.component, variant: option(args, "--variant") ?? base.variant };
  const element = option(args, "--element") ?? base.element;
  const all = flag(args, "--all") || base.all === true ? true : undefined;
  return Object.fromEntries(Object.entries({ ...target, element, all, set }).filter(([, value]) => value !== undefined));
}

// The stored nodes behind a selection (a page version or a variant): the
// projection draws copies but keeps their overrides only here.
function storedNodesOf(workspace, selection = {}) {
  const snapshots = [workspace.product, workspace.foundation, ...(workspace.libraries ?? [])].filter(Boolean);
  for (const snapshot of snapshots) {
    if (selection.screenId) {
      const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].id === selection.screenId);
      const screen = entry && snapshot.entries[entry];
      const presentation = screen?.presentations.find(({ id }) => id === (selection.presentationId ?? screen.basePresentationId));
      if (presentation) return presentation.nodes;
    }
    const set = selection.componentId && snapshot.domain.componentSets.get(selection.componentId);
    if (set) return (set.variants.find(({ id }) => id === selection.variantId) ?? set.variants[0]).nodes;
  }
  return {};
}

// Token id -> name across the workspace, for specs.
function tokenNamer(workspace) {
  const names = new Map();
  for (const snapshot of [workspace.product, workspace.foundation, ...(workspace.libraries ?? [])].filter(Boolean))
    for (const token of snapshot.domain.tokens.values()) if (!names.has(token.id)) names.set(token.id, token.path);
  return (reference) => names.get(reference?.assetId ?? reference);
}

// --token: one Token by name, or every Token under a name ("color").
function tokenNamed(path, wanted) {
  if (wanted === undefined) return true;
  const name = String(wanted).trim().replace(/^\{|\}$/g, "");
  return path === name || String(path).startsWith(`${name}.`);
}

// project show: counts in the words the commands use.
function projectSummary(snapshot) {
  const summary = packageSummary(snapshot);
  const pages = snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry]);
  const sets = [...snapshot.domain.componentSets.values()];
  const { starts, links } = flowLinks(snapshot);
  return {
    name: summary.name,
    role: summary.role,
    revision: summary.revision,
    counts: {
      pages: pages.length,
      pageVersions: pages.reduce((total, page) => total + page.presentations.length, 0),
      components: sets.length + snapshot.domain.locatedComponents.size,
      variants: sets.reduce((total, set) => total + set.variants.length, 0),
      tokens: summary.counts.tokens,
      tokenValues: summary.counts.tokenValues,
      themeOptions: listTokenThemes(snapshot).length,
      links: links.length,
      starts: starts.length,
      elements: summary.counts.nodes,
    },
    dependencies: (snapshot.manifest.dependencies ?? []).map((dependency) => dependency.path ?? dependency.name ?? dependency.packageId),
    next: "view PACKAGE for pages, components and Tokens by name; --full for the stored data",
  };
}

// Every check of the selected targets, untruncated.
async function validateTargets(workspace, args) {
  const designs = await validationDesigns(workspace, args);
  const reports = [];
  for (const design of designs) {
    const report = {
      ...(await validateDesign(workspace, design)),
      selection: design.selection,
    };
    // A skipped check names its element; its path is a projected node id.
    const nodes = design.projection?.nodes ?? {};
    report.coverage.skipped = (report.coverage.skipped ?? []).map((skip) => {
      const at = typeof skip.path === "string" && Object.hasOwn(nodes, skip.path) ? skip.path
        : typeof skip.nodeId === "string" && Object.hasOwn(nodes, skip.nodeId) ? skip.nodeId : undefined;
      if (at === undefined) return skip;
      const { path: _path, ...rest } = skip;
      return { ...rest, element: elementPath(nodes, design.projection.rootId, at) || nodes[at].name };
    });
    if (design.selection.screenId) {
      const flow = prototypeConnections(
        workspace.product,
        design.selection,
        {
          ...workspace,
          context: design.projection.context,
          initialProjection: design.projection,
        },
      );
      report.issues.push(
        ...flow.issues.map((issue) => ({
          ...issue,
          check: "prototype-connections",
        })),
      );
      report.coverage.checks.push("prototype-connections");
      report.coverage.connectionCount = flow.connections.length;
    }
    reports.push(report);
  }
  const all = flag(args, "--all");
  const visual = {
    ...reports[0],
    ...(reports.some((report) => report.hints?.length) ? { hints: reports.flatMap((report) => report.hints ?? []) } : {}),
    issues: reports.flatMap((report) =>
      report.issues.map((issue) =>
        all ? { ...issue, target: report.selection } : issue,
      ),
    ),
    coverage: {
      ...reports[0].coverage,
      targets: reports.map((report) => ({ ...selectionNames(workspace, report.selection), ...report.selection })),
      targetCount: reports.length,
      nodeCount: reports.reduce(
        (count, report) => count + report.coverage.nodeCount,
        0,
      ),
      visibleNodeCount: reports.reduce(
        (count, report) => count + report.coverage.visibleNodeCount,
        0,
      ),
      ...(reports.some(
        (report) => report.coverage.connectionCount !== undefined,
      )
        ? {
            connectionCount: reports.reduce(
              (count, report) =>
                count + (report.coverage.connectionCount ?? 0),
              0,
            ),
          }
        : {}),
      skipped: reports.flatMap((report) =>
        report.coverage.skipped.map((skip) =>
          all ? { ...skip, target: report.selection } : skip,
        ),
      ),
    },
  };
  visual.issueCount = visual.issues.length;
  visual.interactionIssueCount = visual.issues.filter(
    (issue) => issue.check === "prototype-connections",
  ).length;
  visual.interactionStatus = !visual.coverage.checks.includes(
    "prototype-connections",
  )
    ? "not-checked"
    : visual.interactionIssueCount
      ? "issues"
      : "no-issues-found";
  if (all) {
    visual.selection = {
      ...themeSettings(workspace).selection,
      all: true,
      ...(option(args, "--component-id")
        ? {
            componentId: option(args, "--component-id"),
            packageId: reports[0].selection.packageId,
          }
        : { screenId: option(args, "--screen-id") }),
    };
  }
  return visual;
}

async function validateCommand(packagePath, args, { named = false } = {}) {
  if (
    flag(args, "--all") &&
    !option(args, "--component-id") &&
    !option(args, "--screen-id")
  )
    throw new SmallPenError(
      "missing_check_target",
      "--all requires one --component-id or one --screen-id",
    );
  const resolution = await resolveCliWorkspace(packagePath);
  const staleInstances = workspaceStaleInstances(resolution);
  if (resolution.status === "repair") {
    throw new SmallPenError(
      "repair_required",
      "SmallPen workspace requires Repair",
      {
        conflicts: resolution.conflicts,
        ...(staleInstances.length > 0 ? { staleInstances } : {}),
        nextOperations: [
          { args: { packagePath }, operation: "smallpen.repair" },
        ],
      },
    );
  }
  if (staleInstances.length > 0) {
    throw new SmallPenError(
      "stale_instance_variant",
      `${staleInstances.length} Instance(s) select a variant their Component Set no longer has. ` +
        `${staleInstances[0].message}. Fix: ${staleInstances[0].fix}`,
      { instances: staleInstances },
    );
  }
  const workspace = await tokenWorkspace(packagePath, args);
  const targeted = [
    "--screen-id",
    "--presentation-id",
    "--scenario-id",
    "--component-id",
    "--node-id",
    "--design-system",
  ].some((arg) => flag(args, arg));
  if (!targeted) return validateWholePackage(packagePath, args, workspace, resolution);
  if (named) {
    const ids = ["--screen-id", "--presentation-id", "--component-id", "--package-id", "--variant-id"]
      .flatMap((name) => (option(args, name) !== undefined ? [name, option(args, name)] : []));
    const where = option(args, "--page") ?? option(args, "--component");
    return validateWholePackage(packagePath, args, workspace, resolution, [{ ids: [...ids, ...(flag(args, "--all") ? ["--all"] : [])], where }]);
  }
  let visual;
  if (targeted || workspace.product.manifest.defaultScreenId) {
    visual = await validateTargets(workspace, args);
    const report = {
      packageId: workspace.product.manifest.packageId,
      ...workspaceRevisions(
        workspace.product,
        workspace.foundation,
        workspace.libraries,
      ),
      ...visual,
    };
    if (
      visual.issues.length > 20 ||
      visual.coverage.skipped.length > 10 ||
      visual.coverage.targets.length > 20
    ) {
      const json = canonicalJSON(report);
      visual.reportPath = await writeAtomic(
        artifactPath("validation", "json"),
        json,
      );
    }
    visual.coverage = {
      ...visual.coverage,
      targets: visual.coverage.targets.slice(0, 20),
      skippedCount: visual.coverage.skipped.length,
      skipped: visual.coverage.skipped.slice(0, 10),
    };
    const page = pageItems(visual.issues, pagination(args));
    visual = {
      ...visual,
      issues: flag(args, "--full") ? visual.issues : page.items,
      page: page.page,
    };
  } else
    visual = {
      selection: themeSettings(workspace).selection,
      issues: [],
      issueCount: 0,
      coverage: {
        complete: false,
        checks: ["canonical-data", "references"],
        skipped: [
          {
            check: "visual",
            reason: "Select a component variant or Screen for visual checks",
          },
        ],
      },
    };
  if (!targeted) {
    // The whole package: names that repeat are issues too.
    const names = packageNameIssues(workspace);
    if (names.length)
      visual = { ...visual, issues: [...names, ...visual.issues], issueCount: (visual.issueCount ?? 0) + names.length };
  }
  return {
    foundationRevision: resolution.workspace.foundation?.revision,
    packageId: resolution.workspace.product.manifest.packageId,
    revision: resolution.workspace.product.revision,
    status: "valid",
    dataStatus: "valid",
    visualStatus: visual.issueCount ? "issues" : "no-issues-found",
    interactionStatus: visual.interactionStatus ?? "not-checked",
    ...visual,
    warnings: [
      ...(resolution.warnings ?? []),
      ...[resolution.workspace.foundation, resolution.workspace.product]
        .filter(Boolean)
        .flatMap(packageFormatWarnings),
    ],
  };
}

async function main(args) {
  publicSurface = Boolean(commandMatch(args)?.route);
  const routed = routeCommand(args);
  args = routed.args;
  publicSurface =
    Boolean(routed.route) ||
    ["view", "export", "validate", "changes"].includes(args[0]);
  const globalVersion = args[0] === "--version";
  if (args[0] === "--version") args = ["version", ...args.slice(1)];
  if (args[0] === "-h") args = ["--help", ...args.slice(1)];
  if (Object.hasOwn(COMMAND_CONTRACTS, args[0])) {
    args = [...args];
    const definitions = Object.values(commandContract(args[0]).parameters);
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-h") args[i] = "--help";
      const parameter = definitions.find(({ option }) => option === args[i]);
      if (parameter && parameter.type !== "boolean") i++;
    }
  }
  const command = args[0];
  beginArtifacts(
    Object.hasOwn(COMMAND_CONTRACTS, command) ? command : "help",
    args,
  );
  if (!command || command === "--help") {
    printHelp(args[1]?.startsWith("-") ? undefined : args[1], {
      full: flag(args, "--full"),
    });
    return;
  }
  if (command === "help") {
    if (flag(args, "--help")) {
      printHelp("help", { full: flag(args, "--full") });
      return;
    }
    let [topic, section] = discoveryArguments("help", args);
    // An old flat name ("help init") shows its grouped path's help.
    if (topic && section === undefined && !COMMAND_GROUPS[topic] && Object.hasOwn(COMMAND_CONTRACTS, topic)) {
      const path = publicArgv([topic]);
      if (path.length >= 2 && COMMAND_GROUPS[path[0]]) [topic, section] = [path[0], path.slice(1).join(" ")];
    }
    const full = flag(args, "--full");
    const value = helpTopic(topic, section, { full });
    // A grouped action's full help is its engine's text, under its path.
    const route = topic && section && COMMAND_GROUPS[topic] && !groupDefinition(topic, section) ? groupRoute(topic, section) : undefined;
    const fullTopic = route ? route.engine : !COMMAND_GROUPS[topic] && !["workflow", "rules"].includes(topic) ? topic : undefined;
    if (flag(args, "--json"))
      printJson(
        full && fullTopic
          ? { ...commandContract(route ? route.name : fullTopic), guidance: commandGuidance(fullTopic, route) }
          : value,
      );
    else if (full && fullTopic) printHelp(fullTopic, { full, route });
    else printBriefHelp(topic, section, { full });
    return;
  }
  if (command === "version") {
    if (flag(args, "--help")) {
      printHelp("version", { full: flag(args, "--full") });
      return;
    }
    validateCommandArguments("version", ["version", "", ...args.slice(1)]);
    const { name, version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (globalVersion && !flag(args, "--json"))
      process.stdout.write(`${name} ${version}\n`);
    else printJson({ name, version });
    return;
  }
  if (command === "schema") {
    if (flag(args, "--help")) {
      printHelp("schema", { full: flag(args, "--full") });
      return;
    }
    const positional = discoveryArguments("schema", args);
    if (
      (args.includes("--limit") || args.includes("--offset")) &&
      !["commands", "operations"].includes(positional[0])
    )
      throw new SmallPenError(
        "invalid_schema_pagination",
        "Pagination applies only to schema commands or operations",
        {
          nextOperations: [
            {
              operation: "smallpen.schema",
              argv: ["schema", "commands", "--json"],
            },
          ],
        },
      );
    const { version: cliVersion } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    const contractRevision = createHash("sha256")
      .update(
        canonicalJSON({
          capabilities: SMALLPEN_FORMAT_CAPABILITIES,
          operations:
            SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.operationTypes.map(
              (type) => schemaTopic("operation", type),
            ),
          schema: await readFile(
            new URL("./schema.mjs", import.meta.url),
            "utf8",
          ),
          cli: await readFile(new URL(import.meta.url), "utf8"),
          help: await readFile(new URL("./help.mjs", import.meta.url), "utf8"),
          helpTopics: await readFile(
            new URL("./help-topics.mjs", import.meta.url),
            "utf8",
          ),
          windowsArtifacts: await readFile(
            new URL("./windows-artifacts.mjs", import.meta.url),
            "utf8",
          ),
          resultFiles: await readFile(
            new URL("./result-files.mjs", import.meta.url),
            "utf8",
          ),
          output: await readFile(
            new URL("./read-output.mjs", import.meta.url),
            "utf8",
          ),
          commands: COMMAND_CONTRACTS,
          commandTree: await readFile(
            new URL("./command-tree.mjs", import.meta.url),
            "utf8",
          ),
          parameters: await readFile(
            new URL("./command-contract.mjs", import.meta.url),
            "utf8",
          ),
          workflow: CLI_RULES,
          designOutput: await readFile(
            new URL("./design-output.mjs", import.meta.url),
            "utf8",
          ),
        }),
      )
      .digest("hex");
    printJson({
      ...schemaTopic(positional[0], positional[1], {
        action: positional[2],
        full: flag(args, "--full"),
        limit: args.includes("--limit")
          ? integerOption(args, "--limit")
          : undefined,
        offset: integerOption(args, "--offset"),
      }),
      cliVersion,
      contractRevision,
    });
    return;
  }
  // Only grouped commands and the shared ones are public: an engine name
  // typed directly ("apply", "inspect") points to its grouped path.
  if (
    !routed.route &&
    COMMAND_NAMES.includes(command) &&
    !["view", "changes", "export", "validate", "help", "schema", "version"].includes(command)
  ) {
    const path = publicArgv([command]);
    throw new SmallPenError(
      "unknown_command",
      `Unknown command: ${command}${path[0] !== command ? `; use smallpen ${path.join(" ")}` : ""}`,
      {
        ...(path[0] !== command ? { suggestion: path.join(" ") } : {}),
        validCommands: PUBLIC_COMMANDS.map(({ command: name }) => name),
      },
    );
  }
  if (!COMMAND_NAMES.includes(command) && command !== "resource-write") {
    const path = publicArgv([command]);
    const suggestion = path[0] !== command ? path.join(" ") : undefined;
    throw new SmallPenError("unknown_command", `Unknown command: ${command}${suggestion ? `; use smallpen ${suggestion}` : ""}`, {
      validCommands: PUBLIC_COMMANDS.map(({ command }) => command),
      ...(suggestion ? { suggestion, nextOperations: [{ operation: "smallpen.help", argv: ["help", ...path, "--json"] }] } : {}),
    });
  }
  if (flag(args, "--help")) {
    printHelp(command, { full: flag(args, "--full") });
    return;
  }
  if (!routed.route) args = validateCommandArguments(command, args);
  executionArgs = args;
  const packagePath = args[1];
  if (command === "token-export") {
    printJson(await tokenExportCommand(packagePath, args));
    return;
  }
  if (command === "changes") {
    printJson(await changesCommand(packagePath, args));
    return;
  }
  if (command === "view") {
    const looked = await lookCommand(packagePath, args);
    // Every read reports the revision it saw, for changes --since.
    if (looked.revision === undefined) looked.revision = (await openPackage(packagePath)).revision;
    printJson(looked);
    return;
  }
  // --context Density=Compact names an axis and a value; the engines take
  // their IDs.
  if (publicSurface && options(args, "--context").length) args = await namedContextArgs(packagePath, args);
  // export and validate name their target as view does; the engines below
  // take the IDs those names stand for.
  if (command === "export" || command === "validate")
    args = [...args, ...(await nameTargetArgs(packagePath, args, { every: command === "validate" }))];
  if (command === "export" && flag(args, "--evidence")) {
    if (option(args, "--format") !== "png")
      throw new SmallPenError("missing_png_format", "--evidence requires --format png");
    const translated = ["export", packagePath];
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--evidence") continue;
      if (args[i] === "--format") {
        i++;
        continue;
      }
      translated.push(args[i]);
    }
    printJson(await renderCommand(packagePath, translated, true));
    return;
  }

  if (command === "themes") {
    const workspace = await tokenWorkspace(packagePath, args);
    const settings = themeSettings(workspace, { full: flag(args, "--full") });
    const groups = pageItems(settings.groups, pagination(args));
    printJson({
      ...settings,
      groups: flag(args, "--full") ? settings.groups : groups.items,
      page: groups.page,
      packageId: workspace.product.manifest.packageId,
      ...workspaceRevisions(
        workspace.product,
        workspace.foundation,
        workspace.libraries,
      ),
      nextOperations: [
        { argv: ["help", "theme", "--json"], operation: "smallpen.help" },
      ],
    });
    return;
  }
  if (command === "canvas-list") {
    printJson(await canvasListCommand(packagePath));
    return;
  }
  if (command === "flow-list") {
    printJson(await flowListCommand(packagePath, args));
    return;
  }
  if (NAMED_EDITS.has(command) || (command === "flow-start" && flag(args, "--remove"))) {
    const intent = command === "flow-start" ? { page: option(args, "--page"), platform: option(args, "--platform"), remove: true } : namedEditIntent(command, args);
    // A workspace in Repair takes no edits until its dependency is fixed.
    await readableWorkspace(packagePath);
    const snapshot = await openPackage(packagePath);
    const batchId = option(args, "--batch-id") ?? `${command}_${randomUUID()}`;
    const cliIntent = { command, intent };
    if (
      option(args, "--batch-id") &&
      !["--dry-run", "--explain", "--diff"].some((arg) => flag(args, arg))
    ) {
      const recorded = await replayRecordedBatch(
        packagePath,
        { baseRevision: snapshot.revision, batchId, operations: [], cliIntent },
        { rebuilt: true },
      );
      if (recorded) {
        printJson(await writeReply(recorded, args));
        return;
      }
    }
    const operations =
      command === "flow-start"
        ? [flowStartRemoveOperation(snapshot, intent.page, intent.platform)]
        : await namedEditOperations(command, snapshot, intent, packagePath);
    if (command === "component-delete") {
      // Copies in this package first, then in packages that depend on it.
      checkNotUsedElsewhere([snapshot], operations, snapshot, { here: true });
      checkNotUsedElsewhere(await dependentPackages(packagePath, snapshot), operations, snapshot);
    }
    printJson(
      await applyBatch(
        packagePath,
        { baseRevision: snapshot.revision, batchId, operations, cliIntent, ...renameNumbering(command) },
        args,
      ),
    );
    return;
  }
  if (["component-define", "page-draw", "page-set", "component-set", "page-move", "canvas-rename", "canvas-put", "flow-link", "flow-start"].includes(command)) {
    // Elements, components and pages by name: the planners build node
    // tables and IDs; text is measured with the renderer's fonts.
    const intent =
      command === "flow-link"
        ? Object.fromEntries(
            [["from", "--from"], ["to", "--to"], ["on", "--on"], ["action", "--action"], ["platform", "--platform"]]
              .map(([key, flagName]) => [key, option(args, flagName)])
              .filter(([, value]) => value !== undefined),
          )
        : command === "flow-start"
          ? { page: option(args, "--page"), ...(option(args, "--platform") ? { platform: option(args, "--platform") } : {}) }
          : command === "canvas-rename"
            ? { canvas: option(args, "--canvas"), to: option(args, "--to") }
          : command === "canvas-put"
            ? { page: option(args, "--page"), canvas: option(args, "--canvas") }
          : command === "page-set" || command === "component-set"
            ? await setIntent(command, args)
          : command === "page-move"
            ? {
                page: option(args, "--page"),
                platform: option(args, "--platform"),
                element: option(args, "--element"),
                direction: option(args, "--direction"),
                // One place unless --steps says more.
                steps: option(args, "--steps") === undefined ? 1 : Math.max(1, Number(option(args, "--steps"))),
              }
            : parseJson(
              await readInputFile(option(args, "--intent"), "--intent", "utf8"),
              `invalid_${command.replace("-", "_")}_json`,
            );
    const workspace = await readableWorkspace(packagePath);
    const snapshot = await openPackage(packagePath);
    const batchId = option(args, "--batch-id") ?? `${command}_${randomUUID()}`;
    const cliIntent = { command, intent };
    if (
      option(args, "--batch-id") &&
      !["--dry-run", "--explain", "--diff"].some((arg) => flag(args, arg))
    ) {
      const recorded = await replayRecordedBatch(
        packagePath,
        { baseRevision: snapshot.revision, batchId, operations: [], cliIntent },
        { rebuilt: true },
      );
      if (recorded) {
        printJson(await writeReply(recorded, args));
        return;
      }
    }
    const lookups = {
      foundation: workspace.foundation !== workspace.product ? workspace.foundation : undefined,
      libraries: workspace.libraries ?? [],
    };
    let operations;
    let flowTarget;
    if (command === "page-move" && intent.element === undefined) {
      // A whole page moves in its business flow's row on the canvas.
      const screen = findPage(snapshot, intent.page);
      operations = [reorderPageOperation(snapshot.manifest, snapshot.entries, screen.id, intent.direction, intent.steps, snapshot.runtime)];
    } else if (command === "page-move") {
      operations = [elementMoveOperation(snapshot, intent)];
    } else if (command === "canvas-rename") {
      operations = [renameCanvasOperation(snapshot.manifest, snapshot.entries, intent.canvas, intent.to)];
    } else if (command === "canvas-put") {
      const screen = findPage(snapshot, intent.page);
      operations = [placePageOnCanvas(snapshot.manifest, snapshot.entries, screen.id, intent.canvas)];
    } else if (["component-define", "page-draw", "page-set", "component-set"].includes(command)) {
      // Plan once with estimated text sizes, measure every text with the
      // renderer, then plan again with the measured sizes.
      // Variants share node ids, so sizes are kept per tree, in the order
      // the planner asks for them.
      const trees = [];
      const measured = [];
      // A text that fills its slot is measured again at the slot's width,
      // where it wraps: "id@width" -> height, asked for by the planner.
      const wraps = [];
      const asked = [];
      let calls = 0;
      const plan = () => {
        calls = 0;
        return ({ "component-define": componentDefineOperation, "page-draw": pageDrawOperation, "page-set": pageSetOperation, "component-set": componentSetOperation })[command](
          snapshot,
          intent,
          {
            ...lookups,
            measure: (tree) => {
              const index = calls++;
              trees[index] ??= tree;
              const size = (id) => measured[index]?.get(id);
              size.wrapped = (id, width) => {
                const key = `${id}@${Math.round(width)}`;
                const known = wraps[index]?.get(key);
                if (!known) (asked[index] ??= new Map()).set(key, { id, width: Math.round(width), node: tree.nodes[id] });
                return known;
              };
              return size;
            },
          },
        );
      };
      plan();
      for (const [index, tree] of trees.entries()) {
        measured[index] = new Map();
        // Texts that fill or hug their slot are measured on one line: their
        // natural width; fixed-width texts wrap at their width.
        const texts = Object.fromEntries(
          [
            ...Object.entries(tree.nodes).filter(([, node]) => node.type === "TEXT"),
            ...Object.entries(tree.probes ?? {}),
          ].map(([id, node]) => {
            // A text bound to a string Token is measured with its longest
            // translation.
            const longest = tree.measureTexts?.[id];
            const measured = longest ? { ...node, text: longest } : node;
            return [
              id,
              ["fill", "auto"].includes(node["layout-item-h-sizing"])
                ? { ...measured, growType: "auto-width" }
                : measured,
            ];
          }),
        );
        if (!Object.keys(texts).length) continue;
        const metrics = await measureProjectionText(
          workspace.product,
          { nodes: texts, rootId: Object.keys(texts)[0] },
          { foundation: lookups.foundation, libraries: lookups.libraries },
        );
        for (const item of metrics.items)
          if (!item.missingGlyphs?.length)
            measured[index].set(item.nodeId, { width: Math.ceil(item.width), height: Math.ceil(item.height) });
      }
      operations = [plan()];
      if (asked.some((requests) => requests?.size)) {
        for (const [index, requests] of asked.entries()) {
          if (!requests?.size) continue;
          wraps[index] = new Map();
          const texts = Object.fromEntries([...requests].map(([key, { id, width, node }]) => {
            const longest = trees[index].measureTexts?.[id];
            return [key, { ...node, id: key, text: longest ?? node.text, width, growType: "auto-height", "layout-item-h-sizing": "fix" }];
          }));
          const metrics = await measureProjectionText(
            workspace.product,
            { nodes: texts, rootId: Object.keys(texts)[0] },
            { foundation: lookups.foundation, libraries: lookups.libraries },
          );
          for (const item of metrics.items)
            if (!item.missingGlyphs?.length) wraps[index].set(item.nodeId, { height: Math.ceil(item.height) });
        }
        operations = [plan()];
      }
      // A page drawn onto a named canvas is placed there (made if new).
      if (command === "page-draw" && intent.canvas !== undefined)
        operations.push(placePageOnCanvas(snapshot.manifest, snapshot.entries, operations[0].screen.id, intent.canvas));
    } else {
      const flowIntent =
        command === "flow-link"
          ? flowLinkIntent(snapshot, intent, lookups)
          : flowStartIntent(snapshot, intent.page, () => {
              const hex = createHash("sha256").update(`${batchId}\0start`).digest("hex");
              return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
            }, intent.platform);
      operations = interactionIntentOperations(snapshot, flowIntent);
      // Say which page version the link or start went to.
      flowTarget = versionName(snapshot, flowIntent.screenId, flowIntent.presentationId);
    }
    const written = await applyBatch(
      packagePath,
      { baseRevision: snapshot.revision, batchId, operations, cliIntent, ...renameNumbering(command) },
      args,
    );
    printJson(flowTarget ? { target: flowTarget, ...written } : written);
    return;
  }
  if (NAMED_TOKEN_WRITES.has(command)) {
    // Name-based writes compile to the existing operations in one atomic
    // batch; a retried batch ID replays the recorded result.
    const intent =
      command === "token-set"
        ? parseJson(
            await readInputFile(option(args, "--intent"), "--intent", "utf8"),
            "invalid_token_set_json",
          )
        : {
            themes: options(args, "--theme"),
            group: option(args, "--group"),
            to: option(args, "--to"),
            path: option(args, "--path"),
          };
    // A workspace in Repair takes no edits until its dependency is fixed.
    await readableWorkspace(packagePath);
    const snapshot = await openPackage(packagePath);
    const batchId = option(args, "--batch-id") ?? `${command}_${randomUUID()}`;
    const cliIntent = { command, intent };
    if (
      option(args, "--batch-id") &&
      !["--dry-run", "--explain", "--diff"].some((arg) => flag(args, arg))
    ) {
      const recorded = await replayRecordedBatch(
        packagePath,
        { baseRevision: snapshot.revision, batchId, operations: [], cliIntent },
        { rebuilt: true },
      );
      if (recorded) {
        printJson(await writeReply(recorded, args));
        return;
      }
    }
    let operations = [];
    if (command.startsWith("theme-")) {
      const [theme] = intent.themes;
      const steps =
        command === "theme-add"
          ? themeAddIntents(snapshot, intent.themes)
          : command === "theme-rename"
            ? [themeRenameIntent(snapshot, { theme, group: intent.group, to: intent.to })]
            : command === "theme-default"
              ? [themeDefaultIntent(snapshot, theme)]
              : [themeDeleteIntent(snapshot, { theme, group: intent.group })];
      // Each step reads the group as the previous step leaves it.
      let working = snapshot;
      for (const step of steps) {
        const stepOperations = await themeIntentOperations(working, step);
        working = (
          await prepareOperationBatch(working, {
            baseRevision: working.revision,
            batchId: `${batchId}_plan_${operations.length}`,
            operations: stepOperations,
          })
        ).snapshot;
        operations.push(...stepOperations);
      }
    } else if (command === "token-delete") {
      operations = tokenDeleteOperations(snapshot, intent.path);
      checkNotUsedElsewhere(await dependentPackages(packagePath, snapshot), operations, snapshot);
    } else {
      let index = 0;
      operations = tokenSetOperations(snapshot, intent, () =>
        `tok_${createHash("sha256")
          .update(canonicalJSON({ batchId, intent, index: index++ }))
          .digest("hex")
          .slice(0, 32)}`,
      );
    }
    printJson(
      await applyBatch(
        packagePath,
        { baseRevision: snapshot.revision, batchId, operations, cliIntent, ...renameNumbering(command) },
        args,
      ),
    );
    return;
  }
  if (command === "export") {
    if (option(args, "--format") !== "png" && flag(args, "--base64"))
      throw new SmallPenError("missing_png_format", "--base64 requires --format png");
    // Say what was exported, by the names the caller gave.
    const target = Object.fromEntries(
      [["page", "--page"], ["platform", "--platform"], ["component", "--component"], ["variant", "--variant"], ["element", "--element"]]
        .map(([key, name]) => [key, option(args, name)])
        .filter(([, value]) => value !== undefined),
    );
    if (flag(args, "--design-system")) target.designSystem = true;
    const exported = await designCommand(packagePath, args);
    printJson(Object.keys(target).length ? { target, ...exported } : exported);
    return;
  }

  if (command === "init") {
    printJson(await initializeCommand(packagePath, args));
    return;
  }
  if (command === "migrate-themes") {
    printJson(
      await trackedWrite(() =>
        migrateThemesByCopy(packagePath, option(args, "--output")),
      ),
    );
    return;
  }
  if (command === "import-draft") {
    const inputPath = option(args, "--input");
    const kind = option(args, "--kind") ?? "figma";
    const input = await readInputFile(inputPath, "--input");
    printJson(
      await trackedWrite(() =>
        importDraft({
          ...(kind === "figma"
            ? { html: input.toString("utf8") }
            : { bytes: new Uint8Array(input) }),
          kind,
          output: packagePath,
          packageId: option(args, "--package-id") ?? "pkg_figma_draft",
        }),
      ),
    );
    return;
  }
  if (command === "import-tokens") {
    const inputPath = option(args, "--input");
    const document = parseJson(
      await readInputFile(inputPath, "--input", "utf8"),
      "invalid_import_json",
      { path: inputPath },
    );
    const { product: snapshot } = await tokenWorkspace(packagePath, args);
    const selection = options(args, "--select");
    const result = importTokens(snapshot, document, {
      selection: selection.length > 0 ? selection : undefined,
      setName: option(args, "--set-name"),
    });
    const full = flag(args, "--full");
    const review = {
      diff: full
        ? result.diff
        : Object.fromEntries(
            Object.entries(result.diff).map(([group, actions]) => [
              group,
              group === "summary"
                ? actions
                : Object.fromEntries(
                    Object.entries(actions).map(([action, rows]) => [
                      action,
                      {
                        total: rows.length,
                        items: rows.slice(0, 20).map((row) =>
                          typeof row === "string"
                            ? row
                            : {
                                id: row.id,
                                name:
                                  row.name ??
                                  row.after?.name ??
                                  row.before?.name,
                                set: row.set,
                                path: row.path,
                                fields: row.fields,
                              },
                        ),
                      },
                    ]),
                  ),
            ]),
          ),
      previousLibraryId: result.previousLibraryId,
      warnings: full ? result.warnings : result.warnings.slice(0, 20),
      warningCount: result.warnings.length,
    };
    if (!flag(args, "--apply")) {
      printJson({
        ...review,
        packageId: snapshot.manifest.packageId,
        revision: snapshot.revision,
        dryRun: true,
        library: full
          ? result.library
          : {
              id: result.library.id,
              setCount: result.library.sets.length,
              tokenCount: result.library.sets.reduce(
                (count, set) => count + set.tokens.length,
                0,
              ),
              themeCount: result.library.themes.length,
            },
      });
      return;
    }
    printJson({
      ...(await applyBatch(
        packagePath,
        {
          baseRevision: snapshot.revision,
          batchId:
            option(args, "--batch-id") ?? `import_tokens_${randomUUID()}`,
          operations: result.operations,
        },
        args,
      )),
      ...review,
    });
    return;
  }
  if (command === "draft-diff") {
    const afterPath = option(args, "--after");
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
    const selections = parseJson(
      await readInputFile(selectionsPath, "--selections", "utf8"),
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
  if (command === "validate") {
    // A named page or component reads like the whole-package report;
    // --full keeps every stored check.
    const named = publicSurface && option(args, "--element") === undefined && !flag(args, "--full") &&
      (option(args, "--page") !== undefined || option(args, "--component") !== undefined);
    const report = await validateCommand(packagePath, args, { named });
    // Sizes the preview cannot compute: one note, not one issue each.
    const limits = (report.issues ?? []).filter((issue) => issue.code === "layout_projection_partial");
    if (limits.length && !flag(args, "--full")) {
      report.issues = report.issues.filter((issue) => issue.code !== "layout_projection_partial");
      report.issueCount = (report.issueCount ?? limits.length) - limits.length;
      if (!report.issueCount) report.visualStatus = "no-issues-found";
      report.previewNote = `The local preview cannot compute some automatic sizes in ${limits.length} place${limits.length === 1 ? "" : "s"}; geometry there may differ in the App.`;
    }
    printJson(report);
    return;
  }
  if (command === "inspect") {
    const snapshot = await openPackage(packagePath);
    printJson(
      flag(args, "--full")
        ? { revision: snapshot.revision, ...inspect(snapshot) }
        : projectSummary(snapshot),
    );
    return;
  }
  if (command === "list") {
    const snapshot = await openPackage(packagePath);
    const kind = option(args, "--kind") ?? "all";
    const offset = integerOption(args, "--offset");
    const limit = integerOption(args, "--limit");
    const all = listDomain(snapshot, kind)
      .sort((left, right) =>
        compareText(String(left.item.id ?? ""), String(right.item.id ?? "")),
      );
    // A page version reads as its page and platform; its own name is often
    // just "desktop".
    const pageNames = new Map(snapshot.manifest.entries.screens.map((entry) => [snapshot.entries[entry].id, snapshot.entries[entry].name]));
    // page list: each page by name with its platforms.
    if (routed.route?.name === "page list" && !flag(args, "--full")) {
      const pages = snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry]);
      printJson({
        pages: pages.slice(offset, offset + limit).map((screen) => ({
          name: screen.name,
          platforms: screen.presentations.map((presentation) => presentation.platform ?? presentation.name),
        })),
        page: { hasMore: offset + limit < pages.length, limit, offset, total: pages.length },
        revision: snapshot.revision,
      });
      return;
    }
    printJson({
      items: all.slice(offset, offset + limit).map(({ group, item }) => {
        const summary = flag(args, "--full") ? item : discoverySummary(item);
        const screen = group === "screens" ? snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry]).find(({ id }) => id === item.id) : undefined;
        const value = group === "presentations" && pageNames.has(item.screenId)
          ? { page: pageNames.get(item.screenId), ...summary }
          : screen
            ? { ...summary, platforms: screen.presentations.map((presentation) => presentation.platform ?? presentation.name) }
            : summary;
        return routed.route?.name === "page list" ? value : { group, item: value };
      }),
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
    if (flag(args, "--definitions")) {
      if (
        options(args, "--theme").length ||
        options(args, "--context").length
      ) {
        throw new SmallPenError(
          "conflicting_token_read_options",
          "--definitions reads stored values in all options; use --theme/--context with effective tokens instead",
        );
      }
      const { product, foundation, libraries } =
        await readableWorkspace(packagePath);
      const snapshots = [foundation, ...libraries, product].filter(
        (item, index, all) =>
          item &&
          all.findIndex(
            (other) => other?.manifest.packageId === item.manifest.packageId,
          ) === index,
      );
      const group = option(args, "--group");
      const all = snapshots.flatMap((snapshot) =>
        listTokenDefinitions(snapshot, { group }),
      ).filter((item) => tokenNamed(item.token?.path, option(args, "--token")));
      const page = pageItems(all, pagination(args));
      printJson({
        mode: "definitions",
        items:
          flag(args, "--full") &&
          !args.includes("--limit") &&
          !args.includes("--offset")
            ? all
            : page.items,
        page: page.page,
        packageId: product.manifest.packageId,
        ...workspaceRevisions(product, foundation, libraries),
        nextOperations: [
          {
            operation: "smallpen.schema",
            argv: ["schema", "token-set", "--json"],
          },
        ],
      });
      return;
    }
    if (option(args, "--group") !== undefined)
      throw new SmallPenError(
        "conflicting_token_read_options",
        "--group requires --definitions; effective token reads use --theme",
      );
    const { foundation, libraries, product } = await tokenWorkspace(
      packagePath,
      args,
    );
    const context = contextSelection(args);
    const requestedType = option(args, "--type");
    const all = listEffectiveTokens(product, {
      context,
      foundation,
      libraries,
    }).filter((item) => (!requestedType || item.token.type === requestedType) && tokenNamed(item.token.path, option(args, "--token")));
    const page = pageItems(all, pagination(args));
    const paginated =
      !flag(args, "--full") ||
      args.includes("--limit") ||
      args.includes("--offset");
    // Each row also lists the values it takes under other theme options,
    // so one read shows the whole matrix.
    const optionValues = await optionValuesFor(
      packagePath,
      args,
      page.items,
      { context, libraries },
    );
    printJson({
      context,
      items: flag(args, "--full")
        ? paginated
          ? page.items
          : all
        : page.items.map((item) => ({
            ...(Object.keys(item.target ?? {}).length ? { target: item.target } : {}),
            token: {
              id: item.token.id,
              path: item.token.path,
              type: item.token.type,
            },
            value: item.value,
            ...(optionValues.has(item.token.path)
              ? { values: optionValues.get(item.token.path) }
              : {}),
          })),
      ...(paginated ? { page: page.page } : {}),
      labels: tokenLabels(option(args, "--locale") ?? defaultLocale()),
      packageId: product.manifest.packageId,
      themes: themeSummary(product, foundation),
      ...workspaceRevisions(product, foundation, libraries),
    });
    return;
  }
  if (command === "search-tokens") {
    const { foundation, libraries, product } = await tokenWorkspace(
      packagePath,
      args,
    );
    const query = option(args, "--query");
    const requestedType = option(args, "--type");
    const valueSearch = searchValue(args);
    const type = requestedType ?? valueSearch.type;
    const limit = integerOption(args, "--limit");
    printJson({
      ...searchEffectiveTokens(product, {
        ...valueSearch,
        allThemes: flag(args, "--all-themes"),
        ...(options(args, "--theme").length > 0
          ? { themeMode: "explicit" }
          : {}),
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
  if (command === "catalog") {
    const { foundation, libraries, product } = await tokenWorkspace(
      packagePath,
      args,
    );
    const catalog = createCatalog(product, {
      context: contextSelection(args),
      foundation,
      libraries,
    });
    const page = pageItems(
      catalog.components.map((component) =>
        catalogItemSummary(component, [product, foundation, ...libraries]),
      ),
      pagination(args),
    );
    printJson({
      ...(flag(args, "--full")
        ? catalog
        : {
            packageId: catalog.packageId,
            role: catalog.role,
            components: page.items,
            page: page.page,
            counts: Object.fromEntries(
              Object.entries(catalog)
                .filter(([, value]) => Array.isArray(value))
                .map(([key, value]) => [key, value.length]),
            ),
            outputDetail: {
              omitted: [
                "tokens",
                "effectiveTokens",
                "tokenInventory",
                "contexts",
                "scenarios",
                "screens",
                "requirements",
              ],
              fullOption: "--full",
            },
          }),
      ...workspaceRevisions(product, foundation, libraries),
      warnings: (await resolveCliWorkspace(packagePath)).warnings ?? [],
    });
    return;
  }
  if (command === "search-components") {
    const query = option(args, "--query");
    const limit = integerOption(args, "--limit");
    const { foundation, libraries, product } = await tokenWorkspace(
      packagePath,
      args,
    );
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
        // view resolves the Foundation and Libraries from the searched
        // package, so the next read names it, not the owner (a URL).
        const argv = [
          "view",
          resolve(packagePath),
          "--component",
          component.name,
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
          ...(flag(args, "--full")
            ? component
            : catalogItemSummary(component, [owner])),
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
  if (command === "effective-token" || command === "explain-token") {
    const { foundation, libraries, product } = await tokenWorkspace(
      packagePath,
      args,
    );
    const reference = tokenReference(args, product, [foundation, ...libraries]);
    const context = contextSelection(args);
    const result =
      command === "explain-token"
        ? explainEffectiveToken(product, reference, {
            context,
            foundation,
            libraries,
          })
        : resolveEffectiveToken(product, reference, {
            context,
            foundation,
            libraries,
          });
    if (!result) {
      throw new SmallPenError("missing_token", "Token is not available", {
        reference,
      });
    }
    printJson({
      ...result,
      ...workspaceRevisions(product, foundation, libraries),
    });
    return;
  }
  if (command === "impact") {
    const { foundation, libraries, product } = await tokenWorkspace(
      packagePath,
      args,
    );
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
          packageIds: matches.map(
            ({ snapshot }) => snapshot.manifest.packageId,
          ),
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
    const batch = parseJson(
      await readInputFile(batchPath, "--batch", "utf8"),
      "invalid_batch_json",
      { path: batchPath },
    );
    if (!isRecord(batch)) {
      throw new SmallPenError(
        "invalid_batch",
        "Operation Batch must be a JSON object",
        { path: batchPath },
      );
    }
    if (Array.isArray(batch.operations)) {
      batch.operations.forEach((operation, index) => {
        if (isRecord(operation)) checkOperationShape(operation, index);
      });
    }
    await checkExternalComponentConsumers(packagePath, batch.operations ?? []);
    printJson(await applyBatch(packagePath, batch, args));
    return;
  }
  if (command === "assets") {
    const { product } = await readableWorkspace(packagePath);
    const items = listAssets(product, {
      kind: option(args, "--kind"),
    }).filter(
      ({ kind }) =>
        routed.route?.name !== "advanced style list" ||
        option(args, "--kind") !== undefined ||
        ["colors", "typographies"].includes(kind),
    );
    printJson({
      packageId: product.manifest.packageId,
      revision: product.revision,
      ...pageItems(items, pagination(args)),
    });
    return;
  }
  if (command === "import-media") {
    const mediaPath = option(args, "--file");
    const bytes = new Uint8Array(await readInputFile(mediaPath, "--file"));
    const inspected = inspectMedia(bytes);
    const mediaId = `media_${randomUUID()}`;
    const name = option(args, "--name") ?? mediaPath.split(/[\\/]/).pop();
    // Names do not repeat: a media file is found by its name.
    const mediaFolder = option(args, "--media-path") ?? "";
    const fullName = (folder, base) => [folder, base].filter(Boolean).join("/").toLowerCase();
    const taken = listAssets(await openPackage(packagePath), { kind: "media" })
      .find(({ asset }) => fullName(asset.path, asset.name) === fullName(mediaFolder, name));
    if (taken)
      throw new SmallPenError("duplicate_name", `A media file is already named ${[taken.asset.path, taken.asset.name].filter(Boolean).join("/")}; delete it with asset media delete or choose another --name`, { kind: "media", name });
    const print = await trackedWrite(() =>
      importMedia(packagePath, {
        bytes,
        height: inspected.height,
        id: mediaId,
        mimeType: inspected.mimeType,
        name,
        path: option(args, "--media-path") ?? "",
        width: inspected.width,
      }),
    );
    printJson(
      await writeReply(
        {
          batchId: print.result.batchId,
          changedFiles: print.result.changedFiles,
          descriptor: print.descriptor,
          inverseBatch: print.result.inverseBatch,
          revision: print.result.revision,
        },
        args,
      ),
    );
    return;
  }
  if (command === "import-font") {
    const fontPath = option(args, "--file");
    const family = option(args, "--family");
    const bytes = new Uint8Array(await readInputFile(fontPath, "--file"));
    const signatureTtf = bytes[0] === 0x00 && bytes[1] === 0x01;
    const signatureOtf = bytes[0] === 0x4f && bytes[1] === 0x54;
    const signatureWoff =
      bytes[0] === 0x77 &&
      bytes[1] === 0x4f &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46;
    const signatureWoff2 =
      bytes[0] === 0x77 &&
      bytes[1] === 0x4f &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x32;
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
    // A family imported again gains a variant: fonts are found by family name.
    const family_ = listAssets(await openPackage(packagePath), { kind: "fonts" })
      .find(({ asset }) => String(asset.family).toLowerCase() === String(family).toLowerCase());
    const fontId = family_?.asset.id ?? `font_${randomUUID()}`;
    const style = option(args, "--style") ?? "normal";
    const weight = integerOption(args, "--weight");
    const variantId = `fvar_${randomUUID()}`;
    const { result, variant } = await trackedWrite(() =>
      importFontVariant(packagePath, {
        family: family_?.asset.family ?? family,
        files,
        fontId,
        id: variantId,
        name: option(args, "--name") ?? fontVariantName(weight, style),
        style,
        weight,
      }),
    );
    printJson(
      await writeReply(
        {
          batchId: result.batchId,
          changedFiles: result.changedFiles,
          family: family_?.asset.family ?? family,
          variant: variant.name,
          files: variant.files,
          fontId,
          inverseBatch: result.inverseBatch,
          revision: result.revision,
          variantId: variant.id,
        },
        args,
      ),
    );
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
        // A failed fetch with a verified cache reports "stale": keep the reason.
        warning: refreshed.remote.warning,
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
    // Validate before clamping: Number("abc") is NaN and would poll nonstop.
    const interval = Math.max(100, integerOption(args, "--interval"));
    // Default is unlimited: watch without --max-events must keep observing
    // (SP-041-A caught a fallback of 1 that exited after the first event).
    const maxEvents = integerOption(args, "--max-events");
    if (maxEvents === 0) {
      throw new SmallPenError(
        "invalid_integer_option",
        "--max-events requires an integer from 1 through 10000",
        { maximum: 10_000, name: "--max-events", value: "0" },
      );
    }
    const emit = (payload) =>
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    // The last emitted state: an unchanged invalid state is not repeated
    // every poll, and recovery reports the revision again even when it is
    // the one before the Package became invalid.
    let previous;
    let events = 0;
    process.on("SIGINT", () => process.exit(0));
    for (;;) {
      try {
        const snapshot = await openPackage(packagePath);
        if (`revision:${snapshot.revision}` !== previous) {
          previous = `revision:${snapshot.revision}`;
          events += 1;
          emit({
            event: "revision",
            packageId: snapshot.manifest.packageId,
            revision: snapshot.revision,
          });
          if (maxEvents !== undefined && events >= maxEvents) return;
        }
      } catch (error) {
        const invalid = {
          code: error instanceof SmallPenError ? error.code : "internal_error",
          event: "invalid",
          message: error instanceof Error ? error.message : String(error),
        };
        if (`invalid:${invalid.code}:${invalid.message}` !== previous) {
          previous = `invalid:${invalid.code}:${invalid.message}`;
          events += 1;
          emit(invalid);
          if (maxEvents !== undefined && events >= maxEvents) return;
        }
      }
      await delay(interval);
    }
  }
  if (command === "repair") {
    printJson(await repairCommand(packagePath, args));
  }
}

function errorDetails(error, args) {
  let details = error instanceof SmallPenError ? error.details : {};
  const parameters = Object.hasOwn(COMMAND_CONTRACTS, args[0])
    ? commandContract(args[0]).parameters
    : {};
  const parameterField = details.field ?? details.path;
  if (Object.hasOwn(parameters, parameterField)) {
    const parameter = parameters[parameterField];
    const position = args.indexOf(parameter.option);
    const value = position === -1 ? undefined : args[position + 1];
    details = {
      expected: parameterExpectation(parameter),
      expectedType: parameter.type,
      received: value === undefined || value.startsWith("--") ? null : value,
      field: parameterField,
      path: parameter.option,
      nextOperations: [
        {
          argv: ["schema", "command", args[0], "--json"],
          operation: "smallpen.schema",
        },
      ],
      ...details,
    };
  }
  if (details.schemaCommand && !details.nextOperations) {
    details = {
      ...details,
      nextOperations: [
        {
          argv: [...details.schemaCommand.split(" ").slice(1), "--json"],
          operation: "smallpen.schema",
        },
      ],
    };
  }
  if (!flag(args, "--full") && details.allowedFields?.length > 20) {
    const preferred = details.suggestion?.split(".")[0];
    details = {
      ...details,
      allowedFieldCount: details.allowedFields.length,
      allowedFields: [
        ...new Set([
          ...(preferred ? [preferred] : []),
          ...details.allowedFields,
        ]),
      ].slice(0, 5),
      allowedFieldsTruncated: true,
    };
  }
  if (error?.code === "unknown_option" && typeof details.command === "string") {
    return {
      ...details,
      nextOperations: [
        ...(details.nextOperations ?? []),
        { argv: [details.command, "--help"], operation: "smallpen.help" },
      ],
      recovery:
        "Read this command's parameter schema and correct the option before retrying. No operation was applied.",
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
          ? [
              {
                argv: [
                  "list",
                  resolve(args[1]),
                  "--kind",
                  "components",
                  "--json",
                ],
                operation: "smallpen.list",
              },
            ]
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
    [
      "invalid_initialization_answer_json",
      "invalid_initialization_answer",
    ].includes(error?.code) &&
    typeof details.questionId === "string"
  ) {
    const retry = [...args];
    retry[1] = resolve(retry[1]);
    const stateIndex = retry.indexOf("--state");
    if (stateIndex !== -1)
      retry[stateIndex + 1] = resolve(retry[stateIndex + 1]);
    let replaced = false;
    for (let index = 2; index < retry.length; index += 1) {
      if (
        retry[index] === "--answer" &&
        retry[index + 1]?.startsWith(`${details.questionId}=`)
      ) {
        retry[index + 1] = `${details.questionId}=<JSON>`;
        replaced = true;
      }
    }
    if (!replaced) retry.push("--answer", `${details.questionId}=<JSON>`);
    if (!retry.includes("--json")) retry.push("--json");
    if (!retry.includes("--locale")) retry.push("--locale", defaultLocale());
    return {
      ...details,
      nextOperations: [{ argv: retry, operation: "smallpen.init.answer" }],
      recovery:
        "Replace <JSON> with a valid JSON answer and execute the retry argv.",
    };
  }
  if (error?.code === "stale_revision") {
    const locator =
      typeof args[1] === "string" ? resolve(args[1]) : "<package>";
    const commands = [
      {
        argv: ["view", locator, "--json"],
        explanation:
          "Read the current revision, then look at the affected targets by name to check concurrent changes before rebuilding the intent.",
      },
      {
        argv: ["apply", locator, "--batch", "<rebuilt-intent.json>", "--json"],
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
      ...(remainingIntent
        ? {
            remainingIntentCount: remainingIntent.length,
            ...(flag(args, "--full") ? { remainingIntent } : {}),
          }
        : {}),
      commands,
      nextOperations: Array.isArray(details.nextOperations)
        ? details.nextOperations.map((operation, index) => {
            const step = {
              ...operation,
              ...(commands[index] ? { argv: commands[index].argv } : {}),
            };
            if (flag(args, "--full") || !operation.args?.operations)
              return step;
            const { operations: _operations, ...operationArgs } =
              operation.args;
            return { ...step, args: operationArgs };
          })
        : [
            {
              argv: commands[0].argv,
              args: { expectedRevision: details.actualRevision },
              operation: "smallpen.refresh",
            },
            {
              argv: commands[1].argv,
              args: {
                baseRevision: details.actualRevision,
                newBatchId: "<unique-id>",
              },
              operation: "smallpen.apply.replay-intent",
            },
          ],
      recovery:
        "The write was rejected atomically; nothing was applied. Read the actual revision and inspect the affected targets for concurrent changes. Rebuild the retained intent file against that revision with a new unique batchId inside the JSON (advanced apply takes no --batch-id option), then rerun advanced apply --batch. Preserve concurrent updates that are still needed.",
    };
  }
  if (error?.code === "missing_local_asset" && isRecord(details.reference)) {
    const locator =
      typeof args[1] === "string" ? resolve(args[1]) : "<package>";
    const assetId = details.reference.assetId;
    const isToken = typeof assetId === "string" && assetId.startsWith("tok_");
    const commands = [
      {
        argv: details.tokenPath
          ? ["token", "impact", locator, "--path", details.tokenPath, "--json"]
          : ["view", locator, "--as", "issues", "--json"],
        explanation: details.tokenPath ? "List every element that still binds this token, by name." : "Find the elements that still use it.",
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
          operation: details.tokenPath ? "smallpen.token.impact" : "smallpen.view",
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
          argv: ["schema", "commands", "--json"],
          operation: "smallpen.schema",
        },
      ],
    };
  }
  return details;
}

// A write that removes a Token still bound fails naming only its id; the
// recovery names it, so token impact --path can list where it is used.
async function nameMissingToken(error, args) {
  const assetId = error?.details?.reference?.assetId;
  if (error?.code !== "missing_local_asset" || typeof assetId !== "string" || typeof args?.[1] !== "string") return;
  try {
    const before = await openPackage(args[1]);
    const token = before.domain.tokens.get(assetId);
    if (token) error.details = { ...error.details, tokenPath: token.path };
  } catch {
    // The package cannot be read: keep the id.
  }
}

const cliArgs = process.argv.slice(2);
let executionArgs = cliArgs;
let publicSurface = false;
main(cliArgs)
  .catch(async (error) => {
    await nameMissingToken(error, executionArgs);
    printJson({
      error: {
        code: error instanceof SmallPenError ? error.code : "internal_error",
        details: errorDetails(error, executionArgs),
        writeState,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  })
  .finally(releaseArtifacts);
