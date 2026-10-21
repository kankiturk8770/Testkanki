// "/storage" posted in a channel where the bot is admin proposes it as the bot's file storage
// (the Mini App player uploads tracks there instead of into users' chats). The bot admin confirms
// in a private chat, so nobody else can redirect the bot's uploads.
import { api } from 'sdk';
import { getSetting } from '../lib/store.js';
import { esc } from '../lib/util.js';

export default async function (post) {
  if ((post.text || '').trim().split('@')[0] !== '/storage') return;
  const admin = await getSetting('admin_id');
  if (!admin) {
    await api.sendMessage({ chat_id: post.chat.id, text: 'اول در چت خصوصی ربات /admin بزن.' });
    return;
  }
  await api.sendMessage({
    chat_id: Number(admin),
    text: `📦 کانال «${esc(post.chat.title)}» می‌خواد محل ذخیره فایل‌های ربات بشه. تأیید می‌کنی؟`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '✅ تأیید', callback_data: `st:${post.chat.id}` }]] },
  });
  await api.sendMessage({ chat_id: post.chat.id, text: 'درخواست برای ادمین ربات فرستاده شد.' });
}
