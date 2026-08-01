# Telegram `/new_route` 命令实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mail2telegram 的 Telegram bot 中新增 `/new_route` 命令，通过 inline keyboard 选择域名与转发目标，调用 Cloudflare API 创建 Email Routing 规则。

**Architecture:** 新增 `src/cloudflare/index.ts`（纯 fetch 的 CF API client + 纯函数工具）和 `src/telegram/new_route.ts`（命令/回调处理 + KV 多步状态 + 纯函数 keyboard 构建器），在现有 `src/telegram/telegram.ts` 中接线。域名选项来自 zone-scoped token 的 `GET /zones` + MX 记录探测子域名。

**Tech Stack:** TypeScript on Cloudflare Workers、fetch（无新依赖）、KV（现有 `DB` binding）、Telegram Bot API（现有 `createTelegramBotAPI`）、测试用 `tsx` + `node:assert/strict`（入口 `src/test.ts`）。

**Spec:** `docs/superpowers/specs/2026-08-01-telegram-new-route-command-design.md`

## Global Constraints

- 不新增任何 npm 依赖；CF API 调用只用全局 `fetch`。
- 代码风格遵循现有项目：4 空格缩进、单引号、分号（`npm run lint` 必须通过）。
- Bot 消息与代码注释用英文（与现有代码一致）。
- 测试运行方式：`npm test`（即 `tsx src/test.ts`），断言用 `node:assert/strict`，新测试文件要在 `src/test.ts` 注册 import。
- callback_data 必须 ≤ 64 字节（Telegram 限制），协议：`nr:d:{stateId}:{idx}`、`nr:t:{stateId}:{idx}`、`nr:g:{stateId}:{page}`。
- 每个 Task 末尾的 commit 步骤需要用户确认后再执行（不自动 git commit）。

---

### Task 1: Cloudflare API client（`src/cloudflare/index.ts`）

**Files:**
- Create: `src/cloudflare/index.ts`
- Test: `src/cloudflare/index.test.ts`
- Modify: `src/test.ts`

**Interfaces:**
- Consumes: 无（只用全局 fetch）。
- Produces（后续 Task 依赖的精确签名）:
  - `interface CloudflareZone { id: string; name: string; accountId: string }`
  - `interface CloudflareRuleAction { type: 'forward' | 'worker'; value: string }`
  - `validateEmailPrefix(prefix: string): boolean`
  - `isValidAddressLength(address: string): boolean`
  - `filterEmailRoutingMXRecords(records: Array<{ name: string; content: string }>): string[]`
  - `listZones(token: string): Promise<CloudflareZone[]>`
  - `listEmailDomains(token: string, zone: CloudflareZone): Promise<string[]>`
  - `listDestinationAddresses(token: string, accountId: string): Promise<string[]>`
  - `listWorkers(token: string, accountId: string): Promise<string[]>`
  - `listRuleAddresses(token: string, zoneId: string): Promise<string[]>`
  - `createRule(token: string, zoneId: string, address: string, action: CloudflareRuleAction): Promise<void>`

- [ ] **Step 1: Write the failing test**

创建 `src/cloudflare/index.test.ts`：

```ts
import assert from 'node:assert/strict';
import { filterEmailRoutingMXRecords, isValidAddressLength, validateEmailPrefix } from './index';

function testValidateEmailPrefix() {
    assert.equal(validateEmailPrefix('admin'), true);
    assert.equal(validateEmailPrefix('a.b_c-d'), true);
    assert.equal(validateEmailPrefix('A1'), true);
    assert.equal(validateEmailPrefix(''), false);
    assert.equal(validateEmailPrefix('-bad'), false);
    assert.equal(validateEmailPrefix('.bad'), false);
    assert.equal(validateEmailPrefix('a b'), false);
    assert.equal(validateEmailPrefix('a@b'), false);
    assert.equal(validateEmailPrefix('x'.repeat(64)), false);
    console.log('testValidateEmailPrefix ok');
}

function testIsValidAddressLength() {
    assert.equal(isValidAddressLength('a@b.co'), true);
    assert.equal(isValidAddressLength(`${'a'.repeat(80)}@test.com`), true);
    assert.equal(isValidAddressLength(`${'a'.repeat(90)}@test.com`), false);
    console.log('testIsValidAddressLength ok');
}

function testFilterEmailRoutingMXRecords() {
    const records = [
        { name: 'test.com', content: 'route1.mx.cloudflare.net' },
        { name: 'test.com', content: 'route2.mx.cloudflare.net' },
        { name: 'sub.test.com', content: 'route3.mx.cloudflare.net.' },
        { name: 'other.test.com', content: 'mx.google.com' },
        { name: 'test.com', content: 'route1.mx.cloudflare.net' },
    ];
    assert.deepEqual(filterEmailRoutingMXRecords(records), ['sub.test.com', 'test.com']);
    assert.deepEqual(filterEmailRoutingMXRecords([]), []);
    console.log('testFilterEmailRoutingMXRecords ok');
}

testValidateEmailPrefix();
testIsValidAddressLength();
testFilterEmailRoutingMXRecords();
```

