import { fail } from "./errors.mjs";
import { isRecord, ownValue } from "./internal.mjs";
import { projectScreen } from "./design-projection.mjs";

export const PROTOTYPE_EVENTS = Object.freeze([
  "click",
  "mouse-enter",
  "mouse-leave",
  "after-delay",
  "mouse-press",
  "mouse-over",
]);
export const PROTOTYPE_ACTIONS = Object.freeze([
  "navigate",
  "open-overlay",
  "toggle-overlay",
  "close-overlay",
  "prev-screen",
  "open-url",
]);
const DESTINATION_ACTIONS = ["navigate", "open-overlay", "toggle-overlay"];
const FIELDS = [
  "event-type",
  "action-type",
  "destination",
  "delay",
  "preserve-scroll",
  "animation",
  "overlay-position",
  "overlay-pos-type",
  "close-click-outside",
  "background-overlay",
  "position-relative-to",
  "url",
];

function record(value, fields, label) {
  if (!isRecord(value))
    fail("invalid_prototype_input", `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length)
    fail(
      "unknown_prototype_field",
      `${label} has unknown fields: ${unknown.join(", ")}`,
      { allowedFields: fields },
    );
}
function presentationOf(snapshot, selector = {}) {
  const screenId = selector.screenId ?? snapshot.manifest.defaultScreenId;
  const screen = snapshot.manifest.entries.screens
    .map((entry) => snapshot.entries[entry])
    .find((screen) => screen.id === screenId);
  if (!screen) fail("missing_screen", `No Screen ${screenId}`);
  const presentationId = selector.presentationId ?? screen.basePresentationId;
  const presentation = screen.presentations.find(
    (p) => p.id === presentationId,
  );
  if (!presentation)
    fail(
      "missing_presentation",
      `No Presentation ${presentationId} in ${screenId}`,
    );
  return { screen, presentation };
}
function targetOf(snapshot, reference, frame = true) {
  record(reference, ["screenId", "presentationId", "nodeId"], "destination");
  if (typeof reference.screenId !== "string")
    fail("invalid_prototype_destination", "destination requires a screenId");
  const { screen, presentation } = presentationOf(snapshot, reference);
  const nodeId =
    reference.nodeId ?? presentation.rootId ?? presentation.rootIds?.[0];
  const node = ownValue(presentation.nodes, nodeId);
  if (!node) fail("missing_node", `No destination Node ${nodeId}`);
  if (frame && node.type !== "FRAME")
    fail(
      "invalid_prototype_destination",
      "Prototype destinations must be FRAME nodes",
    );
  return { screenId: screen.id, presentationId: presentation.id, nodeId };
}
function runtimeId(snapshot, target) {
  const id =
    snapshot.runtime.nodes?.[target.screenId]?.[target.presentationId]?.[
      target.nodeId
    ];
  if (!id)
    fail("missing_runtime_node", `No runtime identity for ${target.nodeId}`);
  return id;
}
function runtimeTarget(snapshot, id, frame = true) {
  const target = snapshot.runtime.reverseNodes?.[id];
  if (!target)
    fail(
      "missing_prototype_destination",
      "This link names a page or element that is not in the package",
      { runtimeId: id },
    );
  return targetOf(snapshot, target, frame);
}
function selectedProjection(snapshot, target, options) {
  const initial = options.initialProjection;
  if (
    initial?.screenId === target.screenId &&
    initial.presentationId === target.presentationId
  )
    return initial;
  return projectScreen(snapshot, target.screenId, {
    ...options,
    presentationId: target.presentationId,
  });
}

function checkPrototypeInteraction(
  snapshot,
  source,
  interaction,
  sourceTarget,
) {
  record(interaction, FIELDS, "interaction");
  if (!PROTOTYPE_EVENTS.includes(interaction["event-type"]))
    fail(
      "invalid_interaction_trigger",
      "Unsupported native prototype trigger",
      { validTriggers: PROTOTYPE_EVENTS },
    );
  if (!PROTOTYPE_ACTIONS.includes(interaction["action-type"]))
    fail(
      "unsupported_interaction_action",
      "Unsupported native prototype action",
      { validActions: PROTOTYPE_ACTIONS },
    );
  if (interaction["event-type"] === "after-delay") {
    if (source.type !== "FRAME")
      fail(
        "invalid_interaction_trigger",
        "after-delay requires a FRAME source",
      );
    if (
      !Number.isSafeInteger(interaction.delay ?? 600) ||
      (interaction.delay ?? 600) < 0
    )
      fail(
        "invalid_interaction_delay",
        "delay must be a nonnegative integer in milliseconds",
      );
  }
  for (const field of [
    "preserve-scroll",
    "close-click-outside",
    "background-overlay",
  ])
    if (
      interaction[field] !== undefined &&
      typeof interaction[field] !== "boolean"
    )
      fail("invalid_interaction_option", `${field} must be boolean`);
  if (DESTINATION_ACTIONS.includes(interaction["action-type"])) {
    const target = runtimeTarget(snapshot, interaction.destination);
    // An overlay is another page drawn over this one: its root board, the
    // way the App shows a board of the same canvas as an overlay.
    if (
      sourceTarget &&
      interaction["action-type"] !== "navigate" &&
      target.screenId === sourceTarget.screenId &&
      target.presentationId === sourceTarget.presentationId
    )
      fail(
        "invalid_prototype_destination",
        "An overlay opens another page, not the page it is on",
      );
  }
  if (interaction["action-type"] === "close-overlay" && interaction.destination)
    runtimeTarget(snapshot, interaction.destination);
  if (interaction["position-relative-to"])
    runtimeTarget(snapshot, interaction["position-relative-to"], false);
  if (
    interaction["action-type"] === "open-url" &&
    (typeof interaction.url !== "string" || !interaction.url.trim())
  )
    fail("invalid_interaction_url", "open-url requires a nonempty url");
  if (
    interaction["overlay-pos-type"] !== undefined &&
    ![
      "manual",
      "center",
      "top-left",
      "top-right",
      "top-center",
      "bottom-left",
      "bottom-right",
      "bottom-center",
    ].includes(interaction["overlay-pos-type"])
  )
    fail("invalid_overlay_position", "Invalid overlay-pos-type");
  if (interaction["overlay-position"] !== undefined) {
    const position = interaction["overlay-position"];
    record(position, ["x", "y"], "overlay-position");
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
      fail(
        "invalid_overlay_position",
        "overlay-position requires finite x and y",
      );
  }
  if (interaction.animation !== undefined) {
    const a = interaction.animation;
    record(
      a,
      [
        "animation-type",
        "duration",
        "easing",
        "way",
        "direction",
        "offset-effect",
      ],
      "animation",
    );
    if (
      !["dissolve", "slide", "push"].includes(a["animation-type"]) ||
      !Number.isSafeInteger(a.duration) ||
      a.duration < 0 ||
      !["linear", "ease", "ease-in", "ease-out", "ease-in-out"].includes(
        a.easing,
      )
    )
      fail(
        "invalid_interaction_animation",
        "animation requires type, duration and easing",
      );
    if (
      a.direction !== undefined &&
      !["left", "right", "up", "down"].includes(a.direction)
    )
      fail("invalid_interaction_animation", "Invalid animation direction");
    if (a.way !== undefined && !["in", "out"].includes(a.way))
      fail("invalid_interaction_animation", "Invalid animation way");
    if (
      a["offset-effect"] !== undefined &&
      typeof a["offset-effect"] !== "boolean"
    )
      fail("invalid_interaction_animation", "offset-effect must be boolean");
    if (
      a["animation-type"] === "slide" &&
      (a.way === undefined ||
        a.direction === undefined ||
        a["offset-effect"] === undefined)
    )
      fail(
        "invalid_interaction_animation",
        "slide requires way, direction and offset-effect",
      );
    if (
      a["animation-type"] === "push" &&
      (interaction["action-type"] !== "navigate" || a.direction === undefined)
    )
      fail(
        "invalid_interaction_animation",
        "push requires navigate and direction",
      );
  }
  return interaction;
}

// Shared by the App's web projection and CLI reading/execution. A condition
// must never disappear while converting canonical interactions to native ones.
export function projectPrototypeInteraction(
  snapshot,
  presentation,
  interaction,
) {
  if (interaction.condition)
    fail(
      "unsupported_interaction_condition",
      `App prototype cannot execute condition on ${interaction.id}`,
    );
  if (
    interaction.trigger !== "activate" ||
    interaction.action?.type !== "navigate"
  )
    fail(
      "unsupported_interaction_action",
      `App prototype cannot execute ${interaction.trigger}/${interaction.action?.type}`,
    );
  if (interaction.action.screen.packageId !== snapshot.manifest.packageId)
    fail(
      "missing_prototype_destination",
      "Prototype targets must belong to this project",
    );
  const source = {
    screenId: presentation.screenId,
    presentationId: presentation.id,
    nodeId: interaction.sourceNodeId,
  };
  const target = targetOf(snapshot, {
    screenId: interaction.action.screen.assetId,
    presentationId: interaction.action.presentationId,
  });
  return {
    "action-type": "navigate",
    "event-type": "click",
    destination: runtimeId(snapshot, target),
    "position-relative-to": runtimeId(snapshot, source),
    "preserve-scroll": false,
  };
}

export const INTERACTION_INTENT_ACTIONS = Object.freeze({
  "set-start": {
    fields: ["screenId", "presentationId?", "flow"],
    purpose:
      "Add or replace {id:UUID,name,startingNodeId:FRAME} in the App's prototype starts",
  },
  "delete-start": {
    fields: ["screenId", "presentationId?", "flowId"],
    purpose: "Delete one named prototype start",
  },
  "set-interaction": {
    fields: ["screenId", "presentationId?", "nodeId", "sourcePath?", "index?", "interaction"],
    purpose:
      "Append native interaction or replace index on one node; stable destination references become App UUIDs",
  },
  "delete-interaction": {
    fields: ["screenId", "presentationId?", "nodeId", "sourcePath?", "index"],
    purpose: "Remove one native interaction by node and index",
  },
});

export function prototypeConnections(snapshot, selector = {}, options = {}) {
  const { screen, presentation } = presentationOf(snapshot, selector);
  const target = { screenId: screen.id, presentationId: presentation.id };
  const projection = selectedProjection(snapshot, target, options);
  const nodes = projection.nodes;
  const scope = selector.nodeId
    ? descendants({ nodes }, selector.nodeId, false)
    : undefined;
  const connections = [],
    issues = [];
  const add = (source, native, identity) => {
    try {
      checkPrototypeInteraction(snapshot, source, native, target);
      connections.push({
        ...target,
        nodeId: source.id,
        name: source.name,
        ...identity,
        trigger: native["event-type"],
        action: native["action-type"],
        ...(DESTINATION_ACTIONS.includes(native["action-type"]) ||
        (native["action-type"] === "close-overlay" && native.destination)
          ? { target: runtimeTarget(snapshot, native.destination) }
          : {}),
        ...(native["event-type"] === "after-delay"
          ? { delay: native.delay ?? 600 }
          : {}),
        ...(native["action-type"] === "open-url" ? { url: native.url } : {}),
        configuration: structuredClone(native),
      });
    } catch (error) {
      issues.push({
        code: error.code ?? "invalid_interaction",
        severity: "error",
        message: error.message,
        ...target,
        nodeId: source.id,
        ...identity,
      });
    }
  };
  for (const source of Object.values(nodes)) {
    if (scope && !scope.has(source.id)) continue;
    for (const [index, native] of (source.interactions ?? []).entries())
      add(source, native, { index });
    for (const interaction of (presentation.interactions ?? []).filter(
      (i) => i.sourceNodeId === source.id,
    )) {
      try {
        add(
          source,
          projectPrototypeInteraction(
            snapshot,
            { ...presentation, screenId: screen.id },
            interaction,
          ),
          { interactionId: interaction.id },
        );
      } catch (error) {
        issues.push({
          code: error.code ?? "invalid_interaction",
          severity: "error",
          message: error.message,
          ...target,
          nodeId: source.id,
          interactionId: interaction.id,
        });
      }
    }
  }
  if (selector.nodeId && !ownValue(nodes, selector.nodeId))
    fail("missing_node", `No source ${selector.nodeId}`);
  for (const flow of presentation.prototypeFlows ?? []) {
    try {
      targetOf(snapshot, { ...target, nodeId: flow.startingNodeId });
    } catch (error) {
      issues.push({
        code: error.code,
        severity: "error",
        message: error.message,
        ...target,
        flowId: flow.id,
      });
    }
  }
  return {
    target,
    starts: structuredClone(presentation.prototypeFlows ?? []),
    connections,
    issues,
    issueCount: issues.length,
  };
}

function descendants(presentation, rootId, visibleOnly = true) {
  const result = new Set();
  const walk = (id) => {
    const node = ownValue(presentation.nodes, id);
    if (!node || (visibleOnly && node.visible === false) || result.has(id))
      return;
    result.add(id);
    for (const child of node.children ?? []) walk(child);
  };
  walk(rootId);
  return result;
}
