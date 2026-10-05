const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { PermissionFlagsBits: P, PermissionsBitField, ChannelType } = require('discord.js');

const env = require('./config');
const { client } = require('./bot');
const { query } = require('./db');
const gc = require('./guildConfig');
const { sanitize } = require('./schema');
const { levelInfo } = require('./util');

const isHttps = env.baseUrl.startsWith('https');
const REDIRECT = `${env.baseUrl}/auth/callback`;
const INVITE_URL =
  `https://discord.com/oauth2/authorize?client_id=${env.clientId}&scope=bot&permissions=` +
  new PermissionsBitField([P.ViewChannel, P.SendMessages, P.AddReactions, P.ManageMessages, P.ManageRoles, P.ReadMessageHistory]).bitfield.toString();

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: isHttps };

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com'],
        'upgrade-insecure-requests': isHttps ? [] : null,
      },
    },
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '300kb' }));

  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  // Reject cross-site writes (cookies are also SameSite=Lax).
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== env.baseUrl) return res.status(403).json({ error: 'Bad origin' });
    next();
  });

  // ---------- Discord OAuth2 ----------
  const authLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 40, standardHeaders: true, legacyHeaders: false });

  app.get('/auth/login', authLimiter, (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, { ...cookieOpts, maxAge: 10 * 60e3 });
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: env.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'identify', state, prompt: 'none',
    }).toString();
    res.redirect(url.toString());
  });

  app.get('/auth/callback', authLimiter, ah(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.cookies.oauth_state) return res.redirect('/?error=state');
    res.clearCookie('oauth_state');

    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.clientId, client_secret: env.clientSecret,
        grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT,
      }),
    });
    if (!tok.ok) return res.redirect('/?error=token');
    const { access_token } = await tok.json();

    const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
    if (!me.ok) return res.redirect('/?error=user');
    const u = await me.json();

    const session = jwt.sign(
      { id: u.id, name: u.global_name || u.username, avatar: u.avatar || null },
      env.jwtSecret, { expiresIn: '7d' },
    );
    res.cookie('session', session, { ...cookieOpts, maxAge: 7 * 864e5 });
    res.redirect('/');
  }));

  app.get('/auth/logout', (req, res) => { res.clearCookie('session'); res.redirect('/'); });

  // ---------- API ----------
  const api = express.Router();
  api.use(rateLimit({ windowMs: 60e3, limit: 150, standardHeaders: true, legacyHeaders: false }));

  api.use((req, res, next) => {
    try { req.user = jwt.verify(req.cookies.session || '', env.jwtSecret); next(); }
    catch { res.status(401).json({ error: 'Not logged in' }); }
  });

  api.get('/me', (req, res) => res.json({ user: req.user, inviteUrl: INVITE_URL }));

  api.get('/guilds', ah(async (req, res) => {
    const rows = await Promise.all([...client.guilds.cache.values()].map(async (g) => {
      const m = await g.members.fetch(req.user.id).catch(() => null);
      if (!m) return null;
      return { id: g.id, name: g.name, icon: g.icon, isAdmin: isAdmin(g, m), memberCount: g.memberCount };
    }));
    res.json(rows.filter(Boolean));
  }));

  // Every /guilds/:id/* request re-verifies identity, membership and permission on the server.
  const guildRouter = express.Router({ mergeParams: true });
  guildRouter.use(ah(async (req, res, next) => {
    if (!/^\d{15,25}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad server id' });
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'The bot is not in this server' });
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) return res.status(403).json({ error: 'You are not in this server' });
    req.guild = guild; req.member = member; req.isAdmin = isAdmin(guild, member);
    next();
  }));
  const adminOnly = (req, res, next) =>
    req.isAdmin ? next() : res.status(403).json({ error: 'Administrator permission required' });

  // Public to any server member
  guildRouter.get('/leaderboard', ah(async (req, res) => {
    const gid = req.guild.id;
    const { cfg } = await gc.get(gid);
    const shape = (u, rank) => ({ rank, userId: u.user_id, name: u.name || 'Unknown', avatar: u.avatar || null, xp: u.xp, ...levelInfo(cfg, u.xp) });
    const top = (await query(
      'SELECT user_id, name, avatar, xp FROM users WHERE guild_id = $1 AND xp > 0 ORDER BY xp DESC LIMIT 50', [gid])).rows;
    const mine = (await query(
      'SELECT user_id, name, avatar, xp FROM users WHERE guild_id = $1 AND user_id = $2', [gid, req.user.id])).rows[0];
    let me = null;
    if (mine && mine.xp > 0) {
      const ahead = (await query('SELECT count(*)::int AS n FROM users WHERE guild_id = $1 AND xp > $2', [gid, mine.xp])).rows[0].n;
      me = shape(mine, ahead + 1);
    }
    res.json({ rows: top.map((u, i) => shape(u, i + 1)), me });
  }));

  // Admin only
  guildRouter.get('/overview', adminOnly, ah(async (req, res) => {
    const gid = req.guild.id;
    const { cfg } = await gc.get(gid);
    const t = (await query(
      'SELECT count(*)::int AS tracked, COALESCE(SUM(xp), 0)::float8 AS total FROM users WHERE guild_id = $1', [gid])).rows[0];
    res.json({
      members: req.guild.memberCount, tracked: t.tracked, totalXp: t.total,
      levels: cfg.levels.length, badWords: cfg.badWords.list.length, goodWords: cfg.goodWords.list.length,
      activityRules: cfg.activity.rules.length,
    });
  }));

  guildRouter.get('/meta', adminOnly, ah(async (req, res) => res.json(await buildMeta(req.guild))));

  guildRouter.post('/sync', adminOnly, ah(async (req, res) => {
    await Promise.all([req.guild.roles.fetch(), req.guild.channels.fetch(), req.guild.emojis.fetch()]);
    res.json(await buildMeta(req.guild));
  }));

  guildRouter.get('/config', adminOnly, ah(async (req, res) => res.json((await gc.get(req.guild.id)).cfg)));

  guildRouter.put('/config', adminOnly, ah(async (req, res) => {
    if (!req.is('json')) return res.status(415).json({ error: 'JSON required' });
    let clean;
    try { clean = sanitize(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    const botMember = req.guild.members.me || (await req.guild.members.fetchMe());
    const problems = checkAgainstGuild(req.guild, botMember, clean);
    if (problems.length) return res.status(400).json({ error: 'Some roles cannot be managed by the bot', details: problems });
    res.json(await gc.save(req.guild.id, clean));
  }));

  api.use('/guilds/:id', guildRouter);
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[web]', err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}

function isAdmin(guild, member) {
  return guild.ownerId === member.id || member.permissions.has(P.Administrator);
}

async function buildMeta(guild) {
  const bot = guild.members.me || (await guild.members.fetchMe());
  const top = bot.roles.highest.position;
  const canRoles = bot.permissions.has(P.ManageRoles);
  const hex = (n) => (n ? `#${n.toString(16).padStart(6, '0')}` : null);
  return {
    roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).map((r) => ({
      id: r.id, name: r.name, color: hex(r.color), position: r.position,
      assignable: canRoles && !r.managed && r.position < top,
    })),
    channels: [...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ id: c.id, name: c.name, canSend: !!(c.permissionsFor(bot) && c.permissionsFor(bot).has([P.ViewChannel, P.SendMessages])) })),
    emojis: [...guild.emojis.cache.values()].map((e) => ({ id: e.id, name: e.name, animated: e.animated, value: `${e.name}:${e.id}` })),
    botPerms: {
      manageRoles: canRoles,
      manageMessages: bot.permissions.has(P.ManageMessages),
      addReactions: bot.permissions.has(P.AddReactions),
      sendMessages: bot.permissions.has(P.SendMessages),
      readMessageHistory: bot.permissions.has(P.ReadMessageHistory),
    },
    botTopRole: bot.roles.highest.name,
    timezone: env.tz,
  };
}

