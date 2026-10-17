import bcrypt from 'bcryptjs';

/** bcrypt only looks at the first 72 *bytes*; longer secrets are rejected by validation instead of silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

export async function hashPassword(plain: string, cost: number): Promise<string> {
  return bcrypt.hash(plain, cost);
}

export interface PasswordCheck {
  valid: boolean;
  /** True when the stored hash uses a lower cost than currently configured — re-hash on next login. */
  needsRehash: boolean;
}

export async function verifyPassword(plain: string, hash: string | undefined | null, cost: number): Promise<PasswordCheck> {
  // Constant-ish time even for unknown users: compare against a dummy hash.
  const known = Boolean(hash && /^\$2[aby]\$\d{2}\$/.test(hash));
  const target = known ? (hash as string) : await dummyHash(cost);
  const valid = (await bcrypt.compare(plain, target)) && known;
  const rounds = known ? bcrypt.getRounds(target) : cost;
  return { valid, needsRehash: valid && rounds < cost };
}

// Hash of a random string, built once, used to equalise timing for unknown accounts.
let dummy: Promise<string> | undefined;
const dummyHash = (cost: number): Promise<string> => (dummy ??= bcrypt.hash(`dummy-${Math.random()}`, cost));
