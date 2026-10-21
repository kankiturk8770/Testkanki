// Full history (kept apart from playlists). input: { kind?, clear? }
import * as store from '../lib/store.js';
import { caller } from '../lib/webapp.js';
import { MUSIC_SOURCES } from '../lib/sources.js';

const KINDS = ['search', 'recognize', 'open', 'play', 'download', 'edit'];

export default async function (input, ctx) {
  const uid = await caller(ctx);
  if (input?.clear) {
    await store.clearHistory(uid);
    return [];
  }
  const kind = KINDS.includes(input?.kind) ? input.kind : null;
  // pasted links are shown as text; only songs are playable rows
  return (await store.history(uid, kind, 300)).map((r) =>
    r.track_id && !MUSIC_SOURCES.includes(r.source) ? { ...r, track_id: null, title: null, query: r.query || r.url } : r);
}
