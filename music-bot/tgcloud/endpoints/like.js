import * as store from '../lib/store.js';
import { caller, trackOrFail } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const t = await trackOrFail(input?.id);
  return { liked: await store.toggleLike(uid, t.id) };
}
