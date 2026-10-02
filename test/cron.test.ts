import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CronParseError, explainFields, matchesAt, nextTriggerTimes, parseCron } from '../src/cron.js';

function isoTimes(expression: string, from: string, count: number, rest: { includeFrom?: boolean; until?: string; maxScannedMinutes?: number } = {}): string[] {
  return nextTriggerTimes(expression, {
    from: new Date(from),
    count,
    until: rest.until ? new Date(rest.until) : new Date('2036-01-01T00:00:00Z'),
    includeFrom: rest.includeFrom,
    maxScannedMinutes: rest.maxScannedMinutes ?? 10_000_000,
  }).times;
}

describe('字段解析', () => {
  it('解析星号、列表、闭区间和步长的组合', () => {
    const explained = explainFields('0,15-30/5,45 9-17/2 * * 1,3,5');
    assert.deepEqual(explained.fields[0]!.values, [0, 15, 20, 25, 30, 45]);
    assert.deepEqual(explained.fields[1]!.values, [9, 11, 13, 15, 17]);
    assert.deepEqual(explained.fields[4]!.values, [1, 3, 5]);
    assert.equal(explained.fields[2]!.restricted, false);
  });

  it('星期 0 和 7 都表示周日并归一化', () => {
    assert.deepEqual(parseCron('0 0 * * 7').dayOfWeek.values, [0]);
    assert.deepEqual(parseCron('0 0 * * 0').dayOfWeek.values, [0]);
    assert.ok(matchesAt(parseCron('0 0 * * 7'), new Date('2026-03-01T00:00:00Z')));
  });

  it('拒绝非法字段数量、范围、步长和数字', () => {
    assert.throws(() => parseCron('* * * *'), (e: CronParseError) => e.code === 'CRON_FIELD_COUNT');
    assert.throws(() => parseCron('60 * * * *'), (e: CronParseError) => e.code === 'CRON_OUT_OF_RANGE');
    assert.throws(() => parseCron('* * 0 * *'), (e: CronParseError) => e.code === 'CRON_OUT_OF_RANGE');
    assert.throws(() => parseCron('* * * * 13'), (e: CronParseError) => e.code === 'CRON_OUT_OF_RANGE');
    assert.throws(() => parseCron('5-1 * * * *'), (e: CronParseError) => e.code === 'CRON_BAD_RANGE');
    assert.throws(() => parseCron('*/0 * * * *'), (e: CronParseError) => e.code === 'CRON_BAD_STEP');
    assert.throws(() => parseCron('a * * * *'), (e: CronParseError) => e.code === 'CRON_BAD_NUMBER');
  });
});

describe('日与星期的 OR 组合口径', () => {
  const cron = parseCron('0 12 15 * 1');
  it('两个字段都受限时匹配日期或星期一', () => {
    assert.ok(matchesAt(cron, new Date('2026-03-15T12:00:00Z')));
    assert.ok(matchesAt(cron, new Date('2026-03-09T12:00:00Z')));
    assert.ok(!matchesAt(cron, new Date('2026-03-10T12:00:00Z')));
  });

  it('仅日受限则忽略星期；仅星期受限则忽略日', () => {
    assert.ok(matchesAt(parseCron('0 12 10 * *'), new Date('2026-03-10T12:00:00Z')));
    assert.ok(matchesAt(parseCron('0 12 * * 2'), new Date('2026-03-03T12:00:00Z')));
  });
});

describe('触发时间枚举', () => {
  it('工作日 09:30 跳过周六周日并跨年', () => {
    assert.deepEqual(isoTimes('30 9 * * 1-5', '2025-12-31T00:00:00Z', 5), [
      '2025-12-31T09:30:00.000Z',
      '2026-01-01T09:30:00.000Z',
      '2026-01-02T09:30:00.000Z',
      '2026-01-05T09:30:00.000Z',
      '2026-01-06T09:30:00.000Z',
    ]);
  });

  it('每十五分钟对齐到固定网格，而不是从查询时刻偏移', () => {
    assert.deepEqual(isoTimes('*/15 * * * *', '2026-03-02T10:07:00Z', 4), [
      '2026-03-02T10:15:00.000Z',
      '2026-03-02T10:30:00.000Z',
      '2026-03-02T10:45:00.000Z',
      '2026-03-02T11:00:00.000Z',
    ]);
  });

  it('每月固定日期正确推进月份和年份', () => {
    assert.deepEqual(isoTimes('0 0 1 * *', '2026-01-15T12:00:00Z', 3), [
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
  });

  it('闰日只在闰年出现并跨到下一闰年', () => {
    assert.deepEqual(isoTimes('0 0 29 2 *', '2025-01-01T00:00:00Z', 2), [
      '2028-02-29T00:00:00.000Z',
      '2032-02-29T00:00:00.000Z',
    ]);
  });

  it('起点默认严格晚于输入时刻；includeFrom 可包含起点', () => {
    const at = '2026-03-02T10:15:00Z';
    assert.deepEqual(isoTimes('*/15 * * * *', at, 1), ['2026-03-02T10:30:00.000Z']);
    assert.deepEqual(isoTimes('*/15 * * * *', at, 1, { includeFrom: true }), ['2026-03-02T10:15:00.000Z']);
  });

 it('秒级差异仍按分钟严格晚于处理', () => {
    assert.deepEqual(isoTimes('30 9 * * *', '2026-03-02T09:30:45Z', 1), ['2026-03-03T09:30:00.000Z']);
  });

  it('二月三十一日在扫描范围内无结果并报告范围而非断言永不触发', () => {
    const result = nextTriggerTimes('0 0 31 2 *', {
      from: new Date('2026-02-01T00:00:00Z'),
      count: 1,
      until: new Date('2026-02-28T23:59:00Z'),
    });
    assert.deepEqual(result.times, []);
    assert.equal(result.truncated, true);
    assert.equal(result.stopReason, 'until_reached');
    assert.equal(result.limit.until, '2026-02-28T23:59:00.000Z');
  });

  it('扫描分钟预算耗尽时返回已找到的结果和预算信息', () => {
    const result = nextTriggerTimes('0 0 31 2 *', {
      from: new Date('2026-02-01T00:00:00Z'),
      count: 1,
      maxScannedMinutes: 60,
    });
    assert.equal(result.stopReason, 'budget_exhausted');
    assert.equal(result.times.length, 0);
    assert.ok(result.scannedMinutes > 60);
  });
});
