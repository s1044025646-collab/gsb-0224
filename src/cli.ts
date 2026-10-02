#!/usr/bin/env node
import { resolve } from 'node:path';
import { CronParseError, explainFields, matchesAt, nextTriggerTimes, parseCron } from './cron.js';
import { Store } from './db.js';

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        options.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          options.set(key, next);
          i += 1;
        } else {
          flags.add(key);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options, flags };
}

function fail(error: unknown): never {
  if (error instanceof CronParseError) {
    console.error(JSON.stringify({ valid: false, code: error.code, message: error.message, field: error.field }, null, 2));
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const usage = `Cron 预览 CLI（仅解释时间计划，不执行任何任务）

用法:
  cron validate "<表达式>"
  cron explain  "<表达式>"
  cron matches  "<表达式>" --at 2026-03-02T00:00:00Z
  cron next     "<表达式>" [--from ISO] [--count N] [--include-start]
                           [--until ISO] [--max-scanned-minutes N]
  cron plans:list
  cron plans:save --name 名称 --expression "<表达式>" [--description 说明]
  cron plans:update --id N --expression "<表达式>" [--description 说明]
  cron plans:versions --id N
  cron previews:list [--plan-id N]

全局: --db data/cron.db（默认项目内 data/cron.db）
示例: node dist/cli.js next "*/15 9-17 * * 1-5" --count 6
`;

function buildNextOptions(args: ParsedArgs): Parameters<typeof nextTriggerTimes>[1] {
  const options: Parameters<typeof nextTriggerTimes>[1] = {};
  if (args.options.has('from')) options.from = new Date(args.options.get('from')!);
  if (args.options.has('count')) options.count = Number(args.options.get('count'));
  if (args.flags.has('include-start')) options.includeFrom = true;
  if (args.options.has('until')) options.until = new Date(args.options.get('until')!);
  if (args.options.has('max-scanned-minutes')) options.maxScannedMinutes = Number(args.options.get('max-scanned-minutes'));
  return options;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  if (!command || command === 'help' || args.flags.has('help')) {
    console.log(usage);
    return;
  }

  const dbPath = resolve(args.options.get('db') ?? 'data/cron.db');

  switch (command) {
    case 'validate': {
      const expression = args.positional[1];
      if (!expression) fail(new Error('缺少表达式参数'));
      printJson({ valid: true, expression: parseCron(expression).raw });
      return;
    }
    case 'explain': {
      const expression = args.positional[1];
      if (!expression) fail(new Error('缺少表达式参数'));
      printJson(explainFields(expression));
      return;
    }
    case 'matches': {
      const expression = args.positional[1];
      if (!expression) fail(new Error('缺少表达式参数'));
      const at = new Date(args.options.get('at') ?? new Date().toISOString());
      const cron = parseCron(expression);
      printJson({ expression: cron.raw, at: at.toISOString(), matches: matchesAt(cron, at) });
      return;
    }
    case 'next': {
      const expression = args.positional[1];
      if (!expression) fail(new Error('缺少表达式参数'));
      printJson(nextTriggerTimes(expression, buildNextOptions(args)));
      return;
    }
    case 'plans:list': {
      const store = new Store(dbPath);
      printJson({ plans: store.listPlans() });
      store.close();
      return;
    }
    case 'plans:save': {
      const store = new Store(dbPath);
      const name = args.options.get('name');
      const expression = args.options.get('expression');
      if (!name || !expression) fail(new Error('plans:save 需要 --name 和 --expression'));
      parseCron(expression);
      printJson(store.createPlan(name, expression, args.options.get('description') ?? ''));
      store.close();
      return;
    }
    case 'plans:update': {
      const store = new Store(dbPath);
      const id = Number(args.options.get('id'));
      const expression = args.options.get('expression');
      if (!Number.isInteger(id) || !expression) fail(new Error('plans:update 需要 --id 和 --expression'));
      parseCron(expression);
      printJson(store.updatePlan(id, expression, args.options.get('description') ?? ''));
      store.close();
      return;
    }
    case 'plans:versions': {
      const store = new Store(dbPath);
      const id = Number(args.options.get('id'));
      if (!Number.isInteger(id)) fail(new Error('plans:versions 需要 --id'));
      printJson({ versions: store.listVersions(id) });
      store.close();
      return;
    }
    case 'previews:list': {
      const store = new Store(dbPath);
      const planId = args.options.get('plan-id');
      printJson({
        previews: planId !== undefined ? store.listPreviewsForPlan(Number(planId)) : store.listPreviews(100),
      });
      store.close();
      return;
    }
    default:
      fail(new Error(`未知命令: ${command}\n\n${usage}`));
  }
}

try {
  main();
} catch (error) {
  fail(error);
}
