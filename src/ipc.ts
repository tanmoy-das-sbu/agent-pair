import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Relay } from "./relay.js";
import { requestSchema, type Request } from "./types.js";
import { dataDirectory, pathKey } from "./workspace.js";

const maxFrame = 1024 * 1024;

function endpoint(directory: string): string {
  const hash = createHash("sha256").update("agent-pair-relay-v3\0").update(pathKey(directory)).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\agent-pair-${hash}`;
  if (process.platform === "linux") return `\0agent-pair-${hash}`;
  return join(tmpdir(), `agent-pair-${hash}.sock`);
}

async function brokerSecret(directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "relay.key");
  const fresh = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, fresh, { flag: "wx", mode: 0o600 });
    return fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = readFileSync(file, "utf8");
    if (/^[a-f0-9]{64}$/.test(value)) return value;
    await sleep(25);
  }
  throw new Error("The Agent Pair relay key is invalid.");
}

function equalSecret(expected: string, received: unknown): boolean {
  return typeof received === "string"
    && /^[a-f0-9]{64}$/.test(received)
    && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export async function runBroker(): Promise<void> {
  const directory = dataDirectory();
  const secret = await brokerSecret(directory);
  const relay = new Relay(directory);
  let lastCall = Date.now();
  const server = createServer((socket) => {
    const controller = new AbortController();
    socket.on("close", () => controller.abort());
    socket.on("error", () => socket.destroy());
    socket.setTimeout(32_000, () => socket.destroy());
    socket.setEncoding("utf8");
    let frame = "";

    const onData = async (chunk: string) => {
      frame += chunk;
      if (frame.length > maxFrame) {
        socket.destroy();
        return;
      }
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      try {
        const packet = JSON.parse(frame.slice(0, newline));
        if (!equalSecret(secret, packet.secret)) throw new Error("Relay authentication failed.");
        const request = requestSchema.safeParse(packet.request);
        if (!request.success) throw new Error("Invalid relay request.");
        lastCall = Date.now();
        const data = await relay.execute(request.data, controller.signal);
        if (!socket.destroyed) socket.end(JSON.stringify({ data }) + "\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent Pair relay request failed.";
        if (!socket.destroyed) socket.end(JSON.stringify({ error: message }) + "\n");
      }
    };
    socket.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint(directory), resolve);
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") throw error;
  });
  if (!server.listening) return;
  const timer = setInterval(() => {
    relay.sweep();
    if (relay.idle && Date.now() - lastCall > 60_000) server.close();
  }, 5000);
  server.once("close", () => clearInterval(timer));
}

function call(path: string, secret: string, request: Request, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const abort = () => socket.destroy(new Error("Agent Pair tool call canceled."));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(31_000, () => socket.destroy(new Error("Agent Pair relay did not respond.")));
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ secret, request }) + "\n"));
    socket.once("error", reject);
    socket.once("close", () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("Agent Pair relay closed the connection."));
    });
    let frame = "";
    socket.on("data", (chunk: string) => {
      frame += chunk;
      if (frame.length > maxFrame) {
        socket.destroy(new Error("Agent Pair relay response exceeded the size limit."));
        return;
      }
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      try {
        const packet = JSON.parse(frame.slice(0, newline));
        if (typeof packet.error === "string") reject(new Error(packet.error));
        else resolve(packet.data);
      } catch {
        reject(new Error("Invalid Agent Pair relay response."));
      }
      socket.destroy();
    });
  });
}

function unavailable(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function relayCall(entry: string, request: Request, signal?: AbortSignal): Promise<unknown> {
  const directory = dataDirectory();
  const secret = await brokerSecret(directory);
  const path = endpoint(directory);
  try {
    return await call(path, secret, request, signal);
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  signal?.throwIfAborted();
  const worker = spawn(process.execPath, [entry, "broker"], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  let launchError: Error | undefined;
  worker.on("error", (error) => { launchError = error; });
  worker.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(100, undefined, { signal });
    if (launchError) throw launchError;
    try {
      return await call(path, secret, request, signal);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  throw new Error("Could not start the local Agent Pair relay. Run agent-pair doctor to check this environment.");
}
