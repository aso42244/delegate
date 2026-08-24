import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, authApi, type TotpEnrolmentDto } from '../../api/client.js';
import { Alert, Button, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Two-factor authentication for the signed-in account.
 *
 * Its own component because two screens need exactly it and nothing around it:
 * Settings → Users, where it sits beside the account it protects, and
 * `/set-up-two-factor`, which is the way in for somebody who has none yet and
 * cannot reach Settings at all. A second enrolment flow would be a second thing
 * to keep correct.
 *
 * The recovery codes are shown exactly once, at the end of enrolment. The server
 * keeps only their hashes, so this screen is the single opportunity to write
 * them down — which is why it says so plainly rather than assuming anyone reads
 * a subtitle.
 */

export function TwoFactorCard(): ReactNode {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['totp'], queryFn: authApi.totpStatus });

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
      await queryClient.invalidateQueries({ queryKey: ['users'] });
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
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const enrolled = status.data?.enrolled === true;

  return (
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
