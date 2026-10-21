"use strict";
// Mini App: player, library, history, live recognition and an in-browser audio editor.
// The backend is the bot's Telegram Serverless endpoints (tgcloud/endpoints/*), called
// with Telegram.WebApp.Serverless.call.
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.initData) document.documentElement.dataset.tg = "1";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => {
  if (!isFinite(s) || s <= 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};
const PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#8884"/><text x="5" y="6.6" font-size="5" text-anchor="middle">♪</text></svg>');
const haptic = (t = "light") => tg?.HapticFeedback?.impactOccurred(t);

function toast(msg, ms = 2500) {
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
      reject(new Error(err.type === "UNAUTHORIZED" ? "مینی‌اپ رو از داخل ربات باز کن" : err.message || "خطا"));
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

/* ---------------- tabs ---------------- */
function showView(id) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === id));
  if (id === "v-library") loadLibrary();
  if (id === "v-history") loadHistory();
}
$$(".tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

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
      <div class="meta"><b>${esc(t.title)}</b><small>${esc(t.artist || "")}${t.duration ? " · " + fmt(t.duration) : ""}<span class="badge">${esc(t.source || "")}</span></small></div>
      ${onRemove ? '<button class="icon more" title="حذف">✕</button>' : ""}`;
    row.onclick = (e) => {
      if (e.target.closest(".more")) {
        e.stopPropagation();
        onRemove(t, row);
        return;
      }
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
  lastQuery = q.replace(/ (remix|live|cover|slowed reverb)$/, "");
  const el = $("#search-results");
  el.innerHTML = '<p class="empty">🔎 در حال جستجو...</p>';
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
// Track audio comes from the bot in base64 parts; kept in memory for the session.
const audioCache = new Map(); // id -> Promise<{ blob, url }>
function loadAudio(t, onProgress) {
  if (!audioCache.has(t.id)) {
    const p = (async () => {
      const first = await call("audioChunk", { id: t.id, idx: 0 });
      const parts = [b64ToBytes(first.data)];
      onProgress?.(1, first.total);
      for (let i = 1; i < first.total; i++) {
        parts.push(b64ToBytes((await call("audioChunk", { id: t.id, idx: i })).data));
        onProgress?.(i + 1, first.total);
      }
      const blob = new Blob(parts, { type: first.mime });
      return { blob, url: URL.createObjectURL(blob) };
    })();
    p.catch(() => audioCache.delete(t.id));
    audioCache.set(t.id, p);
  }
  return audioCache.get(t.id);
}

/* ---------------- player ---------------- */
const audio = $("#audio");
const player = {
  queue: [], idx: -1, cur: null,
  repeat: "off", // off | all | one
  shuffle: false,
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
    const t = this.cur;
    const seq = ++this.loadSeq;
    stopPreview();
    audio.pause();
    this.render();
    setupCut();
    const loading = $("#p-loading");
    loading.hidden = false;
    loading.textContent = "⏳ در حال آماده‌سازی...";
    try {
      const { url } = await loadAudio(t, (n, total) => {
        if (seq === this.loadSeq) loading.textContent = `⏳ دریافت ${n} از ${total}`;
      });
      if (seq !== this.loadSeq) return;
      audio.src = url;
      audio.playbackRate = +$("#p-rate").value;
      if (autoplay) audio.play().catch(() => {});
      call("played", { id: t.id }).catch(() => {});
      preloadNext();
    } catch (e) {
      if (seq !== this.loadSeq) return;
      loading.hidden = true;
      toast("⚠️ " + e.message, 4000);
    }
  },
  render() {
    const t = this.cur;
    if (!t) return;
    $("#mini").hidden = false;
    $("#mini-cover").src = $("#p-cover").src = t.thumb || PLACEHOLDER;
    $("#mini-title").textContent = $("#p-title").textContent = t.title;
    $("#mini-artist").textContent = $("#p-artist").textContent = t.artist || "";
    $("#player-src").textContent = `${this.idx + 1} / ${this.queue.length} · ${t.source || ""}`;
    $("#p-like").textContent = t.liked ? "❤️" : "🤍";
    $("#p-shuffle").classList.toggle("active", this.shuffle);
    $("#p-repeat").classList.toggle("active", this.repeat !== "off");
    $("#p-repeat").textContent = this.repeat === "one" ? "🔂" : "🔁";
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
    if (this.shuffle && n > 1) {
      let j;
      do j = Math.floor(Math.random() * n); while (j === this.idx);
      return j;
    }
    const j = this.idx + dir;
    if (j >= n) return this.repeat === "all" ? 0 : -1;
    if (j < 0) return this.repeat === "all" ? n - 1 : 0;
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
    audio.paused ? audio.play() : audio.pause();
  },
};

// fetch the next track in the background so skipping is instant
function preloadNext() {
  if (player.shuffle) return;
  const t = player.queue[player.idx + 1];
  if (t) loadAudio(t).catch(() => {});
}

audio.addEventListener("play", () => ($("#p-play").textContent = $("#mini-play").textContent = "⏸"));
audio.addEventListener("pause", () => ($("#p-play").textContent = $("#mini-play").textContent = "▶"));
audio.addEventListener("canplay", () => ($("#p-loading").hidden = true));
audio.addEventListener("loadedmetadata", () => {
  $("#t-dur").textContent = fmt(audio.duration);
  setupCut();
});
audio.addEventListener("timeupdate", () => {
  const d = audio.duration || 0, c = audio.currentTime;
  if (!seeking) $("#seek").value = d ? (c / d) * 1000 : 0;
  $("#t-cur").textContent = fmt(c);
  $("#mini-bar").style.width = d ? `${(c / d) * 100}%` : "0";
  if (d && !preview) $("#cut-head").style.left = `${(c / d) * 100}%`;
});
audio.addEventListener("ended", () => {
  if (player.repeat === "one") {
    audio.currentTime = 0;
    audio.play();
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
  haptic();
  player.toggle();
};
$("#p-next").onclick = $("#mini-next").onclick = (e) => {
  e.stopPropagation();
  player.next();
};
$("#p-prev").onclick = () => player.prev();
$("#p-back10").onclick = () => (audio.currentTime = Math.max(0, audio.currentTime - 10));
$("#p-fwd10").onclick = () => (audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10));
$("#p-rate").onchange = () => (audio.playbackRate = +$("#p-rate").value);
$("#p-shuffle").onclick = () => {
  player.shuffle = !player.shuffle;
  toast(player.shuffle ? "🔀 پخش تصادفی روشن" : "پخش تصادفی خاموش");
  player.render();
};
$("#p-repeat").onclick = () => {
  player.repeat = { off: "all", all: "one", one: "off" }[player.repeat];
  toast({ off: "تکرار خاموش", all: "🔁 تکرار همه", one: "🔂 تکرار همین آهنگ" }[player.repeat]);
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
    if (x0 !== null) $("#p-cover").style.transform = `translateX(${(e.touches[0].clientX - x0) / 3}px)`;
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
  tg?.BackButton?.show();
}
function closePlayer() {
  $("#player").hidden = true;
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
  if (name === "queue") renderQueue();
  if (name === "edit") setupCut();
  if (!$(`#panel-${name}`).hidden) setTimeout(() => $(`#panel-${name}`).scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
}
$$("[data-panel]").forEach((b) => (b.onclick = () => togglePanel(b.dataset.panel)));
$("#player-queue-btn").onclick = () => togglePanel("queue");

