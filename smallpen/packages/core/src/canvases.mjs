// Canvases: the boards a person sees together, one Penpot page each. By
// default every page of the app sits on one canvas, because Penpot links
// and prototype flows only reach boards on the same page. The manifest may
// still list canvases ({id, name, screens: [screenId]}, in order) when the
// agent or a person splits them; pages it does not list go to the default
// canvas. On a canvas each business flow (a module: the part of a page name
// before " / ") is a block of rows, one row per platform, its pages left to
// right in flow order; blocks stack with more room between them. Positions
// are the CLI's, shared by App and CLI, and boards never overlap.
import { fail } from "./errors.mjs";
import { isRecord, stableId } from "./internal.mjs";

export const DEFAULT_CANVAS_NAME = "Pages";
export const DEFAULT_CANVAS_ID = "cnv_pages";
const ROW_GAP = 160; // between the platform rows of one flow
const FLOW_GAP = 480; // between business flows
const BOARD_GAP = 120; // between pages in a row

function slug(text) {
  const ascii = String(text).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/[^\x00-\x7f]/.test(String(text))) return ascii || "x";
  let hash = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(String(text))) hash = Math.imul(hash ^ unit, 0x01000193) >>> 0;
  return [ascii, `u${hash.toString(16).padStart(8, "0")}`].filter(Boolean).join("_");
}

// The business flow a page belongs to: its module, or "" for none.
export function pageFlowName(screen) {
  const parts = String(screen.name ?? "").split(" / ");
  return parts.length > 1 && parts[0].trim() ? parts[0].trim() : "";
}

export function defaultCanvasId(name) {
  return `cnv_${slug(name)}`;
}

export function validateCanvases(value, screenIds) {
  if (value === undefined) return;
  if (!Array.isArray(value)) fail("invalid_canvases", "manifest.canvases must be an array");
  const ids = new Set();
  const placed = new Set();
  for (const [index, canvas] of value.entries()) {
    const path = `manifest.canvases[${index}]`;
    if (!isRecord(canvas)) fail("invalid_canvases", `${path} must contain an object`);
    for (const field of Object.keys(canvas))
      if (!["id", "name", "screens"].includes(field)) fail("invalid_canvases", `${path}.${field} is unsupported`);
    stableId(canvas.id, "cnv_", "invalid_canvas_id", `${path}.id`);
    if (ids.has(canvas.id)) fail("duplicate_canvas_id", `${path}.id repeats ${canvas.id}`);
    ids.add(canvas.id);
    if (typeof canvas.name !== "string" || !canvas.name.trim()) fail("invalid_canvases", `${path}.name must be a non-empty string`);
    if (!Array.isArray(canvas.screens)) fail("invalid_canvases", `${path}.screens must be an array`);
    for (const screenId of canvas.screens) {
      if (typeof screenId !== "string") fail("invalid_canvases", `${path}.screens holds screen ids`);
      if (placed.has(screenId)) fail("duplicate_canvas_screen", `${screenId} is on more than one canvas`);
      placed.add(screenId);
      if (screenIds && !screenIds.has(screenId)) fail("missing_canvas_screen", `${path} lists ${screenId}, which is not a page`);
    }
  }
}

// Every canvas in order with its pages in order: the listed ones first, then
// the default canvas with every page nobody placed.
export function resolveCanvases(manifest, entries) {
  const screens = manifest.entries.screens.map((entry) => entries[entry]).filter(Boolean);
  const byId = new Map(screens.map((screen) => [screen.id, screen]));
  const canvases = (manifest.canvases ?? []).map((canvas) => ({
    explicit: true,
    id: canvas.id,
    name: canvas.name,
    screens: canvas.screens.filter((id) => byId.has(id)),
  }));
  const placed = new Set(canvases.flatMap((canvas) => canvas.screens));
  const rest = screens.filter((screen) => !placed.has(screen.id)).map((screen) => screen.id);
  if (rest.length) {
    let canvas = canvases.find((candidate) => candidate.id === DEFAULT_CANVAS_ID);
    if (!canvas) canvases.push((canvas = { id: DEFAULT_CANVAS_ID, name: DEFAULT_CANVAS_NAME, screens: [] }));
    canvas.screens.push(...rest);
  }
  return canvases;
}

