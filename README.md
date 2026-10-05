# Discord Community Bot + Dashboard 🤖

XP leveling, level roles, bad/good words, daily activity demotion, VIP reactions, aur Discord-login wala dashboard. Ek hi Node service (bot + web) Render par chalti hai.

## 1) Discord Developer Portal ⚙️

| Step | Kya karna hai |
|---|---|
| New Application | https://discord.com/developers/applications → New Application |
| Bot tab | Token copy karo → `DISCORD_TOKEN` |
| **Privileged intents** | **Message Content Intent** + **Server Members Intent** dono ON karo (bina iske bot kaam nahi karega) |
| OAuth2 tab | `CLIENT_ID` aur `CLIENT_SECRET` copy karo |
| OAuth2 → Redirects | Add: `https://<tera-service>.onrender.com/auth/callback` |

## 2) PostgreSQL 🐘

Apna existing Postgres use karo. Bas connection string `DATABASE_URL` me daalo, tables (`guilds`, `users`) bot khud bana leta hai pehli baar start par.

- Render ka external URL SSL ke saath chalta hai (default ON). Local DB par SSL band karna ho to `PGSSL=false`.
- Free Render Postgres 30 din baad expire hota hai, to permanent DB (Neon/Supabase/apna server) better hai.

## 3) Render par deploy 🚀

1. Ye folder GitHub repo me push karo
2. Render → New → Web Service (ya Blueprint, `render.yaml` ready hai)
3. Build: `npm install` · Start: `npm start`
4. Environment variables:

| Key | Value |
|---|---|
| `DISCORD_TOKEN` | bot token |
| `CLIENT_ID` | application id |
| `CLIENT_SECRET` | oauth2 secret |
| `BASE_URL` | `https://<tera-service>.onrender.com` (end me `/` nahi) |
| `JWT_SECRET` | khud generate karo (neeche dekho) |
| `DATABASE_URL` | Postgres connection string |
| `TZ_NAME` | `Asia/Kolkata` (daily reset isi timezone me) |

5. **UptimeRobot** par `https://<tera-service>.onrender.com/healthz` ko har 5 min ping karwao, warna free plan so jaata hai aur bot offline ho jayega 😴

## 4) Bot ko server me add karo

Dashboard khol ke **Add the bot to a server** dabao. Permissions auto-set hoti hain: View Channels, Send Messages, Add Reactions, Manage Messages, Manage Roles, Read Message History.

⚠️ Bot ka role server settings me **un sab roles ke upar** hona chahiye jo wo assign/remove karega (Discord hierarchy).

## Features ↔ Dashboard

| Feature | Page |
|---|---|
| XP, cooldown, good bonus, bad penalty, penalty mode | XP & levels |
| Level thresholds, roles add/remove, Replace/Stack | Level roles |
| Bad words / Good words (add, edit, delete) | Bad words / Good words |
| Daily messages, warnings, auto demotion | Activity |
| VIP role + 4 reactions + channel restriction | VIP reactions |
| Warning same/specific/off | Moderation |
| On/off toggles, Discord sync | Server settings |
| Public leaderboard (members bhi dekh sakte hain) | Leaderboard |

## Important rules (jaisa spec me tha)

- Bad-word penalty **flat** hai, level se nahi badhti.
- Bad-word message delete hota hai, us message ka XP/activity count nahi hota.
- Activity demotion XP ko **nahi** chhuta.
- Demotion par rule wala role automatically hata diya jaata hai + tumhare "remove" roles; "give" roles mil jaate hain.
- Din midnight (`TZ_NAME`) par badalta hai. Bot band/so raha ho to bhi agle check par ek baar catch-up hota hai.
- Activity pehli baar ON karne par aaj ke din se count hota hai (purane din par warning nahi).
- XP penalty se level gir sakta hai, par roles apne aap nahi hatte (sirf level-up par roles lagte hain).

## Security

Har protected API request par backend check karta hai: JWT login → server me member hai? → bot installed? → Administrator ya owner? → roles bot ke neeche hain? Frontend chhupana kaafi nahi hai, isliye direct `PUT /api/guilds/:id/config` bhi block hota hai agar admin nahi ho.

## Local run

```bash
cp .env.example .env   # fill values, BASE_URL=http://localhost:3000
npm install
npm start
```
(Local ke liye Discord redirect me `http://localhost:3000/auth/callback` bhi add karo.)

## JWT_SECRET kaise banaye 🔐

Ye kisi service se nahi aata, tum khud random string banate ho (login cookie sign karne ke liye). Terminal me:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Output (64 characters) copy karke `JWT_SECRET` me paste karo. Kisi ko share mat karo, aur badloge to sab users logout ho jayenge. Render Blueprint (`render.yaml`) use karo to wo ise auto-generate bhi kar deta hai.
