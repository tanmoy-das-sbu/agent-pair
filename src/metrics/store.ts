import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardRun, DashboardSnapshot, Relay } from "../relay.js";
import { dataDirectory } from "../workspace.js";
import { aggregateRunMetrics } from "./aggregator.js";
import { usageReportSchema, type RunMetrics, type UsageReport } from "./types.js";

const safeRunIdPattern = /^[a-zA-Z0-9._-]{1,120}$/;

function assertSafeRunId(runId: string): string {
  if (!safeRunIdPattern.test(runId) || runId === "." || runId === "..") {
    throw new Error(`Invalid run ID for metrics persistence: ${runId}`);
  }
  return runId;
}

export function metricsDirectory(baseDir?: string): string {
  return join(baseDir ?? dataDirectory(), "metrics");
}

export function metricsFilePath(runId: string, baseDir?: string): string {
  return join(metricsDirectory(baseDir), `${assertSafeRunId(runId)}.json`);
}

export function saveRunMetrics(metrics: RunMetrics, baseDir?: string): string {
  const dir = metricsDirectory(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = metricsFilePath(metrics.runId, baseDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(metrics, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function loadRunMetrics(runId: string, baseDir?: string): RunMetrics | null {
  try {
    const raw = readFileSync(metricsFilePath(runId, baseDir), "utf8");
    return JSON.parse(raw) as RunMetrics;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function listSavedMetrics(baseDir?: string): string[] {
  try {
    return readdirSync(metricsDirectory(baseDir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class MetricsTracker {
  private readonly usageByRun = new Map<string, UsageReport[]>();
  private readonly latestRunMeta = new Map<string, DashboardRun>();
  private readonly activeRunIds = new Set<string>();
  private readonly latestMetrics = new Map<string, RunMetrics>();
  private readonly persistedKeys = new Map<string, string>();
  private detachRelay?: () => void;

  constructor(private readonly baseDir?: string, private readonly persist = true) {}

  attach(relay: Relay): () => void {
    this.detach();
    this.syncSnapshot(relay.snapshot());
    const unsubscribe = relay.subscribe(() => {
      this.syncSnapshot(relay.snapshot());
    });
    this.detachRelay = () => {
      unsubscribe();
      this.detachRelay = undefined;
    };
    return this.detachRelay;
  }

  detach(): void {
    this.detachRelay?.();
  }

  recordUsage(input: unknown): UsageReport {
    const parsed = usageReportSchema.parse(input);
    const report: UsageReport = { ...parsed, reportedAt: parsed.reportedAt ?? Date.now() };
    const existing = this.usageByRun.get(report.runId) ?? [];
    existing.push(report);
    this.usageByRun.set(report.runId, existing);
    const run = this.latestRunMeta.get(report.runId);
    if (run) {
      this.computeAndPersist(run, report.reportedAt);
    }
    return report;
  }

  getUsageReports(runId: string): UsageReport[] {
    return [...(this.usageByRun.get(runId) ?? [])];
  }

  syncSnapshot(snapshot: DashboardSnapshot): Record<string, RunMetrics> {
    const result: Record<string, RunMetrics> = {};
    const seen = new Set<string>();
    for (const run of snapshot.runs) {
      seen.add(run.id);
      this.activeRunIds.add(run.id);
      this.latestRunMeta.set(run.id, run);
      result[run.id] = this.computeAndPersist(run, snapshot.now);
    }
    for (const runId of [...this.activeRunIds]) {
      if (seen.has(runId)) continue;
      this.activeRunIds.delete(runId);
      const lastRun = this.latestRunMeta.get(runId);
      if (lastRun) {
        this.computeAndPersist(lastRun, snapshot.now, snapshot.now);
      }
    }
    return result;
  }

  getMetrics(runId: string): RunMetrics | null {
    const live = this.latestMetrics.get(runId);
    if (live) return live;
    if (!this.persist) return null;
    return loadRunMetrics(runId, this.baseDir);
  }

  listMetrics(): RunMetrics[] {
    const byId = new Map<string, RunMetrics>();
    if (this.persist) {
      for (const runId of listSavedMetrics(this.baseDir)) {
        const loaded = loadRunMetrics(runId, this.baseDir);
        if (loaded) byId.set(runId, loaded);
      }
    }
    for (const [runId, metrics] of this.latestMetrics) {
      byId.set(runId, metrics);
    }
    return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private computeAndPersist(run: DashboardRun, now?: number, closedAt?: number): RunMetrics {
    const usageReports = this.usageByRun.get(run.id) ?? [];
    const base = aggregateRunMetrics({
      runId: run.id,
      events: run.events ?? [],
      usageReports,
      tasks: run.tasks,
      members: run.members,
      workspace: run.workspace,
      mode: run.mode,
      tag: run.tag,
      createdAt: run.createdAt,
      now,
    });
    const metrics: RunMetrics = closedAt !== undefined ? { ...base, closedAt } : base;
    this.latestMetrics.set(run.id, metrics);
    if (this.persist) {
      const fingerprint = `${metrics.eventCount}:${usageReports.length}:${run.tasks.map((t) => t.state).join(",")}:${run.tag ?? ""}:${closedAt ?? ""}`;
      if (this.persistedKeys.get(run.id) !== fingerprint) {
        try {
          saveRunMetrics(metrics, this.baseDir);
          this.persistedKeys.set(run.id, fingerprint);
        } catch {
          // Metrics persistence is best-effort and must not disrupt live dashboard delivery.
        }
      }
    }
    return metrics;
  }
}

export function attachMetricsTracker(relay: Relay, baseDir?: string): { tracker: MetricsTracker; detach: () => void } {
  const tracker = new MetricsTracker(baseDir);
  const detach = tracker.attach(relay);
  return { tracker, detach };
}
