# Telegram `/list_routes` 命令实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/list_routes` 命令：选择域名 → 按钮列出该 zone 的 Email Routing 规则（分页）→ 两步确认删除。

**Architecture:** 复用 `/new_route` 的域名探测（`loadDomains` + KV 缓存）、权限检查（`isAllowedChat`）与 KV state 模式。`src/cloudflare/index.ts` 新增规则列表/删除 API；新文件 `src/telegram/list_routes.ts` 承载命令、callback 状态机与纯函数；`telegram.ts`/`const.ts` 接线。

**Tech Stack:** TypeScript on Cloudflare Workers、fetch、KV（`DB` binding）、Telegram Bot API（现有 `createTelegramBotAPI`）、测试 `tsx` + `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-08-01-list-routes-design.md`

## Global Constraints

- 不新增任何 npm 依赖；CF API 调用只用全局 fetch。
- 代码风格：4 空格缩进、单引号、分号（`npm run lint` 必须通过）。
- Bot 消息与注释用英文（与现有代码一致）。
- 测试用 `node:assert/strict`，新测试文件在 `src/test.ts` 注册。
- callback_data ≤ 64 字节，协议前缀 `lr:`（与 `new_route` 的 `nr:` 区分）：`lr:d:{stateId}:{idx}`、`lr:p:{stateId}:{page}`、`lr:c:{stateId}:{ruleIdx}`、`lr:x:{stateId}:{ruleIdx}`、`lr:z:{stateId}:0`。
- stateId 必须为小写 `[a-z0-9]+`（`crypto.randomUUID().replace(/-/g, '').slice(0, 8)`）。
- `source === 'wrangler'` 的规则跳过不显示。
- 每个 Task 末尾的 commit 步骤需用户确认后才执行（不自动 git commit）。

---

### Task 1: Cloudflare API — 规则列表与删除（`src/cloudflare/index.ts`）

**Files:**
- Modify: `src/cloudflare/index.ts`（在 `listRuleAddresses` 之后追加）
- Test: `src/cloudflare/index.test.ts`
- Modify: `src/test.ts`

**Interfaces:**
- Consumes: 现有 `cfFetchAllPages<T>`、`cfErrorMessage`、`CloudflareAPIResponse`、`API_BASE`。
- Produces（Task 2/3 依赖的精确签名）:
  - `interface RoutingRule { id: string; address: string; actionLabel: string; source: string }`
  - `mapRoutingRuleResult(rule: ApiRoutingRule): RoutingRule | null`（纯函数，可测）
  - `listRoutingRules(token: string, zoneId: string): Promise<RoutingRule[]>`
  - `deleteRule(token: string, zoneId: string, ruleId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

在 `src/cloudflare/index.test.ts` 末尾追加：

```ts
import assert from 'node:assert/strict';
import { filterEmailRoutingMXRecords, isValidAddressLength, mapRoutingRuleResult, validateEmailPrefix } from './index';

// ...（保留现有三个测试函数）

function testMapRoutingRuleResult() {
    // forward
    assert.deepEqual(mapRoutingRuleResult({
        id: 'r1',
        matchers: [{ type: 'literal', field: 'to', value: 'a@b.com' }],
        actions: [{ type: 'forward', value: ['x@y.com'] }],
        source: 'api',
    }), { id: 'r1', address: 'a@b.com', actionLabel: '→ x@y.com', source: 'api' });
    // worker
    assert.deepEqual(mapRoutingRuleResult({
        id: 'r2',
        matchers: [{ type: 'literal', field: 'to', value: 'info@b.com' }],
        actions: [{ type: 'worker', value: ['my-worker'] }],
        source: 'wrangler',
    }), { id: 'r2', address: 'info@b.com', actionLabel: '→ worker my-worker', source: 'wrangler' });
    // drop（value 省略）
    assert.deepEqual(mapRoutingRuleResult({
        id: 'r3',
        matchers: [{ type: 'literal', field: 'to', value: 'drop@b.com' }],
        actions: [{ type: 'drop' }],
    }), { id: 'r3', address: 'drop@b.com', actionLabel: '→ drop', source: 'api' });
    // 无 literal matcher（catch-all 等）→ null
    assert.equal(mapRoutingRuleResult({ id: 'r4', matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['x@y.com'] }] }), null);
    // 无 actions → null
    assert.equal(mapRoutingRuleResult({ id: 'r5', matchers: [{ type: 'literal', field: 'to', value: 'a@b.com' }], actions: [] }), null);
    console.log('testMapRoutingRuleResult ok');
}

