import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
const queryClient = new QueryClient({
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
