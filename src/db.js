const { Pool } = require('pg');
const env = require('./config');

let pool;

async function connect() {
  const local = /localhost|127\.0\.0\.1/.test(env.dbUrl);
  pool = new Pool({
    connectionString: env.dbUrl,
    ssl: local || process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (e) => console.error('[db] idle client error', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      id                text PRIMARY KEY,
      config            jsonb,
      last_activity_day text,
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      guild_id   text NOT NULL,
      user_id    text NOT NULL,
      xp         integer NOT NULL DEFAULT 0,
      level      integer NOT NULL DEFAULT 0,
      name       text,
      avatar     text,
      day_key    text,
      day_count  integer NOT NULL DEFAULT 0,
      prev_key   text,
      prev_count integer NOT NULL DEFAULT 0,
      act_warn   jsonb NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS users_guild_xp ON users (guild_id, xp DESC);
  `);
  console.log('[db] connected, tables ready');
}

const query = (text, params) => pool.query(text, params);

module.exports = { connect, query };