// Drops deleted roles/channels silently; rejects roles the bot can't manage (hierarchy).
function checkAgainstGuild(guild, bot, cfg) {
  const problems = [];
  const top = bot.roles.highest.position;
  const canRoles = bot.permissions.has(P.ManageRoles);
  const roleOk = (id, where) => {
    const r = guild.roles.cache.get(id);
    if (!r || r.id === guild.id) return false;
    if (!canRoles) problems.push(`Bot lacks "Manage Roles" (${where}: @${r.name})`);
    else if (r.managed || r.position >= top) problems.push(`@${r.name} (${where}) is managed or above the bot's highest role "${bot.roles.highest.name}"`);
    return true;
  };
  const roles = (ids, where) => ids.filter((id) => roleOk(id, where));
  const chan = (id) => (id && guild.channels.cache.has(id) ? id : null);

  cfg.levels.forEach((l) => { l.add = roles(l.add, `Level ${l.level} add`); l.remove = roles(l.remove, `Level ${l.level} remove`); });
  cfg.activity.rules = cfg.activity.rules.filter((q) => guild.roles.cache.has(q.roleId));
  cfg.activity.rules.forEach((q) => {
    roleOk(q.roleId, 'Activity role');
    q.removeRoles = roles(q.removeRoles, 'Activity remove');
    q.giveRoles = roles(q.giveRoles, 'Activity give');
  });
  cfg.vip.roleId = guild.roles.cache.has(cfg.vip.roleId) ? cfg.vip.roleId : null;
  cfg.vip.channelIds = cfg.vip.channelIds.filter((id) => guild.channels.cache.has(id));
  cfg.moderation.warnChannelId = chan(cfg.moderation.warnChannelId);
  cfg.levelUp.channelId = chan(cfg.levelUp.channelId);
  cfg.activity.notifyChannelId = chan(cfg.activity.notifyChannelId);
  return [...new Set(problems)];
}

module.exports = { createApp };
