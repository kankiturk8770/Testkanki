"use strict";
// Kanki Music Mini App: player, library, history, recognition and a cutter.
// Backend: the bot's Telegram Serverless endpoints (tgcloud/endpoints/*) via Telegram.WebApp.Serverless.call.
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
// Telegram's "swipe down to minimise" fights with scrolling the lists
tg?.disableVerticalSwipes?.();
tg?.setHeaderColor?.("#000000");
tg?.setBackgroundColor?.("#000000");

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => {
  if (!isFinite(s) || s <= 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};
const haptic = (t = "light") => tg?.HapticFeedback?.impactOccurred(t);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ---------------- icons (24×24 line icons) ---------------- */
const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
  prev: '<path d="M19 5L9 12l10 7z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  "repeat-one": '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/><path d="M11 10h1.5v5"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
  order: '<path d="M4 6h12"/><path d="M4 12h9"/><path d="M4 18h6"/><path d="M17 13l3 3-3 3"/><path d="M13 16h7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M10 15.5a1.5 1.5 0 1 1-1.5-1.5H10V10.5l4-1v4.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.4-9-7.4z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor"/><circle cx="15" cy="8" r="1.2" fill="currentColor"/>',
  heart: '<path d="M12 20s-7.5-4.4-9.2-9.2C1.6 7.4 3.8 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.2 0 5.4 2.9 4.2 6.3C19.5 15.6 12 20 12 20z"/>',
  "heart-on": '<path d="M12 20s-7.5-4.4-9.2-9.2C1.6 7.4 3.8 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.2 0 5.4 2.9 4.2 6.3C19.5 15.6 12 20 12 20z" fill="currentColor"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9"/><path d="M14.5 14.5L20 20"/><path d="M8.1 8.1L12 12"/>',
  send: '<path d="M21.5 2.5L10.5 13.5"/><path d="M21.5 2.5l-7 19-4-8-8-4z"/>',
  "list-plus": '<path d="M3 6h12"/><path d="M3 12h12"/><path d="M3 18h7"/><path d="M18 14v7"/><path d="M14.5 17.5h7"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3a9 9 0 0 1 9 9"/><path d="M12 6.5a5.5 5.5 0 0 1 5.5 5.5"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M9 18l6-6-6-6"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8"/><path d="M8 13h5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>',
  "volume-low": '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  upload: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  check: '<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
const setIcon = (el, name) => { el.dataset.i = name; el.innerHTML = icon(name); };
const drawIcons = (root = document) => root.querySelectorAll("i[data-i]").forEach((el) => setIcon(el, el.dataset.i));
drawIcons();

const PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#141006"/><g transform="translate(12 12)" fill="none" stroke="#ffc72c" stroke-width="2" stroke-linecap="round">${ICONS.music}</g></svg>`);

function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

/** Call a bot endpoint. */
function call(name, input = {}) {
  return new Promise((resolve, reject) => {
    if (!tg?.Serverless) return reject(new Error("مینی‌اپ رو از داخل ربات باز کن"));
    tg.Serverless.call(name, input, (err, result) => {
      if (!err) return resolve(result);
      reject(new Error(err.type === "UNAUTHORIZED" ? "مینی‌اپ رو از داخل ربات باز کن" : err.type === "ENDPOINT_ERROR" ? err.message : "ارتباط با سرور نشد؛ دوباره امتحان کن"));
    });
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** One endpoint call, retried twice (a part can fail on a busy server). */
async function callRetry(name, input) {
  for (let i = 0; ; i++) {
    try {
      return await call(name, input);
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
}

/** A file the bot hands out in base64 parts (endpoint responses are capped at ~2 MB). */
async function fetchParts(name, input, onProgress) {
  const first = await callRetry(name, { ...input, idx: 0 });
  const parts = new Array(first.total);
  parts[0] = b64ToBytes(first.data);
  let done = 1;
  onProgress?.(done, first.total);
  const rest = [...Array(first.total).keys()].slice(1);
  // three at a time: faster start, still light on the bot
  for (let i = 0; i < rest.length; i += 3) {
    await Promise.all(rest.slice(i, i + 3).map(async (idx) => {
      parts[idx] = b64ToBytes((await callRetry(name, { ...input, idx })).data);
      onProgress?.(++done, first.total);
    }));
  }
  return new Blob(parts, { type: first.mime });
}

/* ---------------- look ---------------- */
const THEMES = ["gold", "violet", "cyber", "crimson", "mono"];
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
}
setTheme(store.get("theme", "gold"));
$("#bot-btn").onclick = $("#player-bot").onclick = () => (tg?.close ? tg.close() : history.back());
$("#theme-btn").onclick = () => {
  setTheme(THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % THEMES.length]);
  haptic();
};

// gold fill on the played part of every slider
function paint(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty("--p", `${((+el.value - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener("input", (e) => e.target.type === "range" && paint(e.target));
const paintAll = () => $$('input[type="range"]').forEach(paint);

/* ---------------- tabs ---------------- */
function showView(id) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === id));
  if (id === "v-library") loadLibrary();
  if (id === "v-history") loadHistory();
}
$$(".tabs button").forEach((b) => (b.onclick = () => { haptic(); closePlayer(); showView(b.dataset.view); }));

/* ---------------- track lists ---------------- */
function renderList(el, tracks, { emptyText = "چیزی نیست", onRemove } = {}) {
  if (!tracks.length) {
    el.innerHTML = `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  el.innerHTML = "";
  tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "item" + (player.cur?.id === t.id ? " playing" : "");
    row.innerHTML = `<img loading="lazy" src="${esc(t.thumb || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'">
      <div class="meta"><b>${esc(t.title)}</b><small>${esc(t.artist || "")}${t.duration ? " · " + fmt(t.duration) : ""}</small></div>
      ${onRemove ? `<button class="icon-btn more" title="حذف">${icon("trash")}</button>` : ""}`;
    row.onclick = (e) => {
      if (e.target.closest(".more")) {
        e.stopPropagation();
        onRemove(t, row);
        return;
      }
      haptic();
      player.playList(tracks, i);
    };
    el.appendChild(row);
  });
}

/* ---------------- search ---------------- */
let lastQuery = "";
async function doSearch(q) {
  q = q.trim();
  if (!q) return;
  lastQuery = q.replace(/ (remix|live|slowed reverb)$/, "");
  const el = $("#search-results");
  el.innerHTML = '<p class="empty"><span class="spinner" style="display:inline-block"></span></p>';
  try {
    renderList(el, await call("search", { q }), { emptyText: "چیزی پیدا نشد 😕" });
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}
$("#search-form").onsubmit = (e) => {
  e.preventDefault();
  $("#q").blur();
  $$("#search-chips .chip").forEach((c, i) => c.classList.toggle("on", i === 0));
  doSearch($("#q").value);
};
$$("#search-chips .chip").forEach((c) => (c.onclick = () => {
  const base = lastQuery || $("#q").value;
  if (!base.trim()) return;
  $$("#search-chips .chip").forEach((x) => x.classList.toggle("on", x === c));
  doSearch(base + c.dataset.suffix);
}));

/* ---------------- audio loading ---------------- */
const audioCache = new Map(); // id -> Promise<{ blob, url }>
function loadAudio(t, onProgress) {
  if (!audioCache.has(t.id)) {
    const p = fetchParts("audioChunk", { id: t.id }, onProgress).then((blob) => ({ blob, url: URL.createObjectURL(blob) }));
    p.catch(() => audioCache.delete(t.id));
    audioCache.set(t.id, p);
  }
  return audioCache.get(t.id);
}

/* ---------------- player ---------------- */
const audio = $("#audio");
// one button cycles: repeat all -> repeat one -> shuffle -> play in order
const MODES = [
  { id: "all", icon: "repeat", text: "🔁 تکرار همه" },
  { id: "one", icon: "repeat-one", text: "🔂 تکرار همین آهنگ" },
  { id: "shuffle", icon: "shuffle", text: "🔀 پخش تصادفی" },
  { id: "off", icon: "order", text: "▶️ پخش به ترتیب" },
];
const player = {
  queue: [], idx: -1, cur: null,
  mode: store.get("mode", "all"),
  loadSeq: 0,

  playList(tracks, i) {
    this.queue = tracks.slice();
    this.load(i, true);
    openPlayer();
  },
  async load(i, autoplay) {
    if (i < 0 || i >= this.queue.length) return;
    this.idx = i;
    this.cur = this.queue[i];
    viz.track(this.cur);
    const t = this.cur;
    const seq = ++this.loadSeq;
    stopPreview();
    audio.pause();
    audio.removeAttribute("src");
    $("#t-dur").textContent = t.duration ? fmt(t.duration) : "0:00";
    this.render();
    setupCut();
    const loading = $("#p-loading");
    loading.hidden = false;
    $("#p-loading-text").textContent = "";
    try {
      // 1) the song's own CDN, streamed (starts in a moment); 2) Telegram's copy, in parts
      const direct = await call("stream", { id: t.id }).catch(() => null);
      if (seq !== this.loadSeq) return;
      if (direct?.kind && (await playDirect(direct, seq, autoplay))) {
        t.stream = direct;
      } else {
        if (seq !== this.loadSeq) return;
        const { url } = await loadAudio(t, (n, total) => {
          if (seq === this.loadSeq) $("#p-loading-text").textContent = `${Math.round((n / total) * 100)}%`;
        });
        if (seq !== this.loadSeq) return;
        setSource(url);
        if (autoplay) audio.play().catch(() => {});
      }
      call("played", { id: t.id }).catch(() => {});
    } catch (e) {
      if (seq !== this.loadSeq) return;
      loading.hidden = true;
      toast("⚠️ " + e.message, 5000);
    }
  },
  render() {
    const t = this.cur;
    if (!t) return;
    $("#mini").hidden = false;
    for (const img of [$("#mini-cover"), $("#p-cover")]) {
      img.onerror = () => (img.src = PLACEHOLDER);
      img.src = t.thumb || PLACEHOLDER;
    }
    $("#mini-title").textContent = $("#p-title").textContent = t.title;
    $("#mini-artist").textContent = $("#p-artist").textContent = t.artist || "";
    $("#player-src").textContent = `${this.idx + 1} / ${this.queue.length}`;
    setIcon($("#p-like i"), t.liked ? "heart-on" : "heart");
    $("#p-like").classList.toggle("active", !!t.liked);
    const m = MODES.find((x) => x.id === this.mode) || MODES[0];
    setIcon($("#p-mode i"), m.icon);
    $("#p-mode").classList.toggle("active", this.mode !== "off");
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist || "", artwork: t.thumb ? [{ src: t.thumb, sizes: "480x360" }] : [],
      });
    }
    if (!$("#panel-queue").hidden) renderQueue();
  },
  nextIndex(dir) {
    const n = this.queue.length;
    if (!n) return -1;
    if (this.mode === "shuffle" && n > 1) {
      let j;
      do j = Math.floor(Math.random() * n); while (j === this.idx);
      return j;
    }
    const j = this.idx + dir;
    if (j >= n) return this.mode === "off" ? -1 : 0;
    if (j < 0) return this.mode === "off" ? 0 : n - 1;
    return j;
  },
  next(manual = true) {
    const j = this.nextIndex(1);
    if (j >= 0) this.load(j, true);
    else if (manual) toast("آخر صف");
  },
  prev() {
    if (audio.currentTime > 4) audio.currentTime = 0;
    else this.load(this.nextIndex(-1), true);
  },
  toggle() {
    if (!this.cur || !audio.src) return;
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
  },
};

let hls = null;
let switching = false; // errors while trying a source are not "this song is broken"
function setSource(url) {
  hls?.destroy();
  hls = null;
  audio.src = url;
}

/** Play a direct URL (file or HLS); resolves true once it can play, false if it fails in 12 s. */
function playDirect(s, seq, autoplay) {
  return new Promise((resolve) => {
    switching = true;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      switching = false;
      audio.removeEventListener("canplay", onOk);
      audio.removeEventListener("error", onErr);
      clearTimeout(timer);
      if (!ok) { hls?.destroy(); hls = null; audio.removeAttribute("src"); }
      resolve(ok && seq === player.loadSeq);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), 12000);
    audio.addEventListener("canplay", onOk);
    audio.addEventListener("error", onErr);
    if (s.kind === "hls" && !audio.canPlayType("application/vnd.apple.mpegurl")) {
      if (!window.Hls?.isSupported()) return finish(false);
      hls?.destroy();
      hls = new Hls({ maxBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_, d) => d.fatal && finish(false));
      hls.loadSource(s.url);
      hls.attachMedia(audio);
    } else setSource(s.url);
    if (autoplay) audio.play().catch(() => {});
  });
}

