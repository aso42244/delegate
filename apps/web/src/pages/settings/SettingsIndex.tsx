import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { syncApi } from '../../api/client.js';
import { SECTIONS } from './SettingsLayout.jsx';

/**
 * Settings on a phone: a list, not thirteen tabs.
 *
 * About four tabs fit at 390px. Scrolling the other nine sideways hides them
 * behind a gesture with nothing on screen to suggest it — the same failure the
 * hover-revealed row menus had, without the excuse of being an enhancement. A
 * list is the phone's own idiom for an index, and the routes it needs already
 * exist.
 *
 * One row reports, and it reports a fact rather than a verdict. Whether the
 * backup counts as failing is decided in one place — `buildNotifications`, which
 * knows how old the deployment is and stays quiet on one too young for a dump to
 * have been due. Repeating that judgement here with a second rule is how the two
 * come to disagree, and the banner it would disagree with is already on this
 * screen, above this list.
 */
export function SettingsIndex(): ReactNode {
  const sync = useQuery({ queryKey: ['sync', 'status'], queryFn: syncApi.status });

  function stateOf(to: string): { text: string; tone: 'quiet' | 'danger' } | null {
    if (to !== 'sync' || !sync.data) return null;
    if (sync.data.failing) return { text: 'Last sync failed', tone: 'danger' };
    if (sync.data.credentialSource === 'none') return { text: 'Not connected', tone: 'danger' };
    return {
      text: sync.data.lastSyncAt
        ? `Synced ${new Date(sync.data.lastSyncAt).toLocaleDateString()}`
        : 'Connected',
      tone: 'quiet',
    };
  }

  return (
    <ul className="rounded-lg border border-line bg-canvas px-3">
      {SECTIONS.map((section) => {
        const state = stateOf(section.to);
        return (
          <li key={section.to}>
            <Link
              to={section.to}
              className="flex min-h-[52px] items-center gap-2 border-b border-line py-2 text-ink last:border-0"
            >
              <span className="flex-1">{section.label}</span>
              {state && (
                <span
                  className={`truncate text-quiet ${
                    state.tone === 'danger' ? 'font-semibold text-danger' : 'text-muted'
                  }`}
                >
                  {state.text}
                </span>
              )}
              <span aria-hidden className="text-faint">
                ›
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
