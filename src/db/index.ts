import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let client: DatabaseSync | undefined;

export interface ScheduleRow {
  id: number;
  name: string;
  expression: string;
  description: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: number;
  schedule_id: number;
  version: number;
  expression: string;
  description: string;
  created_at: string;
}

export interface PreviewRow {
  id: number;
  schedule_id: number | null;
  schedule_version: number | null;
  expression: string;
  input_json: string;
  result_json: string;
  created_at: string;
}

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      expression TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      expression TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (schedule_id, version)
    );

    CREATE TABLE IF NOT EXISTS previews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER,
      schedule_version INTEGER,
      expression TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_previews_schedule ON previews(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_previews_created ON previews(created_at);
  `);

  client = db;
  return db;
}

export function getDb(): DatabaseSync {
  if (!client) throw new Error('数据库尚未初始化，请先调用 openDatabase()');
  return client;
}

export function closeDatabase(): void {
  client?.close();
  client = undefined;
}

export function createSchedule(name: string, expression: string, description: string): ScheduleRow {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db
    .prepare(
      `INSERT INTO schedules (name, expression, description, current_version, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(name, expression, description, now, now);
  const id = Number(insert.lastInsertRowid);
  db.prepare(
    `INSERT INTO schedule_versions (schedule_id, version, expression, description, created_at)
     VALUES (?, 1, ?, ?, ?)`,
  ).run(id, expression, description, now);
  return getSchedule(id)!;
}

export function getSchedule(id: number): ScheduleRow | undefined {
  return getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as ScheduleRow | undefined;
}

export function getScheduleByName(name: string): ScheduleRow | undefined {
  return getDb().prepare('SELECT * FROM schedules WHERE name = ?').get(name) as unknown as ScheduleRow | undefined;
}

export function listSchedules(): ScheduleRow[] {
  return getDb().prepare('SELECT * FROM schedules ORDER BY id').all() as unknown as ScheduleRow[];
}

/** 更新计划：主表更新并追加一条不可变版本，旧版本与旧预览保持原样。 */
export function updateSchedule(
  id: number,
  expression: string,
  description: string,
): ScheduleRow | undefined {
  const db = getDb();
  const existing = getSchedule(id);
  if (!existing) return undefined;
  const nextVersion = existing.current_version + 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO schedule_versions (schedule_id, version, expression, description, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, nextVersion, expression, description, now);
  db.prepare(
    `UPDATE schedules SET expression = ?, description = ?, current_version = ?, updated_at = ? WHERE id = ?`,
  ).run(expression, description, nextVersion, now, id);
  return getSchedule(id);
}

export function listVersions(scheduleId: number): VersionRow[] {
  return getDb()
    .prepare('SELECT * FROM schedule_versions WHERE schedule_id = ? ORDER BY version')
    .all(scheduleId) as unknown as VersionRow[];
}

export function savePreview(
  scheduleId: number | null,
  scheduleVersion: number | null,
  expression: string,
  input: unknown,
  result: unknown,
): PreviewRow {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO previews (schedule_id, schedule_version, expression, input_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scheduleId,
      scheduleVersion,
      expression,
      JSON.stringify(input),
      JSON.stringify(result),
      now,
    );
  const id = Number(info.lastInsertRowid);
  return getPreview(id)!;
}

export function getPreview(id: number): PreviewRow | undefined {
  return getDb().prepare('SELECT * FROM previews WHERE id = ?').get(id) as unknown as PreviewRow | undefined;
}

export interface PreviewQuery {
  scheduleId?: number;
  limit?: number;
}

export function listPreviews(query: PreviewQuery = {}): PreviewRow[] {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  if (query.scheduleId !== undefined) {
    return getDb()
      .prepare('SELECT * FROM previews WHERE schedule_id = ? ORDER BY id DESC LIMIT ?')
      .all(query.scheduleId, limit) as unknown as PreviewRow[];
  }
  return getDb().prepare('SELECT * FROM previews ORDER BY id DESC LIMIT ?').all(limit) as unknown as PreviewRow[];
}
