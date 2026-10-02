import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CronError } from '../src/cron/errors.js';
import { nextTimes, matchesAt } from '../src/cron/engine.js';
import { parseCron } from '../src/cron/parse.js';

function isoTimes(expression: string, from: string, count: number, opts = {}) {
  return nextTimes(parseCron(expression), new Date(from), count, opts).times;
}

describe('字段解析', () => {
  it('星号、列表、闭区间、步长求并集', () => {
    const parsed = parseCron('0,15,30,45,10/20 9 * * *');
    assert.deepEqual([...parsed.minute.values].sort((a, b) => a - b), [0, 10, 15, 30, 45, 50]);
    assert.equal(parsed.minute.unrestricted, false);
    assert.equal(parsed.dayOfMonth.unrestricted, true);
  });

  it('*/n 从字段起点开始而非查询时刻', () => {
    // 09:07 之后第一次 */15 必须是 09:15
    assert.deepEqual(isoTimes('*/15 * * * *', '2026-01-01T09:07:00Z', 3), [
      '2026-01-01T09:15:00.000Z',
      '2026-01-01T09:30:00.000Z',
      '2026-01-01T09:45:00.000Z',
    ]);
  });

  it('星期 0 与 7 都表示周日且等价', () => {
    const a = parseCron('0 0 * * 0');
    const b = parseCron('0 0 * * 7');
    assert.deepEqual([...a.dayOfWeek.values], [0]);
    assert.deepEqual([...b.dayOfWeek.values], [0]);
    assert.deepEqual(isoTimes('0 0 * * 7', '2026-01-01T00:00:00Z', 2), [
      '2026-01-04T00:00:00.000Z',
      '2026-01-11T00:00:00.000Z',
    ]);
  });

  it('非法范围与语法给出错误码', () => {
    assert.throws(() => parseCron('60 * * * *'), (e: Error) => e instanceof CronError && e.code === 'CRON_NUMBER_OUT_OF_RANGE');
    assert.throws(() => parseCron('* * * * 8'), (e: Error) => e instanceof CronError && e.code === 'CRON_NUMBER_OUT_OF_RANGE');
    assert.throws(() => parseCron('5-1 * * * *'), (e: Error) => e instanceof CronError && e.code === 'CRON_RANGE_REVERSED');
    assert.throws(() => parseCron('*/0 * * * *'), (e: Error) => e instanceof CronError && e.code === 'CRON_STEP_INVALID');
    assert.throws(() => parseCron('a * * * *'), (e: Error) => e instanceof CronError && e.code === 'CRON_INVALID_NUMBER');
    assert.throws(() => parseCron('* * * *'), (e: Error) => e instanceof CronError && e.code === 'CRON_FIELD_COUNT');
    assert.throws(() => parseCron('* * * * * *'), (e: Error) => e instanceof CronError && e.code === 'CRON_FIELD_COUNT');
  });
});

describe('触发时间（独立手算预期）', () => {
  it('工作日 09:30：2026-01-01(周四) 起前三次为 1/1、1/2、1/5', () => {
    assert.deepEqual(isoTimes('30 9 * * 1-5', '2026-01-01T00:00:00Z', 3), [
      '2026-01-01T09:30:00.000Z',
      '2026-01-02T09:30:00.000Z',
      '2026-01-05T09:30:00.000Z',
    ]);
  });

  it('每月 1 日：从 1 月中起跨年为 2/1、3/1、4/1', () => {
    assert.deepEqual(isoTimes('0 0 1 * *', '2026-01-15T12:00:00Z', 3), [
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
  });

  it('日与星期都受限：OR 关系', () => {
    // 每月 1 日 或 周一，2026-02 月内：2/2(周一)、2/9、2/16、2/23
    // 2/1 是周日，因“日=1”仍须触发；故从 1/31 起依次 2/1、2/2、2/9
    assert.deepEqual(isoTimes('0 0 1 * 1', '2026-01-31T12:00:00Z', 3), [
      '2026-02-01T00:00:00.000Z',
      '2026-02-02T00:00:00.000Z',
      '2026-02-09T00:00:00.000Z',
    ]);
  });

  it('闰日：2/29 只在闰年出现，2026 -> 2028', () => {
    assert.deepEqual(
      isoTimes('0 0 29 2 *', '2026-03-01T00:00:00Z', 2, { budgetMinutes: 8 * 366 * 24 * 60 }),
      [
      '2028-02-29T00:00:00.000Z',
      '2032-02-29T00:00:00.000Z',
      ],
    );
  });

  it('起点边界：默认严格晚于；includeStart 可包含整点', () => {
    const expression = '0 9 * * *';
    assert.equal(matchesAt(parseCron(expression), new Date('2026-01-01T09:00:30Z')), true);
    assert.deepEqual(isoTimes(expression, '2026-01-01T09:00:00Z', 1), ['2026-01-02T09:00:00.000Z']);
    assert.deepEqual(
      isoTimes(expression, '2026-01-01T09:00:00Z', 1, { includeStart: true }),
      ['2026-01-01T09:00:00.000Z'],
    );
  });
});

describe('预算与截止', () => {
  it('二月内扫描 31 日：预算/截止耗尽，明确 truncated 且不声称永不触发', () => {
    const result = nextTimes(parseCron('0 0 31 * *'), new Date('2026-02-01T00:00:00Z'), 1, {
      deadline: new Date('2026-03-01T00:00:00Z'),
    });
    assert.deepEqual(result.times, []);
    assert.equal(result.truncated, true);
    assert.equal(result.deadlineReached, true);
  });

  it('小预算耗尽时标记 budgetExhausted', () => {
    const result = nextTimes(parseCron('0 0 1 1 *'), new Date('2026-02-01T00:00:00Z'), 1, {
      budgetMinutes: 60,
    });
    assert.deepEqual(result.times, []);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.scannedMinutes, 60);
  });
});
