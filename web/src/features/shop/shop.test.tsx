import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, problem, renderApp, signedIn } from '@/test/render';
import PaymentCallbackPage from './PaymentCallbackPage';
import { ShopModal } from './ShopModal';
import { VipModal } from './VipModal';

const packs = [{ id: 'p1', name: '100 Gems', description: '', price: 4.99, gems: 100, popular: true }];

describe('ShopModal', () => {
  it('lists packs and starts a hosted checkout with the site origin as return url', async () => {
    mockBaseApi({ payments: { stripeEnabled: true, currency: 'USD' } });
    signedIn();
    let body: unknown;
    server.use(
      http.get(`${API}/packs`, () => ok(packs)),
      http.post(`${API}/payments/stripe/checkout`, async ({ request }) => { body = await request.json(); return ok({ orderId: 'o1' }, { status: 201 }); }),
    );
    renderApp(<ShopModal open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /buy 100 gems/i }));
    await waitFor(() => expect(body).toEqual({ packId: 'p1', returnUrl: window.location.origin }));
  });
});

describe('VipModal', () => {
  const plans = [{ id: 'v1', name: 'Monthly', description: '', priceGems: 500, durationDays: 30, popular: false }];
  it('subscribes with an Idempotency-Key and updates the balance', async () => {
    mockBaseApi();
    signedIn({ gems: 600 });
    let key: string | null = null;
    server.use(
      http.get(`${API}/vip-plans`, () => ok(plans)),
      http.post(`${API}/vip-plans/v1/subscribe`, ({ request }) => { key = request.headers.get('idempotency-key'); return ok({ balance: 100, vipExpiry: '2027-01-01T00:00:00.000Z' }, { status: 201 }); }),
    );
    let closed = false;
    renderApp(<VipModal open onClose={() => { closed = true; }} />);
    await userEvent.click(await screen.findByRole('button', { name: /subscribe to monthly/i }));
    await waitFor(() => expect(closed).toBe(true));
    expect(key).toBeTruthy();
  });

  it('sends people without enough gems to the shop instead of calling the API', async () => {
    mockBaseApi();
    signedIn({ gems: 5 });
    let called = false;
    server.use(
      http.get(`${API}/vip-plans`, () => ok(plans)),
      http.post(`${API}/vip-plans/v1/subscribe`, () => { called = true; return problem(402, 'insufficient_gems'); }),
    );
    renderApp(<VipModal open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /subscribe to monthly/i }));
    expect(called).toBe(false);
  });
});

describe('PaymentCallbackPage', () => {
  it('shows a cancelled notice without calling the API', async () => {
    mockBaseApi();
    signedIn();
    renderApp(<PaymentCallbackPage />, { route: '/payment-callback?status=cancel&method=stripe' });
    expect(await screen.findByText(/payment cancelled/i)).toBeInTheDocument();
  });

  it('verifies a stripe session server-side and reports the new balance', async () => {
    mockBaseApi();
    signedIn();
    let body: unknown;
    server.use(http.post(`${API}/payments/stripe/verify`, async ({ request }) => { body = await request.json(); return ok({ balance: 400, gems: 100, purchaseId: 'x', alreadyProcessed: false }, { status: 201 }); }));
    renderApp(<PaymentCallbackPage />, { route: '/payment-callback?status=success&method=stripe&session_id=cs_test_123' });
    expect(await screen.findByText(/payment successful/i)).toBeInTheDocument();
    expect(body).toEqual({ sessionId: 'cs_test_123' });
  });

  it('explains a failed verification', async () => {
    mockBaseApi();
    signedIn();
    server.use(http.post(`${API}/payments/paypal/verify`, () => problem(402, 'payment_not_completed')));
    renderApp(<PaymentCallbackPage />, { route: '/payment-callback?status=success&method=paypal&token=ORDER12345' });
    expect(await screen.findByText(/could not confirm your payment/i)).toBeInTheDocument();
  });
});
