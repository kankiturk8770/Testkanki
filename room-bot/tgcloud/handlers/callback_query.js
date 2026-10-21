import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as store from '../lib/store.js';
import { send, btn, call } from '../lib/util.js';
import { tick } from '../lib/timer.js';
import { aiEnabled } from '../lib/ai.js';
import { AI_PROMPT } from '../lib/aiflow.js';
import { welcome, HELP, startSession, showJobs, showChannels, showStats, addHelp, menuKb, sessionCallback } from '../lib/flow.js';
import { gvJoin, gvMenu, showGvs, loadGv, drawGiveaway, cancelGiveaway } from '../lib/gv.js';

export default async function (c) {
  const data = c.data || '';
  if (data.startsWith('gj:')) { // join button in a channel
    await gvJoin(c);
    return tick().catch((e) => console.error('tick', e));
  }
  await call('answerCallbackQuery', { callback_query_id: c.id });
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
  if (data === 'gvl') return showGvs(uid);
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
