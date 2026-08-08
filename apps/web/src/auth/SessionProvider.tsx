import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, use, type ReactNode } from 'react';
import { ApiError, authApi, type SessionUser } from '../api/client.js';

/**
 * Who is signed in.
 *
 * The server is the authority: a 401 means signed out, and nothing is cached
 * across that boundary. Storing the user anywhere persistent would let a
 * revoked session keep rendering a signed-in interface.
 */

interface SessionValue {
  readonly user: SessionUser | null;
  readonly isLoading: boolean;
  readonly refresh: () => Promise<void>;
  readonly clear: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSessionQuery(): UseQueryResult<SessionUser | null> {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return (await authApi.me()).user;
      } catch (error) {
        // Not signed in is an ordinary answer here, not a failure to retry.
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();
  const query = useSessionQuery();

  const value: SessionValue = {
    user: query.data ?? null,
    isLoading: query.isLoading,
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    clear: () => {
      // Everything cached was fetched as this user; none of it should survive.
      queryClient.clear();
    },
  };

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
