// One definition drives command schemas, help, argument validation and errors.
import {
  SMALLPEN_FORMAT_CAPABILITIES,
  SmallPenError,
  suggestField,
} from "@smallpen/core";

const parameter = (option, type, description, extra = {}) => ({
  option,
  type,
  description,
  required: false,
  repeatable: false,
  ...extra,
});
const flag = (option, description) =>
  parameter(option, "boolean", description, { default: false });
const path = (option, description) => parameter(option, "path", description);
const integer = (option, description, extra = {}) =>
  parameter(option, "integer", description, {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    ...extra,
  });

const PARAMETERS = {
  targetTimeout: integer(
    "--target-timeout",
    "Maximum milliseconds per validation target, including native layout; interruption returns partial coverage",
    { minimum: 1, maximum: 600_000, default: 30_000 },
  ),
  stdout: flag(
    "--stdout",
    "Print large results to stdout instead of saving a temporary result file",
  ),
  allThemes: flag("--all-themes", "Search inactive token themes too"),
  base64: flag(
    "--base64",
    "Include inline image bytes; disables the small reply budget",
  ),
  color: parameter("--color", "string", "Search tokens near this color"),
  evidence: flag(
    "--evidence",
    "Export PNG, specification, wireframe and JSON evidence from one native layout; requires --format png",
  ),
  designSystem: flag(
    "--design-system",
    "Render the generated Design System page (every Token and representative component samples) instead of a Screen",
  ),
  unused: flag(
    "--unused",
    "Only Tokens no page or component uses (they may still be meant for code)",
  ),
  definitions: flag(
    "--definitions",
    "Read stored Token definitions in all option Sets, without resolving a theme combination",
  ),
  group: parameter(
    "--group",
    "string",
    "Only Tokens that take values in this theme group (Brand); requires --definitions",
  ),
  page: parameter("--page", "string", "Page name"),
  by: parameter("--by", "string", "Theme group: one file per option, for example Language"),
  tokenFormat: parameter("--format", "string", "json (nested by name, numbers in px), flat (one key per Token name) or css (custom properties as tokens.css writes them: aliases as var(--name), units kept)", {
    values: ["json", "flat", "css"],
    errorCode: "unknown_token_format",
  }),
  since: parameter("--since", "string", "A revision you saw; every read and write reports one"),
  canvas: parameter("--canvas", "string", "Canvas name"),
  as: parameter("--as", "string", "Three design outputs: spec for implementation and sources; wireframe for structure; png for appearance. text (default) navigates; issues checks. Compare layout.hash", {
    values: ["text", "wireframe", "png", "issues", "spec"],
    errorCode: "unknown_view_as",
  }),
  component: parameter("--component", "string", "Component name"),
  variant: parameter("--variant", "string", 'One variant, as in props: "Style: secondary; Size: sm" (or just "secondary")'),
  element: parameter("--element", "string", 'Element name, or "Parent / Element" when the name repeats; view/export also accept the actual root name'),
  platform: parameter("--platform", "string", "Page version: desktop, mobile, ..."),
  token: parameter("--token", "string", "Token name or prefix, for example color or color.brand"),
  allTokens: flag("--tokens", "Every Token"),
  allComponents: flag("--components", "Every component"),
  allPages: flag("--pages", "Every page"),
  full: flag(
    "--full",
    "Expand selected data; large results still use files. --stdout opts into large stdout. View nodes honor explicit pagination",
  ),
  help: flag("--help", "Print this command's help"),
  interval: integer(
    "--interval",
    "Watch poll interval in milliseconds; values below 100 use 100",
    { default: 500, maximum: 3_600_000 },
  ),
  json: flag("--json", "Machine-readable output with stable keys"),
  kind: parameter("--kind", "string", "Object kind"),
  // Accepted for older scripts; a package is always one directory, so help
  // does not list it.
  layout: parameter("--layout", "string", "Kept for older scripts: a package is always single", {
    hidden: true,
    default: "single",
    values: ["single"],
    errorCode: "invalid_init_layout",
  }),
  limit: integer("--limit", "Maximum items in this page", {
    default: 20,
    maximum: 100,
  }),
  locale: parameter(
    "--locale",
    "string",
    "Label locale; stable JSON keys stay English",
    { defaultFrom: "LC_ALL, LC_MESSAGES, LANG, then English" },
  ),
  maxEvents: integer("--max-events", "Maximum watch events before exit", {
    minimum: 1,
    maximum: 10_000,
    defaultFrom: "unlimited",
  }),
  name: parameter("--name", "string", "Display name"),
  offset: integer("--offset", "First item index in this page", { default: 0 }),
  output: path(
    "--output",
    "Output artifact path; image commands otherwise return temporary file paths",
  ),
  path: parameter(
    "--path",
    "string",
    "Token name, for example color.brand",
  ),
  query: parameter("--query", "string", "Search text"),
  revert: flag(
    "--revert",
    "Put the files check rejects back to the last accepted version (new files are removed)",
  ),
  file: parameter("--file", "string", "With --revert: revert only this package file (repeatable), such as pages/Tasks/Board.html", {
    repeatable: true,
  }),
  render: flag(
    "--render",
    "Also lay out and draw the pages and components and check text fit, bounds, overlaps and contrast",
  ),
  allThemes: flag(
    "--all-themes",
    "With --render: check under every combination of theme options, not only the defaults",
  ),
  scale: parameter("--scale", "number", "Raster scale within (0, 8]", {
    default: 1,
    exclusiveMinimum: 0,
    maximum: 8,
    errorCode: "invalid_render_scale",
  }),
  theme: parameter(
    "--theme",
    "string",
    "GROUP/NAME token theme for this call; one per group",
    {
      repeatable: true,
      defaultFrom:
        "project group defaults (data-GROUP on index.html's <html>); --theme overrides named groups for this call; independent of App active selection",
    },
  ),
  type: parameter("--type", "string", "Token type filter", {
    values: SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes,
    errorCode: "invalid_token_type",
  }),
  value: parameter(
    "--value",
    "string",
    "Token value filter; JSON when valid, otherwise text",
  ),
  artifactFormat: parameter("--format", "string", "spec implements and traces sources; wireframe shows structure; png reviews appearance; html exports an offline page review; text is a navigation outline", {
    default: "wireframe",
    values: ["text", "spec", "wireframe", "png", "html"],
    errorCode: "unknown_export_format",
  }),};

