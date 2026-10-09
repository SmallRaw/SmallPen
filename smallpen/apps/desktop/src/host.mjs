import { startWebHost } from "@smallpen/web";

export function startDesktopHost(options = {}) {
  return startWebHost({ ...options, desktop: true });
}
