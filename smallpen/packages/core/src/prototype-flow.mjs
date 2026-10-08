import { fail } from "./errors.mjs";
import { isRecord, ownValue } from "./internal.mjs";
import { projectScreen } from "./design-projection.mjs";
import { canonicalJSON } from "./canonical.mjs";

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
      `No local prototype target for ${id}`,
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

export function checkPrototypeInteraction(
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
    if (
      sourceTarget &&
      interaction["action-type"] !== "navigate" &&
      (target.screenId !== sourceTarget.screenId ||
        target.presentationId !== sourceTarget.presentationId)
    )
      fail(
        "unsupported_cross_page_overlay",
        "The App opens overlays only within the source Presentation; navigate for cross-page connections",
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

export function validatePrototypeChanges(before, after) {
  const errors = (snapshot) => {
    const issues = [];
    for (const entry of snapshot.manifest.entries.screens) {
      const screen = snapshot.entries[entry];
      for (const presentation of screen.presentations) {
        const target = { screenId: screen.id, presentationId: presentation.id };
        const check = (source, interaction, index, canonical = false) => {
          try {
            const native = canonical
              ? projectPrototypeInteraction(
                  snapshot,
                  { ...presentation, screenId: screen.id },
                  interaction,
                )
              : interaction;
            checkPrototypeInteraction(snapshot, source, native, target);
          } catch (error) {
            issues.push({
              ...target,
              nodeId: source.id,
              index,
              code: error.code ?? "invalid_interaction",
              message: error.message,
              configuration: interaction,
            });
          }
        };
        for (const source of Object.values(presentation.nodes))
          for (const [index, interaction] of (
            source.interactions ?? []
          ).entries())
            check(source, interaction, index);
        for (const [index, interaction] of presentation.interactions.entries())
          check(
            ownValue(presentation.nodes, interaction.sourceNodeId),
            interaction,
            index,
            true,
          );
      }
    }
    return issues;
  };
  // Preserve an already incomplete App connection during unrelated writes.
  // A changed configuration or newly broken target cannot silently enter it.
  const key = ({ index: _index, ...issue }) => canonicalJSON(issue);
  const known = new Map();
  for (const issue of errors(before))
    known.set(key(issue), (known.get(key(issue)) ?? 0) + 1);
  const introduced = errors(after).filter((issue) => {
    const count = known.get(key(issue)) ?? 0;
    if (count) {
      known.set(key(issue), count - 1);
      return false;
    }
    return true;
  });
  if (introduced.length)
    fail(
      "invalid_prototype_connection",
      "The edit introduces prototype behavior the App cannot execute",
      { issueCount: introduced.length, issues: introduced.slice(0, 20) },
    );
}

export function interactionIntentOperations(snapshot, intent) {
  const contract = ownValue(INTERACTION_INTENT_ACTIONS, intent?.action);
  if (!contract)
    fail(
      "invalid_interaction_intent",
      "Use set-start/delete-start/set-interaction/delete-interaction",
    );
  record(
    intent,
    ["action", ...contract.fields.map((f) => f.replace(/\?$/, ""))],
    "intent",
  );
  if (typeof intent.screenId !== "string")
    fail(
      "invalid_interaction_intent",
      "An interaction write requires screenId",
    );
  const { screen, presentation } = presentationOf(snapshot, intent);
  const target = { screenId: screen.id, presentationId: presentation.id };
  if (intent.action.endsWith("start")) {
    const flows = structuredClone(presentation.prototypeFlows ?? []);
    const id = intent.action === "set-start" ? intent.flow?.id : intent.flowId;
    const index = flows.findIndex((flow) => flow.id === id);
    if (intent.action === "delete-start") {
      if (index < 0) fail("missing_prototype_flow", `No prototype start ${id}`);
      flows.splice(index, 1);
    } else {
      record(intent.flow, ["id", "name", "startingNodeId"], "flow");
      if (typeof intent.flow.startingNodeId !== "string")
        fail("invalid_prototype_flow", "flow requires startingNodeId");
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          id,
        ) ||
        typeof intent.flow.name !== "string" ||
        !intent.flow.name.trim()
      )
        fail(
          "invalid_prototype_flow",
          "flow requires UUID id and nonempty name",
        );
      targetOf(snapshot, { ...target, nodeId: intent.flow.startingNodeId });
      if (index < 0) flows.push(structuredClone(intent.flow));
      else flows[index] = structuredClone(intent.flow);
    }
    return [
      {
        type: "update-presentation",
        ...target,
        changes: { prototypeFlows: flows },
      },
    ];
  }
  const stored = ownValue(presentation.nodes, intent.nodeId);
  if (!stored) fail("missing_node", `No interaction source ${intent.nodeId}`);
  // sourcePath: an element inside a copy of a component. Its links are the
  // copy's override "<sourcePath>:interactions".
  const overridePath = intent.sourcePath === undefined ? undefined : `${intent.sourcePath}:interactions`;
  if (overridePath !== undefined && !stored.instance)
    fail("invalid_interaction_intent", "sourcePath names an element inside a copy; nodeId must be the copy");
  const source = overridePath === undefined ? stored : { id: `${stored.id}__${intent.sourcePath}`, type: "COPY_CHILD" };
  const interactions = structuredClone(
    (overridePath === undefined ? source.interactions : stored.instance.overrides?.[overridePath]) ?? [],
  );
  const index = intent.index ?? interactions.length;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > interactions.length ||
    (intent.action === "delete-interaction" && index === interactions.length)
  )
    fail(
      "invalid_interaction_index",
      "index must identify an existing interaction, or append for set-interaction",
    );
  if (intent.action === "delete-interaction") interactions.splice(index, 1);
  else {
    record(intent.interaction, FIELDS, "interaction");
    const native = structuredClone(intent.interaction);
    if (native["event-type"] === "after-delay") native.delay ??= 600;
    for (const field of ["destination", "position-relative-to"]) {
      if (isRecord(native[field]))
        native[field] = runtimeId(
          snapshot,
          targetOf(snapshot, native[field], field === "destination"),
        );
    }
    if (["open-overlay", "toggle-overlay"].includes(native["action-type"])) {
      native["overlay-pos-type"] ??= "center";
      native["overlay-position"] ??= { x: 0, y: 0 };
      native["position-relative-to"] ??= runtimeId(snapshot, {
        ...target,
        nodeId: source.id,
      });
    }
    checkPrototypeInteraction(snapshot, source, native, target);
    if (index === interactions.length) interactions.push(native);
    else interactions[index] = native;
  }
  if (overridePath !== undefined)
    return [
      interactions.length
        ? { type: "set-instance-override", ...target, nodeId: stored.id, overridePath, value: interactions }
        : { type: "clear-instance-override", ...target, nodeId: stored.id, overridePath },
    ];
  return [
    {
      type: "update-presentation-node",
      ...target,
      nodeId: source.id,
      changes: { interactions },
    },
  ];
}

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
const sameTarget = (a, b) =>
  a.screenId === b.screenId &&
  a.presentationId === b.presentationId &&
  a.nodeId === b.nodeId;
