// INPUT:  selected workspace snapshots, native render callback, output directory
// OUTPUT: offline HTML review, per-page native evidence, manifest receipt
// POS:    Read-only review export; navigation uses measured geometry only
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJSON, findPage, findPresentation, pageFlowName,
  prototypeConnections, resolveCanvases, SmallPenError,
} from "@smallpen/core";
import { openPackage } from "./local-package.mjs";
import { reviewDocument, reviewScript, reviewStyle } from "./html-review-viewer.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const key = target => `${target.screenId}\0${target.presentationId}`;
const within = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const fail = (code, message, details) => { throw new SmallPenError(code, message, details); };

// Resolve existing ancestors too: an output symlink must not bypass the
// prohibition on adding review files to a Canonical Package.
async function physicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await physicalPath(parent), relative(parent, path));
  }
}

export function htmlReviewTargets(product, { page, canvas, platform } = {}) {
  if (page !== undefined && canvas !== undefined)
    fail("too_many_review_targets", "Choose --page or --canvas, not both");
  if (platform !== undefined && page === undefined)
    fail("incomplete_view_target", "--platform needs --page");
  const canvases = resolveCanvases(product.manifest, product.entries);
  let screens, scope;
  if (page !== undefined) {
    screens = [findPage(product, page)];
    scope = { page: screens[0].name };
  } else {
    const matches = canvas === undefined ? canvases : canvases.filter(item => item.name === canvas);
    if (matches.length !== 1)
      fail(matches.length ? "ambiguous_review_canvas" : "unknown_canvas",
        "Choose one canvas for HTML export with --canvas NAME",
        { canvases: canvases.map(item => item.name) });
    const chosen = matches[0];
    const byId = new Map(product.manifest.entries.screens.map(entry => [product.entries[entry].id, product.entries[entry]]));
    screens = chosen.screens.map(id => byId.get(id));
    scope = { canvas: chosen.name };
  }
  const targets = screens.flatMap(screen =>
    (platform === undefined ? screen.presentations : [findPresentation(screen, platform)])
      .map(presentation => ({ screen, presentation,
        screenId: screen.id, presentationId: presentation.id })));
  if (!targets.length) fail("empty_review", "The selected scope has no page versions");
  return { targets, scope };
}

// Triggers and actions the offline review can play: the App's names.
const REVIEW_TRIGGERS = ["click", "mouse-press", "mouse-over", "mouse-enter", "mouse-leave", "after-delay"];
const REVIEW_ACTIONS = ["navigate", "prev-screen", "open-overlay", "toggle-overlay", "close-overlay", "open-url"];

function parentOf(nodes, id) {
  for (const [key, node] of Object.entries(nodes)) if (node.children?.includes(id)) return key;
  return undefined;
}