testValidateEmailPrefix();
testIsValidAddressLength();
testFilterEmailRoutingMXRecords();
testFilterEmailRoutingMXRecordsByMeta();
testMapRoutingRuleResult();
```

修改 `src/test.ts` 注册测试（已有 `./cloudflare/index.test` 与 `./telegram/new_route.test`，无需新增——本 Task 只改 cloudflare 测试文件内部）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cloudflare/index.test.ts`
Expected: 报错 `mapRoutingRuleResult is not a function`

- [ ] **Step 3: Write minimal implementation**

在 `src/cloudflare/index.ts` 的 `listRuleAddresses` 之后追加：

```ts
export interface RoutingRule {
    id: string;
    address: string;
    actionLabel: string;
    source: string;
}

interface ApiRoutingRule {
    id: string;
    matchers: Array<{ type: string; value?: string }>;
    actions: Array<{ type: string; value?: string[] }>;
    source?: string;
}

export function mapRoutingRuleResult(rule: ApiRoutingRule): RoutingRule | null {
    const matcher = rule.matchers.find(m => m.type === 'literal');
    const action = rule.actions?.[0];
    if (!matcher?.value || !action) {
        return null;
    }
    const actionValue = action.value?.[0] || '';
    const actionLabel = action.type === 'forward'
        ? `→ ${actionValue}`
        : action.type === 'worker'
            ? `→ worker ${actionValue}`
            : '→ drop';
    return {
        id: rule.id,
        address: matcher.value,
        actionLabel,
        source: rule.source || 'api',
    };
}

export async function listRoutingRules(token: string, zoneId: string): Promise<RoutingRule[]> {
    const rules = await cfFetchAllPages<ApiRoutingRule>(token, `/zones/${zoneId}/email/routing/rules`);
    return rules.map(mapRoutingRuleResult).filter((r): r is RoutingRule => r !== null);
}

export async function deleteRule(token: string, zoneId: string, ruleId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/zones/${zoneId}/email/routing/rules/${ruleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null) as CloudflareAPIResponse<unknown> | null;
    if (!res.ok || !data || !data.success) {
        throw new Error(cfErrorMessage(res, data));
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cloudflare/index.test.ts`
Expected: 五行 `... ok`，无断言错误

- [ ] **Step 5: Lint + Commit**

```bash
npm run lint
git add src/cloudflare/index.ts src/cloudflare/index.test.ts
git commit -m "feat(cloudflare): add listRoutingRules and deleteRule"
```

---

### Task 2: `/list_routes` 纯函数（callback 协议、键盘构建）

**Files:**
- Create: `src/telegram/list_routes.ts`（本任务只写纯函数与类型）
- Test: `src/telegram/list_routes.test.ts`
- Modify: `src/test.ts`

