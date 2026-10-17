import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

/**
 * A software FIDO2 authenticator (ES256, "none" attestation) so WebAuthn flows can be tested
 * end-to-end against the real verification library without a browser or hardware key.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;

  constructor(
    private readonly rpId = 'localhost',
    private readonly origin = 'http://localhost:3000',
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x!, 'base64url');
    this.y = Buffer.from(jwk.y!, 'base64url');
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.counter);
    return b;
  }

  register(options: { challenge: string }, overrides: { origin?: string; challenge?: string } = {}) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: overrides.challenge ?? options.challenge, origin: overrides.origin ?? this.origin, crossOrigin: false }),
    );
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]) as never,
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([0x45]), // UP | UV | AT
      this.counterBytes(), Buffer.alloc(16), idLen, this.credentialId, Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  assert(options: { challenge: string }, overrides: { counter?: number; origin?: string } = {}) {
    this.counter = overrides.counter ?? this.counter + 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: overrides.origin ?? this.origin, crossOrigin: false }),
    );
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), this.counterBytes()]); // UP | UV
    const signature = createSign('SHA256').update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }
}
