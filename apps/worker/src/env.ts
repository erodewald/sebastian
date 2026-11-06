import type { ApplyParams } from './apply-workflow.js';
import type { InstallDO } from './install-do.js';

export interface Env {
  INSTALL: DurableObjectNamespace<InstallDO>;
  DB: D1Database;
  APPLY: Workflow<ApplyParams>;

  PUBLIC_ORIGIN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ST_SCOPES: string;
  USER_AGENT: string;
  /** SmartThings appId; CONFIRMATION messages for any other app are refused. */
  ST_APP_ID: string;

  // secrets
  ST_CLIENT_ID: string;
  ST_CLIENT_SECRET: string;
  /** base64-encoded 32-byte key; encrypts tokens at rest and signs OAuth state. */
  DATA_KEY: string;
}

/** The InstallDO instance that holds pending OAuth `state` nonces (we don't know the installedAppId yet). */
export const OAUTH_DO_NAME = '__oauth__';

export function installStub(env: Env, installedAppId: string) {
  return env.INSTALL.get(env.INSTALL.idFromName(installedAppId));
}
