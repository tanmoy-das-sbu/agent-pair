import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DashboardSnapshot, Relay } from "./relay.js";
import { MetricsTracker, usageReportSchema, type RunMetrics } from "./metrics/index.js";
import { teamSetupSchema } from "./types.js";

const clientNames = { codex: "Codex", antigravity: "Antigravity", claude: "Claude Code" };
function equalToken(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{32}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export function openDashboardUrl(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/d\/[a-f0-9]{32}\/$/.test(url)) return;
  try {
    let child;
    if (process.platform === "win32") {
      const rundll = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
      child = spawn(rundll, ["url.dll,FileProtocolHandler", url], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
    } else if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is best-effort and must never fail team coordination.
  }
}

export class DashboardServer {
  private readonly token = randomBytes(16).toString("hex");
  private readonly clients = new Set<ServerResponse>();
  private readonly pendingClients = new Set<ServerResponse>();
  private latestEvent = "";
  private broadcastQueued = false;
  private server?: Server;
  private startPromise?: Promise<string>;
  private unsubscribe?: () => void;
  private heartbeat?: NodeJS.Timeout;
  private addressUrl?: string;

  private readonly metrics: MetricsTracker;

  constructor(private readonly relay: Relay, dataDir?: string) {
    this.metrics = new MetricsTracker(dataDir);
    this.metrics.attach(relay);
  }

  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  get isStarted(): boolean {
    return this.addressUrl !== undefined;
  }

  async ensureStarted(): Promise<string> {
    if (this.addressUrl) return this.addressUrl;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async start(): Promise<string> {
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.addressUrl = `http://127.0.0.1:${port}/d/${this.token}/`;
    this.unsubscribe = this.relay.subscribe(() => {
      this.scheduleBroadcast();
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.writableEnded && !client.writableNeedDrain) client.write(": ping\n\n");
      }
    }, 15_000);
    this.heartbeat.unref();
    return this.addressUrl;
  }

  close(): void {
    this.metrics.detach();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of this.clients) {
      if (!client.writableEnded) client.end();
    }
    this.clients.clear();
    this.pendingClients.clear();
    this.latestEvent = "";
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
    this.addressUrl = undefined;
  }

  private enrichedSnapshot(): DashboardSnapshot & { runs: Array<DashboardSnapshot["runs"][number] & { metrics: RunMetrics }> } {
    const snap = this.relay.snapshot();
    const byRun = this.metrics.syncSnapshot(snap);
    return {
      ...snap,
      runs: snap.runs.map((run) => ({ ...run, metrics: byRun[run.id] })),
    };
  }

  private snapshotEvent(): string {
    return `event: snapshot\ndata: ${JSON.stringify(this.enrichedSnapshot())}\n\n`;
  }

  private scheduleBroadcast(): void {
    if (this.broadcastQueued || !this.clients.size) return;
    this.broadcastQueued = true;
    queueMicrotask(() => {
      this.broadcastQueued = false;
      if (!this.clients.size) return;
      this.latestEvent = this.snapshotEvent();
      for (const client of this.clients) {
        if (client.writableEnded) continue;
        if (client.writableNeedDrain) this.pendingClients.add(client);
        else client.write(this.latestEvent);
      }
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = URL.parse(req.url ?? "/", "http://127.0.0.1");
    if (!url) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    const match = /^\/d\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !equalToken(this.token, match[1])) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    const route = match[2] ?? "/";
    const pickFolder = route === "/api/workspace-picker" && req.method === "POST";
    if (pickFolder || (route === "/api/setup" && (req.method === "POST" || req.method === "DELETE"))) {
      void this.handleSetup(req, res, url, pickFolder);
      return;
    }
    if (route === "/api/metrics/usage" && req.method === "POST") {
      void this.handleUsageReport(req, res);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }
    if (route === "/" || route === "") {
      const nonce = randomBytes(16).toString("base64");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
      });
      res.end(dashboardHtml(this.token, nonce));
      return;
    }
    if (route === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(this.enrichedSnapshot()));
      return;
    }
    if (route === "/api/metrics") {
      this.metrics.syncSnapshot(this.relay.snapshot());
      const runId = url.searchParams.get("runId");
      if (runId) {
        const found = this.metrics.getMetrics(runId);
        res.writeHead(found ? 200 : 404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(found ?? { error: "Run metrics not found." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ runs: this.metrics.listMetrics() }));
      return;
    }
    if (route === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
      });
      this.clients.add(res);
      res.on("drain", () => {
        if (this.pendingClients.delete(res) && !res.writableEnded) res.write(this.latestEvent);
      });
      res.on("close", () => {
        this.clients.delete(res);
        this.pendingClients.delete(res);
      });
      res.write(this.snapshotEvent());
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  private async handleSetup(req: IncomingMessage, res: ServerResponse, url: URL, pickFolder: boolean): Promise<void> {
    const respond = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.origin !== new URL(this.addressUrl!).origin) {
      req.resume();
      respond(403, { error: "Open team setup from the local dashboard." });
      return;
    }
    if (pickFolder) {
      req.resume();
      const requested = url.searchParams.get("path") || process.cwd();
      if (!isAbsolute(requested) || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(requested))) {
        respond(400, { error: "Choose a folder on a local drive." });
        return;
      }
      const workspace = resolve(requested);
      try {
        const entries = await readdir(workspace, { withFileTypes: true });
        const folders = entries.filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, path: join(workspace, entry.name) }))
          .sort((left, right) => left.name.localeCompare(right.name));
        const drives = process.platform === "win32"
          ? await Promise.all(Array.from({ length: 26 }, async (_, index) => {
              const root = String.fromCharCode(65 + index) + ":\\";
              return (await stat(root).catch(() => undefined))?.isDirectory() ? root : null;
            }))
          : ["/"];
        const parent = dirname(workspace);
        respond(200, { workspace, parent: parent === workspace ? null : parent, home: homedir(), drives: drives.filter(Boolean), folders });
      } catch {
        if (!res.destroyed) respond(400, { error: "Unable to read that folder. Try its parent or another drive." });
      }
      return;
    }
    if (req.method === "DELETE") {
      req.resume();
      const canceled = this.relay.cancelTeamSetup(url.searchParams.get("id") ?? "");
      respond(canceled ? 200 : 404, canceled ? { canceled } : { error: "This setup has already changed." });
      return;
    }
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
      req.resume();
      respond(415, { error: "Send the team setup as JSON." });
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 32_768) {
          req.resume();
          respond(413, { error: "Team setup is too large." });
          return;
        }
        chunks.push(chunk);
      }
      const parsed = teamSetupSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) {
        respond(400, { error: parsed.error.issues[0].message });
        return;
      }
      respond(201, this.relay.saveTeamSetup(parsed.data));
    } catch (error) {
      if (!res.destroyed) respond(400, { error: error instanceof Error ? error.message : "Unable to save team setup." });
    }
  }

  private async handleUsageReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const respond = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.origin && req.headers.origin !== new URL(this.addressUrl!).origin) {
      req.resume();
      respond(403, { error: "Submit usage reports from the local dashboard or trusted local client." });
      return;
    }
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
      req.resume();
      respond(415, { error: "Send usage reports as JSON." });
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 32_768) {
          req.resume();
          respond(413, { error: "Usage report payload is too large." });
          return;
        }
        chunks.push(chunk);
      }
      const parsed = usageReportSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) {
        respond(400, { error: parsed.error.issues[0].message });
        return;
      }
      this.metrics.syncSnapshot(this.relay.snapshot());
      const report = this.metrics.recordUsage(parsed.data);
      this.scheduleBroadcast();
      respond(201, { report, metrics: this.metrics.getMetrics(report.runId) });
    } catch (error) {
      if (!res.destroyed) respond(400, { error: error instanceof Error ? error.message : "Unable to record usage report." });
    }
  }
}

