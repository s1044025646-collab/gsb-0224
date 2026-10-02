# Cron 表达式解释与触发时间预览服务（Windows 本地后端）

一个只运行在本机的 Cron **检查与预览**服务：解析五字段 Cron 表达式，解释字段集合，判断某时刻是否匹配，并计算给定时刻之后的若干次触发时间。

- 只解释时间计划：**不调度任务、不执行命令、无常驻队列**。
- 只做 **HTTP API 与 CLI**，无前端。
- 时间统一使用 **UTC**；不处理秒字段、时区、夏令时。
- SQLite 保存**命名计划的版本历史**和每次**预览的输入输出快照**；修改计划不会改写旧报告。
- 零第三方运行时依赖：HTTP 使用 Node 内置模块，数据库使用 Node 内置的 `node:sqlite`（需要 Node 22.5+，本项目在 Node 25 上开发验证）。

## 环境要求

- Windows 本地 PowerShell
- Node.js 22.5 或更高（使用内置 `node:sqlite`；命令行可能出现一次 ExperimentalWarning，属正常现象）
- 不需要 Docker、WSL、付费服务或外部在线 API

## 快速开始

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 编译并运行全部测试
npm run demo       # 四个内置演示场景
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
```

启动后控制台会打印实际地址，例如 `http://127.0.0.1:61711`。需要固定端口时：

```powershell
$env:PORT=8080; npm start
```

数据库默认位于项目内 `data/cron.db`（SQLite WAL 模式）。

## Cron 方言

五字段，全部只接受数字与符号，不支持月份/星期英文名、别名或 `@hourly` 等扩展语法。

| 字段 | 含义 | 范围 |
| --- | --- | --- |
| 1 | 分钟 | 0-59 |
| 2 | 小时 | 0-23 |
| 3 | 日（day of month） | 1-31 |
| 4 | 月 | 1-12 |
| 5 | 星期（day of week） | 0-7，其中 **0 和 7 都表示周日**，1=周一 … 6=周六 |

每个字段支持的语法：

- `*`：该字段全部合法值。
- 数字：单值，如 `30`。
- 列表：逗号分隔，如 `0,15,45`。
- 闭区间：`a-b`，包含两端，如 `9-17`；起点不能大于终点。
- 步长：`*/n`、`a-b/n` 或 `a/n`（`a/n` 表示从 `a` 到该字段最大值每 `n`），如 `*/15`、`0,15-45/15`。
- 列表/区间/步长可以组合，如 `0,15-30/5,45`。

**日与星期组合口径（常见 Vixie cron 风格）**：

- 两个字段都受限（都不是裸 `*`）：日期命中**或**星期命中即触发（OR）。
- 只有一个受限：只按受限字段判断，另一个不参与。
- 两者都是 `*`：每天。

其他约定与差异：

- 所有计算均为 UTC，返回 ISO 8601（`...Z`），无任何本地时区或夏令时偏移。
- 触发时间对齐到表达式自身的固定分钟网格。`*/15` 永远是 00/15/30/45，**不会**从查询时刻开始“每隔 15 分钟”计时。
- 默认只计算**严格晚于**输入时刻的分钟；输入时刻的秒会被向下取整到该分钟。传 `includeFrom: true` 可把起点分钟包含在内。
- 枚举方式是从起点开始逐分钟扫描并做集合匹配，不做复杂日历优化；因此提供截止日期与扫描预算双重限制。
- 预算/截止范围内没有结果，只说明“在该范围内未找到”，**不断言表达式永远不会触发**（例如 `0 0 31 2 *` 实际永不触发，但本服务只报告扫描范围）。

## 扫描参数

预览接口（API 与 CLI）接受：

- `from`：起点 UTC 时间，默认当前时间。
- `includeFrom`：是否包含起点分钟，默认 `false`。
- `count`：需要的触发次数，默认 5，必须为正整数。
- `until`：截止时间；默认起点之后 366 天。
- `maxScannedMinutes`：最多扫描的分钟数，默认 576000（约 400 天），防止无效表达式无限扫描。

返回中包含 `truncated`、`stopReason`（`count_reached` / `until_reached` / `budget_exhausted`）、`scannedMinutes` 和实际 `limit`，便于判断结果是否完整。

## HTTP API

