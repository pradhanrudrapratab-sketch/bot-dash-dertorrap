const cron = require('node-cron');
const env = require('./config');
const { client } = require('./bot');
const { query } = require('./db');
const gc = require('./guildConfig');
const { yesterdayKey } = require('./util');

// Runs every 10 minutes and evaluates "yesterday" once per server. Guarded by
// last_activity_day, so a restart or a sleeping Render instance never skips a day
// (it catches up) and never double-warns.
async function tick() {
  const y = yesterdayKey();
  for (const guild of client.guilds.cache.values()) {
    try {
      const { cfg } = await gc.get(guild.id);
      if (!cfg.activity.enabled || !cfg.activity.rules.length) continue;
      const { rows } = await query('SELECT last_activity_day FROM guilds WHERE id = $1', [guild.id]);
      if (rows[0] && rows[0].last_activity_day === y) continue;
      await query(
        `INSERT INTO guilds (id, last_activity_day) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET last_activity_day = $2`,
        [guild.id, y],
      );
      await processGuild(guild, cfg, y);
    } catch (e) {
      console.error(`[activity] ${guild.id}:`, e);
    }
  }
}

async function processGuild(guild, cfg, y) {
  await guild.members.fetch();
  for (const rule of cfg.activity.rules) {
    const role = guild.roles.cache.get(rule.roleId);
    if (!role) continue;
    for (const member of role.members.values()) {
      if (member.user.bot) continue;
      const { rows } = await query(
        'SELECT day_key, day_count, prev_key, prev_count, act_warn FROM users WHERE guild_id = $1 AND user_id = $2',
        [guild.id, member.id],
      );
      const u = rows[0];
      const count = !u ? 0 : u.day_key === y ? u.day_count : u.prev_key === y ? u.prev_count : 0;
      const warns = (u && u.act_warn && u.act_warn[rule.roleId]) || 0;
      const setWarn = (n) =>
        query(
          `INSERT INTO users (guild_id, user_id, act_warn)
           VALUES ($1, $2, jsonb_build_object($3::text, $4::int))
           ON CONFLICT (guild_id, user_id) DO UPDATE
           SET act_warn = users.act_warn || jsonb_build_object($3::text, $4::int)`,
          [guild.id, member.id, rule.roleId, n],
        );

      if (count >= rule.required) {
        if (warns) await setWarn(0);
        continue;
      }

      const n = warns + 1;
      if (n <= rule.warnings) {
        await setWarn(n);
        await notify(guild, cfg, member,
          `⚠️ Warning ${n}/${rule.warnings}: you sent ${count}/${rule.required} messages yesterday for **${role.name}**. Stay active to keep the role.`);
      } else {
        await demote(member, rule);
        await setWarn(0);
        await notify(guild, cfg, member,
          `🔻 You were demoted from **${role.name}** (${count}/${rule.required} messages yesterday, warnings used up).`);
      }
    }
  }
}

async function demote(member, rule) {
  const remove = [...new Set([rule.roleId, ...rule.removeRoles])].filter((r) => member.roles.cache.has(r));
  const give = rule.giveRoles.filter((r) => !member.roles.cache.has(r));
  if (give.length) await member.roles.add(give, 'Activity demotion').catch((e) => console.warn('[activity] add:', e.message));
  if (remove.length) await member.roles.remove(remove, 'Activity demotion').catch((e) => console.warn('[activity] remove:', e.message));
}

async function notify(guild, cfg, member, content) {
  const ch = cfg.activity.notifyChannelId && guild.channels.cache.get(cfg.activity.notifyChannelId);
  if (ch && ch.isTextBased()) {
    return ch.send({ content: `<@${member.id}> ${content}`, allowedMentions: { users: [member.id] } }).catch(() => {});
  }
  return member.send(`**${guild.name}**: ${content}`).catch(() => {});
}

function start() {
  cron.schedule('*/10 * * * *', () => tick().catch((e) => console.error('[activity]', e)), { timezone: env.tz });
  setTimeout(() => tick().catch((e) => console.error('[activity]', e)), 30e3);
}

module.exports = { start };
