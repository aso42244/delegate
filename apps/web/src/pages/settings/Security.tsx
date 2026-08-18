import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, authApi, type TotpEnrolmentDto } from '../../api/client.js';
import { settingsApi } from '../../api/settings.js';
import { Alert, Button, TextField, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Security. Two-factor authentication, for this account and for the
 * budget as a whole.
 *
 * The recovery codes are shown exactly once, at the end of enrolment. The server
 * keeps only their hashes, so this screen is the single opportunity to write
 * them down — which is why it says so plainly rather than assuming anyone reads
 * a subtitle.
 */

export function SecuritySection(): ReactNode {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['totp'], queryFn: authApi.totpStatus });
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });

  const [enrolment, setEnrolment] = useState<TotpEnrolmentDto | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [enrolPassword, setEnrolPassword] = useState('');

  const begin = useMutation({
    mutationFn: () => authApi.totpBegin(enrolPassword),
    onSuccess: (offer) => {
      setProblem(null);
      setEnrolPassword('');
      setEnrolment(offer);
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const confirm = useMutation({
    mutationFn: () => authApi.totpConfirm(code),
    onSuccess: async ({ recoveryCodes: codes }) => {
      setProblem(null);
      setEnrolment(null);
      setCode('');
      setRecoveryCodes(codes);
      await queryClient.invalidateQueries({ queryKey: ['totp'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const disable = useMutation({
    mutationFn: () => authApi.totpDisable(password),
    onSuccess: async () => {
      setProblem(null);
      setPassword('');
      setRecoveryCodes(null);
      await queryClient.invalidateQueries({ queryKey: ['totp'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const setRemote = useMutation({
    mutationFn: (remoteOverTorEnabled: boolean) => settingsApi.update({ remoteOverTorEnabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const setRequirement = useMutation({
    mutationFn: (requireTotp: boolean) => settingsApi.update({ requireTotp }),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['totp'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const enrolled = status.data?.enrolled === true;

  return (
    <>
      <SettingsCard
        title="Two-factor authentication"
        description="A code from your phone, on top of your password."
      >
        {problem && <Alert>{problem}</Alert>}

        {recoveryCodes && (
          <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />
        )}

        {!enrolled && !enrolment && !recoveryCodes && (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              begin.mutate();
            }}
            className="flex flex-col gap-3"
          >
            <p className="text-quiet text-muted">
              Not set up. Your password is the only thing protecting this budget.
            </p>
            {/* Asked for here as well as to turn it off. Binding an
                authenticator from a session somebody else is holding would give
                them a credential you never issued. */}
            <TextField
              label="Current password"
              type="password"
              value={enrolPassword}
              onChange={(event) => setEnrolPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <div>
              <Button type="submit" variant="primary" disabled={begin.isPending}>
                {begin.isPending ? 'Working…' : 'Set up two-factor'}
              </Button>
            </div>
          </form>
        )}

        {enrolment && (
          <Enrol
            offer={enrolment}
            code={code}
            onCodeChange={setCode}
            pending={confirm.isPending}
            onSubmit={() => confirm.mutate()}
            onCancel={() => {
              setEnrolment(null);
              setCode('');
              setProblem(null);
            }}
          />
        )}

        {enrolled && !recoveryCodes && (
          <div className="flex flex-col gap-3">
            <p className="text-quiet text-muted">
              On. {status.data?.recoveryCodesRemaining ?? 0} recovery{' '}
              {status.data?.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
            </p>

            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                disable.mutate();
              }}
              className="flex flex-col gap-3"
            >
              <TextField
                label="Current password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                hint="Required to turn two-factor off, so an open session cannot do it alone."
              />
              <div>
                <Button type="submit" variant="danger" disabled={disable.isPending || !password}>
                  {disable.isPending ? 'Working…' : 'Turn off two-factor'}
                </Button>
              </div>
            </form>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Reaching the budget from away"
        description="Over Tor, with no port forwarded, no domain name, and nobody in the middle holding your data."
      >
        {settings.data?.onionAddress ? (
          <div className="flex flex-col gap-3">
            {/* The address is not a secret exactly — it is a public key — but it
                is the only thing an attacker would need to find this at all, so
                it is shown here and nowhere else. */}
            <div>
              <p className="text-label uppercase tracking-[0.05em] text-muted">Address</p>
              <p className="mt-1 font-mono text-quiet break-all text-ink">
                {settings.data.onionAddress}
              </p>
            </div>

            <Toggle
              checked={settings.data.remoteOverTorEnabled}
              onChange={(next) => setRemote.mutate(next)}
              label="Answer requests to this address"
            />

            <p className="text-quiet text-muted">
              {settings.data.remoteOverTorEnabled
                ? 'On. Open Tor Browser — or Onion Browser on iPhone — and go to the address above.'
                : 'Off. The address exists but the budget will refuse anything arriving on it. Turning it on can only be done from here, on the home network.'}
            </p>

            <p className="text-label text-muted">
              An onion address is itself a public key, so the connection is encrypted and
              authenticated end to end. Nothing decrypts it on the way — which is the difference
              between this and a tunnel provider.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-quiet text-muted">
              No onion address yet. Nothing to start — Tor runs alongside Delegate and makes one the
              first time it comes up, usually within a minute of a deploy.
            </p>
            {/* Instructions only for the case where it has not appeared, rather
                than as the ordinary path. Being told to start something that
                starts itself is how somebody concludes it is broken. */}
            <details>
              <summary className="cursor-pointer text-quiet text-muted">
                Still nothing after a minute?
              </summary>
              <p className="mt-2 text-label text-muted">
                On the NAS, <code>sudo docker compose ps tor</code> shows whether it is running and{' '}
                <code>sudo docker compose logs tor</code> says why not. The commonest cause is a key
                directory left behind by an older version, which{' '}
                <code>sudo docker compose up -d --build tor</code> repairs.
              </p>
            </details>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Require it of everyone"
        description="Refuses the budget to any account without a second factor set up."
      >
        <div className="flex items-center gap-3">
          <Toggle
            checked={settings.data?.requireTotp === true}
            onChange={(next) => setRequirement.mutate(next)}
            label="Require two-factor authentication"
          />
          <span className="text-quiet text-muted">
            {settings.data?.requireTotp
              ? 'Required. Every active account has one.'
              : 'Not required. It can only be turned on once every account has enrolled.'}
          </span>
        </div>
      </SettingsCard>
    </>
  );
}

/** The scan-and-confirm step. */
function Enrol({
  offer,
  code,
  onCodeChange,
  pending,
  onSubmit,
  onCancel,
}: {
  readonly offer: TotpEnrolmentDto;
  readonly code: string;
  readonly onCodeChange: (next: string) => void;
  readonly pending: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [qr, setQr] = useState<string | null>(null);

  // Rendered locally rather than through any QR service: the URI contains the
  // shared secret, and sending it to a third party would hand over the second
  // factor it exists to protect.
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(offer.uri, { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [offer.uri]);

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-quiet text-muted">
        Scan this with an authenticator app, then enter the code it shows to finish.
      </p>

      {qr && (
        <img
          src={qr}
          alt="QR code for setting up two-factor authentication"
          className="rounded border border-line bg-white p-2"
          width={220}
          height={220}
        />
      )}

      <div>
        <p className="text-label font-semibold text-muted">Or type this key in by hand</p>
        <p className="mt-1 font-mono text-quiet break-all text-ink">{offer.secret}</p>
      </div>

      <TextField
        label="Code from the app"
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
        autoComplete="one-time-code"
        inputMode="numeric"
        required
      />

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Working…' : 'Confirm'}
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Shown once. There is no second chance, and it says so. */
function RecoveryCodes({
  codes,
  onDone,
}: {
  readonly codes: readonly string[];
  readonly onDone: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="positive">
        Two-factor is on. Write these recovery codes down now — they will not be shown again.
      </Alert>

      <ul className="grid grid-cols-2 gap-1 rounded border border-line bg-surface-2 p-3 font-mono text-quiet text-ink">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>

      <p className="text-quiet text-muted">
        Each one works once, in place of a code from the app. They are the way back in if the phone
        is lost.
      </p>

      <div>
        <Button onClick={onDone}>I have written them down</Button>
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}
