// The player reports each started track; feeds history and the "best picks" playlist.
import * as store from '../lib/store.js';
import { caller, trackOrFail } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const t = await trackOrFail(input?.id);
  await store.log(uid, 'play', null, t.id);
  return { ok: true };
}
