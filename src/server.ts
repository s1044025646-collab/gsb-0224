import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CronParseError, explainFields, matchesAt, nextTriggerTimes, parseCron } from './cron.js';
import { Store } from './db.js';

interface JsonRequestBody {
  [key: string]: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, extra?: unknown): void {
  sendJson(res, status, { error: { code, message, ...(extra ? { details: extra } : {}) } });
}

async function readJson(req: IncomingMessage): Promise<JsonRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf-8');
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as JsonRequestBody;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireString(body: JsonRequestBody, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_PARAMETER', `参数 "${key}" 必须是非空字符串`);
  }
  return value;
}

function optionalBoolean(body: JsonRequestBody, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'INVALID_PARAMETER', `参数 "${key}" 必须是布尔值`);
  }
  return value;
}

function optionalPositiveInt(body: JsonRequestBody, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, 'INVALID_PARAMETER', `参数 "${key}" 必须是正整数`);
  }
  return value;
}

function optionalNonNegativeInt(body: JsonRequestBody, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, 'INVALID_PARAMETER', `参数 "${key}" 必须是非负整数`);
  }
  return value;
}

function optionalDate(body: JsonRequestBody, key: string): Date | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_PARAMETER', `参数 "${key}" 必须是 ISO 8601 字符串`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, 'INVALID_PARAMETER', `参数 "${key}" 不是合法日期`);
  }
  return date;
}

function cronErrorToHttp(error: CronParseError): { status: number; code: string } {
  const status = error.code === 'CRON_FIELD_COUNT' ? 400 : 422;
  return { status, code: error.code };
}

export function createApp(dbPath?: string): { close: () => void; listen: (port?: number) => Promise<{ port: number }> } {
  const store = new Store(dbPath ?? resolve('data/cron.db'));
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, store);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof CronParseError) {
        const mapping = cronErrorToHttp(error);
        sendError(res, mapping.status, mapping.code, error.message, error.field ? { field: error.field } : undefined);
        return;
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      if (message === 'PLAN_NOT_FOUND') {
        sendError(res, 404, 'PLAN_NOT_FOUND', '指定的计划不存在');
        return;
      }
      if (String(message).includes('UNIQUE')) {
        sendError(res, 409, 'PLAN_NAME_CONFLICT', '同名计划已存在');
        return;
      }
      sendError(res, 500, 'INTERNAL_ERROR', message);
    }
  });

  return {
    listen(port = Number(process.env.PORT ?? 0)) {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('无法确定监听端口'));
            return;
          }
          resolvePromise({ port: address.port });
        });
      });
    },
    close() {
      server.close();
      store.close();
    },
  };
}

