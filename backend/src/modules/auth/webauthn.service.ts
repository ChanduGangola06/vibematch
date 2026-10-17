import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../core/errors/index.js';
import { AuthChallengeModel, AuthCredentialModel } from '../../infra/db/models/auth.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { PasskeyGate } from './auth.ports.js';

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface PasskeyInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  deviceType?: string;
  backedUp?: boolean;
}

/**
 * WebAuthn / passkeys (FIDO2) for privileged accounts.
 *  - registration: an authenticated admin enrols an authenticator
 *  - login: either a step-up after the password (when required) or passwordless sign-in
 * Challenges are server-side, single-use and expire after 5 minutes (replay protection).
 */
export class WebAuthnService implements PasskeyGate {
  constructor(private readonly env: Env) {}

  private get origins(): string[] {
    const configured = this.env.WEBAUTHN_ORIGINS;
    return configured.length ? configured : [...new Set([this.env.PUBLIC_URL, ...this.env.corsOrigins])];
  }

  // ---- gate used by AuthService ------------------------------------------------------------
  async isRequired(user: { id: string; role: string; requirePasskey?: boolean | null }): Promise<boolean> {
    if (user.role !== 'admin') return false;
    if (!(this.env.REQUIRE_ADMIN_PASSKEY || user.requirePasskey)) return false;
    return (await AuthCredentialModel.countDocuments({ userId: user.id })) > 0;
  }

  async createLoginChallengeToken(userId: string): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await AuthChallengeModel.create({
      key: `login:${token}`, challenge: '', purpose: 'login', userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
    return token;
  }

  // ---- registration ------------------------------------------------------------------------
  async registrationOptions(userId: string) {
    const user = await UserModel.findOne({ id: userId }, { username: 1, name: 1, id: 1 }).lean();
    if (!user) throw new NotFoundError('Account');
    const existing = await AuthCredentialModel.find({ userId }).lean();
    const options = await generateRegistrationOptions({
      rpName: this.env.WEBAUTHN_RP_NAME,
      rpID: this.env.WEBAUTHN_RP_ID,
      userName: user.username,
      userDisplayName: user.name || user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: 60_000,
    });
    await AuthChallengeModel.findOneAndUpdate(
      { key: `reg:${userId}` },
      { $set: { challenge: options.challenge, purpose: 'register', userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) } },
      { upsert: true },
    );
    return options;
  }

