// Ogg/Opus (Telegram voice messages) -> mono PCM at 48 kHz.
// libopus from opus-decoder (MIT, https://github.com/eshaz/wasm-audio-decoders), converted from
// WebAssembly to plain JavaScript with binaryen's wasm2js (the sandbox does not allow WebAssembly).
import { instantiate } from './opus_asm.js';

let w = null;
const heapU8 = () => new Uint8Array(w.e.buffer);

function init() {
  if (w) return;
  w = instantiate({
    a: Math.exp,
    b: Math.cos,
    c: (dest, src, num) => heapU8().copyWithin(dest, src, src + num),
    d: () => { throw new Error('opus: out of memory'); },
  });
  w.f(); // runtime init
}

/** Ogg pages -> packets (a packet can span several 255-byte segments and pages). */
function* oggPackets(b) {
  let o = 0, packet = [];
  while (o + 27 <= b.length) {
    if (b[o] !== 0x4f || b[o + 1] !== 0x67 || b[o + 2] !== 0x67 || b[o + 3] !== 0x53) throw new Error('not an ogg file');
    const nseg = b[o + 26];
    let p = o + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      const len = b[o + 27 + i];
      packet.push(b.subarray(p, p + len));
      p += len;
      if (len < 255) {
        const total = packet.reduce((n, x) => n + x.length, 0);
        const out = new Uint8Array(total);
        let k = 0;
        for (const x of packet) { out.set(x, k); k += x.length; }
        packet = [];
        yield out;
      }
    }
    o = p;
  }
}

/** -> { pcm: Float32Array (mono), sampleRate: 48000 }; stops after maxSeconds. */
export function decodeOggOpus(bytes, maxSeconds = 30) {
  init();
  const packets = oggPackets(bytes);
  const head = packets.next().value;
  if (!head || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') throw new Error('not an opus file');
  const channels = head[9], preSkip = head[10] | (head[11] << 8);
  if (head[18] !== 0) throw new Error('opus: multichannel not supported');
  packets.next(); // OpusTags

  const FRAME = 120 * 48; // max samples per channel in one packet
  const inPtr = w.h(4000 * channels), outPtr = w.h(FRAME * channels * 4), mapPtr = w.h(2);
  heapU8().set([0, 1].slice(0, channels), mapPtr);
  const dec = w.g(48000, channels, 1, channels === 2 ? 1 : 0, mapPtr, preSkip, 0);
  const max = maxSeconds * 48000;
  const pcm = new Float32Array(max);
  let n = 0;
  try {
    for (const pkt of packets) {
      if (n >= max) break;
      if (!pkt.length || pkt.length > 4000 * channels) continue;
      heapU8().set(pkt, inPtr);
      const got = w.i(dec, inPtr, pkt.length, outPtr);
      if (got <= 0) continue;
      const f = new Float32Array(w.e.buffer, outPtr, got * channels);
      const take = Math.min(got, max - n);
      for (let s = 0; s < take; s++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += f[c * got + s];
        pcm[n + s] = v / channels;
      }
      n += take;
    }
  } finally {
    w.j(dec);
    w.k(inPtr); w.k(outPtr); w.k(mapPtr);
  }
  return { pcm: pcm.subarray(0, n), sampleRate: 48000 };
}
