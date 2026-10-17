import { BlockList, isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { ForbiddenError } from '../core/errors/index.js';

/** Builds a matcher from IPs / CIDRs (`10.0.0.0/8`, `203.0.113.7`, `2001:db8::/32`). Empty list = allow all. */
export function createIpMatcher(entries: readonly string[]): (ip: string | undefined) => boolean {
  if (entries.length === 0) return () => true;
  const list = new BlockList();
  for (const raw of entries) {
    const [addr = '', prefix] = raw.split('/');
    const family = isIP(addr);
    if (!family) throw new Error(`Invalid IP allow-list entry: ${raw}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(prefix), type);
  }
  return (ip) => {
    if (!ip) return false;
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip; // IPv4-mapped IPv6
    const family = isIP(clean);
    return family !== 0 && list.check(clean, family === 4 ? 'ipv4' : 'ipv6');
  };
}

export function ipAllowlist(entries: readonly string[]): RequestHandler {
  const allowed = createIpMatcher(entries);
  return (req, _res, next) => {
    if (allowed(req.ip)) return next();
    next(new ForbiddenError('Your IP address is not allowed to use this endpoint', 'ip_not_allowed'));
  };
}
