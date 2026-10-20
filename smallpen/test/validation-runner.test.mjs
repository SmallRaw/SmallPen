import assert from "node:assert/strict";
import test from "node:test";
import { runValidationJobs } from "../apps/cli/bin/validation-runner.mjs";

const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  parentPort.on('message', job => {
    if (job.block) { while (true) {} }
    parentPort.postMessage({ report: { value: job.label } });
  });
`)}`);
const job = (label, block = false) => ({ label, selection: { variantId: label }, block });

test("a synchronous blocked target times out and later targets still complete", async () => {
  const events = [];
  const result = await runValidationJobs({}, [job("first"), job("blocked", true), job("last")], {
    workerUrl, timeoutMs: 500, progress: event => events.push(event),
  });
  assert.deepEqual(result.results.map(item => item.report?.value ?? item.error?.code), ["first", "validation_target_timeout", "last"]);
  assert.equal(result.results[1].error.details.target, "blocked");
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(events[0], { type: "validation-progress", event: "start", total: 3, completed: 0 });
  assert.equal(events.at(-1).completed, 3);
});

test("interruption retains completed results and identifies the current and pending targets", async () => {
  const controller = new AbortController();
  const result = await runValidationJobs({}, [job("first"), job("blocked", true), job("last")], {
    workerUrl, timeoutMs: 5000, signal: controller.signal,
    progress: event => { if (event.event === "completed") setTimeout(() => controller.abort(), 20); },
  });
  assert.equal(result.interrupted, true);
  assert.deepEqual(result.results.map(item => item.report.value), ["first"]);
  assert.deepEqual(result.remaining.map(item => item.target), ["blocked", "last"]);
});

// A worker counts its own jobs and panics on the second target it serves,
// as a renderer out of memory does; a fresh worker renders it.
const tiredWorkerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  let served = 0;
  parentPort.on('message', job => {
    served += 1;
    if (job.label === 'heavy' && served > 1) parentPort.postMessage({ error: { code: 'panic', message: '_alloc_bytes' } });
    else parentPort.postMessage({ report: { value: job.label, served } });
  });
`)}`);

test("a target the renderer panicked on is retried once in a fresh worker; workers are replaced", async () => {
  const events = [];
  const result = await runValidationJobs({}, [job("first"), job("heavy"), job("a"), job("b"), job("c")], {
    workerUrl: tiredWorkerUrl, timeoutMs: 5000, jobsPerWorker: 2, progress: event => events.push(event),
  });
  assert.deepEqual(result.results.map(item => item.report?.value ?? item.error?.code), ["first", "heavy", "a", "b", "c"]);
  assert.equal(result.results[1].report.served, 1, "the retry ran in a new worker");
  assert.ok(result.results.every(item => item.report.served <= 2), "no worker serves more than jobsPerWorker targets");
  assert.deepEqual(events.filter(event => event.event === "retry").map(event => event.reason), ["panic"]);
});
