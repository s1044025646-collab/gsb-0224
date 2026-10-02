export type FieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';

export interface FieldRange {
  min: number;
  max: number;
}

export interface ParsedField {
  raw: string;
  values: number[];
  set: Set<number>;
  restricted: boolean;
}

export interface CronExpression {
  raw: string;
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
}

export const FIELD_RANGES: Record<FieldName, FieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

export type CronErrorCode =
  | 'CRON_FIELD_COUNT'
  | 'CRON_EMPTY_FIELD'
  | 'CRON_BAD_NUMBER'
  | 'CRON_BAD_RANGE'
  | 'CRON_BAD_STEP'
  | 'CRON_OUT_OF_RANGE';

export class CronParseError extends Error {
  code: CronErrorCode;
  field?: FieldName;
  detail?: string;

  constructor(code: CronErrorCode, message: string, field?: FieldName, detail?: string) {
    super(message);
    this.name = 'CronParseError';
    this.code = code;
    if (field) this.field = field;
    if (detail) this.detail = detail;
  }
}

const FIELD_ORDER: FieldName[] = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];

function parseNumber(token: string, field: FieldName): number {
  if (!/^\d+$/.test(token)) {
    throw new CronParseError('CRON_BAD_NUMBER', `字段 ${field} 包含非数字内容: "${token}"`, field);
  }
  const n = Number(token);
  const range = FIELD_RANGES[field];
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    throw new CronParseError(
      'CRON_OUT_OF_RANGE',
      `字段 ${field} 的数值 ${n} 超出允许范围 ${range.min}-${range.max}`,
      field,
    );
  }
  return n;
}

function parseField(rawInput: string, field: FieldName): ParsedField {
  const raw = rawInput.trim();
  if (raw === '') {
    throw new CronParseError('CRON_EMPTY_FIELD', `字段 ${field} 不能为空`, field);
  }
  const range = FIELD_RANGES[field];
  const set = new Set<number>();

  for (const part of raw.split(',')) {
    if (part === '') {
      throw new CronParseError('CRON_EMPTY_FIELD', `字段 ${field} 的列表中存在空项`, field);
    }
    const slashParts = part.split('/');
    if (slashParts.length > 2) {
      throw new CronParseError('CRON_BAD_STEP', `字段 ${field} 的步长语法有误: "${part}"`, field);
    }
    const base = slashParts[0]!;
    let lo = range.min;
    let hi = range.max;

    if (base === '*') {
      lo = range.min;
      hi = range.max;
    } else if (base.includes('-')) {
      const endpoints = base.split('-');
      if (endpoints.length !== 2 || endpoints.includes('')) {
        throw new CronParseError('CRON_BAD_RANGE', `字段 ${field} 的区间语法有误: "${part}"`, field);
      }
      lo = parseNumber(endpoints[0]!, field);
      hi = parseNumber(endpoints[1]!, field);
      if (lo > hi) {
        throw new CronParseError(
          'CRON_BAD_RANGE',
          `字段 ${field} 的区间 ${lo}-${hi} 不是闭区间（起点不能大于终点）`,
          field,
        );
      }
    } else {
      lo = parseNumber(base, field);
      hi = slashParts.length === 2 ? range.max : lo;
    }

    let step = 1;
    if (slashParts.length === 2) {
      const stepToken = slashParts[1]!;
      if (!/^\d+$/.test(stepToken)) {
        throw new CronParseError('CRON_BAD_STEP', `字段 ${field} 的步长必须为正整数: "${part}"`, field);
      }
      step = Number(stepToken);
      if (step <= 0) {
        throw new CronParseError('CRON_BAD_STEP', `字段 ${field} 的步长必须大于 0`, field);
      }
    }

    for (let v = lo; v <= hi; v += step) {
      set.add(v);
    }
  }

  const normalized = new Set<number>();
  for (const v of set) {
    normalized.add(field === 'dayOfWeek' && v === 7 ? 0 : v);
  }
  const values = [...normalized].sort((a, b) => a - b);
  return { raw, values, set: normalized, restricted: raw !== '*' };
}

export function parseCron(expression: string): CronExpression {
  if (typeof expression !== 'string') {
    throw new CronParseError('CRON_FIELD_COUNT', 'Cron 表达式必须是字符串');
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      'CRON_FIELD_COUNT',
      `Cron 表达式必须恰好包含 5 个字段（分 时 日 月 星期），实际为 ${parts.length} 个`,
    );
  }
  return {
    raw: expression.trim(),
    minute: parseField(parts[0]!, 'minute'),
    hour: parseField(parts[1]!, 'hour'),
    dayOfMonth: parseField(parts[2]!, 'dayOfMonth'),
    month: parseField(parts[3]!, 'month'),
    dayOfWeek: parseField(parts[4]!, 'dayOfWeek'),
  };
}