修改 `src/test.ts` 注册测试：

```ts
import './mail/parse.test';
import './cloudflare/index.test';
```

注意：`src/mail/parse.test.ts` 依赖 `example/nodemailer.eml`，若本地不存在该文件会导致已有用例失败——与本任务无关，只关注新用例输出。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cloudflare/index.test.ts`
Expected: 报错 `Cannot find module './index'`（文件尚未创建）

- [ ] **Step 3: Write minimal implementation**

创建 `src/cloudflare/index.ts`：

```ts
export interface CloudflareZone {
    id: string;
    name: string;
    accountId: string;
}

export interface CloudflareRuleAction {
    type: 'forward' | 'worker';
    value: string;
}

interface CloudflareAPIResponse<T> {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
    result: T;
    result_info?: {
        page: number;
        total_pages: number;
    };
}

const API_BASE = 'https://api.cloudflare.com/client/v4';
const EMAIL_ROUTING_MX_PATTERN = /^route\d+\.mx\.cloudflare\.net\.?$/;

export function validateEmailPrefix(prefix: string): boolean {
    return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(prefix);
}

export function isValidAddressLength(address: string): boolean {
    return address.length <= 90;
}

export function filterEmailRoutingMXRecords(records: Array<{ name: string; content: string }>): string[] {
    const domains = new Set<string>();
    for (const record of records) {
        if (EMAIL_ROUTING_MX_PATTERN.test(record.content)) {
            domains.add(record.name);
        }
    }
    return [...domains].sort();
}

async function cfFetchAllPages<T>(token: string, path: string): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (;;) {
        const sep = path.includes('?') ? '&' : '?';
        const res = await fetch(`${API_BASE}${path}${sep}page=${page}&per_page=50`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json() as CloudflareAPIResponse<T[]>;
        if (!data.success) {
            throw new Error(data.errors?.map(e => e.message).join('; ') || `Cloudflare API error (HTTP ${res.status})`);
        }
        all.push(...data.result);
        if (page >= (data.result_info?.total_pages ?? 1)) {
            return all;
        }
        page++;
    }
}

interface ZoneResult {
    id: string;
    name: string;
    account: { id: string };
}

export async function listZones(token: string): Promise<CloudflareZone[]> {
    const zones = await cfFetchAllPages<ZoneResult>(token, '/zones?status=active');
    return zones.map(z => ({ id: z.id, name: z.name, accountId: z.account.id }));
}

export async function listEmailDomains(token: string, zone: CloudflareZone): Promise<string[]> {
    const records = await cfFetchAllPages<{ name: string; content: string }>(token, `/zones/${zone.id}/dns_records?type=MX`);
    return filterEmailRoutingMXRecords(records);
}

interface DestinationAddressResult {
    email: string;
    verified: string | null;
}

export async function listDestinationAddresses(token: string, accountId: string): Promise<string[]> {
    const addresses = await cfFetchAllPages<DestinationAddressResult>(token, `/accounts/${accountId}/email/routing/addresses`);
    return addresses.filter(a => a.verified !== null).map(a => a.email).sort();
}

interface WorkerScriptResult {
    id: string;
    handlers?: string[];
}

export async function listWorkers(token: string, accountId: string): Promise<string[]> {
    const scripts = await cfFetchAllPages<WorkerScriptResult>(token, `/accounts/${accountId}/workers/scripts`);
    // handlers 缺失时不过滤（API 字段可能缺省），存在时只保留实现了 email() handler 的 worker
    return scripts.filter(s => !s.handlers || s.handlers.includes('email')).map(s => s.id).sort();
}

