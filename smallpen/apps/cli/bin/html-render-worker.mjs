// INPUT:  one page design, frozen workspace and native scale
// OUTPUT: PNG, native geometry, full specification, wireframe and evidence
// POS:    Single-page headless worker; terminated before the next page starts
import { parentPort, workerData as workspace } from "node:worker_threads";
import { componentLookup, localWireframe, resolveDesignLayout } from "./design-output.mjs";
import { inspectionReport, inspectionText } from "./inspection-output.mjs";

parentPort.once("message", async job => {
  try {
    const design = await resolveDesignLayout(workspace, job.design,
      { raster: true, scale: job.scale, forExport: true });
    const report = inspectionReport(workspace, design, {
      components: componentLookup(workspace), stored: job.stored, full: true,
    });
    parentPort.postMessage({ rendered: {
      projection: design.projection, tree: design.tree, snapshot: design.layoutSnapshot,
      render: design.render, selection: design.selection, evidence: report,
      specification: inspectionText(report, { details: true }), wireframe: localWireframe(design, { full: true }),
    } });
  } catch (error) {
    parentPort.postMessage({ error: {
      code: error.code ?? "shared_render_failed", message: error.message, details: error.details,
    } });
  }
});
