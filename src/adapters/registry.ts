import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import type { AdapterLookupOptions, ClientAdapter } from "./types.js";

const builtinAdapters: readonly ClientAdapter[] = [
  codexAdapter,
  antigravityAdapter,
  claudeAdapter,
  geminiAdapter,
];

const registry = new Map<string, ClientAdapter>(builtinAdapters.map((adapter) => [adapter.id, adapter]));

export function experimentalAdaptersEnabled(options?: AdapterLookupOptions): boolean {
  return options?.includeExperimental === true || process.env.AGENT_PAIR_EXPERIMENTAL_ADAPTERS === "1";
}

export function listAdapters(options?: AdapterLookupOptions): ClientAdapter[] {
  const allowExperimental = experimentalAdaptersEnabled(options);
  return [...registry.values()].filter((adapter) => allowExperimental || !adapter.experimental);
}

export function getAdapter(id: string, options?: AdapterLookupOptions): ClientAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(`Unknown client adapter: ${id}. Available adapters: ${listAdapters(options).map((a) => a.id).join(", ")}.`);
  }
  if (adapter.experimental && !experimentalAdaptersEnabled(options)) {
    throw new Error(
      `Client adapter "${adapter.id}" is experimental. Pass --experimental-adapters or set AGENT_PAIR_EXPERIMENTAL_ADAPTERS=1 to enable it.`,
    );
  }
  return adapter;
}

export function registerAdapter(adapter: ClientAdapter): () => void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(adapter.id)) {
    throw new Error(`Invalid adapter ID: ${adapter.id}`);
  }
  if (registry.has(adapter.id)) {
    throw new Error(`Client adapter "${adapter.id}" is already registered.`);
  }
  registry.set(adapter.id, adapter);
  return () => {
    if (registry.get(adapter.id) === adapter) registry.delete(adapter.id);
  };
}