interface RoutingRuleResult {
    matchers: Array<{ type: string; value?: string }>;
}

export async function listRuleAddresses(token: string, zoneId: string): Promise<string[]> {
    const rules = await cfFetchAllPages<RoutingRuleResult>(token, `/zones/${zoneId}/email/routing/rules`);
    return rules.flatMap(r => r.matchers).filter(m => m.type === 'literal' && m.value).map(m => m.value as string);
}

export async function createRule(token: string, zoneId: string, address: string, action: CloudflareRuleAction): Promise<void> {
    const res = await fetch(`${API_BASE}/zones/${zoneId}/email/routing/rules`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            name: 'Created by mail2telegram bot',
            enabled: true,
            matchers: [{ type: 'literal', field: 'to', value: address }],
            actions: [{ type: action.type, value: [action.value] }],
        }),
    });
    const data = await res.json() as CloudflareAPIResponse<unknown>;
    if (!data.success) {
        throw new Error(data.errors?.map(e => e.message).join('; ') || `Cloudflare API error (HTTP ${res.status})`);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cloudflare/index.test.ts`
Expected: 输出三行 `... ok`，无断言错误

- [ ] **Step 5: Lint + Commit**

```bash
npm run lint
git add src/cloudflare/index.ts src/cloudflare/index.test.ts src/test.ts
git commit -m "feat: add Cloudflare Email Routing API client"
```

---

### Task 2: `/new_route` 纯函数助手（callback 协议、keyboard 构建、KV state）

**Files:**
- Create: `src/telegram/new_route.ts`（本任务只写纯函数部分，Task 3 追加 handlers）
- Test: `src/telegram/new_route.test.ts`
- Modify: `src/test.ts`

**Interfaces:**
- Consumes: `CloudflareRuleAction`（Task 1）；`telegram-bot-api-types` 的 `Telegram.InlineKeyboardMarkup`。
- Produces（Task 3 依赖的精确签名）:
  - `interface NewRouteDomainOption { domain: string; zoneId: string }`
  - `interface NewRouteTarget { label: string; type: 'forward' | 'worker'; value: string }`
  - `interface NewRouteState { prefix: string; chatId: number; accountId: string; domains: NewRouteDomainOption[]; domain?: string; zoneId?: string; targets?: NewRouteTarget[] }`
  - `type NewRouteCallback = { act: 'd' | 't'; stateId: string; index: number } | { act: 'g'; stateId: string; page: number }`
  - `parseCallbackData(data: string): NewRouteCallback | null`
  - `buildTargets(emails: string[], workers: string[]): NewRouteTarget[]`
  - `buildDomainKeyboard(domains: NewRouteDomainOption[], stateId: string): Telegram.InlineKeyboardMarkup`
  - `buildTargetsKeyboard(targets: NewRouteTarget[], stateId: string, page: number): Telegram.InlineKeyboardMarkup`
  - `TARGETS_PER_PAGE: 10`
  - `stateKey(id: string): string`、`awaitPrefixKey(chatId: number): string`、`DOMAINS_CACHE_KEY: string`
  - `STATE_TTL = 3600`、`AWAIT_PREFIX_TTL = 300`

- [ ] **Step 1: Write the failing test**

创建 `src/telegram/new_route.test.ts`：

```ts
import assert from 'node:assert/strict';
import {
    buildDomainKeyboard,
    buildTargets,
    buildTargetsKeyboard,
    parseCallbackData,
    TARGETS_PER_PAGE,
} from './new_route';

function testParseCallbackData() {
    assert.deepEqual(parseCallbackData('nr:d:ab12cd34:0'), { act: 'd', stateId: 'ab12cd34', index: 0 });
    assert.deepEqual(parseCallbackData('nr:t:ab12cd34:17'), { act: 't', stateId: 'ab12cd34', index: 17 });
    assert.deepEqual(parseCallbackData('nr:g:ab12cd34:2'), { act: 'g', stateId: 'ab12cd34', page: 2 });
    assert.equal(parseCallbackData(''), null);
    assert.equal(parseCallbackData('nr:x:ab12cd34:0'), null);
    assert.equal(parseCallbackData('nr:d:ab12cd34'), null);
    assert.equal(parseCallbackData('nr:d:ab12cd34:x'), null);
    assert.equal(parseCallbackData('p:mailid123'), null);
    // Telegram callback_data 上限 64 字节
    for (const data of ['nr:d:ab12cd34:0', 'nr:t:ab12cd34:199', 'nr:g:ab12cd34:19']) {
        assert.ok(Buffer.byteLength(data) <= 64, `${data} exceeds 64 bytes`);
    }
    console.log('testParseCallbackData ok');
}

function testBuildTargets() {
    const targets = buildTargets(['a@x.com', 'b@x.com'], ['worker-a']);
    assert.deepEqual(targets, [
        { label: '📧 a@x.com', type: 'forward', value: 'a@x.com' },
        { label: '📧 b@x.com', type: 'forward', value: 'b@x.com' },
        { label: '⚙️ worker-a', type: 'worker', value: 'worker-a' },
    ]);
    assert.deepEqual(buildTargets([], []), []);
    console.log('testBuildTargets ok');
}

function testBuildDomainKeyboard() {
    const kb = buildDomainKeyboard([
        { domain: 'test.com', zoneId: 'z1' },
        { domain: 'sub.test.com', zoneId: 'z1' },
    ], 'ab12cd34');
    assert.deepEqual(kb.inline_keyboard, [
        [{ text: 'test.com', callback_data: 'nr:d:ab12cd34:0' }],
        [{ text: 'sub.test.com', callback_data: 'nr:d:ab12cd34:1' }],
    ]);
    console.log('testBuildDomainKeyboard ok');
}

function testBuildTargetsKeyboardPagination() {
    const targets = buildTargets(
        Array.from({ length: 15 }, (_, i) => `e${i}@x.com`),
        Array.from({ length: 10 }, (_, i) => `w${i}`),
    );
    assert.equal(targets.length, 25);

    const page0 = buildTargetsKeyboard(targets, 'ab12cd34', 0);
    assert.equal(page0.inline_keyboard.length, TARGETS_PER_PAGE + 1); // 10 个目标 + 导航行
    assert.equal(page0.inline_keyboard[0][0].callback_data, 'nr:t:ab12cd34:0');
    const nav0 = page0.inline_keyboard[TARGETS_PER_PAGE];
    assert.equal(nav0.length, 1);
    assert.equal(nav0[0].callback_data, 'nr:g:ab12cd34:1');

    const page1 = buildTargetsKeyboard(targets, 'ab12cd34', 1);
    assert.equal(page1.inline_keyboard[0][0].callback_data, 'nr:t:ab12cd34:10');
    const nav1 = page1.inline_keyboard[TARGETS_PER_PAGE];
    assert.equal(nav1.length, 2);
    assert.equal(nav1[0].callback_data, 'nr:g:ab12cd34:0');
    assert.equal(nav1[1].callback_data, 'nr:g:ab12cd34:2');

    const page2 = buildTargetsKeyboard(targets, 'ab12cd34', 2);
    assert.equal(page2.inline_keyboard.length, 5 + 1); // 剩余 5 个 + 导航行
    assert.equal(page2.inline_keyboard[0][0].callback_data, 'nr:t:ab12cd34:20');
    const nav2 = page2.inline_keyboard[5];
    assert.equal(nav2.length, 1);
    assert.equal(nav2[0].callback_data, 'nr:g:ab12cd34:1');
    console.log('testBuildTargetsKeyboardPagination ok');
}

testParseCallbackData();
testBuildTargets();
testBuildDomainKeyboard();
testBuildTargetsKeyboardPagination();
```

修改 `src/test.ts`：

```ts
import './mail/parse.test';
import './cloudflare/index.test';
import './telegram/new_route.test';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/telegram/new_route.test.ts`
Expected: 报错 `Cannot find module './new_route'`

- [ ] **Step 3: Write minimal implementation**

创建 `src/telegram/new_route.ts`（本任务只包含以下纯函数与常量；Task 3 会在文件末尾追加 handlers）：

```ts
import type * as Telegram from 'telegram-bot-api-types';

export interface NewRouteDomainOption {
    domain: string;
    zoneId: string;
}

export interface NewRouteTarget {
    label: string;
    type: 'forward' | 'worker';
    value: string;
}

export interface NewRouteState {
    prefix: string;
    chatId: number;
    accountId: string;
    domains: NewRouteDomainOption[];
    domain?: string;
    zoneId?: string;
    targets?: NewRouteTarget[];
}

export type NewRouteCallback =
    | { act: 'd' | 't'; stateId: string; index: number }
    | { act: 'g'; stateId: string; page: number };

export const TARGETS_PER_PAGE = 10;
export const STATE_TTL = 3600;
export const AWAIT_PREFIX_TTL = 300;
export const DOMAINS_CACHE_KEY = 'new_route:domains';

export function stateKey(id: string): string {
    return `new_route:state:${id}`;
}

export function awaitPrefixKey(chatId: number): string {
    return `new_route:await:${chatId}`;
}

export function parseCallbackData(data: string): NewRouteCallback | null {
    const parts = data.split(':');
    if (parts.length !== 4 || parts[0] !== 'nr') {
        return null;
    }
    const [, act, stateId, num] = parts;
    if (!/^[a-z0-9]+$/.test(stateId) || !/^\d+$/.test(num)) {
        return null;
    }
    if (act === 'd' || act === 't') {
        return { act, stateId, index: Number.parseInt(num, 10) };
    }
    if (act === 'g') {
        return { act, stateId, page: Number.parseInt(num, 10) };
    }
    return null;
}

export function buildTargets(emails: string[], workers: string[]): NewRouteTarget[] {
    return [
        ...emails.map(email => ({ label: `📧 ${email}`, type: 'forward' as const, value: email })),
        ...workers.map(worker => ({ label: `⚙️ ${worker}`, type: 'worker' as const, value: worker })),
    ];
}

export function buildDomainKeyboard(domains: NewRouteDomainOption[], stateId: string): Telegram.InlineKeyboardMarkup {
    return {
        inline_keyboard: domains.map((d, i) => [{
            text: d.domain,
            callback_data: `nr:d:${stateId}:${i}`,
        }]),
    };
}

export function buildTargetsKeyboard(targets: NewRouteTarget[], stateId: string, page: number): Telegram.InlineKeyboardMarkup {
    const start = page * TARGETS_PER_PAGE;
    const keyboard: Telegram.InlineKeyboardButton[][] = targets
        .slice(start, start + TARGETS_PER_PAGE)
        .map((t, i) => [{
            text: t.label,
            callback_data: `nr:t:${stateId}:${start + i}`,
        }]);
    const nav: Telegram.InlineKeyboardButton[] = [];
    if (page > 0) {
        nav.push({ text: '⬅️ Prev', callback_data: `nr:g:${stateId}:${page - 1}` });
    }
    if (start + TARGETS_PER_PAGE < targets.length) {
        nav.push({ text: 'Next ➡️', callback_data: `nr:g:${stateId}:${page + 1}` });
    }
    if (nav.length > 0) {
        keyboard.push(nav);
    }
    return { inline_keyboard: keyboard };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/telegram/new_route.test.ts`
Expected: 输出四行 `... ok`，无断言错误

- [ ] **Step 5: Lint + Commit**

```bash
npm run lint
git add src/telegram/new_route.ts src/telegram/new_route.test.ts src/test.ts
git commit -m "feat: add new_route callback protocol and keyboard builders"
```

---

### Task 3: `/new_route` handlers（命令、await-prefix、callback）

**Files:**
- Modify: `src/telegram/new_route.ts`（在 Task 2 内容后追加）
- Modify: `src/types/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `listZones`、`listEmailDomains`、`listDestinationAddresses`、`listWorkers`、`listRuleAddresses`、`createRule`、`validateEmailPrefix`、`isValidAddressLength`、`CloudflareZone`；Task 2 的全部纯函数；现有 `createTelegramBotAPI`（`src/telegram/api.ts`）。
- Produces（Task 4 接线依赖的精确签名）:
  - `handleNewRouteCommand(message: Telegram.Message, env: Environment): Promise<Response>`
  - `tryConsumeAwaitedPrefix(message: Telegram.Message, env: Environment): Promise<boolean>`
  - `handleNewRouteCallback(callback: Telegram.CallbackQuery, env: Environment): Promise<void>`
  - `Environment` 新增可选字段 `CF_API_TOKEN?: string`

- [ ] **Step 1: 扩展 Environment 类型**

修改 `src/types/index.ts`，在 `Environment` 接口的 `RESEND_API_KEY?: string;` 一行后追加：

```ts
    CF_API_TOKEN?: string;
```

- [ ] **Step 2: 实现 handlers**

在 `src/telegram/new_route.ts` 末尾追加（imports 需相应更新，完整 import 块如下）：

```ts
import type * as Telegram from 'telegram-bot-api-types';
import type { Environment } from '../types';
import {
    createRule,
    isValidAddressLength,
    listDestinationAddresses,
    listEmailDomains,
    listRuleAddresses,
    listWorkers,
    listZones,
    validateEmailPrefix,
} from '../cloudflare';
import { createTelegramBotAPI } from './api';
```

追加的代码：

```ts
function isAllowedChat(env: Environment, chatId: number): boolean {
    return env.TELEGRAM_ID.split(',').map(s => s.trim()).includes(`${chatId}`);
}

async function loadDomains(env: Environment): Promise<{ accountId: string; domains: NewRouteDomainOption[] }> {
    const cached = await env.DB.get(DOMAINS_CACHE_KEY);
    if (cached) {
        return JSON.parse(cached);
    }
    const token = env.CF_API_TOKEN as string;
    const zones = await listZones(token);
    if (zones.length === 0) {
        throw new Error('No zones visible to CF_API_TOKEN. Check token permissions and zone scope.');
    }
    const domains: NewRouteDomainOption[] = [];
    for (const zone of zones) {
        for (const domain of await listEmailDomains(token, zone)) {
            domains.push({ domain, zoneId: zone.id });
        }
    }
    const result = { accountId: zones[0].accountId, domains };
    await env.DB.put(DOMAINS_CACHE_KEY, JSON.stringify(result), { expirationTtl: STATE_TTL });
    return result;
}

async function saveState(env: Environment, stateId: string, state: NewRouteState): Promise<void> {
    await env.DB.put(stateKey(stateId), JSON.stringify(state), { expirationTtl: STATE_TTL });
}

async function loadState(env: Environment, stateId: string): Promise<NewRouteState | null> {
    const raw = await env.DB.get(stateKey(stateId));
    return raw ? JSON.parse(raw) : null;
}

async function startNewRouteFlow(prefix: string, message: Telegram.Message, env: Environment): Promise<Response> {
    const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
    const chatId = message.chat.id;
    const reply = (text: string) => api.sendMessage({ chat_id: chatId, text });

    if (!validateEmailPrefix(prefix)) {
        return reply(`Invalid prefix "${prefix}". Use letters, digits, dot, underscore and hyphen (max 63 chars, starting with a letter or digit).`);
    }
    const { accountId, domains } = await loadDomains(env);
    if (domains.length === 0) {
        return reply('No email routing domains found. Enable Email Routing on your zone first, and check CF_API_TOKEN permissions (Zone:Read, DNS:Read).');
    }
    const stateId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    await saveState(env, stateId, { prefix, chatId, accountId, domains });
    return api.sendMessage({
        chat_id: chatId,
        text: `Create ${prefix}@❓ - choose a domain:`,
        reply_markup: buildDomainKeyboard(domains, stateId),
    });
}

export async function handleNewRouteCommand(message: Telegram.Message, env: Environment): Promise<Response> {
    const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
    const chatId = message.chat.id;
    if (!isAllowedChat(env, chatId)) {
        return api.sendMessage({ chat_id: chatId, text: 'Permission denied.' });
    }
    if (!env.CF_API_TOKEN) {
        return api.sendMessage({ chat_id: chatId, text: 'Cloudflare API is not enabled (CF_API_TOKEN missing).' });
    }
    const args = message.text?.split(/ (.*)/)[1]?.trim() || '';
    if (!args) {
        await env.DB.put(awaitPrefixKey(chatId), '1', { expirationTtl: AWAIT_PREFIX_TTL });
        return api.sendMessage({ chat_id: chatId, text: 'Send me the email prefix (e.g. admin) within 5 minutes.' });
    }
    return startNewRouteFlow(args, message, env);
}

export async function tryConsumeAwaitedPrefix(message: Telegram.Message, env: Environment): Promise<boolean> {
    const chatId = message.chat.id;
    if (!message.text || message.text.startsWith('/') || !isAllowedChat(env, chatId)) {
        return false;
    }
    const key = awaitPrefixKey(chatId);
    if (await env.DB.get(key) === null) {
        return false;
    }
    await env.DB.delete(key);
    await startNewRouteFlow(message.text.trim(), message, env);
    return true;
}

export async function handleNewRouteCallback(callback: Telegram.CallbackQuery, env: Environment): Promise<void> {
    const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const parsed = parseCallbackData(callback.data || '');
    if (!parsed || !chatId || !messageId || !isAllowedChat(env, chatId) || !env.CF_API_TOKEN) {
        return;
    }
    const alert = (text: string) => api.answerCallbackQuery({
        callback_query_id: callback.id,
        text,
        show_alert: true,
    });

    const state = await loadState(env, parsed.stateId);
    if (!state || state.chatId !== chatId) {
        await alert('Session expired, run /new_route again.');
        return;
    }
    const token = env.CF_API_TOKEN;

    if (parsed.act === 'd') {
        const option = state.domains[parsed.index];
        if (!option) {
            await alert('Invalid option.');
            return;
        }
        const address = `${state.prefix}@${option.domain}`;
        if (!isValidAddressLength(address)) {
            await alert(`Address too long (over 90 chars): ${address}`);
            return;
        }
        const [emails, workers] = await Promise.all([
            listDestinationAddresses(token, state.accountId),
            listWorkers(token, state.accountId),
        ]);
        const targets = buildTargets(emails, workers);
        if (targets.length === 0) {
            await api.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text: 'No verified destination addresses or workers with an email handler found in this account.',
            });
            return;
        }
        state.domain = option.domain;
        state.zoneId = option.zoneId;
        state.targets = targets;
        await saveState(env, parsed.stateId, state);
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `Create ${address} - choose a target:\n📧 forward to email\n⚙️ send to worker`,
            reply_markup: buildTargetsKeyboard(targets, parsed.stateId, 0),
        });
        return;
    }

    if (parsed.act === 'g') {
        if (!state.targets || !state.domain) {
            await alert('Session expired, run /new_route again.');
            return;
        }
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `Create ${state.prefix}@${state.domain} - choose a target:\n📧 forward to email\n⚙️ send to worker`,
            reply_markup: buildTargetsKeyboard(state.targets, parsed.stateId, parsed.page),
        });
        return;
    }

    // parsed.act === 't'
    const target = state.targets?.[parsed.index];
    if (!target || !state.zoneId || !state.domain) {
        await alert('Invalid option.');
        return;
    }
    const address = `${state.prefix}@${state.domain}`;
    const existing = await listRuleAddresses(token, state.zoneId);
    await env.DB.delete(stateKey(parsed.stateId));
    if (existing.includes(address)) {
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `❌ ${address} already exists.`,
        });
        return;
    }
    await createRule(token, state.zoneId, address, { type: target.type, value: target.value });
    await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `✅ Created ${address} → ${target.type === 'forward' ? 'forward to' : 'worker'} ${target.value}`,
    });
}
```

- [ ] **Step 3: 验证编译与测试**

Run: `npx tsc --noEmit`
Expected: 无类型错误（若 `telegram-bot-api-types` 的 `InlineKeyboardButton` 等类型名有出入，以该包实际导出为准微调 import type）

Run: `npm test`
Expected: Task 1/2 的测试全部输出 `ok`

- [ ] **Step 4: Lint + Commit**

```bash
npm run lint
git add src/telegram/new_route.ts src/types/index.ts
git commit -m "feat: add /new_route command handlers with KV state"
```

---

### Task 4: 接线（命令注册、callback 分发、配置与文档）

**Files:**
- Modify: `src/telegram/telegram.ts`（约 line 136-170 的 `telegramCommandHandler`、line 172-263 的 `telegramCallbackHandler`）
- Modify: `src/telegram/const.ts`
- Modify: `wrangler.example.jsonc`
- Modify: `README.md`（Configuration 表格）

**Interfaces:**
- Consumes: Task 3 的 `handleNewRouteCommand`、`tryConsumeAwaitedPrefix`、`handleNewRouteCallback`。
- Produces: 无新接口。

- [ ] **Step 1: 注册命令与 callback 分发**

修改 `src/telegram/telegram.ts`：

1) 文件头部 import 追加：

```ts
import { handleNewRouteCallback, handleNewRouteCommand, tryConsumeAwaitedPrefix } from './new_route';
```

2) `telegramCommandHandler` 中，在 `if (message?.reply_to_message) {` 分支**之前**插入 await-prefix 消费逻辑：

