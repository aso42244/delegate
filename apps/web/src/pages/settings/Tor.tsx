import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { settingsApi } from '../../api/settings.js';
import { Alert, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';
import { Disclosure, StatusLine } from '../../components/layout.jsx';

/**
 * Settings → Tor.
 *
 * Reaching the budget from away, and nothing else. This tab was "Security" and
 * carried two-factor as well, which put a per-account credential and a
 * household-wide network door on one page for no better reason than that both
 * are security. Two-factor belongs with the account it protects, so it lives in
 * Settings → Users now — the two things it is next to there are the same
 * person's password and role.
 */

export function TorSection(): ReactNode {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const [problem, setProblem] = useState<string | null>(null);

  const setRemote = useMutation({
    mutationFn: (remoteOverTorEnabled: boolean) => settingsApi.update({ remoteOverTorEnabled }),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that.'),
  });

  return (
    <>
      {problem && <Alert>{problem}</Alert>}
      <SettingsCard
        span="third"
        title="Reaching the budget from away"
        description="Over Tor, with no port forwarded, no domain name, and nobody in the middle holding your data."
      >
        {settings.data?.onionAddress ? (
          <div className="flex flex-col gap-2">
            {/* The address is not a secret exactly — it is a public key — but it
          is the only thing an attacker would need to find this at all, so
          it is shown here and nowhere else. */}
            <div>
              <p className="text-label uppercase tracking-label text-muted">Address</p>
              <p className="mt-1 font-mono text-quiet break-all text-ink">
                {settings.data.onionAddress}
              </p>
            </div>

            <Toggle
              checked={settings.data.remoteOverTorEnabled}
              onChange={(next) => setRemote.mutate(next)}
              label="Answer requests to this address"
            />

            <StatusLine tone={settings.data.remoteOverTorEnabled ? 'positive' : 'muted'}>
              {settings.data.remoteOverTorEnabled
                ? 'On. Open the address in Tor Browser.'
                : 'Off. Requests to the address are refused.'}
            </StatusLine>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <StatusLine tone="muted">
              No onion address yet — one appears within a minute of a deploy.
            </StatusLine>
            {/* Instructions only for the case where it has not appeared, rather
          than as the ordinary path. Being told to start something that
          starts itself is how somebody concludes it is broken. */}
            <Disclosure summary="Still nothing after a minute?">
              {/*
                The whole command, including the directory it must run from and
                the shell it needs.

                What stood here was `sudo docker compose logs tor` alone. Run
                from a home directory that answers "no configuration file
                provided"; run as `sudo docker` on DSM it answers "command not
                found", because sudo resolves the binary itself and
                /usr/local/bin is not on the path it uses. Instructions that
                fail at the moment somebody needs them are worse than none —
                they look like the diagnosis.
              */}
              <p className="mt-2 text-label text-muted">On the NAS, over SSH:</p>
              <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-label text-ink">
                sudo -i sh -c &apos;cd /volume1/docker/delegate &amp;&amp; docker compose logs
                tor&apos;
              </pre>
              <p className="mt-2 text-label text-muted">
                A configuration error stops tor before it starts, and the container then restarts
                for ever without ever creating an address — so the logs are the first thing to read,
                not the last. <code>ps tor</code> in place of <code>logs tor</code> shows whether it
                is running at all, and <code>up -d --build tor</code> rebuilds it.
              </p>
            </Disclosure>
          </div>
        )}
      </SettingsCard>
    </>
  );
}
