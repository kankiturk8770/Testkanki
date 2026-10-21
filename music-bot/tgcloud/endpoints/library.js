// Everything the library tab shows: the automatic "best picks", likes and the user's playlists
// (each with up to 4 covers for its mosaic).
import * as store from '../lib/store.js';
import { caller, outList } from '../lib/webapp.js';

const covers = (list) => list.map((t) => t.thumb).filter(Boolean).slice(0, 4);

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const smart = await store.smartPicks(uid);
  const liked = await store.liked(uid);
  const playlists = [];
  for (const p of await store.playlists(uid)) playlists.push({ ...p, covers: covers(await store.playlistTracks(p.id)) });
  return {
    smart: await outList(smart, uid), smartCovers: covers(smart),
    liked: await outList(liked, uid), likedCovers: covers(liked),
    playlists,
  };
}
