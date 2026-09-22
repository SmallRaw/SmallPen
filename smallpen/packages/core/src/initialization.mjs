import { fail } from "./errors.mjs";

const PROJECT_KINDS = ["application", "motion", "custom"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slug(value, separator = "_") {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "");
  return normalized || "smallpen_project";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(nonEmptyString)
  );
}

function contextAxes(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (axis) =>
        isRecord(axis) &&
        nonEmptyString(axis.id) &&
        axis.id.startsWith("axis_") &&
        /^[a-zA-Z0-9_-]+$/.test(axis.id) &&
        nonEmptyString(axis.name) &&
        ["accessibility", "custom", "density", "locale", "theme", "viewport"].includes(
          axis.kind,
        ) &&
        nonEmptyStrings(axis.values) &&
        new Set(axis.values).size === axis.values.length &&
        axis.values.includes(axis.defaultValue),
    )
  );
}

const QUESTION_DEFINITIONS = [
  {
    id: "projectKind",
    label: { en: "Project kind", "zh-TW": "專案類型" },
    reason: "Selects the initial workflow and adapter scope.",
    recommendation: "application",
    schema: { enum: PROJECT_KINDS, type: "string" },
    valid: (value) => PROJECT_KINDS.includes(value),
  },
  {
    id: "projectName",
    label: { en: "Project name", "zh-TW": "專案名稱" },
    reason: "Derives stable package names and initial identifiers.",
    recommendation: "My Product",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "purpose",
    label: { en: "Purpose", "zh-TW": "目標" },
    reason: "Records what the design must help people accomplish.",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "audience",
    label: { en: "Audience", "zh-TW": "使用者／審閱者" },
    reason: "Defines who will use or review the output.",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "firstOutput",
    label: { en: "First output", "zh-TW": "首個交付物" },
    reason: "Keeps initialization focused on one concrete first result.",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "foundationChoice",
    label: { en: "Foundation", "zh-TW": "Foundation 選擇" },
    reason: "Initialization currently creates a local Foundation beside the Product.",
    recommendation: "create-new",
    schema: { enum: ["create-new"], type: "string" },
    valid: (value) => value === "create-new",
  },
  {
    id: "platforms",
    label: { en: "Platforms", "zh-TW": "平台／頁面稿目標" },
    reason: "The first value becomes the Base Presentation and default view.",
    recommendation: ["desktop"],
    schema: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
    valid: nonEmptyStrings,
  },
  {
    id: "sourceInputs",
    label: { en: "Source inputs", "zh-TW": "來源輸入" },
    reason: "Persists references to existing research, assets, or designs.",
    recommendation: ["none"],
    schema: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
    valid: nonEmptyStrings,
  },
  {
    id: "contextAxes",
    label: { en: "Context axes", "zh-TW": "Context 軸" },
    reason: "Declares finite theme, density, locale, accessibility, or custom alternatives.",
    recommendation: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Theme",
        values: ["light", "dark"],
      },
    ],
    schema: {
      items: {
        required: ["defaultValue", "id", "kind", "name", "values"],
        type: "object",
      },
      type: "array",
    },
    valid: contextAxes,
  },
  {
    id: "initialTokens",
    label: { en: "Initial Tokens", "zh-TW": "初始 Tokens" },
    reason: "Creates a small shared Token vocabulary in Foundation.",
    recommendation: ["color.brand", "spacing.md", "radius.md"],
    schema: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
    valid: nonEmptyStrings,
  },
  {
    id: "initialComponents",
    label: { en: "Initial components", "zh-TW": "初始元件" },
    reason: "Creates explicit starter Component Sets in Foundation.",
    recommendation: ["Button"],
    schema: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
    valid: nonEmptyStrings,
  },
  {
    id: "firstScreen",
    label: { en: "First Screen", "zh-TW": "首個 Screen" },
    reason: "Names the initial Product Screen.",
    recommendation: "Home",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "firstScenario",
    label: { en: "First Scenario", "zh-TW": "首個 Scenario" },
    reason: "Records one reproducible initial design state.",
    recommendation: "Default",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "firstJourney",
    label: { en: "First journey", "zh-TW": "首個使用流程" },
    reason: "Seeds requirements and Flow navigation without executable scripts.",
    recommendation: "Primary journey",
    schema: { minLength: 1, type: "string" },
    valid: nonEmptyString,
  },
  {
    id: "kindDetails",
    label: { en: "Adapter scope", "zh-TW": "類型／轉接器細節" },
    reason: "Captures runtime, motion, size, or delivery constraints for the selected kind.",
    recommendation: ["responsive", "local-first"],
    schema: { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
    valid: nonEmptyStrings,
  },
];

