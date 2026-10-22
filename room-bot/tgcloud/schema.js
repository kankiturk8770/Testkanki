import { table, integer, text, index, uniqueIndex } from 'sdk/db';

// Admins who use the bot. pin: pin new posts by default; spons: last sponsor list (JSON).
export const users = table('users', {
  id:      integer('id').primaryKey(),
  name:    text('name'),
  pin:     integer('pin').default(1),
  count:   integer('count').default(0),
  spons:   text('spons'),
  created: integer('created'),
});

// Channels / groups an admin connected (the bot is admin there).
export const channels = table('channels', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  chatId:  integer('chat_id').notNull(),
  title:   text('title'),
}, (t) => ({
  uniq: uniqueIndex('uidx_channel').on(t.userId, t.chatId),
}));

// What a user is doing right now: the post being built (JSON), or what the bot waits for.
export const sessions = table('sessions', {
  userId: integer('user_id').primaryKey(),
  v:      text('v'),
});

// Scheduled posts. kind: room | post | gv ; data / targets are JSON.
export const jobs = table('jobs', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  kind:    text('kind').notNull(),
  due:     integer('due').notNull(),
  targets: text('targets').notNull(),
  pin:     integer('pin').default(0),
  data:    text('data').notNull(),
}, (t) => ({
  byDue: index('idx_jobs_due').on(t.due),
}));

// Giveaways posted in a channel. data: prize, winners, cap, sponsors, … (JSON);
// status: open | done | cancel ; winners: JSON list of the drawn participants.
export const giveaways = table('giveaways', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  owner:   integer('owner').notNull(),
  chatId:  integer('chat_id').notNull(),
  msgId:   integer('msg_id'),
  data:    text('data').notNull(),
  status:  text('status').notNull(),
  endsAt:  integer('ends_at'),
  winners: text('winners'),
  created: integer('created'),
}, (t) => ({
  byOwner: index('idx_gv_owner').on(t.owner, t.status),
  byEnd:   index('idx_gv_end').on(t.status, t.endsAt),
}));

// One row per participant; the unique index makes a double tap harmless.
export const entries = table('entries', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  gid:    integer('gid').notNull(),
  userId: integer('user_id').notNull(),
  name:   text('name'),
  un:     text('un'),
}, (t) => ({
  uniq: uniqueIndex('uidx_entry').on(t.gid, t.userId),
}));

// Bot settings: owner, tz, gemini_key, timer state, …
export const settings = table('settings', {
  k: text('k').primaryKey(),
  v: text('v'),
});

// Automatic posts: news items already used (so nothing repeats), and drafts waiting for the owner's OK.
export const seen = table('seen', {
  k:  text('k').primaryKey(),
  ts: integer('ts'),
});

// kind: news | char ; photo: Telegram file_id once shown to the owner ; status: wait | sent | drop
export const drafts = table('drafts', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  kind:    text('kind').notNull(),
  caption: text('caption').notNull(),
  photo:   text('photo'),
  status:  text('status').notNull(),
  created: integer('created'),
});
