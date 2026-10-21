// Shazam lookup. The fingerprint ("signature") is computed in the Mini App with shazamio-core
// (WebAssembly can't run in the serverless sandbox); this only asks Shazam's API what it is.
import { fetch } from 'sdk';

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  .replace(/[xy]/g, (c) => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16).toUpperCase());

/** -> { title, artist, album, cover, engine } or null */
export async function shazamLookup(uri, samplems) {
  if (!/^data:audio\/vnd\.shazam\.sig;base64,/.test(uri)) return null;
  const url = `https://amp.shazam.com/discovery/v5/en-US/GB/iphone/-/tag/${uuid()}/${uuid()}`
    + '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: '*/*', 'Accept-Language': 'en-US',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'X-Shazam-Platform': 'IPHONE', 'X-Shazam-AppVersion': '14.1.0',
    },
    body: JSON.stringify({ timezone: 'Europe/Berlin', signature: { uri, samplems: Math.round(samplems) }, timestamp: Date.now(), context: {}, geolocation: {} }),
  });
  if (!res.ok) throw new Error(`shazam ${res.status}`);
  const t = (await res.json())?.track;
  if (!t) return null;
  const album = (t.sections || []).flatMap((s) => s.metadata || []).find((m) => m.title === 'Album')?.text || null;
  return { title: t.title, artist: t.subtitle || null, album, cover: t.images?.coverart || null, engine: 'Shazam' };
}
