import type { SocialProvider } from './auth.schemas.js';

/** Feature flags the auth module reads from settings (admin → Auth settings). */
export interface AuthFlags {
  guestLoginEnabled(): Promise<boolean>;
  providerEnabled(provider: SocialProvider): Promise<boolean>;
  /** Gems granted on sign-up. */
  signupBonusGems(): Promise<number>;
}

export interface VerifiedIdentity {
  provider: SocialProvider;
  uid: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
  picture?: string | undefined;
  phone?: string | undefined;
}

/** Adapter boundary to Firebase Auth (or any OIDC provider). */
export interface IdTokenVerifier {
  verify(idToken: string): Promise<VerifiedIdentity>;
}

/** Step-up second factor for privileged accounts. Implemented by the WebAuthn service. */
export interface PasskeyGate {
  isRequired(user: { id: string; role: string; requirePasskey?: boolean | null }): Promise<boolean>;
  createLoginChallengeToken(userId: string): Promise<string>;
}
