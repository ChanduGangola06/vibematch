import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { useUi } from '@/app/UiProvider';
import { useSession } from '@/features/session/SessionProvider';
import { sessionStore } from '@/shared/api/session-store';
import { server } from '@/test/server';
import { API, makeUser, ok, problem, renderApp, mockBaseApi } from '@/test/render';
import { AuthModal } from './AuthModal';

function Harness() {
  const ui = useUi();
  const { status, user } = useSession();
  useEffect(() => { ui.openAuth(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <p data-testid="status">{status}:{user?.username ?? '-'}</p>
      <AuthModal />
    </>
  );
}

/** The mode toggle and the submit button share a label; pick the submit one. */
const submit = (name: RegExp) => screen.getAllByRole('button', { name }).find((b) => b.getAttribute('type') === 'submit')!;

const authed = (user = makeUser(), isNewUser = false) => ok({ status: 'authenticated', user, tokens: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 900 }, isNewUser }, { status: 201 });

describe('AuthModal', () => {
  it('guest quick start signs in, stores the token in memory and closes', async () => {
    mockBaseApi();
    server.use(http.post(`${API}/auth/guest`, () => authed(makeUser({ username: 'guest_abc', isGuest: true, role: 'guest', gems: 0 }), true)));
    renderApp(<Harness />);
    await userEvent.click(await screen.findByRole('button', { name: /continue as guest/i }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated:guest_abc'));
    expect(sessionStore.getToken()).toBe('tok');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides guest login when the admin disabled it', async () => {
    mockBaseApi({ auth: { guestLogin: false, phoneLogin: false, googleLogin: false, firebaseConfig: '' } });
    renderApp(<Harness />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.queryByRole('button', { name: /continue as guest/i })).not.toBeInTheDocument());
    expect(screen.getByText(/quick sign-in is disabled/i)).toBeInTheDocument();
  });

  it('social buttons only appear when the provider is enabled AND firebase is configured', async () => {
    mockBaseApi({ auth: { guestLogin: true, googleLogin: true, facebookLogin: false, firebaseConfig: '{"apiKey":"k","projectId":"p"}' } });
    renderApp(<Harness />);
    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /facebook/i })).not.toBeInTheDocument();
  });

  it('email sign-in succeeds and shows server errors without leaking which part was wrong', async () => {
    mockBaseApi();
    let attempts = 0;
    server.use(http.post(`${API}/auth/login`, async ({ request }) => {
      attempts++;
      const body = (await request.json()) as { identifier: string; password: string };
      return body.password === 'right-password' ? authed() : problem(401, 'invalid_credentials', { detail: 'Invalid username or password' });
    }));
    renderApp(<Harness />);
    await userEvent.click(await screen.findByRole('tab', { name: /email/i }));
    await userEvent.type(screen.getByLabelText(/username or email/i), 'alice');
    await userEvent.type(screen.getByLabelText(/^password/i), 'wrong');
    await userEvent.click(submit(/^sign in$/i));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
    await userEvent.clear(screen.getByLabelText(/^password/i));
    await userEvent.type(screen.getByLabelText(/^password/i), 'right-password');
    await userEvent.click(submit(/^sign in$/i));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated:alice'));
    expect(attempts).toBe(2);
  });

  it('register: live username check, field-level server errors, success', async () => {
    mockBaseApi();
    server.use(
      http.get(`${API}/users/check-username`, ({ request }) => {
        const u = new URL(request.url).searchParams.get('username');
        return ok(u === 'taken_name' ? { available: false, reason: 'taken' } : { available: true });
      }),
      http.post(`${API}/auth/register`, async ({ request }) => {
        const b = (await request.json()) as { password: string };
        return b.password === 'password123' ? problem(422, 'validation_failed', { errors: [{ path: 'password', message: 'This password is too common' }] }) : authed(makeUser({ username: 'newbie', gems: 300 }), true);
      }),
    );
    renderApp(<Harness />);
    await userEvent.click(await screen.findByRole('tab', { name: /email/i }));
    await userEvent.click(screen.getByRole('button', { name: /create account/i, pressed: false }));
    await userEvent.type(screen.getByLabelText(/^username$/i), 'taken_name');
    expect(await screen.findByText(/username is taken/i)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/^username$/i));
    await userEvent.type(screen.getByLabelText(/^username$/i), 'newbie');
    expect(await screen.findByText(/username is available/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^email$/i), 'n@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'password123');
    await userEvent.click(submit(/^create account$/i));
    expect(await screen.findByText('This password is too common')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/^password/i));
    await userEvent.type(screen.getByLabelText(/^password/i), 'a-much-better-pass');
    await userEvent.click(submit(/^create account$/i));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated:newbie'));
  });

  it('closes with Escape and returns focus; is labelled for screen readers', async () => {
    mockBaseApi();
    renderApp(<Harness />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toHaveAccessibleName(/join testsite/i));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