/** HLS playlist -> one file (init segment + all media segments), fetched by the browser. */
async function hlsBlob(url) {
  const text = await (await fetch(url)).text();
  const abs = (u) => (/^https?:/.test(u) ? u : new URL(u, url).href);
  const map = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const urls = [...(map ? [map[1]] : []), ...text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))].map(abs);
  const parts = new Array(urls.length);
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(urls.slice(i, i + 4).map(async (u, k) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`segment ${r.status}`);
      parts[i + k] = await r.arrayBuffer();
    }));
  }
  return new Blob(parts, { type: "audio/mp4" });
}

/** Bytes of the current song for the cutter: straight from the CDN when possible. */
async function songBlob(t) {
  try {
    if (t.stream?.kind === "file") {
      const r = await fetch(t.stream.url);
      if (r.ok) return await r.blob();
    }
    if (t.stream?.kind === "hls") return await hlsBlob(t.stream.url);
  } catch (e) {
    console.warn("cdn fetch failed, using the bot's copy", e);
  }
  return (await loadAudio(t)).blob;
}

/* ---------------- player spectrum: mirrored bars in the theme colours, also a seek bar ---------------- */
const viz = (() => {
  const c = $("#viz"), g = c.getContext("2d");
  const N = 64;
  let raf = 0, amp = 0, seed = 1, shape = [], jit = new Float32Array(N), last = 0, colors = null, colorsAt = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  function reshape(key) {
    seed = [...String(key || "x")].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 2147483647, 7) || 7;
    // a "song" envelope: a few loud bursts over a quieter body
    const peaks = Array.from({ length: 4 }, () => [rnd() * N, 2 + rnd() * 6, 0.75 + rnd() * 0.25]);
    shape = Array.from({ length: N }, (_, i) => {
      let v = 0.3 + rnd() * 0.3;
      for (const [p, w, h] of peaks) v = Math.max(v, h * Math.exp(-((i - p) ** 2) / (2 * w * w)) * (0.7 + rnd() * 0.3));
      return v;
    });
  }
  function palette() {
    const now = performance.now();
    if (!colors || now - colorsAt > 1000) {
      const cs = getComputedStyle(document.documentElement);
      colors = ["--gold-deep", "--gold", "--shine"].map((v) => cs.getPropertyValue(v).trim());
      colorsAt = now;
    }
    return colors;
  }
  function frame(now) {
    raf = 0;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || $("#player").hidden || document.hidden) return; // nothing to draw: wake() restarts
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const playing = !audio.paused;
    amp += ((playing ? 1 : 0.18) - amp) * 0.08;
    if (now - last > 90 && playing) { // new "beat" values, smoothed below
      last = now;
      for (let i = 0; i < N; i++) jit[i] = 0.55 + Math.random() * 0.45;
    }
    const [deep, gold, shine] = palette();
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, deep); grad.addColorStop(0.3, gold); grad.addColorStop(0.5, shine); grad.addColorStop(0.7, gold); grad.addColorStop(1, deep);
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    const step = w / N, bw = Math.max(2, step * 0.55), mid = h / 2;
    g.fillStyle = grad;
    g.shadowColor = gold;
    for (let i = 0; i < N; i++) {
      const pulse = 0.85 + 0.15 * Math.sin(now / 240 + i * 0.45);
      shape.cur ??= new Float32Array(N);
      shape.cur[i] += ((shape[i] || 0.3) * (playing ? jit[i] * pulse : 1) * amp - shape.cur[i]) * 0.25;
      const bh = Math.max(2, shape.cur[i] * (h - 4));
      g.globalAlpha = i / N <= progress ? 1 : 0.35;
      g.shadowBlur = i / N <= progress ? 8 : 0;
      g.beginPath();
      (g.roundRect || g.rect).call(g, i * step + (step - bw) / 2, mid - bh / 2, bw, bh, bw / 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
    // keep animating while playing or until the bars settle
    if (playing || Math.abs(amp - 0.18) > 0.01) raf = requestAnimationFrame(frame);
  }
  const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };
  c.addEventListener("click", (e) => {
    const r = c.getBoundingClientRect();
    if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
    wake();
  });
  audio.addEventListener("timeupdate", () => audio.paused && wake());
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("resize", wake);
  reshape("x");
  return { wake, track: (t) => { reshape(t?.id ?? t?.key ?? t?.title); shape.cur = null; wake(); } };
})();

