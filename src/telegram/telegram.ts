import type * as Telegram from 'telegram-bot-api-types';
import type { EmailRender } from '../mail';
import type { Environment } from '../types';
import { Dao } from '../db';
import { renderEmailDebugMode, renderEmailListMode, renderEmailPreviewMode, renderEmailSummaryMode, replyToEmail } from '../mail';
import { createTelegramBotAPI } from './api';
import { tmaModeDescription } from './const';
import { handleListRoutesCallback, handleListRoutesCommand } from './list_routes';
import { handleNewRouteCallback, handleNewRouteCommand, tryConsumeAwaitedPrefix } from './new_route';

type TelegramMessageHandler = (message: Telegram.Message) => Promise<Response>;
type CommandHandlerGroup = Record<string, TelegramMessageHandler>;

function logTelegram(event: string, data?: Record<string, unknown>): void {
    console.log(`[telegram] ${event}${data ? ` ${JSON.stringify(data)}` : ''}`);
}

function logTelegramError(event: string, error: unknown, data?: Record<string, unknown>): void {
    const err = error as Error;
    console.error(`[telegram] ${event} ${JSON.stringify({
        ...data,
        message: err?.message || String(error),
        stack: err?.stack,
    })}`);
}

async function logTelegramResponse(method: string, response: Response): Promise<void> {
    const data: Record<string, unknown> = {
        method,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
    };

    if (!response.ok) {
        try {
            data.body = (await response.clone().text()).substring(0, 500);
        } catch (e) {
            data.bodyReadError = (e as Error).message;
        }
    }

    logTelegram('api.response', data);
}

function handleIDCommand(env: Environment): TelegramMessageHandler {
    return async (msg: Telegram.Message): Promise<Response> => {
        const text = `Your chat ID is ${msg.chat.id}`;
        return await handleOpenTMACommand('', text, env)(msg);
    };
}

function handleOpenTMACommand(mode: string, text: string | null, env: Environment): TelegramMessageHandler {
    return async (msg: Telegram.Message): Promise<Response> => {
        const {
            TELEGRAM_TOKEN,
            DOMAIN,
        } = env;
        const params: Telegram.SendMessageParams = {
            chat_id: msg.chat.id,
            text: text || tmaModeDescription[mode] || 'Address Manager',
        };

        if (msg.chat.type === 'private') {
            params.reply_markup = {
                inline_keyboard: [
                    [
                        {
                            text: 'Open Manager',
                            web_app: {
                                url: `https://${DOMAIN}/tma?mode=${mode}`,
                            },
                        },
                    ],
                ],
            };
        }

        return await createTelegramBotAPI(TELEGRAM_TOKEN).sendMessage(params);
    };
}

async function handleReplyEmailCommand(message: Telegram.Message, env: Environment): Promise<void> {
    const {
        TELEGRAM_TOKEN,
        RESEND_API_KEY,
        DB,
    } = env;
    const dao = new Dao(DB);
    const api = createTelegramBotAPI(TELEGRAM_TOKEN);
    const reply = async (text: string) => {
        await api.sendMessage({
            chat_id: message.chat.id,
            reply_parameters: {
                message_id: message.message_id,
            },
            text,
        });
    };
    if (!RESEND_API_KEY) {
        logTelegram('reply_email.disabled', { chatId: message.chat.id, messageId: message.message_id });
        await reply('Resend API is not enabled.');
        return;
    }
    if (!message.text) {
        logTelegram('reply_email.missing_text', { chatId: message.chat.id, messageId: message.message_id });
        await reply('Please provide a message to resend.');
        return;
    }
    try {
        const messageID = message.reply_to_message?.message_id;
        if (!messageID) {
            logTelegram('reply_email.missing_reply', { chatId: message.chat.id, messageId: message.message_id });
            await reply('Please reply to a message to resend.');
            return;
        }
        const mailID = await dao.telegramIDToMailID(`${messageID}`);
        if (!mailID) {
            logTelegram('reply_email.mail_id_not_found', { chatId: message.chat.id, messageId: message.message_id, replyMessageId: messageID });
            await reply('Message not found.');
            return;
        }
        const mail = await dao.loadMailCache(mailID);
        if (!mail) {
            logTelegram('reply_email.mail_not_found', { chatId: message.chat.id, messageId: message.message_id, mailId: mailID });
            await reply('Message not found or expired.');
            return;
        }
        logTelegram('reply_email.send', { chatId: message.chat.id, messageId: message.message_id, mailId: mailID });
        await replyToEmail(RESEND_API_KEY, mail, message.text);
        await reply('Reply sent successfully.');
    } catch (e) {
        logTelegramError('reply_email.error', e, { chatId: message.chat.id, messageId: message.message_id });
        await reply((e as Error).message);
    }
}

