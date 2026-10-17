import { createHash } from 'node:crypto';
import { AppError } from '../../core/errors/index.js';
import type { PaymentConfig, PaymentConfigProvider, PaymentProvider, PurchaseProvider } from './payment.types.js';
import { AppStoreProvider } from './providers/app-store.provider.js';
import { GooglePlayProvider } from './providers/google-play.provider.js';
import type { FetchLike } from './providers/http.js';
import { PayPalProvider } from './providers/paypal.provider.js';
import { RazorpayProvider } from './providers/razorpay.provider.js';
import { StripeProvider, createStripeClient, type StripeLike } from './providers/stripe.provider.js';

export const PROVIDER_IDS = ['stripe', 'paypal', 'razorpay', 'google', 'apple'] as const;

/**
 * Abstract Factory: turns the admin's gateway configuration into ready-to-use provider objects.
 * Each product (provider) hides its SDK / REST details behind the common PaymentProvider port.
 */
export class PaymentProviderFactory {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly stripeClient: (secret: string) => StripeLike = createStripeClient,
  ) {}

  create(id: PurchaseProvider, cfg: PaymentConfig): PaymentProvider | null {
    switch (id) {
      case 'stripe':
        return cfg.stripe?.secretKey ? new StripeProvider(this.stripeClient(cfg.stripe.secretKey), cfg.stripe.webhookSecret) : null;
      case 'paypal':
        return cfg.paypal?.clientId && cfg.paypal.clientSecret ? new PayPalProvider(cfg.paypal, this.fetchImpl) : null;
      case 'razorpay':
        return cfg.razorpay?.keyId && cfg.razorpay.keySecret ? new RazorpayProvider(cfg.razorpay, this.fetchImpl) : null;
      case 'google':
        return cfg.google?.serviceAccountJson ? new GooglePlayProvider(cfg.google, this.fetchImpl) : null;
      case 'apple':
        return cfg.apple ? new AppStoreProvider(cfg.apple, this.fetchImpl) : null;
    }
  }
}

/**
 * Proxy-ish registry: re-reads the (cached) configuration on every call so admin changes apply at
 * once, but reuses provider instances while the config for that gateway is unchanged
 * (keeps HTTP clients and OAuth tokens warm).
 */
export class PaymentProviders {
  private readonly cache = new Map<PurchaseProvider, { fingerprint: string; provider: PaymentProvider | null }>();

  constructor(
    private readonly config: PaymentConfigProvider,
    private readonly factory: PaymentProviderFactory,
  ) {}

  async get(id: PurchaseProvider): Promise<PaymentProvider> {
    const cfg = await this.config.get();
    const slice = (cfg as unknown as Record<string, unknown>)[id === 'google' ? 'google' : id];
    const fingerprint = createHash('sha1').update(JSON.stringify([slice, cfg.currency])).digest('hex');
    let entry = this.cache.get(id);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, provider: this.factory.create(id, cfg) };
      this.cache.set(id, entry);
    }
    if (!entry.provider) {
      throw new AppError(400, 'provider_not_configured', 'Payment provider unavailable', { detail: `${id} payments are not configured` });
    }
    return entry.provider;
  }

  currency(): Promise<string> {
    return this.config.get().then((c) => c.currency);
  }
}

export const noPaymentConfig: PaymentConfigProvider = { get: async () => ({ currency: 'USD' }) };
