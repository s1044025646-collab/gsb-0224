#!/usr/bin/env node
import { resolve } from 'node:path';
import { openDatabase } from '../db/index.js';
import {
  checkMatch,
  createPlan,
  getPlanOrThrow,
  listPreviews,
  listSchedules,
  listVersions,
  runPreview,
  updatePlan,
  validateExpression,
  type PreviewRequestBody,
} from '../service.js';

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'cron-preview.db');

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`错误: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, 'true');
      } else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function numberFlag(flags: Map<string, string>, key: string): number | undefined {
  const value = flags.get(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`--${key} 需要数字，收到 ${value}`);
  return parsed;
}

function runDemo(): void {
  const examples: Array<{ title: string; body: PreviewRequestBody }> = [
    {
      title: '工作日早上 09:30（周一到周五）',
      body: { expression: '30 9 * * 1-5', from: '2026-01-01T00:00:00Z', count: 5 },
    },
    {
      title: '每 15 分钟',
      body: { expression: '*/15 * * * *', from: '2026-01-01T09:07:00Z', count: 6 },
    },
    {
      title: '每月 1 日 00:00',
      body: { expression: '0 0 1 * *', from: '2026-01-15T12:00:00Z', count: 4 },
    },
    {
      title: '每月 31 日：从 2026-02-01 起一个月内找不到（预算/截止耗尽，不代表永不触发）',
      body: {
        expression: '0 0 31 * *',
        from: '2026-02-01T00:00:00Z',
        count: 3,
        deadline: '2026-03-01T00:00:00Z',
      },
    },
    {
      title: '步长与列表组合：分钟 0,15,30,45 中第 10 分钟起每 20 分钟的并集',
      body: { expression: '0,15,30,45,10/20 9 * * *', from: '2026-03-02T09:00:00Z', count: 8 },
    },
  ];

  for (const example of examples) {
    process.stdout.write(`\n=== ${example.title} ===\n`);
    const { result } = runPreview(example.body);
    print(result);
  }

  process.stdout.write('\n=== 保存一个计划并更新（演示版本保留）===\n');
  const existing = listSchedules().find((item) => item.name === 'nightly');
  const created = existing
    ? updatePlan(existing.id, { expression: '0 18 * * *', description: '每日 UTC 18:00 的报表（重置）' })!
    : createPlan({
        name: 'nightly',
        expression: '0 18 * * *',
        description: '每日 UTC 18:00 的报表',
      });
  const updated = updatePlan(created.id, {
    expression: '30 18 * * *',
    description: '每日 UTC 18:30 的报表（已改点）',
  });
  runPreview({ scheduleId: created.id, from: '2026-01-01T00:00:00Z', count: 3 });
  print({ schedule: updated, versions: listVersions(created.id) });
}

function main(argv: string[]): void {
  const dbPath = process.env.CRON_DB_PATH ? resolve(process.env.CRON_DB_PATH) : DEFAULT_DB_PATH;
  openDatabase(dbPath);

  const [command, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);

  try {
    switch (command) {
      case 'validate':
      case 'explain': {
        const expression = positional[0];
        if (!expression) fail('用法: cron-preview validate "<表达式>"');
        print(validateExpression(expression));
        break;
      }
      case 'matches': {
        const [expression, at] = positional;
        if (!expression || !at) fail('用法: cron-preview matches "<表达式>" <ISO 时间>');
        print(checkMatch(expression, at));
        break;
      }
      case 'next': {
        const expression = positional[0];
        if (!expression) fail('用法: cron-preview next "<表达式>" [--from ISO] [--count N] ...');
        const body: PreviewRequestBody = {
          expression,
          from: flags.get('from'),
          count: numberFlag(flags, 'count') ?? 5,
          includeStart: flags.has('include-start'),
          budgetMinutes: numberFlag(flags, 'budget'),
          deadline: flags.get('deadline'),
        };
        print(runPreview(body).result);
        break;
      }
      case 'schedule': {
        const sub = positional[0];
        if (sub === 'list') {
          print({ schedules: listSchedules() });
        } else if (sub === 'create') {
          const name = flags.get('name');
          const expression = flags.get('expression');
          const description = flags.get('description') ?? '';
          if (!name || !expression) fail('用法: schedule create --name 名称 --expression "<表达式>" [--description 文本]');
          print(createPlan({ name, expression, description }));
        } else if (sub === 'update') {
          const id = numberFlag(flags, 'id');
          const expression = flags.get('expression');
          if (id === undefined || !expression) fail('用法: schedule update --id N --expression "<表达式>" [--description 文本]');
          print(updatePlan(id, { expression, description: flags.get('description') ?? undefined }));
        } else if (sub === 'versions') {
          const id = numberFlag(flags, 'id');
          if (id === undefined) fail('用法: schedule versions --id N');
          print({ schedule: getPlanOrThrow(id), versions: listVersions(id) });
        } else {
          fail('子命令需为 list | create | update | versions');
        }
        break;
      }
      case 'history': {
        const rows = listPreviews({
          scheduleId: numberFlag(flags, 'schedule-id'),
          limit: numberFlag(flags, 'limit') ?? 20,
        });
        print({
          previews: rows.map((row) => ({
            ...row,
            input: JSON.parse(row.input_json),
            result: JSON.parse(row.result_json),
          })),
        });
        break;
      }
      case 'demo':
        runDemo();
        break;
      default:
        process.stdout.write(
          [
            'cron-preview — 本地 Cron 表达式解释与触发时间预览（五字段，UTC）',
            '',
            '用法:',
            '  cron-preview validate "<表达式>"',
            '  cron-preview matches "<表达式>" <ISO 时间>',
            '  cron-preview next "<表达式>" [--from ISO] [--count N] [--include-start] [--budget 分钟] [--deadline ISO]',
            '  cron-preview schedule list',
            '  cron-preview schedule create --name 名称 --expression "<表达式>" [--description 文本]',
            '  cron-preview schedule update --id N --expression "<表达式>" [--description 文本]',
            '  cron-preview schedule versions --id N',
            '  cron-preview history [--schedule-id N] [--limit N]',
            '  cron-preview demo',
            '',
          ].join('\n'),
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.exitCode !== 1) {
      process.stderr.write(`错误: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

main(process.argv.slice(2));