function publicQuestion(question, statePath, locale) {
  const language = locale?.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
  return {
    choices: question.schema.enum ?? undefined,
    continuation: {
      args: [
        "init",
        "<workspace-directory>",
        "--state",
        statePath,
        "--answer",
        `${question.id}=<JSON>`,
        "--json",
      ],
      operation: "smallpen.init.answer",
    },
    id: question.id,
    label: question.label[language],
    labels: question.label,
    reason: question.reason,
    recommendation: structuredClone(question.recommendation),
    required: true,
    schema: structuredClone(question.schema),
  };
}

export function parseInitializationAnswers(value) {
  if (!isRecord(value)) {
    fail(
      "invalid_initialization_answers",
      "Initialization answers must contain an object",
      { path: "answers" },
    );
  }
  const known = new Set(QUESTION_DEFINITIONS.map(({ id }) => id));
  for (const field of Object.keys(value)) {
    if (!known.has(field)) {
      fail(
        "unknown_initialization_answer",
        `Unknown Initialization answer: ${field}`,
        { field, path: `answers.${field}` },
      );
    }
  }
  const result = {};
  for (const question of QUESTION_DEFINITIONS) {
    if (!Object.hasOwn(value, question.id)) continue;
    if (!question.valid(value[question.id])) {
      fail(
        "invalid_initialization_answer",
        `Initialization answer does not match ${question.id}`,
        { path: `answers.${question.id}`, questionId: question.id, schema: question.schema },
      );
    }
    result[question.id] = structuredClone(value[question.id]);
  }
  return result;
}

function proposal(answers) {
  const project = slug(answers.projectName);
  const firstScreen = slug(answers.firstScreen);
  const platform = slug(answers.platforms[0]);
  const packageIds = {
    foundation: `pkg_${project}_foundation`,
    product: `pkg_${project}_product`,
  };
  return {
    assumptions: [
      "The first platform is the Base Presentation and default Design View.",
      "Foundation owns shared Contexts, Tokens, and starter Component Sets.",
      "Product owns Screens, Scenarios, requirements, Flows, and local overrides.",
    ],
    brief: structuredClone(answers),
    firstDesign: {
      flowId: `flow_${slug(answers.firstJourney)}`,
      name: answers.firstScreen,
      presentationId: `pres_${firstScreen}_${platform}`,
      requirementId: `req_${slug(answers.firstJourney)}`,
      scenarioId: `scn_${firstScreen}_${slug(answers.firstScenario)}`,
      screenId: `scr_${firstScreen}`,
    },
    packages: {
      foundation: {
        directoryName: `${project.replaceAll("_", "-")}-foundation.smallpen`,
        name: `${answers.projectName} Foundation`,
        packageId: packageIds.foundation,
        role: "foundation",
      },
      product: {
        directoryName: `${project.replaceAll("_", "-")}.smallpen`,
        name: answers.projectName,
        packageId: packageIds.product,
        role: "product",
      },
    },
    proposalVersion: 1,
  };
}

export function createInitializationState(answersValue, options = {}) {
  const answers = parseInitializationAnswers(answersValue);
  const missing = QUESTION_DEFINITIONS.filter(
    (question) => !Object.hasOwn(answers, question.id),
  );
  if (missing.length > 0) {
    const statePath = options.statePath ?? "smallpen-init.json";
    return {
      answers,
      nextQuestion: publicQuestion(
        missing[0],
        statePath,
        options.locale ?? "zh-TW",
      ),
      pendingQuestionIds: missing.map(({ id }) => id),
      status: "needs_input",
    };
  }
  return {
    proposal: proposal(answers),
    status: "proposal",
  };
}

export const INITIALIZATION_QUESTION_IDS = Object.freeze(
  QUESTION_DEFINITIONS.map(({ id }) => id),
);
