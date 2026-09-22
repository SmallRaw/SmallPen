import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { SmallPenError } from "@smallpen/core";

const MAX_RECENT_PACKAGES = 50;
const INCOMPLETE_LOCK_GRACE_MS = 1000;
const UNVERIFIED_LOCK_MAX_AGE_MS = 30_000;
const renderers = new Set(["svg", "wasm"]);
const themes = new Set(["dark", "light", "system"]);
const defaultPreferences = Object.freeze({
  language: "",
  renderer: "svg",
  theme: "dark",
});

function initialState() {
  return {
    preferences: { ...defaultPreferences },
    recentPackages: [],
    version: 1,
  };
}

function invalidState(message) {
  return new SmallPenError("invalid_application_state", message);
}

function validLanguage(value) {
  return (
    typeof value === "string" &&
    value.length <= 20 &&
    (value === "" || /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(value))
  );
}

function validatePreferences(value) {
  const renderer = value?.renderer ?? defaultPreferences.renderer;
  if (
    !value ||
    typeof value !== "object" ||
    !validLanguage(value.language) ||
    !renderers.has(renderer) ||
    !themes.has(value.theme)
  ) {
    throw invalidState("Application preferences are invalid");
  }
  return {
    language: value.language,
    renderer,
    theme: value.theme,
  };
}

function validateRecentPackage(value) {
  const fields = ["lastOpenedAt", "locator", "name", "packageId", "role"];
  if (
    !value ||
    typeof value !== "object" ||
    fields.some((field) => typeof value[field] !== "string") ||
    value.locator.length === 0 ||
    value.locator.length > 4096 ||
    Number.isNaN(Date.parse(value.lastOpenedAt))
  ) {
    throw invalidState("Recent Package metadata is invalid");
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function validateState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !Array.isArray(value.recentPackages)
  ) {
    throw invalidState("Application state file is invalid");
  }
  return {
    preferences: validatePreferences(value.preferences),
    recentPackages: value.recentPackages
      .map(validateRecentPackage)
      .slice(0, MAX_RECENT_PACKAGES),
    version: 1,
  };
}

const execFileAsync = promisify(execFile);

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function stateLockInspection(lockPath) {
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { abandoned: true };
    throw error;
  }
  let source = "";
  let owner;
  let ownerInfo;
  try {
    const ownerPath = info.isDirectory() ? join(lockPath, "owner.json") : lockPath;
    [ownerInfo, source] = await Promise.all([
      lstat(ownerPath),
      readFile(ownerPath, "utf8"),
    ]);
    owner = JSON.parse(source);
  } catch {
    // A writer can be preempted after mkdir and before owner.json is complete.
  }
  const generationInfo = ownerInfo ?? info;
  const age = Date.now() - generationInfo.mtimeMs;
  const generation = createHash("sha256")
    .update(`${generationInfo.ino}:${generationInfo.mtimeMs}:${source}`)
    .digest("hex");
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
    return { abandoned: age > INCOMPLETE_LOCK_GRACE_MS, generation };
  }
  try {
    process.kill(owner.pid, 0);
    const currentIdentity = await processIdentity(owner.pid);
    if (owner.processIdentity && currentIdentity) {
      return {
        abandoned: owner.processIdentity !== currentIdentity,
        generation,
      };
    }
    return { abandoned: age > UNVERIFIED_LOCK_MAX_AGE_MS, generation };
  } catch (error) {
    return {
      abandoned:
        error?.code === "ESRCH" || age > UNVERIFIED_LOCK_MAX_AGE_MS,
      generation,
    };
  }
}

