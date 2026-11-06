import { createApp } from './app.js';
import { retention, tokenHealthAndRollup } from './cron.js';
import type { Env } from './env.js';

export { ApplyWorkflow } from './apply-workflow.js';
export { InstallDO } from './install-do.js';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === '17 9 * * *') ctx.waitUntil(retention(env));
    else ctx.waitUntil(tokenHealthAndRollup(env));
  },
} satisfies ExportedHandler<Env>;
