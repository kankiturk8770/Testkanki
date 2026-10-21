// Full history (kept apart from playlists). input: { kind?, clear? }
import * as store from '../lib/store.js';
import { caller } from '../lib/webapp.js';

const KINDS = ['search', 'recognize', 'open', 'play', 'download', 'edit'];

export default async function (input, ctx) {
  const uid = await caller(ctx);
  if (input?.clear) {
    await store.clearHistory(uid);
    return [];
  }
  const kind = KINDS.includes(input?.kind) ? input.kind : null;
  return store.history(uid, kind, 300);
}
