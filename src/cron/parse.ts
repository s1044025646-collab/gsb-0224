import { CronError } from './errors.js';

/** 五个字段的名称与合法闭区间（星期在解析层接受 0-7，归一化时 7->0）。 */
export interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

export const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
];

export interface ParsedField {
  /** 命中的数值集合（星期已把 7 归一化为 0）。 */
  values: Set<number>;
  /** 该字段是否仅为星号（未受限）；星号/步长 形式视为受限。 */
  unrestricted: boolean;
  /** 归一化后的字段文本（用于解释展示）。 */
  normalized: string;
}

export interface ParsedCron {
  expression: string;
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
}

function parseNumber(token: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(token)) {
    throw new CronError('CRON_INVALID_NUMBER', `「${token}」不是非负整数`, spec.name);
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    throw new CronError(
      'CRON_NUMBER_OUT_OF_RANGE',
      `数值 ${value} 超出允许范围 ${spec.min}-${spec.max}`,
      spec.name,
    );
  }
  return value;
}

/**
 * 解析单个字段：支持星号、数字、逗号列表、闭区间 a-b、步长（星号/n、a-b/n、a/n）。
 * 列表项之间求并集；区间为闭区间；步长从区间起点开始，而非查询时刻。
 */
export function parseField(raw: string, spec: FieldSpec): ParsedField {
  const token = raw.trim();
  if (token === '') {
    throw new CronError('CRON_EMPTY_FIELD', '字段为空', spec.name);
  }

  const values = new Set<number>();
  let unrestricted = false;

  const parts = token.split(',');
  for (const part of parts) {
    if (part === undefined || part === '') {
      throw new CronError('CRON_SYNTAX', `列表项为空：「${raw}」`, spec.name);
    }

    const slashParts = part.split('/');
    if (slashParts.length > 2) {
      throw new CronError('CRON_SYNTAX', `步长语法非法：「${part}」`, spec.name);
    }
    const rangeToken = slashParts[0]!;
    let step = 1;
    if (slashParts.length === 2) {
      const stepToken = slashParts[1]!;
      if (!/^\d+$/.test(stepToken) || Number(stepToken) === 0) {
        throw new CronError('CRON_STEP_INVALID', `步长必须是正整数：「${stepToken}」`, spec.name);
      }
      step = Number(stepToken);
    }

    if (rangeToken === '*') {
      if (slashParts.length === 1) {
        unrestricted = true;
        for (let v = spec.min; v <= spec.max; v += 1) values.add(v);
      } else {
        for (let v = spec.min; v <= spec.max; v += step) values.add(v);
      }
      continue;
    }

    let lo: number;
    let hi: number;
    if (rangeToken.includes('-')) {
      const bounds = rangeToken.split('-');
      if (bounds.length !== 2 || bounds[0] === '' || bounds[1] === '') {
        throw new CronError('CRON_SYNTAX', `区间语法非法：「${rangeToken}」`, spec.name);
      }
      lo = parseNumber(bounds[0]!, spec);
      hi = parseNumber(bounds[1]!, spec);
      if (lo > hi) {
        throw new CronError('CRON_RANGE_REVERSED', `区间起点 ${lo} 大于终点 ${hi}`, spec.name);
      }
    } else {
      const single = parseNumber(rangeToken, spec);
      if (slashParts.length === 2) {
        lo = single;
        hi = spec.max;
      } else {
        lo = single;
        hi = single;
      }
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  // 星期归一化：7 -> 0（周日两种写法等价）。
  if (spec.name === 'dayOfWeek' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  const normalized = [...values].sort((a, b) => a - b).join(',');
  return { values, unrestricted, normalized };
}

export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string') {
    throw new CronError('CRON_SYNTAX', '表达式必须是字符串');
  }
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronError(
      'CRON_FIELD_COUNT',
      `需要恰好 5 个字段（分 时 日 月 星期），实际 ${tokens.length} 个`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELD_SPECS.map((spec, i) =>
    parseField(tokens[i]!, spec),
  );
  return {
    expression: expression.trim(),
    minute: minute!,
    hour: hour!,
    dayOfMonth: dayOfMonth!,
    month: month!,
    dayOfWeek: dayOfWeek!,
  };
}
