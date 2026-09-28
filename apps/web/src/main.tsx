import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.jsx';
import { SessionProvider } from './auth/SessionProvider.jsx';
import { initDensity } from './display.js';
import { initTheme } from './theme.js';
import './styles.css';

/**
 * Entry point.
 *
 * Retries are off by default: this is a LAN application talking to one server on
 * the same network, so a failure is almost always a real error the owner should
 * see rather than a blip worth hiding behind three silent attempts.
 */
/**
 * Notifications are recomputed after anything that succeeds.
 *
 * They were invalidated at two call sites out of the dozens that can change
 * them, so the commonest case of all — categorizing the last uncategorized
 * transaction — left "12 waiting to be categorized" on screen until the
 * five-minute poll came round. Going back to the Budget page did not help,
 * because the answer was already cached.
 *
 * Done here rather than at each call site because the list of things that can
 * change a notification is every mutation in the application, and a list like
 * that is one somebody eventually forgets to add to. Notifications are computed
 * on read and never stored (ADR 030), so recomputing one is a cheap query rather
 * than work, and the banner is never a stale reading of a fact that has moved.
 */
const mutationCache = new MutationCache({
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  },
});

const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Before the first render, so rows are not drawn at one height and then jump,
// and the page is not painted light and then repainted dark.
initDensity();
initTheme();

const container = document.getElementById('root');
if (!container) throw new Error('No #root element to mount into');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
