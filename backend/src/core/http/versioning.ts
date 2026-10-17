import type { RequestHandler } from 'express';
import { NotAcceptableError } from '../errors/index.js';

export interface VersionPolicy {
  /** Versions this server can serve, e.g. ['1']. */
  supported: readonly string[];
  /** Version a request without `Accept-Version` is served with. */
  current: string;
  /** Deprecated versions → optional sunset date (HTTP-date) clients should migrate before. */
  deprecated?: Record<string, { sunset?: Date; link?: string }>;
}

/**
 * Header-based negotiation on top of the `/api/v1` URL prefix:
 *   Accept-Version: 1      → ok
 *   Accept-Version: 7      → 406 version_not_supported
 * The URL prefix is the canonical version; the header lets clients assert what they expect.
 * Deprecated versions advertise `Deprecation` / `Sunset` (RFC 9745 / RFC 8594).
 */
export function versionNegotiation(policy: VersionPolicy, urlVersion: string): RequestHandler {
  return (req, res, next) => {
    const asked = req.header('accept-version')?.trim();
    if (asked && asked !== urlVersion) {
      if (!policy.supported.includes(asked)) {
        return next(
          new NotAcceptableError(`API version "${asked}" is not supported. Supported: ${policy.supported.join(', ')}`, {
            extensions: { supported: policy.supported },
          }),
        );
      }
      return next(new NotAcceptableError(`This endpoint serves version ${urlVersion}; requested ${asked}`));
    }
    res.setHeader('API-Version', urlVersion);
    const dep = policy.deprecated?.[urlVersion];
    if (dep) {
      res.setHeader('Deprecation', 'true');
      if (dep.sunset) res.setHeader('Sunset', dep.sunset.toUTCString());
      if (dep.link) res.setHeader('Link', `<${dep.link}>; rel="deprecation"`);
    }
    next();
  };
}
