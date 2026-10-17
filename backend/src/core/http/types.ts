import type { ApiKeyLevel } from '../security/api-key.js';
import type { Role } from '../security/tokens.js';
import type { Logger } from '../logger/logger.js';

export interface AuthContext {
  userId: string;
  role: Role;
  /** Session (refresh-token family) id. */
  sid: string;
  username?: string | undefined;
}

export interface ApiKeyContext {
  id: string;
  level: ApiKeyLevel;
  scopes: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      auth?: AuthContext;
      apiKey?: ApiKeyContext;
      /** Route pattern that matched (for metrics / audit), e.g. `/users/:id`. */
      routePattern?: string;
      startedAt: number;
    }
  }
}

export {};