// Pages of one flow in flow order: from the pages a prototype flow starts
// on, along the links between them; pages no link reaches keep their order.
function flowOrder(pageIds, byId, runtime) {
  const members = new Set(pageIds);
  const links = new Map(pageIds.map((id) => [id, []]));
  const starts = [];
  for (const id of pageIds) {
    for (const presentation of byId.get(id).presentations) {
      if ((presentation.prototypeFlows ?? []).length && !starts.includes(id)) starts.push(id);
      const interactions = [
        ...(presentation.interactions ?? []),
        ...Object.values(presentation.nodes ?? {}).flatMap((node) => node.interactions ?? []),
      ];
      for (const interaction of interactions) {
        // A link names its destination board by runtime id (or a screen id).
        const target = interaction.destination?.screenId ?? runtime?.reverseNodes?.[String(interaction.destination)]?.screenId;
        if (target && members.has(target) && target !== id && !links.get(id).includes(target)) links.get(id).push(target);
      }
    }
  }
  const order = [];
  const visit = (id) => {
    if (order.includes(id)) return;
    order.push(id);
    for (const next of links.get(id)) visit(next);
  };
  // Without a flow start, a flow begins at the pages nothing links to.
  const linked = new Set([...links.values()].flat());
  for (const id of starts) visit(id);
  for (const id of pageIds) if (!linked.has(id)) visit(id);
  for (const id of pageIds) visit(id);
  return order;
}

function presentationBox(presentation) {
  const roots = Array.isArray(presentation.rootIds) ? presentation.rootIds : presentation.rootId ? [presentation.rootId] : [];
  const nodes = roots.map((id) => presentation.nodes?.[id]).filter(Boolean);
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0, roots: [] };
  const left = Math.min(...nodes.map((node) => node.x ?? 0));
  const top = Math.min(...nodes.map((node) => node.y ?? 0));
  const right = Math.max(...nodes.map((node) => (node.x ?? 0) + (node.width ?? 0)));
  const bottom = Math.max(...nodes.map((node) => (node.y ?? 0) + (node.height ?? 0)));
  return { x: left, y: top, width: right - left, height: bottom - top, roots };
}

// Where each page version's board sits on its canvas.
export function canvasLayout(manifest, entries, runtime) {
  const byId = new Map(manifest.entries.screens.map((entry) => [entries[entry]?.id, entries[entry]]));
  return resolveCanvases(manifest, entries).map((canvas) => {
    const flows = [];
    for (const id of canvas.screens) {
      const name = pageFlowName(byId.get(id));
      let flow = flows.find((candidate) => candidate.name === name);
      if (!flow) flows.push((flow = { name, pages: [] }));
      flow.pages.push(id);
    }
    const platformOf = (presentation) => presentation.platform ?? presentation.name ?? "";
    const boards = [];
    let y = 0;
    for (const flow of flows) {
      // A listed canvas keeps the order it lists; otherwise flow order.
      const pages = canvas.explicit ? flow.pages : flowOrder(flow.pages, byId, runtime);
      const platforms = [];
      for (const id of pages)
        for (const presentation of byId.get(id).presentations)
          if (!platforms.includes(platformOf(presentation))) platforms.push(platformOf(presentation));
      // Columns line up a page's versions; rows are platforms.
      const boxes = new Map(pages.map((id) => [id, byId.get(id).presentations.map((presentation) => ({ presentation, box: presentationBox(presentation) }))]));
      const columnX = new Map();
      let x = 0;
      for (const id of pages) {
        columnX.set(id, x);
        x += Math.max(0, ...boxes.get(id).map(({ box }) => box.width)) + BOARD_GAP;
      }
      for (const platform of platforms) {
        let rowHeight = 0;
        for (const id of pages)
          for (const { presentation, box } of boxes.get(id)) {
            if (platformOf(presentation) !== platform) continue;
            const left = columnX.get(id);
            boards.push({ screenId: id, presentationId: presentation.id, flow: flow.name, platform, x: left, y, width: box.width, height: box.height, dx: left - box.x, dy: y - box.y });
            rowHeight = Math.max(rowHeight, box.height);
          }
        y += rowHeight + ROW_GAP;
      }
      y += FLOW_GAP - ROW_GAP;
    }
    const { explicit: _explicit, ...rest } = canvas;
    return { ...rest, boards };
  });
}

