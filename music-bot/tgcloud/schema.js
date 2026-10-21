import { table, integer, text, blob, index, uniqueIndex } from 'sdk/db';

// Telegram users who talked to the bot. id = Telegram user id.
export const users = table('users', {
  id:      integer('id').primaryKey(),
  name:    text('name'),
  created: integer('created'),
});

// Every song/video the bot has seen. key = "<source>:<id>", e.g. "youtube:dQw4w9WgXcQ".
export const tracks = table('tracks', {
  id:       integer('id').primaryKey({ autoIncrement: true }),
  key:      text('key').notNull().unique(),
  url:      text('url').notNull(),
  title:    text('title'),
  artist:   text('artist'),
  duration: integer('duration'),
  thumb:    text('thumb'),
  source:   text('source'),
  created:  integer('created'),
});

// Full activity history: search | recognize | open | play | download | edit
export const history = table('history', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  kind:    text('kind').notNull(),
  query:   text('query'),
  trackId: integer('track_id'),
  ts:      integer('ts').notNull(),
}, (t) => ({
  byUser: index('idx_history_user').on(t.userId, t.ts),
}));

export const playlists = table('playlists', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  name:    text('name').notNull(),
  created: integer('created'),
}, (t) => ({
  byUser: index('idx_playlists_user').on(t.userId),
}));

export const playlistItems = table('playlist_items', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  playlistId: integer('playlist_id').notNull(),
  trackId:    integer('track_id').notNull(),
  added:      integer('added'),
}, (t) => ({
  uniq: uniqueIndex('uidx_playlist_track').on(t.playlistId, t.trackId),
}));

export const likes = table('likes', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  trackId: integer('track_id').notNull(),
  added:   integer('added'),
}, (t) => ({
  uniq: uniqueIndex('uidx_like').on(t.userId, t.trackId),
}));

// Telegram file_id of every file the bot uploaded, so the next send is instant.
// variant: a128 | a192 | a320 | v360 | v720 | ...
export const fileCache = table('file_cache', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  trackId: integer('track_id').notNull(),
  variant: text('variant').notNull(),
  fileId:  text('file_id').notNull(),
  size:    integer('size'),
}, (t) => ({
  uniq: uniqueIndex('uidx_file').on(t.trackId, t.variant),
}));

// Small per-user state: last track, what the bot is waiting for, ...
export const state = table('state', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  k:      text('k').notNull(),
  v:      text('v'),
}, (t) => ({
  uniq: uniqueIndex('uidx_state').on(t.userId, t.k),
}));

// Bot settings and API keys, set by the admin with /set in the chat (never in code).
export const settings = table('settings', {
  k: text('k').primaryKey(),
  v: text('v'),
});

// Edited audio uploaded from the Mini App in parts, until the last part arrives.
export const uploads = table('uploads', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  token:   text('token').notNull(),
  idx:     integer('idx').notNull(),
  data:    blob('data'),
  created: integer('created'),
}, (t) => ({
  byToken: index('idx_uploads_token').on(t.token),
}));