function sourceFrame(presentation, sourceId, current, overlays) {
  const source = ownValue(presentation.nodes, sourceId);
  if (
    ["FRAME", "INSTANCE"].includes(source?.type) &&
    overlays.some(
      (target) =>
        target.nodeId === sourceId &&
        target.screenId === current.screenId &&
        target.presentationId === current.presentationId,
    )
  )
    return { ...current, nodeId: sourceId };
  let id = sourceId;
  const visited = new Set();
  while (!visited.has(id)) {
    visited.add(id);
    const parent = Object.values(presentation.nodes).find((node) =>
      node.children?.includes(id),
    );
    if (!parent) break;
    if (["FRAME", "INSTANCE"].includes(parent.type))
      return { ...current, nodeId: parent.id };
    id = parent.id;
  }
  return current;
}

export function verifyPrototypeFlow(
  snapshot,
  input,
  selector = {},
  options = {},
) {
  record(input, ["steps"], "flow steps");
  if (
    !Array.isArray(input.steps) ||
    input.steps.length < 1 ||
    input.steps.length > 1000
  )
    fail(
      "invalid_flow_steps",
      "steps must contain 1 to 1000 explicit operations",
    );
  const initial = presentationOf(snapshot, selector);
  let start = {
    screenId: initial.screen.id,
    presentationId: initial.presentation.id,
    nodeId: initial.presentation.rootId ?? initial.presentation.rootIds?.[0],
  };
  if (selector.flowId) {
    const flow = initial.presentation.prototypeFlows?.find(
      (f) => f.id === selector.flowId,
    );
    if (!flow)
      fail("missing_prototype_flow", `No prototype start ${selector.flowId}`);
    start.nodeId = flow.startingNodeId;
  }
  const state = {
      target: targetOf(snapshot, start),
      history: [],
      overlays: [],
    },
    reports = [];
  const projectionCache = new Map();
  const projectedPresentation = (target) => {
    const key = `${target.screenId}/${target.presentationId}`;
    if (!projectionCache.has(key))
      projectionCache.set(
        key,
        selectedProjection(snapshot, target, options).presentation,
      );
    return projectionCache.get(key);
  };
  const finish = (status) => ({
    status,
    target: start,
    stepCount: reports.length,
    requestedStepCount: input.steps.length,
    steps: reports,
    stateSaved: false,
    coverage: {
      checks: [
        "visible-source",
        "native-trigger",
        "connection-target",
        "navigation-history",
        "overlay-state",
        "explicit-expectations",
      ],
      skipped: [
        {
          check: "animation-pixels",
          reason:
            "Configuration is validated; this text verifier does not play rendered animations or open external URLs.",
        },
      ],
    },
  });
  for (const [index, step] of input.steps.entries()) {
    const before = structuredClone(state);
    try {
      record(
        step,
        [
          "nodeId",
          "trigger",
          "phase",
          "index",
          "interactionId",
          "waitMs",
          "expect",
        ],
        `steps[${index}]`,
      );
      const trigger = step.trigger ?? "click";
      if (!PROTOTYPE_EVENTS.includes(trigger))
        fail(
          "invalid_interaction_trigger",
          `Unsupported step trigger ${trigger}`,
        );
      if (
        typeof step.nodeId !== "string" ||
        (step.index !== undefined &&
          (!Number.isInteger(step.index) || step.index < 0)) ||
        (step.interactionId !== undefined &&
          typeof step.interactionId !== "string")
      )
        fail(
          "invalid_flow_steps",
          "A step requires a nodeId and valid optional index/interactionId",
        );
      if (step.index !== undefined && step.interactionId !== undefined)
        fail("invalid_flow_steps", "Choose index or interactionId, not both");
      const phase = step.phase ?? "activate";
      if (
        !["activate", "deactivate"].includes(phase) ||
        (phase === "deactivate" &&
          !["mouse-press", "mouse-over"].includes(trigger))
      )
        fail(
          "invalid_flow_phase",
          "deactivate is the release/leave phase of mouse-press/mouse-over only",
        );
      let sourceTarget;
      for (const target of [...state.overlays]
        .reverse()
        .concat([state.target])) {
        const presentation = projectedPresentation(target);
        if (descendants(presentation, target.nodeId).has(step.nodeId)) {
          sourceTarget = target;
          break;
        }
      }
      if (!sourceTarget)
        fail(
          "unavailable_interaction_source",
          `Node ${step.nodeId} is not visible in the current page or overlay`,
        );
      const read = prototypeConnections(
        snapshot,
        { ...sourceTarget, nodeId: step.nodeId },
        options,
      );
      const invalid = read.issues.find((issue) => issue.nodeId === step.nodeId);
      if (invalid) fail(invalid.code, invalid.message);
      const matches = read.connections.filter(
        (c) =>
          c.nodeId === step.nodeId &&
          c.trigger === trigger &&
          (step.index === undefined || c.index === step.index) &&
          (step.interactionId === undefined ||
            c.interactionId === step.interactionId),
      );
      if (!matches.length)
        fail(
          "missing_interaction",
          `No ${trigger} interaction on ${step.nodeId}`,
        );
      const actions = [];
      for (const connection of matches) {
        if (
          trigger === "after-delay" &&
          (!Number.isFinite(step.waitMs) || step.waitMs < connection.delay)
        )
          fail(
            "interaction_delay_pending",
            `Wait at least ${connection.delay} milliseconds before this trigger`,
          );
        const action =
          phase === "activate"
            ? connection.action
            : ({
                "open-overlay": "close-overlay",
                "close-overlay": "open-overlay",
                "toggle-overlay": "toggle-overlay",
              }[connection.action] ?? "none");
        if (action === "navigate") {
          state.history.push(structuredClone(state.target));
          state.target = structuredClone(connection.target);
          state.overlays = [];
        } else if (action === "prev-screen") {
          if (!state.history.length)
            fail(
              "missing_previous_screen",
              "No previous page in this verification session",
            );
          state.target = state.history.pop();
          state.overlays = [];
        } else if (action === "open-overlay" || action === "toggle-overlay") {
          if (!connection.target) continue;
          const at = state.overlays.findIndex((target) =>
            sameTarget(target, connection.target),
          );
          if (at >= 0 && action === "toggle-overlay")
            state.overlays.splice(at, 1);
          else if (at < 0)
            state.overlays.push(structuredClone(connection.target));
        } else if (action === "close-overlay") {
          const target =
            connection.target ??
            sourceFrame(
              projectedPresentation(sourceTarget),
              step.nodeId,
              sourceTarget,
              state.overlays,
            );
          state.overlays = state.overlays.filter(
            (overlay) => !sameTarget(overlay, target),
          );
        } else if (action === "open-url") state.externalUrl = connection.url;
        actions.push({
          action,
          ...(connection.target ? { target: connection.target } : {}),
          ...(connection.url ? { url: connection.url } : {}),
        });
      }
      if (step.expect !== undefined) {
        record(
          step.expect,
          ["screenId", "presentationId", "nodeId", "overlays", "externalUrl"],
          "expect",
        );
        for (const [key, expected] of Object.entries(step.expect)) {
          const actual =
            key === "overlays" || key === "externalUrl"
              ? state[key]
              : state.target[key];
          if (canonicalJSON(actual) !== canonicalJSON(expected))
            fail("flow_expectation_failed", `Expected ${key} does not match`, {
              field: key,
              expected,
              actual,
            });
        }
      }
      reports.push({
        index,
        nodeId: step.nodeId,
        trigger,
        phase,
        actions,
        status: "passed",
        result: {
          target: structuredClone(state.target),
          overlays: structuredClone(state.overlays),
          ...(state.externalUrl ? { externalUrl: state.externalUrl } : {}),
        },
      });
    } catch (error) {
      reports.push({
        index,
        nodeId: step.nodeId,
        status: "failed",
        before: { target: before.target, overlays: before.overlays },
        error: {
          code: error.code ?? "flow_step_failed",
          message: error.message,
          details: error.details ?? {},
        },
        result: { target: state.target, overlays: state.overlays },
      });
      return { ...finish("failed"), failedStep: index };
    }
  }
  return finish("passed");
}
