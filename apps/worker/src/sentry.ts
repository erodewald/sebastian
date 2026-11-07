import { errorStatus } from './app.js';
import type { Env } from './env.js';

/** Bad requests, re-auth and SmartThings rejections are normal outcomes, returned to the caller. */
export function isExpectedError(err: unknown): boolean {
  const status = errorStatus(err);
  return status < 500 || status === 502;
}

/** Shared by the fetch/scheduled handlers, InstallDO and ApplyWorkflow. No DSN means no reporting. */
export function sentryOptions(env: Env) {
  return {
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    // Link Worker → InstallDO calls into one trace, but send no trace headers to SmartThings.
    rpcTracePropagationBindings: ['INSTALL'],
    tracePropagationTargets: [],
    // This Worker handles OAuth codes, tokens and Access JWTs: collect none of the request data.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: <T>(event: T, hint: { originalException?: unknown }) =>
      isExpectedError(hint.originalException) ? null : event,
  };
}