function setPlaying(on) {
  for (const b of [$("#p-play i"), $("#mini-play i")]) setIcon(b, on ? "pause" : "play");
  viz.wake();
}
audio.addEventListener("play", () => setPlaying(true));
audio.addEventListener("pause", () => setPlaying(false));
audio.addEventListener("canplay", () => ($("#p-loading").hidden = true));
audio.addEventListener("loadedmetadata", () => {
  $("#t-dur").textContent = fmt(audio.duration);
  setupCut();
});
audio.addEventListener("error", () => {
  if (switching || !audio.getAttribute("src")) return;
  $("#p-loading").hidden = true;
  toast("⚠️ این فایل پخش نشد؛ آهنگ بعدی...");
  setTimeout(() => player.next(false), 1500);
});
audio.addEventListener("timeupdate", () => {
  const d = audio.duration || 0, c = audio.currentTime;
  if (preview && c >= cut.b) audio.currentTime = cut.a; // looped preview of the cut
  if (!seeking) {
    $("#seek").value = d ? (c / d) * 1000 : 0;
    paint($("#seek"));
  }
  $("#t-cur").textContent = fmt(c);
  $("#mini-bar").style.width = d ? `${(c / d) * 100}%` : "0";
  if (d) $("#cut-head").style.left = `${(c / d) * 100}%`;
});
audio.addEventListener("ended", () => {
  if (player.mode === "one") {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } else player.next(false);
});

let seeking = false;
$("#seek").addEventListener("input", () => {
  seeking = true;
  $("#t-cur").textContent = fmt((($("#seek").value / 1000) * audio.duration) || 0);
});
$("#seek").addEventListener("change", () => {
  if (audio.duration) audio.currentTime = ($("#seek").value / 1000) * audio.duration;
  seeking = false;
});