**Interfaces:**
- Consumes: `RoutingRule`（Task 1）；`NewRouteDomainOption`（`./new_route`）；`Telegram.InlineKeyboardMarkup`/`InlineKeyboardButton`（`telegram-bot-api-types`）。
- Produces（Task 3 依赖的精确签名）:
  - `interface ListRoutesState { chatId: number; domains: NewRouteDomainOption[]; domain?: string; zoneId?: string; rules?: RoutingRule[] }`
  - `type ListRoutesCallback = { act: 'd'; stateId: string; index: number } | { act: 'p' | 'z'; stateId: string; page: number } | { act: 'c' | 'x'; stateId: string; ruleIndex: number }`
  - `RULES_PER_PAGE: 10`
  - `listRoutesStateKey(id: string): string`
  - `parseListRoutesCallbackData(data: string): ListRoutesCallback | null`
  - `buildRuleLabel(rule: RoutingRule): string`
  - `buildListRoutesDomainKeyboard(domains: NewRouteDomainOption[], stateId: string): Telegram.InlineKeyboardMarkup`
  - `buildRulesKeyboard(rules: RoutingRule[], stateId: string, page: number): Telegram.InlineKeyboardMarkup`
  - `buildConfirmKeyboard(stateId: string, ruleIndex: number): Telegram.InlineKeyboardMarkup`

- [ ] **Step 1: Write the failing test**

创建 `src/telegram/list_routes.test.ts`：

```ts
import assert from 'node:assert/strict';
import type { RoutingRule } from '../cloudflare';
import {
    buildConfirmKeyboard,
    buildListRoutesDomainKeyboard,
    buildRuleLabel,
    buildRulesKeyboard,
    parseListRoutesCallbackData,
    RULES_PER_PAGE,
} from './list_routes';

function testParseListRoutesCallbackData() {
    assert.deepEqual(parseListRoutesCallbackData('lr:d:ab12cd34:0'), { act: 'd', stateId: 'ab12cd34', index: 0 });
    assert.deepEqual(parseListRoutesCallbackData('lr:p:ab12cd34:2'), { act: 'p', stateId: 'ab12cd34', page: 2 });
    assert.deepEqual(parseListRoutesCallbackData('lr:c:ab12cd34:5'), { act: 'c', stateId: 'ab12cd34', ruleIndex: 5 });
    assert.deepEqual(parseListRoutesCallbackData('lr:x:ab12cd34:5'), { act: 'x', stateId: 'ab12cd34', ruleIndex: 5 });
    assert.deepEqual(parseListRoutesCallbackData('lr:z:ab12cd34:0'), { act: 'z', stateId: 'ab12cd34', page: 0 });
    assert.equal(parseListRoutesCallbackData(''), null);
    assert.equal(parseListRoutesCallbackData('lr:x:ab12cd34'), null);
    assert.equal(parseListRoutesCallbackData('lr:x:ab12cd34:x'), null);
    assert.equal(parseListRoutesCallbackData('nr:d:ab12cd34:0'), null);
    assert.equal(parseListRoutesCallbackData('lr:x:AB12CD34:0'), null); // stateId 必须小写
    for (const data of ['lr:d:ab12cd34:0', 'lr:p:ab12cd34:19', 'lr:x:ab12cd34:199']) {
        assert.ok(Buffer.byteLength(data) <= 64, `${data} exceeds 64 bytes`);
    }
    console.log('testParseListRoutesCallbackData ok');
}

function testBuildRuleLabel() {
    const fwd: RoutingRule = { id: 'r1', address: 'a@b.com', actionLabel: '→ x@y.com', source: 'api' };
    const wk: RoutingRule = { id: 'r2', address: 'i@b.com', actionLabel: '→ worker my-worker', source: 'api' };
    const drop: RoutingRule = { id: 'r3', address: 'd@b.com', actionLabel: '→ drop', source: 'api' };
    assert.equal(buildRuleLabel(fwd), '📧 a@b.com → x@y.com');
    assert.equal(buildRuleLabel(wk), '⚙️ i@b.com → worker my-worker');
    assert.equal(buildRuleLabel(drop), '🚫 d@b.com → drop');
    console.log('testBuildRuleLabel ok');
}

function testBuildListRoutesDomainKeyboard() {
    const kb = buildListRoutesDomainKeyboard([
        { domain: 'test.com', zoneId: 'z1' },
        { domain: 'sub.test.com', zoneId: 'z1' },
    ], 'ab12cd34');
    assert.deepEqual(kb.inline_keyboard, [
        [{ text: 'test.com', callback_data: 'lr:d:ab12cd34:0' }],
        [{ text: 'sub.test.com', callback_data: 'lr:d:ab12cd34:1' }],
    ]);
    console.log('testBuildListRoutesDomainKeyboard ok');
}

function testBuildRulesKeyboardPagination() {
    const rules: RoutingRule[] = Array.from({ length: 25 }, (_, i) => ({
        id: `r${i}`,
        address: `a${i}@b.com`,
        actionLabel: '→ x@y.com',
        source: 'api',
    }));

    const page0 = buildRulesKeyboard(rules, 'ab12cd34', 0);
    assert.equal(page0.inline_keyboard.length, RULES_PER_PAGE + 1);
    assert.equal(page0.inline_keyboard[0][0].callback_data, 'lr:c:ab12cd34:0');
    const nav0 = page0.inline_keyboard[RULES_PER_PAGE];
    assert.equal(nav0.length, 1);
    assert.equal(nav0[0].callback_data, 'lr:p:ab12cd34:1');

    const page1 = buildRulesKeyboard(rules, 'ab12cd34', 1);
    assert.equal(page1.inline_keyboard[0][0].callback_data, 'lr:c:ab12cd34:10');
    const nav1 = page1.inline_keyboard[RULES_PER_PAGE];
    assert.equal(nav1.length, 2);
    assert.equal(nav1[0].callback_data, 'lr:p:ab12cd34:0');
    assert.equal(nav1[1].callback_data, 'lr:p:ab12cd34:2');

    const page2 = buildRulesKeyboard(rules, 'ab12cd34', 2);
    assert.equal(page2.inline_keyboard.length, 5 + 1);
    const nav2 = page2.inline_keyboard[5];
    assert.equal(nav2.length, 1);
    assert.equal(nav2[0].callback_data, 'lr:p:ab12cd34:1');

    // 空列表 → 空键盘
    assert.deepEqual(buildRulesKeyboard([], 'ab12cd34', 0).inline_keyboard, []);
    console.log('testBuildRulesKeyboardPagination ok');
}

function testBuildConfirmKeyboard() {
    const kb = buildConfirmKeyboard('ab12cd34', 5);
    assert.deepEqual(kb.inline_keyboard, [
        [{ text: '✅ Confirm', callback_data: 'lr:x:ab12cd34:5' }],
        [{ text: '❌ Cancel', callback_data: 'lr:z:ab12cd34:0' }],
    ]);
    console.log('testBuildConfirmKeyboard ok');
}

testParseListRoutesCallbackData();
testBuildRuleLabel();
testBuildListRoutesDomainKeyboard();
testBuildRulesKeyboardPagination();
testBuildConfirmKeyboard();
```

