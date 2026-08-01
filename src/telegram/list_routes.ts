import type * as Telegram from 'telegram-bot-api-types';
import type { RoutingRule } from '../cloudflare';
import type { Environment } from '../types';
import type { NewRouteDomainOption } from './new_route';
import { deleteRule, listRoutingRules } from '../cloudflare';
import { createTelegramBotAPI } from './api';
import { isAllowedChat, loadDomains, STATE_TTL } from './new_route';

export interface ListRoutesState {
    chatId: number;
    domains: NewRouteDomainOption[];
    domain?: string;
    zoneId?: string;
    rules?: RoutingRule[];
}

export type ListRoutesCallback
    = | { act: 'd'; stateId: string; index: number }
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
    if (parsed.act === 'x') {
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
}
