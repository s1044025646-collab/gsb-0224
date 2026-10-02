import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Store } from '../src/db.js';

describe('SQLite 版本与预览历史', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-db-'));
  const dbPath = join(dir, 'cron.db');
  let store: Store;

  before(() => {
    store = new Store(dbPath);
  });

  after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('保存计划、更新版本且旧版本表达式保持不变', () => {
    const plan = store.createPlan('工作日早会', '30 9 * * 1-5', '旧说明');
    assert.equal(plan.version, 1);
    const updated = store.updatePlan(plan.id, '0 10 * * 1-5', '改到十点');
    assert.equal(updated.version, 2);

    store.insertPreview({
      planId: plan.id,
      planVersion: 1,
      expressionSnapshot: '30 9 * * 1-5',
      requestJson: JSON.stringify({ count: 1 }),
      resultJson: JSON.stringify({ expression: '30 9 * * 1-5', times: ['2026-01-05T09:30:00.000Z'] }),
    });

    const versions = store.listVersions(plan.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.expression, '30 9 * * 1-5');
    assert.equal(versions[1]!.expression, '0 10 * * 1-5');

    const previews = store.listPreviewsForPlan(plan.id);
    assert.equal(previews.length, 1);
    assert.equal(previews[0]!.expression_snapshot, '30 9 * * 1-5');
  });

  it('模拟服务重启后仍可查询历史', () => {
    store.close();
    const reopened = new Store(dbPath);
    const plans = reopened.listPlans();
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.version, 2);
    const previews = reopened.listPreviews();
    assert.equal(previews.length, 1);
    assert.ok(previews[0]!.result_json.includes('09:30'));
    assert.equal(reopened.listVersions(plans[0]!.id).length, 2);
    reopened.close();
  });
});
