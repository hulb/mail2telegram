# Telegram `/new_route` 命令 — 通过 Bot 创建 Cloudflare Email Routing 规则

日期：2026-08-01
状态：已确认（用户已批准交互流程，命令名定为 `/new_route`）

## 目标

在 mail2telegram 的 Telegram bot 中新增 `/new_route` 命令：用户发送邮箱前缀（如 `admin`），通过 inline keyboard 按钮依次选择域名（含子域名）和转发目标（已验证 email 或 worker），bot 调用 Cloudflare API 创建对应的 Email Routing custom address 规则。

## 关键调研结论（Cloudflare API）

- 创建规则：`POST /zones/{zone_id}/email/routing/rules`，body 含 `matchers: [{type:"literal", field:"to", value:"admin@test.com"}]` 和 `actions: [{type:"forward"|"worker", value:[...]}]`；`enabled` 默认 `true`。
  - `forward` 的 value 必须是**已验证**的 destination address。
  - `worker` 的 value 是 **worker script name**，同账号即可，无需预先配置绑定；worker 需实现 `email()` handler。
- 列出 zone：`GET /zones`，zone-scoped token 只返回被授权的 zone；返回项含 `account.id`（可由此推导 account_id，无需额外配置）。
- 子域名邮箱：支持，规则建在**父 zone** 的 rules 端点，matcher 写完整子域名地址。**无 API 可枚举 zone 下已启用 Email Routing 的子域名**；采用 MX 记录探测：`GET /zones/{zone_id}/dns_records?type=MX`，content 指向 `route1/2/3.mx.cloudflare.net` 的记录名（apex 或子域名）即为可创建邮箱的域名。
- 已验证转发地址：`GET /accounts/{account_id}/email/routing/addresses?verified=true`（账号级，`verified != null` 才可用于 forward）。
- Workers 列表：`GET /accounts/{account_id}/workers/scripts`，脚本名字段为 `id`。
- 重复创建规则的错误码官方未文档化 → 创建前先 list rules 查重。
- 限制：每 zone 200 条 rules、每账号 200 个 destination addresses；API 全局限流 1200 req / 5 min。
- 认证头：`Authorization: Bearer <CF_API_TOKEN>`。

### 所需 token 权限

| 权限（官方名） | 级别 | 用途 |
|---|---|---|
| Zone \| Zone \| Read | Zone（按 zone 限定） | GET /zones |
| Zone \| DNS \| Read | Zone（按 zone 限定） | MX 探测子域名 |
| Zone \| Email Routing Rules \| Edit | Zone（按 zone 限定） | list/create rules |
| Account \| Email Routing Addresses \| Read | Account | 列出已验证转发地址 |
| Account \| Workers Scripts \| Read | Account | 列出 workers |

域名范围限制方案（已与用户确认）：**token 按 zone 限定范围 + MX 记录探测子域名**，不在 wrangler 中维护域名白名单。

## 交互流程

```
用户: /new_route admin        （或 /new_route 不带参数 → bot 提示回复一条前缀消息）
bot : 选择要在哪个域名下创建 admin@❓
      [test.com] [sub.test.com] [foo.com]      ← GET /zones + MX 探测
用户: (点击 sub.test.com)
bot : 创建 admin@sub.test.com，选择转发目标：
      [📧 alice@gmail.com] [📧 bob@outlook.com]  ← 已验证 destination addresses
      [⚙️ mail2telegram] [⚙️ email-parser]       ← workers scripts
用户: (点击 alice@gmail.com)
bot : ✅ Created admin@sub.test.com → forward to alice@gmail.com
```

- 每步用 `editMessageText` 更新同一条消息（沿用项目现有 callback 模式）。
- 前缀校验：`/^[a-z0-9][a-z0-9._-]{0,62}$/i`（首字符为字母或数字，总长 ≤ 63），拼上域名后总长 ≤ 90 字符。
- 目标按钮为统一列表（📧 前缀 = 转发到 email，⚙️ 前缀 = 发送到 worker），每页 10 个，超出加翻页按钮。
- 未配置 `CF_API_TOKEN` 时命令回复未启用提示。

## 架构与组件

### 新模块 `src/cloudflare/index.ts`

纯函数 CF API client（fetch + Bearer token），每个函数返回解析后的 `result`，出错抛出含 `errors[].message` 的 Error：

- `listZones(token)` → `{ id, name, accountId }[]`（处理分页）
- `listEmailDomains(token, zone)` → zone 内可创建邮箱的域名列表（apex + MX 探测出的子域名）
- `listDestinationAddresses(token, accountId)` → 已验证 email 列表（分页，`verified=true`）
- `listWorkers(token, accountId)` → script name 列表
- `listRules(token, zoneId)` → 现有规则（查重用）
- `createRule(token, zoneId, address, action)` → 创建规则；`action = { type: 'forward'|'worker', value: string }`

### Telegram 侧改动（`src/telegram/telegram.ts`、`src/telegram/const.ts`）

- `const.ts`：`telegramCommands` 增加 `new_route`。
- `telegram.ts`：
  - `handlers` 增加 `new_route` 命令处理器。
  - **权限检查**：该命令及 `nr:` 前缀的 callback 仅响应 `TELEGRAM_ID`（逗号分隔）内的 chat id，其他用户静默忽略。
  - 多步状态存 KV（复用 `DB` binding）：`/new_route` 时生成 8 位 hex stateId，存 `{ prefix, domains: [{domain, zoneId}] }`，TTL 1 小时；选定域名后更新 state 存目标候选列表。
  - callback_data 协议（≤64 字节）：`nr:d:{stateId}:{idx}` 选域名、`nr:t:{stateId}:{idx}` 选目标、`nr:g:{stateId}:{page}` 翻页。`idx` 是 state 中数组下标，避免超长。
  - 域名列表（zones + MX 探测结果）缓存于 KV `new_route:domains`，TTL 1 小时，避免每次命令重复探测。

### 配置（`src/types/index.ts`、`wrangler.example.jsonc`）

- 新增环境变量 `CF_API_TOKEN`（secret，`wrangler secret put CF_API_TOKEN`；example 配置中注释说明）。
- 不需要 `CF_ACCOUNT_ID`（从 zones 响应推导）。

## 错误处理

- 前缀非法 / 超长 → 回复错误提示，不建 state。
- CF API 返回 `success:false` → 展示 `errors[].message`。
- 目标地址已存在规则 → 创建前 list rules 查重，提示已存在。
- 无已验证地址或无 worker → 对应分组不渲染；两者皆无 → 提示无可选目标。
- callback state 过期/不存在 → `answerCallbackQuery` alert "Session expired, run /new_route again"。
- 域名探测结果为空 → 提示无可用域名（检查 token 权限/范围）。

## 测试

- 测试入口 `src/test.ts`（tsx），参照 `src/mail/parse.test.ts` 风格新增 `src/cloudflare/index.test.ts`：
  - 前缀校验函数的正反例
  - MX 记录过滤逻辑（只认 `route*.mx.cloudflare.net`）
  - callback_data 编码/解析（含 64 字节约束）
- `npm run lint` 通过；`npm run build`（esbuild）通过。
- 手动验证：`wrangler dev --remote` + 真实 bot 走一遍完整流程。

## 不做的事（YAGNI）

- 不维护 wrangler 域名白名单（用 token 范围 + MX 探测代替）。
- 不创建/验证新的 destination address（需在 dashboard 完成验证）。
- 不删除/修改已有规则，不管理 catch-all。
- 不支持一条规则多 action。