function renderQueue() {
  renderList($("#queue-list"), player.queue);
  [...$("#queue-list").children].forEach((row, i) => (row.onclick = () => player.load(i, true)));
}

/* send to chat */
["128", "192", "320"].forEach((q) => $("#send-audio").insertAdjacentHTML("beforeend", `<button class="btn" data-send="audio:${q}">${q} kbps</button>`));
["360", "480", "720", "1080"].forEach((q) => $("#send-video").insertAdjacentHTML("beforeend", `<button class="btn" data-send="video:${q}">${q}p</button>`));
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-send]");
  if (!b || !player.cur) return;
  const [kind, quality] = b.dataset.send.split(":");
  b.disabled = true;
  toast("⏳ دارم آماده می‌کنم؛ تو چت ربات می‌فرستم...", 4000);
  try {
    await call("sendTrack", { id: player.cur.id, kind, quality });
    toast("✅ تو چت ربات فرستادم");
    haptic("medium");
  } catch (err) {
    toast("⚠️ " + err.message, 4000);
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
  if (p) await add(String(p.id)).catch((e) => toast(e.message));
  else {
    await call("playlist", { op: "create", name: pick, trackId: t.id }).catch((e) => toast(e.message));
    toast("✅ پلی‌لیست ساخته شد");
  }
};