仅监听 `127.0.0.1`。请求体均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/validate` | 校验表达式 |
| POST | `/api/explain` | 返回五个字段解析后的值集合 |
| POST | `/api/matches` | 判断 `at`（默认现在）是否匹配 |
| POST | `/api/next` | 计算后续触发时间，并写入预览历史 |
| GET | `/api/plans` | 计划列表 |
| POST | `/api/plans` | 新建命名计划（`name` 唯一） |
| GET | `/api/plans/:id[?versions=1]` | 查看计划，可选附带版本历史 |
| PUT | `/api/plans/:id` | 更新表达式/说明，自动新增版本 |
| POST | `/api/plans/:id/preview` | 按计划当前版本计算并保存带版本号的预览 |
| GET | `/api/previews[?planId=:id]` | 预览历史 |

示例：

```powershell
$base = 'http://127.0.0.1:8080'

Invoke-RestMethod "$base/api/explain" -Method Post -ContentType 'application/json' `
  -Body '{"expression":"*/15 9-17 * * 1-5"}'

Invoke-RestMethod "$base/api/next" -Method Post -ContentType 'application/json' `
  -Body '{"expression":"30 9 * * 1-5","from":"2026-02-27T00:00:00Z","count":5}'

Invoke-RestMethod "$base/api/plans" -Method Post -ContentType 'application/json' `
  -Body '{"name":"工作日早会","expression":"30 9 * * 1-5","description":"周一至周五 09:30 UTC"}'
```

错误响应统一为：

```json
{ "error": { "code": "CRON_OUT_OF_RANGE", "message": "...", "details": { "field": "minute" } } }
```

常见错误码：`INVALID_JSON`、`INVALID_PARAMETER`、`CRON_FIELD_COUNT`、`CRON_EMPTY_FIELD`、`CRON_BAD_NUMBER`、`CRON_BAD_RANGE`、`CRON_BAD_STEP`、`CRON_OUT_OF_RANGE`、`PLAN_NOT_FOUND`、`PLAN_NAME_CONFLICT`、`NOT_FOUND`、`INTERNAL_ERROR`。

## CLI

```powershell
node dist/src/cli.js validate "*/15 * * * *"
node dist/src/cli.js explain "0,15-45/15 9-17 * * 1-5"
node dist/src/cli.js matches "0 9 * * 1" --at 2026-03-02T09:00:00Z
node dist/src/cli.js next "*/15 * * * *" --from 2026-03-02T10:07:00Z --count 4
node dist/src/cli.js next "0 0 31 2 *" --from 2026-02-01T00:00:00Z --until 2026-02-28T23:59:00Z
node dist/src/cli.js plans:save --name "月报" --expression "0 0 1 * *" --description "每月一日"
node dist/src/cli.js plans:list
node dist/src/cli.js plans:update --id 1 --expression "0 0 2 * *"
node dist/src/cli.js plans:versions --id 1
node dist/src/cli.js previews:list
```

CLI 输出为 JSON；表达式非法时退出码为 2 并输出错误码。

## 数据模型

- `plans`：计划当前状态（`name` 唯一，`version` 单调递增）。
- `plan_versions`：每次新建/修改产生的不可变版本（表达式 + 说明 + 时间）。
- `previews`：预览输入 `request_json`、输出 `result_json`、**当时表达式快照**以及 `plan_id`/`plan_version`。计划被修改后，旧预览仍保留旧表达式与版本号。

## 演示场景（`npm run demo`）

1. 工作日 09:30：`30 9 * * 1-5`，展示周末跳过与跨年。
2. 每十五分钟：`*/15 * * * *`，展示固定网格而非查询时刻偏移。
3. 每月固定日期：`0 0 1 * *`。
4. 二月三十一日：`0 0 31 2 *`，在给定范围内无结果，报告 `until_reached`。

## 测试

`npm test` 覆盖：步长与列表组合、周日 0/7、日与星期 OR 关系、跨年、闰日、起点边界（含秒）、非法范围/步长、预算耗尽，以及 SQLite 版本保留、重启后历史可查和 HTTP API 集成。

## 限制

- 仅 UTC，无秒字段、时区、DST、英文名、别名和扩展宏。
- 逐分钟枚举，刻意不做日历算法优化；极长跨度的稀有表达式应显式调大 `maxScannedMinutes`/`until`。
- 服务只绑定本机回环地址，未实现鉴权（定位为单机工具）。
- `node:sqlite` 在当前 Node 版本仍带实验性警告，API 可能随 Node 版本调整。
