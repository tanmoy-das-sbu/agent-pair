export { antigravityAdapter } from "./antigravity.js";
export { claudeAdapter } from "./claude.js";
export { codexAdapter } from "./codex.js";
export { geminiAdapter } from "./gemini.js";
export {
  platformCommand,
  probeExecutableVersion,
  registrationFor,
  resolveConfigHome,
  sessionContextMessage,
} from "./helpers.js";
export {
  experimentalAdaptersEnabled,
  getAdapter,
  listAdapters,
  registerAdapter,
} from "./registry.js";
export type {
  AdapterCommandSpec,
  AdapterLookupOptions,
  AdapterRegistration,
  AdapterSetupContext,
  AdapterSetupEdit,
  ClientAdapter,
} from "./types.js";
