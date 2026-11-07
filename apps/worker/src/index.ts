import * as Sentry from '@sentry/cloudflare';
import { createApp } from './app.js';
import { ApplyWorkflow as BaseApplyWorkflow } from './apply-workflow.js';
import { retention, tokenHealthAndRollup } from './cron.js';
import type { Env } from './env.js';
import { InstallDO as BaseInstallDO } from './install-do.js';
import { sentryOptions } from './sentry.js';

export const ApplyWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, BaseApplyWorkflow);
export const InstallDO = Sentry.instrumentDurableObjectWithSentry(sentryOptions, BaseInstallDO);

const app = createApp();

export default Sentry.withSentry(sentryOptions, {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === '17 9 * * *') ctx.waitUntil(retention(env));
    else ctx.waitUntil(tokenHealthAndRollup(env));
  },
} satisfies ExportedHandler<Env>);
