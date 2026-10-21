// "Just tell me": a sentence -> a filled post, straight to the preview (missing parts are asked).
import { send, call, btn } from './util.js';
import { parseRequest } from './ai.js';
import { startSession, parseWhen } from './flow.js';

export const AI_PROMPT = '🪄 <b>بگو چی میخوای، خودم می‌سازم</b>\n\n' +
  'هر جور راحتی بنویس، مثلا:\n\n' +
  '▫️ روم امشب ساعت ۱۱ لیویک اسکواد، ۱۰۰ یوسی به MVP، هک و فحش ممنوع\n' +
  '▫️ قرعه‌کشی ۲ کا لایک مرغ، ۳ برنده بین ۵۰ نفر، اسپانسر @mychannel\n' +
  '▫️ اطلاعیه: فردا سرور تست داریم، همه آنلاین باشید';

export async function aiCreate(uid, st, text) {
  const wait = await send(uid, '🪄 دارم می‌سازمش…');
  const drop = () => wait.ok && call('deleteMessage', { chat_id: uid, message_id: wait.result.message_id });
  let req;
  try {
    req = await parseRequest(text);
  } catch (e) {
    console.warn('ai', e.message);
    await drop();
    st.w = null;
    return send(uid, '⚠️ هوش مصنوعی الان جواب نداد؛ چند لحظه بعد دوباره بفرست یا از منو بساز.', [[btn('🏠 منو', 'menu')]]);
  }
  await drop();
  if (req.d.gend && /^\d{1,2}:\d{2}$/.test(req.d.gend)) {
    const ts = await parseWhen(req.d.gend);
    if (ts) req.d.gend = `at:${ts}`;
    else delete req.d.gend;
  } else if (req.d.gend && !/^(full|d:\d+)$/.test(req.d.gend)) delete req.d.gend;
  return startSession(uid, st, req.kind, { prefill: req.d });
}
