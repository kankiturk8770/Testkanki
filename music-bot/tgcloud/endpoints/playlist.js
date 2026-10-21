// Playlist operations. input: { op: create|get|rename|delete|add|remove, id?, name?, trackId? }
import { EndpointError } from 'sdk';
import * as store from '../lib/store.js';
import { caller, trackOrFail, outList } from '../lib/webapp.js';

export default async function (input, ctx) {
  const uid = await caller(ctx);
  const op = input?.op;
  const name = String(input?.name || '').trim();
  if (op === 'create') {
    const id = await store.createPlaylist(uid, name || 'پلی‌لیست من');
    if (input.trackId) await store.addToPlaylist(id, (await trackOrFail(input.trackId)).id);
    return { id };
  }
  const pid = Number(input?.id);
  if (!(await store.ownsPlaylist(uid, pid))) throw new EndpointError('پلی‌لیست پیدا نشد', { code: 'NOT_FOUND' });
  switch (op) {
    case 'get':
      return outList(await store.playlistTracks(pid), uid);
    case 'rename':
      await store.renamePlaylist(pid, name || 'پلی‌لیست');
      return { ok: true };
    case 'delete':
      await store.deletePlaylist(pid);
      return { ok: true };
    case 'add':
      await store.addToPlaylist(pid, (await trackOrFail(input.trackId)).id);
      return { ok: true };
    case 'remove':
      await store.removeFromPlaylist(pid, Number(input.trackId));
      return { ok: true };
    default:
      throw new EndpointError('عملیات نامعتبر', { code: 'BAD_OP' });
  }
}
