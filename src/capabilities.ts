import { CLI_CATALOG } from "./cli-catalog.js";
import { targets } from "./targets/index.js";

/** Implemented routes are distinct from exact-version installed certification. */
export function targetCapabilities() {
  return CLI_CATALOG.map(cli => ({ ...cli, bootstrap: true,
    nativeImport: targets[cli.id].supportsNativeImport !== false,
    exactNativeResume: targets[cli.id].supportsNativeResume !== false,
    certification: "consult exact-version verification evidence" }));
}
