import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useSession } from '@/features/session/SessionProvider';
import { client, idempotencyHeader, unwrap } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { PageSpinner } from '@/shared/ui/Spinner';

/** Landing page after Stripe/PayPal redirect. The server verifies the payment itself; query params are only identifiers. */
export default function PaymentCallbackPage() {
  const t = useT();
  const [sp] = useSearchParams();
  const { status, patchUser } = useSession();
  const method = sp.get('method');
  const cancelled = sp.get('status') !== 'success';
  const ref = method === 'stripe' ? sp.get('session_id') : sp.get('token');

  const verify = useQuery({
    queryKey: ['payment-verify', method, ref],
    enabled: !cancelled && status === 'authenticated' && Boolean(ref) && (method === 'stripe' || method === 'paypal'),
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const r = method === 'stripe'
        ? await unwrap(client.POST('/payments/stripe/verify', { body: { sessionId: ref! }, headers: idempotencyHeader() }))
        : await unwrap(client.POST('/payments/paypal/verify', { body: { orderId: ref! }, headers: idempotencyHeader() }));
      patchUser({ gems: r.balance });
      return r;
    },
  });

  if (status === 'loading') return <PageSpinner />;
  let body;
  if (cancelled) body = <Msg title={t('Payment cancelled')} text={t('You have not been charged.')} />;
  else if (status !== 'authenticated') body = <Msg title={t('Please sign in')} text={t('Sign in to finish crediting your gems.')} />;
  else if (!ref || (method !== 'stripe' && method !== 'paypal')) body = <Msg title={t('Payment not recognised')} text={t('The payment link is incomplete.')} />;
  else if (verify.isPending) return <PageSpinner />;
  else if (verify.isError) body = <Msg title={t('We could not confirm your payment')} text={errorMessage(verify.error, t('If you were charged, your gems will arrive shortly.'))} />;
  else body = <Msg title={t('Payment successful!')} text={t('{n} gems were added. New balance: {b}', { n: verify.data.gems, b: verify.data.balance })} />;

  return (
    <div className="max-w-md mx-auto py-20 px-4 text-center">
      {body}
      <Link to="/" className="inline-block mt-6 px-5 py-2.5 rounded-xl bg-[#00E676] text-black font-bold">{t('Back to home')}</Link>
    </div>
  );
}

const Msg = ({ title, text }: { title: string; text: string }) => (
  <div role="status"><h1 className="text-2xl font-bold mb-2">{title}</h1><p className="text-gray-400">{text}</p></div>
);