```ts
    if (await tryConsumeAwaitedPrefix(message, env)) {
        return;
    }
```

3) 同一函数的 `handlers` 对象中追加：

```ts
        new_route: (msg: Telegram.Message) => handleNewRouteCommand(msg, env),
```

4) `telegramCallbackHandler` 中，在 `const [act, arg] = data.split(/:(.*)/)` 之后、`if (handlers[act])` 之前插入：

```ts
    if (act === 'nr') {
        try {
            await handleNewRouteCallback(callback, env);
        } catch (e) {
            logTelegramError('callback.new_route.error', e, { data, chatId, messageId });
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

5) `telegramCommandHandler` 中，把 `new_route` 的 handler 包一层错误兜底（Handler 抛错时向用户回复错误，而不是静默失败）：

```ts
        new_route: async (msg: Telegram.Message): Promise<Response> => {
            try {
                return await handleNewRouteCommand(msg, env);
            } catch (e) {
                logTelegramError('command.new_route.error', e, { command, chatId: msg.chat.id, messageId: msg.message_id });
                return await createTelegramBotAPI(TELEGRAM_TOKEN).sendMessage({
                    chat_id: msg.chat.id,
                    text: (e as Error).message,
                });
            }
        },
```

6) 为 callback 成功路径补 `answerCallbackQuery`（消除按钮 loading 转圈）。修改 `src/telegram/new_route.ts`：
- 在 `handleNewRouteCallback` 内，`alert` 定义后追加一个无提示的确认函数：

```ts
    const ack = () => api.answerCallbackQuery({ callback_query_id: callback.id });
