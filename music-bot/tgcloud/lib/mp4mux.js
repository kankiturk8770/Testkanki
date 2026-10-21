// Joins a video-only and an audio-only fragmented MP4 (YouTube's DASH streams) into one playable
// .mp4, without re-encoding. The runtime has no ffmpeg, so this works on the MP4 boxes directly:
// one moov with both tracks (track 1 = video, 2 = audio), then the moof+mdat fragments of both
// tracks interleaved by time.
import { concatBytes } from './util.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function setU32(b, o, v) {
  b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}
function u64(b, o) {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}
function setU64(b, o, v) {
  setU32(b, o, Math.floor(v / 2 ** 32));
  setU32(b, o + 4, v % 2 ** 32);
}

/** Boxes of bytes[start, end): [{ type, start, end, header }] */
function boxes(b, start = 0, end = b.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    let header = 8;
    if (size === 1) {
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type, start: o, end: o + size, header });
    o += size;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.start + box.header, box.end).find((x) => x.type === type);
const children = (b, box) => boxes(b, box.start + box.header, box.end);
const copy = (b, box) => b.slice(box.start, box.end);

function wrap(type, parts) {
  const body = concatBytes(parts);
  const out = new Uint8Array(8 + body.length);
  setU32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

// tkhd / tfhd / trex keep the track id right after the full-box header (tkhd: after the times)
function setTrackId(box, type, id) {
  const version = box[8];
  const off = type === 'tkhd' ? (version === 1 ? 28 : 20) : 12;
  setU32(box, off, id);
}

// Rewrite the track ids inside a copied trak / traf, recursing through containers.
function retrack(bytes, id) {
  for (const box of boxes(bytes)) {
    if (box.type === 'tkhd' || box.type === 'tfhd') setTrackId(bytes.subarray(box.start, box.end), box.type, id);
    else if (CONTAINERS.has(box.type)) retrack(bytes.subarray(box.start + box.header, box.end), id);
  }
  return bytes;
}

function parse(b) {
  const top = boxes(b);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) throw new Error('mp4: no moov');
  const trak = child(b, moov, 'trak');
  const mdhd = child(b, child(b, trak, 'mdia'), 'mdhd');
  const timescale = u32(b, mdhd.start + (b[mdhd.start + 8] === 1 ? 28 : 20));
  const frags = [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    const mdat = top[i + 1]?.type === 'mdat' ? top[i + 1] : null;
    if (!mdat) continue;
    const traf = child(b, top[i], 'traf');
    const tfdt = traf && child(b, traf, 'tfdt');
    const t = tfdt ? (b[tfdt.start + 8] === 1 ? u64(b, tfdt.start + 12) : u32(b, tfdt.start + 12)) : 0;
    frags.push({ moof: top[i], mdat, time: t / timescale });
  }
  return { b, top, moov, trak, frags };
}

/** video, audio: Uint8Array fragmented MP4s -> Uint8Array mp4 with both tracks. */
export function muxAV(video, audio) {
  const v = parse(video), a = parse(audio);
  if (!v.frags.length || !a.frags.length) throw new Error('mp4: not a fragmented stream');

  const ftyp = v.top.find((x) => x.type === 'ftyp');
  const mvhd = copy(v.b, child(v.b, v.moov, 'mvhd'));
  setU32(mvhd, mvhd.length - 4, 3); // next_track_ID
  const trex = (src, id) => {
    const mvex = child(src.b, src.moov, 'mvex');
    const box = copy(src.b, child(src.b, mvex, 'trex'));
    setTrackId(box, 'trex', id);
    return box;
  };
  const moov = wrap('moov', [
    mvhd,
    retrack(copy(v.b, v.trak), 1),
    retrack(copy(a.b, a.trak), 2),
    wrap('mvex', [trex(v, 1), trex(a, 2)]),
  ]);

  const head = [ftyp ? copy(v.b, ftyp) : wrap('ftyp', []), moov];
  let pos = head.reduce((n, x) => n + x.length, 0);
  const all = [...v.frags.map((f) => ({ ...f, src: v, id: 1 })), ...a.frags.map((f) => ({ ...f, src: a, id: 2 }))]
    .sort((x, y) => x.time - y.time || x.id - y.id);
  const parts = [...head];
  let seq = 1;
  for (const f of all) {
    const moof = copy(f.src.b, f.moof);
    retrack(moof.subarray(8), f.id);
    for (const box of boxes(moof, 8)) {
      if (box.type === 'mfhd') setU32(moof, box.start + 12, seq++);
      if (box.type !== 'traf') continue;
      // an explicit base_data_offset is a file position: move it with the fragment
      const tfhd = boxes(moof, box.start + box.header, box.end).find((x) => x.type === 'tfhd');
      const flags = u32(moof, tfhd.start + 8) & 0xffffff;
      if (flags & 1) setU64(moof, tfhd.start + 16, u64(moof, tfhd.start + 16) - f.moof.start + pos);
    }
    parts.push(moof, f.src.b.subarray(f.mdat.start, f.mdat.end));
    pos += moof.length + (f.mdat.end - f.mdat.start);
  }
  return concatBytes(parts);
}