$("#p-remix").onclick = async () => {
  const t = player.cur;
  if (!t) return;
  toast("🔁 دنبال ریمیکس‌ها...");
  const list = await call("remixes", { id: t.id }).catch((e) => (toast(e.message), null));
  if (!list?.length) return toast("ریمیکسی پیدا نشد");
  closePlayer();
  showView("v-search");
  $("#q").value = `${t.artist || ""} ${t.title} remix`.trim();
  renderList($("#search-results"), list);
};

/* ---------------- editor: cut, ringtone, effects (Web Audio, in the browser) ---------------- */
const cut = { a: 0, b: 30, fx: "", track: null };
const trackDur = () => audio.duration || player.cur?.duration || 0;

function setupCut() {
  const d = trackDur();
  if (!d) return;
  ["#cut-a", "#cut-b"].forEach((s) => ($(s).max = d.toFixed(1)));
  if (cut.track !== player.cur?.id) {
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
  $("#cut-a-t").textContent = fmt(cut.a);
  $("#cut-b-t").textContent = fmt(cut.b);
  $("#cut-len").textContent = `${Math.round(cut.b - cut.a)}s`;
  $("#cut-sel").style.left = `${(cut.a / d) * 100}%`;
  $("#cut-sel").style.width = `${((cut.b - cut.a) / d) * 100}%`;
}
const restartPreview = () => preview && startPreview();
$("#cut-a").oninput = () => { cut.a = +$("#cut-a").value; drawCut(); };
$("#cut-b").oninput = () => { cut.b = +$("#cut-b").value; drawCut(); };
$("#cut-a").onchange = $("#cut-b").onchange = restartPreview;
$$("[data-nudge]").forEach((b) => (b.onclick = () => {
  const [k, v] = b.dataset.nudge.split(":");
  cut[k] += +v;
  drawCut();
  restartPreview();
}));
$$("[data-mark]").forEach((b) => (b.onclick = () => {
  cut[b.dataset.mark] = audio.currentTime;
  drawCut();
  restartPreview();
}));
$("#cut-whole").onclick = () => { cut.a = 0; cut.b = trackDur(); drawCut(); restartPreview(); };
$("#cut-ring").onclick = () => { const d = trackDur(); cut.a = Math.max(0, d * 0.4 - 15); cut.b = Math.min(d, cut.a + 30); drawCut(); restartPreview(); };
$("#cut-bar").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * trackDur();
  if (Math.abs(t - cut.a) < Math.abs(t - cut.b)) cut.a = t; else cut.b = t;
  drawCut();
  restartPreview();
};
$$("#fx-chips .chip").forEach((c) => (c.onclick = () => {
  cut.fx = c.dataset.fx;
  $$("#fx-chips .chip").forEach((x) => x.classList.toggle("on", x === c));
  restartPreview();
}));

const RATE = { slow: 0.85, fast: 1.2 };
let decoded = { id: null, buffer: null };
async function getBuffer() {
  const t = player.cur;
  if (decoded.id === t.id) return decoded.buffer;
  $("#edit-status").textContent = "⏳ آماده‌سازی صدا...";
  const { blob } = await loadAudio(t);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  decoded = { id: t.id, buffer };
  $("#edit-status").textContent = "";
  return buffer;
}

