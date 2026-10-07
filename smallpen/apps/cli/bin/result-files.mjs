import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SmallPenError } from "@smallpen/core";
import { secureWindowsDirectories } from "./windows-artifacts.mjs";

export const OUTPUT_LIMIT_BYTES = 8192;
export const RESULT_RETENTION_MS = 30 * 60 * 1000;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const role =
  "(?:result|render(?:-matrix-\\d{2})?|outline|wireframe|text|undo|changes|evidence|matrix|validation|flow-connections|flow-verification)";
const managedName = new RegExp(
  `^(smallpen-\\d{13}-${uuid})-(${role}|owner-(\\d+))\\.(?:png|json|txt)(?:\\.smallpen-(\\d+)-${uuid}\\.tmp)?$`,
);
const artifactName = new RegExp(`^${role}\\.(?:png|json|txt)$`);
let prefix = `smallpen-${Date.now()}-${randomUUID()}`;
let activeMarker;
let windowsSecured = false;

function directories() {
  const owner = process.getuid
    ? `-${process.getuid()}`
    : `-${createHash("sha256").update(JSON.stringify(userInfo())).digest("hex").slice(0, 16)}`;
  const root = join(tmpdir(), `smallpen-cli${owner}`);
  return [root, join(root, "results")];
}
function assertPrivate(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (process.getuid &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  ) {
    throw new SmallPenError(
      "invalid_artifact_directory",
      "CLI temporary directory must be an owned private directory",
      { path },
    );
  }
}
export function artifactDirectory({ create = false, validate = false } = {}) {
  const paths = directories();
  const windowsItems = [];
  for (const path of create || validate ? paths : []) {
    let created = false;
    try {
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      assertPrivate(path);
      windowsItems.push({ path, created });
    } catch (error) {
      if (
        error instanceof SmallPenError ||
        (!create && error.code === "ENOENT")
      )
        throw error;
      throw new SmallPenError(
        "artifact_directory_unavailable",
        "CLI temporary directory is not writable or accessible",
        { path, reason: error.code },
      );
    }
  }
  if (process.platform === "win32" && windowsItems.length && !windowsSecured) {
    secureWindowsDirectories(windowsItems);
    windowsSecured = true;
  }
  return paths.at(-1);
}
function realDestination(path) {
  let ancestor = path;
  while (true) {
    try {
      return join(realpathSync(ancestor), relative(ancestor, path));
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(error.code) ||
        dirname(ancestor) === ancestor
      )
        throw error;
      ancestor = dirname(ancestor);
    }
  }
}
function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function cleanupExpired(directory) {
  const entries = readdirSync(directory).flatMap((name) => {
    const match = name.match(managedName);
    if (!match) return [];
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) return [];
      return [{ path, match, stat }];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  });
  const active = new Set(
    entries
      .filter(({ match }) => match[3] && ownerAlive(Number(match[3])))
      .map(({ match }) => match[1]),
  );
  const cutoff = Date.now() - RESULT_RETENTION_MS;
  for (const { path, match, stat } of entries) {
    if (
      stat.mtimeMs >= cutoff ||
      active.has(match[1]) ||
      (match[4] && ownerAlive(Number(match[4])))
    )
      continue;
    try {
      rmSync(path, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new SmallPenError(
          "artifact_cleanup_failed",
          "An expired CLI temporary file could not be removed",
          { path, reason: error.code },
        );
    }
  }
}

// Every invocation has unique names in one folder. Only expired recognized CLI
// files are cleaned; caller-owned paths and unrelated files are never removed.
export function beginArtifacts(_command, args = []) {
  prefix = `smallpen-${Date.now()}-${randomUUID()}`;
  const root = realDestination(directories()[0]);
  for (const option of ["--output", "--inverse-out"]) {
    const index = args.indexOf(option);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--"))
      continue;
    const path = resolve(args[index + 1]);
    const child = relative(root, realDestination(path));
    if (
      !child ||
      (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
    ) {
      throw new SmallPenError(
        "reserved_output_path",
        "Choose a retained output path outside the CLI-managed temporary tree",
        { option, path },
      );
    }
  }
  let directory;
  try {
    directory = artifactDirectory({ validate: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  cleanupExpired(directory);
}
export function artifactPath(kind, extension) {
  if (!artifactName.test(`${kind}.${extension}`))
    throw new Error(`Unknown CLI artifact: ${kind}.${extension}`);
  const directory = artifactDirectory({ create: true });
  if (!activeMarker) {
    activeMarker = join(directory, `${prefix}-owner-${process.pid}.json`);
    writeFileSync(activeMarker, "", { mode: 0o600, flag: "wx" });
  }
  return join(directory, `${prefix}-${kind}.${extension}`);
}
export function releaseArtifacts() {
  if (!activeMarker) return;
  try {
    rmSync(activeMarker, { force: true });
  } catch {}
  activeMarker = undefined;
}
process.once("exit", releaseArtifacts);
export function saveResult(bytes, extension = "json") {
  const path = artifactPath("result", extension);
  const temporary = `${path}.smallpen-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new SmallPenError(
      "result_output_failed",
      "Complete result could not be saved to the CLI temporary directory",
      { path, reason: error.code },
    );
  }
  return {
    path,
    format: extension,
    bytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    expiresAt: new Date(Date.now() + RESULT_RETENTION_MS).toISOString(),
  };
}
export function printText(text) {
  if (
    Buffer.byteLength(text) <= OUTPUT_LIMIT_BYTES ||
    process.argv.includes("--stdout")
  ) {
    process.stdout.write(text);
    return;
  }
  const file = saveResult(text, "txt");
  process.stdout.write(
    `Complete text: ${file.path}\nBytes: ${file.bytes}; SHA-256: ${file.sha256}\nTemporary result: 30 minutes. Read/search it with your usual file tools, or request --stdout.\n`,
  );
}