const PAGE = ["limit", "offset"];
const VIEW = ["theme"];
// A design target by name, as view takes it.
const TARGET = ["page", "platform", "element", "component", "variant"];
const COMMON = ["json", "full", "stdout", "help"];
const command = (purpose, fields = [], extra = {}) => ({
  purpose,
  fields,
  ...extra,
});
const required = (field, code) => ({ field, code });

export const COMMAND_CONTRACTS = {
  help: command("Print command usage and options", [], {
    locator: false,
    arguments: [
      { name: "topic", type: "string", required: false },
      {
        name: "section",
        type: "string",
        required: false,
        when: "an action, subgroup or rules topic",
      },
      { name: "action", type: "string", required: false, when: "section is a command subgroup" },
    ],
  }),
  version: command("Print the CLI version", [], { locator: false }),
  // Internal: the rendering checks behind check --render and view --as
  // issues. It is not a public command.
  validate: command(
    "Render the selected pages and components and check text fit, bounds, overlaps and contrast",
    [...TARGET, ...VIEW, "designSystem", "limit", "offset", "targetTimeout"],
    { conflicts: { designSystem: ["page", "component"] } },
  ),
  check: command(
    "Check the package's HTML, tokens.css and rules: one line per problem with file:line:column; --render also checks text fit, bounds, overlaps and contrast",
    ["revert", "file", "render", "allThemes", ...TARGET, ...VIEW, "limit", "offset", "targetTimeout"],
  ),
  schema: command(
    "Print the JSON shape and parameters of each command and write input",
    PAGE,
    {
      locator: false,
      arguments: [
        { name: "topic", type: "string", required: false },
        {
          name: "name",
          type: "string",
          required: false,
          when: "topic is command, operation, workflow or an intent action directory",
        },
        { name: "action", type: "string", required: false, when: "topic is command" },
        { name: "subaction", type: "string", required: false, when: "name and action identify a command subgroup" },
      ],
    },
  ),
  init: command(
    "Create a blank package (index.html and tokens.css)",
    ["name", "layout", "locale"],
    { locatorName: "workspace" },
  ),
  "token-export": command(
    "Export Token values as JSON or CSS custom properties; --by GROUP writes one file per option",
    ["type", "token", "by", "tokenFormat", "theme", "output"],
    { overrides: { output: { description: "Directory for the files; default a temporary directory" } } },
  ),
  changes: command(
    "What changed since a revision you saw, by name: themes, Tokens, components and pages, including edits made in the App",
    ["since", "limit"],
  ),
  view: command(
    "Look by name: spec for implementation, wireframe for structure, PNG for appearance; text navigates, issues checks",
    [
      "as",
      "canvas",
      "page",
      "platform",
      "component",
      "variant",
      "element",
      "token",
      "allTokens",
      "allComponents",
      "allPages",
      "scale",
      "output",
      ...VIEW,
      "designSystem",
      "locale",
      ...PAGE,
    ],
    { conflicts: { designSystem: ["page", "component", "canvas", "token", "allTokens", "allComponents", "allPages"] } },
  ),
  export: command(
    "Export spec, wireframe or PNG; --format html --canvas NAME --output DIR saves an offline review with declared prototype navigation",
    [
      ...TARGET,
      "canvas",
      ...VIEW,
      "designSystem",
      "artifactFormat",
      "locale",
      "scale",
      "output",
      "evidence",
      "base64",
    ],
    {
      conflicts: {
        designSystem: ["page", "component", "canvas"],
        canvas: ["page", "component", "element", "variant", "platform"],
      },
      requires: [
        {
          field: "artifactFormat",
          when: ["evidence", "base64"],
          code: "missing_png_format",
        },
        { field: "output", when: { artifactFormat: "html" }, code: "missing_review_output" },
      ],
      overrides: {
        output: { description: "Artifact path; HTML requires a new/empty directory outside source Packages, with index written last" },
        component: { description: "Component name; PNG/wireframe show all variants as view does unless --variant or --element selects one; spec reads the main variant unless --variant selects another" },
        page: { description: "Page name; HTML exports all its versions unless --platform selects one" },
        canvas: { description: "HTML review canvas name; without --page/--canvas, exactly one canvas must exist" },
      },
    },
  ),
  tokens: command("Read effective Tokens for these themes", [
    "definitions",
    "unused",
    "token",
    "group",
    "type",
    "locale",
    "theme",
    ...PAGE,
  ]),
};

