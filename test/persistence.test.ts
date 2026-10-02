import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlan,
  getPlanOrThrow,
  listPreviews,
  listVersions,
  runPreview,
  updatePlan,
} from '../src/service.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';

const dbDir = mkdtempSync(join(tmpdir(), 'cron-preview-test-'));
const dbPath = join(dbDir, 'test.db');

describe('SQLite 版本与预览持久化', () => {
  before(() => {
    openDatabase(dbPath);
  });

  it('创建计划、改点追加版本，旧预览记录保留首次表达式', () => {
    const plan = createPlan({ name: 'nightly', expression: '0 18 * * *', description: 'v1' });
    const first = runPreview({ scheduleId: plan.id, from: '2026-01-01T00:00:00Z', count: 2 });
    updatePlan(plan.id, { expression: '30 18 * * *', description: 'v2' });

    const versions = listVersions(plan.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.expression, '0 18 * * *');
    assert.equal(versions[1]!.expression, '30 18 * * *');
    assert.equal(getPlanOrThrow(plan.id).current_version, 2);

    // 旧预览固化了版本 1 的表达式，不受更新影响。
    assert.equal(first.previewRecord.schedule_version, 1);
    assert.equal(first.previewRecord.expression, '0 18 * * *');
    const history = listPreviews({ scheduleId: plan.id });
    assert.equal(history[0]!.expression, '0 18 * * *');
  });

  it('重新打开数据库（模拟服务重启）后历史仍可查询', () => {
    openDatabase(dbPath);
    const plans = listPreviews({ limit: 10 });
    assert.ok(plans.length >= 1);
    const reloaded = JSON.parse(plans[0]!.result_json);
    assert.ok(Array.isArray(reloaded.times));
  });

  after(() => {
    closeDatabase();
    try {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下句柄释放可能滞后；临时目录不影响断言，忽略清理失败。
    }
  });
});