修改 `src/test.ts`：

```ts
import './mail/parse.test';
import './cloudflare/index.test';
import './telegram/new_route.test';
import './telegram/list_routes.test';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/telegram/list_routes.test.ts`
Expected: 报错 `Cannot find module './list_routes'`

- [ ] **Step 3: Write minimal implementation**

创建 `src/telegram/list_routes.ts`（本任务只包含以下内容）：

```ts
import type * as Telegram from 'telegram-bot-api-types';
import type { RoutingRule } from '../cloudflare';
import type { NewRouteDomainOption } from './new_route';

export interface ListRoutesState {
    chatId: number;
    domains: NewRouteDomainOption[];
    domain?: string;
    zoneId?: string;
    rules?: RoutingRule[];
}

export type ListRoutesCallback =
    | { act: 'd'; stateId: string; index: number }
    | { act: 'p' | 'z'; stateId: string; page: number }
    | { act: 'c' | 'x'; stateId: string; ruleIndex: number };

export const RULES_PER_PAGE = 10;

export function listRoutesStateKey(id: string): string {
    return `list_routes:state:${id}`;
}

export function parseListRoutesCallbackData(data: string): ListRoutesCallback | null {
    const parts = data.split(':');
    if (parts.length !== 4 || parts[0] !== 'lr') {
        return null;
    }
    const [, act, stateId, num] = parts;
    if (!/^[a-z0-9]+$/.test(stateId) || !/^\d+$/.test(num)) {
        return null;
    }
    if (act === 'd') {
        return { act, stateId, index: Number.parseInt(num, 10) };
    }
    if (act === 'p' || act === 'z') {
        return { act, stateId, page: Number.parseInt(num, 10) };
    }
    if (act === 'c' || act === 'x') {
        return { act, stateId, ruleIndex: Number.parseInt(num, 10) };
    }
    return null;
}

export function buildRuleLabel(rule: RoutingRule): string {
    const emoji = rule.actionLabel.startsWith('→ worker')
        ? '⚙️'
        : rule.actionLabel.startsWith('→ drop')
            ? '🚫'
            : '📧';
    return `${emoji} ${rule.address} ${rule.actionLabel}`;
}

export function buildListRoutesDomainKeyboard(domains: NewRouteDomainOption[], stateId: string): Telegram.InlineKeyboardMarkup {
    return {
        inline_keyboard: domains.map((d, i) => [{
            text: d.domain,
            callback_data: `lr:d:${stateId}:${i}`,
        }]),
    };
}

export function buildRulesKeyboard(rules: RoutingRule[], stateId: string, page: number): Telegram.InlineKeyboardMarkup {
    const start = page * RULES_PER_PAGE;
    const keyboard: Telegram.InlineKeyboardButton[][] = rules
        .slice(start, start + RULES_PER_PAGE)
        .map((r, i) => [{
            text: buildRuleLabel(r),
            callback_data: `lr:c:${stateId}:${start + i}`,
        }]);
    const nav: Telegram.InlineKeyboardButton[] = [];
    if (page > 0) {
        nav.push({ text: '⬅️ Prev', callback_data: `lr:p:${stateId}:${page - 1}` });
    }
    if (start + RULES_PER_PAGE < rules.length) {
        nav.push({ text: 'Next ➡️', callback_data: `lr:p:${stateId}:${page + 1}` });
    }
    if (nav.length > 0) {
        keyboard.push(nav);
    }
    return { inline_keyboard: keyboard };
}

export function buildConfirmKeyboard(stateId: string, ruleIndex: number): Telegram.InlineKeyboardMarkup {
    return {
        inline_keyboard: [
            [{ text: '✅ Confirm', callback_data: `lr:x:${stateId}:${ruleIndex}` }],
            [{ text: '❌ Cancel', callback_data: `lr:z:${stateId}:0` }],
        ],
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/telegram/list_routes.test.ts`
Expected: 五行 `... ok`，无断言错误

