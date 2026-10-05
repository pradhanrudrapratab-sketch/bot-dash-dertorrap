'use strict';

const $app = document.getElementById('app');
const S = { me: null, invite: null, guilds: null, gid: null, guild: null, meta: null, cfg: null, page: null };

const NAV = [
  ['overview', 'Overview'], ['leaderboard', 'Leaderboard'], ['xp', 'XP & levels'], ['levels', 'Level roles'],
  ['badwords', 'Bad words'], ['goodwords', 'Good words'], ['activity', 'Activity'], ['vip', 'VIP reactions'],
  ['moderation', 'Moderation'], ['settings', 'Server settings'],
];
const CONFIG_PAGES = new Set(['xp', 'levels', 'badwords', 'goodwords', 'activity', 'vip', 'moderation', 'settings']);

/* ---------- tiny DOM helper (always textContent -> no XSS from names) ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'disabled' || k === 'selected') e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  if (value !== undefined) e.value = value;
  return e;
}

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok) {
    const e = new Error(j.error || 'Request failed');
    e.status = r.status; e.details = j.details;
    throw e;
  }
  return j;
}

let toastTimer;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, err ? 6000 : 2500);
}

/* ---------- form builders ---------- */
const row = (label, control, hint) =>
  h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('label', {}, label), hint ? h('small', {}, hint) : null), h('div', { class: 'ctl' }, control));
const sheet = (title, intro, ...kids) => h('section', { class: 'sheet' }, h('h2', {}, title), intro ? h('p', {}, intro) : null, kids);
const field = (label, control) => h('div', { class: 'f2' }, h('span', {}, label), control);

const numIn = (o, k, { min = 0, max = 100000, after } = {}) =>
  h('input', { type: 'number', min, max, value: o[k], oninput: (e) => { o[k] = e.target.value === '' ? 0 : Number(e.target.value); if (after) after(); } });
const textIn = (o, k, { max = 300, ph = '' } = {}) =>
  h('input', { type: 'text', maxlength: max, placeholder: ph, value: o[k] || '', oninput: (e) => { o[k] = e.target.value; } });
const toggle = (o, k, after) =>
  h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!o[k], onchange: (e) => { o[k] = e.target.checked; if (after) after(); } }), h('span', {}));
const selectIn = (o, k, opts, after) =>
  h('select', { value: o[k], onchange: (e) => { o[k] = e.target.value; if (after) after(); } }, opts.map(([v, t]) => h('option', { value: v }, t)));

const chanSel = (o, k) =>
  h('select', { value: o[k] || '', onchange: (e) => { o[k] = e.target.value || null; } },
    h('option', { value: '' }, '— none —'),
    S.meta.channels.map((c) => h('option', { value: c.id, disabled: !c.canSend }, '#' + c.name + (c.canSend ? '' : ' (bot can’t send here)'))));

const roleSel = (o, k, { onlyAssignable = true } = {}) =>
  h('select', { value: o[k] || '', onchange: (e) => { o[k] = e.target.value || null; } },
    h('option', { value: '' }, '— none —'),
    [...S.meta.roles].sort((a, b) => b.position - a.position).map((r) =>
      h('option', { value: r.id, disabled: onlyAssignable && !r.assignable }, r.name + (onlyAssignable && !r.assignable ? ' (bot can’t manage)' : ''))));

function chips(o, k, items, placeholder = '+ Add') {
  const byId = new Map(items.map((i) => [i.id, i]));
  const wrap = h('div', { class: 'chips' });
  const draw = () => {
    const cur = o[k] || [];
    wrap.replaceChildren(
      ...cur.map((id) => {
        const i = byId.get(id);
        return h('span', { class: 'chip' },
          i && i.color ? h('i', { class: 'dot', style: `background:${i.color}` }) : null,
          i ? i.label : id,
          h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { o[k] = o[k].filter((x) => x !== id); draw(); } }, '×'));
      }),
      h('select', { onchange: (e) => { if (e.target.value) { o[k] = [...(o[k] || []), e.target.value]; draw(); } } },
        h('option', { value: '' }, placeholder),
        items.filter((i) => !cur.includes(i.id)).map((i) => h('option', { value: i.id, disabled: !!i.disabled }, i.label + (i.disabled ? ' (bot can’t manage)' : '')))),
    );
  };
  draw();
  return wrap;
}
const roleItems = () => [...S.meta.roles].sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, label: r.name, color: r.color, disabled: !r.assignable }));
const chanItems = () => S.meta.channels.map((c) => ({ id: c.id, label: '#' + c.name }));