function dashboardHtml(token: string, nonce: string): string {
  const base = `/d/${token}`;
  return `<!doctype html>
<html lang="en" data-theme="cozy-dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Pair — Live Team Studio</title>
  <style>
    :root {
      --bg: #1c1b29;
      --bg-dot: rgba(244, 239, 230, 0.045);
      --surface: #262538;
      --surface-2: #302f46;
      --surface-soft: #222133;
      --ink: #f5efe6;
      --muted: #b9b2c9;
      --border: #464362;
      --comic-shadow: #11101b;
      --accent: #a799ff;
      --working-bg: rgba(124, 224, 181, 0.16);
      --working-ink: #8ce9c1;
      --working-border: #63c99f;
      --waiting-bg: rgba(246, 208, 122, 0.16);
      --waiting-ink: #f9d88b;
      --waiting-border: #deb258;
      --blocked-bg: rgba(245, 152, 152, 0.18);
      --blocked-ink: #ffaaaa;
      --blocked-border: #df7b7b;
      --review-bg: rgba(168, 184, 255, 0.18);
      --review-ink: #bfcaff;
      --review-border: #879bff;
      --done-bg: rgba(164, 232, 160, 0.18);
      --done-ink: #b3f2ad;
      --done-border: #7ad173;
      --idle-bg: rgba(147, 197, 253, 0.15);
      --idle-ink: #aed2ff;
      --idle-border: #76a9e6;
      --off-bg: rgba(142, 138, 158, 0.15);
      --off-ink: #b5b0c7;
      --off-border: #6d6882;
      --tag-bg: #362f52;
      --tag-border: #a799ff;
      --codex: #7bdff2;
      --antigravity: #b8b5ff;
      --claude: #f6a985;
      --bubble-bg: #312f49;
    }
    html[data-theme="cream"] {
      --bg: #faf3e8;
      --bg-dot: rgba(45, 38, 56, 0.06);
      --surface: #fffdf8;
      --surface-2: #f4ead9;
      --surface-soft: #f7efe2;
      --ink: #2b2438;
      --muted: #6c637d;
      --border: #2b2438;
      --comic-shadow: rgba(43, 36, 56, 0.22);
      --accent: #6c5ce7;
      --working-bg: #dff7ec;
      --working-ink: #1b6b4c;
      --working-border: #2d8f69;
      --waiting-bg: #fef1cf;
      --waiting-ink: #8a5a08;
      --waiting-border: #c98b1a;
      --blocked-bg: #fde2e2;
      --blocked-ink: #a22d2d;
      --blocked-border: #d95555;
      --review-bg: #e4e9ff;
      --review-ink: #3647a3;
      --review-border: #5a6fd8;
      --done-bg: #e2f8df;
      --done-ink: #236e20;
      --done-border: #469c42;
      --idle-bg: #e3f0ff;
      --idle-ink: #2c5b94;
      --idle-border: #588ac7;
      --off-bg: #ece8f0;
      --off-ink: #5d566b;
      --off-border: #8d869c;
      --tag-bg: #efe8ff;
      --tag-border: #6c5ce7;
      --bubble-bg: #f6eee0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      background-image: radial-gradient(var(--bg-dot) 1.5px, transparent 1.5px);
      background-size: 22px 22px;
      color: var(--ink);
      font-family: "Fredoka", "Nunito", "Segoe UI Rounded", "Trebuchet MS", system-ui, -apple-system, sans-serif;
      line-height: 1.45;
      transition: background-color 0.25s ease, color 0.25s ease;
    }
    .wrap {
      max-width: 1240px;
      margin: 0 auto;
      padding: 20px 20px 44px;
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      background: var(--surface);
      border: 2.5px solid var(--border);
      border-radius: 24px;
      padding: 14px 18px;
      box-shadow: 4px 5px 0 var(--comic-shadow);
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-badge {
      width: 46px;
      height: 46px;
      border-radius: 16px;
      background: var(--surface-2);
      border: 2.5px solid var(--border);
      display: grid;
      place-items: center;
      box-shadow: 2px 3px 0 var(--comic-shadow);
    }
    .brand h1 {
      margin: 0;
      font-size: 1.25rem;
      letter-spacing: 0.01em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-sub {
      font-size: 0.84rem;
      color: var(--muted);
      margin-top: 1px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .pill, button.btn, select.run-select {
      font-family: inherit;
      font-size: 0.86rem;
      font-weight: 700;
      border-radius: 999px;
      border: 2px solid var(--border);
      background: var(--surface-2);
      color: var(--ink);
      padding: 7px 13px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      box-shadow: 2px 3px 0 var(--comic-shadow);
      transition: transform 0.12s ease, box-shadow 0.12s ease, background-color 0.2s ease;
    }
    button.btn { cursor: pointer; }
    button.btn:hover { transform: translateY(-1.5px); box-shadow: 3px 4.5px 0 var(--comic-shadow); }
    button.btn:active { transform: translateY(1px); box-shadow: 1px 1.5px 0 var(--comic-shadow); }
    button.btn.active-toggle { background: var(--tag-bg); border-color: var(--tag-border); }
    .live-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--working-border);
      display: inline-block;
      animation: pulse 2s ease-in-out infinite;
    }
    .live-dot.offline { background: var(--blocked-border); animation: none; }
    .hero-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      background: var(--surface);
      border: 2.5px solid var(--border);
      border-radius: 22px;
      padding: 14px 18px;
      box-shadow: 4px 5px 0 var(--comic-shadow);
      margin-bottom: 20px;
    }
    .workspace-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 220px;
    }
    .workspace-name {
      font-size: 1.15rem;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .workspace-path {
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: 0.78rem;
      color: var(--muted);
      word-break: break-all;
    }
    .tag-box {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .tag-chip {
      background: var(--tag-bg);
      border: 2.5px dashed var(--tag-border);
      border-radius: 16px;
      padding: 8px 14px;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      box-shadow: 2px 3px 0 var(--comic-shadow);
    }
    .tag-code {
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: 1.25rem;
      font-weight: 900;
      letter-spacing: 0.18em;
      color: var(--ink);
    }
    .tag-hint {
      font-size: 0.78rem;
      color: var(--muted);
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin: 22px 0 12px;
    }
    .section-head h2 {
      margin: 0;
      font-size: 1.05rem;
      letter-spacing: 0.02em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }
    .agent-card {
      position: relative;
      background: var(--surface);
      border: 2.5px solid var(--border);
      border-radius: 24px;
      padding: 16px;
      box-shadow: 4px 5px 0 var(--comic-shadow);
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: transform 0.2s ease, opacity 0.2s ease;
    }
    .agent-card:hover { transform: translateY(-2px); }
    .agent-card.status-waiting {
      border-style: dashed;
      border-color: var(--waiting-border);
      background: var(--surface-soft);
    }
    .agent-card.status-working { border-color: var(--working-border); }
    .agent-card.status-blocked { border-color: var(--blocked-border); }
    .agent-card.status-review { border-color: var(--review-border); }
    .agent-card.status-done { border-color: var(--done-border); }
    .agent-card.status-disconnected { opacity: 0.72; border-color: var(--off-border); }
    .agent-top {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .avatar-wrap {
      position: relative;
      width: 74px;
      height: 74px;
      flex: 0 0 74px;
      border-radius: 20px;
      background: var(--surface-2);
      border: 2px solid var(--border);
      display: grid;
      place-items: center;
      overflow: visible;
    }
    .avatar-svg { width: 66px; height: 66px; overflow: visible; }
    .status-working .avatar-svg { animation: bob 2.2s ease-in-out infinite; }
    .status-idle .avatar-svg { animation: bob 3.8s ease-in-out infinite; }
    .status-waiting .avatar-svg { animation: peek 3.2s ease-in-out infinite; }
    .status-blocked .avatar-svg { animation: wobble 1.8s ease-in-out infinite; }
    .status-review .avatar-svg { animation: happyHop 2.6s ease-in-out infinite; }
    .unread-badge {
      position: absolute;
      top: -8px;
      right: -8px;
      min-width: 24px;
      height: 24px;
      padding: 0 6px;
      border-radius: 999px;
      background: var(--blocked-border);
      color: #fff;
      font-size: 0.76rem;
      font-weight: 800;
      display: grid;
      place-items: center;
      border: 2px solid var(--surface);
      box-shadow: 1px 2px 0 var(--comic-shadow);
    }
    .agent-meta { flex: 1; min-width: 0; }
    .agent-name {
      font-size: 1.08rem;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .client-chip {
      font-size: 0.72rem;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1.5px solid var(--border);
      background: var(--surface-2);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .client-codex { color: var(--codex); }
    .client-antigravity { color: var(--antigravity); }
    .client-claude { color: var(--claude); }
    html[data-theme="cream"] .client-codex { color: #0e6f7f; background: #e1f7fb; }
    html[data-theme="cream"] .client-antigravity { color: #4c3fb8; background: #ecebff; }
    html[data-theme="cream"] .client-claude { color: #a34922; background: #feece3; }
    .state-badge {
      margin-top: 6px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78rem;
      font-weight: 800;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1.8px solid transparent;
    }
    .st-working { background: var(--working-bg); color: var(--working-ink); border-color: var(--working-border); }
    .st-waiting { background: var(--waiting-bg); color: var(--waiting-ink); border-color: var(--waiting-border); }
    .st-blocked { background: var(--blocked-bg); color: var(--blocked-ink); border-color: var(--blocked-border); }
    .st-review { background: var(--review-bg); color: var(--review-ink); border-color: var(--review-border); }
    .st-done { background: var(--done-bg); color: var(--done-ink); border-color: var(--done-border); }
    .st-idle { background: var(--idle-bg); color: var(--idle-ink); border-color: var(--idle-border); }
    .st-disconnected { background: var(--off-bg); color: var(--off-ink); border-color: var(--off-border); }
    .speech-bubble {
      position: relative;
      background: var(--bubble-bg);
      border: 2px solid var(--border);
      border-radius: 16px;
      padding: 10px 12px;
      font-size: 0.85rem;
      color: var(--ink);
    }
    .speech-bubble::before {
      content: "";
      position: absolute;
      top: -8px;
      left: 26px;
      width: 12px;
      height: 12px;
      background: var(--bubble-bg);
      border-left: 2px solid var(--border);
      border-top: 2px solid var(--border);
      transform: rotate(45deg);
    }
    .speech-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      font-weight: 800;
      margin-bottom: 2px;
    }
    .agent-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.76rem;
      color: var(--muted);
      gap: 8px;
      margin-top: auto;
    }
    .lower-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
      gap: 18px;
      margin-top: 10px;
    }
    @media (max-width: 920px) {
      .lower-grid { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--surface);
      border: 2.5px solid var(--border);
      border-radius: 24px;
      padding: 16px 18px;
      box-shadow: 4px 5px 0 var(--comic-shadow);
    }
    .progress-wrap {
      margin-bottom: 14px;
    }
    .progress-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .progress-track {
      height: 16px;
      border-radius: 999px;
      background: var(--surface-2);
      border: 2px solid var(--border);
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 999px;
      background: repeating-linear-gradient(
        -45deg,
        var(--working-border),
        var(--working-border) 10px,
        var(--done-border) 10px,
        var(--done-border) 20px
      );
      transition: width 0.35s ease;
    }
    .filter-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .filter-btn {
      font-family: inherit;
      font-size: 0.76rem;
      font-weight: 800;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1.8px solid var(--border);
      background: var(--surface-2);
      color: var(--muted);
      cursor: pointer;
    }
    .filter-btn.active {
      background: var(--tag-bg);
      border-color: var(--tag-border);
      color: var(--ink);
    }
    .task-list, .msg-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 460px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .task-item {
      background: var(--surface-soft);
      border: 2px solid var(--border);
      border-radius: 18px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .task-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .task-title {
      font-weight: 800;
      font-size: 0.94rem;
    }
    .mono-pill {
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: 0.74rem;
      background: var(--surface-2);
      border: 1.5px solid var(--border);
      border-radius: 8px;
      padding: 2px 7px;
      color: var(--muted);
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .note-box {
      font-size: 0.82rem;
      background: var(--bubble-bg);
      border-left: 4px solid var(--accent);
      border-radius: 10px;
      padding: 7px 10px;
    }
    .msg-item {
      background: var(--surface-soft);
      border: 2px solid var(--border);
      border-radius: 18px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .msg-item.unread { border-color: var(--waiting-border); }
    .msg-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 0.8rem;
      font-weight: 800;
    }
    .msg-body {
      font-size: 0.86rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .lounge {
      background: var(--surface);
      border: 2.5px solid var(--border);
      border-radius: 28px;
      padding: 36px 24px;
      text-align: center;
      box-shadow: 5px 6px 0 var(--comic-shadow);
    }
    .lounge-crew {
      display: flex;
      justify-content: center;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .lounge-buddy {
      width: 96px;
      height: 96px;
      border-radius: 26px;
      background: var(--surface-2);
      border: 2.5px solid var(--border);
      display: grid;
      place-items: center;
      box-shadow: 3px 4px 0 var(--comic-shadow);
      animation: bob 3.2s ease-in-out infinite;
    }
    .lounge-buddy:nth-child(2) { animation-delay: 0.4s; }
    .lounge-buddy:nth-child(3) { animation-delay: 0.8s; }
    .lounge h2 { margin: 0 0 8px; font-size: 1.4rem; }
    .lounge p { margin: 0 auto 18px; max-width: 560px; color: var(--muted); }
    .lounge-actions {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--surface);
      color: var(--ink);
      border: 2.5px solid var(--working-border);
      border-radius: 16px;
      padding: 10px 16px;
      font-weight: 800;
      font-size: 0.86rem;
      box-shadow: 4px 5px 0 var(--comic-shadow);
      opacity: 0;
      transform: translateY(12px);
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      z-index: 99;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .demo-banner {
      background: var(--waiting-bg);
      border: 2px dashed var(--waiting-border);
      color: var(--waiting-ink);
      border-radius: 16px;
      padding: 10px 16px;
      font-size: 0.86rem;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    @keyframes bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }
    @keyframes peek {
      0%, 100% { transform: translateY(2px) rotate(-2deg); }
      50% { transform: translateY(-3px) rotate(2deg); }
    }
    @keyframes wobble {
      0%, 100% { transform: rotate(0deg); }
      25% { transform: rotate(-4deg); }
      75% { transform: rotate(4deg); }
    }
    @keyframes happyHop {
      0%, 100% { transform: translateY(0) scale(1); }
      45% { transform: translateY(-6px) scale(1.03); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
    .setup-panel { margin-bottom: 20px; }
    .setup-panel summary { cursor: pointer; font-weight: 800; }
    .setup-fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(135px, 100%), 1fr));
      gap: 12px;
      margin: 14px 0;
    }
    .setup-fields label { display: grid; gap: 5px; font-size: 0.86rem; font-weight: 700; min-width: 0; }
    .setup-workspace { grid-column: 1 / -1; }
    .setup-path { display: flex; gap: 8px; }
    .folder-picker { width: min(620px, calc(100% - 24px)); color: var(--ink); }
    .folder-picker::backdrop { background: rgba(17, 16, 27, 0.7); }
    .folder-picker h2 { margin-top: 0; }
    .folder-picker .task-list { max-height: min(42vh, 360px); }
    .folder-picker .task-list button { border-radius: 10px; text-align: left; overflow-wrap: anywhere; }
    .folder-actions { margin-top: 14px; }
    #folderStatus:empty { display: none; }
    .setup-fields input, .setup-fields select {
      min-width: 0;
      width: 100%;
      font: inherit;
      color: var(--ink);
      background: var(--surface-2);
      border: 2px solid var(--border);
      border-radius: 10px;
      padding: 7px 10px;
    }
    .setup-list:empty { display: none; }
    .setup-row { border-top: 1px solid var(--border); padding: 12px 0; overflow-wrap: anywhere; }
    .setup-row p { margin: 5px 0 9px; color: var(--muted); }
    .setup-status { color: var(--muted); }
    .team-map { margin-bottom: 20px; }
    .map-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .map-header h2, .map-section h3 { margin: 0; }
    .map-attention { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 20px; }
    .map-lead { display: grid; justify-content: center; }
    .map-stem { height: 20px; width: 2px; margin: auto; background: var(--border); }
    .map-workers { border-top: 2px solid var(--border); display: grid; grid-template-columns: repeat(auto-fit, minmax(min(165px, 100%), 1fr)); gap: 12px; }
    .map-branch { position: relative; padding-top: 14px; }
    .map-branch::before { content: ""; position: absolute; top: 0; left: 50%; height: 14px; border-left: 2px solid var(--border); }
    .map-node { width: 100%; text-align: left; font: inherit; cursor: pointer; color: var(--ink); background: var(--surface-2); border: 2px solid var(--border); border-radius: 14px; padding: 10px; display: grid; gap: 5px; overflow-wrap: anywhere; }
    .map-node[aria-pressed="true"] { border-color: var(--accent); outline: 1px solid var(--accent); }
    .map-node-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .map-node .state-badge { margin-top: 0; justify-self: start; }
    .map-bot-row { display: flex; align-items: center; gap: 10px; min-height: 42px; }
    .map-bot-role { color: var(--muted); font-size: 0.76rem; font-weight: 700; }
    .map-bot {
      --bot-color: #aec2e4;
      position: relative; flex: 0 0 36px; height: 29px; margin: 8px 3px 4px;
      border: 2px solid #29263e; border-radius: 12px;
      background: var(--bot-color); box-shadow: 0 3px 0 var(--comic-shadow);
      color: #29263e; display: grid; place-items: center;
    }
    .map-bot::before {
      content: ""; position: absolute; width: 8px; height: 8px; left: 12px; top: -8px;
      background: var(--bot-color); border: 2px solid #29263e; border-radius: 50%;
    }
    .map-bot::after {
      content: ""; position: absolute; left: 12px; bottom: 4px;
      width: 8px; height: 4px; border-bottom: 2px solid currentColor; border-radius: 50%;
    }
    .map-bot-eyes { width: 4px; height: 5px; margin: 0 10px 4px 0; border-radius: 50%; background: currentColor; box-shadow: 10px 0 currentColor; animation: bot-blink 4s infinite; }
    .map-bot-lead { --bot-color: #c3acff; }
    .map-bot-frontend { --bot-color: #ffacd3; }
    .map-bot-backend { --bot-color: #8ddfdc; }
    .map-bot-quality { --bot-color: #ffcb83; }
    .map-bot-docs { --bot-color: #afe4a3; }
    .map-bot-build { --bot-color: #a7c8ff; }
    .map-bot-working { animation: bob 1.8s ease-in-out infinite; }
    .map-bot-idle, .map-bot-waiting { animation: bob 3.6s ease-in-out infinite; }
    .map-bot-blocked { animation: wobble 2.6s ease-in-out infinite; }
    .map-bot-review { animation: happyHop 2.8s ease-in-out infinite; }
    .map-bot-disconnected { opacity: 0.45; }
    .map-bot-disconnected .map-bot-eyes { animation: none; }
    @keyframes bot-blink { 0%, 43%, 49%, 100% { transform: scaleY(1); } 46% { transform: scaleY(0.12); } }
    .map-detail { border: 1px solid var(--border); padding: 12px; border-radius: 12px; margin-top: 14px; overflow-wrap: anywhere; }
    .map-detail p { margin: 6px 0; white-space: pre-wrap; }
    .map-section { margin-top: 18px; }
    .map-dependencies { display: grid; gap: 6px; margin-top: 8px; }
    .map-dependency { width: 100%; text-align: left; overflow-wrap: anywhere; }
    .map-branch.map-pulse::before, .map-stem.map-pulse { animation: map-signal 0.8s ease-out; }
    @keyframes map-signal { from { box-shadow: 0 0 0 4px var(--accent); } to { box-shadow: 0 0 0 0 transparent; } }
    .metrics-panel { margin-top: 18px; }
    .metrics-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .kpi-card { background: var(--surface-soft); border: 2px solid var(--border); border-radius: 16px; padding: 10px 12px; display: grid; gap: 2px; }
    .kpi-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 800; }
    .kpi-value { font-size: 1.05rem; font-weight: 900; }
    .metrics-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    .metrics-table-wrap { overflow-x: auto; }
    .metrics-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .metrics-table th, .metrics-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .metrics-table th { color: var(--muted); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .metrics-muted { color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <div class="brand">
        <div class="brand-badge" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 36 36">
            <rect x="4" y="8" width="28" height="22" rx="9" fill="#a799ff" stroke="currentColor" stroke-width="2.5"/>
            <circle cx="13.5" cy="18.5" r="2.6" fill="#1c1b29"/>
            <circle cx="22.5" cy="18.5" r="2.6" fill="#1c1b29"/>
            <path d="M14.5 24 Q18 27 21.5 24" fill="none" stroke="#1c1b29" stroke-width="2.3" stroke-linecap="round"/>
            <line x1="18" y1="8" x2="18" y2="3.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="18" cy="3" r="2.2" fill="#f6d07a" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </div>
        <div>
          <h1>Agent Pair Studio</h1>
          <div class="brand-sub">Cozy live monitor for your multi-agent team</div>
        </div>
      </div>
      <div class="controls">
        <span class="pill" id="connPill"><span class="live-dot" id="connDot"></span><span id="connText">Connecting...</span></span>
        <select class="run-select" id="runSelect" style="display:none" aria-label="Active team run"></select>
        <button class="btn" id="teamMapBtn" type="button" aria-pressed="false">Team Map</button>
        <button class="btn" id="copyWorkerBtn" type="button" title="Copy the worker join prompt">Copy Worker Prompt</button>
        <button class="btn" id="soundBtn" type="button" title="Toggle soft chime sounds">Sound: Off</button>
        <button class="btn" id="themeBtn" type="button" title="Switch cozy dark or cream paper theme">Cream Paper</button>
      </div>
    </header>

    <details class="panel setup-panel" open>
      <summary>Set up a team</summary>
      <form id="setupForm">
        <div class="setup-fields">
          <div class="setup-workspace">
            <label for="setupWorkspace">Workspace folder</label>
            <div class="setup-path">
              <input id="setupWorkspace" name="workspace" required maxlength="4000" placeholder="Absolute path to your project" />
              ${process.platform === "win32" ? '<button class="btn" id="browseWorkspace" type="button">Browse…</button>' : ""}
            </div>
          </div>
          <label>Orchestrator
            <select name="leadProfile">${Object.entries(clientNames).map(([profile, label]) =>
              `<option value="${profile}">${label}</option>`).join("")}</select>
          </label>
          ${Object.entries(clientNames).map(([profile, label]) =>
            `<label>${label} workers<input name="${profile}" type="number" value="${profile === "antigravity" ? 1 : 0}" min="0" max="63" step="1" required /></label>`).join("")}
        </div>
        <div class="controls">
          <button class="btn" type="submit">Save team setup</button>
          <span class="setup-status" id="setupStatus" role="status"></span>
        </div>
      </form>
      <div class="setup-list" id="setupList"></div>
    </details>
    <dialog class="panel folder-picker" id="folderPicker" aria-labelledby="folderTitle">
      <h2 id="folderTitle">Choose workspace folder</h2>
      <div class="controls">
        <button class="btn" id="folderUp" type="button">Up</button>
        <button class="btn" id="folderHome" type="button">Home</button>
        <select class="run-select" id="folderDrive" aria-label="Drive"></select>
      </div>
      <p class="workspace-path" id="folderLocation"></p>
      <p id="folderStatus" role="status"></p>
      <div class="task-list" id="folderEntries"></div>
      <div class="controls folder-actions">
        <button class="btn active-toggle" id="chooseFolder" type="button" disabled>Use this folder</button>
        <button class="btn" id="cancelFolder" type="button">Cancel</button>
      </div>
    </dialog>
    <section id="teamMap" class="panel team-map" aria-label="Team map" hidden></section>
    <main id="app"></main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script nonce="${nonce}">
    const BASE = ${JSON.stringify(base)};
    const CLIENT_NAMES = ${JSON.stringify(clientNames)};
    const WORKER_PROMPT = "Use the Agent Pair skill to join the team waiting in this workspace. Follow your assigned tasks and file boundaries, and report blockers and handoffs to the orchestrator.";
    const ORCH_PROMPT = "Use the Agent Pair skill to orchestrate this workspace's plan.md. Check the dashboard team setup first. If there is no setup, ask me how many additional workers I want and which clients they should use. Start the team and tell me when it's waiting.";

    let snapshot = { now: Date.now(), runs: [], pendingPairs: [], setups: [] };
    let selectedRunId = null;
    let taskFilter = "all";
    let demoMode = false;
    let mapVisible = false;
    let mapSelection;
    let soundOn = false;
    let audioContext;
    let lastEventKey = "";

    const appEl = document.getElementById("app");
    const teamMap = document.getElementById("teamMap");
    const teamMapBtn = document.getElementById("teamMapBtn");
    teamMapBtn.addEventListener("click", () => {
      mapVisible = !mapVisible;
      if (mapVisible && !snapshot.runs.length) demoMode = true;
      render();
    });
    teamMap.addEventListener("click", (event) => {
      const node = event.target.closest("[data-map-member], [data-map-dependency]");
      if (!node) return;
      mapSelection = { runId: selectedRunId, member: node.dataset.mapMember, dependency: node.dataset.mapDependency };
      render();
    });
    const runSelect = document.getElementById("runSelect");
    const connDot = document.getElementById("connDot");
    const connText = document.getElementById("connText");
    const themeBtn = document.getElementById("themeBtn");
    const soundBtn = document.getElementById("soundBtn");
    const toastEl = document.getElementById("toast");
    const setupForm = document.getElementById("setupForm");
    const setupStatus = document.getElementById("setupStatus");
    const setupList = document.getElementById("setupList");
    const workspaceInput = document.getElementById("setupWorkspace");
    const picker = document.getElementById("folderPicker");
    const folderStatus = document.getElementById("folderStatus");
    const folderLocation = document.getElementById("folderLocation");
    const folderEntries = document.getElementById("folderEntries");
    const folderUp = document.getElementById("folderUp");
    const folderHome = document.getElementById("folderHome");
    const folderDrive = document.getElementById("folderDrive");
    const chooseFolder = document.getElementById("chooseFolder");
    let currentFolder;
    let folderRequest;

    async function browseFolder(path = "") {
      folderRequest?.abort();
      const request = new AbortController();
      folderRequest = request;
      folderStatus.textContent = "Loading folders?";
      chooseFolder.disabled = true;
      try {
        const response = await fetch(BASE + "/api/workspace-picker?path=" + encodeURIComponent(path), {
          method: "POST", signal: request.signal,
        });
        const result = await response.json();
        if (request.signal.aborted) return;
        if (!response.ok) throw new Error(result.error);
        currentFolder = result;
        folderLocation.textContent = result.workspace;
        folderUp.disabled = !result.parent;
        folderDrive.replaceChildren(new Option("Drives", ""));
        for (const drive of result.drives) folderDrive.add(new Option(drive, drive));
        folderEntries.replaceChildren(...result.folders.map((folder) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn";
          button.textContent = folder.name;
          button.addEventListener("click", () => browseFolder(folder.path));
          return button;
        }));
        folderStatus.textContent = result.folders.length ? "" : "No subfolders.";
      } catch (error) {
        if (!request.signal.aborted) folderStatus.textContent = error.message;
      } finally {
        if (!request.signal.aborted) chooseFolder.disabled = !currentFolder;
      }
    }

    document.getElementById("browseWorkspace").addEventListener("click", () => {
      picker.showModal();
      void browseFolder(workspaceInput.value.trim() || currentFolder?.workspace);
    });
    folderUp.addEventListener("click", () => { if (currentFolder?.parent) void browseFolder(currentFolder.parent); });
    folderHome.addEventListener("click", () => { void browseFolder(currentFolder?.home); });
    folderDrive.addEventListener("change", () => { if (folderDrive.value) void browseFolder(folderDrive.value); });
    chooseFolder.addEventListener("click", () => {
      workspaceInput.value = currentFolder.workspace;
      picker.close();
    });
    document.getElementById("cancelFolder").addEventListener("click", () => picker.close());
    picker.addEventListener("close", () => folderRequest?.abort());

    async function updateSetup(method, value) {
      const url = BASE + "/api/setup" + (method === "DELETE" ? "?id=" + encodeURIComponent(value) : "");
      const response = await fetch(url, method === "DELETE" ? { method } : {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }

    setupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      setupStatus.textContent = "Saving…";
      const fields = new FormData(setupForm);
      const workers = Object.fromEntries(Object.keys(CLIENT_NAMES).map((profile) => [profile, Number(fields.get(profile))]));
      try {
        await updateSetup("POST", { workspace: fields.get("workspace").trim(), leadProfile: fields.get("leadProfile"), workers });
        setupStatus.textContent = "Setup saved. Open the selected orchestrator in the workspace.";
      } catch (error) {
        setupStatus.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });

    setupList.addEventListener("click", async (event) => {
      const copy = event.target.closest("[data-setup-copy]");
      if (copy) {
        void copyText("Use the Agent Pair skill. Look up the saved dashboard team setup for this workspace, use it to orchestrate plan.md, and tell me when workers can join.", "Orchestrator prompt copied.");
        return;
      }
      const cancel = event.target.closest("[data-setup-cancel]");
      if (!cancel) return;
      try {
        await updateSetup("DELETE", cancel.dataset.setupCancel);
        setupStatus.textContent = "Setup canceled.";
      } catch (error) {
        setupStatus.textContent = error.message;
      }
    });

    let renderedSetups = "";
    function renderSetups(setups) {
      const fingerprint = JSON.stringify(setups);
      if (fingerprint === renderedSetups) return;
      renderedSetups = fingerprint;
      setupList.innerHTML = setups.map((setup) => {
        const workers = Object.entries(setup.workers).filter(([, count]) => count > 0)
          .map(([profile, count]) => count + " " + CLIENT_NAMES[profile]).join(", ");
        return '<article class="setup-row"><strong>' + esc(setup.workspace) + '</strong>' +
          '<p>Waiting for ' + esc(CLIENT_NAMES[setup.leadProfile]) + ' to orchestrate. Workers: ' + esc(workers) + '.</p>' +
          '<div class="controls"><button class="btn" data-setup-copy type="button">Copy Orchestrator Prompt</button>' +
          '<button class="btn" data-setup-cancel="' + esc(setup.id) + '" type="button">Cancel setup</button></div></article>';
      }).join("");
    }

    let savedTheme;
    try {
      savedTheme = localStorage.getItem("agent-pair-theme");
    } catch {}
    applyTheme(savedTheme === "cream" ? "cream" : "cozy-dark");

    function applyTheme(theme) {
      document.documentElement.setAttribute("data-theme", theme);
      try {
        localStorage.setItem("agent-pair-theme", theme);
      } catch {}
      themeBtn.textContent = theme === "cozy-dark" ? "Cream Paper" : "Cozy Night";
    }
    themeBtn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "cozy-dark" ? "cream" : "cozy-dark";
      applyTheme(next);
    });
    soundBtn.addEventListener("click", () => {
      soundOn = !soundOn;
      soundBtn.textContent = soundOn ? "Sound: On" : "Sound: Off";
      soundBtn.classList.toggle("active-toggle", soundOn);
      if (soundOn) playPop(520);
    });
    document.getElementById("copyWorkerBtn").addEventListener("click", () => copyText(WORKER_PROMPT, "Worker join prompt copied!"));
    runSelect.addEventListener("change", () => { selectedRunId = runSelect.value; render(); });

    let toastTimer = null;
    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
    }

    async function copyText(text, label) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(label);
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try {
          showToast(document.execCommand("copy") ? label : "Clipboard unavailable.");
        } catch {
          showToast("Clipboard unavailable.");
        } finally {
          area.remove();
        }
      }
    }

    function playPop(freq) {
      if (!soundOn) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = audioContext ??= new AudioCtx();
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.25, ctx.currentTime + 0.09);
        gain.gain.setValueAtTime(0.06, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } catch {}
    }

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }

    function relTime(ts) {
      if (!ts) return "not yet";
      const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (diff < 5) return "just now";
      if (diff < 60) return diff + "s ago";
      const mins = Math.floor(diff / 60);
      if (mins < 60) return mins + "m ago";
      return Math.floor(mins / 60) + "h ago";
    }

    function fmtDuration(ms) {
      if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
      if (ms < 1000) return ms + "ms";
      const secs = Math.round(ms / 1000);
      if (secs < 60) return secs + "s";
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      if (mins < 60) return mins + "m " + rem + "s";
      return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
    }

    function fmtTokens(usage) {
      if (!usage || usage.totalTokens === null || usage.totalTokens === undefined) return '<span class="metrics-muted">Not reported</span>';
      return Number(usage.totalTokens).toLocaleString();
    }

    function fmtCost(usage) {
      if (!usage || usage.costUsd === null || usage.costUsd === undefined) return '<span class="metrics-muted">Not reported</span>';
      return "$" + Number(usage.costUsd).toFixed(4);
    }

    function renderMetricsPanel(run) {
      const m = run.metrics;
      if (!m) return "";
      const totals = m.totals || {};
      const agents = Object.values(m.agents || {});
      const tasks = Object.values(m.tasks || {});
      const kpis = [
        ["Run Duration", fmtDuration(m.durationMs)],
        ["Tasks Accepted", (totals.acceptedTasks ?? 0) + " / " + (totals.tasks ?? 0)],
        ["Messages", String(totals.messagesSent ?? 0)],
        ["Handoffs", String(totals.handoffs ?? 0)],
        ["Revisions", String(totals.revisions ?? 0)],
        ["Violations", String(totals.ownershipViolations ?? 0)],
        ["Tokens", fmtTokens(totals.usage)],
        ["Cost", fmtCost(totals.usage)],
      ].map(([label, value]) =>
        '<div class="kpi-card"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + value + "</span></div>"
      ).join("");

      const agentRows = agents.length
        ? agents.map((a) =>
            "<tr>" +
              "<td><strong>" + esc(a.member) + "</strong></td>" +
              "<td>" + (a.profile ? '<span class="client-chip client-' + esc(a.profile) + '">' + esc(a.profile) + "</span>" : "—") + "</td>" +
              "<td>" + esc(a.tasksAccepted + " / " + a.tasksOwned) + "</td>" +
              "<td>" + esc(fmtDuration(a.totalActiveTimeMs)) + "</td>" +
              "<td>" + esc(a.messagesSent + " / " + a.messagesReceived) + "</td>" +
              "<td>" + esc(a.handoffsSubmitted) + "</td>" +
              "<td>" + esc(a.revisionsReceived) + "</td>" +
              "<td>" + esc(a.ownershipViolations) + "</td>" +
              "<td>" + fmtTokens(a.usage) + "</td>" +
              "<td>" + fmtCost(a.usage) + "</td>" +
            "</tr>"
          ).join("")
        : '<tr><td colspan="10" class="metrics-muted">No agent activity recorded yet.</td></tr>';

      const taskRows = tasks.length
        ? tasks.map((t) =>
            "<tr>" +
              '<td><span class="mono-pill">' + esc(t.taskId) + "</span></td>" +
              "<td>" + esc(t.owner || "—") + "</td>" +
              "<td>" + esc(t.state || "pending") + "</td>" +
              "<td>" + esc(fmtDuration(t.wallTimeMs)) + "</td>" +
              "<td>" + esc(t.handoffCount) + "</td>" +
              "<td>" + esc(t.revisionCount) + "</td>" +
              "<td>" + esc(t.ownershipViolationCount) + "</td>" +
              "<td>" + esc(t.messageCount) + "</td>" +
              "<td>" + fmtTokens(t.usage) + "</td>" +
              "<td>" + fmtCost(t.usage) + "</td>" +
            "</tr>"
          ).join("")
        : '<tr><td colspan="10" class="metrics-muted">No tasks recorded yet.</td></tr>';

      return (
        '<section class="panel metrics-panel" id="metricsPanel" aria-label="Metrics and cost">' +
          '<div class="section-head" style="margin-top:0"><h2>📊 Metrics &amp; Cost</h2><span style="font-size:0.82rem;color:var(--muted)">' + esc(m.eventCount) + " events · Cost shown when reported</span></div>" +
          '<div class="metrics-kpis">' + kpis + "</div>" +
          '<div class="metrics-grid">' +
            '<div class="metrics-table-wrap"><h3 style="margin:0 0 8px;font-size:0.9rem">Per-Agent Breakdown</h3>' +
              '<table class="metrics-table"><thead><tr><th>Agent</th><th>Profile</th><th>Tasks</th><th>Active Time</th><th>Msgs (S/R)</th><th>Handoffs</th><th>Revisions</th><th>Violations</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
              agentRows + "</tbody></table></div>" +
            '<div class="metrics-table-wrap"><h3 style="margin:0 0 8px;font-size:0.9rem">Per-Task Breakdown</h3>' +
              '<table class="metrics-table"><thead><tr><th>Task</th><th>Owner</th><th>State</th><th>Wall Time</th><th>Handoffs</th><th>Revisions</th><th>Violations</th><th>Msgs</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
              taskRows + "</tbody></table></div>" +
          "</div>" +
        "</section>"
      );
    }

    function statusInfo(status) {
      const map = {
        working: { label: "Working", cls: "st-working", icon: "⚡" },
        waiting: { label: "Waiting to join", cls: "st-waiting", icon: "⏳" },
        blocked: { label: "Paused / Blocked", cls: "st-blocked", icon: "🚧" },
        review: { label: "Ready for review", cls: "st-review", icon: "📬" },
        done: { label: "All done!", cls: "st-done", icon: "⭐" },
        idle: { label: "Connected · Idle", cls: "st-idle", icon: "☕" },
        disconnected: { label: "Disconnected", cls: "st-disconnected", icon: "👋" },
      };
      return map[status] || map.idle;
    }

    function taskStateInfo(state) {
      const map = {
        pending: { label: "Pending", cls: "st-waiting" },
        active: { label: "Active", cls: "st-working" },
        blocked: { label: "Blocked", cls: "st-blocked" },
        ready: { label: "Ready", cls: "st-review" },
        accepted: { label: "Accepted", cls: "st-done" },
      };
      return map[state] || map.pending;
    }

    function mascotSvg(profile, status, isOrchestrator) {
      const palette = {
        codex: { body: "#7bdff2", shade: "#56bfd4", visor: "#1e2740", accent: "#f6d07a" },
        antigravity: { body: "#b8b5ff", shade: "#8e88eb", visor: "#1d1b38", accent: "#8ce9c1" },
        claude: { body: "#f6a985", shade: "#df8660", visor: "#2d1f26", accent: "#ffe39f" },
      }[profile] || { body: "#b8b5ff", shade: "#8e88eb", visor: "#1d1b38", accent: "#f6d07a" };

      const crown = isOrchestrator
        ? '<path d="M23 14 L26 6 L33 11 L40 5 L47 11 L54 6 L57 14 Z" fill="#f6d07a" stroke="#2b2438" stroke-width="2.4" stroke-linejoin="round"/>'
        : "";

      let eyes = "";
      let mouth = "";
      let prop = "";
      if (status === "done") {
        eyes = '<path d="M27 39 Q31 34 35 39" fill="none" stroke="#fffdf8" stroke-width="2.8" stroke-linecap="round"/><path d="M45 39 Q49 34 53 39" fill="none" stroke="#fffdf8" stroke-width="2.8" stroke-linecap="round"/>';
        mouth = '<path d="M35 46 Q40 51 45 46" fill="none" stroke="#fffdf8" stroke-width="2.6" stroke-linecap="round"/>';
        prop = '<text x="61" y="20" font-size="14">✨</text>';
      } else if (status === "blocked") {
        eyes = '<path d="M28 35 L34 41 M34 35 L28 41 M46 35 L52 41 M52 35 L46 41" stroke="#ffaaaa" stroke-width="2.6" stroke-linecap="round"/>';
        mouth = '<path d="M35 48 Q40 44 45 48" fill="none" stroke="#ffaaaa" stroke-width="2.4" stroke-linecap="round"/>';
        prop = '<path d="M64 21 C64 21 69 27 69 30 A5 5 0 0 1 59 30 C59 27 64 21 64 21 Z" fill="#7bdff2" stroke="#2b2438" stroke-width="2"/>';
      } else if (status === "waiting") {
        eyes = '<line x1="27" y1="39" x2="34" y2="39" stroke="#f9d88b" stroke-width="2.8" stroke-linecap="round"/><line x1="46" y1="39" x2="53" y2="39" stroke="#f9d88b" stroke-width="2.8" stroke-linecap="round"/>';
        mouth = '<circle cx="40" cy="46" r="2.4" fill="#f9d88b"/>';
        prop = '<text x="58" y="21" font-size="12" fill="#f9d88b" font-weight="900">zZ</text>';
      } else if (status === "disconnected") {
        eyes = '<circle cx="31" cy="38" r="2.4" fill="#b5b0c7"/><circle cx="49" cy="38" r="2.4" fill="#b5b0c7"/>';
        mouth = '<line x1="36" y1="46" x2="44" y2="46" stroke="#b5b0c7" stroke-width="2.4" stroke-linecap="round"/>';
      } else if (status === "review") {
        eyes = '<circle cx="31" cy="38" r="3.4" fill="#fffdf8"/><circle cx="49" cy="38" r="3.4" fill="#fffdf8"/><circle cx="32.2" cy="36.8" r="1.2" fill="#1c1b29"/><circle cx="50.2" cy="36.8" r="1.2" fill="#1c1b29"/>';
        mouth = '<path d="M34 45 Q40 50 46 45" fill="none" stroke="#8ce9c1" stroke-width="2.6" stroke-linecap="round"/>';
        prop = '<circle cx="64" cy="22" r="9" fill="#879bff" stroke="#2b2438" stroke-width="2"/><path d="M60 22 L63 25 L68 19" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>';
      } else if (status === "working") {
        eyes = '<circle cx="31" cy="38" r="3.4" fill="#8ce9c1"/><circle cx="49" cy="38" r="3.4" fill="#8ce9c1"/><circle cx="32" cy="37" r="1.1" fill="#fff"/><circle cx="50" cy="37" r="1.1" fill="#fff"/>';
        mouth = '<path d="M35 45 Q40 49 45 45" fill="none" stroke="#8ce9c1" stroke-width="2.5" stroke-linecap="round"/>';
        prop = '<circle cx="64" cy="22" r="7" fill="#7ce0b5" stroke="#2b2438" stroke-width="2"/><circle cx="64" cy="22" r="2.2" fill="#2b2438"/>';
      } else {
        eyes = '<circle cx="31" cy="38" r="3.1" fill="#fffdf8"/><circle cx="49" cy="38" r="3.1" fill="#fffdf8"/>';
        mouth = '<path d="M36 45 Q40 48 44 45" fill="none" stroke="#fffdf8" stroke-width="2.3" stroke-linecap="round"/>';
      }

      let body = "";
      if (profile === "codex") {
        body =
          '<line x1="40" y1="18" x2="40" y2="11" stroke="#2b2438" stroke-width="3" stroke-linecap="round"/>' +
          '<circle cx="40" cy="10" r="3.5" fill="' + palette.accent + '" stroke="#2b2438" stroke-width="2"/>' +
          '<rect x="14" y="18" width="52" height="46" rx="16" fill="' + palette.body + '" stroke="#2b2438" stroke-width="2.8"/>' +
          '<rect x="21" y="27" width="38" height="26" rx="10" fill="' + palette.visor + '" stroke="#2b2438" stroke-width="2.2"/>' +
          '<circle cx="20" cy="54" r="3" fill="#ff9eb5" opacity="0.7"/>' +
          '<circle cx="60" cy="54" r="3" fill="#ff9eb5" opacity="0.7"/>';
      } else if (profile === "antigravity") {
        body =
          '<ellipse cx="40" cy="49" rx="33" ry="9" fill="none" stroke="' + palette.accent + '" stroke-width="3.2" transform="rotate(-12 40 49)"/>' +
          '<circle cx="40" cy="41" r="25" fill="' + palette.body + '" stroke="#2b2438" stroke-width="2.8"/>' +
          '<rect x="21" y="28" width="38" height="25" rx="12" fill="' + palette.visor + '" stroke="#2b2438" stroke-width="2.2"/>' +
          '<circle cx="19" cy="49" r="3" fill="#ff9eb5" opacity="0.7"/>' +
          '<circle cx="61" cy="49" r="3" fill="#ff9eb5" opacity="0.7"/>';
      } else {
        body =
          '<circle cx="22" cy="21" r="7" fill="' + palette.shade + '" stroke="#2b2438" stroke-width="2.5"/>' +
          '<circle cx="58" cy="21" r="7" fill="' + palette.shade + '" stroke="#2b2438" stroke-width="2.5"/>' +
          '<rect x="15" y="19" width="50" height="45" rx="20" fill="' + palette.body + '" stroke="#2b2438" stroke-width="2.8"/>' +
          '<rect x="22" y="28" width="36" height="25" rx="11" fill="' + palette.visor + '" stroke="#2b2438" stroke-width="2.2"/>' +
          '<circle cx="21" cy="54" r="3.2" fill="#ff9eb5" opacity="0.7"/>' +
          '<circle cx="59" cy="54" r="3.2" fill="#ff9eb5" opacity="0.7"/>';
      }

      return '<svg class="avatar-svg" viewBox="0 0 80 72" aria-hidden="true">' + body + crown + eyes + mouth + prop + "</svg>";
    }

    function buildDemoSnapshot() {
      const now = Date.now();
      return {
        now,
        pendingPairs: [],
        runs: [{
          id: "demo-run",
          mode: "team",
          workspace: "D:\\\\Projects\\\\cozy-app",
          workspaceName: "cozy-app (Demo Preview)",
          tag: "7K4M",
          missingSessionIds: [],
          waitingFor: 1,
          createdAt: now - 240_000,
          expiresAt: now + 1_560_000,
          members: [
            { member: "orchestrator", profile: "codex", isOrchestrator: true, connected: true, claimed: true, hasSessionId: true, status: "working", currentTaskId: "api", currentTaskTitle: "Build REST API & OpenAPI schema", unread: 1, lastActivityAt: now - 8_000 },
            { member: "frontend", profile: "antigravity", isOrchestrator: false, connected: true, claimed: true, hasSessionId: true, status: "review", currentTaskId: "ui", currentTaskTitle: "Design cozy task board UI", unread: 0, lastActivityAt: now - 19_000 },
            { member: "quality", profile: "claude", isOrchestrator: false, connected: true, claimed: true, hasSessionId: true, status: "blocked", currentTaskId: "fixtures", currentTaskTitle: "Prepare test fixtures", unread: 0, lastActivityAt: now - 45_000 },
            { member: "docs", profile: "antigravity", isOrchestrator: false, connected: false, claimed: false, hasSessionId: false, status: "waiting", currentTaskId: "readme", currentTaskTitle: "Write quickstart & examples", unread: 0 },
          ],
          tasks: [
            { id: "api", owner: "orchestrator", profile: "codex", title: "Build REST API & OpenAPI schema", paths: ["src/api/"], checks: ["npm test passes"], dependsOn: [], state: "accepted", note: "Endpoints verified", evidence: ["All 14 API tests passed"] },
            { id: "ui", owner: "frontend", profile: "antigravity", title: "Design cozy task board UI", paths: ["src/ui/"], checks: ["UI renders cleanly"], dependsOn: ["api"], state: "ready", note: "UI ready with dark & cream themes!", evidence: ["Build succeeded", "Responsive layout verified"] },
            { id: "fixtures", owner: "quality", profile: "claude", title: "Prepare test fixtures", paths: ["test/fixtures/"], checks: ["Fixtures cover common failures"], dependsOn: [], state: "blocked", note: "Waiting for the mock auth token helper." },
            { id: "tests", owner: "quality", profile: "claude", title: "Add end-to-end integration tests", paths: ["test/"], checks: ["E2E suite green"], dependsOn: ["ui"], state: "pending" },
            { id: "readme", owner: "docs", profile: "antigravity", title: "Write quickstart & examples", paths: ["README.md"], checks: ["Links verified"], dependsOn: [], state: "pending" },
          ],
          messages: [
            { id: 1, taskId: "api", kind: "handoff", from: "orchestrator", to: "frontend", body: "API contract is accepted and ready for UI integration.", createdAt: new Date(now - 90_000).toISOString(), acknowledged: true },
            { id: 2, taskId: "ui", kind: "handoff", from: "frontend", to: "orchestrator", body: "Finished the cartoony UI cards and theme toggle! Ready for review.", createdAt: new Date(now - 25_000).toISOString(), acknowledged: false, checks: ["Build passed", "No console warnings"] },
            { id: 3, taskId: "tests", kind: "blocker", from: "quality", to: "orchestrator", body: "Need the mock auth token helper before running E2E suite.", createdAt: new Date(now - 15_000).toISOString(), acknowledged: false },
          ],
          metrics: {
            runId: "demo-run",
            startedAt: now - 240_000,
            updatedAt: now,
            durationMs: 240_000,
            eventCount: 11,
            totals: {
              tasks: 5, acceptedTasks: 1, handoffs: 2, revisions: 0, ownershipViolations: 0, ownershipRejections: 0, messagesSent: 3, messagesAcked: 1,
              usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] },
            },
            agents: {
              orchestrator: { member: "orchestrator", profile: "codex", tasksOwned: 1, tasksAccepted: 1, totalTaskWallTimeMs: 120_000, totalActiveTimeMs: 120_000, messagesSent: 1, messagesReceived: 2, messagesAcked: 0, handoffsSubmitted: 1, revisionsReceived: 0, ownershipViolations: 0, ownershipRejections: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] } },
              frontend: { member: "frontend", profile: "antigravity", tasksOwned: 1, tasksAccepted: 0, totalTaskWallTimeMs: 65_000, totalActiveTimeMs: 65_000, messagesSent: 1, messagesReceived: 1, messagesAcked: 1, handoffsSubmitted: 1, revisionsReceived: 0, ownershipViolations: 0, ownershipRejections: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] } },
              quality: { member: "quality", profile: "claude", tasksOwned: 2, tasksAccepted: 0, totalTaskWallTimeMs: 40_000, totalActiveTimeMs: 25_000, messagesSent: 1, messagesReceived: 0, messagesAcked: 0, handoffsSubmitted: 0, revisionsReceived: 0, ownershipViolations: 0, ownershipRejections: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] } },
            },
            tasks: {
              api: { taskId: "api", owner: "orchestrator", state: "accepted", startedAt: now - 210_000, completedAt: now - 90_000, wallTimeMs: 120_000, activeTimeMs: 120_000, handoffCount: 1, revisionCount: 0, ownershipViolationCount: 0, ownershipRejectionCount: 0, blockCount: 0, messageCount: 1, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] } },
              ui: { taskId: "ui", owner: "frontend", state: "ready", startedAt: now - 90_000, completedAt: null, wallTimeMs: 90_000, activeTimeMs: 65_000, handoffCount: 1, revisionCount: 0, ownershipViolationCount: 0, ownershipRejectionCount: 0, blockCount: 0, messageCount: 1, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] } },
              fixtures: { taskId: "fixtures", owner: "quality", state: "blocked", startedAt: now - 85_000, completedAt: null, wallTimeMs: 85_000, activeTimeMs: 25_000, handoffCount: 0, revisionCount: 0, ownershipViolationCount: 0, ownershipRejectionCount: 0, blockCount: 1, messageCount: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reportCount: 0, models: [] } },
            },
            usageReports: [],
          },
        }],
      };
    }

    function activeData() {
      if (snapshot.runs.length > 0) {
        demoMode = false;
        return snapshot;
      }
      if (demoMode) return buildDemoSnapshot();
      return snapshot;
    }

    function renderMap(run, pulse) {
      teamMap.hidden = !mapVisible || !run;
      teamMapBtn.setAttribute("aria-pressed", String(!teamMap.hidden));
      teamMapBtn.classList.toggle("active-toggle", !teamMap.hidden);
      if (teamMap.hidden) return;
      const lead = run.members.find((member) => member.isOrchestrator);
      const workers = run.members.filter((member) => member !== lead);
      const tasks = new Map(run.tasks.map((task) => [task.id, task]));
      const links = run.tasks.flatMap((task) => task.dependsOn.map((id) => ({
        from: tasks.get(id), to: task, key: id + "/" + task.id,
      }))).filter((link) => link.from);
      const selection = mapSelection?.runId === run.id ? mapSelection : null;
      const dependency = links.find((link) => link.key === selection?.dependency);
      const member = run.members.find((entry) => entry.member === selection?.member) || lead;
      const reviewCount = run.tasks.filter((task) => task.state === "ready").length;
      const blockedCount = run.tasks.filter((task) => task.state === "blocked").length;
      const waitingCount = links.filter((link) => link.to.state === "pending" && link.from.state !== "accepted").length;
      const signalMembers = pulse?.runId === run.id ? pulse.members : [];

      function botRole(entry) {
        if (entry.isOrchestrator) return ["lead", "Coordination"];
        const task = tasks.get(entry.currentTaskId);
        const assignment = (entry.member + " " + (task ? task.id + " " + task.paths.join(" ") + " " + task.title : "")).toLowerCase();
        if (/\\b(frontend|ui|ux|design|styles|components)\\b/.test(assignment)) return ["frontend", "Frontend"];
        if (/\\b(quality|qa|tests?|fixtures)\\b/.test(assignment)) return ["quality", "Testing"];
        if (/\\b(docs|documentation|readme|copy)\\b/.test(assignment)) return ["docs", "Documentation"];
        if (/\\b(backend|api|server|database)\\b/.test(assignment)) return ["backend", "Backend"];
        if (/\\b(build|ci|deploy|release|automation)\\b/.test(assignment)) return ["build", "Build and release"];
        return ["general", "General work"];
      }

      function node(entry) {
        const info = statusInfo(entry.status);
        const [botColor, botLabel] = botRole(entry);
        return '<button class="map-node" type="button" data-map-member="' + esc(entry.member) +
          '" aria-pressed="' + String(!dependency && member === entry) + '">' +
          '<span class="map-bot-row"><span class="map-bot map-bot-' + botColor + ' map-bot-' + esc(entry.status) +
          '" aria-hidden="true"><span class="map-bot-eyes"></span></span><span class="map-bot-role">' + botLabel + '</span></span>' +
          '<span class="map-node-top"><strong>' + esc(entry.isOrchestrator ? "Orchestrator" : entry.member) +
          '</strong><span class="client-chip client-' + esc(entry.profile) + '">' + esc(CLIENT_NAMES[entry.profile]) +
          '</span></span><span class="state-badge ' + info.cls + '">' + esc(info.label) + '</span>' +
          (entry.currentTaskTitle ? '<span>' + esc(entry.currentTaskTitle) + '</span>' : '') + '</button>';
      }

      let detail = "";
      if (dependency) {
        detail = '<strong>' + esc(dependency.to.title) + '</strong><p>Depends on ' + esc(dependency.from.title) +
          ' (' + esc(dependency.from.owner) + ').</p><p>' +
          (dependency.from.state === "accepted" ? "Prerequisite accepted." : "The orchestrator must accept the prerequisite before this task can start.") +
          '</p>' + (dependency.from.note ? '<p>' + esc(dependency.from.note) + '</p>' : '');
      } else if (member) {
        const owned = run.tasks.filter((task) => task.owner === member.member);
        const latest = run.messages.findLast((message) => message.from === member.member || message.to === member.member);
        detail = '<strong>' + esc(member.isOrchestrator ? "Orchestrator" : member.member) + '</strong>' +
          owned.map((task) => '<p><strong>' + esc(task.title) + '</strong> · ' + esc(taskStateInfo(task.state).label) +
            '<br>Owned paths: ' + esc(task.paths.join(", ") || "None") + '</p>' +
            (task.note ? '<p>' + esc(task.note) + '</p>' : '')).join("") +
          (latest ? '<p>Latest message (' + esc(latest.from) + ' → ' + esc(latest.to) + '): ' + esc(latest.body) + '</p>' : '');
      }

      const focused = teamMap.contains(document.activeElement) ? document.activeElement.dataset : null;
      teamMap.innerHTML =
        '<div class="map-header"><h2>Team Map</h2>' + (demoMode ? '<span class="pill">Demo</span>' : '') + '</div>' +
        '<div class="map-attention"><span class="pill">' + reviewCount + ' ready for review</span>' +
          '<span class="pill">' + blockedCount + ' blocked</span><span class="pill">' + waitingCount + ' unmet dependencies</span></div>' +
        (lead ? '<div class="map-lead">' + node(lead) + '</div>' : '') +
        (workers.length ? '<div class="map-stem' + (signalMembers.length ? ' map-pulse' : '') + '"></div><div class="map-workers">' +
          workers.map((worker) => '<div class="map-branch' + (signalMembers.includes(worker.member) ? ' map-pulse' : '') + '">' +
            node(worker) + '</div>').join("") + '</div>' : '') +
        (detail ? '<div class="map-detail">' + detail + '</div>' : '') +
        (links.length ? '<div class="map-section"><h3>Task dependencies</h3><div class="map-dependencies">' +
          links.map((link) => '<button class="btn map-dependency' +
            (dependency === link ? ' active-toggle' : '') + '" type="button" data-map-dependency="' + esc(link.key) +
            '" aria-pressed="' + String(dependency === link) + '">' + esc(link.from.title) + ' → ' + esc(link.to.title) +
            ' <span class="state-badge ' + (link.from.state === "accepted" ? 'st-done' : 'st-waiting') + '">' +
            (link.from.state === "accepted" ? 'Accepted' : 'Awaiting acceptance') + '</span></button>').join("") +
          '</div></div>' : '');
      if (focused) {
        const selector = focused.mapMember ? "[data-map-member]" : "[data-map-dependency]";
        [...teamMap.querySelectorAll(selector)].find((element) =>
          focused.mapMember ? element.dataset.mapMember === focused.mapMember
            : element.dataset.mapDependency === focused.mapDependency)?.focus({ preventScroll: true });
      }
    }

    function render(pulse) {
      const data = activeData();
      const run = data.runs.find((r) => r.id === selectedRunId) || data.runs[0];
      renderMap(run, pulse);
      if (data.runs.length > 1) {
        runSelect.style.display = "inline-flex";
        runSelect.innerHTML = data.runs.map((r) =>
          '<option value="' + esc(r.id) + '"' + (r.id === run.id ? " selected" : "") + ">" +
          esc(r.workspaceName) + " (" + r.members.filter((m) => m.connected).length + "/" + r.members.length + ")</option>"
        ).join("");
      } else {
        runSelect.style.display = "none";
      }

      if (!run) {
        delete appEl.dataset.runId;
        renderLounge(data.pendingPairs);
        return;
      }

      selectedRunId = run.id;

      const taskMap = new Map(run.tasks.map((t) => [t.id, t]));
      const acceptedCount = run.tasks.filter((t) => t.state === "accepted").length;
      const pct = run.tasks.length ? Math.round((acceptedCount / run.tasks.length) * 100) : 0;

      let tagHtml = "";
      if (run.tag) {
        tagHtml =
          '<button class="tag-chip" type="button" id="copyTagBtn" title="Click to copy resume command">' +
            '<div><div class="tag-hint">Resume Tag (click to copy)</div><div class="tag-code">' + esc(run.tag) + "</div></div>" +
          "</button>";
      } else if (run.waitingFor > 0) {
        tagHtml = '<span class="pill st-waiting">⏳ Tag creates after ' + run.waitingFor + " worker" + (run.waitingFor === 1 ? "" : "s") + " join</span>";
      } else if (run.missingSessionIds && run.missingSessionIds.length) {
        tagHtml = '<span class="pill st-blocked">⚠ No tag — missing sessionId: ' + esc(run.missingSessionIds.join(", ")) + "</span>";
      } else if (run.bookmarkError) {
        tagHtml = '<span class="pill st-blocked">⚠ ' + esc(run.bookmarkError) + "</span>";
      }

      const memberCards = run.members.map((m) => {
        const info = statusInfo(m.status);
        const ownedTasks = run.tasks.filter((t) => t.owner === m.member);
        const blockedTask = ownedTasks.find((t) => t.state === "blocked" && t.note);
        const readyTask = ownedTasks.find((t) => t.state === "ready" && t.note);
        const latestMsg = [...run.messages].reverse().find((msg) => msg.from === m.member);
        let bubbleLabel = "";
        let bubbleText = "";
        if (!m.claimed) {
          bubbleLabel = "Empty Seat";
          bubbleText = "Open a fresh " + m.profile + " session in this folder and paste the Worker Prompt!";
        } else if (blockedTask) {
          bubbleLabel = "Blocker on " + blockedTask.id;
          bubbleText = blockedTask.note;
        } else if (readyTask) {
          bubbleLabel = "Handoff on " + readyTask.id;
          bubbleText = readyTask.note;
        } else if (latestMsg) {
          bubbleLabel = "Sent " + latestMsg.kind + " ➔ " + latestMsg.to;
          bubbleText = latestMsg.body.length > 120 ? latestMsg.body.slice(0, 117) + "..." : latestMsg.body;
        } else if (m.currentTaskTitle) {
          bubbleLabel = "Assigned · " + m.currentTaskId;
          bubbleText = m.currentTaskTitle;
        } else {
          bubbleLabel = "Status";
          bubbleText = m.status === "done" ? "All assigned work accepted!" : "Standing by for updates.";
        }

        const unreadHtml = m.unread > 0 ? '<span class="unread-badge" title="Unread messages">' + m.unread + "</span>" : "";
        const crownTag = m.isOrchestrator ? " 👑" : "";
        const sessionDot = m.claimed ? (m.hasSessionId ? "🔖 ID ready" : "⚠ no sessionId") : "waiting";

        return (
          '<article class="agent-card status-' + esc(m.status) + '">' +
            '<div class="agent-top">' +
              '<div class="avatar-wrap">' + mascotSvg(m.profile, m.status, m.isOrchestrator) + unreadHtml + "</div>" +
              '<div class="agent-meta">' +
                '<div class="agent-name">' + esc(m.member) + crownTag +
                  ' <span class="client-chip client-' + esc(m.profile) + '">' + esc(m.profile) + "</span>" +
                "</div>" +
                '<div class="state-badge ' + info.cls + '">' + info.icon + " " + info.label + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="speech-bubble">' +
              '<div class="speech-label">' + esc(bubbleLabel) + "</div>" +
              "<div>" + esc(bubbleText) + "</div>" +
            "</div>" +
            '<div class="agent-foot">' +
              "<span>" + ownedTasks.length + " task" + (ownedTasks.length === 1 ? "" : "s") + " · " + sessionDot + "</span>" +
              '<span data-rel="' + (m.lastActivityAt || "") + '">' + (m.lastActivityAt ? "Seen " + relTime(m.lastActivityAt) : "Not joined") + "</span>" +
            "</div>" +
          "</article>"
        );
      }).join("");

      const filteredTasks = run.tasks.filter((t) => taskFilter === "all" || t.state === taskFilter);
      const taskHtml = filteredTasks.length
        ? filteredTasks.map((t) => {
            const st = taskStateInfo(t.state);
            const deps = t.dependsOn.map((depId) => {
              const dep = taskMap.get(depId);
              const ok = dep && dep.state === "accepted";
              return '<span class="mono-pill">' + (ok ? "✓ " : "⏳ ") + esc(depId) + "</span>";
            }).join("");
            const paths = t.paths.map((p) => '<span class="mono-pill">' + esc(p) + "</span>").join("");
            const note = t.note ? '<div class="note-box"><strong>Note:</strong> ' + esc(t.note) + "</div>" : "";
            const evidence = t.evidence && t.evidence.length
              ? '<div class="chip-row">' + t.evidence.map((e) => '<span class="mono-pill">✓ ' + esc(e) + "</span>").join("") + "</div>"
              : "";
            return (
              '<div class="task-item">' +
                '<div class="task-top">' +
                  '<div class="task-title"><span class="mono-pill">' + esc(t.id) + "</span> " + esc(t.title) + "</div>" +
                  '<span class="state-badge ' + st.cls + '">' + st.label + "</span>" +
                "</div>" +
                '<div class="chip-row">' +
                  '<span class="client-chip client-' + esc(t.profile) + '">' + esc(t.owner) + " (" + esc(t.profile) + ")</span>" +
                  paths +
                  (deps ? '<span style="font-size:0.75rem;color:var(--muted);font-weight:700">Deps:</span>' + deps : "") +
                "</div>" +
                note + evidence +
              "</div>"
            );
          }).join("")
        : '<div class="mono-pill" style="padding:14px;text-align:center">No tasks match this filter yet.</div>';

      const msgHtml = run.messages.length
        ? [...run.messages].reverse().map((msg) => {
            const kindCls = msg.kind === "blocker" ? "st-blocked"
              : msg.kind === "handoff" ? "st-review"
              : msg.kind === "assignment" ? "st-working"
              : "st-idle";
            const ts = Date.parse(msg.createdAt);
            return (
              '<div class="msg-item' + (msg.acknowledged ? "" : " unread") + '">' +
                '<div class="msg-head">' +
                  '<span>' + esc(msg.from) + " ➔ " + esc(msg.to) + ' <span class="mono-pill">' + esc(msg.taskId) + "</span></span>" +
                  '<span class="chip-row">' +
                    '<span class="state-badge ' + kindCls + '" style="margin:0;padding:2px 8px;font-size:0.72rem">' + esc(msg.kind) + "</span>" +
                    '<span style="color:var(--muted);font-size:0.74rem">' + (msg.acknowledged ? "✓ Read" : "● Unread") + " · " + relTime(ts) + "</span>" +
                  "</span>" +
                "</div>" +
                '<div class="msg-body">' + esc(msg.body) + "</div>" +
                (msg.checks && msg.checks.length
                  ? '<div class="chip-row">' + msg.checks.map((c) => '<span class="mono-pill">✓ ' + esc(c) + "</span>").join("") + "</div>"
                  : "") +
              "</div>"
            );
          }).join("")
        : '<div class="mono-pill" style="padding:14px;text-align:center">No messages exchanged yet — quiet studio!</div>';

      const demoBanner = demoMode
        ? '<div class="demo-banner"><span>👀 Showing playful Demo Preview — will auto-switch as soon as a real team starts!</span><button class="btn" id="exitDemoBtn" type="button">Back to Live</button></div>'
        : "";

      const filters = ["all", "active", "blocked", "ready", "pending", "accepted"].map((f) =>
        '<button class="filter-btn' + (taskFilter === f ? " active" : "") + '" data-filter="' + f + '" type="button">' +
        f[0].toUpperCase() + f.slice(1) + "</button>"
      ).join("");

      const connectedCount = run.members.filter((m) => m.connected).length;
      const sameRun = appEl.dataset.runId === run.id;
      const taskScroll = sameRun ? appEl.querySelector(".task-list")?.scrollTop : 0;
      const messageScroll = sameRun ? appEl.querySelector(".msg-list")?.scrollTop : 0;
      appEl.dataset.runId = run.id;
      appEl.innerHTML =
        demoBanner +
        '<section class="hero-strip">' +
          '<div class="workspace-info">' +
            '<div class="workspace-name">📁 ' + esc(run.workspaceName) +
              ' <span class="pill" style="box-shadow:none;padding:3px 10px;font-size:0.76rem">' +
              connectedCount + " / " + run.members.length + " connected</span>" +
            "</div>" +
            '<div class="workspace-path">' + esc(run.workspace) + "</div>" +
          "</div>" +
          '<div class="tag-box">' + tagHtml + "</div>" +
        "</section>" +
        '<div class="section-head"><h2>🎭 Team Stage</h2><span style="font-size:0.82rem;color:var(--muted)">Workers work under the orchestrator 👑</span></div>' +
        '<section class="stage-grid">' + memberCards + "</section>" +
        '<section class="lower-grid">' +
          '<div class="panel">' +
            '<div class="section-head" style="margin-top:0"><h2>📋 Task Board</h2><span style="font-size:0.82rem;color:var(--muted)">' + acceptedCount + " / " + run.tasks.length + " accepted</span></div>" +
            '<div class="progress-wrap">' +
              '<div class="progress-meta"><span>Team Progress</span><span>' + pct + "%</span></div>" +
              '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
            "</div>" +
            '<div class="filter-row">' + filters + "</div>" +
            '<div class="task-list">' + taskHtml + "</div>" +
          "</div>" +
          '<div class="panel">' +
            '<div class="section-head" style="margin-top:0"><h2>💬 Walkie-Talkie</h2><span style="font-size:0.82rem;color:var(--muted)">' + run.messages.length + " message" + (run.messages.length === 1 ? "" : "s") + "</span></div>" +
            '<div class="msg-list">' + msgHtml + "</div>" +
          "</div>" +
        "</section>" +
        renderMetricsPanel(run);

      appEl.querySelector(".task-list").scrollTop = taskScroll || 0;
      appEl.querySelector(".msg-list").scrollTop = messageScroll || 0;
      const copyTagBtn = document.getElementById("copyTagBtn");
      if (copyTagBtn && run.tag) {
        copyTagBtn.addEventListener("click", () => copyText("agent-pair resume " + run.tag, "Copied: agent-pair resume " + run.tag));
      }
      const exitDemoBtn = document.getElementById("exitDemoBtn");
      if (exitDemoBtn) {
        exitDemoBtn.addEventListener("click", () => { demoMode = false; render(); });
      }
      appEl.querySelectorAll("[data-filter]").forEach((btn) => {
        btn.addEventListener("click", () => { taskFilter = btn.getAttribute("data-filter"); render(); });
      });
    }

    function renderLounge(pendingPairs) {
      const pendingHtml = pendingPairs.length
        ? '<div style="margin:16px auto;max-width:520px">' + pendingPairs.map((p) =>
            '<div class="pill st-waiting" style="margin:4px">⏳ ' + esc(p.role) + " waiting in " + esc(p.workspaceName) + "</div>"
          ).join("") + "</div>"
        : "";
      appEl.innerHTML =
        '<section class="lounge">' +
          '<div class="lounge-crew">' +
            '<div class="lounge-buddy">' + mascotSvg("codex", "idle", true) + "</div>" +
            '<div class="lounge-buddy">' + mascotSvg("antigravity", "working", false) + "</div>" +
            '<div class="lounge-buddy">' + mascotSvg("claude", "review", false) + "</div>" +
          "</div>" +
          "<h2>The Agent Lounge is Ready!</h2>" +
          "<p>Start a team in Codex, Antigravity, or Claude Code and this studio will spring to life automatically as each buddy joins, works, pauses, and hands off tasks.</p>" +
          pendingHtml +
          '<div class="lounge-actions">' +
            '<button class="btn" id="loungeOrchBtn" type="button">Copy Orchestrator Prompt</button>' +
            '<button class="btn" id="loungeWorkerBtn" type="button">Copy Worker Prompt</button>' +
            '<button class="btn active-toggle" id="demoBtn" type="button">Preview Team Map Demo</button>' +
          "</div>" +
        "</section>";
      document.getElementById("loungeOrchBtn").addEventListener("click", () => copyText(ORCH_PROMPT, "Orchestrator prompt copied!"));
      document.getElementById("loungeWorkerBtn").addEventListener("click", () => copyText(WORKER_PROMPT, "Worker join prompt copied!"));
      document.getElementById("demoBtn").addEventListener("click", () => {
        demoMode = true;
        mapVisible = true;
        render({ runId: "demo-run", members: ["frontend"] });
      });
    }

    function connectEvents() {
      const source = new EventSource(BASE + "/events");
      source.addEventListener("open", () => {
        connDot.classList.remove("offline");
        connText.textContent = "Live";
      });
      source.addEventListener("snapshot", (event) => {
        const next = JSON.parse(event.data);
        const key = next.runs.map((r) => r.id + ":" + r.members.filter((m) => m.connected).length + ":" + r.messages.length + ":" + r.tasks.map((t) => t.state).join(",")).join("|");
        if (lastEventKey && key !== lastEventKey) playPop(440);
        lastEventKey = key;
        const upcoming = next.runs.find((run) => run.id === selectedRunId) || next.runs[0];
        const previous = snapshot.runs.find((run) => run.id === upcoming?.id);
        let pulse;
        if (previous) {
          const sent = upcoming.messages.slice(previous.messages.length);
          const joined = upcoming.members.filter((member) => member.connected &&
            previous.members.some((old) => old.member === member.member && !old.connected));
          const members = [...new Set([...sent.flatMap((message) => [message.from, message.to]), ...joined.map((member) => member.member)])];
          if (members.length) pulse = { runId: upcoming.id, members };
        }
        snapshot = next;
        renderSetups(next.setups);
        connDot.classList.remove("offline");
        connText.textContent = "Live";
        render(pulse);
      });
      source.addEventListener("error", () => {
        connDot.classList.add("offline");
        connText.textContent = "Relay napping (reconnecting...)";
      });
    }

    setInterval(() => {
      document.querySelectorAll("[data-rel]").forEach((el) => {
        const ts = Number(el.getAttribute("data-rel"));
        if (ts) el.textContent = "Seen " + relTime(ts);
      });
    }, 5000);

    render();
    connectEvents();
  </script>
</body>
</html>
`;
}