- [ ] **Step 5: Lint + Commit**

```bash
npm run lint
git add src/telegram/list_routes.ts src/telegram/list_routes.test.ts src/test.ts
git commit -m "feat(list_routes): add callback protocol and keyboard builders"
```

---

### Task 3: handlers 与接线

**Files:**
- Modify: `src/telegram/new_route.ts`（导出 `isAllowedChat`、`loadDomains`）
- Modify: `src/telegram/list_routes.ts`（追加 handlers）
- Modify: `src/telegram/telegram.ts`
- Modify: `src/telegram/const.ts`

**Interfaces:**
- Consumes: Task 1 的 `listRoutingRules`/`deleteRule`/`RoutingRule`；Task 2 的全部纯函数与 `ListRoutesState`；`new_route.ts` 的 `isAllowedChat`/`loadDomains`/`NewRouteDomainOption`/`STATE_TTL`；现有 `createTelegramBotAPI`。
- Produces（接线依赖的签名）:
  - `handleListRoutesCommand(message: Telegram.Message, env: Environment): Promise<Response>`
  - `handleListRoutesCallback(callback: Telegram.CallbackQuery, env: Environment): Promise<void>`

- [ ] **Step 1: 导出 `new_route.ts` 的复用函数**

修改 `src/telegram/new_route.ts`：
- `function isAllowedChat(` → `export function isAllowedChat(`
- `async function loadDomains(` → `export async function loadDomains(`

