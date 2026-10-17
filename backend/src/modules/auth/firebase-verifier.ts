import { UnauthorizedError, ServiceUnavailableError } from '../../core/errors/index.js';
import type { IdTokenVerifier, VerifiedIdentity } from './auth.ports.js';
import type { SocialProvider } from './auth.schemas.js';

/** Firebase `sign_in_provider` → our provider names. Anonymous and custom tokens are not accepted. */
const PROVIDER_MAP: Record<string, SocialProvider> = {
  'google.com': 'google',
  'facebook.com': 'facebook',
  'apple.com': 'apple',
  'twitter.com': 'twitter',
  phone: 'phone',
};

interface DecodedToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  phone_number?: string;
  firebase?: { sign_in_provider?: string };
}

export type VerifyFn = (idToken: string) => Promise<DecodedToken>;

export function identityFromDecoded(d: DecodedToken): VerifiedIdentity {
  const provider = PROVIDER_MAP[d.firebase?.sign_in_provider ?? ''];
  if (!provider) throw new UnauthorizedError('Unsupported sign-in provider', 'provider_unsupported');
  return {
    provider,
    uid: d.uid,
    email: d.email,
    emailVerified: d.email_verified,
    name: d.name,
    picture: d.picture,
    phone: d.phone_number,
  };
}

/**
 * Adapter over firebase-admin. The SDK is imported and initialised on first use, with credentials
 * read lazily (env now, admin settings later), so the API boots fine without Firebase configured.
 */
export class FirebaseIdTokenVerifier implements IdTokenVerifier {
  private verifyFn: VerifyFn | undefined;

  constructor(
    private readonly getServiceAccountJson: () => Promise<string | undefined>,
    private readonly injected?: VerifyFn,
  ) {
    this.verifyFn = injected;
  }

  private async init(): Promise<VerifyFn> {
    if (this.verifyFn) return this.verifyFn;
    const json = await this.getServiceAccountJson();
    if (!json || json.length < 10) {
      throw new ServiceUnavailableError('Social sign-in is not configured on this server');
    }
    const [{ cert, getApps, initializeApp }, { getAuth }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/auth'),
    ]);
    const app =
      getApps().find((a) => a.name === 'vibematch-auth') ??
      initializeApp({ credential: cert(JSON.parse(json) as never) }, 'vibematch-auth');
    const auth = getAuth(app);
    this.verifyFn = (t) => auth.verifyIdToken(t, true) as Promise<DecodedToken>;
    return this.verifyFn;
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    const fn = await this.init();
    let decoded: DecodedToken;
    try {
      decoded = await fn(idToken);
    } catch {
      throw new UnauthorizedError('ID token invalid or expired', 'id_token_invalid');
    }
    return identityFromDecoded(decoded);
  }
}
