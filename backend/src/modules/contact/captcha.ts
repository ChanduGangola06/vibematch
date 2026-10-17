import { BadRequestError, ServiceUnavailableError } from '../../core/errors/index.js';

/** Settings-driven reCAPTCHA configuration (admin → Plugins). */
export interface CaptchaConfig {
  enabled: boolean;
  secret?: string | undefined;
}
export interface CaptchaConfigProvider {
  get(): Promise<CaptchaConfig>;
}
export const noCaptcha: CaptchaConfigProvider = { get: async () => ({ enabled: false }) };

export interface CaptchaVerifier {
  /** Throws a 4xx when a token is required but missing/invalid. */
  assertHuman(token: string | undefined, ip: string | undefined): Promise<void>;
}

/** Strategy: Google reCAPTCHA v2/v3 `siteverify`. A response from Google is schema-checked, never trusted blindly. */
export class RecaptchaVerifier implements CaptchaVerifier {
  constructor(
    private readonly config: CaptchaConfigProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async assertHuman(token: string | undefined, ip: string | undefined): Promise<void> {
    const cfg = await this.config.get();
    if (!cfg.enabled || !cfg.secret) return;
    if (!token) throw new BadRequestError('Please complete the reCAPTCHA verification');

    let ok: boolean;
    try {
      const res = await this.fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: cfg.secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { success?: unknown };
      ok = data.success === true;
    } catch {
      throw new ServiceUnavailableError('reCAPTCHA verification service error');
    }
    if (!ok) throw new BadRequestError('reCAPTCHA verification failed. Please try again.');
  }
}