function impulse(ctx, seconds = 2.5) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  return buf;
}

/** The effect chain between a source and ctx.destination; the same graph plays live and renders offline. */
function buildGraph(ctx, buffer, { a, b, fx, fade }) {
  const rate = RATE[fx] || 1;
  const outDur = (b - a) / rate;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  let node = src;
  const link = (n) => (node.connect(n), (node = n));

  if (fx === "karaoke" && buffer.numberOfChannels > 1) {
    // left minus right removes what is mixed in the centre: usually the vocals
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const l = ctx.createGain(), r = ctx.createGain();
    r.gain.value = -1;
    node.connect(split);
    split.connect(l, 0);
    split.connect(r, 1);
    for (const g of [l, r]) { g.connect(merge, 0, 0); g.connect(merge, 0, 1); }
    node = merge;
  }
  if (fx === "bass") {
    const f = ctx.createBiquadFilter();
    f.type = "lowshelf"; f.frequency.value = 110; f.gain.value = 12;
    link(f);
    link(ctx.createDynamicsCompressor());
  }
  if (fx === "loud") {
    const g = ctx.createGain();
    g.gain.value = 1.8;
    link(g);
    link(ctx.createDynamicsCompressor());
  }
  if (fx === "8d") {
    const p = ctx.createStereoPanner();
    const steps = Math.max(2, Math.ceil(outDur * 20));
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = 0.9 * Math.sin((2 * Math.PI * 0.09 * i) / 20);
    p.pan.setValueCurveAtTime(curve, ctx.currentTime, outDur);
    link(p);
  }
  const out = ctx.createGain();
  if (fade) {
    const f = Math.min(2, outDur / 4), t0 = ctx.currentTime;
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(1, t0 + f);
    out.gain.setValueAtTime(1, t0 + outDur - f);
    out.gain.linearRampToValueAtTime(0, t0 + outDur);
  }
  if (fx === "slow") {
    const wet = ctx.createGain(), conv = ctx.createConvolver();
    wet.gain.value = 0.35;
    conv.buffer = impulse(ctx);
    node.connect(conv);
    conv.connect(wet);
    wet.connect(out);
  }
  node.connect(out);
  out.connect(ctx.destination);
  src.start(ctx.currentTime, a, b - a);
  return { src, outDur };
}

let preview = null; // { ctx, src }
function stopPreview() {
  if (!preview) return;
  try { preview.src.stop(); } catch {}
  preview.ctx.close();
  preview = null;
  $("#cut-preview").textContent = "▶ گوش دادن زنده";
}
async function startPreview() {
  const buffer = await getBuffer();
  if (preview) { try { preview.src.stop(); } catch {} preview.ctx.close(); }
  audio.pause();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const { src } = buildGraph(ctx, buffer, { a: cut.a, b: cut.b, fx: cut.fx, fade: $("#cut-fade").checked });
  preview = { ctx, src };
  src.onended = () => preview?.src === src && startPreview(); // loop the selection
  $("#cut-preview").textContent = "⏹ توقف";
}
$("#cut-preview").onclick = () => (preview ? stopPreview() : startPreview().catch((e) => toast("⚠️ " + e.message)));

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

async function renderEdit() {
  const buffer = await getBuffer();
  const rate = RATE[cut.fx] || 1;
  const sr = buffer.sampleRate;
  const len = Math.ceil(((cut.b - cut.a) / rate) * sr);
  const off = new OfflineAudioContext(Math.min(2, buffer.numberOfChannels), len, sr);
  buildGraph(off, buffer, { a: cut.a, b: cut.b, fx: cut.fx, fade: $("#cut-fade").checked });
  $("#edit-status").textContent = "🎛 در حال پردازش...";
  const rendered = await off.startRendering();
  $("#edit-status").textContent = "💾 ساخت mp3...";
  await new Promise((r) => setTimeout(r, 30));
  return encodeMp3(rendered);
}

