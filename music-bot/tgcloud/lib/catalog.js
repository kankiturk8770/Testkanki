// Catalogue engines: they know songs in every language (names, covers, lengths) but serve no full
// files. Their results are turned into real files by sources.js (same song on a source that has one).
//   Deezer  — big international catalogue, good with Turkish / Arabic / Latin names
//   iTunes  — Apple Music's catalogue, many local releases
//   Genius  — finds a song from a line of its lyrics
import { fetch } from 'sdk';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const getJson = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })).json();

export async function deezerSearch(q, limit = 5) {
  const j = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return (j.data || []).map((t) => ({
    key: `deezer:${t.id}`, source: 'deezer', url: t.link, title: t.title, artist: t.artist?.name || null,
    duration: t.duration || null, thumb: t.album?.cover_xl || t.album?.cover_big || null,
  }));
}

export async function itunesSearch(q, limit = 5) {
  const j = await getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=${limit}`);
  return (j.results || []).map((t) => ({
    key: `itunes:${t.trackId}`, source: 'itunes', url: t.trackViewUrl, title: t.trackName, artist: t.artistName || null,
    duration: t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
    thumb: (t.artworkUrl100 || '').replace('100x100bb', '600x600bb') || null,
  }));
}

/** Songs whose lyrics contain the text (no key needed). */
export async function geniusLyrics(q, limit = 4) {
  const j = await getJson(`https://genius.com/api/search/lyric?q=${encodeURIComponent(q)}&per_page=${limit}`);
  const hits = (j.response?.sections || []).flatMap((s) => s.hits || []);
  return hits.slice(0, limit).map((h) => h.result).filter(Boolean).map((r) => ({
    key: `genius:${r.id}`, source: 'genius', url: r.url, title: r.title, artist: r.primary_artist?.name || r.artist_names || null,
    duration: null, thumb: r.song_art_image_url || r.header_image_url || null,
  }));
}
