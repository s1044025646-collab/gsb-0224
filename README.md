# cron-preview：本地 Cron 表达式解释与触发时间预览

一个只做“解释与预览”的本地后端：解析五字段 Cron 表达式，求给定 UTC 时刻之后的若干次触发时间，并用 SQLite 保存命名计划的版本与每次预览的输入/输出。**不调度真实任务、不执行任何用户命令、没有常驻任务队列。**

仅使用 Node.js 内置能力（`node:http`、`node:sqlite`、`node:test`）与 TypeScript，无第三方运行时依赖，无需 Docker、WSL 或任何在线服务。

## 环境要求

- Windows + PowerShell（跨平台亦可）
- Node.js ≥ 22.5（开发与实测环境为 Node v25.5.0；`node:sqlite` 需要 `--experimental-sqlite` 标志）

## 快速开始

```powershell
npm install        # 只安装 typescript 与 @types/node（开发依赖）
npm run build      # TypeScript 编译到 dist/
npm test           # 编译并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # CLI 内置演示：工作日/每15分钟/每月1日/二月找不到31日
```

启动后控制台会打印实际监听地址，例如 `http://127.0.0.1:51010`。

- `PORT=8080 npm start`：指定端口；若该端口被占用，自动回退到系统分配的空闲端口。
- `CRON_DB_PATH=D:\path\to\demo.db npm start`：自定义 SQLite 文件位置。

默认数据文件位于项目内 `data/cron-preview.db`（WAL 模式）。

## 方言定义（与常见实现的差异）

统一采用 **UTC**，不涉及时区与夏令时；固定五字段，**没有秒字段**：

| 字段 | 允许范围 | 备注 |
| --- | --- | --- |
| 分钟 minute | 0-59 | |
| 小时 hour | 0-23 | |
| 日 dayOfMonth | 1-31 | |
| 月 month | 1-12 | 只接受数字，无月份英文名/别名 |
| 星期 dayOfWeek | 0-7 | **0 与 7 都表示周日（周六为 6）** |

- 语法仅支持：`*`、数字、逗号列表（并集）、闭区间 `a-b`、步长 `*/n`、`a-b/n`、`a/n`；列表项求并集。
- **步长从字段起点开始**，例如 `*/15` 的分钟集合是 `{0,15,30,45}`，与查询时刻无关，不是“从现在起每 15 分钟”。
- 纯 `*` 表示“该字段不受限”；`*/n` 属于受限集合。
- **日与星期的组合采用常见 Vixie Cron 口径（OR）**：当“日”和“星期”**都**写了具体限制时，满足任一即触发；只有一个受限时，以受限者为准。
  - 例：`0 0 1 * 1` 表示“每月 1 日”**或**“周一”，而非两者同时满足。
  - 这与 Quartz（Java，6-7 字段、周日=1/SUN=1）以及部分把两者当 AND 的实现不同。
- 不支持：秒、年、`?`、`L/W/#`、`@daily` 等别名、英文名、月份/星期别名。

## 起点与“接下来几次”

- 起点向下取整到分钟，秒被忽略。
- 默认 **严格晚于**输入时刻：即使起点那一分钟匹配，也从下一分钟开始扫描。
- 传 `includeStart: true`（CLI 为 `--include-start`）时允许返回起点所在分钟。
- 返回时间均为 ISO 8601 UTC（`...Z`），并回显所用表达式与扫描范围。

### 搜索范围：截止日期与扫描预算

预览是逐分钟枚举（不做复杂日历优化），由两道保护终止：

- `deadline`（ISO UTC）：只返回不晚于该时刻的触发。
- `budgetMinutes`：最多扫描的分钟数，默认 527040（366 天）。

当范围内未找满次数，返回 `truncated: true`，并区分 `budgetExhausted` 与 `deadlineReached`，同时给出 `scannedMinutes` 与 `range`。**这只表示在该有限范围内没找到，不代表表达式永远不会触发。** 例如 `0 0 31 * *` 在二月扫描必然为空，但 3 月 31 日会触发。

## HTTP API

所有错误返回 `{ "error": { "code", "message" } }`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查与当前 UTC |
| `POST /validate` | 校验表达式并返回各字段命中集合 `fields` |
| `POST /matches` | 判断 `at`（ISO）是否匹配，body：`expression`,`at` |
| `POST /preview` | 计算接下来若干次并写入预览历史 |
| `GET /schedules` | 计划列表 |
| `POST /schedules` | 创建计划，body：`name`,`expression`,`description?` |
| `GET /schedules/:id` | 计划详情（当前版本） |
| `PUT /schedules/:id` | 更新表达式/说明（追加版本，不改写历史） |
| `GET /schedules/:id/versions` | 全部历史版本 |
| `GET /previews?scheduleId=&limit=` | 预览历史（含输入与结果快照） |
| `GET /previews/:id` | 单条预览记录 |

