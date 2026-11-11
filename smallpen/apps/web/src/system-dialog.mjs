import { execFile } from "node:child_process";

// The local service shows the system's own Open and Save dialogs, so it keeps
// the real path. A browser picker gives the page a handle without a path, and
// the service could then neither watch the folder nor share CLI locks.

// JXA drives AppKit directly: unlike AppleScript `choose folder`, NSOpenPanel
// can step into .smallpen folders that Desktop registers as document
// packages. Arguments arrive through argv; nothing is spliced into the code.
// The path is percent-encoded so non-ASCII names survive stdout unchanged.
const MAC_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const [action, message, prompt, directory, name] = argv;
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // Accessory: no Dock icon.
  app.activateIgnoringOtherApps(true);
  const panel =
    action === "open" ? $.NSOpenPanel.openPanel : $.NSSavePanel.savePanel;
  panel.setMessage(message);
  panel.setPrompt(prompt);
  panel.setDirectoryURL($.NSURL.fileURLWithPathIsDirectory(directory, true));
  if (action === "open") {
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    panel.setTreatsFilePackagesAsDirectories(true);
  } else {
    panel.setNameFieldStringValue(name);
    panel.setCanCreateDirectories(true);
  }
  panel.setLevel(8); // Modal panel level: above the browser window.
  if (panel.runModal !== 1) return "";
  return encodeURIComponent(panel.URL.path.js);
}`;

const WORDS = {
  en: {
    open: ["Choose a .smallpen folder", "Open"],
    create: ["Name the new package", "Create"],
  },
  zh: {
    open: ["选择 .smallpen 文件夹", "打开"],
    create: ["给新设计包起个名字", "新建"],
  },
};

function runFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

// Resolves to the chosen path, null when the person cancels, or undefined
// when this system has no dialog the service can show (the page then falls
// back to its own folder list). Rejects only when `signal` aborts.
export async function chooseWithSystemDialog(
  action,
  {
    chinese = false,
    directory = process.cwd(),
    platform = process.platform,
    run = runFile,
    signal,
  } = {},
) {
  if (action !== "open" && action !== "create")
    throw new Error("Unknown file action.");
  if (platform !== "darwin") return undefined;
  const [message, prompt] = WORDS[chinese ? "zh" : "en"][action];
  let stdout;
  try {
    stdout = await run(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        MAC_SCRIPT,
        action,
        message,
        prompt,
        directory,
        "Untitled.smallpen",
      ],
      { signal, encoding: "utf8" },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
  const encoded = stdout.trim();
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
