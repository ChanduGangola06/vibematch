import type { PurchaseProvider } from '../../infra/db/models/commerce.js';
import type { PackRecord } from '../store/store.repository.js';

export type { PurchaseProvider };

/** Secrets per gateway, already filtered to the gateways the admin enabled. */
export interface PaymentConfig {
  stripe?: { secretKey: string; webhookSecret?: string };
  paypal?: { clientId: string; clientSecret: string; env: 'sandbox' | 'live'; webhookId?: string };
  razorpay?: { keyId: string; keySecret: string; webhookSecret?: string; currency: string };
  google?: { serviceAccountJson: string; packageName: string };
  apple?: { sharedSecret?: string };
  /** ISO currency used by Stripe / PayPal checkouts. */
  currency: string;
}

/** Supplied by the settings module (decrypts and caches the admin's gateway keys). */
export interface PaymentConfigProvider {
  get(): Promise<PaymentConfig>;
}

export interface CheckoutInput {
  userId: string;
  pack: PackRecord;
  /** Already validated against the allow-list. */
  returnBaseUrl: string;
  currency: string;
}

export interface CheckoutResult {
  /** Hosted page to send the customer to (Stripe / PayPal). */
  url?: string;
  orderId: string;
  /** Provider specifics for in-app SDKs (e.g. Razorpay key id & amount). */
  extra?: Record<string, unknown>;
}

/** A payment the gateway itself confirmed — the only input the fulfilment step trusts. */
export interface VerifiedPayment {
  provider: PurchaseProvider;
  /** Unique per payment at the gateway; with `provider` it is the replay-protection key. */
  providerTxnId: string;
  /** Owner bound at checkout (web gateways). Undefined for store receipts, where the caller is the owner. */
  userId?: string | undefined;
  packId: string;
  packName: string;
  gems: number;
  /** Major units actually paid. */
  amount: number;
  currency: string;
  receiptHash?: string | undefined;
}

export interface VerifyContext {
  userId: string;
  findPack(key: string): Promise<PackRecord | null>;
}

export interface PaymentProvider {
  readonly id: PurchaseProvider;
  checkout?(input: CheckoutInput): Promise<CheckoutResult>;
  verify(input: Record<string, unknown>, ctx: VerifyContext): Promise<VerifiedPayment>;
  /** Parses and authenticates a gateway callback; returns null for events we ignore. */
  webhook?(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<VerifiedPayment | null>;
}

/** Bits of pack data we freeze into gateway metadata at checkout. */
export interface CheckoutMeta {
  userId: string;
  packId: string;
  packName: string;
  gems: number;
  price: number;
}

export const metaFor = (input: CheckoutInput): CheckoutMeta => ({
  userId: input.userId,
  packId: input.pack.id,
  packName: input.pack.name,
  gems: input.pack.gems,
  price: input.pack.price,
});

export const toMinor = (major: number): number => Math.round(major * 100);
