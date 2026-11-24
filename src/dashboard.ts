import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Relay } from "./relay.js";

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

  constructor(private readonly relay: Relay) {}

  get hasClients(): boolean {
    return this.clients.size > 0;
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
    this.unsubscribe = this.relay.subscribe(() => this.scheduleBroadcast());
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.writableEnded && !client.writableNeedDrain) client.write(": ping\n\n");
      }
    }, 15_000);
    this.heartbeat.unref();
    return this.addressUrl;
  }

  close(): void {
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

  private snapshotEvent(): string {
    return `event: snapshot\ndata: ${JSON.stringify(this.relay.snapshot())}\n\n`;
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
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }
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
      res.end(JSON.stringify(this.relay.snapshot()));
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
        <button class="btn" id="copyWorkerBtn" type="button" title="Copy the worker join prompt">Copy Worker Prompt</button>
        <button class="btn" id="soundBtn" type="button" title="Toggle soft chime sounds">Sound: Off</button>
        <button class="btn" id="themeBtn" type="button" title="Switch cozy dark or cream paper theme">Cream Paper</button>
      </div>
    </header>

    <main id="app"></main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script nonce="${nonce}">
    const BASE = ${JSON.stringify(base)};
    const WORKER_PROMPT = "Use the Agent Pair skill to join the team waiting in this workspace. Follow your assigned tasks and file boundaries, and report blockers and handoffs to the orchestrator.";
    const ORCH_PROMPT = "Use the Agent Pair skill to orchestrate this workspace's plan.md. Ask me how many additional workers I want and which clients they should use. Start the team and tell me when it's waiting.";

    let snapshot = { now: Date.now(), runs: [], pendingPairs: [] };
    let selectedRunId = null;
    let taskFilter = "all";
    let demoMode = false;
    let soundOn = false;
    let audioContext;
    let lastEventKey = "";

    const appEl = document.getElementById("app");
    const runSelect = document.getElementById("runSelect");
    const connDot = document.getElementById("connDot");
    const connText = document.getElementById("connText");
    const themeBtn = document.getElementById("themeBtn");
    const soundBtn = document.getElementById("soundBtn");
    const toastEl = document.getElementById("toast");

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
            { member: "quality", profile: "claude", isOrchestrator: false, connected: true, claimed: true, hasSessionId: true, status: "blocked", currentTaskId: "tests", currentTaskTitle: "Add end-to-end integration tests", unread: 0, lastActivityAt: now - 45_000 },
            { member: "docs", profile: "antigravity", isOrchestrator: false, connected: false, claimed: false, hasSessionId: false, status: "waiting", currentTaskId: "readme", currentTaskTitle: "Write quickstart & examples", unread: 0 },
          ],
          tasks: [
            { id: "api", owner: "orchestrator", profile: "codex", title: "Build REST API & OpenAPI schema", paths: ["src/api/"], checks: ["npm test passes"], dependsOn: [], state: "accepted", note: "Endpoints verified", evidence: ["All 14 API tests passed"] },
            { id: "ui", owner: "frontend", profile: "antigravity", title: "Design cozy task board UI", paths: ["src/ui/"], checks: ["UI renders cleanly"], dependsOn: ["api"], state: "ready", note: "UI ready with dark & cream themes!", evidence: ["Build succeeded", "Responsive layout verified"] },
            { id: "tests", owner: "quality", profile: "claude", title: "Add end-to-end integration tests", paths: ["test/"], checks: ["E2E suite green"], dependsOn: ["ui"], state: "blocked", note: "Waiting for /api/health mock fixture from orchestrator" },
            { id: "readme", owner: "docs", profile: "antigravity", title: "Write quickstart & examples", paths: ["README.md"], checks: ["Links verified"], dependsOn: [], state: "pending" },
          ],
          messages: [
            { id: 1, taskId: "api", kind: "handoff", from: "orchestrator", to: "frontend", body: "API contract is accepted and ready for UI integration.", createdAt: new Date(now - 90_000).toISOString(), acknowledged: true },
            { id: 2, taskId: "ui", kind: "handoff", from: "frontend", to: "orchestrator", body: "Finished the cartoony UI cards and theme toggle! Ready for review.", createdAt: new Date(now - 25_000).toISOString(), acknowledged: false, checks: ["Build passed", "No console warnings"] },
            { id: 3, taskId: "tests", kind: "blocker", from: "quality", to: "orchestrator", body: "Need the mock auth token helper before running E2E suite.", createdAt: new Date(now - 15_000).toISOString(), acknowledged: false },
          ],
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

    function render() {
      const data = activeData();
      const run = data.runs.find((r) => r.id === selectedRunId) || data.runs[0];
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
        "</section>";

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
            '<button class="btn active-toggle" id="demoBtn" type="button">👀 Preview Demo</button>' +
          "</div>" +
        "</section>";
      document.getElementById("loungeOrchBtn").addEventListener("click", () => copyText(ORCH_PROMPT, "Orchestrator prompt copied!"));
      document.getElementById("loungeWorkerBtn").addEventListener("click", () => copyText(WORKER_PROMPT, "Worker join prompt copied!"));
      document.getElementById("demoBtn").addEventListener("click", () => { demoMode = true; render(); });
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
        snapshot = next;
        connDot.classList.remove("offline");
        connText.textContent = "Live";
        render();
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
