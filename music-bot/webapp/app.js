"use strict";
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

async function api(path, opts = {}) {
  const headers = { "X-Init-Data": tg?.initData || "", ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || (r.status === 401 ? "مینی‌اپ رو از داخل ربات باز کن" : `خطا ${r.status}`));
  return data;
}

/* ---------------- tabs ---------------- */
function showView(id) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === id));
  if (id === "v-library") loadLibrary();
  if (id === "v-history") loadHistory();
}
$$(".tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

/* ---------------- track list rendering ---------------- */
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
    renderList(el, await api(`/api/search?q=${encodeURIComponent(q)}`), { emptyText: "چیزی پیدا نشد 😕" });
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

/* ---------------- player ---------------- */
const audio = $("#audio");
const player = {
  queue: [], idx: -1, cur: null,
  repeat: "off", // off | all | one
  shuffle: false,
  loop: null, // [a, b] while previewing a cut

  playList(tracks, i) {
    this.queue = tracks.slice();
    this.load(i, true);
    openPlayer();
  },
  load(i, autoplay) {
    if (i < 0 || i >= this.queue.length) return;
    this.idx = i;
    this.cur = this.queue[i];
    this.loop = null;
    const t = this.cur;
    $("#p-loading").hidden = false;
    audio.src = t.stream;
    audio.playbackRate = +$("#p-rate").value;
    if (autoplay) audio.play().catch(() => {});
    api(`/api/play/${t.id}`, { method: "POST" }).catch(() => {});
    this.render();
    setupCut();
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
    $$(".item").forEach((el) => el.classList.remove("playing"));
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
    if (!this.cur) return;
    audio.paused ? audio.play() : audio.pause();
  },
};

audio.addEventListener("play", () => ($("#p-play").textContent = $("#mini-play").textContent = "⏸"));
audio.addEventListener("pause", () => ($("#p-play").textContent = $("#mini-play").textContent = "▶"));
audio.addEventListener("canplay", () => ($("#p-loading").hidden = true));
audio.addEventListener("waiting", () => ($("#p-loading").hidden = false));
audio.addEventListener("playing", () => ($("#p-loading").hidden = true));
audio.addEventListener("error", () => {
  $("#p-loading").hidden = true;
  if (player.cur) toast("پخش این آهنگ ممکن نشد؛ بعدی...");
  setTimeout(() => player.next(false), 1200);
});
audio.addEventListener("loadedmetadata", () => {
  $("#t-dur").textContent = fmt(audio.duration);
  setupCut();
});
audio.addEventListener("timeupdate", () => {
  const d = audio.duration || 0, c = audio.currentTime;
  if (player.loop && c >= player.loop[1]) audio.currentTime = player.loop[0];
  if (!seeking) $("#seek").value = d ? (c / d) * 1000 : 0;
  $("#t-cur").textContent = fmt(c);
  $("#mini-bar").style.width = d ? `${(c / d) * 100}%` : "0";
  if (d) $("#cut-head").style.left = `${(c / d) * 100}%`;
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
  const r = await api(`/api/like/${t.id}`, { method: "POST" });
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
  if (name === "cut") setupCut();
  if (!$(`#panel-${name}`).hidden) setTimeout(() => $(`#panel-${name}`).scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
}
$$("[data-panel]").forEach((b) => (b.onclick = () => togglePanel(b.dataset.panel)));
$("#player-queue-btn").onclick = () => togglePanel("queue");

function renderQueue() {
  renderList($("#queue-list"), player.queue);
  // clicking a queue item keeps the queue, just jumps
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
    await api("/api/send", { method: "POST", json: { track_id: player.cur.id, kind, quality } });
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
  if (!player.cur) return;
  const lib = await api("/api/library");
  const buttons = lib.playlists.slice(0, 4).map((p) => ({ id: String(p.id), type: "default", text: p.name }));
  buttons.push({ id: "new", type: "default", text: "➕ پلی‌لیست جدید" });
  const add = async (id) => {
    if (!id) return;
    if (id === "new") {
      const name = prompt("اسم پلی‌لیست:");
      if (!name) return;
      await api("/api/playlists", { method: "POST", json: { name, track_id: player.cur.id } });
    } else await api(`/api/playlists/${id}/tracks/${player.cur.id}`, { method: "POST" });
    toast("✅ اضافه شد");
  };
  if (tg?.showPopup && buttons.length <= 3) tg.showPopup({ title: "افزودن به پلی‌لیست", message: player.cur.title.slice(0, 60), buttons }, add);
  else {
    const names = lib.playlists.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    const pick = prompt(`شماره پلی‌لیست یا اسم پلی‌لیست جدید:\n${names}`);
    if (!pick) return;
    const p = lib.playlists[+pick - 1];
    if (p) add(String(p.id));
    else {
      await api("/api/playlists", { method: "POST", json: { name: pick, track_id: player.cur.id } });
      toast("✅ پلی‌لیست ساخته شد");
    }
  }
};

$("#p-remix").onclick = async () => {
  if (!player.cur) return;
  toast("🔁 دنبال ریمیکس‌ها...");
  const list = await api(`/api/remixes/${player.cur.id}`).catch((e) => (toast(e.message), null));
  if (!list?.length) return toast("ریمیکسی پیدا نشد");
  closePlayer();
  showView("v-search");
  $("#q").value = `${player.cur.artist || ""} ${player.cur.title} remix`.trim();
  renderList($("#search-results"), list);
};

/* ---------------- cutter ---------------- */
const cut = { a: 0, b: 30 };
function setupCut() {
  const d = audio.duration || player.cur?.duration || 0;
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
  const d = audio.duration || player.cur?.duration || 1;
  cut.a = Math.max(0, Math.min(cut.a, d - 1));
  cut.b = Math.max(cut.a + 1, Math.min(cut.b, d));
  $("#cut-a").value = cut.a;
  $("#cut-b").value = cut.b;
  $("#cut-a-t").textContent = fmt(cut.a);
  $("#cut-b-t").textContent = fmt(cut.b);
  $("#cut-len").textContent = `${Math.round(cut.b - cut.a)}s`;
  $("#cut-sel").style.left = `${(cut.a / d) * 100}%`;
  $("#cut-sel").style.width = `${((cut.b - cut.a) / d) * 100}%`;
  if (player.loop) player.loop = [cut.a, cut.b];
}
$("#cut-a").oninput = () => { cut.a = +$("#cut-a").value; drawCut(); };
$("#cut-b").oninput = () => { cut.b = +$("#cut-b").value; drawCut(); };
$("#cut-a").onchange = () => { if (player.loop) audio.currentTime = cut.a; };
$$("[data-nudge]").forEach((b) => (b.onclick = () => {
  const [k, v] = b.dataset.nudge.split(":");
  cut[k] += +v;
  drawCut();
  if (k === "a") audio.currentTime = cut.a;
}));
$$("[data-mark]").forEach((b) => (b.onclick = () => {
  cut[b.dataset.mark] = audio.currentTime;
  drawCut();
}));
// tap on the bar: move the nearer handle there
$("#cut-bar").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * (audio.duration || 0);
  if (Math.abs(t - cut.a) < Math.abs(t - cut.b)) cut.a = t; else cut.b = t;
  drawCut();
};
$("#cut-preview").onclick = () => {
  if (player.loop) {
    player.loop = null;
    $("#cut-preview").textContent = "▶ پیش‌نمایش (تکرار)";
    return;
  }
  player.loop = [cut.a, cut.b];
  audio.currentTime = cut.a;
  audio.play();
  $("#cut-preview").textContent = "⏹ توقف پیش‌نمایش";
};
async function doCut(deliver) {
  if (!player.cur) return;
  const body = { track_id: player.cur.id, start: cut.a, end: cut.b, fade: $("#cut-fade").checked, fmt: $("#cut-fmt").value, deliver };
  toast("✂️ در حال برش...", 4000);
  try {
    const r = await api("/api/cut", { method: "POST", json: body });
    if (deliver === "chat") return toast("✅ تو چت ربات فرستادم");
    const url = new URL(r.url, location.href).href;
    if (tg?.downloadFile) tg.downloadFile({ url, file_name: r.name });
    else if (tg?.openLink) tg.openLink(url);
    else location.href = url;
  } catch (e) {
    toast("⚠️ " + e.message, 4000);
  }
}
$("#cut-download").onclick = () => doCut("link");
$("#cut-chat").onclick = () => doCut("chat");

/* ---------------- listen (recognition) ---------------- */
let recorder = null;
async function recognizeBlob(blob, name = "rec.webm") {
  $("#listen-status").textContent = "🔍 دارم پیدا می‌کنم...";
  const fd = new FormData();
  fd.append("hum", $("#hum").checked ? "1" : "0");
  fd.append("audio", blob, name);
  const el = $("#listen-result");
  el.innerHTML = "";
  try {
    const r = await api("/api/recognize", { method: "POST", body: fd });
    if (r.match) {
      const m = r.match;
      el.innerHTML = `<div class="match"><img src="${esc(m.cover || r.tracks[0]?.thumb || PLACEHOLDER)}"><div>
        <h3>${esc(m.title)}</h3><p class="muted">${esc(m.artist || "")}${m.album ? " · " + esc(m.album) : ""}</p><small>با ${esc(m.engine)}</small></div></div>`;
      haptic("heavy");
      $("#listen-status").textContent = "✅ پیدا شد!";
    } else if (r.transcript) {
      el.innerHTML = `<div class="match"><div><b>📝 چیزی که شنیدم:</b><p>«${esc(r.transcript)}»</p>
        ${r.lyric_hits.length ? "<small>آهنگ‌هایی با این متن: " + r.lyric_hits.map(esc).join("، ") + "</small>" : ""}</div></div>`;
      $("#listen-status").textContent = "با متنی که خوندی گشتم 👇";
    } else {
      $("#listen-status").textContent = "😕 پیدا نشد؛ دوباره نزدیک‌تر امتحان کن یا متن آهنگ رو جستجو کن";
    }
    const list = document.createElement("div");
    list.className = "list";
    el.appendChild(list);
    if (r.tracks?.length) renderList(list, r.tracks);
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
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(timer);
    $("#listen-btn").classList.remove("rec");
    $("#listen-label").innerHTML = "🎧<br>گوش بده";
    recognizeBlob(new Blob(chunks, { type: recorder.mimeType }), recorder.mimeType.includes("mp4") ? "rec.mp4" : "rec.webm");
    if (wasPlaying) audio.play();
  };
  const secs = $("#hum").checked ? 15 : 12;
  let left = secs;
  recorder.start();
  haptic("medium");
  $("#listen-btn").classList.add("rec");
  $("#listen-status").textContent = $("#hum").checked ? "🎤 بخون یا زمزمه کن..." : "👂 دارم گوش می‌دم...";
  $("#listen-label").innerHTML = `${left}<br>ثانیه`;
  const timer = setInterval(() => {
    left -= 1;
    $("#listen-label").innerHTML = `${left}<br>ثانیه`;
    if (left <= 0 && recorder.state === "recording") recorder.stop();
  }, 1000);
};
$("#listen-file").onchange = (e) => {
  const f = e.target.files[0];
  if (f) recognizeBlob(f, f.name);
  e.target.value = "";
};

/* ---------------- library ---------------- */
let libCache = null;
async function loadLibrary() {
  $("#lib-cards").innerHTML = '<p class="empty">...</p>';
  try {
    libCache = await api("/api/library");
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
  $("#lib-title").textContent = "📁 " + (p?.name || "");
  $("#lib-actions").innerHTML = '<button class="icon" id="pl-rename">✏️</button><button class="icon" id="pl-del">🗑</button>';
  $("#pl-rename").onclick = async () => {
    const name = prompt("اسم جدید:", p.name);
    if (!name) return;
    await api(`/api/playlists/${key}`, { method: "PATCH", json: { name } });
    p.name = name;
    $("#lib-title").textContent = "📁 " + name;
  };
  $("#pl-del").onclick = async () => {
    if (!confirm("این پلی‌لیست حذف بشه؟")) return;
    await api(`/api/playlists/${key}`, { method: "DELETE" });
    $("#lib-back").click();
  };
  libTracks = await api(`/api/playlists/${key}`);
  renderList(list, libTracks, {
    emptyText: "خالیه؛ از دکمه ➕ تو پلیر آهنگ اضافه کن",
    onRemove: async (t, row) => {
      await api(`/api/playlists/${key}/tracks/${t.id}`, { method: "DELETE" });
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
  await api("/api/playlists", { method: "POST", json: { name } });
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
    rows = await api(`/api/history${histKind ? "?kind=" + histKind : ""}`);
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
  await api("/api/history", { method: "DELETE" });
  loadHistory();
};

/* ---------------- deep link: /app/?t=ID&cut=1 ---------------- */
(async () => {
  const p = new URLSearchParams(location.search);
  const tid = p.get("t") || tg?.initDataUnsafe?.start_param?.replace(/^t/, "");
  if (!tid) return;
  try {
    const t = await api(`/api/track/${tid}`);
    player.playList([t], 0);
    if (p.get("cut")) togglePanel("cut", true);
  } catch (e) {
    toast(e.message);
  }
})();
