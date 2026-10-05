// Default per-server config + strict sanitizer (the backend never trusts the dashboard).
const SNOW = /^\d{15,25}$/;

const int = (v, min, max, d) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
const oneOf = (v, arr, d) => (arr.includes(v) ? v : d);
const snow = (v) => (typeof v === 'string' && SNOW.test(v) ? v : null);
const snowList = (a, max = 25) =>
  Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string' && SNOW.test(x)))].slice(0, max) : [];
const text = (v, max, d = '') => (typeof v === 'string' ? v.trim().slice(0, max) : d);
const words = (a) =>
  Array.isArray(a)
    ? [...new Set(a.filter((w) => typeof w === 'string').map((w) => w.normalize('NFKC').trim().toLowerCase()).filter((w) => w && w.length <= 50))].slice(0, 2000)
    : [];
const emoji = (v) => {
  if (typeof v !== 'string') return null;
  let e = v.trim();
  const m = e.match(/^<a?:(\w+):(\d+)>$/);
  if (m) e = `${m[1]}:${m[2]}`;
  return e && e.length <= 64 && !/\s/.test(e) ? e : null;
};

const defaults = () => ({
  xp: { enabled: true, perMessage: 10, cooldownSec: 60, goodBonusPct: 50, badPenalty: 20, penaltyMode: 'per_word' },
  goodWords: { enabled: true, list: [] },
  badWords: { enabled: true, list: [] },
  moderation: { warnMode: 'same', warnChannelId: null, warnMessage: '{user}, watch your language! (-{xp} XP)', warnDeleteAfterSec: 10 },
  levelUp: { mode: 'same', channelId: null, message: '🎉 {user} reached **level {level}**!' },
  levels: [],
  activity: { enabled: false, notifyChannelId: null, rules: [] },
  vip: { enabled: false, roleId: null, reactions: ['🔥', '👑', '💎', '⭐'], channelIds: [] },
});

function sanitize(raw) {
  const d = defaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  const x = r.xp || {}, gw = r.goodWords || {}, bw = r.badWords || {};
  const m = r.moderation || {}, lu = r.levelUp || {}, a = r.activity || {}, v = r.vip || {};

  const out = {
    xp: {
      enabled: bool(x.enabled, true),
      perMessage: int(x.perMessage, 0, 1000, d.xp.perMessage),
      cooldownSec: int(x.cooldownSec, 0, 3600, d.xp.cooldownSec),
      goodBonusPct: int(x.goodBonusPct, 0, 1000, d.xp.goodBonusPct),
      badPenalty: int(x.badPenalty, 0, 100000, d.xp.badPenalty),
      penaltyMode: oneOf(x.penaltyMode, ['per_word', 'per_message'], 'per_word'),
    },
    goodWords: { enabled: bool(gw.enabled, true), list: words(gw.list) },
    badWords: { enabled: bool(bw.enabled, true), list: words(bw.list) },
    moderation: {
      warnMode: oneOf(m.warnMode, ['same', 'channel', 'none'], 'same'),
      warnChannelId: snow(m.warnChannelId),
      warnMessage: text(m.warnMessage, 300, d.moderation.warnMessage) || d.moderation.warnMessage,
      warnDeleteAfterSec: int(m.warnDeleteAfterSec, 0, 600, 10),
    },
    levelUp: {
      mode: oneOf(lu.mode, ['same', 'channel', 'none'], 'same'),
      channelId: snow(lu.channelId),
      message: text(lu.message, 300, d.levelUp.message) || d.levelUp.message,
    },
    levels: [],
    activity: { enabled: bool(a.enabled), notifyChannelId: snow(a.notifyChannelId), rules: [] },
    vip: {
      enabled: bool(v.enabled),
      roleId: snow(v.roleId),
      reactions: (Array.isArray(v.reactions) ? v.reactions : []).map(emoji).filter(Boolean).slice(0, 4),
      channelIds: snowList(v.channelIds, 50),
    },
  };

  const seen = new Set();
  out.levels = (Array.isArray(r.levels) ? r.levels : [])
    .slice(0, 100)
    .map((l) => ({
      level: int(l && l.level, 0, 1000, 0),
      xp: int(l && l.xp, 0, 1e9, 0),
      add: snowList(l && l.add),
      remove: snowList(l && l.remove),
      mode: oneOf(l && l.mode, ['replace', 'stack'], 'replace'),
    }))
    .filter((l) => l.level > 0 && !seen.has(l.level) && seen.add(l.level))
    .sort((p, q) => p.level - q.level);
  for (let i = 1; i < out.levels.length; i++) {
    if (out.levels[i].xp <= out.levels[i - 1].xp) {
      throw new Error(`Level ${out.levels[i].level} needs more XP than level ${out.levels[i - 1].level}`);
    }
  }

  const seenRoles = new Set();
  out.activity.rules = (Array.isArray(a.rules) ? a.rules : [])
    .slice(0, 25)
    .map((q) => ({
      roleId: snow(q && q.roleId),
      required: int(q && q.required, 1, 10000, 20),
      warnings: int(q && q.warnings, 0, 30, 2),
      removeRoles: snowList(q && q.removeRoles),
      giveRoles: snowList(q && q.giveRoles),
    }))
    .filter((q) => q.roleId && !seenRoles.has(q.roleId) && seenRoles.add(q.roleId));

  return out;
}

module.exports = { defaults, sanitize };
