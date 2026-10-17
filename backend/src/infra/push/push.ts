export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushPort {
  /** Returns the tokens FCM reported as permanently invalid so callers can prune them. */
  send(tokens: string[], msg: PushMessage): Promise<{ sent: number; invalidTokens: string[] }>;
}

/** Minimal slice of firebase-admin `Messaging` used here (injectable for tests). */
export interface MessagingLike {
  sendEachForMulticast(m: {
    tokens: string[];
    notification: { title: string; body: string };
    data?: Record<string, string>;
  }): Promise<{ successCount: number; responses: { success: boolean; error?: { code?: string } }[] }>;
}

const INVALID_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export class FcmPushAdapter implements PushPort {
  constructor(private readonly messaging: MessagingLike) {}

  async send(tokens: string[], msg: PushMessage) {
    const unique = [...new Set(tokens.filter(Boolean))].slice(0, 500);
    if (unique.length === 0) return { sent: 0, invalidTokens: [] };
    const res = await this.messaging.sendEachForMulticast({
      tokens: unique,
      notification: { title: msg.title, body: msg.body },
      ...(msg.data ? { data: msg.data } : {}),
    });
    const invalidTokens = res.responses
      .map((r, i) => (!r.success && r.error?.code && INVALID_CODES.has(r.error.code) ? unique[i]! : null))
      .filter((t): t is string => t !== null);
    return { sent: res.successCount, invalidTokens };
  }
}

/** No-op adapter used when push is not configured. */
export class NullPushAdapter implements PushPort {
  async send() {
    return { sent: 0, invalidTokens: [] };
  }
}

/**
 * Lazy proxy: firebase-admin is only imported/initialised the first time a push is sent,
 * and only if a service account is configured.
 */
export class LazyPushAdapter implements PushPort {
  private inner: PushPort | undefined;
  constructor(private readonly factory: () => Promise<PushPort>) {}
  async send(tokens: string[], msg: PushMessage) {
    this.inner ??= await this.factory();
    return this.inner.send(tokens, msg);
  }
}

export async function createFcmFromServiceAccount(serviceAccountJson: string): Promise<PushPort> {
  const [{ cert, getApps, initializeApp }, { getMessaging }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/messaging'),
  ]);
  const credentials = JSON.parse(serviceAccountJson) as Record<string, unknown>;
  const app =
    getApps().find((a) => a.name === 'vibematch-push') ??
    initializeApp({ credential: cert(credentials as never) }, 'vibematch-push');
  return new FcmPushAdapter(getMessaging(app) as unknown as MessagingLike);
}
