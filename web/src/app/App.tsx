import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'react-hot-toast';
import { RouterProvider } from 'react-router';
import { SessionProvider } from '@/features/session/SessionProvider';
import { SettingsProvider } from '@/features/settings/SettingsProvider';
import { isApiError } from '@/shared/api/errors';
import { I18nProvider } from '@/shared/i18n/I18nProvider';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { SocketProvider } from '@/shared/socket/SocketProvider';
import { UiProvider } from './UiProvider';
import { createRouter } from './router';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: (n, e) => !(isApiError(e) && e.status < 500) && n < 2 } },
  });
}

export function App() {
  const [qc] = useState(makeClient);
  const [router] = useState(createRouter);
  return (
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <SettingsProvider>
            <I18nProvider>
              <UiProvider>
                <SocketProvider>
                  <RouterProvider router={router} />
                </SocketProvider>
              </UiProvider>
              <Toaster position="top-center" />
            </I18nProvider>
          </SettingsProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
