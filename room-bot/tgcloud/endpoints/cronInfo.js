// The Mini App's timer page: is the cron set up, and when did it last call?
import { EndpointError } from 'sdk';
import { getSetting, isOwner, localStr } from '../lib/store.js';
import { now } from '../lib/util.js';

export default async function (input, ctx) {
  if (!(await isOwner(ctx.initData.user.id))) throw new EndpointError('فقط صاحب ربات', { code: 'NOT_OWNER' });
  const seen = Number(await getSetting('cron_seen')) || 0;
  return { seen: seen ? await localStr(seen) : null, working: seen > now() - 180 };
}