function wordEditor(holder, placeholder) {
  const listBox = h('div', { class: 'words chips' });
  let filter = '';
  const drawList = () => {
    const shown = holder.list.filter((w) => w.includes(filter));
    listBox.replaceChildren(...(shown.length ? shown.map((w) =>
      h('span', { class: 'chip' },
        h('span', { title: 'Click to edit', style: 'cursor:pointer', onclick: () => {
          const n = prompt('Edit word', w);
          if (n == null) return;
          const v = n.trim().toLowerCase();
          holder.list = [...new Set(holder.list.map((x) => (x === w ? v : x)).filter(Boolean))];
          drawList();
        } }, w),
        h('button', { type: 'button', 'aria-label': 'Remove ' + w, onclick: () => { holder.list = holder.list.filter((x) => x !== w); drawList(); } }, '×'),
      )) : [h('span', { class: 'empty' }, holder.list.length ? 'No match.' : 'No words yet. Add some above.')]));
  };
  const input = h('input', { type: 'text', placeholder });
  const add = () => {
    const ws = input.value.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!ws.length) return;
    holder.list = [...new Set([...holder.list, ...ws])];
    input.value = '';
    drawList();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  drawList();
  return h('div', {},
    h('div', { class: 'addrow' }, input, h('button', { type: 'button', onclick: add }, 'Add words')),
    h('div', { style: 'margin-top:10px' }, h('input', { type: 'search', placeholder: `Filter (${holder.list.length} words)`, oninput: (e) => { filter = e.target.value.toLowerCase(); drawList(); } })),
    listBox);
}

/* ---------- screens ---------- */
function renderLogin(err) {
  $app.replaceChildren(h('div', { class: 'center' },
    h('h1', {}, 'One bot. One dashboard. Your whole community.'),
    h('p', {}, 'Log in with Discord to set up XP, level roles, moderation, activity rules and VIP reactions for the servers you manage.'),
    err ? h('p', { class: 'note warn' }, 'Login failed. Please try again.') : null,
    h('a', { class: 'btn', href: '/auth/login' }, 'Log in with Discord')));
}

function guildIcon(g, cls = 'icon') {
  return g.icon
    ? h('img', { class: cls, alt: '', src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` })
    : h('div', { class: cls }, g.name.slice(0, 1).toUpperCase());
}

async function renderPicker() {
  S.gid = null;
  S.guilds = await api('/guilds');
  $app.replaceChildren(h('div', { class: 'center' },
    h('h1', {}, 'Choose a server'),
    h('p', {}, S.guilds.length ? 'Administrators can manage a server. Everyone else can view its leaderboard.' : 'The bot is not in any server you belong to yet.'),
    h('div', { class: 'picker' }, S.guilds.map((g) =>
      h('a', { class: 'pick', href: `#/g/${g.id}/${g.isAdmin ? 'overview' : 'leaderboard'}` },
        guildIcon(g), h('div', {}, h('b', {}, g.name), h('small', {}, `${g.memberCount} members`), g.isAdmin ? h('span', { class: 'tag' }, 'Admin') : null)))),
    h('a', { class: 'btn alt', href: S.invite, target: '_blank', rel: 'noopener' }, 'Add the bot to a server'),
    h('a', { class: 'btn alt', href: '/auth/logout' }, 'Log out')));
}

