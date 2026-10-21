// Scheduled posts and giveaway deadlines. Telegram Serverless only runs code when something calls it:
// a cron service calls endpoints/tick every minute (set up once with /timer), and every update runs
// tick() too, so nothing is lost even without the cron.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { send, btn, now } from './util.js';
import { KIND_LABEL } from './data.js';
import { deliver } from './posts.js';
import { drawGiveaway } from './gv.js';

const MAX_PER_TICK = 3; // a run has ~30 s; the rest goes on the next tick

export async function tick() {
  const t = now();
  const due = await db.all(sql`SELECT * FROM jobs WHERE due <= ${t} ORDER BY due LIMIT ${MAX_PER_TICK}`);
  for (const j of due) {
    // claim it first so two ticks never send it twice
    const claimed = (await db.run(sql`DELETE FROM jobs WHERE id = ${j.id} RETURNING id`)).rows[0];
    if (!claimed) continue;
    try {
      const [lines] = await deliver(j.user_id, j.kind, JSON.parse(j.data), JSON.parse(j.targets), !!j.pin);
      await send(j.user_id, `⏰ <b>پست زمان‌بندی‌شده اجرا شد</b> (${KIND_LABEL[j.kind]})\n\n${lines.join('\n\n')}`, [[btn('🏠 منو', 'menu')]]);
    } catch (e) {
      console.error('job', j.id, e);
    }
  }
  const ending = await db.all(sql`SELECT id FROM giveaways WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= ${t} LIMIT ${MAX_PER_TICK}`);
  for (const g of ending) {
    try {
      await drawGiveaway(g.id);
    } catch (e) {
      console.error('draw', g.id, e);
    }
  }
}
