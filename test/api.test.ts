import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/server.js';

describe('HTTP API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-api-'));
  const dbPath = join(dir, 'cron.db');
  const app = createApp(dbPath);
  let baseUrl = '';

  before(async () => {
    const { port } = await app.listen(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('健康检查', async () => {
    const result = await call('/health');
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
  });

  it('校验与解释表达式', async () => {
    const invalid = await call('/api/validate', { method: 'POST', body: { expression: '60 * * * *' } });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, 'CRON_OUT_OF_RANGE');

    const explained = await call('/api/explain', { method: 'POST', body: { expression: '*/15 * * * *' } });
    assert.deepEqual(explained.body.fields[0].values, [0, 15, 30, 45]);
  });

  it('计算下一次触发、保存预览并可通过历史读取', async () => {
    const next = await call('/api/next', {
      method: 'POST',
      body: { expression: '30 9 * * 1-5', from: '2025-12-31T00:00:00Z', count: 2 },
    });
    assert.equal(next.status, 200);
    assert.equal(next.body.times[0], '2025-12-31T09:30:00.000Z');

    const history = await call('/api/previews');
    assert.equal(history.body.previews.length, 1);
    assert.equal(history.body.previews[0].expression_snapshot, '30 9 * * 1-5');
  });

  it('计划更新后旧预览仍保留旧版本号', async () => {
    const created = await call('/api/plans', {
      method: 'POST',
      body: { name: '月报', expression: '0 0 1 * *', description: '每月' },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const preview = await call(`/api/plans/${id}/preview`, { method: 'POST', body: { count: 1, from: '2026-01-15T00:00:00Z' } });
    assert.equal(preview.body.planVersion, 1);

    await call(`/api/plans/${id}`, { method: 'PUT', body: { expression: '0 0 2 * *', description: '改二号' } });
    const history = await call(`/api/previews?planId=${id}`);
    assert.equal(history.body.previews[0].plan_version, 1);
    assert.equal(history.body.previews[0].expression_snapshot, '0 0 1 * *');
  });
});
