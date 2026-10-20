import { Worker } from "node:worker_threads";

// A renderer that panicked or ran out of memory stays broken in its worker.
const RENDERER_FAILURE = /panic|wasm|render_failed|validation_worker_failed/;

// A persistent worker reuses the shared App runtime. Terminating the worker
// also stops synchronous WASM; a Promise timeout in this process cannot.
// WASM memory only grows, so a worker is replaced after jobsPerWorker
// targets, and a target the renderer failed on is tried once more in a
// fresh worker.
export async function runValidationJobs(workspace, jobs, {
  timeoutMs = 30_000, signal, progress = () => {}, jobsPerWorker = 12,
  workerUrl = new URL("./validation-worker.mjs", import.meta.url),
} = {}) {
  const results = [];
  let worker, served = 0;
  const emit = (event, extra = {}) => progress({
    type: "validation-progress", event, total: jobs.length, completed: results.length, ...extra,
  });
  emit("start");
  try {
    const runOne = job => {
      if (!worker) {
        worker = new Worker(workerUrl, { workerData: workspace });
        served = 0;
      }
      served += 1;
      return new Promise(resolve => {
        let finished = false;
        const finish = value => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onMessage = value => finish(value);
        const onError = error => finish({ error: { code: "validation_worker_failed", message: error.message }, restart: true });
        const onExit = code => onError(new Error(`Validation worker exited (${code})`));
        const onAbort = () => finish({ interrupted: true, restart: true });
        const timer = setTimeout(() => finish({ error: {
          code: "validation_target_timeout", message: `Target exceeded ${timeoutMs}ms`,
          details: { timeoutMs, target: job.label, selection: job.selection },
        }, restart: true }), timeoutMs);
        worker.once("message", onMessage);
        worker.once("error", onError);
        worker.once("exit", onExit);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else worker.postMessage(job);
      });
    };
    const restart = async () => {
      await worker?.terminate();
      worker = undefined;
    };
    for (const job of jobs) {
      if (signal?.aborted) break;
      emit("target", { target: job.label });
      if (served >= jobsPerWorker) await restart();
      let result = await runOne(job);
      if (!result.interrupted && RENDERER_FAILURE.test(result.error?.code ?? "")) {
        await restart();
        emit("retry", { target: job.label, reason: result.error.code });
        result = await runOne(job);
      }
      if (result.restart || RENDERER_FAILURE.test(result.error?.code ?? "")) await restart();
      if (result.interrupted) break;
      results.push({ job, ...result });
      emit("completed", { target: job.label, status: result.error ? result.error.code : "checked" });
    }
  } finally {
    await worker?.terminate();
  }
  const remaining = jobs.slice(results.length).map(job => ({ target: job.label, selection: job.selection }));
  const interrupted = Boolean(signal?.aborted);
  emit(interrupted ? "interrupted" : "finished", { remaining: remaining.length });
  return { results, interrupted, remaining, total: jobs.length };
}