$("#p-play").onclick = $("#mini-play").onclick = (e) => {
  e.stopPropagation();
  haptic("medium");
  player.toggle();
};
$("#p-next").onclick = $("#mini-next").onclick = (e) => {
  e.stopPropagation();
  haptic();
  player.next();
};
$("#p-prev").onclick = () => { haptic(); player.prev(); };
$("#p-mode").onclick = () => {
  const i = MODES.findIndex((x) => x.id === player.mode);
  const m = MODES[(i + 1) % MODES.length];
  player.mode = m.id;
  store.set("mode", m.id);
  toast(m.text, 1500);
  haptic();
  player.render();
};
$("#p-like").onclick = async () => {
  const t = player.cur;
  if (!t) return;
  const r = await call("like", { id: t.id }).catch((e) => toast(e.message));
  if (!r) return;
  t.liked = r.liked;
  haptic("medium");
  player.render();
};

// volume
const volEl = $("#vol");
volEl.value = Math.max(5, +store.get("vol", 100));
audio.volume = volEl.value / 100;
volEl.oninput = () => {
  audio.volume = volEl.value / 100;
  store.set("vol", volEl.value);
};
$("#vol-btn").onclick = () => {
  $("#vol-row").hidden = !$("#vol-row").hidden;
  paint(volEl);
};

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
  navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  navigator.mediaSession.setActionHandler("seekto", (d) => (audio.currentTime = d.seekTime));
}

// swipe the cover left/right = next/previous
(() => {
  const el = $("#cover-wrap");
  let x0 = null;
  el.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (x0 !== null) $("#p-cover").style.transform = `translateX(${(e.touches[0].clientX - x0) / 3}px) rotate(${(e.touches[0].clientX - x0) / 40}deg)`;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - x0;
    $("#p-cover").style.transform = "";
    x0 = null;
    if (Math.abs(dx) < 60) return;
    haptic();
    dx < 0 ? player.next() : player.prev();
  });
})();

function openPlayer() {
  $("#player").hidden = false;
  viz.wake();
  document.body.classList.add("player-open");
  tg?.BackButton?.show();
  paintAll();
}
function closePlayer() {
  $("#player").hidden = true;
  document.body.classList.remove("player-open");
  tg?.BackButton?.hide();
}
$("#mini").onclick = openPlayer;
$("#player-close").onclick = closePlayer;
tg?.BackButton?.onClick(() => {
  if (!$("#player").hidden) closePlayer();
  else if (!$("#lib-detail").hidden) $("#lib-back").click();
});

/* panels */
function togglePanel(name, force) {
  $$(".panel").forEach((p) => {
    const show = p.id === `panel-${name}` && (force ?? p.hidden);
    p.hidden = !show;
  });
  $$(".tool[data-panel]").forEach((b) => b.classList.toggle("on", !$(`#panel-${b.dataset.panel}`).hidden));
  if (name === "queue") renderQueue();
  if (name === "edit") setupCut();
  paintAll();
  if (!$(`#panel-${name}`).hidden) setTimeout(() => $(`#panel-${name}`).scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
}
$$("[data-panel]").forEach((b) => (b.onclick = () => togglePanel(b.dataset.panel)));
$("#player-queue-btn").onclick = () => togglePanel("queue");

function renderQueue() {
  renderList($("#queue-list"), player.queue);
  [...$("#queue-list").children].forEach((row, i) => (row.onclick = () => player.load(i, true)));
}

/* send to chat */
$("#send-audio").innerHTML = ["128", "192", "320"].map((q) => `<button class="pill" data-send="audio:${q}">${icon("music")} ${q}k</button>`).join("")
  + `<button class="pill" data-send="voice:">${icon("mic")} ویس</button>`;
$("#send-video").innerHTML = ["360", "720", "1080"].map((q) => `<button class="pill" data-send="video:${q}">🎬 ${q}p</button>`).join("");
$$("#panel-send svg").forEach((s) => s.setAttribute("width", "16"));
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-send]");
  if (!b || !player.cur) return;
  const [kind, quality] = b.dataset.send.split(":");
  b.disabled = true;
  toast("⏳ دارم می‌فرستم تو چت...", 4000);
  try {
    await call("sendTrack", { id: player.cur.id, kind, quality });
    toast("✅ تو چت فرستادم");
    haptic("medium");
  } catch (err) {
    toast("⚠️ " + err.message, 5000);
  } finally {
    b.disabled = false;
  }
});

/* add to playlist */
$("#p-add").onclick = async () => {
  const t = player.cur;
  if (!t) return;
  const lib = await call("library").catch((e) => (toast(e.message), null));
  if (!lib) return;
  const add = async (id) => {
    if (!id) return;
    if (id === "new") {
      const name = prompt("اسم پلی‌لیست:");
      if (!name) return;
      await call("playlist", { op: "create", name, trackId: t.id });
    } else await call("playlist", { op: "add", id: Number(id), trackId: t.id });
    toast("✅ اضافه شد");
    haptic("medium");
  };
  const buttons = lib.playlists.slice(0, 2).map((p) => ({ id: String(p.id), type: "default", text: p.name.slice(0, 30) }));
  buttons.push({ id: "new", type: "default", text: "➕ پلی‌لیست جدید" });
  if (tg?.showPopup && lib.playlists.length <= 2) {
    tg.showPopup({ title: "افزودن به پلی‌لیست", message: t.title.slice(0, 60), buttons }, (id) => add(id).catch((e) => toast(e.message)));
    return;
  }
  const names = lib.playlists.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const pick = prompt(`شماره پلی‌لیست، یا اسم یه پلی‌لیست جدید:\n${names}`);
  if (!pick) return;
  const p = lib.playlists[+pick - 1];
  await (p ? add(String(p.id)) : call("playlist", { op: "create", name: pick, trackId: t.id }).then(() => toast("✅ پلی‌لیست ساخته شد"))).catch((e) => toast(e.message));
};

$("#p-remix").onclick = async () => {
  const t = player.cur;
  if (!t) return;
  toast("⏳ دنبال ریمیکس‌ها...");
  const list = await call("remixes", { id: t.id }).catch((e) => (toast(e.message), null));
  if (!list) return;
  if (!list.length) return toast("ریمیکسی پیدا نشد");
  closePlayer();
  showView("v-search");
  $("#q").value = `${t.artist || ""} ${t.title} remix`.trim();
  renderList($("#search-results"), list);
};