async function renderGuild(gid, page) {
  if (!S.guilds) S.guilds = await api('/guilds');
  const g = S.guilds.find((x) => x.id === gid);
  if (!g) { location.hash = '#/'; return; }
  if (!g.isAdmin && page !== 'leaderboard') { location.hash = `#/g/${gid}/leaderboard`; return; }
  if (!NAV.some(([id]) => id === page)) page = 'overview';

  if (S.gid !== gid) {
    S.gid = gid; S.guild = g; S.meta = null; S.cfg = null;
    if (g.isAdmin) {
      [S.meta, S.cfg] = await Promise.all([api(`/guilds/${gid}/meta`), api(`/guilds/${gid}/config`)]);
    }
  }
  S.page = page;

  const nav = h('nav', { class: 'nav' }, NAV.filter(([id]) => g.isAdmin || id === 'leaderboard').map(([id, label]) =>
    h('a', { href: `#/g/${gid}/${id}`, class: id === page ? 'on' : '' }, label)));
  const side = h('aside', { class: 'side' },
    h('a', { class: 'guild', href: '#/' }, guildIcon(g), h('div', {}, h('b', {}, g.name), h('small', {}, 'Switch server'))),
    nav,
    h('div', { class: 'who' }, h('span', {}, S.me.name), h('a', { href: '/auth/logout' }, 'Log out')));

  const title = NAV.find(([id]) => id === page)[1];
  const main = h('main', { class: 'main' }, h('h1', {}, title));
  $app.replaceChildren(h('div', { class: 'shell' }, side, main));

  let body;
  try { body = await PAGES[page](); }
  catch (e) { body = h('p', { class: 'note warn' }, e.message); }
  main.append(body);
  if (CONFIG_PAGES.has(page)) {
    main.append(h('div', { class: 'savebar' }, h('span', { class: 'lede', style: 'margin:0' }, 'Changes apply after saving.'), h('button', { onclick: save }, 'Save changes')));
  }
}

async function save() {
  try {
    S.cfg = await api(`/guilds/${S.gid}/config`, { method: 'PUT', body: S.cfg });
    toast('Saved');
    renderGuild(S.gid, S.page);
  } catch (e) {
    toast(e.message + (e.details ? ': ' + e.details.join('; ') : ''), true);
  }
}

const rerender = () => renderGuild(S.gid, S.page);