- [ ] **Step 2: 实现 handlers**

在 `src/telegram/list_routes.ts` 末尾追加。文件顶部 import 块替换为：

```ts
import type * as Telegram from 'telegram-bot-api-types';
import type { Environment } from '../types';
import { deleteRule, listRoutingRules } from '../cloudflare';
import type { RoutingRule } from '../cloudflare';
import type { NewRouteDomainOption } from './new_route';
import { isAllowedChat, loadDomains, STATE_TTL } from './new_route';
import { createTelegramBotAPI } from './api';
```

追加的代码：

```ts
async function loadListRoutesState(env: Environment, stateId: string): Promise<ListRoutesState | null> {
    const raw = await env.DB.get(listRoutesStateKey(stateId));
    return raw ? JSON.parse(raw) : null;
}

export async function handleListRoutesCommand(message: Telegram.Message, env: Environment): Promise<Response> {
    const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
    const chatId = message.chat.id;
    if (!isAllowedChat(env, chatId)) {
        return new Response(null, { status: 200 });
    }
    if (!env.CF_API_TOKEN) {
        return api.sendMessage({ chat_id: chatId, text: 'Cloudflare API is not enabled (CF_API_TOKEN missing).' });
    }
    const { domains } = await loadDomains(env);
    if (domains.length === 0) {
        return api.sendMessage({ chat_id: chatId, text: 'No email routing domains found. Enable Email Routing on your zone first, and check CF_API_TOKEN permissions (Zone:Read, DNS:Read).' });
    }
    const stateId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const state: ListRoutesState = { chatId, domains };
    await env.DB.put(listRoutesStateKey(stateId), JSON.stringify(state), { expirationTtl: STATE_TTL });
    return api.sendMessage({
        chat_id: chatId,
        text: 'Choose a domain to list routes:',
        reply_markup: buildListRoutesDomainKeyboard(domains, stateId),
    });
}

export async function handleListRoutesCallback(callback: Telegram.CallbackQuery, env: Environment): Promise<void> {
    const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const parsed = parseListRoutesCallbackData(callback.data || '');
    if (!parsed || !chatId || !messageId) {
        return;
    }
    if (!isAllowedChat(env, chatId) || !env.CF_API_TOKEN) {
        await api.answerCallbackQuery({ callback_query_id: callback.id });
        return;
    }
    const alert = (text: string) => api.answerCallbackQuery({
        callback_query_id: callback.id,
        text,
        show_alert: true,
    });
    const ack = () => api.answerCallbackQuery({ callback_query_id: callback.id });

    const state = await loadListRoutesState(env, parsed.stateId);
    if (!state || state.chatId !== chatId) {
        await alert('Session expired, run /list_routes again.');
        return;
    }
    const token = env.CF_API_TOKEN;

    if (parsed.act === 'd') {
        const option = state.domains[parsed.index];
        if (!option) {
            await alert('Invalid option.');
            return;
        }
        const rules = (await listRoutingRules(token, option.zoneId)).filter(r => r.source !== 'wrangler');
        state.domain = option.domain;
        state.zoneId = option.zoneId;
        state.rules = rules;
        await env.DB.put(listRoutesStateKey(parsed.stateId), JSON.stringify(state), { expirationTtl: STATE_TTL });
        const text = rules.length === 0 ? `No rules found for ${option.domain}.` : `Routes for ${option.domain}:`;
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text,
            reply_markup: buildRulesKeyboard(rules, parsed.stateId, 0),
        });
        await ack();
        return;
    }

    if (parsed.act === 'p' || parsed.act === 'z') {
        if (!state.rules || !state.domain) {
            await alert('Session expired, run /list_routes again.');
            return;
        }
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `Routes for ${state.domain}:`,
            reply_markup: buildRulesKeyboard(state.rules, parsed.stateId, parsed.act === 'z' ? 0 : parsed.page),
        });
        await ack();
        return;
    }

    if (parsed.act === 'c') {
        const rule = state.rules?.[parsed.ruleIndex];
        if (!rule || !state.domain) {
            await alert('Invalid option.');
            return;
        }
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `🗑 Delete ${rule.address} ${rule.actionLabel} ?`,
            reply_markup: buildConfirmKeyboard(parsed.stateId, parsed.ruleIndex),
        });
        await ack();
        return;
    }

    // parsed.act === 'x'
    const rule = state.rules?.[parsed.ruleIndex];
    if (!rule || !state.zoneId || !state.domain) {
        await alert('Invalid option.');
        return;
    }
    await deleteRule(token, state.zoneId, rule.id);
    const rules = (await listRoutingRules(token, state.zoneId)).filter(r => r.source !== 'wrangler');
    state.rules = rules;
    await env.DB.put(listRoutesStateKey(parsed.stateId), JSON.stringify(state), { expirationTtl: STATE_TTL });
    const text = rules.length === 0
        ? `✅ Deleted ${rule.address}. No rules left for ${state.domain}.`
        : `✅ Deleted ${rule.address}. Remaining rules for ${state.domain}:`;
    await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: buildRulesKeyboard(rules, parsed.stateId, 0),
    });
    await ack();
}
```

