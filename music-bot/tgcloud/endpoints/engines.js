// Which server-side recognisers are configured, so the Mini App only uploads audio when useful.
import { getSetting } from '../lib/store.js';
import { caller } from '../lib/webapp.js';

export default async function (input, ctx) {
  await caller(ctx);
  const has = async (k) => !!(await getSetting(k));
  return {
    fingerprint: (await has('audd_token')) || (await has('acr_key')),
    humming: (await has('acr_hum_key')) || (await has('stt_key')),
  };
}
