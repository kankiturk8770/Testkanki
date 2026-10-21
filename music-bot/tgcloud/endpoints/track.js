import { caller, trackOrFail, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  return (await outList([await trackOrFail(input?.id)], uid))[0];
}
