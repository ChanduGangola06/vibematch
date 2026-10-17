import { createHash } from 'node:crypto';
import type { Cache } from '../../core/cache/index.js';
import type { Logger } from '../../core/logger/index.js';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type IceConfig =
  | { provider: 'default' }
  | { provider: 'twilio'; accountSid: string; authToken: string }
  | { provider: 'metered'; apiKey: string; appName?: string | undefined }
  | { provider: 'xirsys'; domain: string; secret: string; channel?: string | undefined };

export interface IceConfigProvider {
  get(): Promise<IceConfig>;
}
export const defaultIceConfig: IceConfigProvider = { get: async () => ({ provider: 'default' }) };

export const STUN_FALLBACK: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

type Fetch = typeof fetch;

/** Strategy interface: how to obtain ICE (STUN/TURN) servers from one vendor. */
interface IceStrategy {
  fetch(): Promise<IceServer[]>;
}

const json = async (res: Response): Promise<unknown> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

class DefaultStrategy implements IceStrategy {
  async fetch() {
    return STUN_FALLBACK;
  }
}

class TwilioStrategy implements IceStrategy {
  constructor(private readonly c: { accountSid: string; authToken: string }, private readonly f: Fetch) {}
  async fetch() {
    const auth = Buffer.from(`${this.c.accountSid}:${this.c.authToken}`).toString('base64');
    const data = (await json(
      await this.f(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}/Tokens.json`, {
        method: 'POST', headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000),
      }),
    )) as { ice_servers?: { url?: string; urls?: string | string[]; username?: string; credential?: string }[] };
    return (data.ice_servers ?? []).map((s) => ({ urls: s.urls ?? s.url ?? '', ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) })).filter((s) => s.urls);
  }
}

class MeteredStrategy implements IceStrategy {
  constructor(private readonly c: { apiKey: string; appName?: string | undefined }, private readonly f: Fetch) {}
  async fetch() {
    const host = encodeURIComponent(this.c.appName || this.c.apiKey);
    const data = await json(
      await this.f(`https://${host}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(this.c.apiKey)}`, { signal: AbortSignal.timeout(8000) }),
    );
    return Array.isArray(data) ? (data as IceServer[]) : [];
  }
}

class XirsysStrategy implements IceStrategy {
  constructor(private readonly c: { domain: string; secret: string; channel?: string | undefined }, private readonly f: Fetch) {}
  async fetch() {
    const auth = Buffer.from(`${this.c.domain}:${this.c.secret}`).toString('base64');
    const data = (await json(
      await this.f(`https://global.xirsys.net/_turn/${encodeURIComponent(this.c.channel ?? 'MyFirstApp')}`, {
        method: 'PUT', headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000),
      }),
    )) as { v?: { iceServers?: IceServer } };
    return data.v?.iceServers ? [data.v.iceServers] : [];
  }
}

export function strategyFor(cfg: IceConfig, f: Fetch = fetch): IceStrategy {
  switch (cfg.provider) {
    case 'twilio': return new TwilioStrategy(cfg, f);
    case 'metered': return new MeteredStrategy(cfg, f);
    case 'xirsys': return new XirsysStrategy(cfg, f);
    default: return new DefaultStrategy();
  }
}

/**
 * ICE servers for WebRTC. TURN credentials cost money, so results are cached (shared across users)
 * and a vendor outage degrades to public STUN instead of failing calls.
 */
export class IceService {
  constructor(
    private readonly config: IceConfigProvider,
    private readonly cache: Cache,
    private readonly log: Logger,
    private readonly fetchImpl: Fetch = fetch,
    private readonly ttlSeconds = 600,
  ) {}

  async servers(): Promise<IceServer[]> {
    const cfg = await this.config.get();
    const key = `ice:${createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 16)}`;
    try {
      const servers = await this.cache.wrap(key, () => strategyFor(cfg, this.fetchImpl).fetch(), { ttl: this.ttlSeconds, tags: ['ice'] });
      return servers.length ? servers : STUN_FALLBACK;
    } catch (err) {
      this.log.warn({ err: (err as Error).message, provider: cfg.provider }, 'ICE provider failed; using public STUN');
      return STUN_FALLBACK;
    }
  }
}
