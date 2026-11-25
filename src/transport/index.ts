import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathKey } from "../workspace.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function startupLock(directory: string): Promise<() => void> {
  const lock = join(directory, "startup.lock");
  const pidFile = join(lock, "pid");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
      return () => { unlinkSync(pidFile); rmdirSync(lock); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid relay startup lock.");
        try { process.kill(pid, 0); } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
            throw new Error(`Relay startup lock is stale: ${lock}. Remove it only after verifying no relay is starting.`);
          }
        }
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
        // The creator may still be writing its PID. Never remove an unverified lock.
      }
      await delay(50);
    }
  }
  throw new Error("Timed out waiting for the relay startup lock.");
}

async function socketAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

export interface Transport {
  endpoint: string;
  connect(): Socket;
  listen(server: Server): Promise<void>;
}

export function transport(directory: string, platform: NodeJS.Platform = process.platform): Transport {
  const hash = createHash("sha256").update("agent-pair-relay-v11\0").update(pathKey(directory)).digest("hex").slice(0, 24);
  const windows = platform === "win32";
  const socketDir = join(tmpdir(), `agent-pair-${hash}`);
  const endpoint = windows ? `\\\\.\\pipe\\agent-pair-${hash}` : join(socketDir, "relay.sock");
  return {
    endpoint,
    connect: () => createConnection(endpoint),
    listen: async (server) => {
      if (!windows) {
        mkdirSync(socketDir, { recursive: true, mode: 0o700 });
        const info = lstatSync(socketDir);
        if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe relay socket directory.");
        chmodSync(socketDir, 0o700);
      }
      const release = windows ? undefined : await startupLock(socketDir);
      try {
        if (!windows) {
          try {
            const info = lstatSync(endpoint);
            if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe relay socket path.");
            if (await socketAlive(endpoint)) {
              const error = new Error("Relay already listening.") as NodeJS.ErrnoException;
              error.code = "EADDRINUSE";
              throw error;
            }
            unlinkSync(endpoint);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(endpoint, resolve);
        });
        if (!windows) chmodSync(endpoint, 0o600);
      } finally { release?.(); }
    },
  };
}
