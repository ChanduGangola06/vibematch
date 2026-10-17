import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactElement, ReactNode } from 'react';
import { Toaster } from 'react-hot-toast';
import { MemoryRouter } from 'react-router';
import { UiProvider } from '@/app/UiProvider';
import { SessionProvider } from '@/features/session/SessionProvider';
import { SettingsProvider } from '@/features/settings/SettingsProvider';
import { sessionStore } from '@/shared/api/session-store';
import { I18nProvider } from '@/shared/i18n/I18nProvider';
import { SocketProvider, type SocketFactory } from '@/shared/socket/SocketProvider';
import { FakeSocket } from './fakes';
import { server } from './server';

export const API = `${location.origin}/api/v1`;
export const ok = (data: unknown, init: ResponseInit = {}) => HttpResponse.json({ data, meta: { requestId: 'r' } }, init);
export const page = (data: unknown[], p: Record<string, unknown> = { limit: 20, hasMore: false, nextCursor: null }) =>
  HttpResponse.json({ data, page: p, meta: { requestId: 'r' } });
export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ title: code, status, code, detail: `detail:${code}`, ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });

export const makeUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1', username: 'alice', name: 'Alice', avatar: '/images/avatars/female-1.svg', gender: 'female', country: 'France', countryCode: 'FR',
  bio: '', phone: '', address: '', gems: 300, likesCount: 0, followersCount: 0, followingCount: 0, isVip: false, role: 'user', isGuest: false,
  createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

/** Default public data every screen needs; individual tests override with `server.use`. */
export function mockBaseApi(settings: Record<string, unknown> = {}) {
  server.use(
    http.get(`${API}/settings/public`, () => ok({ general: { siteName: 'TestSite', termsUrl: '/terms-of-service', privacyUrl: '/privacy-policy' }, auth: { guestLogin: true, phoneLogin: false, googleLogin: true, facebookLogin: false, appleLogin: false, twitterLogin: false, firebaseConfig: '' }, demoMode: false, ...settings })),
    http.get(`${API}/languages`, () => ok([{ code: 'en', name: 'English', flag: 'us.svg', rtl: false }])),
    http.get(`${API}/languages/en`, () => ok({ code: 'en', name: 'English', flag: 'us.svg', rtl: false, translations: {} })),
  );
}

export function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

/** Makes the next mount restore a signed-in session through the (mocked) refresh endpoint. */
export function signedIn(over: Record<string, unknown> = {}) {
  const user = makeUser(over);
  localStorage.setItem('vm_has_session', '1');
  server.use(http.post(`${API}/auth/refresh`, () => ok({ tokens: { accessToken: 'tok-' + Math.random().toString(36).slice(2), tokenType: 'Bearer', expiresIn: 900 }, user })));
  sessionStore.clear();
  localStorage.setItem('vm_has_session', '1');
}

export function renderApp(ui: ReactElement, opts: { route?: string; client?: QueryClient; socketFactory?: SocketFactory; /** Pass false when `ui` brings its own data router. */ memoryRouter?: boolean } & Omit<RenderOptions, 'wrapper'> = {}) {
  const client = opts.client ?? createQueryClient();
  const Router = ({ children }: { children: ReactNode }) => opts.memoryRouter === false ? <>{children}</> : <MemoryRouter initialEntries={[opts.route ?? '/']}>{children}</MemoryRouter>;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <Router>
        <SessionProvider>
          <SettingsProvider>
            <I18nProvider>
              <Toaster />
              <UiProvider>
                <SocketProvider factory={opts.socketFactory ?? (() => new FakeSocket().asSocket())}>{children}</SocketProvider>
              </UiProvider>
            </I18nProvider>
          </SettingsProvider>
        </SessionProvider>
      </Router>
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper: Wrapper, ...opts }) };
}