export function dayMatches(cron: CronExpression, dayOfMonth: number, dayOfWeekSunday0: number): boolean {
  const domRestricted = cron.dayOfMonth.restricted;
  const dowRestricted = cron.dayOfWeek.restricted;
  if (!domRestricted && !dowRestricted) return true;
  if (domRestricted && !dowRestricted) return cron.dayOfMonth.set.has(dayOfMonth);
  if (!domRestricted && dowRestricted) return cron.dayOfWeek.set.has(dayOfWeekSunday0);
  return cron.dayOfMonth.set.has(dayOfMonth) || cron.dayOfWeek.set.has(dayOfWeekSunday0);
}

export function matchesAt(cron: CronExpression, instant: Date): boolean {
  return (
    cron.minute.set.has(instant.getUTCMinutes()) &&
    cron.hour.set.has(instant.getUTCHours()) &&
    cron.month.set.has(instant.getUTCMonth() + 1) &&
    dayMatches(cron, instant.getUTCDate(), instant.getUTCDay())
  );
}

export interface NextOptions {
  count?: number;
  from?: Date;
  includeFrom?: boolean;
  until?: Date;
  maxScannedMinutes?: number;
}

export interface NextResult {
  expression: string;
  from: string;
  includeFrom: boolean;
  times: string[];
  truncated: boolean;
  stopReason: 'count_reached' | 'until_reached' | 'budget_exhausted';
  scannedMinutes: number;
  limit: {
    until: string;
    maxScannedMinutes: number;
  };
}

const DEFAULT_COUNT = 5;
const DEFAULT_HORIZON_DAYS = 366;
const DEFAULT_MAX_SCANNED_MINUTES = 60 * 24 * 400;

export function nextTriggerTimes(expression: string, options: NextOptions = {}): NextResult {
  const cron = parseCron(expression);
  const from = options.from ?? new Date();
  if (Number.isNaN(from.getTime())) {
    throw new CronParseError('CRON_BAD_NUMBER', '起始时间不是合法日期');
  }
  const includeFrom = options.includeFrom ?? false;
  const count = options.count ?? DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1) {
    throw new CronParseError('CRON_BAD_NUMBER', 'count 必须是正整数');
  }
  const maxScannedMinutes = options.maxScannedMinutes ?? DEFAULT_MAX_SCANNED_MINUTES;
  if (!Number.isInteger(maxScannedMinutes) || maxScannedMinutes < 0) {
    throw new CronParseError('CRON_BAD_NUMBER', 'maxScannedMinutes 必须是非负整数');
  }

  const startMinute = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes(),
  );
  const cursor = new Date(startMinute + (includeFrom ? 0 : 60_000));
  const defaultUntil = new Date(startMinute + DEFAULT_HORIZON_DAYS * 86_400_000);
  const until = options.until ?? defaultUntil;
  if (Number.isNaN(until.getTime()) || until.getTime() < cursor.getTime()) {
    throw new CronParseError('CRON_BAD_NUMBER', 'until 不是合法日期或早于实际扫描起点');
  }

  const times: string[] = [];
  let scanned = 0;
  let stopReason: NextResult['stopReason'] = 'until_reached';

  while (times.length < count) {
    if (cursor.getTime() > until.getTime()) {
      stopReason = 'until_reached';
      break;
    }
    if (scanned > maxScannedMinutes) {
      stopReason = 'budget_exhausted';
      break;
    }
    if (matchesAt(cron, cursor)) {
      times.push(cursor.toISOString());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    scanned += 1;
  }

  if (times.length >= count) stopReason = 'count_reached';

  return {
    expression: cron.raw,
    from: new Date(startMinute).toISOString(),
    includeFrom,
    times,
    truncated: times.length < count,
    stopReason,
    scannedMinutes: scanned,
    limit: {
      until: until.toISOString(),
      maxScannedMinutes,
    },
  };
}

export interface FieldExplanation {
  name: FieldName;
  raw: string;
  restricted: boolean;
  values: number[];
}

export function explainFields(expression: string): {
  expression: string;
  fields: FieldExplanation[];
} {
  const cron = parseCron(expression);
  return {
    expression: cron.raw,
    fields: FIELD_ORDER.map((name) => ({
      name,
      raw: cron[name].raw,
      restricted: cron[name].restricted,
      values: cron[name].values,
    })),
  };
}