/* ---------- pages ---------- */
const PAGES = {
  async overview() {
    const o = await api(`/guilds/${S.gid}/overview`);
    const c = S.cfg, p = S.meta.botPerms;
    const stat = (n, l) => h('div', {}, h('b', {}, Number(n).toLocaleString()), h('span', {}, l));
    const perm = (ok, t) => h('div', { class: 'perm ' + (ok ? 'ok' : 'no') }, t);
    const missing = !p.manageRoles || !p.manageMessages || !p.addReactions || !p.sendMessages;
    return h('div', {},
      h('p', { class: 'lede' }, 'A quick look at this server and what the bot is allowed to do here.'),
      sheet('This server', null, h('div', { class: 'stats' },
        stat(o.members, 'members'), stat(o.tracked, 'members with activity'), stat(o.totalXp, 'total XP earned'),
        stat(o.levels, 'levels set up'), stat(o.badWords, 'bad words'), stat(o.goodWords, 'good words'))),
      sheet('Systems', null,
        perm(c.xp.enabled, 'XP & leveling'), perm(c.badWords.enabled, 'Bad-word moderation'), perm(c.goodWords.enabled, 'Good-word bonus'),
        perm(c.activity.enabled, 'Activity requirements'), perm(c.vip.enabled, 'VIP reactions')),
      sheet('Bot permissions', null,
        perm(p.manageRoles, 'Manage Roles (level rewards, demotion)'), perm(p.manageMessages, 'Manage Messages (delete bad words)'),
        perm(p.addReactions, 'Add Reactions (VIP)'), perm(p.sendMessages, 'Send Messages (warnings, level-ups)'),
        missing ? h('p', { class: 'note warn' }, 'Some permissions are missing. Features that need them will not work until you grant them in Discord, then press Sync in Server settings.') : null,
        h('p', { class: 'note' }, `Bot's highest role: ${S.meta.botTopRole}. It can only manage roles below it.`)));
  },

  async leaderboard() {
    const d = await api(`/guilds/${S.gid}/leaderboard`);
    const item = (u, mine) => {
      const pct = u.next ? Math.min(100, Math.round(((u.xp - u.floor) / (u.next - u.floor)) * 100)) : 100;
      const bar = h('i', {}); bar.style.width = pct + '%';
      return h('li', { class: `r${u.rank}${mine ? ' me' : ''}` },
        h('div', { class: 'rank' }, u.rank),
        u.avatar ? h('img', { class: 'ava', alt: '', src: u.avatar }) : h('div', { class: 'ava' }),
        h('div', { class: 'who2' },
          h('div', { class: 'nm' }, u.name, h('small', {}, `Level ${u.level} · ${u.xp.toLocaleString()} XP`)),
          h('div', { class: 'bar', title: u.next ? `${u.next - u.xp} XP to next level` : 'Top level' }, bar)));
    };
    return h('div', {},
      h('p', { class: 'lede' }, 'The most active members of this server. Bars show progress to the next level.'),
      d.me && d.me.rank > 50 ? sheet('Your rank', null, h('ol', { class: 'board' }, item(d.me, true))) : null,
      h('section', { class: 'sheet' }, d.rows.length
        ? h('ol', { class: 'board' }, d.rows.map((u) => item(u, d.me && u.userId === d.me.userId)))
        : h('p', { class: 'empty' }, 'Nobody has earned XP yet. Send a message in the server to get on the board.')));
  },

  async xp() {
    const x = S.cfg.xp, lu = S.cfg.levelUp;
    const prev = h('p', { class: 'note' });
    const upd = () => {
      const good = Math.round(x.perMessage * (1 + x.goodBonusPct / 100));
      prev.textContent = `Normal message +${x.perMessage} XP · Good-word message +${good} XP · Bad word −${x.badPenalty} XP`;
    };
    upd();
    return h('div', {},
      h('p', { class: 'lede' }, 'How members earn and lose XP in this server.'),
      sheet('XP rules', null,
        row('XP per message', numIn(x, 'perMessage', { max: 1000, after: upd })),
        row('Cooldown (seconds)', numIn(x, 'cooldownSec', { max: 3600 }), 'A member earns XP at most once per cooldown.'),
        row('Good-word bonus (%)', numIn(x, 'goodBonusPct', { max: 1000, after: upd }), 'Extra XP when a message contains a good word.'),
        row('Bad-word penalty (XP)', numIn(x, 'badPenalty', { max: 100000, after: upd }), 'Flat amount. It does not grow with level.'),
        row('Penalty mode', selectIn(x, 'penaltyMode', [['per_word', 'Per bad word'], ['per_message', 'Once per message']])),
        prev),
      sheet('Level-up message', 'Posted when a member reaches a new level. Use {user} and {level}.',
        row('Where to post', selectIn(lu, 'mode', [['same', 'Same channel'], ['channel', 'Specific channel'], ['none', 'Don’t post']], rerender)),
        lu.mode === 'channel' ? row('Channel', chanSel(lu, 'channelId')) : null,
        row('Message', textIn(lu, 'message'))));
  },

  async levels() {
    const c = S.cfg;
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren(...(c.levels.length ? c.levels.map((l, i) =>
        h('div', { class: 'lvl' },
          h('div', { class: 'lvl-head' },
            h('div', { class: 'f' }, h('span', {}, 'Level'), numIn(l, 'level', { min: 1, max: 1000 })),
            h('div', { class: 'f' }, h('span', {}, 'Total XP needed'), numIn(l, 'xp', { max: 1e9 })),
            h('div', { class: 'f' }, h('span', {}, 'Role behavior'), selectIn(l, 'mode', [['replace', 'Replace (remove listed roles)'], ['stack', 'Stack (keep old roles)']])),
            h('button', { class: 'ghost danger', type: 'button', onclick: () => { c.levels.splice(i, 1); draw(); } }, 'Delete level')),
          field('Roles to add', chips(l, 'add', roleItems())),
          field('Roles to remove (Replace mode only)', chips(l, 'remove', roleItems())))
      ) : [h('p', { class: 'empty' }, 'No levels yet. Add your first level to start rewarding members.')]));
    };
    draw();
    const addLevel = () => {
      const last = c.levels.reduce((m, l) => (l.level > m.level ? l : m), { level: 0, xp: 0 });
      c.levels.push({ level: last.level + 1, xp: last.xp + 100, add: [], remove: [], mode: 'replace' });
      draw();
    };
    return h('div', {},
      h('p', { class: 'lede' }, 'Pick the XP each level needs and the roles members get on reaching it. XP must rise with every level.'),
      sheet('Levels', null, list, h('button', { type: 'button', class: 'ghost', onclick: addLevel }, '+ Add level')));
  },

  async badwords() {
    const b = S.cfg.badWords, x = S.cfg.xp;
    return h('div', {},
      h('p', { class: 'lede' }, 'Messages containing these words are deleted and the author loses XP.'),
      sheet('Bad words', null,
        row('Enabled', toggle(b, 'enabled')),
        h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('label', {}, 'Word list'), h('small', {}, 'Matches whole words, ignoring case.')), h('div', { class: 'ctl' }, wordEditor(b, 'Add bad words (comma or new line separated)')))),
      sheet('Penalty', null,
        row('Penalty (XP)', numIn(x, 'badPenalty', { max: 100000 }), 'Same for every level.'),
        row('Penalty mode', selectIn(x, 'penaltyMode', [['per_word', 'Per bad word'], ['per_message', 'Once per message']]))));
  },

  async goodwords() {
    const g = S.cfg.goodWords, x = S.cfg.xp;
    return h('div', {},
      h('p', { class: 'lede' }, 'Positive words earn a bonus on top of the normal message XP.'),
      sheet('Good words', null,
        row('Enabled', toggle(g, 'enabled')),
        row('Bonus (%)', numIn(x, 'goodBonusPct', { max: 1000 })),
        h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('label', {}, 'Word list')), h('div', { class: 'ctl' }, wordEditor(g, 'Add good words (comma or new line separated)')))));
  },

  async activity() {
    const a = S.cfg.activity;
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren(...(a.rules.length ? a.rules.map((r, i) =>
        h('div', { class: 'lvl' },
          h('div', { class: 'lvl-head' },
            h('div', { class: 'f' }, h('span', {}, 'Role to keep active'), roleSel(r, 'roleId')),
            h('div', { class: 'f' }, h('span', {}, 'Messages per day'), numIn(r, 'required', { min: 1, max: 10000 })),
            h('div', { class: 'f' }, h('span', {}, 'Warnings before demotion'), numIn(r, 'warnings', { min: 0, max: 30 })),
            h('button', { class: 'ghost danger', type: 'button', onclick: () => { a.rules.splice(i, 1); draw(); } }, 'Delete rule')),
          field('Extra roles to remove on demotion', chips(r, 'removeRoles', roleItems())),
          field('Roles to give on demotion', chips(r, 'giveRoles', roleItems())))
      ) : [h('p', { class: 'empty' }, 'No rules yet. Add a rule to require daily activity for a role.')]));
    };
    draw();
    return h('div', {},
      h('p', { class: 'lede' }, `Members with a rule's role must send enough messages every day (day changes at midnight, ${S.meta.timezone}). Each missed day is a warning; once warnings are used up, the next miss demotes them. The rule's own role is always removed on demotion. XP is never touched.`),
      sheet('Activity requirements', null,
        row('Enabled', toggle(a, 'enabled')),
        row('Send warnings in', chanSel(a, 'notifyChannelId'), 'Leave empty to warn members by direct message.')),
      sheet('Rules', null, list, h('button', { type: 'button', class: 'ghost', onclick: () => { a.rules.push({ roleId: null, required: 20, warnings: 2, removeRoles: [], giveRoles: [] }); draw(); } }, '+ Add rule')));
  },

  async vip() {
    const v = S.cfg.vip;
    let slot = 0;
    const inputs = [];
    for (let i = 0; i < 4; i++) {
      const inp = h('input', { type: 'text', maxlength: 64, 'aria-label': `Reaction ${i + 1}`, value: v.reactions[i] || '', onfocus: () => { slot = i; mark(); },
        oninput: (e) => { v.reactions[i] = e.target.value.trim(); } });
      inputs.push(inp);
    }
    const mark = () => inputs.forEach((inp, i) => inp.classList.toggle('cur', i === slot));
    mark();
    const picker = h('div', { class: 'emojis' }, S.meta.emojis.map((e) =>
      h('button', { type: 'button', title: e.name, onclick: () => { v.reactions[slot] = e.value; inputs[slot].value = e.value; } },
        h('img', { alt: e.name, src: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48` }))));
    while (v.reactions.length < 4) v.reactions.push('');
    return h('div', {},
      h('p', { class: 'lede' }, 'When someone @mentions a member with the VIP role, the bot adds these reactions to that message. It never replies or posts anything.'),
      sheet('VIP reactions', null,
        row('Enabled', toggle(v, 'enabled')),
        row('VIP role', roleSel(v, 'roleId', { onlyAssignable: false })),
        row('Reactions', h('div', {}, h('div', { class: 'slots' }, inputs), S.meta.emojis.length ? h('p', { class: 'note' }, 'Type any emoji, or click a server emoji below to fill the highlighted slot.') : null, S.meta.emojis.length ? picker : null)),
        row('Only in channels', chips(v, 'channelIds', chanItems(), '+ Add channel'), 'Leave empty to work everywhere.')));
  },

  async moderation() {
    const m = S.cfg.moderation;
    return h('div', {},
      h('p', { class: 'lede' }, 'What happens after a bad-word message is deleted. Use {user}, {xp} and {channel} in the message.'),
      sheet('Warning message', null,
        row('Where to warn', selectIn(m, 'warnMode', [['same', 'Same channel'], ['channel', 'Specific channel'], ['none', 'No warning']], rerender)),
        m.warnMode === 'channel' ? row('Channel', chanSel(m, 'warnChannelId')) : null,
        m.warnMode !== 'none' ? row('Message', textIn(m, 'warnMessage')) : null,
        m.warnMode === 'same' ? row('Remove warning after (seconds)', numIn(m, 'warnDeleteAfterSec', { max: 600 }), '0 keeps it in the channel.') : null));
  },

  async settings() {
    const c = S.cfg, p = S.meta.botPerms;
    const sync = async (e) => {
      e.target.disabled = true;
      try { S.meta = await api(`/guilds/${S.gid}/sync`, { method: 'POST' }); toast('Roles, channels and emojis refreshed'); rerender(); }
      catch (err) { toast(err.message, true); e.target.disabled = false; }
    };
    return h('div', {},
      h('p', { class: 'lede' }, 'Turn whole systems on or off and refresh data from Discord.'),
      sheet('Systems', null,
        row('XP & leveling', toggle(c.xp, 'enabled')),
        row('Bad-word moderation', toggle(c.badWords, 'enabled')),
        row('Good-word bonus', toggle(c.goodWords, 'enabled')),
        row('Activity requirements', toggle(c.activity, 'enabled')),
        row('VIP reactions', toggle(c.vip, 'enabled'))),
      sheet('Discord sync', 'Created a new role, channel or emoji in Discord? Refresh to see it here.',
        h('button', { type: 'button', onclick: sync }, 'Sync with Discord'),
        !p.manageRoles ? h('p', { class: 'note warn' }, 'The bot lacks the Manage Roles permission, so role rewards are disabled.') : null));
  },
};

/* ---------- router ---------- */
async function route() {
  try {
    if (!S.me) { const r = await api('/me'); S.me = r.user; S.invite = r.inviteUrl; }
  } catch (e) {
    if (e.status === 401) return renderLogin(new URLSearchParams(location.search).get('error'));
    return $app.replaceChildren(h('p', { class: 'note warn' }, e.message));
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'g' && parts[1]) await renderGuild(parts[1], parts[2] || 'overview');
    else await renderPicker();
  } catch (e) {
    if (e.status === 401) { S.me = null; return renderLogin(); }
    toast(e.message, true);
    if (e.status === 403 || e.status === 404) { S.gid = null; location.hash = '#/'; }
  }
}
window.addEventListener('hashchange', route);
route();