注意：确认文案用纯文本 `🗑 Delete ${rule.address} ${rule.actionLabel} ?`（与 spec 交互文案一致，不带 emoji 前缀）。

- [ ] **Step 3: 接线 `telegram.ts`**

1) 顶部 import 追加：

```ts
import { handleListRoutesCallback, handleListRoutesCommand } from './list_routes';
```

2) `telegramCommandHandler` 的 handlers 对象追加（与 `new_route` 相同的错误兜底模式）：

```ts
        list_routes: async (msg: Telegram.Message): Promise<Response> => {
            try {
                return await handleListRoutesCommand(msg, env);
            } catch (e) {
                logTelegramError('command.list_routes.error', e, { command, chatId: msg.chat.id, messageId: msg.message_id });
                return await createTelegramBotAPI(TELEGRAM_TOKEN).sendMessage({
                    chat_id: msg.chat.id,
                    text: (e as Error).message,
                });
            }
        },
```

3) `telegramCallbackHandler` 中，在 `if (act === 'nr') { ... }` 分支之后追加：

```ts
    if (act === 'lr') {
        try {
            await handleListRoutesCallback(callback, env);
        } catch (e) {
            logTelegramError('callback.list_routes.error', e, { data, chatId, messageId });
            const response = await api.answerCallbackQuery({
                callback_query_id: callbackId,
                text: (e as Error).message,
                show_alert: true,
            });
            await logTelegramResponse('answerCallbackQuery', response);
        }
        return;
    }
```

- [ ] **Step 4: 注册命令**

修改 `src/telegram/const.ts`，`telegramCommands` 末尾追加：

```ts
    {
        command: 'list_routes',
        description: '/list_routes - List and delete email routes',
    },
```

- [ ] **Step 5: 全量验证**

```bash
npx tsc --noEmit
npm run lint
npm run build
npx tsx src/cloudflare/index.test.ts
npx tsx src/telegram/new_route.test.ts
npx tsx src/telegram/list_routes.test.ts
```

Expected: 全部通过，无错误。

- [ ] **Step 6: Commit**

```bash
git add src/telegram/new_route.ts src/telegram/list_routes.ts src/telegram/telegram.ts src/telegram/const.ts build/index.js
git commit -m "feat: wire /list_routes command into telegram bot"
```

- [ ] **Step 7: 手动验证（需要真实 token 与 bot，用户执行）**

1. `npm run pub` 部署后重新调用 `https://{DOMAIN}/init` 注册新命令
2. 发 `/list_routes` → 选域名 → 看到规则列表（含 `source === 'wrangler'` 之外的规则）
3. 点规则 → Confirm → 规则删除并在剩余列表中消失；dashboard Email Routing → Rules 确认删除生效
