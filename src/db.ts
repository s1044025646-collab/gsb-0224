import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface PlanRow {
  id: number;
  name: string;
  version: number;
  expression: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface PlanVersionRow {
  id: number;
  plan_id: number;
  version: number;
  expression: string;
  description: string;
  created_at: string;
}

export interface PreviewRow {
  id: number;
  plan_id: number | null;
  plan_version: number | null;
  expression_snapshot: string;
  request_json: string;
  result_json: string;
  created_at: string;
}

export class Store {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath = 'data/cron.db') {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        expression TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        expression TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (plan_id, version)
      );
      CREATE TABLE IF NOT EXISTS previews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
        plan_version INTEGER,
        expression_snapshot TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createPlan(name: string, expression: string, description = ''): PlanRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO plans (name, version, expression, description, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`,
      )
      .run(name, expression, description, now, now);
    const id = Number(info.lastInsertRowid);
    this.db
      .prepare(
        `INSERT INTO plan_versions (plan_id, version, expression, description, created_at)
         VALUES (?, 1, ?, ?, ?)`,
      )
      .run(id, expression, description, now);
    return this.getPlanOrThrow(id);
  }

  updatePlan(id: number, expression: string, description: string): PlanRow {
    const current = this.getPlan(id);
    if (!current) {
      throw new Error('PLAN_NOT_FOUND');
    }
    const now = new Date().toISOString();
    const version = current.version + 1;
    this.db
      .prepare('UPDATE plans SET expression = ?, description = ?, version = ?, updated_at = ? WHERE id = ?')
      .run(expression, description, version, now, id);
    this.db
      .prepare(
        `INSERT INTO plan_versions (plan_id, version, expression, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, version, expression, description, now);
    return this.getPlanOrThrow(id);
  }

  getPlan(id: number): PlanRow | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    return row;
  }

  getPlanOrThrow(id: number): PlanRow {
    const row = this.getPlan(id);
    if (!row) throw new Error('PLAN_NOT_FOUND');
    return row;
  }

  findPlanByName(name: string): PlanRow | undefined {
    return this.db.prepare('SELECT * FROM plans WHERE name = ?').get(name) as PlanRow | undefined;
  }

  listPlans(): PlanRow[] {
    return this.db.prepare('SELECT * FROM plans ORDER BY id').all() as PlanRow[];
  }

  listVersions(planId: number): PlanVersionRow[] {
    return this.db
      .prepare('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version')
      .all(planId) as PlanVersionRow[];
  }

  insertPreview(input: {
    planId: number | null;
    planVersion: number | null;
    expressionSnapshot: string;
    requestJson: string;
    resultJson: string;
  }): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO previews
           (plan_id, plan_version, expression_snapshot, request_json, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.planId,
        input.planVersion,
        input.expressionSnapshot,
        input.requestJson,
        input.resultJson,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  listPreviews(limit = 50): PreviewRow[] {
    return this.db
      .prepare('SELECT * FROM previews ORDER BY id DESC LIMIT ?')
      .all(limit) as PreviewRow[];
  }

  listPreviewsForPlan(planId: number): PreviewRow[] {
    return this.db
      .prepare('SELECT * FROM previews WHERE plan_id = ? ORDER BY id')
      .all(planId) as PreviewRow[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