export function commandContract(name) {
  const spec = Object.hasOwn(COMMAND_CONTRACTS, name)
    ? COMMAND_CONTRACTS[name]
    : undefined;
  if (!spec)
    throw new SmallPenError(
      "unknown_schema_command",
      `Unknown command: ${name ?? "(missing)"}`,
      {
        received: name ?? null,
        nextOperations: [
          {
            argv: ["schema", "commands", "--json"],
            operation: "smallpen.schema",
          },
        ],
      },
    );
  const parameters = Object.fromEntries(
    [...spec.fields, ...(spec.common ?? COMMON)].map((field) => {
      const { errorCode: _code, ...definition } = {
        ...PARAMETERS[field],
        ...spec.overrides?.[field],
      };
      const required = (spec.required ?? []).some(
        (item) => item.field === field,
      );
      return [
        field,
        {
          ...definition,
          required,
          ...(required && ["path", "string"].includes(definition.type)
            ? { minLength: 1 }
            : {}),
          ...(definition.valuesWhen
            ? {
                valuesWhen: definition.valuesWhen.map(
                  ({ errorCode: _code, ...rule }) => rule,
                ),
              }
            : {}),
        },
      ];
    }),
  );
  return {
    command: name,
    purpose: spec.purpose,
    arguments:
      spec.arguments ??
      (spec.locator === false
        ? []
        : [
            {
              name: spec.locatorName ?? "package",
              type: "path",
              required: true,
            },
          ]),
    parameters,
    ...(spec.output ? { output: spec.output } : {}),
    ...(spec.requires ? { requires: spec.requires } : {}),
    ...(spec.conflicts ? { conflicts: spec.conflicts } : {}),
    ...(spec.exactlyOne ? { exactlyOne: spec.exactlyOne } : {}),
    ...(spec.atLeastOne
      ? { atLeastOne: spec.atLeastOne.map(({ fields }) => fields) }
      : {}),
    conflictsWith: [
      ...[["full", "compact"]].filter((group) =>
        group.every((field) => parameters[field]),
      ),
      ...(spec.conflictsWith ?? []).map(({ fields }) => fields),
    ],
    next: ["schema", "command", name, "--json"],
  };
}

function conditionMatches(when, seen) {
  return Array.isArray(when)
    ? when.every((field) => seen.has(field))
    : Object.entries(when).every(([field, value]) =>
        seen.get(field)?.includes(value),
      );
}

function conditionText(when, parameters) {
  return (
    Array.isArray(when)
      ? when.map((field) => parameters[field].option)
      : Object.entries(when).map(
          ([field, value]) => `${parameters[field].option} ${value}`,
        )
  ).join(" and ");
}

