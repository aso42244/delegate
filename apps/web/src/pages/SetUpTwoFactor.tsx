import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth/SessionProvider.jsx';
import { SecuritySection } from './settings/Security.jsx';

/**
 * The one screen an account without a second factor can reach, when the
 * household requires one.
 *
 * The requirement used to be a trap. Every authenticated route answers 403
 * — including the settings page that offers enrolment — so turning it on locked
 * an un-enrolled account out of the application with no way back in but an
 * administrator undoing the setting. This is the way back in.
 *
 * It is the ordinary Security screen, not a copy of it. A second enrolment flow
 * would be a second place for the recovery codes to be got wrong, and those are
 * the only thing standing between a lost phone and a lost budget.
 */
export function SetUpTwoFactor(): ReactNode {
  const { user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Once enrolled, the guard that sent us here stops applying. Re-reading the
  // session is what notices.
  useEffect(() => {
    if (user && user.needsTwoFactor !== true) {
      void navigate('/', { replace: true });
    }
  }, [user, navigate]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-page font-bold text-ink">Set up two-factor authentication</h1>
        <p className="mt-1 text-quiet text-muted">
          This household requires it. Nothing else is reachable until it is set up — including the
          rest of Settings.
        </p>
      </header>

      <div
        onBlur={() => {
          // The section owns its own state; this page only needs to know when
          // the account's standing has changed.
          void queryClient.invalidateQueries({ queryKey: ['session'] });
        }}
      >
        <SecuritySection />
      </div>
    </div>
  );
}
