import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as store from '../lib/store.js';
import { send, btn, call } from '../lib/util.js';
import { tick } from '../lib/timer.js';
import { aiEnabled } from '../lib/ai.js';
import { AI_PROMPT } from '../lib/aiflow.js';
import { welcome, HELP, startSession, showJobs, showChannels, showStats, addHelp, menuKb, sessionCallback } from '../lib/flow.js';
import { gvJoin, gvMenu, showGvs, loadGv, drawGiveaway, cancelGiveaway, templates } from '../lib/gv.js';
import { autoPanel, autoAction, draftAction } from '../lib/autopost.js';
import { predictCallback, channelPredict, resultPicker, resultConfirm, announceResult } from '../lib/predict.js';

export default async function (c) {
  const data = c.data || '';
  if (data.startsWith('pq:')) { // a score button under a channel post
    await channelPredict(c);
    return tick().catch((e) => console.error('tick', e));
  }
  if (data.startsWith('gj:')) { // join button in a channel
    await gvJoin(c);
    return tick().catch((e) => console.error('tick', e));
  }
  await call('answerCallbackQuery', { callback_query_id: c.id });
  if (/^p[pc]:/.test(data)) return predictCallback(c); // anyone's score picker
  const uid = c.from.id;
  await store.user(c.from);
  const st = await store.getSession(uid);
  try {
    await handle(c, uid, st, data);
  } finally {
    await store.saveSession(uid, st);
  }
  await tick().catch((e) => console.error('tick', e));
}

async function handle(c, uid, st, data) {
  const mid = c.message?.message_id;
  const name = c.from.first_name || '';
  if (data === 'menu') {
    st.w = null;
    return welcome(uid, name);
  }
  if (data === 'new') return startSession(uid, st, 'room');
  if (data === 'post') return startSession(uid, st, 'post');
  if (data === 'gv') return gvMenu(uid);
  if (data.startsWith('gvn:')) return startSession(uid, st, 'gv_' + data.slice(4));
  if (data.startsWith('gvq:')) return startSession(uid, st, 'gv_' + data.slice(4), { quick: true });
  if (data.startsWith('gvt:')) {
    const t = (await store.isOwner(uid)) && (await templates())[Number(data.slice(4))];
    if (!t) return gvMenu(uid);
    return startSession(uid, st, t.kind, { prefill: t.d, tpl: true });
  }
  if (data === 'gvl') {
    st.w = null; // back from "type the result"
    return showGvs(uid);
  }
  // the match result: ➕/➖ per team, then confirm (owner only; checked inside)
  if (data.startsWith('mr:')) return resultPicker(uid, Number(data.slice(3)));
  if (/^r[pky]:\d+:\d+:\d+$/.test(data)) {
    const [act, gid, a, b] = data.split(':');
    if (act === 'rp') return resultPicker(uid, Number(gid), Number(a), Number(b), mid);
    if (act === 'rk') return resultConfirm(uid, Number(gid), Number(a), Number(b), mid);
    await call('editMessageReplyMarkup', { chat_id: uid, message_id: mid, reply_markup: { inline_keyboard: [] } });
    return announceResult(uid, Number(gid), Number(a), Number(b));
  }
  if (data === 'noop') return;
  if (data === 'auto' || /^(au|ap|ar|ax):/.test(data)) {
    if (!(await store.isOwner(uid))) return send(uid, '⛔️ این بخش فقط برای صاحب رباته.');
    if (data === 'auto') {
      st.w = null; // back from "type the times / sources"
      return autoPanel(uid);
    }
    if (data.startsWith('au:')) return autoAction(uid, st, data, mid);
    return draftAction(uid, data, c.message);
  }
  if (data === 'ai') {
    if (!(await aiEnabled())) return welcome(uid, name);
    st.w = 'ai';
    return send(uid, AI_PROMPT, [[btn('🏠 منو', 'menu')]]);
  }
  if (data.startsWith('gd:') || data.startsWith('gx:')) {
    const g = await loadGv(data.slice(3));
    if (!g || g.owner !== uid || g.status !== 'open') return send(uid, '⌛️ این قرعه‌کشی دیگه باز نیست.');
    if (data.startsWith('gd:')) {
      if (!g.count) return send(uid, '⚠️ هنوز کسی ثبت‌نام نکرده.');
      return drawGiveaway(g.id);
    }
    await cancelGiveaway(g);
    return send(uid, `⛔️ قرعه‌کشی #${g.id} لغو شد.`, [[btn('🏠 منو', 'menu')]]);
  }
  if (data === 'jobs') return showJobs(uid);
  if (data.startsWith('sc:')) {
    await db.run(sql`DELETE FROM jobs WHERE id = ${Number(data.slice(3))} AND user_id = ${uid}`);
    return showJobs(uid);
  }
  if (data === 'chs') return showChannels(uid);
  if (data === 'addch') {
    st.w = 'addch';
    return send(uid, addHelp(), [[btn('🏠 منو', 'menu')]]);
  }
  if (data === 'stats') return showStats(uid);
  if (data === 'help') return send(uid, HELP, [[btn('🏠 منو', 'menu')]]);
  if (data.startsWith('dc:')) {
    await store.removeChannel(uid, Number(data.slice(3)));
    return showChannels(uid);
  }
  if (!st.s) return send(uid, '⌛️ این جلسه تموم شده.', await menuKb());
  return sessionCallback(uid, st, data, mid);
}
