const env = require('./config');

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.tz, year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayKey = (d = new Date()) => dayFmt.format(d); // "2026-10-04"

const prevDay = (key) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const yesterdayKey = () => prevDay(dayKey());

const fmt = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));

// cfg.levels is sorted by level asc with strictly increasing xp
function levelFor(cfg, xp) {
  let lv = 0;
  for (const l of cfg.levels) { if (xp >= l.xp) lv = l.level; else break; }
  return lv;
}

function levelInfo(cfg, xp) {
  let level = 0, floor = 0, next = null;
  for (const l of cfg.levels) {
    if (xp >= l.xp) { level = l.level; floor = l.xp; } else { next = l.xp; break; }
  }
  return { level, floor, next };
}

async function retryDup(fn) {
  try { return await fn(); } catch (e) { if (e && e.code === 11000) return fn(); throw e; }
}

module.exports = { dayKey, prevDay, yesterdayKey, fmt, levelFor, levelInfo, retryDup };
