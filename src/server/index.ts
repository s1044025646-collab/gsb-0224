import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, type PreviewRow } from '../db/index.js';
import {
  HttpError,
  checkMatch,
  createPlan,
  getPlanOrThrow,
  listPreviews,
  listSchedules,
  listVersions,
  runPreview,
  updatePlan,
  validateExpression,
} from '../service.js';
import { CronError, PreviewError } from '../cron/errors.js';

export const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'cron-preview.db');

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
      } catch {
        throw new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON');
      }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function decoratePreview(row: PreviewRow) {
  return {
    ...row,
    input: JSON.parse(row.input_json as string),
    result: JSON.parse(row.result_json as string),
  };
}

export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true, utc: new Date().toISOString() });
        return;
      }

      if (method === 'POST' && path === '/validate') {
        const body = (await readJson(req)) as { expression?: unknown };
        if (typeof body.expression !== 'string') {
          throw new HttpError(400, 'CRON_MISSING_EXPRESSION', 'expression 必须是字符串');
        }
        sendJson(res, 200, validateExpression(body.expression));
        return;
      }

      if (method === 'POST' && path === '/matches') {
        const body = (await readJson(req)) as { expression?: unknown; at?: unknown };
        if (typeof body.expression !== 'string') {
          throw new HttpError(400, 'CRON_MISSING_EXPRESSION', 'expression 必须是字符串');
        }
        if (typeof body.at !== 'string') {
          throw new HttpError(400, 'PREVIEW_BAD_TIME', 'at 必须是 ISO 8601 字符串');
        }
        sendJson(res, 200, checkMatch(body.expression, body.at));
        return;
      }

      if (method === 'POST' && path === '/preview') {
        const body = (await readJson(req)) as Parameters<typeof runPreview>[0];
        const { result } = runPreview(body);
        sendJson(res, 200, result);
        return;
      }

      if (method === 'GET' && path === '/schedules') {
        sendJson(res, 200, { schedules: listSchedules() });
        return;
      }

      if (method === 'POST' && path === '/schedules') {
        const body = (await readJson(req)) as Parameters<typeof createPlan>[0];
        sendJson(res, 201, createPlan(body));
        return;
      }

      const scheduleMatch = /^\/schedules\/(\d+)$/.exec(path);
      if (scheduleMatch && method === 'GET') {
        sendJson(res, 200, getPlanOrThrow(Number(scheduleMatch[1])));
        return;
      }
      if (scheduleMatch && method === 'PUT') {
        const body = (await readJson(req)) as Parameters<typeof updatePlan>[1];
        sendJson(res, 200, updatePlan(Number(scheduleMatch[1]), body));
        return;
      }

      const versionsMatch = /^\/schedules\/(\d+)\/versions$/.exec(path);
      if (versionsMatch && method === 'GET') {
        const id = Number(versionsMatch[1]);
        getPlanOrThrow(id);
        sendJson(res, 200, { versions: listVersions(id) });
        return;
      }

      if (method === 'GET' && path === '/previews') {
        const scheduleId = url.searchParams.get('scheduleId');
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const rows = listPreviews({
          scheduleId: scheduleId ? Number(scheduleId) : undefined,
          limit,
        }).map(decoratePreview);
        sendJson(res, 200, { previews: rows });
        return;
      }

      const previewMatch = /^\/previews\/(\d+)$/.exec(path);
      if (previewMatch && method === 'GET') {
        const id = Number(previewMatch[1]);
        const all = listPreviews({ limit: 500 });
        const row = all.find((item) => item.id === id);
        if (!row) throw new HttpError(404, 'PREVIEW_NOT_FOUND', `预览记录 #${id} 不存在`);
        sendJson(res, 200, decoratePreview(row));
        return;
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `路由不存在: ${method} ${path}` } });
    } catch (err) {
      if (err instanceof CronError) {
        sendJson(res, 400, { error: { code: err.code, message: err.message } });
        return;
      }
      if (err instanceof PreviewError) {
        sendJson(res, 400, { error: { code: err.code, message: err.message } });
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: { code: 'INTERNAL', message } });
    }
  });
}

export function listenFree(server: Server, preferredPort?: number): Promise<{ port: number }> {
  return new Promise((resolvePromise, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferredPort !== undefined) {
        server.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(preferredPort ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') {
        resolvePromise({ port: address.port });
      } else {
        reject(new Error('无法获取监听端口'));
      }
    });
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  const dbPath = process.env.CRON_DB_PATH ? resolve(process.env.CRON_DB_PATH) : DEFAULT_DB_PATH;
  openDatabase(dbPath);
  const preferred = process.env.PORT ? Number(process.env.PORT) : undefined;
  const server = createApp();
  listenFree(server, preferred).then(({ port }) => {
    console.log(`Cron 预览服务已启动: http://127.0.0.1:${port}`);
    console.log(`SQLite 数据文件: ${dbPath}`);
  });
}
