// INPUT:  a package locator
// OUTPUT: the workspace a package opens as
// POS:    SmallPen packages are single, self-contained HTML packages: no
//         Foundation pairing and no linked libraries. The workspace shape is
//         kept for the callers that read product/foundation/libraries.

import { openPackage } from "./local-package.mjs";

export const MAX_LIBRARY_DECLARATIONS = 0;

export async function resolveWorkspace(productLocator) {
  const product = await openPackage(productLocator);
  return {
    status: "ready",
    warnings: [],
    workspace: { libraries: [], librarySources: [], product },
  };
}

export async function openWorkspace(productLocator) {
  return (await resolveWorkspace(productLocator)).workspace;
}
