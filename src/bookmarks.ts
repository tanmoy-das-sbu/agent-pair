import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assignmentSchema, roleSchema } from "./types.js";
import { pathKey } from "./workspace.js";

const rosterSchema = z.array(z.object({
  member: assignmentSchema.shape.owner,
  profile: roleSchema,
  sessionId: z.string().uuid(),
})).min(2).refine((sessions) => {
  const members = new Set(sessions.map(({ member }) => member));
  const nativeSessions = new Set(sessions.map(({ profile, sessionId }) => `${profile}:${sessionId.toLowerCase()}`));
  return members.size === sessions.length && nativeSessions.size === sessions.length;
});
type NativeSession = z.infer<typeof rosterSchema>[number];
type Bookmark = { tag: string; workspace: string; sessions: NativeSession[] };
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function readRoster(value: unknown): NativeSession[] {
  const result = rosterSchema.safeParse(value);
  if (!result.success) throw new Error("A bookmark requires a valid roster with distinct members and native sessions.");
  return result.data;
}

function open(directory: string): DatabaseSync {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, "bookmarks.sqlite"));
  try {
    database.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS bookmarks (
        workspace_key TEXT PRIMARY KEY,
        tag TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        codex TEXT NOT NULL,
        antigravity TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_bookmarks (
        workspace_key TEXT PRIMARY KEY,
        tag TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        sessions TEXT NOT NULL
      );
      INSERT OR IGNORE INTO session_bookmarks (workspace_key, tag, workspace, sessions)
        SELECT workspace_key, tag, workspace, json_array(
          json_object('member', 'codex', 'profile', 'codex', 'sessionId', codex),
          json_object('member', 'antigravity', 'profile', 'antigravity', 'sessionId', antigravity)
        ) FROM bookmarks;
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function saveBookmark(directory: string, workspace: string, codex: string, antigravity: string): string {
  return saveSessions(directory, workspace, [
    { member: "codex", profile: "codex", sessionId: codex },
    { member: "antigravity", profile: "antigravity", sessionId: antigravity },
  ]);
}

export function saveSessions(directory: string, workspace: string, sessions: NativeSession[]): string {
  const payload = JSON.stringify(readRoster(sessions));
  const db = open(directory);
  try {
    db.exec("BEGIN IMMEDIATE");
    const key = pathKey(workspace);
    const existing = db.prepare("SELECT tag FROM session_bookmarks WHERE workspace_key = ?").get(key);
    let tag: string;
    if (existing) {
      tag = String(existing.tag);
      db.prepare("UPDATE session_bookmarks SET workspace = ?, sessions = ? WHERE workspace_key = ?")
        .run(workspace, payload, key);
    } else {
      const insert = db.prepare("INSERT OR IGNORE INTO session_bookmarks VALUES (?, ?, ?, ?)");
      for (let attempt = 0; ; attempt += 1) {
        if (attempt === 64) throw new Error("Could not allocate a unique project tag.");
        tag = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
        if (insert.run(key, tag, workspace, payload).changes) break;
      }
    }
    db.exec("COMMIT");
    return tag;
  } finally {
    db.close();
  }
}

export function getBookmark(directory: string, tag: string): Bookmark {
  if (!/^[A-Z0-9]{4}$/i.test(tag)) throw new Error("A project tag contains four letters or digits.");
  const db = open(directory);
  try {
    const record = db.prepare("SELECT tag, workspace, sessions FROM session_bookmarks WHERE tag = ?")
      .get(tag.toUpperCase()) as { tag: string; workspace: string; sessions: string } | undefined;
    if (!record) throw new Error(`Unknown project tag ${tag.toUpperCase()}.`);
    return { ...record, sessions: readRoster(JSON.parse(record.sessions)) };
  } finally {
    db.close();
  }
}