/* ---------------- cutter ---------------- */
const cut = { a: 0, b: 30, track: null };
const trackDur = () => audio.duration || player.cur?.duration || 0;
let preview = false;

function setupCut() {
  const d = trackDur();
  if (!d) return;
  ["#cut-a", "#cut-b"].forEach((s) => ($(s).max = d.toFixed(1)));
  // a new track starts with the 30 s around the chorus; redo once the real length is known
  if (cut.track !== player.cur?.id || cut.b > d + 0.5) {
    cut.track = player.cur?.id;
    cut.a = Math.max(0, d * 0.4 - 15);
    cut.b = Math.min(d, cut.a + 30);
  }
  drawCut();
}
function drawCut() {
  const d = trackDur() || 1;
  cut.a = Math.max(0, Math.min(cut.a, d - 1));
  cut.b = Math.max(cut.a + 1, Math.min(cut.b, d));
  $("#cut-a").value = cut.a;
  $("#cut-b").value = cut.b;
  paint($("#cut-a"));
  paint($("#cut-b"));
  $("#cut-a-t").textContent = fmt(cut.a);
  $("#cut-b-t").textContent = fmt(cut.b);
  $("#cut-len").textContent = `${Math.round(cut.b - cut.a)}s`;
  $("#cut-sel").style.left = `${(cut.a / d) * 100}%`;
  $("#cut-sel").style.width = `${((cut.b - cut.a) / d) * 100}%`;
}
const jumpPreview = () => preview && (audio.currentTime = cut.a);
$("#cut-a").oninput = () => { cut.a = +$("#cut-a").value; drawCut(); };
$("#cut-b").oninput = () => { cut.b = +$("#cut-b").value; drawCut(); };
$("#cut-a").onchange = jumpPreview;
$("#cut-bar").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * trackDur();
  if (Math.abs(t - cut.a) < Math.abs(t - cut.b)) cut.a = t; else cut.b = t;
  drawCut();
  jumpPreview();
};

// preview = the player itself looping the selection
function stopPreview() {
  if (!preview) return;
  preview = false;
  $("#cut-preview").innerHTML = `${icon("play")} گوش دادن`;
}
$("#cut-preview").onclick = () => {
  if (!audio.src) return;
  if (preview) {
    stopPreview();
    audio.pause();
    return;
  }
  preview = true;
  audio.currentTime = cut.a;
  audio.play().catch(() => {});
  $("#cut-preview").innerHTML = `${icon("pause")} توقف`;
};

function encodeMp3(buffer, kbps = 192) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const enc = new lamejs.Mp3Encoder(ch, buffer.sampleRate, kbps);
  const toInt16 = (f) => {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    return out;
  };
  const left = toInt16(buffer.getChannelData(0));
  const right = ch > 1 ? toInt16(buffer.getChannelData(1)) : null;
  const chunks = [];
  for (let i = 0; i < left.length; i += 1152) {
    const l = left.subarray(i, i + 1152);
    const m = right ? enc.encodeBuffer(l, right.subarray(i, i + 1152)) : enc.encodeBuffer(l);
    if (m.length) chunks.push(new Uint8Array(m));
  }
  chunks.push(new Uint8Array(enc.flush()));
  return new Blob(chunks, { type: "audio/mpeg" });
}

/** The selection with a short fade in/out, as mp3. */
async function renderCut() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await (await songBlob(player.cur)).arrayBuffer());
  } catch {
    // the CDN copy could not be decoded here: use the bot's copy of the song
    buf = await ctx.decodeAudioData(await (await loadAudio(player.cur)).blob.arrayBuffer());
  } finally {
    ctx.close();
  }
  const sr = buf.sampleRate, dur = cut.b - cut.a;
  const off = new OfflineAudioContext(Math.min(2, buf.numberOfChannels), Math.ceil(dur * sr), sr);
  const src = off.createBufferSource();
  src.buffer = buf;
  const g = off.createGain();
  const f = Math.min(1.5, dur / 4);
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, f);
  g.gain.setValueAtTime(1, dur - f);
  g.gain.linearRampToValueAtTime(0, dur);
  src.connect(g);
  g.connect(off.destination);
  src.start(0, cut.a, dur);
  return encodeMp3(await off.startRendering());
}

$("#cut-send").onclick = async () => {
  const t = player.cur;
  if (!t) return;
  if (!window.lamejs) return toast("⚠️ اینترنت رو چک کن و دوباره امتحان کن");
  const btn = $("#cut-send");
  btn.disabled = true;
  stopPreview();
  try {
    $("#edit-status").textContent = "⏳ دارم می‌برم...";
    const bytes = new Uint8Array(await (await renderCut()).arrayBuffer());
    const PART = 700 * 1024;
    const total = Math.ceil(bytes.length / PART);
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    for (let i = 0; i < total; i++) {
      $("#edit-status").textContent = `⏳ ارسال ${Math.round(((i + 1) / total) * 100)}%`;
      const last = i === total - 1;
      await call("uploadEdit", {
        token, idx: i, data: bytesToB64(bytes.subarray(i * PART, (i + 1) * PART)), last,
        ...(last ? { meta: { id: t.id, label: `${fmt(cut.a)}-${fmt(cut.b)}` } } : {}),
      });
    }
    $("#edit-status").textContent = "✅ تو چت فرستادم";
    haptic("heavy");
  } catch (e) {
    $("#edit-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* ---------------- recognition ----------------
   1. Shazam: fingerprint made here in the browser (shazamio-core), looked up by the "shazam" endpoint
   2. the bot's paid engines if the admin set them (AudD, ACRCloud, humming, Whisper)
   3. "I sing" mode: the phone's own speech recognition turns the sung words into text -> search */
const SHAZAMIO = "https://cdn.jsdelivr.net/npm/shazamio-core@1.3.1/web/";
let shazamLib = null;
function shazamCore() {
  shazamLib ??= (async () => {
    const m = await import(SHAZAMIO + "shazamio-core.js");
    await m.default(SHAZAMIO + "shazamio-core_bg.wasm");
    return m;
  })().catch((e) => ((shazamLib = null), Promise.reject(e)));
  return shazamLib;
}

function monoSlice(buf, start, secs) {
  const from = Math.floor(start * buf.sampleRate);
  const len = Math.min(buf.length - from, Math.floor(secs * buf.sampleRate));
  const out = new Float32Array(Math.max(0, len));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] += d[from + i] / buf.numberOfChannels;
  }
  return out;
}

async function decodeBlob(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close();
  }
}

