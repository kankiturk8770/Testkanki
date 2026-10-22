// Gemini (Google AI Studio key, set by the owner with /set gemini_key …).
import { fetch } from 'sdk';
import { getSetting } from './store.js';
import { PRESETS, RULES } from './data.js';

// Fastest first (a bot run is cut off after ~30 s; some models take longer than that).
// A busy model answers 503/429 at once and the next one takes over.
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const BUDGET = 16000; // ms: no new attempt after this, so the bot always gets to answer

export const aiEnabled = async () => !!(await getSetting('gemini_key'));

export async function gemini(prompt, json = false) {
  const key = await getSetting('gemini_key');
  if (!key) throw new Error('no gemini key');
  let last = '';
  const t0 = Date.now();
  for (const m of MODELS) {
    if (Date.now() - t0 > BUDGET) break;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Answer with the requested content only: no greeting, no intro line, no explanation, no markdown.' }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: json ? 0.2 : 0.9, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    const j = await res.json().catch(() => ({}));
    const text = j.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    if (res.ok && text) return text;
    last = `${m}: ${res.status} ${j.error?.message || ''}`;
    if (![429, 500, 503, 404].includes(res.status)) break;
  }
  throw new Error(last || 'gemini: empty answer');
}

/** Body of a framed channel post about `title`. */
export async function writePost(title, style) {
  const mood = { fire: 'پرانرژی و هیجانی', ice: 'آروم و شیک', royal: 'رسمی و باکلاس', game: 'گیمری و خودمونی', gold: 'جذاب و شاد' }[style] || 'جذاب';
  const text = await gemini(
    `یه متن کوتاه برای پست کانال تلگرام گیمرهای پابجی موبایل بنویس با موضوع «${title}».\n` +
    `لحن: ${mood}، فارسی محاوره‌ای، ۳ تا ۶ خط کوتاه، با چند اموجی مناسب.\n` +
    'فقط خود متن رو بده؛ بدون عنوان، بدون توضیح، بدون علامت‌های مارک‌داون مثل * یا #.');
  return cleanText(text).slice(0, 900);
}

/** Drop markdown and a leading "here is your text:" line. */
export function cleanText(t) {
  const lines = String(t).replace(/[*#`]/g, '').trim().split('\n');
  if (lines.length > 1 && /[:：]\s*$/.test(lines[0])) lines.shift();
  return lines.join('\n').trim();
}

const ids = (key) => PRESETS[key].map(([, , v]) => v).join(' | ');
// "بیشترین کیل" -> "🔫 بیشترین کیل": the AI's words become the button's value when they match one
const bare = (x) => String(x).replace(/\d\uFE0F?\u20E3/gu, '').replace(/[^\p{L}\p{N}\s/]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
function preset(key, v) {
  if (v === undefined) return v;
  const hit = PRESETS[key].find(([id, label, val]) => [id, label, val].some((x) => bare(x) === bare(v)));
  return hit ? hit[2] : v;
}

/**
 * A free-text request ("روم ساعت ۱۱ لیویک اسکواد ۱۰۰ یوسی به MVP") -> { kind, d } with the fields it
 * mentions filled in; fields it doesn't mention stay undefined, so the bot asks them.
 */
export async function parseRequest(text) {
  const raw = await gemini(`You fill forms for a Telegram bot that posts PUBG Mobile channel announcements (Persian users).
Read the admin's message and answer ONLY a JSON object. Put a field only if the message gives it (never invent).

"kind": "room" (custom room / match announcement) | "gv" (giveaway / قرعه‌کشی) | "post" (any other channel post / notice)

For kind "room":
  "time": start time "HH:MM" 24h (e.g. ساعت ۱۱ شب -> "23:00", ۹ -> "21:00")
  "prize": like "100 UC" (یوسی = UC)
  "winner": one of [${ids('winner')}] or the admin's own words
  "map": one of [${ids('map')}] or the admin's own words in Persian
  "mode": one of [${ids('mode')}] or the admin's own words
  "rules": array of rule numbers (0-${RULES.length - 1}) from this list that the message asks for: ${RULES.map((r, i) => `${i}=${r}`).join('; ')}; plus "rules_extra": array of other rules it states, in Persian
  "room": room ID / password text if given
  "spons": array of sponsor channel usernames like "@name"
  "desc": extra notes in Persian
For kind "gv":
  "theme": "uc" (prize is UC) | "chicken" (prize is PUBG likes/gifts: موتور گل هواپیما مرغ ماشین) | "custom" (anything else)
  "gprize": like "100 UC" (theme uc); "glike": gift type in Persian with emoji from [${ids('glike')}] and "glamt": like "2K" (theme chicken); "gtitle" and "gprize_c" (theme custom)
  "gwin": number of winners; "gcap": capacity (number of participants)
  "gend": "full" (when full) | "d:<minutes>" (e.g. یک ساعت دیگه -> "d:60") | "HH:MM"
  "spons", "desc" as above
For kind "post":
  "ptitle": a short title in Persian; "pbody": the post text in Persian (polish it, 2-6 short lines, a few emoji, no markdown)
  "pstyle": one of gold | fire | ice | royal | game (pick what fits)
  "pbtn": {"t": button text, "u": https link} only if a link is given

Message: """${text}"""`, true);
  const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
  const kind = ['room', 'gv', 'post'].includes(j.kind) ? j.kind : 'post';
  const d = {};
  const str = (v, max = 300) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim().replace(/[*#`]/g, '').slice(0, max) : undefined;
  const set = (k, v) => { if (v !== undefined) d[k] = v; };
  const spons = Array.isArray(j.spons) ? j.spons.map(String).filter((x) => /^@?\w{4,}$/.test(x)).map((x) => '@' + x.replace(/^@/, '')) : [];
  if (spons.length) d.spons = spons;
  set('desc', str(j.desc));
  if (kind === 'room') {
    for (const k of ['time', 'prize', 'room']) set(k, str(j[k]));
    for (const k of ['winner', 'map', 'mode']) set(k, preset(k, str(j[k])));
    const rules = (Array.isArray(j.rules) ? j.rules : []).map(Number).filter((i) => RULES[i]).map((i) => RULES[i]);
    const extra = (Array.isArray(j.rules_extra) ? j.rules_extra : []).map(str).filter(Boolean).map((r) => '✍️ ' + r);
    if (rules.length || extra.length) d.rules = [...rules, ...extra];
    return { kind: 'room', d };
  }
  if (kind === 'gv') {
    const theme = ['uc', 'chicken', 'custom'].includes(j.theme) ? j.theme : 'custom';
    for (const k of ['gprize', 'glike', 'glamt', 'gtitle', 'gprize_c', 'gend']) set(k, str(j[k]));
    for (const k of ['gwin', 'gcap']) if (Number.isInteger(Number(j[k])) && Number(j[k]) > 0) d[k] = Number(j[k]);
    if (d.gwin && d.gcap && d.gwin > d.gcap) delete d.gwin;
    return { kind: `gv_${theme}`, d };
  }
  set('ptitle', str(j.ptitle, 120));
  set('pbody', str(j.pbody, 900));
  if (['gold', 'fire', 'ice', 'royal', 'game'].includes(j.pstyle)) d.pstyle = j.pstyle;
  if (j.pbtn?.t && /^https?:\/\/\S+$/.test(j.pbtn.u || '')) d.pbtn = { t: String(j.pbtn.t).slice(0, 60), u: j.pbtn.u };
  return { kind: 'post', d };
}
