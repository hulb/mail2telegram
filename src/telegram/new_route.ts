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

export type NewRouteCallback
    = | { act: 'd' | 't'; stateId: string; index: number }
        | { act: 'g'; stateId: string; page: number };

export const TARGETS_PER_PAGE = 10;
export const STATE_TTL = 3600;
export const AWAIT_PREFIX_TTL = 300;
// v2: 旧版缓存曾存过空列表（旧探测逻辑所致），升版本强制失效
export const DOMAINS_CACHE_KEY = 'new_route:domains:v2';

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

export function isAllowedChat(env: Environment, chatId: number): boolean {
    return env.TELEGRAM_ID.split(',').map(s => s.trim()).includes(`${chatId}`);
}

export async function loadDomains(env: Environment): Promise<{ accountId: string; domains: NewRouteDomainOption[] }> {
    const cached = await env.DB.get(DOMAINS_CACHE_KEY);
    if (cached) {
        console.log(`[new_route] loadDomains cache_hit ${cached}`);
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
    console.log(`[new_route] loadDomains zones=${zones.length} ${JSON.stringify(zones.map(z => z.name))} domains=${JSON.stringify(domains)}`);
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
        return new Response(null, { status: 200 });
    }
    if (!env.CF_API_TOKEN) {
        return api.sendMessage({ chat_id: chatId, text: 'Cloudflare API is not enabled (CF_API_TOKEN missing).' });
    }
    const args = message.text?.split(/ (.*)/)[1]?.trim() || '';
    if (!args) {
        await env.DB.put(awaitPrefixKey(chatId), '1', { expirationTtl: AWAIT_PREFIX_TTL });
        return api.sendMessage({ chat_id: chatId, text: 'Send me the email prefix (e.g. admin) within 5 minutes.' });
    }
    await env.DB.delete(awaitPrefixKey(chatId));
    return startNewRouteFlow(args, message, env);
}

export async function tryConsumeAwaitedPrefix(message: Telegram.Message, env: Environment): Promise<boolean> {
    const chatId = message.chat.id;
    if (!message.text || message.text.startsWith('/') || !!message.reply_to_message || !isAllowedChat(env, chatId)) {
        return false;
    }
    const key = awaitPrefixKey(chatId);
    if (await env.DB.get(key) === null) {
        return false;
    }
    await env.DB.delete(key);
    if (!env.CF_API_TOKEN) {
        const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
        await api.sendMessage({ chat_id: chatId, text: 'Cloudflare API is not enabled (CF_API_TOKEN missing).' });
        return true;
    }
    try {
        await startNewRouteFlow(message.text.trim(), message, env);
    } catch (e) {
        const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
        await api.sendMessage({ chat_id: chatId, text: (e as Error).message });
    }
    return true;
}

export async function handleNewRouteCallback(callback: Telegram.CallbackQuery, env: Environment): Promise<void> {
    const api = createTelegramBotAPI(env.TELEGRAM_TOKEN);
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const parsed = parseCallbackData(callback.data || '');
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
            await ack();
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
        await ack();
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
        await ack();
        return;
    }

    // parsed.act === 't'
    const target = state.targets?.[parsed.index];
    if (!target || !state.targets || !state.zoneId || !state.domain) {
        await alert('Invalid option.');
        return;
    }
    const address = `${state.prefix}@${state.domain}`;
    const existing = await listRuleAddresses(token, state.zoneId);
    if (existing.includes(address)) {
        await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `❌ ${address} already exists. Choose another target or run /new_route again.`,
            reply_markup: buildTargetsKeyboard(state.targets, parsed.stateId, 0),
        });
        await ack();
        return;
    }
    await createRule(token, state.zoneId, address, { type: target.type, value: target.value });
    await env.DB.delete(stateKey(parsed.stateId));
    await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `✅ Created ${address} → ${target.type === 'forward' ? 'forward to' : 'worker'} ${target.value}`,
    });
    await ack();
}