```

- 三个成功分支（`d` 分支编辑目标键盘后、`g` 分支编辑消息后、`t` 分支编辑成功/已存在消息后）各追加一行 `await ack();`。

- [ ] **Step 2: 注册 bot 命令**

修改 `src/telegram/const.ts`，在 `telegramCommands` 数组末尾追加：

```ts
    {
        command: 'new_route',
        description: '/new_route <prefix> - Create a new email route',
    },
```

- [ ] **Step 3: 配置示例与文档**

修改 `wrangler.example.jsonc`，在 `vars` 的 `"DEBUG": "false"` 后追加一行注释（secret 不写入 vars）：

```jsonc
        "DEBUG": "false"
        // CF_API_TOKEN 请用 `wrangler secret put CF_API_TOKEN` 设置，所需权限：
        // Zone: Zone:Read, DNS:Read, Email Routing Rules:Edit（建议按 zone 限定范围）
        // Account: Email Routing Addresses:Read, Workers Scripts:Read
```

修改 `README.md` 的 Configuration 表格，在 `RESEND_API_KEY` 行后追加：

```markdown
| CF_API_TOKEN           | Cloudflare API Token for the `/new_route` command (create Email Routing rules from the bot). Required permissions: Zone `Zone:Read`, `DNS:Read`, `Email Routing Rules:Edit` (recommended to scope to specific zones); Account `Email Routing Addresses:Read`, `Workers Scripts:Read`. Set via `wrangler secret put CF_API_TOKEN`. The selectable domains are the zones visible to the token plus their email-routing subdomains (detected via MX records). |
```

- [ ] **Step 4: 全量验证**

```bash
npm test
npm run lint
npm run build
npx tsc --noEmit
```

Expected: 全部通过，无错误。

- [ ] **Step 5: 手动验证（需要真实 token 与 bot，用户执行）**

1. 按 README 新建 CF API token 并 `wrangler secret put CF_API_TOKEN`
2. `npm run pub` 部署后重新调用 `https://{DOMAIN}/init` 注册新命令
3. 在 bot 中发送 `/new_route admin`，走完 选域名 → 选目标 → 创建成功 流程；在 Cloudflare dashboard 的 Email Routing → Rules 中确认规则已创建
4. 重复发送同一前缀，确认提示 `already exists`

- [ ] **Step 6: Commit**

```bash
git add src/telegram/telegram.ts src/telegram/const.ts wrangler.example.jsonc README.md
git commit -m "feat: wire /new_route command into telegram bot"
```
