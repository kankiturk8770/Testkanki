import { remixes } from '../lib/sources.js';
import * as store from '../lib/store.js';
import { caller, trackOrFail, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const t = await trackOrFail(input?.id);
  return outList(await store.upsertTracks(await remixes(t, 15)), uid);
}
