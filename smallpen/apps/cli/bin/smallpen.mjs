#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";

import {
  tokenOptionValues,
  buildDesignSystemPage,
  canonicalJSON,
  createSemanticTree,
  projectComponentVariant,
  projectScreen,
  designChanges,
  designChangesText,
  findComponent,
  canvasLayout,
  duplicateNameIssues,
  elementPath,
  findElement,
  findPage,
  findPresentation,
  findVariant,
  createWorkspaceRuntime,
  designSystemPageOptions,
  expandDesignSystemPage,
  locatedFamilySource,
  defaultTokenWorkspace,
  listEffectiveTokens,
  variantLabel,
  listTokenDefinitions,
  tokenCssDeclaration,
  tokenUseCounts,
  listTokenThemes,
  packageFormatWarnings,
  selectTokenThemes,
  SmallPenError,
  SMALLPEN_FORMAT_CAPABILITIES,
  staleInstanceDiagnostics,
  checkPackageFiles,
  formatIssues,
  tokenTypeOfName,
} from "@smallpen/core";
import {
  BATCH_HISTORY_LIMITS,
  initializeBlankWorkspace,
  openRevisionSnapshot,
  readPackageFiles,
  rememberPackageFiles,
  readAccepted,
  writeAccepted,
  acceptPackageFiles,
  gateFiles,
  changedPaths,
  revertFiles,
  withPackageWriteLock,
  inspectMedia as inspectMediaBytes,
  inspectMedia,
  exportHtmlReview,
  openPackage,
  readBatchHistory,
  resolveWorkspace,
} from "@smallpen/local-package";

import { COMMAND_NAMES, commandGuidance, helpWithInput, printHelp } from "./help.mjs";
import {
  COMMAND_CONTRACTS,
  commandContract,
  numericDefault,
  parameterExpectation,
  validateCommandArguments,
} from "./command-contract.mjs";
import { schemaTopic } from "./schema.mjs";
import { renderHtmlReviewPage } from "./html-render.mjs";
import { printBriefHelp } from "./help-topics.mjs";
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
  variantDifferences,
  platformHints,
  localWireframe,
  resolveDesignLayout,
  outlineTree,
  selectedDesign,
  themeSettings,
  validateDesign,
} from "./design-output.mjs";
import { inspectionCoverage, inspectionReport, inspectionText } from "./inspection-output.mjs";
import {
  pageItems,
  viewSummary,
} from "./read-output.mjs";

import { runValidationJobs } from "./validation-runner.mjs";

let writeState = "not-applied";
// Refusals that come before anything is written.
const REFUSED_BEFORE_WRITING = new Set(["workspace_already_exists", "invalid_workspace_path", "invalid_package_path", "package_already_exists", "invalid_init_layout"]);
async function trackedWrite(action) {
  writeState = "unknown";
  try {
    const result = await action();
    writeState = "committed";
    return result;
  } catch (error) {
    if (REFUSED_BEFORE_WRITING.has(error?.code)) writeState = "not-applied";
    throw error;
  }
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

// Locale-independent order for JSON output: localeCompare follows the host
// LANG (Danish sorts "aa" after "ab"), which would reorder lists and pages.
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
    ["schema", "help", "version", "--help", "-h", "--version"].includes(args[0]) ||
    args.includes("--help")
  );
}

// A write by name answers what changed, what to look at and how to undo;
// hashes, counts and each advised value stay in --full.
function compactWriteReceipt(value) {
  if (!value || typeof value !== "object" || typeof value.batchId !== "string" || value.error) return value;
  const out = { ...value };
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
  if (!keepsIds(args)) value = compactWriteReceipt(withoutIds(value));
  const measuredOutput = ["help", "view", "export", "check"].includes(args[0]);
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
      "history",
      "historyWindow",
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
      "specPath",
      "wireframePath",
      "layout",
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
    // The readable part (outline, spec or wireframe) also as plain text,
    // so it can be searched without parsing the JSON.
    const text = value.text ?? value.outline ?? value.wireframe;
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
      // Callers that always want one path can ask for the whole reply.
      inline: "--stdout prints the whole result instead",
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
      "specPath",
      "wireframePath",
      "layout",
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
  return resolveWorkspace(packagePath);
}

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
    // A package is one directory: its revision is the revision; the
    // product/foundation pair only shows with a foundation.
    ...(foundation ? { productRevision: product.revision } : {}),
    revision: product.revision,
  };
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

