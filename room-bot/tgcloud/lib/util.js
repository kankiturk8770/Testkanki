// Small helpers shared by every module.
import { api, BotApiError } from 'sdk';

export const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const btn = (text, data) => ({ text, callback_data: data });
export const grid = (items, cols) => Array.from({ length: Math.ceil(items.length / cols) }, (_, i) => items.slice(i * cols, i * cols + cols));
export const now = () => Math.floor(Date.now() / 1000);
export const LINE = '━━━━━━━━━━━━━━━';
// Persian / Arabic digits -> ASCII
export const digits = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

/** Bot API call that never throws for Telegram errors: -> { ok, result } | { ok: false, description } */
export async function call(method, params) {
  try {
    return { ok: true, result: await api[method](params) };
  } catch (e) {
    if (e instanceof BotApiError) return { ok: false, code: e.code, description: e.description };
    throw e;
  }
}

export function send(chat, text, kb = null, extra = {}) {
  return call('sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}), ...extra,
  });
}

export const markup = (chat, mid, kb) => call('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: kb } });
