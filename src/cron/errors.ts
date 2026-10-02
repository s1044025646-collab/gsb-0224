export type CronErrorCode =
  | 'CRON_FIELD_COUNT'
  | 'CRON_EMPTY_FIELD'
  | 'CRON_INVALID_NUMBER'
  | 'CRON_NUMBER_OUT_OF_RANGE'
  | 'CRON_RANGE_REVERSED'
  | 'CRON_STEP_INVALID'
  | 'CRON_SYNTAX';

export class CronError extends Error {
  readonly code: CronErrorCode;
  readonly field?: string;

  constructor(code: CronErrorCode, message: string, field?: string) {
    super(field ? `[${code}] 字段「${field}」: ${message}` : `[${code}] ${message}`);
    this.name = 'CronError';
    this.code = code;
    this.field = field;
  }
}

export type PreviewErrorCode =
  | 'PREVIEW_BAD_COUNT'
  | 'PREVIEW_BAD_TIME'
  | 'PREVIEW_BUDGET_EXHAUSTED'
  | 'PREVIEW_BAD_DEADLINE';

export class PreviewError extends Error {
  readonly code: PreviewErrorCode;

  constructor(code: PreviewErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'PreviewError';
    this.code = code;
  }
}
