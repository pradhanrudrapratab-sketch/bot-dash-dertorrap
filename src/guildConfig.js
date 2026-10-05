const { query } = require('./db');
const { sanitize } = require('./schema');
const { yesterdayKey } = require('./util');

const cache = new Map();

function compile(list) {
  if (!list.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alts = [...list].sort((a, b) => b.length - a.length).map(esc).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts})(?![\\p{L}\\p{N}_])`, 'giu');
}

const build = (cfg) => ({ cfg, bad: compile(cfg.badWords.list), good: compile(cfg.goodWords.list) });

async function get(guildId) {
  let e = cache.get(guildId);
  if (e) return e;
  const { rows } = await query('SELECT config FROM guilds WHERE id = $1', [guildId]);
  e = build(sanitize(rows[0] && rows[0].config));
  cache.set(guildId, e);
  return e;
}

async function save(guildId, raw) {
  const cfg = sanitize(raw);
  const prev = (await get(guildId)).cfg;
  // When activity tracking is switched on, start judging from today (not retroactively).
  const startDay = cfg.activity.enabled && !prev.activity.enabled ? yesterdayKey() : null;
  await query(
    `INSERT INTO guilds (id, config, last_activity_day) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET
       config = EXCLUDED.config,
       updated_at = now(),
       last_activity_day = COALESCE($3, guilds.last_activity_day)`,
    [guildId, JSON.stringify(cfg), startDay],
  );
  cache.set(guildId, build(cfg));
  return cfg;
}

module.exports = { get, save };
