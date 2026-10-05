const env = require('./config');
const db = require('./db');
const { client } = require('./bot');
const { createApp } = require('./web');
const activity = require('./activity');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

(async () => {
  await db.connect();
  createApp().listen(env.port, () => console.log(`[web] listening on :${env.port}`));
  await client.login(env.token);
  activity.start();
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
