interface RzpResponse { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
interface RzpOptions {
  key: string; amount: number; currency: string; order_id: string; name: string; prefill?: { email?: string };
  handler(r: RzpResponse): void; modal: { ondismiss(): void };
}
declare global { interface Window { Razorpay?: new (o: RzpOptions) => { open(): void } } }

const SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Razorpay'));
    document.head.appendChild(s);
  });
}

/** Opens Razorpay's hosted checkout; resolves with the signed response, rejects with message 'dismissed' if closed. */
export async function openRazorpay(o: { key: string; amount: number; currency: string; orderId: string; name: string; email?: string | undefined }) {
  await loadScript();
  return new Promise<{ orderId: string; paymentId: string; signature: string }>((resolve, reject) => {
    const rz = new window.Razorpay!({
      key: o.key, amount: o.amount, currency: o.currency, order_id: o.orderId, name: o.name,
      ...(o.email ? { prefill: { email: o.email } } : {}),
      handler: (r) => resolve({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
      modal: { ondismiss: () => reject(new Error('dismissed')) },
    });
    rz.open();
  });
}