/** Shazam on a recording / file: a few 12 s windows until one matches. */
async function shazamBlob(blob, deliver = false) {
  const [m, buf] = await Promise.all([shazamCore(), decodeBlob(blob)]);
  const d = buf.duration;
  const starts = d <= 16 ? [0] : [0.15, 0.4, 0.65, 0.85].map((f) => Math.max(0, d * f - 6));
  for (const st of starts) {
    const sig = m.DecodedSignature.new(monoSlice(buf, st, 12), buf.sampleRate, 1);
    const input = { uri: sig.uri, samplems: sig.samplems, deliver };
    sig.free();
    const r = await call("shazam", input);
    if (r.match) return r;
  }
  return null;
}

let engines = null;
const getEngines = () => (engines ??= call("engines").catch(() => ({ fingerprint: false, humming: false })));

/** Status line under the microphone: kind = busy | ok | (plain) */
function listenStatus(text, kind = "") {
  const el = $("#listen-status");
  el.innerHTML = (kind === "busy" ? '<span class="spinner"></span>' : kind === "ok" ? icon("check") : "") + `<span>${esc(text)}</span>`;
}

/** Songs as a two-column grid of covers. */
function renderGrid(el, tracks) {
  el.innerHTML = "";
  el.className = "grid";
  tracks.forEach((t, i) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.innerHTML = `<img loading="lazy" src="${esc(t.thumb || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'"><b>${esc(t.title)}</b><small>${esc(t.artist || "")}</small>`;
    tile.onclick = () => { haptic(); player.playList(tracks, i); };
    el.appendChild(tile);
  });
}

function showMatch(r, el, note = "") {
  el.innerHTML = "";
  if (r.match) {
    const m = r.match;
    el.innerHTML = `<div class="match glass"><img src="${esc(m.cover || r.tracks?.[0]?.thumb || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'">
      <div class="grow-col"><h3>${esc(m.title)}</h3><p class="muted">${esc(m.artist || "")}</p></div>
      ${r.tracks?.[0] ? `<button class="gold-btn send-btn" id="match-send">${icon("send")} بفرست</button>` : ""}</div>`;
    $("#match-send") && ($("#match-send").onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      await call("sendTrack", { id: r.tracks[0].id, kind: "audio" }).then(() => toast("✅ تو چت فرستادم")).catch((x) => toast("⚠️ " + x.message));
      b.disabled = false;
    });
    haptic("heavy");
    listenStatus("پیدا شد", "ok");
  } else if (r.transcript) {
    el.innerHTML = `<div class="match glass"><div class="grow-col"><b>«${esc(r.transcript)}»</b></div></div>`;
    listenStatus("با کلمه‌هایی که خوندی گشتم");
  } else {
    listenStatus(note || "پیدا نشد؛ صدای واضح‌تر و نزدیک‌تر امتحان کن");
  }
  if (r.tracks?.length) {
    el.insertAdjacentHTML("beforeend", '<div class="section-title">نسخه‌ها</div>');
    const grid = document.createElement("div");
    el.appendChild(grid);
    renderGrid(grid, r.tracks);
  }
}

let listenMode = "song";
$$("#listen-mode button").forEach((b) => (b.onclick = () => {
  listenMode = b.dataset.mode;
  $$("#listen-mode button").forEach((x) => x.classList.toggle("on", x === b));
  $("#sing-lang").hidden = listenMode !== "sing";
  listenStatus(listenMode === "sing" ? "بزن و چند خط از آهنگ رو بخون" : "بزن و گوشی رو نزدیک صدای آهنگ بگیر");
}));
$("#sing-lang").value = store.get("singLang", "fa-IR");
$("#sing-lang").onchange = () => store.set("singLang", $("#sing-lang").value);

async function recognizeBlob(blob, spoken = "") {
  const el = $("#listen-result");
  el.innerHTML = "";
  const sing = listenMode === "sing";
  try {
    listenStatus("دارم پیدا می‌کنم…", "busy");
    const r = await shazamBlob(blob).catch((e) => (console.warn("shazam", e), null));
    if (r) return showMatch(r, el);
    const eng = await getEngines();
    if ((sing ? eng.humming : eng.fingerprint) && blob.size < 1024 * 1024) {
      const r2 = await call("recognize", { data: bytesToB64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type || "audio/webm", hum: sing });
      if (r2.match || r2.transcript) return showMatch(r2, el);
    }
    if (spoken) return showMatch({ transcript: spoken, tracks: await call("search", { q: spoken }) }, el);
    showMatch({}, el, sing ? "😕 پیدا نشد؛ کلمه‌ها رو واضح‌تر بخون یا متن آهنگ رو تو جستجو بنویس" : "");
  } catch (e) {
    listenStatus("⚠️ " + e.message);
  }
}

/* ---------------- neon mic with a spectrum on both sides ---------------- */
const MIC_BARS = [0.35, 0.7, 0.45, 0.9, 0.55, 1, 0.6, 0.8, 0.4];
function micArt(id) {
  const bar = (x, h, i) => `<rect class="b" style="--d:${(-i * 0.17).toFixed(2)}s" x="${x - 2.5}" y="${60 - h / 2}" width="5" height="${h}" rx="2.5"/>`;
  const left = MIC_BARS.map((h, i) => bar(20 + i * 8.2, 12 + h * 70, i)).join("");
  const right = [...MIC_BARS].reverse().map((h, i) => bar(155 + i * 8.2, 12 + h * 70, i + 9)).join("");
  return `<svg viewBox="0 0 240 120" fill="none" stroke="url(#${id})" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="240" y2="0" spreadMethod="reflect">
      <stop offset="0" style="stop-color:var(--gold-deep)"/><stop offset=".5" style="stop-color:var(--gold)"/><stop offset="1" style="stop-color:var(--shine)"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="-240 0" to="240 0" dur="4s" repeatCount="indefinite"/>
    </linearGradient></defs>
    <g class="bars">${left}${right}</g>
    <rect x="101" y="12" width="38" height="62" rx="19"/>
    <path d="M89 52v6a31 31 0 0 0 62 0v-6M120 89v15M106 104h28"/>
    <path d="M115 57V35l13-3v21"/><circle cx="111.5" cy="57.5" r="3.6"/><circle cx="124.5" cy="53.5" r="3.6"/>
  </svg>`;
}
$$(".mic-art .art").forEach((el, i) => (el.innerHTML = micArt(`mic-g${i}`)));