async function stateLockOwner(lockPath) {
  try {
    const info = await lstat(lockPath);
    const ownerPath = info.isDirectory() ? join(lockPath, "owner.json") : lockPath;
    return JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function releaseStateLock(lockPath, token) {
  if ((await stateLockOwner(lockPath))?.token !== token) return;
  const releasedPath = `${lockPath}.released-${token}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await rm(releasedPath, { force: true, recursive: true });
}

async function acquireStateLock(statePath) {
  const directory = dirname(statePath);
  const lockPath = join(directory, `.${basename(statePath)}.write-lock`);
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const candidatePath = `${lockPath}.candidate-${token}`;
  const ownerProcessIdentity = await processIdentity(process.pid);
  const owner = JSON.stringify({
    createdAt: new Date().toISOString(),
    pid: process.pid,
    processIdentity: ownerProcessIdentity ?? null,
    token,
  });
  await writeFile(candidatePath, owner, {
    flag: "wx",
    mode: 0o600,
  });
  const deadline = Date.now() + 30000;
  try {
    while (true) {
      try {
        await link(candidatePath, lockPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if ((await stateLockOwner(lockPath))?.token === token) {
        await unlink(candidatePath);
        return () => releaseStateLock(lockPath, token);
      }
      const inspection = await stateLockInspection(lockPath);
      if (inspection.abandoned && inspection.generation) {
        const stalePath = `${lockPath}.stale-${inspection.generation}`;
        let claimed = false;
        try {
          await mkdir(stalePath);
          claimed = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        if (claimed) {
          try {
            await rename(lockPath, join(stalePath, "lock"));
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SmallPenError(
          "application_state_write_locked",
          "Timed out waiting for another application state writer",
        );
      }
      await delay(10);
    }
  } catch (error) {
    await rm(candidatePath, { force: true, recursive: true });
    throw error;
  }
}

export function defaultApplicationStatePath() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "SmallPen", "state.json");
  }
  return join(homedir(), ".config", "smallpen", "state.json");
}

export class LocalApplicationState {
  #now;
  #pending = Promise.resolve();
  #state = initialState();
  #statePath;

  constructor({ now = () => new Date().toISOString(), statePath } = {}) {
    this.#now = now;
    this.#statePath = statePath;
  }

  static async open(options) {
    const application = new LocalApplicationState(options);
    await application.#load();
    return application;
  }

  get preferences() {
    return structuredClone(this.#state.preferences);
  }

  get recentPackages() {
    return structuredClone(this.#state.recentPackages);
  }

  get snapshot() {
    return structuredClone(this.#state);
  }

  async recordPackage(value) {
    return this.#mutate((state) => {
      const record = validateRecentPackage({
        ...value,
        lastOpenedAt: this.#now(),
      });
      state.recentPackages = [
        record,
        ...state.recentPackages.filter(({ locator }) => locator !== record.locator),
      ].slice(0, MAX_RECENT_PACKAGES);
    });
  }

  async updatePreferences(changes) {
    const keys = Object.keys(changes ?? {});
    if (
      keys.some(
        (key) => key !== "language" && key !== "renderer" && key !== "theme",
      ) ||
      (changes.language !== undefined && !validLanguage(changes.language)) ||
      (changes.renderer !== undefined && !renderers.has(changes.renderer)) ||
      (changes.theme !== undefined && !themes.has(changes.theme))
    ) {
      throw new SmallPenError(
        "invalid_application_preferences",
        "Application preferences are invalid",
      );
    }
    return this.#mutate((state) => {
      state.preferences = validatePreferences({
        ...state.preferences,
        ...changes,
      });
    });
  }

  async #load() {
    if (!this.#statePath) return;
    let source;
    try {
      source = await readFile(this.#statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#state = initialState();
        return;
      }
      throw error;
    }
    try {
      this.#state = validateState(JSON.parse(source));
    } catch (error) {
      if (error instanceof SmallPenError) throw error;
      throw invalidState("Application state file does not contain valid JSON");
    }
  }

  async #mutate(operation) {
    const pending = this.#pending.then(async () => {
      const release = this.#statePath
        ? await acquireStateLock(this.#statePath)
        : async () => undefined;
      try {
        await this.#load();
        const next = structuredClone(this.#state);
        operation(next);
        this.#state = validateState(next);
        await this.#persist();
        return this.snapshot;
      } finally {
        await release();
      }
    });
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  async #persist() {
    if (!this.#statePath) return;
    const directory = dirname(this.#statePath);
    const temporary = join(
      directory,
      `.${basename(this.#statePath)}.${randomUUID()}.tmp`,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#statePath);
  }
}
