import { getAdapter, type AdapterLookupOptions } from "./adapters/index.js";
import { type Role } from "./types.js";

export function captureSession(
  role: Role | string,
  payload: unknown,
  options?: AdapterLookupOptions,
): Record<string, unknown> {
  return getAdapter(role, options).discoverSessionId(payload);
}
