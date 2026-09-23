export function parseHostArguments(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--frontend-root") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--frontend-root requires a path");
      result.frontendRoot = args[++i];
    } else if (arg === "--parent-stdio") {
      result.parentStdio = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown Desktop host option: ${arg}`);
    } else {
      if (result.packagePath)
        throw new Error("Desktop host accepts one initial package");
      result.packagePath = arg;
    }
  }
  return result;
}
