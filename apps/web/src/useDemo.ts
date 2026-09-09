import { useQuery } from '@tanstack/react-query';
import { api } from './api/client.js';

export interface AppInfo {
  readonly appName: string;
  /** True on a read-only demo instance. */
  readonly demo: boolean;
}

/**
 * What this instance is.
 *
 * One query, cached forever: it answers a fact about the deployment rather than
 * about the household, and it cannot change while a tab is open.
 */
export function useAppInfo(): AppInfo {
  const query = useQuery({
    queryKey: ['app-info'],
    queryFn: () => api.get<AppInfo>('/api/app'),
    staleTime: Infinity,
  });
  return { appName: query.data?.appName ?? 'Delegate', demo: query.data?.demo ?? false };
}

/**
 * Whether this instance is a read-only demo.
 *
 * Used to stop offering what cannot be done: a control that answers 403 is worse
 * than one that is not there. **This is presentation and never enforcement** —
 * the wall is on the server, which refuses a write whatever the interface drew,
 * and nothing here should ever be the only thing standing between a visitor and
 * a change.
 */
export function useIsDemo(): boolean {
  return useAppInfo().demo;
}