`POST /preview` 请求体：

```json
{
  "expression": "*/15 9-17 * * 1-5",
  "from": "2026-01-01T09:07:00Z",
  "count": 5,
  "includeStart": false,
  "budgetMinutes": 527040,
  "deadline": "2026-12-31T23:59:00Z",
  "scheduleId": 1
}
```

- `expression` 与 `scheduleId` 至少给一个；给 `scheduleId` 时默认使用该计划当前表达式，同时在记录中固化 `scheduleVersion`。
- `from` 省略时取当前 UTC。`count` 默认 5，最大 1000。

错误码（节选）：`CRON_FIELD_COUNT`、`CRON_INVALID_NUMBER`、`CRON_NUMBER_OUT_OF_RANGE`、`CRON_RANGE_REVERSED`、`CRON_STEP_INVALID`、`PREVIEW_BAD_TIME`、`PREVIEW_BAD_COUNT`、`PREVIEW_BUDGET_EXHAUSTED`、`SCHEDULE_NOT_FOUND`、`SCHEDULE_NAME_EXISTS`、`BAD_JSON`、`NOT_FOUND`。

curl 示例（PowerShell 建议用文件避免引号转义）：

```powershell
'{"expression":"*/15 * * * *","from":"2026-01-01T09:07:00Z","count":3}' | Set-Content b.json
curl.exe -s -X POST http://127.0.0.1:<端口>/preview -H "content-type: application/json" --data-binary "@b.json"
```

## CLI

编译后可用 `node --experimental-sqlite dist/src/cli/index.js <命令>`（或 `npm link` 后使用 `cron-preview`）：

```powershell
node --experimental-sqlite dist/src/cli/index.js validate "*/15 9-17 * * 1-5"
node --experimental-sqlite dist/src/cli/index.js matches "30 9 * * 1-5" 2026-01-02T09:30:00Z
node --experimental-sqlite dist/src/cli/index.js next "0 0 31 * *" --from 2026-02-01T00:00:00Z --deadline 2026-03-01T00:00:00Z
node --experimental-sqlite dist/src/cli/index.js next "0 0 29 2 *" --from 2026-03-01T00:00:00Z --count 2 --budget 4204800
node --experimental-sqlite dist/src/cli/index.js schedule create --name nightly --expression "30 18 * * *" --description "每日UTC18:30"
node --experimental-sqlite dist/src/cli/index.js schedule list
node --experimental-sqlite dist/src/cli/index.js schedule update --id 1 --expression "0 18 * * *"
node --experimental-sqlite dist/src/cli/index.js schedule versions --id 1
node --experimental-sqlite dist/src/cli/index.js history --limit 10
node --experimental-sqlite dist/src/cli/index.js demo
```

CLI 默认使用 `data/cron-preview.db`，同样支持 `CRON_DB_PATH` 环境变量。

## 数据模型（版本不可变）

- `schedules`：计划主表，保存当前表达式与 `current_version`。
- `schedule_versions`：每次创建/更新追加一条（表达式 + 说明 + 版本号），永不修改。
- `previews`：每次预览保存原始输入 `input_json`、完整输出 `result_json`、以及当时的 `schedule_id`/`schedule_version`/表达式文本。

因此**修改计划不会改写任何旧预览报告**；服务重启后历史与版本仍可查询（测试已覆盖）。

## 测试

`npm test` 使用内置 `node:test`/`node:assert`，预期日期为独立手算，覆盖：

- 步长与列表组合求并集、`*/n` 从字段起点开始
- 星期 0 与 7 等价（均为周日）
- 日与星期 OR 关系、工作日跨周末
- 跨年（每月 1 日）、闰日（`2/29` 跳过平年到 2028/2032）
- 起点边界（严格晚于 vs `includeStart`）
- 非法字段数、越界、反向区间、零步长
- 预算耗尽与截止到达、二月扫描不到 31 日
- SQLite 计划版本追加、旧预览固化、**重新打开数据库（模拟重启）后历史仍可查询**
- HTTP API 全链路与 400/404/409 错误码

## 设计取舍与限制

- 逐分钟枚举，刻意不做日历跳跃优化；长间隔表达式（如闰年）需要显式调大 `budgetMinutes`。
- 仅解释时间，不执行命令、不管理任务、不做权限隔离。
- `node:sqlite` 目前仍为实验特性，启动会打印 ExperimentalWarning，功能在本机 Node v25 验证通过。
- 服务绑定 `127.0.0.1`，仅供本地使用，未包含鉴权与 HTTPS。