// while recording, the bars follow the microphone
function micLevels(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 64;
    ctx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const bars = $$("#listen-btn .b");
    const art = $("#listen-btn");
    art.classList.add("live");
    let on = true;
    (function loop() {
      if (!on) return;
      an.getByteFrequencyData(data);
      bars.forEach((b, i) => {
        const k = i < 9 ? 8 - i : i - 9; // low frequencies next to the mic
        b.style.transform = `scaleY(${(0.25 + (data[k + 1] / 255) * 0.95).toFixed(3)})`;
      });
      requestAnimationFrame(loop);
    })();
    return () => {
      on = false;
      art.classList.remove("live");
      bars.forEach((b) => (b.style.transform = ""));
      ctx.close().catch(() => {});
    };
  } catch {
    return () => {};
  }
}

let recorder = null;
$("#listen-btn").onclick = async () => {
  if (recorder?.state === "recording") return recorder.stop();
  shazamCore().catch(() => {}); // warm up while recording
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch {
    listenStatus("⚠️ اجازه میکروفون داده نشد؛ می‌تونی تو چت ویس بفرستی.");
    return;
  }
  const wasPlaying = !audio.paused;
  audio.pause();
  const sing = listenMode === "sing";
  let spoken = "";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let sr = null;
  if (sing && SR) {
    try {
      sr = new SR();
      sr.lang = $("#sing-lang").value;
      sr.continuous = true;
      sr.onresult = (e) => { spoken = [...e.results].map((x) => x[0].transcript).join(" ").trim(); };
      sr.onerror = () => {};
      sr.start();
    } catch { sr = null; }
  }
  const chunks = [];
  const stopLevels = micLevels(stream);
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let left = sing ? 15 : 12;
  const timer = setInterval(() => {
    left -= 1;
    $("#listen-label").textContent = `${left}`;
    if (left <= 0 && recorder.state === "recording") recorder.stop();
  }, 1000);
  recorder.onstop = () => {
    stopLevels();
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(timer);
    try { sr?.stop(); } catch {}
    $("#listen-btn").classList.remove("rec");
    $("#listen-label").textContent = "گوش بده";
    setTimeout(() => recognizeBlob(new Blob(chunks, { type: recorder.mimeType }), spoken), sr ? 700 : 0);
    if (wasPlaying) audio.play().catch(() => {});
  };
  recorder.start();
  haptic("medium");
  $("#listen-btn").classList.add("rec");
  listenStatus(sing ? "بخون…" : "دارم گوش می‌دم…", "busy");
  $("#listen-label").textContent = `${left}`;
};
$("#listen-file").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  $("#listen-result").innerHTML = "";
  listenStatus(`در حال خوندن «${f.name.slice(0, 30)}»…`, "busy");
  recognizeBlob(f);
};

/* ---------------- library ---------------- */
function mosaic(covers, big = false) {
  const c = (covers || []).filter(Boolean);
  if (!c.length) return `<div class="mosaic${big ? " big" : ""}"><div class="ph">${icon("music")}</div></div>`;
  const imgs = c.length < 4 ? [c[0]] : c.slice(0, 4);
  return `<div class="mosaic${big ? " big" : ""}${imgs.length === 1 ? " one" : ""}">${imgs.map((u) => `<img src="${esc(u)}" loading="lazy" onerror="this.src='${PLACEHOLDER}'">`).join("")}</div>`;
}

