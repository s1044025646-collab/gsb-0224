import { explainFields, nextTriggerTimes } from './cron.js';

const demos: Array<{ title: string; expression: string; from: string; count?: number; until?: string }> = [
  {
    title: '工作日 09:30（周一至周五）',
    expression: '30 9 * * 1-5',
    from: '2026-02-27T09:00:00Z',
    count: 6,
  },
  {
    title: '每十五分钟（00/15/30/45，与查询时刻无关）',
    expression: '*/15 * * * *',
    from: '2026-03-02T10:07:00Z',
    count: 6,
  },
  {
    title: '每月 1 日 00:00',
    expression: '0 0 1 * *',
    from: '2026-01-15T12:00:00Z',
    count: 4,
  },
  {
    title: '二月找不到 31 日（预算内无结果，不代表永远不触发）',
    expression: '0 0 31 2 *',
    from: '2026-02-01T00:00:00Z',
    count: 1,
    until: '2026-03-31T23:59:00Z',
  },
];

for (const demo of demos) {
  console.log(`\n=== ${demo.title} ===`);
  console.log(JSON.stringify(explainFields(demo.expression), null, 2));
  const result = nextTriggerTimes(demo.expression, {
    from: new Date(demo.from),
    count: demo.count ?? 5,
    until: demo.until ? new Date(demo.until) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}
