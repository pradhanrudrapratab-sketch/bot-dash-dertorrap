require('dotenv').config();

const need = (k) => {
  if (!process.env[k]) throw new Error(`Missing environment variable: ${k}`);
  return process.env[k];
};

module.exports = {
  token: need('DISCORD_TOKEN'),
  clientId: need('CLIENT_ID'),
  clientSecret: need('CLIENT_SECRET'),
  baseUrl: need('BASE_URL').replace(/\/+$/, ''),
  jwtSecret: need('JWT_SECRET'),
  dbUrl: (() => {
    const u = need('DATABASE_URL').trim().replace(/^["']|["']$/g, '');
    if (!/^postgres(ql)?:\/\//i.test(u)) {
      throw new Error('DATABASE_URL must start with postgresql:// (check for https:// or extra quotes)');
    }
    return u;
  })(),
  tz: process.env.TZ_NAME || 'Asia/Kolkata',
  port: Number(process.env.PORT) || 3000,
};
