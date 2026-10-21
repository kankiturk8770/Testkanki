// Helpers shared by the Mini App endpoints.
import { EndpointError } from 'sdk';
import * as store from './store.js';

export async function caller(ctx) {
  const user = ctx.initData?.user;
  if (!user) throw new EndpointError('مینی‌اپ رو از داخل ربات باز کن', { code: 'NO_USER' });
  await store.touchUser(user);
  return user.id;
}

export async function trackOrFail(id) {
  const t = await store.getTrack(id);
  if (!t) throw new EndpointError('آهنگ پیدا نشد', { code: 'NOT_FOUND' });
  return t;
}

export function out(t, likedSet) {
  return {
    id: t.id, title: t.title, artist: t.artist, duration: t.duration,
    thumb: t.thumb, source: t.source, url: t.url, liked: likedSet ? likedSet.has(t.id) : false,
  };
}

export async function outList(list, userId) {
  const liked = await store.likedIds(userId);
  return list.map((t) => out(t, liked));
}

/** Friendly EndpointError from any failure of a download/upload job. */
export function failure(e) {
  if (e instanceof EndpointError) return e;
  console.error(e);
  return new EndpointError(e?.constructor?.name === 'TooBig' ? 'حجم فایل بیشتر از ۵۰ مگابایته' : `نشد: ${String(e?.message || e).slice(0, 150)}`);
}