export function commandHelp(name) {
  const spec = commandContract(name);
  const options = (fields) =>
    fields.map((field) => spec.parameters[field].option).join(" or ");
  const rules = [
    ...(spec.requires ?? []).map(
      ({ field, when }) =>
        `${spec.parameters[field].option} is required with ${conditionText(when, spec.parameters)}`,
    ),
    ...Object.entries(spec.conflicts ?? {}).map(
      ([field, others]) =>
        `${spec.parameters[field].option} conflicts with ${options(others)}`,
    ),
    ...(spec.exactlyOne ?? []).map(
      (fields) => `Choose exactly one of ${options(fields)}`,
    ),
    ...(spec.atLeastOne ?? []).map(
      (fields) => `Supply at least one of ${options(fields)}`,
    ),
    ...spec.conflictsWith.map(
      (fields) => `Choose at most one of ${options(fields)}`,
    ),
    ...Object.entries(spec.parameters).flatMap(([_field, parameter]) =>
      (parameter.valuesWhen ?? []).map(
        ({ when, values }) =>
          `${parameter.option} accepts ${values.join("|")} with ${conditionText(when, spec.parameters)}`,
      ),
    ),
  ];
  return (
    `Options:\n` +
    Object.entries(spec.parameters)
      .map(([_field, parameter]) => {
        const {
          option,
          type,
          description,
          required,
          repeatable,
          values,
          minimum,
          maximum,
          exclusiveMinimum,
          minLength,
          nonBlank,
          minItems,
          maxItems,
          default: fallback,
          defaultFrom,
        } = parameter;
        const facts = [
          type,
          required ? "required" : "optional",
          ...(repeatable ? ["repeatable"] : []),
          ...(values ? [values.join("|")] : []),
          ...(minimum !== undefined ? [`min=${minimum}`] : []),
          ...(maximum !== undefined ? [`max=${maximum}`] : []),
          ...(exclusiveMinimum !== undefined ? [`>${exclusiveMinimum}`] : []),
          ...(minLength !== undefined ? [`minLength=${minLength}`] : []),
          ...(nonBlank ? ["non-blank"] : []),
          ...(minItems !== undefined ? [`minItems=${minItems}`] : []),
          ...(maxItems !== undefined ? [`maxItems=${maxItems}`] : []),
          ...(fallback !== undefined ? [`default=${fallback}`] : []),
          ...(defaultFrom ? [`default: ${defaultFrom}`] : []),
        ];
        return `  ${option} (${facts.join("; ")})\n    ${description}`;
      })
      .join("\n") +
    (rules.length
      ? `\nConstraints:\n${rules.map((rule) => `  ${rule}`).join("\n")}`
      : "")
  );
}

export function parameterExpectation(spec) {
  const parts = [spec.type, spec.description];
  if (spec.values) parts.push(`one of: ${spec.values.join(" | ")}`);
  if (spec.minimum !== undefined) parts.push(`minimum ${spec.minimum}`);
  if (spec.maximum !== undefined) parts.push(`maximum ${spec.maximum}`);
  if (spec.exclusiveMinimum !== undefined)
    parts.push(`greater than ${spec.exclusiveMinimum}`);
  if (spec.minLength !== undefined)
    parts.push(`at least ${spec.minLength} character(s)`);
  if (spec.nonBlank) parts.push("non-blank text");
  return parts.join("; ");
}

function facts(command, field, received = null) {
  const spec = commandContract(command).parameters[field];
  if (typeof received === "string" && received.length > 256)
    received = `${received.slice(0, 256)}…`;
  return {
    command,
    field,
    option: spec.option,
    path: spec.option,
    expected: parameterExpectation(spec),
    expectedType: spec.type,
    received,
    ...(spec.values ? { validValues: spec.values } : {}),
    nextOperations: [
      {
        argv: ["schema", "command", command, "--json"],
        operation: "smallpen.schema",
      },
    ],
  };
}

