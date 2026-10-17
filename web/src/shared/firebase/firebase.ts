/**
 * Lazy Firebase Auth wrapper. The SDK (~100 KB) is only downloaded when someone actually chooses a social or
 * phone sign-in. The server verifies the resulting ID token — nothing the browser says about the user is trusted.
 */
import type { Auth, ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';

export type SocialProvider = 'google' | 'facebook' | 'apple' | 'twitter';

let auth: Auth | undefined;
let configJson = '';
let phoneVerifier: RecaptchaVerifier | undefined;
let confirmation: ConfirmationResult | undefined;

async function getAuthInstance(config: string): Promise<Auth> {
  if (auth && config === configJson) return auth;
  const [{ getApp, getApps, initializeApp }, { getAuth }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new Error('Social sign-in is not configured.');
  }
  if (!parsed.apiKey || !parsed.projectId) throw new Error('Social sign-in is not configured.');
  const app = getApps().find((a) => a.name === 'vibematch') ?? initializeApp(parsed, 'vibematch');
  auth = getAuth(getApp(app.name));
  configJson = config;
  return auth;
}

export async function signInWithProvider(provider: SocialProvider, config: string): Promise<string> {
  const a = await getAuthInstance(config);
  const m = await import('firebase/auth');
  const p = {
    google: () => new m.GoogleAuthProvider(),
    facebook: () => new m.FacebookAuthProvider(),
    apple: () => new m.OAuthProvider('apple.com'),
    twitter: () => new m.TwitterAuthProvider(),
  }[provider]();
  const result = await m.signInWithPopup(a, p);
  return result.user.getIdToken();
}

/** Step 1 of phone sign-in: sends the SMS. `containerId` hosts the invisible reCAPTCHA. */
export async function sendPhoneCode(phoneE164: string, containerId: string, config: string): Promise<void> {
  const a = await getAuthInstance(config);
  const m = await import('firebase/auth');
  phoneVerifier?.clear();
  phoneVerifier = new m.RecaptchaVerifier(a, containerId, { size: 'invisible' });
  confirmation = await m.signInWithPhoneNumber(a, phoneE164, phoneVerifier);
}

/** Step 2: returns the ID token for the confirmed phone number. */
export async function confirmPhoneCode(code: string): Promise<string> {
  if (!confirmation) throw new Error('Request a code first.');
  const cred = await confirmation.confirm(code);
  return cred.user.getIdToken();
}

/** Maps Firebase error codes to messages a person can act on. */
export function firebaseMessage(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const known: Record<string, string> = {
    'auth/popup-closed-by-user': 'The sign-in window was closed.',
    'auth/cancelled-popup-request': 'The sign-in window was closed.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups and try again.',
    'auth/invalid-phone-number': 'Enter the number in international format, e.g. +14155550123.',
    'auth/too-many-requests': 'Too many attempts. Please wait a few minutes.',
    'auth/invalid-verification-code': 'That code is not correct.',
    'auth/code-expired': 'That code has expired. Request a new one.',
    'auth/network-request-failed': 'Network error. Check your connection.',
  };
  return known[code] ?? (e instanceof Error ? e.message : 'Sign-in failed.');
}
