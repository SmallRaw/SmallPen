import { parentPort, workerData } from "node:worker_threads";
import { elementPath, prototypeConnections } from "@smallpen/core";
import { selectedDesign, validateDesign } from "./design-output.mjs";

const workspace = workerData;
parentPort.on("message", async (job) => {
  try {
    const design = job.design ?? selectedDesign(workspace, job.selector, job.target);
    const report = { ...(await validateDesign(workspace, design)), selection: design.selection };
    const nodes = design.projection.nodes;
    report.coverage.skipped = (report.coverage.skipped ?? []).map(skip => {
      const at = [skip.path, skip.nodeId].find(id => typeof id === "string" && Object.hasOwn(nodes, id));
      if (!at) return skip;
      const { path: _path, ...rest } = skip;
      return { ...rest, element: elementPath(nodes, design.projection.rootId, at) || nodes[at].name };
    });
    if (design.selection.screenId) {
      const flow = prototypeConnections(workspace.product, design.selection, {
        ...workspace, context: design.projection.context, initialProjection: design.projection,
      });
      report.issues.push(...flow.issues.map(issue => ({ ...issue, check: "prototype-connections" })));
      report.coverage.checks.push("prototype-connections");
      report.coverage.connectionCount = flow.connections.length;
    }
    parentPort.postMessage({ report });
  } catch (error) {
    parentPort.postMessage({ error: { code: error.code ?? "unreadable_target", message: error.message, details: error.details } });
  }
});