async function initializeCommand(workspacePath, args) {
  const layout = option(args, "--layout") ?? "single";
  // A blank package has no pages yet: the agent writes the first page file.
  const initialized = await trackedWrite(() =>
    initializeBlankWorkspace(workspacePath, {
      layout,
      name: option(args, "--name"),
      page: false,
    }),
  );
  const paths = [initialized.packagePath, initialized.foundationPath, initialized.productPath].filter(Boolean);
  // A new package is the first accepted version: an agent's first broken
  // edit can be reverted.
  for (const path of paths) await acceptPackageFiles(path);
  const opened = await Promise.all(paths.map((path) => openPackage(path)));
  const summary = (snapshot) => ({ name: snapshot.manifest.name, path: snapshot.locator, revision: snapshot.revision });
  return {
    ...initialized,
    packages: initialized.packagePath
      ? { package: summary(opened[0]) }
      : { foundation: summary(opened[0]), product: summary(opened[1]) },
    next: "Write Tokens in tokens.css, components in components/, pages in pages/, then run smallpen check (smallpen help rules format)",
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
    if (diagnostic.code === "font_render_fallback" && !Array.isArray(diagnostic.nodeIds)) {
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
    transparentComponents: part?.only !== "tokens",
    ...(part
      ? {
          only: part.only,
          minWidth: part.only === "tokens" ? 1400 : 0,
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

async function htmlExportCommand(packagePath, args) {
  const unsupported = ["--component", "--variant", "--element", "--design-system", "--base64", "--evidence", "--locale"]
    .filter(name => args.includes(name));
  if (unsupported.length)
    throw new SmallPenError("unsupported_html_export_option", "HTML exports whole page versions; remove incompatible selectors/output flags", { options: unsupported });
  const workspace = await tokenWorkspace(packagePath, args);
  const scale = numberOption(args, "--scale") ?? 1;
  return exportHtmlReview(workspace, {
    output: option(args, "--output"), page: option(args, "--page"),
    canvas: option(args, "--canvas"), platform: option(args, "--platform"), scale,
    progress: terminalProgress("exporting"),
  }, async target => {
    const design = selectedDesign(workspace, {
      screenId: target.screenId, presentationId: target.presentationId,
      ...(options(args, "--context").length ? { context: contextSelection(args) } : {}),
    });
    return renderHtmlReviewPage(workspace, design, {
      scale, stored: storedNodesOf(workspace, design.selection),
    });
  });
}

async function designCommand(packagePath, args, override, suppliedWorkspace) {
  const workspace = suppliedWorkspace ?? await tokenWorkspace(packagePath, args);
  let design = override ?? (await designForCommand(workspace, args));
  const format =
    option(args, "--format") ?? (args[0] === "view" ? "outline" : "wireframe");
  // The outline reads sizes from the same native layout as spec and PNG,
  // not from the file's estimate.
  if (["spec", "wireframe", "png", "outline"].includes(format))
    design = await resolveDesignLayout(workspace, design, {
      raster: format === "png", scale: numberOption(args, "--scale"),
      forExport: flag(args, "--evidence"),
    });
  let report;
  if (design.layoutSnapshot) {
    design.validation = await validateDesign(workspace, design);
    report = inspectionReport(workspace, design, {
      components: componentLookup(workspace), stored: storedNodesOf(workspace, design.selection),
      full: flag(args, "--full"),
    });
  }
  const receipt = {
    packageId: workspace.product.manifest.packageId,
    ...(design.projection.preview ? { preview: design.projection.preview } : {}),
    ...workspaceRevisions(
      workspace.product,
      workspace.foundation,
      workspace.libraries,
    ),
    selection: design.selection,
    // Path and resolved value say what the selection resolves to; --full
    // adds each binding's reference and source. A PNG says it in pixels,
    // and a wireframe shows structure only.
    ...((format === "png" || format === "wireframe") && !flag(args, "--full") ? {} : {
      tokenSources: flag(args, "--full")
        ? design.tokenSources
        : design.tokenSources?.map(({ path, value }) => ({ path, value })),
    }),
    diagnostics: nameDiagnostics(design.projection.diagnostics ?? [], design.projection),
    ...(report ? {
      layout: { ...report.snapshot, diagnostics: undefined, diagnosticCount: report.snapshot.diagnostics.length,
        ...(report.snapshot.libraries?.length ? {} : { libraries: undefined }) },
      coverage: flag(args, "--full") ? report.coverage : inspectionCoverage(report.coverage),
      // A spec lists its issues; a picture or wireframe leaves the count to
      // --as issues, which folds repeats the same way check --render does.
      ...(format === "spec" ? { issueCount: report.issues.length } : {}),
      ...(flag(args, "--full") ? { inspection: report } : {}),
    } : {}),
  };
  if (flag(args, "--evidence")) {
    const prefix = option(args, "--output");
    if (flag(args, "--base64") && !prefix) return {
      ...receipt, renderHash: design.render.renderHash, semanticTree: design.tree,
      specification: inspectionText(report), wireframe: localWireframe(design),
      image: { imageBase64: Buffer.from(design.render.bytes).toString("base64"),
        ...workspaceRevisions(workspace.product, workspace.foundation, workspace.libraries),
        width: design.render.width, height: design.render.height,
        mimeType: "image/png", renderHash: design.render.renderHash },
    };
    const path = (kind, extension) => prefix ? `${prefix}${kind ? `.${kind}` : ""}.${extension}` : artifactPath(kind || "render", extension);
    const imagePath = await writeAtomic(path("", "png"), design.render.bytes);
    const specPath = await writeAtomic(path("spec", "txt"), inspectionText(report));
    const wireframePath = await writeAtomic(path("wireframe", "txt"), localWireframe(design));
    const regions = [];
    const viewport = design.layoutSnapshot.viewport;
    const scale = numberOption(args, "--scale") ?? 1;
    const regionsOf = node => {
      if (node.bounds) {
        const left = Math.max(0, Math.min(design.render.width, (node.bounds.x - viewport.x) * scale));
        const top = Math.max(0, Math.min(design.render.height, (node.bounds.y - viewport.y) * scale));
        const right = Math.max(0, Math.min(design.render.width, (node.bounds.x + node.bounds.width - viewport.x) * scale));
        const bottom = Math.max(0, Math.min(design.render.height, (node.bounds.y + node.bounds.height - viewport.y) * scale));
        regions.push({ nodeId: node.id, x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
      }
      node.children.forEach(regionsOf);
    };
    regionsOf(design.tree.root);
    const evidencePath = await writeAtomic(prefix ? `${prefix}.json` : artifactPath("evidence", "json"), canonicalJSON({
      ...report, semanticTree: { ...design.tree, selection: design.selection }, renderHash: design.render.renderHash,
      ...(design.projection.preview ? { preview: design.projection.preview } : {}),
      packageId: workspace.product.manifest.packageId,
      packageHash: workspace.foundation
        ? createHash("sha256").update(`${workspace.product.revision}\0${workspace.foundation.revision}`).digest("hex")
        : workspace.product.revision,
      ...workspaceRevisions(workspace.product, workspace.foundation, workspace.libraries),
      renderer: design.layoutSnapshot.renderer, kernelHash: design.layoutSnapshot.kernelHash,
      selector: design.selection,
      snapshotId: design.layoutSnapshot.id, nodeRegions: regions,
      viewport: { width: design.render.width, height: design.render.height, scale },
    }));
    return { ...receipt, imagePath, specPath, wireframePath, evidencePath,
      renderHash: design.render.renderHash, width: design.render.width, height: design.render.height,
      ...(flag(args, "--base64") ? { imageBase64: Buffer.from(design.render.bytes).toString("base64") } : {}),
    };
  }
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
          ? inspectionText(report, { details: flag(args, "--full") || Boolean(design.selection.nodeId) })
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
          argv: ["check", packagePath, "--render", ...designArgs(args)],
          operation: "smallpen.check",
        },
      ],
    };
  }
  if (format === "png") {
    const render = design.render;
    const output = await writeAtomic(
      withExtension(option(args, "--output"), ".png") ?? artifactPath("render", "png"),
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
        design.layoutSnapshot.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code !== "layout_projection_partial" ||
            relevant.has(diagnostic.nodeId),
        ),
        design.renderProjection ?? design.projection,
      ),
    };
  }
  const text = format === "spec" ? `${inspectionText(report, { details: flag(args, "--full") || Boolean(design.selection.nodeId) })}\n`
    : `${JSON.stringify(receipt)}\n\n${format === "wireframe" ? localWireframe(design) : outline}\n`;
  const output = await writeAtomic(
    withExtension(option(args, "--output"), ".txt") ?? artifactPath(format, "txt"),
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

async function validationJobs(workspace, args) {
  if (!flag(args, "--all")) {
    const design = await designForCommand(workspace, args);
    return [{ design, selection: design.selection }];
  }
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
      ({ selector: designSelector(args),
        target: { componentId, packageId: first.selection.packageId, variantId: variant.id },
        selection: { componentId, packageId: first.selection.packageId, variantId: variant.id } }),
    );
  }
  const screen = workspace.product.manifest.entries.screens
    .map((entry) => workspace.product.entries[entry])
    .find((screen) => screen.id === screenId);
  if (!screen)
    throw new SmallPenError("missing_screen", `No Screen ${screenId}`);
  return screen.presentations.map((presentation) =>
    ({ selector: { ...designSelector(args), screenId, presentationId: presentation.id },
      selection: { screenId, presentationId: presentation.id } }),
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

// tokens.css names group with dashes (spacing-4 is under spacing).
function tokenUnder(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}-`) || path.startsWith(`${prefix}.`);
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
// The same target read another way: the file options of this read
// (--output, --stdout) do not carry over.
function lookAgain(args, as) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--as" || args[index] === "--output") {
      index += 1;
      continue;
    }
    if (args[index] !== "--json" && args[index] !== "--stdout") out.push(args[index]);
  }
  return [{ argv: [...out, "--as", as, "--json"], operation: "smallpen.view" }];
}

// Every view reads the same way: what it shows is in text, whether an
// outline, a spec or a wireframe.
function lookResult(target, result, args, as) {
  const {
    nextOperations: _next,
    outline,
    wireframe,
    format: _format,
    ...rest
  } = result;
  return {
    target,
    as,
    ...(outline !== undefined ? { text: outline } : wireframe !== undefined ? { text: wireframe } : {}),
    ...rest,
    nextOperations: lookAgain(args, as === "issues" ? "text" : "issues"),
  };
}

async function lookAt(packagePath, args, ids, target) {
  const as = option(args, "--as") ?? "text";
  const pass = lookPass(args);
  if (as === "issues") {
    if (flag(args, "--full"))
      return lookResult(target, await validateCommand(packagePath, ["validate", packagePath, ...ids, ...pass]), args, as);
    return lookIssues(packagePath, args, [
      { ids, where: target.page ?? target.component ?? "design" },
    ], target);
  }
  const argv =
    as === "png"
      ? ["export", packagePath, ...ids, "--format", "png", ...pass]
      : ["view", packagePath, ...ids, "--format", as === "wireframe" || as === "spec" ? as : "outline", ...pass];
  return lookResult(target, await designCommand(packagePath, argv), args, as);
}

// A design-system style sheet (Tokens, components, variants) as a
// wireframe or PNG.
async function sheetDesign(args, workspace, part, target) {
  let projection;
  if (part?.allVariants) {
    // Named component previews use the same owner, themes and context as
    // individual definition reads, including unused dependency components.
    const { owner, set } = findComponent(workspace.product, option(args, "--component") ?? target.component, workspace);
    const selector = designSelector(options(args, "--context").length
      ? await namedContextArgs(workspace.product.locator, args) : args);
    const classification = set.variants.some((variant) => Object.values(variant.nodes).some((node) => node.instance))
      ? "Composite" : "Primitive";
    let context;
    const componentSamples = set.variants.map((variant, variantIndex) => {
      const design = selectedDesign(workspace, selector, {
        componentId: set.id, packageId: owner.manifest.packageId, variantId: variant.id,
      });
      context ??= design.projection.context;
      return {
        componentSetId: set.id, familyName: set.name, axes: set.axes, classification,
        variantId: variant.id, variantIndex, selection: variant.selection,
        rootId: design.projection.rootId, nodes: design.projection.nodes,
        combinationIndex: 0,
      };
    });
    const refs = { componentSamples };
    const page = buildDesignSystemPage(refs, {}, {
      locale: option(args, "--locale") ?? "en", only: "components", minColumns: 1,
      transparentComponents: true,
      allVariantsOf: new Set([set.id]),
    });
    projection = { ...expandDesignSystemPage(page, refs), context };
  } else projection = await designSystemProjection(workspace, args, part);
  return {
    projection,
    tree: createSemanticTree(workspace.product, projection),
    selection: { ...target, ...themeSettings(workspace).selection, ...(projection.context ? { context: projection.context } : {}) },
  };
}

async function lookSheet(packagePath, args, workspace, part, target) {
  const as = option(args, "--as") ?? "text";
  const design = await sheetDesign(args, workspace, part, target);
  const argv =
    as === "png"
      ? ["export", packagePath, "--format", "png", ...lookPass(args)]
      : ["view", packagePath, "--format", "wireframe", ...lookPass(args)];
  const result = lookResult(target, await designCommand(packagePath, argv, design), args, as);
  const missing = design.projection.preview?.components.filter((component) => component.shownVariants < component.totalVariants) ?? [];
  const retained = ["--theme", "--context", "--locale", "--scale"].flatMap((name) =>
    options(args, name).flatMap((value) => [name, value]),
  );
  if (flag(args, "--full")) retained.push("--full");
  result.nextOperations = [...missing.map(({ component }) => ({
    operation: "smallpen.view",
    argv: ["view", packagePath, "--component", component, "--as", as, ...retained, "--json"],
  })), ...result.nextOperations];
  return result;
}

// Views keep the same check scope and receipt as validate. One workspace
// snapshot and one runner serve all targets, including compact replies.
async function lookIssues(packagePath, args, targets, target, extra = []) {
  const report = await validateCommand(
    packagePath,
    ["validate", packagePath, ...lookPass(args)],
    { targets, extraIssues: extra },
  );
  return {
    ...report,
    target,
    as: "issues",
    checked: targets.length,
    nextOperations: lookAgain(args, "text"),
  };
}

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
            (item) => item.token.path.split(/[.-]/)[0],
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

// Instances expose the descendants of their selected variants. Read their
// names in the same expanded tree that specifications and exports use.
function pageElementForRead(workspace, screen, presentation, element, rootId = presentation.rootId) {
  const projection = projectScreen(workspace.product, screen.id, {
    presentationId: presentation.id,
    foundation: workspace.foundation,
    libraries: workspace.libraries,
  });
  return findElement(projection.nodes, rootId, element, screen.name, { allowRoot: true });
}

function componentElementForRead(workspace, owner, set, variant, element) {
  const nodes = projectComponentVariant(workspace.product, variant, {
    owner: owner === workspace.product ? undefined : owner,
    foundation: workspace.foundation,
    libraries: workspace.libraries,
  });
  return findElement(nodes, variant.rootId, element, set.name, { allowRoot: true });
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
      ...(element !== undefined ? ["--node-id", pageElementForRead(workspace, screen, presentation, element)] : []),
    ];
  }
  if (component !== undefined) {
    const located = findLocatedComponent(workspace, component);
    if (located)
      return [
        "--screen-id", located.screen.id, "--presentation-id", located.presentation.id, "--node-id",
        element !== undefined ? pageElementForRead(workspace, located.screen, located.presentation, element, located.component.mainNodeId) : located.component.mainNodeId,
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
      ...(element !== undefined ? ["--node-id", componentElementForRead(workspace, owner, set, variant, element)] : []),
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
  if (as === "spec" && page === undefined && component === undefined)
    throw new SmallPenError("missing_spec_target", "Choose one --page or --component for its specification; use --as text to navigate first");
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
      ids.push("--node-id", pageElementForRead(workspace, screen, presentation, element));
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
        element !== undefined ? pageElementForRead(workspace, located.screen, located.presentation, element, located.component.mainNodeId) : located.component.mainNodeId];
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
        return lookIssues(packagePath, args, [{ ids: ["--component-id", set.id, ...owned, "--all"], where: set.name }], target);
    }
    const variant = findVariant(set, variantText);
    const label = variantLabel(set, variant);
    const ids = ["--component-id", set.id, ...owned, "--variant-id", variant.id];
    if (element !== undefined)
      ids.push("--node-id", componentElementForRead(workspace, owner, set, variant, element));
    const reply = await lookAt(packagePath, args, ids, {
      component: set.name,
      ...(variantText !== undefined || element !== undefined ? { variant: label } : { variants: set.variants.length }),
      ...(element !== undefined ? { element } : {}),
      ...limits,
    });
    // The whole component's spec: the main variant, then what each other
    // variant changes, with values and Tokens, for writing its code.
    if (as === "spec" && variantText === undefined && element === undefined && typeof reply.text === "string" && set.variants.length > 1)
      reply.text = `${reply.text}\n${variantDifferences(set, (reference) => [product, foundation, ...libraries].filter(Boolean).map((owner) => owner.domain.tokens.get(reference?.assetId)?.path).find(Boolean))}`;
    return reply;
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
      return { target, as, text, lineCount: text.split("\n").length, nextOperations: lookAgain(args, "issues") };
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
      ...screens.map((screen) => ({ ids: ["--screen-id", screen.id, "--all"], where: screen.name })),
      ...sets.map(({ owner, set }) => ({
        ids: ["--component-id", set.id, ...(owner === product ? [] : ["--package-id", owner.manifest.packageId]), "--all"],
        where: set.name,
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

// What each of the newest recorded writes changed in the design, by name:
// step back one write at a time and compare. Keyed by the write's revision.
// What each recent App or CLI write changed, by name: the files before and
// after it are remembered revisions, so edits made to the files in between
// (an agent editing HTML) do not hide what the write itself did.
async function recentDesignChanges(snapshot, history, limit) {
  const result = new Map();
  const entries = [...history].sort((left, right) => String(right.committedAt).localeCompare(String(left.committedAt))).slice(0, limit);
  for (const entry of entries) {
    try {
      const [older, newer] = await Promise.all([
        openRevisionSnapshot(snapshot, entry.baseRevision),
        entry.revision === snapshot.revision ? snapshot : openRevisionSnapshot(snapshot, entry.revision),
      ]);
      if (!older || !newer) continue;
      result.set(entry.revision, designChanges(older, newer).map((change) =>
        [change.name, change.element].filter(Boolean).join(" / ")));
    } catch {
      // An unreadable revision leaves this write's ids as its description.
    }
  }
  return result;
}

// The rendering checks (text fit, bounds, overlaps, contrast) of the
// selected pages and components, as check --render reports them. Targets are
// named the way view names them.
async function renderReport(packagePath, args, { named: publicNames = true } = {}) {
  const targets = await nameTargetArgs(packagePath, args, { every: true });
  const validateArgs = [...args, ...targets];
  // A named page or component reads like the whole-package report;
  // --full keeps every stored check.
  const named = publicNames && !flag(args, "--full") &&
    (option(args, "--page") !== undefined || option(args, "--component") !== undefined);
  const report = await validateCommand(packagePath, validateArgs, { named });
  // Sizes the preview cannot compute: one note, not one issue each.
  const limits = (report.issues ?? []).filter((issue) => issue.code === "layout_projection_partial");
  if (limits.length && !flag(args, "--full")) {
    report.issues = report.issues.filter((issue) => issue.code !== "layout_projection_partial");
    report.issueCount = (report.issueCount ?? limits.length) - limits.length;
    if (!report.issueCount) report.visualStatus = "no-issues-found";
    report.previewNote = `The local preview cannot compute some automatic sizes in ${limits.length} place${limits.length === 1 ? "" : "s"}; geometry there may differ in the App.`;
  }
  return report;
}

const CHECK_HELP = `SmallPen check
Check a package's HTML, tokens.css and rules; accept what passes, reject what fails
Usage: smallpen check <package> [--revert [--file PATH]...] [--render [--page P [--platform X]] [--component C [--variant V]] [--theme G/O]...] [--json] [--help]
Prints one line per problem: file:line:column severity code message, with the fix.
Every passing check (and every App save) is the accepted version. When files
have errors, the changed files that keep the package valid are accepted and
the files with errors are rejected (listed as "rejected PATH"). --revert puts
the rejected files back to the accepted version and removes rejected new
files; --file PATH limits that to the files you changed (several agents can
edit at once). --render then lays out and draws the pages and components and
adds text overflow, bounds, overlap and contrast problems, by element name.
A copied package has no accepted version until its first passing check.
--render checks the default theme options (or --theme); --all-themes checks
every combination of options. Errors exit with code 1; warnings and
rendering problems do not.`;

// check is also the gate for an agent's direct edits: a passing check
// accepts the files; with errors, the changed files that keep the package
// valid are accepted and the ones with errors are rejected. --revert puts the
// rejected files (or only those named by --file) back to the accepted version.
async function checkCommand(args) {
  if (flag(args, "--help")) {
    process.stdout.write(`${CHECK_HELP}\n`);
    return;
  }
  const packagePath = args[1];
  if (!packagePath || packagePath.startsWith("--")) throw new SmallPenError("missing_package", "check needs a package path", { usage: "smallpen check <package> [--revert] [--render] [--json]" });
  args = validateCommandArguments("check", args);
  let root;
  try {
    root = await realpath(resolve(packagePath));
  } catch (error) {
    throw new SmallPenError("invalid_package_path", `Unable to open Package: ${error.message}`);
  }
  const checkOptions = {
    locator: root,
    inspectMedia: (bytes) => {
      try {
        const info = inspectMediaBytes(bytes);
        return { mimeType: info.mimeType, width: info.width, height: info.height };
      } catch {
        return undefined;
      }
    },
  };
  const checkFiles = (files) => checkPackageFiles(files, checkOptions);
  let files = await readPackageFiles(root);
  let result = await checkFiles(files);
  const accepted = await readAccepted(root);
  const only = options(args, "--file").map((path) => path.replace(/^\.\//, ""));
  let gate;
  let reverted;
  if (!result.ok && accepted) {
    gate = await gateFiles(root, accepted, files, checkFiles);
    if (flag(args, "--revert")) {
      // Under the write lock, against the files as they are now.
      reverted = await withPackageWriteLock(root, async () => {
        const current = await readPackageFiles(root);
        const now = await gateFiles(root, accepted, current, checkFiles);
        const paths = now.rejected.map(({ path }) => path).filter((path) => !only.length || only.includes(path));
        return revertFiles(root, accepted, paths);
      });
      files = await readPackageFiles(root);
      result = await checkFiles(files);
      gate = await gateFiles(root, accepted, files, checkFiles);
    }
  }
  // The revision of these files, as every other command reports it, and
  // remembered so `changes --since` can start from what was checked.
  const revision = result.ok ? await rememberPackageFiles(root, files) : undefined;
  // What passes is accepted: the whole package, or the changes that keep it
  // valid when other files have errors.
  let acceptedChanges = [];
  try {
    if (result.ok) {
      acceptedChanges = accepted ? changedPaths(accepted, files) : [];
      await writeAccepted(root, files);
    } else if (gate?.accepted.length) {
      acceptedChanges = gate.accepted;
      await writeAccepted(root, gate.candidate);
    }
  } catch (error) {
    process.emitWarning(`The accepted version was not updated: ${error.message}`, { code: "SMALLPEN_ACCEPTED_VERSION_WRITE_FAILED" });
  }
  const rejected = result.ok ? [] : (gate?.rejected ?? []);
  // With rejected files, the accepted version (the good changes kept) has a
  // revision of its own: changes --since can start from it.
  const acceptedRevision = !result.ok && gate?.candidate ? await rememberPackageFiles(root, gate.candidate) : undefined;
  // --render draws what the files describe; it needs files that read.
  let render;
  if (flag(args, "--render")) {
    const pass = withoutOptions(args.slice(2), ["--render", "--json", "--revert", "--all-themes"], ["--file"]);
    if (!result.ok) render = { skipped: "The files have errors; fix them before rendering" };
    else if (!flag(args, "--all-themes")) render = await renderReport(root, ["validate", root, ...pass]);
    else {
      // Every combination of theme options, one render each; issues say
      // which combination they come from.
      const groups = themeSettings(await tokenWorkspace(root, ["check", root])).groups ?? [];
      let combos = [[]];
      for (const group of groups) combos = combos.flatMap((combo) => group.options.map((option) => [...combo, option]));
      const runs = [];
      for (const combo of combos)
        runs.push({ combo, report: await renderReport(root, ["validate", root, ...withoutOptions(pass, [], ["--theme"]), ...combo.flatMap((theme) => ["--theme", theme])]) });
      const label = (combo) => combo.join(" + ") || "defaults";
      render = {
        ...runs[0].report,
        issueCount: runs.reduce((sum, run) => sum + (run.report.issueCount ?? 0), 0),
        issues: runs.flatMap(({ combo, report }) => (report.issues ?? []).map((issue) => ({ ...issue, themes: label(combo) }))),
        page: { hasMore: runs.some(({ report }) => report.page?.hasMore), total: runs.reduce((sum, run) => sum + (run.report.page?.total ?? 0), 0), offset: 0, limit: runs[0].report.page?.limit ?? 20 },
        combinations: combos.map(label),
        coverage: { ...runs[0].report.coverage, targetCount: runs.reduce((sum, run) => sum + (run.report.coverage?.targetCount ?? 0), 0) },
      };
    }
  }
  const renderProblems = render?.issueCount ?? 0;
  // Rendering problems are reported for the agent to look at; only file
  // and rule errors fail the check.
  const ok = result.ok;
  const revertArgv = ["check", root, "--revert"];
  const gateReply = {
    ...(acceptedChanges.length ? { accepted: acceptedChanges } : {}),
    ...(rejected.length
      ? {
          rejected: rejected.map(({ path, change, issues }) => ({
            path,
            change,
            errors: issues.length,
            issues: issues.map(({ causedBy: _causedBy, details: _details, ...issue }) => issue),
            ...(issues.some((issue) => issue.causedBy) ? { breaks: [...new Set(issues.map((issue) => issue.file).filter(Boolean))] } : {}),
          })),
          revert: {
            argv: revertArgv,
            note: "Puts the rejected files back to the last accepted version; add --file PATH to revert only the files you changed.",
          },
        }
      : {}),
    ...(reverted?.length ? { reverted } : {}),
    ...(!result.ok && !accepted ? { note: "No accepted version yet: nothing to revert to. Fix the errors; the first passing check is accepted." } : {}),
  };
  if (flag(args, "--json")) {
    printJson({
      ok,
      errors: result.errors,
      warnings: result.warnings,
      // With rejected files, the counts are of the accepted version, as the
      // text says.
      summary: rejected.length && gate?.summary ? gate.summary : result.summary,
      ...(revision ? { revision } : {}),
      ...(acceptedRevision ? { acceptedRevision } : {}),
      issues: result.issues,
      ...(Object.keys(gateReply).length ? { gate: { ...gateReply, ...(rejected.length && gate?.summary ? { acceptedSummary: gate.summary } : {}) } } : {}),
      ...(render
        ? {
            render: render.skipped
              ? render
              : Object.fromEntries(Object.entries(render).filter(([key]) => !["revision", "productRevision", "outputBytes"].includes(key))),
          }
        : {}),
    });
  } else {
    const issueKey = (issue) => `${issue.file}\0${issue.line}\0${issue.column}\0${issue.code}\0${issue.message}`;
    // An error that another file's change causes says so on its own line,
    // without a "did you mean" that would send the fix to the wrong file.
    const causes = new Map();
    for (const entry of rejected)
      for (const issue of entry.issues)
        if (issue.causedBy && issue.file !== issue.causedBy) causes.set(issueKey(issue), entry);
    const shown = result.issues.map((issue) => {
      const cause = causes.get(issueKey(issue));
      if (!cause) return issue;
      const message = issue.message.replace(/; (did you mean|Tokens like it|parts:).*$/, "");
      return { ...issue, message: `${message} ← caused by the change to ${cause.path} (${cause.change}), which this check rejected; check --revert puts it back` };
    });
    const lines = shown.length ? `${formatIssues(shown)}\n` : "";
    const shownIssues = new Set(result.issues.map(issueKey));
    const gateLines = [
      ...(reverted ?? []).map(({ path, action }) => `reverted ${path} (${action === "removed" ? "removed: it was new" : "restored the accepted version"})`),
      ...rejected.flatMap(({ path, change, issues }) => {
        const elsewhere = issues.some((issue) => issue.causedBy)
          ? ` in ${[...new Set(issues.map((issue) => issue.file).filter(Boolean))].join(", ")}`
          : "";
        // Errors that show only once the other rejected files go back
        // (a page using a Token from a rejected tokens.css) are listed here.
        const unseen = issues.filter((issue) => !shownIssues.has(issueKey(issue)));
        // A component file whose component got another name: say so, since
        // the copies still use the old one.
        const names = (text) => [...String(text ?? "").matchAll(/<sp-component\s[^>]*name="([^"]+)"/g)].map((match) => match[1]);
        const before = path.startsWith("components/") && accepted ? names(accepted.text.get(path)) : [];
        const after = path.startsWith("components/") ? names(files.get(path)) : [];
        const gone = before.filter((name) => !after.includes(name));
        const came = after.filter((name) => !before.includes(name));
        const elsewhereNamed = (name) => [...files.keys()].find((other) => other !== path && other.startsWith("components/") && names(files.get(other)).includes(name));
        const taken = came.length === 1 ? elsewhereNamed(came[0]) : undefined;
        const renamed = gone.length === 1 && came.length === 1
          ? taken
            ? `; it renames ${gone[0]} to ${came[0]}, which ${taken} already defines: pick another name`
            : `; it renames ${gone[0]} to ${came[0]}: write component="${came[0]}" in the copies, or keep the name`
          : gone.length && change !== "deleted" ? `; it no longer defines ${gone.join(", ")}, which copies still use` : "";
        return [
          `rejected ${path} (${change}): causes ${issues.length} error${issues.length === 1 ? "" : "s"}${elsewhere}${renamed}${unseen.length ? ", with the other rejected files put back:" : ""}`,
          ...(unseen.length ? formatIssues(unseen).split("\n").map((line) => `  ${line}`) : []),
        ];
      }),
      ...acceptedChanges.map((path) => `accepted ${path}${files.has(path) ? accepted?.text.has(path) || accepted?.assets.has(path) ? "" : " (added)" : " (deleted)"}`),
      ...(rejected.length ? [`Run smallpen check ${root} --revert to put the rejected files back to the last accepted version (--file PATH reverts only that file).`] : []),
      ...(gateReply.note ? [gateReply.note] : []),
    ].join("\n");
    // Each line names the page version or variant, then the element.
    const renderLines = [
      ...(render?.issues ?? []).map((issue) => {
        const place = [issue.themes ? `[${issue.themes}] ${issue.target ?? ""}`.trim() : issue.target, issue.where].filter(Boolean).join(": ");
        const examples = issue.examples?.length ? ` For example ${issue.examples.join("; ")}.` : "";
        // Repeats folded into this line, by name.
        const also = issue.alsoAt?.length ? ` Also at: ${issue.alsoAt.join("; ")}.` : "";
        return `render ${place ? `${place} ` : ""}${issue.code} ${issue.message ?? ""}${examples}${also}`.replace(/\s+/g, " ").trim();
      }),
      ...(render?.page?.hasMore
        ? [`${render.issues.length} of ${render.page.total} rendering problems shown; next: smallpen check ${root} --render --offset ${render.page.offset + render.page.limit}${render.page.limit < 100 ? " --limit 100" : ""}`]
        : []),
    ].join("\n");
    const counts = `${result.errors} error${result.errors === 1 ? "" : "s"}, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}`;
    // Which theme options the render used: the defaults unless --theme or
    // --all-themes says otherwise.
    const checkedUnder = render?.combinations
      ? ` under ${render.combinations.length} theme combination${render.combinations.length === 1 ? "" : "s"}`
      : render?.selection?.themes?.length ? ` under ${render.selection.themes.join(" + ")}${flag(args, "--theme") ? "" : " (defaults; --all-themes checks every combination)"}` : "";
    const renderCount = render && !render.skipped ? `, ${renderProblems} rendering problem${renderProblems === 1 ? "" : "s"}${checkedUnder}` : "";
    // With rejected files, the counts are of what was accepted.
    const counted = rejected.length && gate?.summary ? gate.summary : result.summary;
    const scope = `${rejected.length && gate?.summary ? "accepted version: " : ""}${counted.pages} pages (${counted.pageVersions} versions), ${counted.components} components (${counted.variants} variants), ${counted.tokens} Tokens${counted.unusedTokens ? ` (${counted.unusedTokens} not used by any page or component; token list --unused names them)` : ""}`;
    // The revision changes --since starts from.
    const revisionLine = revision ? `revision ${revision}\n` : acceptedRevision ? `accepted revision ${acceptedRevision}\n` : "";
    process.stdout.write(`${lines}${gateLines ? `${gateLines}\n` : ""}${renderLines ? `${renderLines}\n` : ""}${render?.skipped ? `render skipped: ${render.skipped}\n` : ""}${ok ? "ok" : "failed"}: ${counts}${renderCount}; ${scope}\n${revisionLine}`);
  }
  if (!ok) process.exitCode = 1;
}

// args without some flags and some options with their values.
// --output without an extension gets the file's own, as --evidence's
// prefix does: shots/home -> shots/home.png.
function withExtension(path, extension) {
  if (path === undefined) return undefined;
  return /\.[A-Za-z0-9]+$/.test(basename(path)) ? path : `${path}${extension}`;
}

function withoutOptions(args, flags, valued) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (flags.includes(args[index])) continue;
    if (valued.includes(args[index])) {
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  return out;
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
    historyWindow: packages.map((snapshot, index) => ({
      packageId: snapshot.manifest.packageId,
      ...BATCH_HISTORY_LIMITS,
      retainedBatches: histories[index].length,
      incompleteBatches: histories[index].filter((entry) => entry.history?.status === "partial").length,
      oldestRevision: histories[index][0]?.baseRevision,
      newestRevision: histories[index].at(-1)?.revision,
    })),
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
  // Every revision a read or write reported is remembered with its files;
  // compare that state with the current one, however the files changed.
  const productThen = await openRevisionSnapshot(product, since);
  if (!productThen)
    throw new SmallPenError(
      "unknown_revision",
      "This revision is not in the local history; read the current design with view instead",
      {
        historyWindow: revisions.historyWindow,
        nextOperations: [
          { argv: ["view", packagePath, "--as", "text", "--json"], operation: "smallpen.view" },
        ],
      },
    );
  const changes = designChanges(productThen, product);
  const edits = histories[0].filter((entry) => entry.baseRevision === since || entry.revision !== since);
  const by = {};
  for (const edit of edits) by[edit.source] = (by[edit.source] ?? 0) + 1;
  const rebuilt = [{ complete: true }];
  const firstPage = changes.find((change) => change.kind === "page" && change.change !== "removed");
  const firstComponent = changes.find((change) => change.kind === "component" && change.change !== "removed");
  return {
    ...revisions,
    since,
    // How many of these changes people saved in the App (the rest are file
    // edits).
    ...(by.app ? { appSaves: by.app } : {}),
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
// Nested JSON groups tokens.css names by their type prefix
// (color-on-brand -> color: { "on-brand": ... }); other names nest by dots.
function nestTokens(items) {
  const root = {};
  for (const { token, value } of items) {
    const typed = tokenTypeOfName(token.path);
    const parts = typed ? [typed.prefix.slice(0, -1), typed.rest] : token.path.split(".");
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
    let text;
    if (format === "css") {
      // As tokens.css defines them under these options: :root's value, then
      // each selected option's; an alias stays var(--name).
      const selected = new Set(themeSettings(workspace).selection.themes);
      const written = new Map();
      for (const definition of listTokenDefinitions(workspace.product))
        if (!definition.group || selected.has(`${definition.group}/${definition.option}`))
          written.set(definition.token.name, definition.token);
      const kept = new Set(items.map((item) => item.token.path));
      const lines = [...written.values()].filter((token) => kept.has(token.name)).map((token) => tokenCssDeclaration(token.name, token.type, token.value));
      text = `:root {\n${lines.join("\n")}\n}\n`;
    } else text = `${JSON.stringify(format === "flat" ? Object.fromEntries(items.map((item) => [item.token.path, item.value])) : nestTokens(items), null, 2)}\n`;
    const file = join(directory, `${version.name.replace(/[^\w.-]+/g, "-")}.${format === "css" ? "css" : "json"}`);
    await writeFile(file, text);
    files.push({ ...(version.themes[0] ? { option: version.themes[0] } : {}), file, tokens: items.length });
  }
  return {
    format,
    ...(by !== undefined ? { by } : {}),
    // The other groups' options every file was resolved under; --by's
    // group has one file per option.
    themes: themeSettings(base).selection.themes.filter((theme) => by === undefined || theme.split("/")[0].toLowerCase() !== by.toLowerCase()),
    directory,
    files,
    revision: base.product.revision,
  };
}

// What a design selection is, by name: page and platform, or component and
// variant, so a reply without IDs still says what was checked.
function selectionNames({ product, foundation, libraries = [] }, selection = {}) {
  if (selection.screenId) {
    const entry = product.manifest.entries.screens.find((item) => product.entries[item]?.id === selection.screenId);
    const screen = entry && product.entries[entry];
    const presentation = screen?.presentations.find(({ id }) => id === selection.presentationId);
    const nodes = selection.nodeId && presentation
      ? projectScreen(product, screen.id, { foundation, libraries, presentationId: presentation.id, context: selection.context }).nodes
      : undefined;
    return screen ? { page: screen.name, ...(presentation ? { platform: presentation.platform ?? presentation.name } : {}),
      ...(nodes ? { element: elementPath(nodes, presentation.rootId, selection.nodeId) || nodes[selection.nodeId]?.name } : {}) } : {};
  }
  if (selection.componentId) {
    for (const owner of [product, foundation, ...libraries].filter(Boolean)) {
      const set = owner.domain.componentSets.get(selection.componentId);
      if (!set) continue;
      const variant = set.variants.find(({ id }) => id === selection.variantId);
      const nodes = selection.nodeId && variant
        ? projectComponentVariant(product, variant, { owner, foundation, libraries, context: selection.context })
        : undefined;
      return { component: set.name, ...(variant ? { variant: variantLabel(set, variant) } : {}),
        ...(nodes ? { element: elementPath(nodes, variant.rootId, selection.nodeId) || nodes[selection.nodeId]?.name } : {}) };
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
async function validateWholePackage(packagePath, args, workspace, resolution, only, extraIssues = []) {
  const { product } = workspace;
  const pass = lookPass(args).filter((item) => item !== "--full");
  const targets = only ?? [
    ...product.manifest.entries.screens.map((entry) => product.entries[entry])
      .map((screen) => ({ ids: ["--screen-id", screen.id, "--all"], where: screen.name })),
    ...[...product.domain.componentSets.values()]
      .map((set) => ({ ids: ["--component-id", set.id, "--all"], where: set.name })),
  ];
  const targetLabel = (selection = {}) => validationLabel(workspace, selection);
  const issues = [], checked = [], skipped = [], hints = [];
  let unreadable = 0;
  const jobs = [];
  for (const target of targets) {
    try {
      jobs.push(...await validationJobs(workspace, ["validate", packagePath, ...target.ids, ...pass]));
    } catch (error) {
      unreadable += 1;
      issues.push({ target: target.where, code: error.code ?? "unreadable_target", severity: "error", check: "read", message: error.message });
    }
  }
  const outcome = await runChecks(workspace, jobs, args);
  for (const result of outcome.results) {
    const report = validationResult(result);
    for (const issue of report.issues ?? []) {
      const { target: _target, ...rest } = issue;
      issues.push({ target: validationLabel(workspace, report.selection), ...rest });
    }
    if (result.report) checked.push(report.selection);
    skipped.push(...(report.coverage?.skipped ?? []).map(skip => ({ ...skip, target: report.selection, label: validationLabel(workspace, report.selection) })));
    for (const hint of report.hints ?? [])
      if (!hints.some(other => JSON.stringify(other) === JSON.stringify(hint))) hints.push(hint);
  }
  // Layout limits belong to the tool, with full diagnostics kept separately
  // from design issues and every skipped layout check counted in coverage.
  const limits = issues.filter((issue) => issue.code === "layout_projection_partial");
  const notChecked = skipped.filter((skip) => skip.check !== "visual-intent");
  const full = flag(args, "--full");
  const found = [...extraIssues, ...(only ? [] : packageNameIssues(workspace)), ...issues.filter((issue) => issue.code !== "layout_projection_partial")];
  const design = full ? found : foldFontFallbacks(found).map(publicIssue);
  const page = pageItems(design, pagination(args));
  return {
    packageId: product.manifest.packageId,
    ...workspaceRevisions(product, workspace.foundation, workspace.libraries),
    status: outcome.interrupted ? "interrupted" : outcome.results.some(result => result.error) ? "partial" : unreadable ? "invalid" : "valid",
    dataStatus: unreadable ? "invalid" : "valid",
    visualStatus: design.length ? "issues" : outcome.interrupted ? "partial" : "no-issues-found",
    issueCount: design.length,
    issues: full ? design : page.items,
    ...(full ? {} : { page: page.page }),
    ...(limits.length
      ? { previewNote: `The local preview cannot compute some automatic sizes in ${limits.length} place${limits.length === 1 ? "" : "s"}; geometry there may differ in the App.` }
      : {}),
    ...(full && limits.length ? { diagnostics: limits } : {}),
    // The theme options every target was checked under.
    selection: { themes: themeSettings(workspace).selection.themes },
    coverage: {
      // Every target drawn and every check run on it.
      complete: unreadable === 0 && notChecked.length === 0 && !outcome.interrupted,
      ...executionCoverage(outcome),
      targetCount: checked.length,
      // By name, short: "Home (desktop)", "Button (Style=primary)".
      // Pages by version; components as one line each unless --full.
      targets: full ? checked.map(targetLabel) : Object.entries(checked.reduce((groups, selection) => {
        const named = selectionNames(workspace, selection);
        const key = named.component && !named.element ? `component:${named.component}` : targetLabel(selection);
        (groups[key] ??= []).push(selection);
        return groups;
      }, {})).map(([key, list]) => key.startsWith("component:") && list.length > 1
        ? `${key.slice(10)} (${list.length} variants)` : targetLabel(list[0])),
      skippedCount: notChecked.length,
      // One line per kind of check the tool could not run, with where.
      skipped: Object.values(notChecked.reduce((groups, skip) => {
        const code = skip.code ?? skip.check ?? "skipped";
        const group = (groups[code] ??= { code, check: skip.check, count: 0, reason: skip.reason ?? skip.message, where: [], ...(full ? { details: [] } : {}) });
        group.count += 1;
        if (full) {
          const { label, target: _target, ...detail } = skip;
          group.details.push({ target: label, ...detail });
        }
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

// A missing font or weight is one problem, not one per text: every text
// that asks for it is drawn and measured with what the App has instead.
function foldFontFallbacks(issues) {
  const fonts = new Map();
  const weights = new Map();
  const rest = [];
  for (const issue of issues) {
    if (issue.code === "font_weight_substituted") {
      const key = `${issue.family}\0${issue.requestedWeight}\0${issue.drawnWeight}`;
      const group = weights.get(key) ?? { issue, texts: 0, targets: new Set(), examples: [] };
      group.texts += 1;
      group.targets.add(issue.target);
      const example = [issue.target, issue.where].filter(Boolean).join(": ");
      if (group.examples.length < 3 && !group.examples.includes(example)) group.examples.push(example);
      weights.set(key, group);
      continue;
    }
    if (issue.code !== "font_render_fallback") {
      rest.push(issue);
      continue;
    }
    const font = issue.requestedFont ?? issue.details?.requestedFont ?? "A font";
    const group = fonts.get(font) ?? { texts: 0, targets: new Set(), examples: [], available: issue.availableFonts ?? ["Source Sans Pro (bundled)"] };
    group.texts += 1;
    group.targets.add(issue.target);
    const example = [issue.target, issue.where].filter(Boolean).join(": ");
    if (group.examples.length < 3 && !group.examples.includes(example)) group.examples.push(example);
    fonts.set(font, group);
  }
  const folded = [...fonts].map(([font, group]) => ({
    code: "font_render_fallback",
    severity: "warning",
    requestedFont: font,
    texts: group.texts,
    targets: group.targets.size,
    examples: group.examples,
    message: `${font} is not available, so ${group.texts} text${group.texts === 1 ? "" : "s"} in ${group.targets.size} page version${group.targets.size === 1 ? "" : "s"} and variant${group.targets.size === 1 ? "" : "s"} are drawn and measured with Source Sans Pro (text fit is checked with it). Put a ${font} TTF, OTF or WOFF file in assets/fonts/ and declare it with @font-face in tokens.css, or use an available font: ${group.available.join(", ")}.`,
    nextOperations: [{ operation: "smallpen.help", argv: ["help", "rules", "format"] }],
  }));
  const weightIssues = [...weights.values()].map(({ issue, texts, targets, examples }) => ({
    code: "font_weight_substituted",
    severity: "warning",
    family: issue.family,
    requestedWeight: issue.requestedWeight,
    drawnWeight: issue.drawnWeight,
    texts,
    targets: targets.size,
    examples,
    message: `${issue.family} has no ${issue.requestedWeight} weight, so ${texts} text${texts === 1 ? " is" : "s are"} drawn at ${issue.drawnWeight}; use a weight the font has, or add the ${issue.requestedWeight} file in assets/fonts/ with @font-face.`,
  }));
  return [...folded, ...weightIssues, ...rest];
}

// Issues read by name: element ids stay inside the tool.
function publicIssue(issue) {
  const { path: _path, nodeId: _nodeId, nodeIds: _nodeIds, ...rest } = issue;
  return rest;
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

// --token: one Token by name, or every Token under a name ("color").
// A Token by name, or every Token under a name: --token radius matches
// radius-base as tokens.css names it (--radius-base).
function tokenNamed(path, wanted) {
  if (wanted === undefined) return true;
  const name = String(wanted).trim().replace(/^\{|\}$/g, "").replace(/^var\(--|\)$/g, "").replace(/^--/, "");
  return tokenUnder(String(path), name);
}

// Progress for a person at a terminal: one line rewritten in place. An
// agent reading the output gets the result only.
function terminalProgress(verb) {
  if (!process.stderr.isTTY) return () => {};
  return (event) => {
    if ((event.event === "target" || event.event === "page") && event.target)
      process.stderr.write(`\r\x1b[2K${verb} ${event.completed + 1}/${event.total} ${event.target}`);
    else if (event.event === "finished") process.stderr.write("\r\x1b[2K");
  };
}

function validationLabel(workspace, selection) {
  const named = selectionNames(workspace, selection);
  const parts = [named.page ?? named.component, named.platform ?? named.variant].filter(Boolean);
  const label = parts.length > 1 ? `${parts[0]} (${parts[1]})` : parts[0] ?? "design";
  return named.element ? `${label} / ${named.element}` : label;
}

async function runChecks(workspace, jobs, args) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const outcome = await runValidationJobs(workspace, jobs.map(job => ({
      ...job, label: validationLabel(workspace, job.selection),
    })), {
      timeoutMs: Number(option(args, "--target-timeout") ?? 30_000),
      signal: controller.signal,
      progress: terminalProgress("checking"),
    });
    if (outcome.interrupted) process.exitCode = 130;
    return outcome;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

function executionCoverage(outcome) {
  return {
    totalTargetCount: outcome.total,
    completedTargetCount: outcome.results.length,
    failedTargetCount: outcome.results.filter(result => result.error).length,
    remainingCount: outcome.remaining.length,
    remaining: outcome.remaining,
    interrupted: outcome.interrupted,
  };
}

function validationResult({ job, report, error }) {
  return report ?? {
    selection: job.selection,
    issues: [{ ...error, severity: "error", check: "execution" }],
    coverage: { complete: false, nodeCount: 0, visibleNodeCount: 0, checks: [],
      skipped: [{ check: "native-layout", reason: error.message, code: error.code, target: job.selection }] },
  };
}

// Every check of the selected targets, untruncated.
async function validateTargets(workspace, args) {
  const outcome = await runChecks(workspace, await validationJobs(workspace, args), args);
  const reports = outcome.results.map(validationResult);
  const empty = { issues: [], coverage: { complete: false, checks: [], skipped: [], nodeCount: 0, visibleNodeCount: 0 } };
  const all = flag(args, "--all");
  const visual = {
    ...(reports[0] ?? empty),
    ...(outcome.interrupted ? { status: "interrupted", visualStatus: "partial" }
      : outcome.results.some(result => result.error) ? { status: "partial", visualStatus: "partial" } : {}),
    ...(reports.some((report) => report.hints?.length) ? { hints: reports.flatMap((report) => report.hints ?? []) } : {}),
    issues: reports.flatMap((report) =>
      report.issues.map((issue) =>
        all ? { ...issue, target: report.selection } : issue,
      ),
    ),
    coverage: {
      ...(reports[0]?.coverage ?? empty.coverage),
      ...executionCoverage(outcome),
      complete: !outcome.interrupted && reports.every(report => report.coverage.complete),
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
            packageId: reports[0]?.selection.packageId,
          }
        : { screenId: option(args, "--screen-id") }),
    };
  }
  return visual;
}

async function validateCommand(packagePath, args, { named = false, targets, extraIssues } = {}) {
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
  if (targets) return validateWholePackage(packagePath, args, workspace, resolution, targets, extraIssues);
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
    const ids = ["--screen-id", "--presentation-id", "--component-id", "--package-id", "--variant-id", "--node-id"]
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
    ["init", "check", "view", "export", "changes"].includes(args[0]);
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
    const value = helpWithInput(topic, section, { full });
    // A grouped action's full help is its engine's text, under its path.
    const route = topic && section && COMMAND_GROUPS[topic] && !groupDefinition(topic, section) ? groupRoute(topic, section) : undefined;
    const fullTopic = route ? route.engine : !COMMAND_GROUPS[topic] && !["workflow", "rules", "skills"].includes(topic) ? topic : undefined;
    if (flag(args, "--json"))
      printJson(
        full && fullTopic
          ? { ...commandContract(route ? route.name : fullTopic), guidance: commandGuidance(fullTopic, route), ...(value.input ? { input: value.input } : {}) }
          : value,
      );
    else if (full && fullTopic) printHelp(fullTopic, { full, route, input: value.input });
    else printBriefHelp(topic, section, { full, value });
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
  if (command === "check") {
    await checkCommand(args);
    return;
  }
  // Only grouped commands and the shared ones are public: an engine name
  // typed directly ("apply", "inspect") points to its grouped path.
  if (
    !routed.route &&
    COMMAND_NAMES.includes(command) &&
    !["init", "view", "changes", "export", "help", "schema", "version"].includes(command)
  ) {
    // validate became check --render.
    const path = command === "validate" ? ["check", "--render"] : publicArgv([command]);
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
  if (command === "export" && option(args, "--format") === "html") {
    printJson(await htmlExportCommand(packagePath, args));
    return;
  }
  if (command === "export" && args.includes("--canvas"))
    throw new SmallPenError("unsupported_canvas_export_format", "--canvas exports an HTML review; use --format html, or view --canvas for other canvas outputs");
  const namedTargets = command === "export" ? await nameTargetArgs(packagePath, args) : [];
  // A whole component has the same visual scope as view. Explicit variants,
  // elements and low-level ID targets keep their native definition exports.
  if (publicSurface && command === "export" && option(args, "--component") !== undefined &&
      option(args, "--variant") === undefined && option(args, "--element") === undefined &&
      ["png", "wireframe"].includes(option(args, "--format") ?? "wireframe")) {
    const workspace = await tokenWorkspace(packagePath, args);
    if (!findLocatedComponent(workspace, option(args, "--component"))) {
      const { set } = findComponent(workspace.product, option(args, "--component"), workspace);
      if (set.variants.length > 1) {
        const design = await sheetDesign(args, workspace, {
          only: "components", componentSetIds: [set.id], allVariants: true,
        }, {
          component: set.name, variants: set.variants.length,
          ...(set.visibility && set.visibility !== "public" ? { visibility: set.visibility } : {}),
          ...(set.deprecated ? { deprecated: set.deprecated } : {}),
        });
        if (flag(args, "--evidence") && option(args, "--format") !== "png")
          throw new SmallPenError("missing_png_format", "--evidence requires --format png");
        printJson(await designCommand(packagePath, args, design, workspace));
        return;
      }
    }
  }
  if (command === "export") args = [...args, ...namedTargets];
  if (command === "export" && flag(args, "--evidence")) {
    if (option(args, "--format") !== "png")
      throw new SmallPenError("missing_png_format", "--evidence requires --format png");
    printJson(await designCommand(packagePath, args));
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
      ).filter((item) => tokenNamed(item.token?.path ?? item.token?.name, option(args, "--token")));
      // Each definition as tokens.css writes it: its block and its value,
      // an alias as var(--name).
      const asWritten = (item) => {
        const { description, name, type, value } = item.token ?? {};
        const alias = typeof value === "string" ? /^\{([^}]+)\}$/.exec(value) : null;
        return {
          block: item.group ? `:root[data-${item.group}="${item.option}"]` : ":root",
          token: { name, type, value: alias ? `var(--${alias[1]})` : value, ...(description ? { description } : {}) },
        };
      };
      const page = pageItems(all.map(asWritten), pagination(args));
      printJson({
        mode: "definitions",
        items:
          flag(args, "--full") &&
          !args.includes("--limit") &&
          !args.includes("--offset")
            ? all.map(asWritten)
            : page.items,
        page: page.page,
        packageId: product.manifest.packageId,
        ...workspaceRevisions(product, foundation, libraries),
        // Tokens change in tokens.css; the classes that use them are listed here.
        nextOperations: [
          {
            operation: "smallpen.help",
            argv: ["help", "rules", "classes", "--json"],
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
    // How often pages and components use each Token, by name.
    const uses = tokenUseCounts(Object.values(product.entries));
    const all = listEffectiveTokens(product, {
      context,
      foundation,
      libraries,
    }).filter((item) => (!requestedType || item.token.type === requestedType) && tokenNamed(item.token.path, option(args, "--token")) &&
      (!flag(args, "--unused") || (uses.get(item.token.path) ?? 0) === 0));
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
            uses: uses.get(item.token.path) ?? 0,
          })),
      ...(paginated ? { page: page.page } : {}),
      labels: tokenLabels(option(args, "--locale") ?? defaultLocale()),
      packageId: product.manifest.packageId,
      themes: themeSummary(product, foundation),
      ...workspaceRevisions(product, foundation, libraries),
    });
    return;
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

const cliArgs = process.argv.slice(2);
let executionArgs = cliArgs;
let publicSurface = false;
main(cliArgs)
  .catch(async (error) => {
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
