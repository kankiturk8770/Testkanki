import * as store from '../lib/store.js';
import { send, btn, call, now } from '../lib/util.js';
import { tick } from '../lib/timer.js';
import { aiEnabled } from '../lib/ai.js';
import { aiCreate, AI_PROMPT } from '../lib/aiflow.js';
import {
  active, welcome, HELP, startSession, showJobs, showChannels, showStats, addHelp, tryAdd, storeAnswer,
  makeJob, parseWhen, menuKb, ask,
} from '../lib/flow.js';
import { gvMenu } from '../lib/gv.js';

// Settings the owner can set from the chat (keys never go in the code).
const SETTABLE = { gemini_key: 'کلید Gemini' };
const WEBAPP = 'https://app8719466331.tgcloud.ai/';

const fwdChat = (m) => m.forward_from_chat || m.forward_origin?.chat || null;

async function command(m, uid, st, cmd, arg, rest) {
  st.w = null;
  if (cmd === '/start' || cmd === '/menu') return welcome(uid, m.from?.first_name || '');
  if (cmd === '/help') return send(uid, HELP, [[btn('🏠 منو', 'menu')]]);
  if (cmd === '/new') return startSession(uid, st, 'room');
  if (cmd === '/giveaway' || cmd === '/gv') return gvMenu(uid);
  if (cmd === '/post') return startSession(uid, st, 'post');
  if (cmd === '/ai') {
    if (!(await aiEnabled())) return send(uid, '🪄 هوش مصنوعی هنوز فعال نشده.');
    if (rest) return aiCreate(uid, st, rest);
    st.w = 'ai';
    return send(uid, AI_PROMPT, [[btn('🏠 منو', 'menu')]]);
  }
  if (cmd === '/jobs') return showJobs(uid);
  if (cmd === '/channels') return showChannels(uid);
  if (cmd === '/addchannel') {
    if (arg) return tryAdd(uid, st, arg);
    st.w = 'addch';
    return send(uid, addHelp(), [[btn('🏠 منو', 'menu')]]);
  }
  if (cmd === '/stats') return showStats(uid);
  if (cmd === '/cancel') {
    st.s = null;
    return send(uid, '❎ لغو شد.', await menuKb());
  }
  const owner = await store.isOwner(uid);
  if (cmd === '/tz' && owner) {
    const mm = arg.match(/^([+-]?)(\d{1,2})(?::(\d{2}))?$/);
    if (mm) {
      await store.setSetting('tz', (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3] || 0)));
      return send(uid, `🕓 ساعت ربات تنظیم شد. الان: <b>${await store.localStr(now())}</b>`);
    }
    return send(uid, `مثال: /tz +3:30\nالان: <b>${await store.localStr(now())}</b>`);
  }
  if (cmd === '/timer' && owner) {
    return send(uid, '⏰ <b>زمان‌بندی دقیق</b>\n\nبرای اینکه پست‌های زمان‌بندی‌شده و قرعه‌کشی‌ها دقیق سر ساعت انجام بشن، این صفحه رو باز کن و مراحلش رو انجام بده (یه بار، ۲ دقیقه):',
      [[{ text: '⏰ تنظیم زمان‌بندی دقیق', web_app: { url: WEBAPP } }]]);
  }
  if ((cmd === '/set' || cmd === '/unset') && owner) {
    if (!SETTABLE[arg]) return send(uid, '⚙️ تنظیمات:\n<code>/set gemini_key کلید</code> — هوش مصنوعی\n<code>/unset gemini_key</code> — خاموش کردنش');
    if (cmd === '/unset') {
      await store.setSetting(arg, null);
      return send(uid, `✅ ${SETTABLE[arg]} پاک شد.`);
    }
    const val = rest.split(/\s+/).slice(1).join(' ').trim();
    if (!val) return send(uid, `مثال: <code>/set ${arg} …</code>`);
    await store.setSetting(arg, val);
    await call('deleteMessage', { chat_id: uid, message_id: m.message_id }); // don't leave the key in the chat
    return send(uid, `✅ ${SETTABLE[arg]} ذخیره شد.`, await menuKb());
  }
  return welcome(uid, m.from?.first_name || '');
}

export default async function (m) {
  if (m.chat.type !== 'private') return;
  const uid = m.chat.id;
  await store.user(m.from || { id: uid });
  const st = await store.getSession(uid);
  try {
    await handle(m, uid, st);
  } finally {
    await store.saveSession(uid, st);
  }
  await tick().catch((e) => console.error('tick', e));
}

async function handle(m, uid, st) {
  const t = (m.text || '').trim();
  if (t.startsWith('/')) {
    const parts = t.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    return command(m, uid, st, cmd, parts[1] || '', t.slice(parts[0].length).trim());
  }
  const fc = fwdChat(m);
  if (st.w === 'addch') {
    if (fc) return tryAdd(uid, st, fc.id);
    if (t) return tryAdd(uid, st, '@' + t.replace(/^@/, '').split(/\s+/)[0]);
    return;
  }
  if (st.w === 'ai' && t) return aiCreate(uid, st, t);
  if (st.s?.mode === 'sched' && t) {
    const ts = await parseWhen(t);
    if (!ts) return send(uid, '⚠️ ساعت رو اینجوری بفرست: 23:30 یا +45');
    return makeJob(uid, st, ts);
  }
  if (active(st)) {
    const s = st.s;
    const key = s.edit || s.keys[s.i];
    if (key === 'photo') {
      if (m.photo) return storeAnswer(uid, st, 'photo', m.photo[m.photo.length - 1].file_id);
      return send(uid, '🖼 عکس بفرست یا «بدون بنر» رو بزن.');
    }
    if (key === 'rules') {
      if (t) {
        s.rcustom.push('✍️ ' + t);
        return ask(uid, st);
      }
      return;
    }
    if (t) return storeAnswer(uid, st, key, t);
    return;
  }
  if (fc || /^@\w{4,}$/.test(t)) return tryAdd(uid, st, fc ? fc.id : t);
  // a sentence outside any menu: the AI builds the post it describes
  if (t.length >= 12 && (await aiEnabled())) return aiCreate(uid, st, t);
  return welcome(uid, m.from?.first_name || '');
}