// The entries with every board moved to its place on its canvas. The App
// draws these and the adapter reads edits against them; stored positions of
// a page's own board do not matter.
export function withCanvasPositions(snapshot) {
  const layout = canvasLayout(snapshot.manifest, snapshot.entries, snapshot.runtime);
  const entries = { ...snapshot.entries };
  for (const entry of snapshot.manifest.entries.screens) {
    const screen = entries[entry];
    let copy;
    for (const [index, presentation] of screen.presentations.entries()) {
      const board = layout.flatMap((canvas) => canvas.boards).find((item) => item.presentationId === presentation.id && item.screenId === screen.id);
      if (!board || (board.dx === 0 && board.dy === 0)) continue;
      copy ??= { ...screen, presentations: [...screen.presentations] };
      const nodes = { ...presentation.nodes };
      for (const root of presentationBox(presentation).roots)
        nodes[root] = { ...nodes[root], x: (nodes[root].x ?? 0) + board.dx, y: (nodes[root].y ?? 0) + board.dy };
      copy.presentations[index] = { ...presentation, nodes };
    }
    if (copy) entries[entry] = copy;
  }
  return { ...snapshot, entries, canvases: layout };
}

// The canvas list with one change, as the manifest stores it: every canvas
// listed, so order and membership are explicit once a person or the CLI
// arranges them.
export function explicitCanvases(manifest, entries) {
  return resolveCanvases(manifest, entries).map(({ id, name, screens }) => ({ id, name, screens: [...screens] }));
}

// --- by name, for the CLI ---------------------------------------------------

function canvasByName(canvases, name) {
  const found = canvases.find((canvas) => canvas.name.toLowerCase() === String(name).trim().toLowerCase());
  return found;
}

// The canvas list with a page placed on a named canvas (made when missing),
// at the end of its flow. screenId may be a page drawn in the same batch.
export function placePageOnCanvas(manifest, entries, screenId, canvasName) {
  const canvases = explicitCanvases(manifest, entries).map((canvas) => ({
    ...canvas,
    screens: canvas.screens.filter((id) => id !== screenId),
  }));
  let target = canvasByName(canvases, canvasName);
  if (!target) {
    target = { id: defaultCanvasId(canvasName), name: String(canvasName).trim(), screens: [] };
    while (canvases.some((canvas) => canvas.id === target.id)) target.id = `${target.id}_2`;
    canvases.push(target);
  }
  target.screens.push(screenId);
  return { canvases, type: "put-canvases" };
}

export function renameCanvasOperation(manifest, entries, name, to) {
  const canvases = explicitCanvases(manifest, entries);
  const canvas = canvasByName(canvases, name);
  if (!canvas)
    fail("unknown_canvas", `No canvas ${name}`, { canvases: canvases.map((item) => item.name) });
  if (!String(to ?? "").trim()) fail("invalid_canvas_name", "--to names the new name");
  // A name already taken is numbered by the batch, as in the App.
  canvas.name = String(to).trim();
  return { canvases, type: "put-canvases" };
}

// A page one or more places left or right in its business flow's row.
export function reorderPageOperation(manifest, entries, screenId, direction, steps = 1, runtime) {
  if (direction !== "left" && direction !== "right")
    fail("move_across_layout", "A page moves left or right within its business flow; its flow is the part of its name before \" / \"");
  const layout = canvasLayout(manifest, entries, runtime);
  const canvas = layout.find((item) => item.boards.some((board) => board.screenId === screenId));
  const flow = canvas.boards.find((board) => board.screenId === screenId).flow;
  const row = [...new Set(canvas.boards.filter((board) => board.flow === flow).map((board) => board.screenId))];
  const from = row.indexOf(screenId);
  const to = Math.max(0, Math.min(row.length - 1, from + (direction === "left" ? -steps : steps)));
  if (to === from) fail("nothing_to_move_past", `The page is already ${direction === "left" ? "first" : "last"} in its flow`);
  row.splice(from, 1);
  row.splice(to, 0, screenId);
  const canvases = explicitCanvases(manifest, entries);
  const target = canvases.find((item) => item.id === canvas.id);
  let index = 0;
  target.screens = target.screens.map((id) => (row.includes(id) ? row[index++] : id));
  return { canvases, type: "put-canvases" };
}
