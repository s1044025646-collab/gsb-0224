import { CronError, PreviewError } from './cron/errors.js';
import { explain, matchesAt, nextTimes, type NextOptions } from './cron/engine.js';
import { parseCron } from './cron/parse.js';
import {
  createSchedule,
  getSchedule,
  getScheduleByName,
  listPreviews,
  listSchedules,
  listVersions,
  savePreview,
  updateSchedule,
  type PreviewRow,
} from './db/index.js';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateExpression(expression: string) {
  const parsed = parseCron(expression);
  return { expression: parsed.expression, fields: explain(parsed) };
}

export function checkMatch(expression: string, atIso: string) {
  const parsed = parseCron(expression);
  const at = parseIsoTime(atIso);
  return {
    expression: parsed.expression,
    at: at.toISOString(),
    matches: matchesAt(parsed, at),
  };
}

function parseIsoTime(value: string): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'PREVIEW_BAD_TIME', '必须提供 ISO 8601 时间（例如 2026-01-15T09:00:00Z）');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, 'PREVIEW_BAD_TIME', `无法解析时间：${value}`);
  }
  return date;
}

export interface PreviewRequestBody {
  expression?: string;
  scheduleId?: number | string;
  from?: string;
  count?: number;
  includeStart?: boolean;
  budgetMinutes?: number;
  deadline?: string;
}

export function runPreview(body: PreviewRequestBody): { result: unknown; previewRecord: PreviewRow } {
  let expression: string | undefined = body.expression;
  let scheduleId: number | null = null;
  let scheduleVersion: number | null = null;

  if (body.scheduleId !== undefined && body.scheduleId !== null) {
    const id = Number(body.scheduleId);
    if (!Number.isInteger(id)) throw new HttpError(400, 'SCHEDULE_BAD_ID', 'scheduleId 必须是整数');
    const schedule = getSchedule(id);
    if (!schedule) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', `计划 #${id} 不存在`);
    scheduleId = schedule.id;
    scheduleVersion = schedule.current_version;
    if (expression === undefined) expression = schedule.expression;
  }

  if (typeof expression !== 'string') {
    throw new HttpError(400, 'CRON_MISSING_EXPRESSION', '必须提供 expression 或 scheduleId');
  }

  let parsed;
  try {
    parsed = parseCron(expression);
  } catch (err) {
    if (err instanceof CronError) {
      throw new HttpError(400, err.code, err.message);
    }
    throw err;
  }

  const from = body.from ? parseIsoTime(body.from) : new Date();
  const count = body.count ?? 5;
  if (!Number.isInteger(count)) {
    throw new HttpError(400, 'PREVIEW_BAD_COUNT', 'count 必须是整数');
  }
  const options: NextOptions = { includeStart: body.includeStart === true };
  if (body.budgetMinutes !== undefined) options.budgetMinutes = body.budgetMinutes;
  if (body.deadline) options.deadline = parseIsoTime(body.deadline);

  try {
    const result = {
      ...nextTimes(parsed, from, count, options),
      fields: explain(parsed),
    };
    const input = {
      expression: parsed.expression,
      scheduleId,
      scheduleVersion,
      from: from.toISOString(),
      count,
      includeStart: options.includeStart ?? false,
      budgetMinutes: options.budgetMinutes ?? null,
      deadline: options.deadline ? options.deadline.toISOString() : null,
    };
    const record = savePreview(scheduleId, scheduleVersion, parsed.expression, input, result);
    return { result: { ...result, previewId: record.id }, previewRecord: record };
  } catch (err) {
    if (err instanceof PreviewError) {
      throw new HttpError(400, err.code, err.message);
    }
    throw err;
  }
}

export interface ScheduleInput {
  name?: unknown;
  expression?: unknown;
  description?: unknown;
}

function requireScheduleFields(body: ScheduleInput): { name: string; expression: string; description: string } {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    throw new HttpError(400, 'SCHEDULE_BAD_NAME', 'name 必须是非空字符串');
  }
  if (typeof body.expression !== 'string') {
    throw new HttpError(400, 'CRON_MISSING_EXPRESSION', 'expression 必须是字符串');
  }
  parseCron(body.expression); // 提前校验
  return {
    name: body.name.trim(),
    expression: body.expression.trim(),
    description: typeof body.description === 'string' ? body.description : '',
  };
}

export function createPlan(body: ScheduleInput) {
  const fields = requireScheduleFields(body);
  if (getScheduleByName(fields.name)) {
    throw new HttpError(409, 'SCHEDULE_NAME_EXISTS', `计划名「${fields.name}」已存在`);
  }
  try {
    return createSchedule(fields.name, fields.expression, fields.description);
  } catch (err) {
    if (err instanceof CronError) throw new HttpError(400, err.code, err.message);
    throw err;
  }
}

export function updatePlan(id: number, body: ScheduleInput) {
  const schedule = getSchedule(id);
  if (!schedule) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', `计划 #${id} 不存在`);
  const fields = requireScheduleFields({
    name: body.name ?? schedule.name,
    expression: body.expression,
    description: body.description ?? schedule.description,
  });
  if (getScheduleByName(fields.name) && fields.name !== schedule.name) {
    throw new HttpError(409, 'SCHEDULE_NAME_EXISTS', `计划名「${fields.name}」已被占用`);
  }
  try {
    return updateSchedule(id, fields.expression, fields.description)!;
  } catch (err) {
    if (err instanceof CronError) throw new HttpError(400, err.code, err.message);
    throw err;
  }
}

export function getPlanOrThrow(id: number) {
  const schedule = getSchedule(id);
  if (!schedule) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', `计划 #${id} 不存在`);
  return schedule;
}

export { listSchedules, listVersions, listPreviews };
