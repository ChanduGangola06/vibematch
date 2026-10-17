import type { UserDoc } from '../../infra/db/models/user.js';
import type { AdminUser, PublicUser, SelfUser } from './user.schemas.js';

type UserLike = Omit<UserDoc, 'passwordHash'> & { passwordHash?: string | null | undefined };

const iso = (d: Date | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);
export const isVipNow = (u: Pick<UserLike, 'vipExpiry'>, now = Date.now()): boolean =>
  Boolean(u.vipExpiry && new Date(u.vipExpiry).getTime() > now);

/**
 * Explicit DTO mappers — the only way user data leaves the service layer. Whitelisting fields here
 * (instead of deleting secret ones) means a new column can never leak by accident (OWASP API3).
 */
export function toSelfUser(u: UserLike): SelfUser {
  const vip = iso(u.vipExpiry);
  return {
    id: u.id,
    username: u.username,
    name: u.name ?? '',
    ...(u.email ? { email: u.email } : {}),
    avatar: u.avatar ?? '',
    gender: u.gender ?? '',
    country: u.country ?? '',
    countryCode: u.countryCode ?? '',
    ...(u.age != null ? { age: u.age } : {}),
    bio: u.bio ?? '',
    phone: u.phone ?? '',
    address: u.address ?? '',
    gems: u.gems ?? 0,
    likesCount: u.likesCount ?? 0,
    followersCount: u.followersCount ?? 0,
    followingCount: u.followingCount ?? 0,
    ...(vip ? { vipExpiry: vip } : {}),
    isVip: isVipNow(u),
    role: u.role ?? 'user',
    isGuest: u.role === 'guest',
    createdAt: iso(u.createdAt) ?? new Date(0).toISOString(),
  };
}

export function toPublicUser(u: UserLike): PublicUser {
  return {
    id: u.id,
    username: u.username,
    name: u.name ?? '',
    avatar: u.avatar ?? '',
    gender: u.gender ?? '',
    country: u.country ?? '',
    countryCode: u.countryCode ?? '',
    ...(u.age != null ? { age: u.age } : {}),
    bio: u.bio ?? '',
    likesCount: u.likesCount ?? 0,
    followersCount: u.followersCount ?? 0,
    followingCount: u.followingCount ?? 0,
    isOnline: Boolean(u.isOnline),
    isVip: isVipNow(u),
  };
}

export function toAdminUser(u: UserLike): AdminUser {
  const last = iso(u.lastLoginAt);
  return {
    ...toSelfUser(u),
    isBanned: Boolean(u.isBanned),
    isDemo: Boolean(u.isDemo),
    isOnline: Boolean(u.isOnline),
    ...(last ? { lastLoginAt: last } : {}),
    requirePasskey: Boolean(u.requirePasskey),
    videoUrl: u.videoUrl ?? '',
  };
}
