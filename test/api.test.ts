import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createApp, listenFree } from '../src/server/index.js';

const dbDir = mkdtempSync(join(tmpdir(), 'cron-preview-api-'));
const dbPath = join(dbDir, 'api.db');
let server: Server;
let base: string;

async function call(path: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe('HTTP API', () => {
  before(async () => {
    openDatabase(dbPath);
    server = createApp();
    const { port } = await listenFree(server, 0);
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server.close();
    closeDatabase();
    try {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下句柄释放可能滞后；临时目录不影响断言，忽略清理失败。
    }
  });

  it('健康检查、校验、预览、错误码', async () => {
    const health = await call('/health');
    assert.equal(health.status, 200);

    const validated = await call('/validate', { method: 'POST', body: { expression: '*/15 9-17 * * 1-5' } });
    assert.equal(validated.status, 200);
    assert.deepEqual(validated.json.fields && (validated.json.fields as { minute: number[] }).minute, [0, 15, 30, 45]);

    const bad = await call('/validate', { method: 'POST', body: { expression: '99 * * * *' } });
    assert.equal(bad.status, 400);
    assert.equal((bad.json.error as { code: string }).code, 'CRON_NUMBER_OUT_OF_RANGE');

    const preview = await call('/preview', {
      method: 'POST',
      body: { expression: '0 0 31 * *', from: '2026-02-01T00:00:00Z', count: 1, deadline: '2026-03-01T00:00:00Z' },
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json.times, []);
    assert.equal(preview.json.truncated, true);
    assert.ok(typeof preview.json.previewId === 'number');

    const history = await call('/previews');
    assert.equal(history.status, 200);
    assert.ok(((history.json.previews as unknown[]).length) >= 1);
  });

  it('计划创建、更新与版本', async () => {
    const created = await call('/schedules', {
      method: 'POST',
      body: { name: 'weekly', expression: '0 10 * * 1', description: '周一' },
    });
    assert.equal(created.status, 201);
    const id = (created.json.id as number) ?? 0;

    const dup = await call('/schedules', { method: 'POST', body: { name: 'weekly', expression: '0 10 * * 1' } });
    assert.equal(dup.status, 409);

    const updated = await call(`/schedules/${id}`, { method: 'PUT', body: { expression: '30 10 * * 1' } });
    assert.equal(updated.status, 200);

    const versions = await call(`/schedules/${id}/versions`);
    assert.equal((versions.json.versions as unknown[]).length, 2);
  });
});
