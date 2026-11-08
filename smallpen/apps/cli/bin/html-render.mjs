// INPUT:  frozen workspace, one selected page design and authored nodes
// OUTPUT: one native solve's PNG/spec/wireframe/evidence after worker teardown
// POS:    HTML page rendering boundary; no WASM/font state survives a page
import { SmallPenError } from "@smallpen/core";
import { runValidationJobs } from "./validation-runner.mjs";

export async function renderHtmlReviewPage(workspace, design, {
  scale = 1, stored = {},
  workerUrl = new URL("./html-render-worker.mjs", import.meta.url),
} = {}) {
  const result = await runValidationJobs(workspace, [{
    label: design.tree.root.name, selection: design.selection, design, scale, stored,
  }], { workerUrl, jobsPerWorker: 1 });
  const page = result.results[0];
  if (!page?.rendered) {
    const error = page?.error ?? { code: "html_render_failed", message: "HTML page render did not complete" };
    throw new SmallPenError(error.code, error.message, error.details);
  }
  // runValidationJobs always awaits terminate(), including the success path.
  // Returning only now makes native font/shape/cache reclamation deterministic.
  return page.rendered;
}