async function route(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'ok', time: new Date().toISOString() });
    return;
  }

  if (method === 'POST' && path === '/api/validate') {
    const body = await readJson(req);
    const expression = requireString(body, 'expression');
    const cron = parseCron(expression);
    sendJson(res, 200, { valid: true, expression: cron.raw });
    return;
  }

  if (method === 'POST' && path === '/api/explain') {
    const body = await readJson(req);
    const expression = requireString(body, 'expression');
    sendJson(res, 200, explainFields(expression));
    return;
  }

  if (method === 'POST' && path === '/api/matches') {
    const body = await readJson(req);
    const expression = requireString(body, 'expression');
    const at = optionalDate(body, 'at') ?? new Date();
    const cron = parseCron(expression);
    sendJson(res, 200, {
      expression: cron.raw,
      at: at.toISOString(),
      matches: matchesAt(cron, at),
    });
    return;
  }

  if (method === 'POST' && path === '/api/next') {
    const body = await readJson(req);
    const expression = requireString(body, 'expression');
    const result = computeNext(body, expression);
    const requestSnapshot = { ...body, expression };
    store.insertPreview({
      planId: null,
      planVersion: null,
      expressionSnapshot: result.expression,
      requestJson: JSON.stringify(requestSnapshot),
      resultJson: JSON.stringify(result),
    });
    sendJson(res, 200, result);
    return;
  }

  if (method === 'GET' && path === '/api/plans') {
    sendJson(res, 200, { plans: store.listPlans() });
    return;
  }

  if (method === 'POST' && path === '/api/plans') {
    const body = await readJson(req);
    const name = requireString(body, 'name');
    const expression = requireString(body, 'expression');
    parseCron(expression);
    const description = typeof body.description === 'string' ? body.description : '';
    const plan = store.createPlan(name, expression, description);
    sendJson(res, 201, plan);
    return;
  }

  const planMatch = /^\/api\/plans\/(\d+)$/.exec(path);
  if (planMatch) {
    const id = Number(planMatch[1]);
    if (method === 'GET') {
      const plan = store.getPlan(id);
      if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '指定的计划不存在');
      const withVersions = url.searchParams.get('versions') === '1';
      sendJson(res, 200, withVersions ? { ...plan, versions: store.listVersions(id) } : plan);
      return;
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      const expression = requireString(body, 'expression');
      parseCron(expression);
      const description = typeof body.description === 'string' ? body.description : '';
      const plan = store.updatePlan(id, expression, description);
      sendJson(res, 200, plan);
      return;
    }
  }

  const previewMatch = /^\/api\/plans\/(\d+)\/preview$/.exec(path);
  if (previewMatch && method === 'POST') {
    const id = Number(previewMatch[1]);
    const plan = store.getPlan(id);
    if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', '指定的计划不存在');
    const body = await readJson(req);
    const usedExpression = typeof body.expression === 'string' ? body.expression : plan.expression;
    parseCron(usedExpression);
    const result = nextTriggerTimes(usedExpression, {
      count: optionalPositiveInt(body, 'count'),
      from: optionalDate(body, 'from'),
      includeFrom: optionalBoolean(body, 'includeFrom'),
      until: optionalDate(body, 'until'),
      maxScannedMinutes: optionalNonNegativeInt(body, 'maxScannedMinutes'),
    });
    const stored = { ...result, expression: usedExpression };
    store.insertPreview({
      planId: plan.id,
      planVersion: plan.version,
      expressionSnapshot: usedExpression,
      requestJson: JSON.stringify({ ...body, planId: id, planVersion: plan.version }),
      resultJson: JSON.stringify(stored),
    });
    sendJson(res, 200, { ...stored, planId: plan.id, planVersion: plan.version });
    return;
  }

  if (method === 'GET' && path === '/api/previews') {
    const planIdParam = url.searchParams.get('planId');
    if (planIdParam !== null) {
      const planId = Number(planIdParam);
      if (!Number.isInteger(planId)) throw new HttpError(400, 'INVALID_PARAMETER', 'planId 必须是整数');
      sendJson(res, 200, { previews: store.listPreviewsForPlan(planId) });
      return;
    }
    sendJson(res, 200, { previews: store.listPreviews(100) });
    return;
  }

  sendError(res, 404, 'NOT_FOUND', `未找到路由: ${method} ${path}`);
}

function computeNext(
  body: JsonRequestBody,
  fallbackExpression?: string,
): ReturnType<typeof nextTriggerTimes> {
  const expression =
    (typeof body.expression === 'string' && body.expression.trim() !== '') || fallbackExpression === undefined
      ? requireString(body, 'expression')
      : fallbackExpression;
  return nextTriggerTimes(expression, {
    count: optionalPositiveInt(body, 'count'),
    from: optionalDate(body, 'from'),
    includeFrom: optionalBoolean(body, 'includeFrom'),
    until: optionalDate(body, 'until'),
    maxScannedMinutes: optionalNonNegativeInt(body, 'maxScannedMinutes'),
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const app = createApp();
  app
    .listen()
    .then(({ port }) => {
      console.log(`Cron 预览服务已启动: http://127.0.0.1:${port}`);
      console.log(`数据目录: ${resolve('data')}`);
      console.log('设置 PORT 环境变量可指定端口；默认由系统分配空闲端口。');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