// Validate the single command spelling before opening a package.
export function validateCommandArguments(command, args) {
  const spec = commandContract(command);
  const argument = spec.arguments[0];
  if (argument?.required && (!args[1] || args[1].startsWith("-")))
    throw new SmallPenError(
      argument.name === "workspace" ? "missing_workspace" : "missing_package",
      `A ${argument.name} path is required`,
      {
        command,
        field: argument.name,
        path: "arguments[0]",
        expected: `a non-empty ${argument.name} path`,
        expectedType: argument.type,
        received: null,
        nextOperations: [{ argv: spec.next, operation: "smallpen.schema" }],
      },
    );
  const byOption = new Map(
    Object.entries(spec.parameters).map(([field, parameter]) => [
      parameter.option,
      { field, parameter },
    ]),
  );
  const seen = new Map();
  const hasValue = (field) =>
    seen.get(field) === true ||
    (seen.get(field) ?? []).some((value) => value !== "");
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    const match = byOption.get(option);
    if (!match) {
      const code = option.startsWith("-")
        ? "unknown_option"
        : "unexpected_argument";
      const validOptions = [...byOption.keys()].sort();
      const suggestion = suggestField(option, validOptions);
      throw new SmallPenError(
        code,
        `${code === "unknown_option" ? "Unknown option" : "Unexpected positional argument"}: ${option}`,
        {
          command,
          option,
          validOptions,
          ...(suggestion ? { suggestion } : {}),
          nextOperations: [
            {
              argv: ["schema", "command", command, "--json"],
              operation: "smallpen.schema",
            },
          ],
        },
      );
    }
    const { field, parameter } = match;
    if (seen.has(field) && !parameter.repeatable)
      throw new SmallPenError(
        "duplicate_option",
        `${parameter.option} may be given only once`,
        facts(command, field, option),
      );
    if (parameter.type === "boolean") {
      seen.set(field, true);
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--"))
      throw new SmallPenError(
        "missing_option_value",
        `${parameter.option} requires a value`,
        facts(command, field),
      );
    const definition = {
      ...PARAMETERS[field],
      ...COMMAND_CONTRACTS[command].overrides?.[field],
    };
    if (
      (parameter.minLength !== undefined &&
        value.length < parameter.minLength) ||
      (parameter.nonBlank && value.trim() === "")
    )
      throw new SmallPenError(
        definition.errorCode ??
          COMMAND_CONTRACTS[command].required?.find(
            (item) => item.field === field,
          )?.code ??
          "invalid_option_value",
        `${parameter.option} requires a non-empty value`,
        facts(command, field, value),
      );
    if (parameter.type === "integer" || parameter.type === "number") {
      const parsed = Number(value);
      if (
        value.trim() === "" ||
        !Number.isFinite(parsed) ||
        (parameter.type === "integer" && !Number.isSafeInteger(parsed)) ||
        (parameter.minimum !== undefined && parsed < parameter.minimum) ||
        (parameter.maximum !== undefined && parsed > parameter.maximum) ||
        (parameter.exclusiveMinimum !== undefined &&
          parsed <= parameter.exclusiveMinimum)
      ) {
        throw new SmallPenError(
          definition.errorCode ??
            (parameter.type === "integer"
              ? "invalid_integer_option"
              : "invalid_number_option"),
          `${parameter.option} is outside its ${parameter.type} range`,
          facts(command, field, value),
        );
      }
    }
    const enumValue =
      parameter.type === "integer" || parameter.type === "number"
        ? Number(value)
        : value;
    if (parameter.values && !parameter.values.includes(enumValue))
      throw new SmallPenError(
        definition.errorCode ?? "invalid_option_value",
        `${parameter.option} must be one of: ${parameter.values.join(", ")}`,
        facts(command, field, value),
      );
    if (parameter.type === "assignment" && !/^[^=]+=[\s\S]+$/.test(value))
      throw new SmallPenError(
        field === "context"
          ? "invalid_context_argument"
          : "invalid_initialization_answer_argument",
        `${parameter.option} requires ${field === "context" ? "CONTEXT=VALUE" : "QUESTION_ID=JSON"}`,
        facts(command, field, value),
      );
    if (parameter.type === "json" || field === "answer") {
      const source =
        field === "answer" ? value.slice(value.indexOf("=") + 1) : value;
      try {
        JSON.parse(source);
      } catch {
        throw new SmallPenError(
          field === "answer"
            ? "invalid_initialization_answer_json"
            : definition.errorCode,
          `${parameter.option} requires valid JSON`,
          {
            ...facts(command, field, value),
            ...(field === "answer"
              ? { questionId: value.slice(0, value.indexOf("=")) }
              : {}),
          },
        );
      }
    }
    if (
      parameter.uniqueBy === "assignment-key" &&
      (seen.get(field) ?? []).some(
        (previous) =>
          previous.slice(0, previous.indexOf("=")) ===
          value.slice(0, value.indexOf("=")),
      )
    )
      throw new SmallPenError(
        "duplicate_option",
        `${parameter.option} cannot set the same key twice`,
        facts(command, field, value),
      );
    seen.set(field, [
      ...(Array.isArray(seen.get(field)) ? seen.get(field) : []),
      value,
    ]);
  }
  for (const [field, parameter] of Object.entries(spec.parameters)) {
    const count = seen.get(field)?.length ?? 0;
    if (
      (parameter.minItems !== undefined && count < parameter.minItems) ||
      (parameter.maxItems !== undefined && count > parameter.maxItems)
    )
      throw new SmallPenError(
        "invalid_compare_count",
        `${parameter.option} requires ${parameter.minItems} to ${parameter.maxItems} items`,
        facts(command, field, count),
      );
  }
  for (const group of spec.conflictsWith)
    if (group.every((field) => seen.has(field)))
      throw new SmallPenError(
        COMMAND_CONTRACTS[command].conflictsWith?.find(
          ({ fields }) => fields.join() === group.join(),
        )?.code ?? "conflicting_output_options",
        `Choose at most one of ${group.map((field) => spec.parameters[field].option).join(" or ")}`,
        {
          ...facts(
            command,
            group[0],
            seen.get(group[0]) === true ? true : seen.get(group[0])[0],
          ),
          fields: group,
          expected: "at most one of the listed options",
        },
      );
  for (const item of COMMAND_CONTRACTS[command].required ?? [])
    if (!seen.has(item.field))
      throw new SmallPenError(
        item.code,
        `${command} requires ${spec.parameters[item.field].option}`,
        facts(command, item.field),
      );
  for (const item of spec.requires ?? [])
    if (conditionMatches(item.when, seen) && !hasValue(item.field))
      throw new SmallPenError(
        item.code,
        `${spec.parameters[item.field].option} is required with ${conditionText(item.when, spec.parameters)}`,
        {
          ...facts(command, item.field, seen.get(item.field)?.[0] ?? null),
          expected: `${parameterExpectation(spec.parameters[item.field])}; required with ${conditionText(item.when, spec.parameters)}`,
        },
      );
  for (const [field, parameter] of Object.entries(spec.parameters))
    for (const rule of {
      ...PARAMETERS[field],
      ...COMMAND_CONTRACTS[command].overrides?.[field],
    }.valuesWhen ?? [])
      if (
        seen.has(field) &&
        conditionMatches(rule.when, seen) &&
        !rule.values.includes(seen.get(field)[0])
      )
        throw new SmallPenError(
          rule.errorCode,
          `${parameter.option} accepts ${rule.values.join(" or ")} with ${conditionText(rule.when, spec.parameters)}`,
          {
            ...facts(command, field, seen.get(field)[0]),
            expected: `${rule.values.join(" or ")} with ${conditionText(rule.when, spec.parameters)}`,
            validValues: rule.values,
          },
        );
  for (const { fields, code } of COMMAND_CONTRACTS[command].atLeastOne ?? [])
    if (!fields.some((field) => seen.has(field)))
      throw new SmallPenError(
        code,
        `Supply at least one of ${fields.map((field) => spec.parameters[field].option).join(" or ")}`,
        {
          ...facts(command, fields[0]),
          fields,
          expected: "at least one of the listed options",
        },
      );
  for (const [field, others] of Object.entries(spec.conflicts ?? {}))
    if (seen.has(field) && others.some((other) => seen.has(other)))
      throw new SmallPenError(
        "conflicting_read_target",
        "Choose one Token, Component, or Screen/Presentation target",
        {
          ...facts(command, field, seen.get(field)[0]),
          fields: [field, ...others.filter((other) => seen.has(other))],
        },
      );
  for (const group of spec.exactlyOne ?? [])
    if (group.filter(hasValue).length !== 1)
      throw new SmallPenError(
        group.includes("theme")
          ? "missing_theme_target"
          : group.includes("colorName")
            ? "missing_asset_target"
            : "missing_token_reference",
        `Choose exactly one of ${group.map((field) => spec.parameters[field].option).join(" or ")}`,
        {
          ...facts(command, group[0], seen.get(group[0])?.[0] ?? null),
          fields: group,
          expected: "exactly one target",
          nextOperations: [{ argv: spec.next, operation: "smallpen.schema" }],
        },
      );
  return args;
}

export function numericDefault(command, option, full) {
  const spec = Object.values(commandContract(command).parameters).find(
    (parameter) => parameter.option === option,
  );
  return (
    (full ? spec.defaultWhenFull : undefined) ??
    spec.default ??
    Number.POSITIVE_INFINITY
  );
}