function region(snapshot, nodeId, width, height) {
  const node = snapshot.nodes[nodeId], box = node?.bounds, viewport = snapshot.viewport;
  if (node?.status !== "resolved" || node.visible === false || !box || !viewport ||
      ![box.x, box.y, box.width, box.height, viewport.x, viewport.y, viewport.width, viewport.height]
        .every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return null;
  const x = Math.max(0, (box.x - viewport.x) / viewport.width);
  const y = Math.max(0, (box.y - viewport.y) / viewport.height);
  const right = Math.min(1, (box.x + box.width - viewport.x) / viewport.width);
  const bottom = Math.min(1, (box.y + box.height - viewport.y) / viewport.height);
  if (right <= x || bottom <= y) return null;
  return { x: x * width, y: y * height, width: (right - x) * width, height: (bottom - y) * height };
}

// renderTarget supplies the CLI's existing spec/wireframe/native evidence
// pipeline. One callback per version supplies all artifacts and its geometry;
// this module never does a second measurement or falls back to authored boxes.
export async function exportHtmlReview(workspace, options, renderTarget) {
  const { product } = workspace;
  if (!options.output) fail("missing_review_output", "HTML export requires --output DIR");
  const selected = htmlReviewTargets(product, options);
  const output = resolve(options.output), physical = await physicalPath(output);
  const owners = [...new Set([product, workspace.foundation, ...(workspace.libraries ?? [])].filter(Boolean))];
  for (const owner of owners) {
    if (isAbsolute(owner.locator) && within(await physicalPath(owner.locator), physical))
      fail("review_output_inside_package", "HTML output must be outside every source .smallpen Package", { output });
  }
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(output)).length)
      fail("review_output_exists", "HTML output must be a new or empty directory; existing files are never replaced", { output });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(join(output, "pages"), { recursive: true });
  const files = [];
  const write = async (path, data) => {
    await writeFile(join(output, path), data, { flag: "wx" });
    files.push({ path, sha256: sha256(data), bytes: Buffer.byteLength(data) });
  };
  const targetsByKey = new Map(selected.targets.map((target, index) => [key(target), { ...target, id: `page-${index + 1}` }]));
  const pages = [], starts = [], unresolved = [];
  for (const target of targetsByKey.values()) {
    options.progress?.({ type: "html-export-progress", event: "page", total: selected.targets.length,
      completed: pages.length, target: target.screen.name, platform: target.presentation.platform ?? target.presentation.name });
    const result = await renderTarget(target);
    const { snapshot, render, projection, tree, selection } = result;
    if (snapshot.revision !== product.revision || selection.screenId !== target.screenId ||
        selection.presentationId !== target.presentationId ||
        snapshot.selection.screenId !== target.screenId || snapshot.selection.presentationId !== target.presentationId ||
        snapshot.selection.themes?.join("\0") !== selection.themes?.join("\0") ||
        sha256(render.bytes) !== render.renderHash)
      fail("inconsistent_review_evidence", "HTML review requires the selected revision and one native solve for every page");
    const prefix = `pages/${String(pages.length + 1).padStart(4, "0")}`;
    const artifacts = { image: `${prefix}.png`, spec: `${prefix}.spec.txt`,
      wireframe: `${prefix}.wireframe.txt`, evidence: `${prefix}.evidence.json` };
    const native = prototypeConnections(product, target, { ...workspace, initialProjection: projection });
    const sourceCounts = new Map();
    for (const connection of native.connections)
      sourceCounts.set(`${connection.nodeId}\0${connection.trigger}`, (sourceCounts.get(`${connection.nodeId}\0${connection.trigger}`) ?? 0) + 1);
    // Elements by name path, as the files name them.
    const where = (nodeId) => {
      const path = [];
      for (let at = nodeId; at && at !== (target.presentation.rootId ?? target.presentation.rootIds?.[0]); at = parentOf(projection.nodes, at))
        path.unshift(projection.nodes[at]?.name ?? "element");
      return path.join(" › ") || target.screen.name;
    };
    const links = native.connections.map(connection => {
      const root = target.presentation.rootId ?? target.presentation.rootIds?.[0];
      // A delay starts from the whole page; the others from the element.
      const sourceRegion = connection.trigger === "after-delay" && connection.nodeId === root
        ? { x: 0, y: 0, width: render.width, height: render.height }
        : region(snapshot, connection.nodeId, render.width, render.height);
      const destination = connection.target ? targetsByKey.get(key(connection.target)) : undefined;
      const destinationRoot = destination?.presentation.rootId ?? destination?.presentation.rootIds?.[0];
      const opens = ["navigate", "open-overlay", "toggle-overlay"].includes(connection.action);
      const reason = !REVIEW_TRIGGERS.includes(connection.trigger) ? "unsupported_trigger"
        : sourceCounts.get(`${connection.nodeId}\0${connection.trigger}`) > 1 ? "multiple_source_actions"
        : !REVIEW_ACTIONS.includes(connection.action) ? "unsupported_action"
        : snapshot.nodes[connection.nodeId]?.visible === false ? "source_hidden"
        : !sourceRegion ? "native_geometry_unavailable"
        : opens && !destination ? "target_outside_scope"
        : opens && connection.target.nodeId !== destinationRoot ? "target_frame_not_exported"
        : undefined;
      const configuration = connection.configuration ?? {};
      const link = {
        element: where(connection.nodeId), name: connection.name,
        trigger: connection.trigger, action: connection.action,
        ...(destination ? { targetPage: destination.id } : {}),
        ...(connection.delay !== undefined ? { delay: connection.delay } : {}),
        ...(connection.url ? { url: connection.url } : {}),
        ...(connection.action === "open-overlay" || connection.action === "toggle-overlay"
          ? { overlay: {
              position: configuration["overlay-pos-type"] ?? "center",
              ...(configuration["overlay-position"] ? { x: configuration["overlay-position"].x, y: configuration["overlay-position"].y } : {}),
              // Presets align inside, and manual offsets start at, the
              // element the overlay is relative to (the page when none).
              ...(() => {
                const relative = configuration["position-relative-to"] && product.runtime.reverseNodes?.[configuration["position-relative-to"]];
                const box = relative && relative.nodeId !== root && region(snapshot, relative.nodeId, render.width, render.height);
                return box ? { relativeTo: box } : {};
              })(),
              closeOutside: configuration["close-click-outside"] === true,
              backdrop: configuration["background-overlay"] === true,
            } }
          : {}),
        ...(sourceRegion ? { region: sourceRegion } : {}), status: reason ? "unresolved" : "resolved",
        ...(reason ? { reason } : {}) };
      if (reason) unresolved.push({ page: target.id, element: link.element, reason,
        trigger: connection.trigger, action: connection.action });
      return link;
    });
    for (const issue of native.issues) {
      const { nodeId, screenId: _screen, presentationId: _presentation, interactionId: _interaction, ...rest } = issue;
      unresolved.push({ page: target.id, ...rest, ...(nodeId ? { element: where(nodeId) } : {}), reason: issue.code });
    }
    for (const start of native.starts) {
      const root = target.presentation.rootId ?? target.presentation.rootIds?.[0];
      const reason = start.startingNodeId !== root ? "start_frame_not_exported" : undefined;
      starts.push({ name: start.name, page: target.id, status: reason ? "unresolved" : "resolved", ...(reason ? { reason } : {}) });
      if (reason) unresolved.push({ page: target.id, flow: start.name, reason });
    }
    const evidence = { ...result.evidence, packageId: product.manifest.packageId,
      revision: product.revision, layout: snapshot, snapshotId: snapshot.id,
      semanticTree: tree, selector: selection, renderHash: render.renderHash,
      viewport: { width: render.width, height: render.height, scale: options.scale ?? 1 },
      // The native links, with element ids, for tools that match them to
      // layout nodes; the manifest names elements.
      prototype: { starts: native.starts, links: native.connections, issues: native.issues } };
    await write(artifacts.image, render.bytes);
    await write(artifacts.spec, result.specification);
    await write(artifacts.wireframe, result.wireframe);
    await write(artifacts.evidence, canonicalJSON(evidence));
    pages.push({ id: target.id, name: target.screen.name, module: pageFlowName(target.screen),
      platform: target.presentation.platform ?? target.presentation.name,
      presentation: target.presentation.name,
      ...(target.screenId === product.manifest.defaultScreenId ? { default: true } : {}),
      selection: { themes: selection.themes }, viewport: snapshot.viewport, width: render.width, height: render.height, artifacts,
      geometryStatus: snapshot.status, layoutHash: snapshot.hash, renderHash: render.renderHash, links });
  }
  // Snapshots are stable throughout the run. Refuse a review of a package
  // that changed while rendering; incomplete runs deliberately have no index.
  for (const owner of owners)
    if (isAbsolute(owner.locator) && (await openPackage(owner.locator)).revision !== owner.revision)
      fail("stale_review_export", "A source Package changed during HTML export; choose a new output directory and retry");
  const links = pages.flatMap(page => page.links);
  const invalidLinks = unresolved.filter(issue => issue.element && issue.code).length;
  const manifest = { format: "smallpen-html-review", formatVersion: 1,
    entrypoint: "index.html",
    packageId: product.manifest.packageId, packageName: product.manifest.name, revision: product.revision,
    // The page the review opens on: the package's default page, its base
    // version when it has one.
    defaultPage: [...targetsByKey.values()].find(target => target.screenId === product.manifest.defaultScreenId &&
      target.presentationId === product.entries[product.manifest.entries.screens.find(entry =>
        product.entries[entry].id === product.manifest.defaultScreenId)]?.basePresentationId)?.id
      ?? [...targetsByKey.values()].find(target => target.screenId === product.manifest.defaultScreenId)?.id,
    scope: selected.scope, pages, starts, unresolved,
    coverage: { packagePageCount: product.manifest.entries.screens.length,
      pageCount: new Set([...targetsByKey.values()].map(target => target.screenId)).size, versionCount: pages.length,
      partialVersions: pages.filter(page => page.geometryStatus !== "resolved").length,
      combinations: 1, linkCount: links.length + invalidLinks,
      resolvedLinks: links.filter(link => link.status === "resolved").length,
      unresolvedLinks: links.filter(link => link.status === "unresolved").length + invalidLinks,
      startCount: starts.length, resolvedStarts: starts.filter(start => start.status === "resolved").length,
      unresolvedCount: unresolved.length, otherThemes: "not exported",
      supported: ["click, press, hover, mouse enter, mouse leave and delay triggers", "navigate and back", "open, toggle and close overlay pages", "open URL"],
      unsupportedBehavior: "Reported as unresolved; no business input, persistence, recording or application code is simulated" },
    files };
  await write("review.css", reviewStyle);
  await write("review.js", reviewScript);
  // The manifest lists every asset hash. The entry point is the final write,
  // so a render or disk error cannot publish a seemingly complete review.
  await writeFile(join(output, "manifest.json"), canonicalJSON(manifest), { flag: "wx" });
  await writeFile(join(output, "index.html"), reviewDocument(manifest), { flag: "wx" });
  options.progress?.({ type: "html-export-progress", event: "finished", total: pages.length, completed: pages.length });
  return { packageId: manifest.packageId, revision: manifest.revision, output,
    indexPath: join(output, "index.html"), manifestPath: join(output, "manifest.json"),
    coverage: manifest.coverage, scope: selected.scope };
}