let libCache = null;
async function loadLibrary() {
  $("#lib-cards").innerHTML = '<p class="empty"><span class="spinner" style="display:inline-block"></span></p>';
  try {
    libCache = await call("library");
  } catch (e) {
    $("#lib-cards").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  const card = (key, covers, title, sub, cls = "") =>
    `<div class="card glass ${cls}" data-open="${key}">${mosaic(covers)}<div><b>${esc(title)}</b><small>${esc(sub)}</small></div></div>`;
  $("#lib-cards").innerHTML = [
    card("smart", libCache.smartCovers, "🌟 منتخب تو", `${libCache.smart.length} آهنگ · بر اساس سلیقه‌ات`, "smart"),
    card("liked", libCache.likedCovers, "❤️ لایک‌ها", `${libCache.liked.length} آهنگ`),
    ...libCache.playlists.map((p) => card(p.id, p.covers, p.name, `${p.count} آهنگ`)),
    `<div class="card glass new" id="card-new">${icon("plus").replace("<svg", '<svg width="34" height="34"')}<small>پلی‌لیست جدید</small></div>`,
  ].join("");
  $$("#lib-cards [data-open]").forEach((c) => (c.onclick = () => openCollection(c.dataset.open)));
  $("#card-new").onclick = () => $("#new-pl").click();
}

let libTracks = [];
async function openCollection(key) {
  $("#lib-root").hidden = true;
  $("#lib-detail").hidden = false;
  tg?.BackButton?.show();
  const list = $("#lib-list");
  list.innerHTML = '<p class="empty"><span class="spinner" style="display:inline-block"></span></p>';
  $("#lib-actions").innerHTML = "";
  const showHead = (title, covers, n) => {
    $("#lib-title").textContent = title;
    $("#lib-mosaic").outerHTML = mosaic(covers, true).replace('class="mosaic', 'id="lib-mosaic" class="mosaic');
    $("#lib-count").textContent = `${n} آهنگ`;
  };
  if (key === "smart" || key === "liked") {
    libTracks = libCache[key];
    showHead(key === "smart" ? "🌟 منتخب تو" : "❤️ لایک‌ها", libCache[`${key}Covers`], libTracks.length);
    renderList(list, libTracks, { emptyText: key === "smart" ? "چندتا آهنگ گوش بده تا این لیست خودکار ساخته بشه" : "هنوز چیزی لایک نکردی" });
    return;
  }
  const p = libCache.playlists.find((x) => String(x.id) === key);
  const id = Number(key);
  showHead(p?.name || "", p?.covers, p?.count || 0);
  $("#lib-actions").innerHTML = `<button class="pill" id="pl-rename">${icon("pencil")}</button><button class="pill" id="pl-del">${icon("trash")}</button>`;
  $$("#lib-actions svg").forEach((s) => s.setAttribute("width", "16"));
  $("#pl-rename").onclick = async () => {
    const name = prompt("اسم جدید:", p.name);
    if (!name) return;
    await call("playlist", { op: "rename", id, name });
    p.name = name;
    $("#lib-title").textContent = name;
  };
  $("#pl-del").onclick = async () => {
    if (!confirm("این پلی‌لیست حذف بشه؟")) return;
    await call("playlist", { op: "delete", id });
    $("#lib-back").click();
  };
  libTracks = await call("playlist", { op: "get", id });
  $("#lib-count").textContent = `${libTracks.length} آهنگ`;
  renderList(list, libTracks, {
    emptyText: "خالیه؛ از دکمه‌ی پلی‌لیست تو پلیر آهنگ اضافه کن",
    onRemove: async (t, row) => {
      await call("playlist", { op: "remove", id, trackId: t.id });
      libTracks = libTracks.filter((x) => x.id !== t.id);
      row.remove();
    },
  });
}
$("#lib-back").onclick = () => {
  $("#lib-detail").hidden = true;
  $("#lib-root").hidden = false;
  if ($("#player").hidden) tg?.BackButton?.hide();
  loadLibrary();
};
$("#lib-play").onclick = () => libTracks.length && player.playList(libTracks, 0);
$("#lib-shuffle").onclick = () => {
  if (!libTracks.length) return;
  player.mode = "shuffle";
  player.playList(libTracks, Math.floor(Math.random() * libTracks.length));
};
$("#new-pl").onclick = async () => {
  const name = prompt("اسم پلی‌لیست جدید:");
  if (!name) return;
  await call("playlist", { op: "create", name }).catch((e) => toast(e.message));
  loadLibrary();
};

/* ---------------- history ---------------- */
const KIND = { search: "🔎", recognize: "🎧", play: "▶️", download: "⬇️", edit: "✂️", open: "🔗" };
let histKind = "";
async function loadHistory() {
  const el = $("#hist-list");
  el.innerHTML = '<p class="empty"><span class="spinner" style="display:inline-block"></span></p>';
  let rows;
  try {
    rows = await call("history", histKind ? { kind: histKind } : {});
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  rows = rows.filter((r) => r.track_id || (r.query && r.query !== "-"));
  if (!rows.length) {
    el.innerHTML = '<p class="empty">تاریخچه خالیه</p>';
    return;
  }
  el.innerHTML = "";
  let lastDay = "";
  const tracks = rows.filter((r) => r.track_id).map((r) => ({ ...r, id: r.track_id }));
  rows.forEach((r) => {
    const day = new Date(r.ts * 1000).toLocaleDateString("fa-IR", { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay) {
      el.insertAdjacentHTML("beforeend", `<div class="day">${esc(day)}</div>`);
      lastDay = day;
    }
    const row = document.createElement("div");
    if (r.track_id) {
      row.className = "item";
      row.innerHTML = `<img loading="lazy" src="${esc(r.thumb || PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'">
        <div class="meta"><b>${esc(r.title)}</b><small>${KIND[r.kind] || ""} ${esc(r.artist || "")}</small></div>`;
      row.onclick = () => player.playList(tracks, tracks.findIndex((t) => t.id === r.track_id));
    } else {
      row.className = "qline";
      row.textContent = `${KIND[r.kind] || ""} ${r.query || ""}`;
      row.onclick = () => {
        showView("v-search");
        $("#q").value = r.query || "";
        doSearch(r.query || "");
      };
    }
    el.appendChild(row);
  });
}
$$("#hist-chips .chip").forEach((c) => (c.onclick = () => {
  histKind = c.dataset.kind;
  $$("#hist-chips .chip").forEach((x) => x.classList.toggle("on", x === c));
  loadHistory();
}));
$("#hist-clear").onclick = async () => {
  if (!confirm("کل تاریخچه پاک بشه؟")) return;
  await call("history", { clear: true });
  loadHistory();
};

/* ---------------- opened from the chat ----------------
   ?rec=1              find the song of the voice / video / link just sent; the bot sends it to the chat
   ?t=ID [&edit=1 [&a=&b=]]   play a track (and open the cutter) */
async function runChatRecognition() {
  $("#rec-screen").hidden = false;
  $("#rec-actions").hidden = true;
  $("#rec-title").textContent = "دارم پیدا می‌کنم…";
  $("#rec-sub").textContent = "";
  try {
    shazamCore().catch(() => {});
    const blob = await fetchParts("pendingSample", {}, (n, total) => total > 1 && ($("#rec-sub").textContent = `${Math.round((n / total) * 100)}%`));
    $("#rec-sub").textContent = "";
    const r = await shazamBlob(blob, true);
    if (r?.match) {
      haptic("heavy");
      $("#rec-title").textContent = `✅ ${r.match.title}`;
      $("#rec-sub").textContent = `${r.match.artist || ""} — تو چت برات فرستادم`;
      setTimeout(() => tg?.close?.(), 1800);
      return;
    }
    $("#rec-title").textContent = "😕 پیدا نشد";
    $("#rec-sub").textContent = "صدای آهنگ باید واضح باشه؛ یه تیکه‌ی دیگه بفرست یا اسمش رو بنویس.";
  } catch (e) {
    $("#rec-title").textContent = "⚠️ نشد";
    $("#rec-sub").textContent = e.message;
  }
  $("#rec-actions").hidden = false;
}
$("#rec-retry").onclick = runChatRecognition;
$("#rec-close").onclick = () => ($("#rec-screen").hidden = true);

(async () => {
  const p = new URLSearchParams(location.search);
  if (p.get("rec")) return runChatRecognition();
  const tid = p.get("t");
  if (!tid) return;
  try {
    const t = await call("track", { id: Number(tid) });
    player.playList([t], 0);
    if (!p.get("edit")) return;
    togglePanel("edit", true);
    const a = parseFloat(p.get("a")), b = parseFloat(p.get("b"));
    if (isFinite(a) && isFinite(b)) {
      cut.track = t.id;
      cut.a = a;
      cut.b = b;
      drawCut();
    }
  } catch (e) {
    toast(e.message);
  }
})();