$("#cut-send").onclick = async () => {
  const t = player.cur;
  if (!t) return;
  if (!window.lamejs) return toast("⚠️ کتابخانه mp3 لود نشد؛ اینترنت رو چک کن");
  const btn = $("#cut-send");
  btn.disabled = true;
  stopPreview();
  try {
    const blob = await renderEdit();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const PART = 700 * 1024;
    const total = Math.ceil(bytes.length / PART);
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const fxLabel = $(`#fx-chips [data-fx="${cut.fx}"]`)?.textContent.replace(/^\S+\s/, "") || "";
    const label = [`${fmt(cut.a)}-${fmt(cut.b)}`, cut.fx && fxLabel].filter(Boolean).join(" ");
    for (let i = 0; i < total; i++) {
      $("#edit-status").textContent = `📤 ارسال ${i + 1} از ${total}...`;
      const last = i === total - 1;
      await call("uploadEdit", {
        token, idx: i, data: bytesToB64(bytes.subarray(i * PART, (i + 1) * PART)), last,
        ...(last ? { meta: { id: t.id, label, voice: $("#cut-fmt").value === "voice" } } : {}),
      });
    }
    $("#edit-status").textContent = "✅ تو چت ربات فرستادم";
    haptic("heavy");
  } catch (e) {
    $("#edit-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* ---------------- listen (recognition) ---------------- */
// Shazam fingerprints are computed here, in the browser (WebAssembly can't run on the bot's
// serverless backend); the "shazam" endpoint only asks Shazam's API what the fingerprint is.
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

async function decodeBlob(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close();
  }
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

/** Shazam on a recording / file: a few 12 s windows until one matches. -> endpoint result or null */
async function shazamBlob(blob) {
  const [m, buf] = await Promise.all([shazamCore(), decodeBlob(blob)]);
  const d = buf.duration;
  const starts = d <= 16 ? [0] : [0.2, 0.45, 0.7].map((f) => Math.max(0, d * f - 6));
  for (const st of starts) {
    const sig = m.DecodedSignature.new(monoSlice(buf, st, 12), buf.sampleRate, 1);
    const input = { uri: sig.uri, samplems: sig.samplems };
    sig.free();
    const r = await call("shazam", input);
    if (r.match) return r;
  }
  return null;
}

function showRecognition(r, el) {
  if (r.match) {
    const m = r.match;
    el.innerHTML = `<div class="match"><img src="${esc(m.cover || r.tracks[0]?.thumb || PLACEHOLDER)}"><div>
      <h3>${esc(m.title)}</h3><p class="muted">${esc(m.artist || "")}${m.album ? " · " + esc(m.album) : ""}</p><small>با ${esc(m.engine)}</small></div></div>`;
    haptic("heavy");
    $("#listen-status").textContent = "✅ پیدا شد!";
  } else if (r.transcript) {
    el.innerHTML = `<div class="match"><div><b>📝 چیزی که شنیدم:</b><p>«${esc(r.transcript)}»</p>
      ${r.lyricHits.length ? "<small>آهنگ‌هایی با این متن: " + r.lyricHits.map(esc).join("، ") + "</small>" : ""}</div></div>`;
    $("#listen-status").textContent = "با متنی که خوندی گشتم 👇";
  } else {
    $("#listen-status").textContent = "😕 پیدا نشد؛ نزدیک‌تر یا با صدای واضح‌تر امتحان کن، یا یه تیکه از متن آهنگ رو جستجو کن";
  }
  const list = document.createElement("div");
  list.className = "list";
  el.appendChild(list);
  if (r.tracks?.length) renderList(list, r.tracks);
}

let recorder = null;
async function recognizeBlob(blob) {
  const el = $("#listen-result");
  el.innerHTML = "";
  const hum = $("#hum").checked;
  try {
    if (!hum) {
      $("#listen-status").textContent = "🔍 دارم با Shazam پیدا می‌کنم...";
      const r = await shazamBlob(blob).catch((e) => (console.warn("shazam", e), null));
      if (r) return showRecognition(r, el);
    }
    // humming / singing, or Shazam didn't know it: the bot's other engines (AudD, ACRCloud, Whisper)
    if (blob.size > 6 * 1024 * 1024) throw new Error("پیدا نشد؛ یه تیکه کوتاه‌تر (زیر ۶ مگ) امتحان کن");
    $("#listen-status").textContent = hum ? "🎤 دارم به صدات گوش می‌دم..." : "🔍 دارم بیشتر می‌گردم...";
    const r = await call("recognize", {
      data: bytesToB64(new Uint8Array(await blob.arrayBuffer())),
      mime: blob.type || "audio/webm",
      hum,
    });
    if (!r.match && !r.transcript && !r.configured && hum) {
      $("#listen-status").textContent = "⚠️ تشخیص زمزمه هنوز تنظیم نشده (ادمین باید کلید ACRCloud یا Whisper رو وارد کنه)";
      return;
    }
    showRecognition(r, el);
  } catch (e) {
    $("#listen-status").textContent = "⚠️ " + e.message;
  }
}

$("#listen-btn").onclick = async () => {
  if (recorder?.state === "recording") return recorder.stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch {
    $("#listen-status").textContent = "⚠️ اجازه میکروفون داده نشد. می‌تونی تو چت ربات ویس بفرستی.";
    return;
  }
  const wasPlaying = !audio.paused;
  audio.pause();
  stopPreview();
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const secs = $("#hum").checked ? 15 : 12;
  let left = secs;
  const timer = setInterval(() => {
    left -= 1;
    $("#listen-label").innerHTML = `${left}<br>ثانیه`;
    if (left <= 0 && recorder.state === "recording") recorder.stop();
  }, 1000);
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(timer);
    $("#listen-btn").classList.remove("rec");
    $("#listen-label").innerHTML = "🎧<br>گوش بده";
    recognizeBlob(new Blob(chunks, { type: recorder.mimeType }));
    if (wasPlaying) audio.play();
  };
  recorder.start();
  haptic("medium");
  $("#listen-btn").classList.add("rec");
  $("#listen-status").textContent = $("#hum").checked ? "🎤 بخون یا زمزمه کن..." : "👂 دارم گوش می‌دم...";
  $("#listen-label").innerHTML = `${left}<br>ثانیه`;
};
$("#listen-file").onchange = (e) => {
  const f = e.target.files[0];
  if (f) recognizeBlob(f);
  e.target.value = "";
};

/* ---------------- library ---------------- */
let libCache = null;
async function loadLibrary() {
  $("#lib-cards").innerHTML = '<p class="empty">...</p>';
  try {
    libCache = await call("library");
  } catch (e) {
    $("#lib-cards").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  const cards = [
    `<div class="card smart" data-open="smart"><span class="ico">🌟</span><div><b>منتخب تو</b><br><small>${libCache.smart.length} آهنگ · خودکار از چیزایی که بیشتر گوش دادی، دانلود و لایک کردی</small></div></div>`,
    `<div class="card" data-open="liked"><span class="ico">❤️</span><div><b>لایک‌ها</b><br><small>${libCache.liked.length} آهنگ</small></div></div>`,
    ...libCache.playlists.map((p) => `<div class="card" data-open="${p.id}"><span class="ico">📁</span><div><b>${esc(p.name)}</b><br><small>${p.count} آهنگ</small></div></div>`),
  ];
  $("#lib-cards").innerHTML = cards.join("");
  $$("#lib-cards [data-open]").forEach((c) => (c.onclick = () => openCollection(c.dataset.open)));
}

let libTracks = [];
async function openCollection(key) {
  $("#lib-root").hidden = true;
  $("#lib-detail").hidden = false;
  tg?.BackButton?.show();
  const list = $("#lib-list");
  list.innerHTML = '<p class="empty">...</p>';
  $("#lib-actions").innerHTML = "";
  if (key === "smart" || key === "liked") {
    $("#lib-title").textContent = key === "smart" ? "🌟 منتخب تو" : "❤️ لایک‌ها";
    libTracks = libCache[key];
    renderList(list, libTracks, { emptyText: key === "smart" ? "هنوز چیزی گوش ندادی؛ چندتا آهنگ پخش یا دانلود کن تا لیستت ساخته بشه" : "هنوز چیزی لایک نکردی" });
    return;
  }
  const p = libCache.playlists.find((x) => String(x.id) === key);
  const id = Number(key);
  $("#lib-title").textContent = "📁 " + (p?.name || "");
  $("#lib-actions").innerHTML = '<button class="icon" id="pl-rename">✏️</button><button class="icon" id="pl-del">🗑</button>';
  $("#pl-rename").onclick = async () => {
    const name = prompt("اسم جدید:", p.name);
    if (!name) return;
    await call("playlist", { op: "rename", id, name });
    p.name = name;
    $("#lib-title").textContent = "📁 " + name;
  };
  $("#pl-del").onclick = async () => {
    if (!confirm("این پلی‌لیست حذف بشه؟")) return;
    await call("playlist", { op: "delete", id });
    $("#lib-back").click();
  };
  libTracks = await call("playlist", { op: "get", id });
  renderList(list, libTracks, {
    emptyText: "خالیه؛ از دکمه ➕ تو پلیر آهنگ اضافه کن",
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
  player.shuffle = true;
  player.playList(libTracks, Math.floor(Math.random() * libTracks.length));
};
$("#new-pl").onclick = async () => {
  const name = prompt("اسم پلی‌لیست جدید:");
  if (!name) return;
  await call("playlist", { op: "create", name }).catch((e) => toast(e.message));
  loadLibrary();
};

/* ---------------- history ---------------- */
const KIND = { search: "🔎", recognize: "🎙", play: "▶️", download: "⬇️", edit: "✂️", open: "👁" };
let histKind = "";
async function loadHistory() {
  const el = $("#hist-list");
  el.innerHTML = '<p class="empty">...</p>';
  let rows;
  try {
    rows = await call("history", histKind ? { kind: histKind } : {});
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
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
        <div class="meta"><b>${KIND[r.kind] || ""} ${esc(r.title)}</b><small>${esc(r.artist || "")} ${r.query ? "· " + esc(r.query) : ""}</small></div>`;
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

/* ---------------- deep links from the chat ----------------
   ?rec=1                       recognize the voice/video just sent in the chat
   ?t=ID&shazam=1               recognize the song of a track/link
   ?t=ID&edit=cut|ringtone|slow|...&a=&b=   open the editor */
(async () => {
  const p = new URLSearchParams(location.search);
  const tid = p.get("t");
  if (p.get("rec") || p.get("shazam")) {
    showView("v-listen");
    $("#listen-status").textContent = "⏳ دریافت فایل...";
    try {
      let blob;
      if (p.get("rec")) {
        const f = await call("pendingSample");
        blob = new Blob([b64ToBytes(f.data)], { type: f.mime });
      } else {
        blob = (await loadAudio({ id: Number(tid) }, (n, total) => ($("#listen-status").textContent = `⏳ دریافت ${n} از ${total}`))).blob;
      }
      await recognizeBlob(blob);
    } catch (e) {
      $("#listen-status").textContent = "⚠️ " + e.message;
    }
    return;
  }
  if (!tid) return;
  try {
    const t = await call("track", { id: Number(tid) });
    player.playList([t], 0);
    const edit = p.get("edit");
    if (!edit) return;
    togglePanel("edit", true);
    if (edit !== "cut" && edit !== "ringtone") $(`#fx-chips [data-fx="${edit}"]`)?.click();
    if (edit === "ringtone") cut.track = null; // default selection is the 30 s ringtone part
    const a = parseFloat(p.get("a")), b = parseFloat(p.get("b"));
    if (isFinite(a) && isFinite(b)) {
      cut.track = t.id;
      cut.a = a;
      cut.b = b;
    } else if (edit !== "ringtone" && edit !== "cut") {
      cut.track = t.id;
      cut.a = 0;
      cut.b = t.duration || 600;
    }
    drawCut();
  } catch (e) {
    toast(e.message);
  }
})();
