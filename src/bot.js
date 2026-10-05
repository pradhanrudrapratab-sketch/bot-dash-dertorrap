const { Client, GatewayIntentBits, Events, MessageType } = require('discord.js');
const { query } = require('./db');
const gc = require('./guildConfig');
const { dayKey, fmt, levelFor } = require('./util');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // privileged: enable in Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable in Developer Portal
  ],
  allowedMentions: { parse: [] },
});

const cooldowns = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600e3;
  for (const [k, t] of cooldowns) if (t < cutoff) cooldowns.delete(k);
}, 600e3).unref();

client.once(Events.ClientReady, (c) => console.log(`[bot] logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`));
client.on(Events.MessageCreate, (msg) => handle(msg).catch((e) => console.error('[message]', e)));

async function handle(msg) {
  if (!msg.guild || msg.author.bot || msg.webhookId) return;
  if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;

  const { cfg, bad, good } = await gc.get(msg.guild.id);
  const text = (msg.content || '').normalize('NFKC');

  // 1) Bad words: delete, penalize, warn — nothing else happens for this message.
  const badCount = cfg.badWords.enabled && bad && text ? (text.match(bad) || []).length : 0;
  if (badCount) return moderate(msg, cfg, badCount);

  // 2) Daily activity counter
  if (cfg.activity.enabled) await trackActivity(msg);

  // 3) VIP mention reactions (reactions only, no replies)
  await vipReact(msg, cfg, text);

  // 4) XP
  if (!cfg.xp.enabled || cfg.xp.perMessage <= 0) return;
  const key = `${msg.guild.id}:${msg.author.id}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < cfg.xp.cooldownSec * 1000) return;
  cooldowns.set(key, now);

  let gain = cfg.xp.perMessage;
  if (cfg.goodWords.enabled && good && text.match(good)) {
    gain = Math.round(gain * (1 + cfg.xp.goodBonusPct / 100));
  }
  await addXp(msg, cfg, gain);
}

async function moderate(msg, cfg, count) {
  const penalty = cfg.xp.enabled
    ? (cfg.xp.penaltyMode === 'per_word' ? count * cfg.xp.badPenalty : cfg.xp.badPenalty)
    : 0;
  await msg.delete().catch((e) => console.warn(`[mod] cannot delete in ${msg.guild.name}: ${e.message}`));
  if (penalty > 0) await addXp(msg, cfg, -penalty);
  await sendWarn(msg, cfg, penalty);
}

async function sendWarn(msg, cfg, penalty) {
  const m = cfg.moderation;
  if (m.warnMode === 'none') return;
  const ch = m.warnMode === 'channel' ? msg.guild.channels.cache.get(m.warnChannelId) : msg.channel;
  if (!ch || !ch.isTextBased()) return;
  const content = fmt(m.warnMessage, {
    user: `<@${msg.author.id}>`, xp: penalty, channel: `<#${msg.channel.id}>`,
  });
  const sent = await ch
    .send({ content, allowedMentions: m.warnMode === 'same' ? { users: [msg.author.id] } : { parse: [] } })
    .catch(() => null);
  if (sent && m.warnMode === 'same' && m.warnDeleteAfterSec > 0) {
    setTimeout(() => sent.delete().catch(() => {}), m.warnDeleteAfterSec * 1000);
  }
}

// delta may be negative. XP never drops below 0. Penalties are flat (level-independent).
async function addXp(msg, cfg, delta) {
  const guildId = msg.guild.id, userId = msg.author.id;
  const name = (msg.member && msg.member.displayName) || msg.author.username;
  const avatar = msg.author.displayAvatarURL({ extension: 'png', size: 64 });

  // level is not touched here, so RETURNING level is the OLD level
  const { rows } = await query(
    `INSERT INTO users (guild_id, user_id, xp, name, avatar)
     VALUES ($1, $2, GREATEST(0, $3::int), $4, $5)
     ON CONFLICT (guild_id, user_id) DO UPDATE
     SET xp = GREATEST(0, users.xp + $3::int), name = $4, avatar = $5
     RETURNING xp, level`,
    [guildId, userId, delta, name, avatar],
  );

  const oldLevel = rows[0].level || 0;
  const newLevel = levelFor(cfg, rows[0].xp);
  if (newLevel === oldLevel) return;

  await query('UPDATE users SET level = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, newLevel]);
  if (newLevel > oldLevel) {
    const member = msg.member || (await msg.guild.members.fetch(userId).catch(() => null));
    if (member) await applyRewards(member, oldLevel, newLevel, cfg);
    await announce(msg, cfg, newLevel);
  }
}

async function applyRewards(member, from, to, cfg) {
  const add = new Set(), remove = new Set();
  for (const l of cfg.levels) {
    if (l.level <= from || l.level > to) continue;
    if (l.mode === 'replace') l.remove.forEach((r) => { remove.add(r); add.delete(r); });
    l.add.forEach((r) => { add.add(r); remove.delete(r); });
  }
  const toAdd = [...add].filter((r) => !member.roles.cache.has(r));
  const toRemove = [...remove].filter((r) => member.roles.cache.has(r));
  if (toAdd.length) await member.roles.add(toAdd, 'Level reward').catch((e) => console.warn('[roles] add:', e.message));
  if (toRemove.length) await member.roles.remove(toRemove, 'Level reward').catch((e) => console.warn('[roles] remove:', e.message));
}

async function announce(msg, cfg, level) {
  const l = cfg.levelUp;
  if (l.mode === 'none') return;
  const ch = l.mode === 'channel' ? msg.guild.channels.cache.get(l.channelId) : msg.channel;
  if (!ch || !ch.isTextBased()) return;
  await ch
    .send({
      content: fmt(l.message, { user: `<@${msg.author.id}>`, level }),
      allowedMentions: { users: [msg.author.id] },
    })
    .catch(() => {});
}

async function trackActivity(msg) {
  const today = dayKey();
  // keeps yesterday's numbers (prev_*) so the daily check still sees them after midnight
  await query(
    `INSERT INTO users (guild_id, user_id, day_key, day_count)
     VALUES ($1, $2, $3::text, 1)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       prev_key   = CASE WHEN users.day_key = $3::text THEN users.prev_key   ELSE users.day_key   END,
       prev_count = CASE WHEN users.day_key = $3::text THEN users.prev_count ELSE users.day_count END,
       day_count  = CASE WHEN users.day_key = $3::text THEN users.day_count + 1 ELSE 1 END,
       day_key    = $3::text`,
    [msg.guild.id, msg.author.id, today],
  );
}

async function vipReact(msg, cfg, text) {
  const v = cfg.vip;
  if (!v.enabled || !v.roleId || !v.reactions.length || !msg.mentions.users.size) return;
  if (v.channelIds.length) {
    const ok = v.channelIds.includes(msg.channel.id) ||
      (msg.channel.parentId && v.channelIds.includes(msg.channel.parentId));
    if (!ok) return;
  }
  let hit = false;
  for (const u of msg.mentions.users.values()) {
    // only real @mentions in the text, not the automatic ping of a reply
    if (!text.includes(`<@${u.id}>`) && !text.includes(`<@!${u.id}>`)) continue;
    const m = msg.mentions.members?.get(u.id) || (await msg.guild.members.fetch(u.id).catch(() => null));
    if (m && m.roles.cache.has(v.roleId)) { hit = true; break; }
  }
  if (!hit) return;
  for (const e of v.reactions) await msg.react(e).catch(() => {});
}

module.exports = { client };
