import { PreviewError } from './errors.js';
import type { ParsedCron } from './parse.js';

/** 默认最多扫描的分钟数（366 天）。 */
export const DEFAULT_SCAN_BUDGET_MINUTES = 366 * 24 * 60;
export const MAX_COUNT = 1000;

export interface CronFieldsSnapshot {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export function explain(parsed: ParsedCron): CronFieldsSnapshot {
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return {
    minute: sorted(parsed.minute.values),
    hour: sorted(parsed.hour.values),
    dayOfMonth: sorted(parsed.dayOfMonth.values),
    month: sorted(parsed.month.values),
    dayOfWeek: sorted(parsed.dayOfWeek.values),
  };
}

/** 判断给定 UTC 时刻是否匹配（秒与更小数位被忽略，按其所在分钟判断）。 */
export function matchesAt(parsed: ParsedCron, time: Date): boolean {
  const minute = time.getUTCMinutes();
  const hour = time.getUTCHours();
  const date = time.getUTCDate();
  const month = time.getUTCMonth() + 1;
  const day = time.getUTCDay();

  if (!parsed.month.values.has(month)) return false;

  const domRestricted = !parsed.dayOfMonth.unrestricted;
  const dowRestricted = !parsed.dayOfWeek.unrestricted;
  let dayOk: boolean;
  if (domRestricted && dowRestricted) {
    // 常见 Vixie Cron 口径：两者都受限时满足任一即可（OR）。
    dayOk = parsed.dayOfMonth.values.has(date) || parsed.dayOfWeek.values.has(day);
  } else if (domRestricted) {
    dayOk = parsed.dayOfMonth.values.has(date);
  } else if (dowRestricted) {
    dayOk = parsed.dayOfWeek.values.has(day);
  } else {
    dayOk = true;
  }
  if (!dayOk) return false;

  return parsed.hour.values.has(hour) && parsed.minute.values.has(minute);
}

export interface NextOptions {
  /** 为 true 时允许返回等于起点所在分钟的触发；默认 false（严格晚于输入时刻）。 */
  includeStart?: boolean;
  /** 扫描预算（分钟），默认 DEFAULT_SCAN_BUDGET_MINUTES。 */
  budgetMinutes?: number;
  /** 截止时刻（UTC）；只返回不晚于该时刻的触发。 */
  deadline?: Date;
}

export interface NextResult {
  expression: string;
  from: string;
  includeStart: boolean;
  times: string[];
  /** 是否因预算或截止而提前停止（可能还有未返回的触发）。 */
  truncated: boolean;
  /** 预算耗尽；不代表表达式永远不会触发。 */
  budgetExhausted: boolean;
  /** 到达截止时刻仍未凑满。 */
  deadlineReached: boolean;
  /** 实际扫描的分钟数。 */
  scannedMinutes: number;
  /** 扫描覆盖范围，便于向用户说明“未证明永不触发”。 */
  range: { from: string; lastScanned: string };
}

function floorToMinute(time: Date): Date {
  return new Date(
    Date.UTC(
      time.getUTCFullYear(),
      time.getUTCMonth(),
      time.getUTCDate(),
      time.getUTCHours(),
      time.getUTCMinutes(),
      0,
      0,
    ),
  );
}

export function nextTimes(parsed: ParsedCron, from: Date, count: number, options: NextOptions = {}): NextResult {
  if (!Number.isInteger(count) || count <= 0) {
    throw new PreviewError('PREVIEW_BAD_COUNT', `count 必须是 1-${MAX_COUNT} 的正整数，收到 ${String(count)}`);
  }
  if (count > MAX_COUNT) {
    throw new PreviewError('PREVIEW_BAD_COUNT', `count 最大为 ${MAX_COUNT}`);
  }
  const budget = options.budgetMinutes ?? DEFAULT_SCAN_BUDGET_MINUTES;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new PreviewError('PREVIEW_BUDGET_EXHAUSTED', 'budgetMinutes 必须是正整数');
  }
  if (options.deadline !== undefined && Number.isNaN(options.deadline.getTime())) {
    throw new PreviewError('PREVIEW_BAD_DEADLINE', 'deadline 不是合法日期');
  }

  const includeStart = options.includeStart ?? false;
  let cursor = floorToMinute(from);
  if (!includeStart) cursor = new Date(cursor.getTime() + 60_000);

  const times: Date[] = [];
  let scanned = 0;
  let budgetExhausted = false;
  let deadlineReached = false;

  while (times.length < count) {
    if (options.deadline && cursor.getTime() > options.deadline.getTime()) {
      deadlineReached = true;
      break;
    }
    if (scanned >= budget) {
      budgetExhausted = true;
      break;
    }
    if (matchesAt(parsed, cursor)) times.push(cursor);
    cursor = new Date(cursor.getTime() + 60_000);
    scanned += 1;
  }

  const lastScanned = new Date(cursor.getTime() - 60_000);
  return {
    expression: parsed.expression,
    from: from.toISOString(),
    includeStart,
    times: times.map((t) => t.toISOString()),
    truncated: budgetExhausted || deadlineReached,
    budgetExhausted,
    deadlineReached,
    scannedMinutes: scanned,
    range: { from: floorToMinute(from).toISOString(), lastScanned: lastScanned.toISOString() },
  };
}