async function telegramCommandHandler(message: Telegram.Message, env: Environment): Promise<void> {
    const { TELEGRAM_TOKEN } = env;
    logTelegram('message.received', {
        chatId: message?.chat?.id,
        messageId: message?.message_id,
        chatType: message?.chat?.type,
        hasText: !!message?.text,
        isReply: !!message?.reply_to_message,
    });
    if (await tryConsumeAwaitedPrefix(message, env)) {
        return;
    }
    if (message?.reply_to_message) {
        await handleReplyEmailCommand(message, env);
        return;
    }
    let [command] = message.text?.split(/ (.*)/) || [''];
    if (!command.startsWith('/')) {
        logTelegram('message.invalid_command', { command, chatId: message.chat.id, messageId: message.message_id });
        return;
    }
    command = command.substring(1);
    const handlers: CommandHandlerGroup = {
        id: handleIDCommand(env),
        start: handleIDCommand(env),
        test: handleOpenTMACommand('test', null, env),
        white: handleOpenTMACommand('white', null, env),
        block: handleOpenTMACommand('block', null, env),
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
    };

    if (handlers[command]) {
        logTelegram('command.handle', { command, chatId: message.chat.id, messageId: message.message_id });
        await handlers[command](message);
        return;
    }
    // 兼容旧版命令返回默认信息
    logTelegram('command.unknown', { command, chatId: message.chat.id, messageId: message.message_id });
    await handleOpenTMACommand('', `Unknown command: ${command}, try to reinitialize the bot.`, env)(message);
}

async function telegramCallbackHandler(callback: Telegram.CallbackQuery, env: Environment): Promise<void> {
    const {
        TELEGRAM_TOKEN,
        DB,
    } = env;

    const data = callback.data;
    const callbackId = callback.id;
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const api = createTelegramBotAPI(TELEGRAM_TOKEN);
    const dao = new Dao(DB);

    if (!data || !chatId || !messageId) {
        logTelegram('callback.missing_fields', {
            hasData: !!data,
            hasChatId: !!chatId,
            hasMessageId: !!messageId,
            callbackId,
        });
        return;
    }

    logTelegram('callback.received', { data, callbackId, chatId, messageId });
    const renderHandlerBuilder = (render: EmailRender): (arg: string) => Promise<void> => {
        return async (arg: string): Promise<void> => {
            logTelegram('callback.load_mail.start', { data, mailId: arg, chatId, messageId });
            const value = await dao.loadMailCache(arg);
            if (!value) {
                logTelegram('callback.load_mail.not_found', { data, mailId: arg, chatId, messageId });
                throw new Error('Error: Email not found or expired.');
            }
            logTelegram('callback.load_mail.ok', {
                data,
                mailId: arg,
                subjectLength: value.subject?.length,
                textLength: value.text?.length || 0,
                htmlLength: value.html?.length || 0,
            });
            const req = await render(value, env);
            logTelegram('callback.render.ok', {
                data,
                mailId: arg,
                responseTextLength: req.text?.length || 0,
                keyboardRows: req.reply_markup?.inline_keyboard?.length || 0,
            });
            const params: Telegram.EditMessageTextParams = {
                chat_id: chatId,
                message_id: messageId,
                ...req,
            };
            logTelegram('callback.edit_message.start', { data, mailId: arg, chatId, messageId });
            const response = await api.editMessageText(params);
            await logTelegramResponse('editMessageText', response);
        };
    };

    const deleteMessage = async (arg: string): Promise<void> => {
        logTelegram('callback.delete_message.start', { data, arg, chatId, messageId });
        const response = await api.deleteMessage({
            chat_id: chatId,
            message_id: messageId,
        });
        await logTelegramResponse('deleteMessage', response);
    };

    const handlers = {
        p: renderHandlerBuilder(renderEmailPreviewMode),
        l: renderHandlerBuilder(renderEmailListMode),
        s: renderHandlerBuilder(renderEmailSummaryMode),
        d: renderHandlerBuilder(renderEmailDebugMode),
        delete: deleteMessage,
    } as { [key: string]: (arg: string) => Promise<void> };

    const [act, arg] = data.split(/:(.*)/) as [string, string];
    logTelegram('callback.parsed', { data, act, arg, chatId, messageId });
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
    if (handlers[act]) {
        try {
            await handlers[act](arg);
        } catch (e) {
            logTelegramError('callback.handler.error', e, { data, act, arg, chatId, messageId });
            const response = await api.answerCallbackQuery({
                callback_query_id: callbackId,
                text: (e as Error).message,
                show_alert: true,
            });
            await logTelegramResponse('answerCallbackQuery', response);
        }
        return;
    }
    logTelegram('callback.unknown_action', { data, act, arg, chatId, messageId });
}

export async function telegramWebhookHandler(req: Request, env: Environment): Promise<void> {
    const body = await req.json() as Telegram.Update;
    logTelegram('webhook.update', {
        updateId: body?.update_id,
        hasMessage: !!body?.message,
        hasCallbackQuery: !!body?.callback_query,
        hasEditedMessage: !!body?.edited_message,
        keys: body ? Object.keys(body) : [],
    });
    if (body?.message) {
        await telegramCommandHandler(body?.message, env);
        return;
    }
    if (body?.callback_query) {
        await telegramCallbackHandler(body?.callback_query, env);
        return;
    }
    logTelegram('webhook.unhandled_update', { updateId: body?.update_id, keys: body ? Object.keys(body) : [] });
}
