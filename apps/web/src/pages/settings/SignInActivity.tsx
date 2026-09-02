import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client.js';
import { EmptyState } from '../../components/layout.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Users, third card: what has happened to credentials.
 *
 * The table behind this was asked for twice by an external review and declined
 * twice, because a record nobody reads is not a control — it is the
 * nightly-backup trap, which this household has already paid for once. So the
 * screen is the feature. It shows the most recent events without being asked,
 * the way the backup card shows the newest dump, and it is the reason the table
 * exists at all.
 *
 * Deliberately not a filter, a search or a pager. Fifty lines answers "has
 * anything strange happened", which is the question somebody actually arrives
 * with; an older question than that is a `psql` question, and a control nobody
 * presses is worse than no control.
 */

type AuthEventKind =
  | 'signed_in'
  | 'sign_in_failed'
  | 'second_factor_failed'
  | 'signed_out'
  | 'password_changed'
  | 'password_reset'
  | 'two_factor_enrolled'
  | 'two_factor_disabled'
  | 'two_factor_reset'
  | 'account_created'
  | 'account_archived'
  | 'account_restored';

interface AuthEventDto {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: AuthEventKind;
  readonly subject: string;
  readonly actor: string | null;
  readonly ip: string | null;
}

/**
 * What each kind is called on screen.
 *
 * Past tense and lower case, so a column of them reads as a list of things that
 * happened rather than a list of headings. The three that matter most are said
 * plainly — "wrong password" rather than "authentication failure" — because the
 * reader is a household, not an operations team.
 */
const KIND_LABELS: Record<AuthEventKind, string> = {
  signed_in: 'Signed in',
  sign_in_failed: 'Wrong password',
  second_factor_failed: 'Wrong code',
  signed_out: 'Signed out',
  password_changed: 'Changed password',
  password_reset: 'Password reset',
  two_factor_enrolled: 'Set up two-factor',
  two_factor_disabled: 'Turned off two-factor',
  two_factor_reset: 'Two-factor reset',
  account_created: 'Account created',
  account_archived: 'Account archived',
  account_restored: 'Account restored',
};

/**
 * The kinds worth colouring, and nothing else.
 *
 * Only the two failures. Colouring every row would make the colour mean "this
 * is a row" — the same reasoning as the pills, where severity is carried by
 * tone *and* words precisely so that neither has to shout.
 */
const ATTENTION: ReadonlySet<AuthEventKind> = new Set<AuthEventKind>([
  'sign_in_failed',
  'second_factor_failed',
]);

const authEventsApi = {
  list: () => api.get<{ events: readonly AuthEventDto[] }>('/api/auth-events'),
};

export function SignInActivity(): ReactNode {
  const events = useQuery({ queryKey: ['auth-events'], queryFn: authEventsApi.list });

  return (
    <SettingsCard
      span="half"
      title="Sign-in activity"
      description="The last 90 days of credential changes."
    >
      {events.isLoading ? (
        <p className="text-quiet text-muted">Loading activity…</p>
      ) : (events.data?.events.length ?? 0) === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <table className="w-full border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-[0.05em] text-muted">
              {/* Fixed, so the name column takes what is left. These labels
                  have a known longest — "Turned off two-factor" — and letting
                  two flexible columns split the width evenly truncated a
                  username that had room to spare. */}
              <th className="row-cell w-44 pl-1 text-left font-normal">What</th>
              <th className="row-cell text-left font-normal">Who</th>
              {/*
                The phone column policy, as everywhere else here: what happened
                and to whom, and the rest only where there is room. The address
                is the first to go — over Tor it is the loopback address of the
                SOCKS hop and says nothing at all.
              */}
              <th className="hidden row-cell w-44 text-left font-normal sm:table-cell">When</th>
              <th className="hidden row-cell w-36 text-left font-normal md:table-cell">From</th>
            </tr>
          </thead>
          <tbody>
            {events.data?.events.map((event) => (
              <tr key={event.id} className="border-b border-line last:border-0">
                <td className="row-cell w-44 overflow-hidden pl-1">
                  <span
                    className={`truncate ${ATTENTION.has(event.kind) ? 'text-warning' : 'text-ink'}`}
                  >
                    {KIND_LABELS[event.kind]}
                  </span>
                </td>

                <td className="row-cell overflow-hidden">
                  <div className="flex items-baseline gap-2 overflow-hidden">
                    <span className="truncate text-ink">{event.subject}</span>
                    {/* Who did it, when that is somebody else. An administrator
                        resetting a credential is the case this column exists
                        for, and it is exactly the line worth noticing. */}
                    {event.actor && (
                      <span className="truncate text-quiet text-faint">by {event.actor}</span>
                    )}
                  </div>
                </td>

                <td className="hidden row-cell w-44 text-quiet text-muted sm:table-cell">
                  {new Date(event.occurredAt).toLocaleString()}
                </td>

                <td className="hidden row-cell w-36 truncate text-quiet text-faint md:table-cell">
                  {event.ip ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsCard>
  );
}