  async registrationVerify(userId: string, response: RegistrationResponseJSON, label?: string): Promise<PasskeyInfo> {
    const ch = await AuthChallengeModel.findOneAndDelete({ key: `reg:${userId}`, expiresAt: { $gt: new Date() } }).lean();
    if (!ch) throw new BadRequestError('Registration challenge expired or missing; start again', { extensions: { code: 'challenge_missing' } });

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.origins,
        expectedRPID: this.env.WEBAUTHN_RP_ID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new BadRequestError(`Passkey registration failed: ${(err as Error).message}`);
    }
    if (!verification.verified) throw new BadRequestError('Passkey registration could not be verified');

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const doc = await AuthCredentialModel.create({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      label: (label ?? 'Passkey').slice(0, 60),
    });
    return this.toInfo(doc.toObject());
  }

  // ---- authentication ----------------------------------------------------------------------
  async loginOptions(input: { challengeToken?: string | undefined; username?: string | undefined }) {
    let token = input.challengeToken;
    let userId: string;

    if (token) {
      const doc = await AuthChallengeModel.findOne({ key: `login:${token}`, expiresAt: { $gt: new Date() } }).lean();
      if (!doc?.userId) throw new UnauthorizedError('Login session expired; sign in again', 'challenge_expired');
      userId = doc.userId;
    } else if (input.username) {
      // Passwordless: only for accounts that actually have passkeys.
      const user = await UserModel.findOne({ usernameLower: input.username.toLowerCase(), role: 'admin' }, { id: 1 }).lean();
      const count = user ? await AuthCredentialModel.countDocuments({ userId: user.id }) : 0;
      if (!user || count === 0) throw new UnauthorizedError('Passkey sign-in is not available for this account', 'passkey_unavailable');
      userId = user.id;
      token = await this.createLoginChallengeToken(userId);
    } else {
      throw new BadRequestError('challengeToken or username is required');
    }

    const creds = await AuthCredentialModel.find({ userId }).lean();
    const options = await generateAuthenticationOptions({
      rpID: this.env.WEBAUTHN_RP_ID,
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
      userVerification: 'preferred',
      timeout: 60_000,
    });
    await AuthChallengeModel.updateOne({ key: `login:${token}` }, { $set: { challenge: options.challenge } });
    return { challengeToken: token, options };
  }

  /** Returns the verified user id; the caller (route) then issues the session. */
  async loginVerify(challengeToken: string, response: AuthenticationResponseJSON): Promise<string> {
    // Single use: deleting the challenge up-front means a captured assertion can never be replayed.
    const ch = await AuthChallengeModel.findOneAndDelete({
      key: `login:${challengeToken}`, challenge: { $ne: '' }, expiresAt: { $gt: new Date() },
    }).lean();
    if (!ch?.userId) throw new UnauthorizedError('Login session expired; sign in again', 'challenge_expired');

    const cred = await AuthCredentialModel.findOne({ credentialId: response.id, userId: ch.userId }).lean();
    if (!cred) throw new UnauthorizedError('Unknown passkey', 'passkey_unknown');

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.origins,
        expectedRPID: this.env.WEBAUTHN_RP_ID,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: cred.transports as AuthenticatorTransport[],
        },
        requireUserVerification: false,
      });
    } catch {
      throw new UnauthorizedError('Passkey verification failed', 'passkey_invalid');
    }
    if (!verification.verified) throw new UnauthorizedError('Passkey verification failed', 'passkey_invalid');

    // verifyAuthenticationResponse already rejects a non-increasing signature counter (cloned authenticator).
    const newCounter = verification.authenticationInfo.newCounter;
    await AuthCredentialModel.updateOne({ credentialId: cred.credentialId }, { $set: { counter: newCounter, lastUsedAt: new Date() } });
    return ch.userId;
  }

  // ---- management --------------------------------------------------------------------------
  async list(userId: string): Promise<PasskeyInfo[]> {
    const docs = await AuthCredentialModel.find({ userId }).sort({ createdAt: -1 }).lean();
    return docs.map((d) => this.toInfo(d));
  }

  async remove(userId: string, credentialId: string): Promise<void> {
    const res = await AuthCredentialModel.deleteOne({ userId, credentialId });
    if (res.deletedCount === 0) throw new NotFoundError('Passkey');
    if ((await AuthCredentialModel.countDocuments({ userId })) === 0) {
      await UserModel.updateOne({ id: userId }, { $set: { requirePasskey: false } });
    }
  }

  async setRequired(userId: string, required: boolean): Promise<void> {
    if (required && (await AuthCredentialModel.countDocuments({ userId })) === 0) {
      throw new ForbiddenError('Register at least one passkey before requiring it', 'no_passkey');
    }
    await UserModel.updateOne({ id: userId }, { $set: { requirePasskey: required } });
  }

  private toInfo(d: { credentialId: string; label?: string | null; createdAt?: Date | null; lastUsedAt?: Date | null; deviceType?: string | null; backedUp?: boolean | null }): PasskeyInfo {
    return {
      id: d.credentialId,
      label: d.label ?? 'Passkey',
      createdAt: (d.createdAt ?? new Date(0)).toISOString(),
      ...(d.lastUsedAt ? { lastUsedAt: d.lastUsedAt.toISOString() } : {}),
      ...(d.deviceType ? { deviceType: d.deviceType } : {}),
      ...(d.backedUp != null ? { backedUp: d.backedUp } : {}),
    };
  }
}
