# Telegram `/list_routes` 命令 — 列出并删除 Email Routing 规则

日期：2026-08-01
状态：已确认（用户批准设计：先选域名再列规则、两步确认删除）

## 目标

在 mail2telegram 的 Telegram bot 中新增 `/list_routes` 命令：用户通过 inline keyboard 选择域名，bot 列出该 zone 下所有 Email Routing 规则（按钮交互、分页），点击规则后两步确认删除。复用 `/new_route` 的域名探测（loadDomains + KV 缓存）、权限检查（isAllowedChat）与 KV state 模式。

## 交互流程

```
用户: /list_routes
bot : 选择域名:
      [xxx.domain.com] [domain1.com] ...        ← loadDomains 探测（带缓存）
用户: (点击域名)
bot : 📧 admin@xxx.domain.com → alice@gmail.com  ← 每行一条规则，可点击
      📧 info@xxx.domain.com → my-worker
      [⬅️ Prev] [Next ➡️]                        ← 10 条/页
用户: (点击某条规则)
bot : 🗑 Delete admin@xxx.domain.com → alice@gmail.com ?
      [✅ Confirm] [❌ Cancel]                   ← 两步确认
用户: (点击 Confirm)
bot : ✅ Deleted. 剩余规则重新列出（可继续删）
```

- 每步 `editMessageText` 更新同一条消息。
- 权限：命令与 `lr:` callback 仅响应 `TELEGRAM_ID`（逗号分隔）内的 chat id，其他用户静默忽略。
- 规则按所选域名过滤（`rule.address` 以 `@{domain}` 结尾，大小写不敏感）：选 apex 只显示该 apex 规则，选子域名只显示该子域名规则。
- `source === 'wrangler'` 的规则**显示但禁删**：按钮带 ⚠️ 标记，点击提示 "Managed by wrangler - edit it via wrangler.jsonc instead."（wrangler 托管规则不能用 API 删除）。
- 无规则 → 消息 "No rules found for {domain}."。

## 架构与组件

### CF API 新增（`src/cloudflare/index.ts`）

- `interface RoutingRule { id: string; address: string; actionLabel: string; source: string }`
- `listRoutingRules(token: string, zoneId: string): Promise<RoutingRule[]>` —— `GET /zones/{zone_id}/email/routing/rules`（分页），把 matchers[0]（literal 的 value）与 actions[0]（forward → `→ {email}`；worker → `→ worker {name}`；drop → `→ drop`）拼成 `address` / `actionLabel`；`source` 原样保留。`matchers` 为空或非 literal 的规则跳过。
- `deleteRule(token: string, zoneId: string, ruleId: string): Promise<void>` —— `DELETE /zones/{zone_id}/email/routing/rules/{rule_id}`，复用现有非 ok 响应抛错逻辑（含 CF 错误体透传）。

### 新文件 `src/telegram/list_routes.ts`

- 纯函数（可测）：
  - `filterRulesByDomain(rules, domain)` —— 保留 `rule.address` 以 `@{domain}` 结尾的规则（大小写不敏感）；选择 apex 或子域名时列表按此过滤，删除后重拉同样过滤。
  - `parseListRoutesCallbackData(data: string): ListRoutesCallback | null`
    - `type ListRoutesCallback = { act: 'd'; stateId: string; index: number } | { act: 'p' | 'z'; stateId: string; page: number } | { act: 'c' | 'x'; stateId: string; ruleIndex: number }`
    - 协议：`lr:d:{stateId}:{idx}`、`lr:p:{stateId}:{page}`、`lr:c:{stateId}:{ruleIdx}`、`lr:x:{stateId}:{ruleIdx}`、`lr:z:{stateId}:0`
    - 校验：stateId 小写 `[a-z0-9]+`，数字段 `\d+`，全部 ≤ 64 字节
  - `buildRuleLabel(rule: RoutingRule): string` —— `📧 admin@xxx.domain.com → alice@gmail.com` 格式（forward 用 📧、worker 用 ⚙️、drop 用 🚫，前缀与 action 对应）
  - `buildDomainKeyboard(domains, stateId)` / `buildRulesKeyboard(rules, stateId, page)` / `buildConfirmKeyboard(stateId, ruleIndex)` —— 分页 10 条/页，导航按钮同 `new_route` 模式（Prev/Next）
- handlers：
  - `handleListRoutesCommand(message, env): Promise<Response>`
  - `handleListRoutesCallback(callback, env): Promise<void>`
- KV state：`list_routes:state:{id}`（8 位 hex stateId，TTL 3600），结构 `ListRoutesState { chatId: number; domains: NewRouteDomainOption[]; domain?: string; zoneId?: string; rules?: RoutingRule[] }`

### 复用与导出（`src/telegram/new_route.ts`）

- `export function isAllowedChat(env, chatId): boolean`（现为内部函数，改为导出）
- `export async function loadDomains(env): Promise<{ accountId; domains }>`（现为内部函数，改为导出，供 list_routes 复用）

### 接线（`src/telegram/telegram.ts`、`src/telegram/const.ts`）

- `telegramCommandHandler` 的 handlers 加 `list_routes`（错误兜底同 `new_route` 模式）
- `telegramCallbackHandler` 在 `act === 'nr'` 分支旁加 `act === 'lr'` 分支（try/catch + answerCallbackQuery 报错）
- `telegramCommands` 数组追加 `{ command: 'list_routes', description: '/list_routes - List and delete email routes' }`

## callback 状态机

```
lr:d:{sid}:{idx}  → loadDomains 的缓存拿 domains[idx] → 查 listRoutingRules → 存 state(domain/zoneId/rules) → 编辑为规则列表页0
lr:p:{sid}:{page} → 用 state.rules 渲染第 page 页（翻页/取消返回）
lr:c:{sid}:{idx}  → 编辑为确认视图（Confirm/Cancel），ruleIndex 存于 callback
lr:x:{sid}:{idx}  → deleteRule → 删除成功编辑 ✅ + 重新 listRoutingRules 渲染剩余规则页0；失败弹 alert（CF 错误体）
lr:z:{sid}:0     → 编辑回规则列表页0
```

## 错误处理

- `CF_API_TOKEN` 未配置 → 命令回复 "Cloudflare API is not enabled (CF_API_TOKEN missing)."
- 域名列表为空 → 同 `/new_route` 提示。
- 删除失败（404/竞态/权限）→ `answerCallbackQuery(show_alert)` 显示 CF 错误体。
- state 过期/chatId 不匹配 → alert "Session expired, run /list_routes again."
- 删除成功后重新拉取规则列表，删除的规则自然消失；若删完为空 → "No rules found for {domain}."

## 测试

- 纯函数测试新增到 `src/telegram/list_routes.test.ts`：callback 解析正反例（含 64 字节约束）、buildRuleLabel 三种 action、分页键盘三态（首页/中间/末页）、确认键盘结构。
- 现有 7 个测试保持通过；`npm run lint` / `npx tsc --noEmit` / `npm run build` 全绿。

## 不做的事（YAGNI）

- 不做多选批量删除、不做规则编辑、不管理 catch-all。`source === 'wrangler'` 的规则只读展示（带 ⚠️ 标记），不提供删除入口。
