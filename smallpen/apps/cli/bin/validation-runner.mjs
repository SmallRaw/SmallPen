import { Worker } from "node:worker_threads";

// A persistent worker reuses the shared App runtime. Terminating the worker
// also stops synchronous WASM; a Promise timeout in this process cannot.
export async function runValidationJobs(workspace, jobs, {
  timeoutMs = 30_000, signal, progress = () => {},
  workerUrl = new URL("./validation-worker.mjs", import.meta.url),
} = {}) {
  const results = [];
  let worker;
  const emit = (event, extra = {}) => progress({
    type: "validation-progress", event, total: jobs.length, completed: results.length, ...extra,
  });
  emit("start");
  try {
    for (const job of jobs) {
      if (signal?.aborted) break;
      emit("target", { target: job.label });
      worker ??= new Worker(workerUrl, { workerData: workspace });
      const result = await new Promise(resolve => {
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
      if (result.restart) {
        await worker.terminate();
        worker = undefined;
      }
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
