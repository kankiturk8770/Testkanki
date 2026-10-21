// Everything the library tab shows: the automatic "best picks", likes and the user's playlists.
import * as store from '../lib/store.js';
import { caller, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  return {
    smart: await outList(await store.smartPicks(uid), uid),
    liked: await outList(await store.liked(uid), uid),
    playlists: await store.playlists(uid),
  };
}
