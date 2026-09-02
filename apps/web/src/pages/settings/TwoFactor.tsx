import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, authApi, type TotpEnrolmentDto } from '../../api/client.js';
import { Alert, Button, TextField } from '../../components/ui.jsx';
import { CopyButton } from '../../components/CopyButton.jsx';
import { StatusLine } from '../../components/layout.jsx';
import { groupSecret } from '../../components/clipboard.js';
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
      span={2}
      title="Two-factor authentication"
      description="A code on top of your password."
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
          className="flex flex-col gap-2"
        >
          <StatusLine tone="danger">Not set up.</StatusLine>
          {/* Asked for here as well as to turn it off. Binding an
          authenticator from a session somebody else is holding would give
          them a credential you never issued. */}
          <TextField
            label="Current password"
            width="md"
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
        <div className="flex flex-col gap-2">
          <StatusLine tone="positive">
            On. {status.data?.recoveryCodesRemaining ?? 0} recovery{' '}
            {status.data?.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
          </StatusLine>

          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              disable.mutate();
            }}
            className="flex flex-col gap-2"
          >
            <TextField
              label="Current password"
              width="md"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              hint="So an open session cannot do it alone."
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
        Scan this with an authenticator app, then enter the code it shows.
      </p>

      {qr && (
        <img
          // White in both themes, deliberately: a QR code is scanned rather
          // than read, and inverting it is the one change that stops a camera
          // seeing it at all.
          src={qr}
          alt="QR code for setting up two-factor authentication"
          className="rounded border border-line bg-white p-2"
          width={220}
          height={220}
        />
      )}

      <SetupKey secret={offer.secret} />

      <TextField
        label="Code from the app"
        width="sm"
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

/**
 * The key behind "I can't scan this".
 *
 * A QR code is the fast path and stays the first thing offered. It is also
 * useless in the case this exists for: enrolling on the phone that is holding
 * the screen, or setting the second factor up in a password manager on the same
 * machine, where there is no second camera to point at anything.
 *
 * Folded away rather than shown outright, which is the change. The key used to
 * sit under the QR code permanently, as unbroken text with nothing to copy it —
 * so the common case carried clutter and the uncommon case still meant
 * transcribing thirty-two characters by hand or dragging a selection across
 * them on a phone.
 *
 * Nothing here is newly exposed: the QR code above already encodes this exact
 * secret, and anyone who can read the pixels can read the letters.
 */
function SetupKey({ secret }: { readonly secret: string }): ReactNode {
  const [shown, setShown] = useState(false);
  const keyRef = useRef<HTMLParagraphElement | null>(null);

  if (!shown) {
    return (
      <div>
        {/* A button, not a hover reveal. Half the reason to want this is being
            on a touchscreen, where there is no hover — see the phone notes in
            docs/design.md. */}
        <Button type="button" variant="ghost" onClick={() => setShown(true)} aria-expanded={false}>
          Can&rsquo;t scan this?
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-line bg-surface-2 p-3">
      <p className="text-label font-semibold text-muted">
        Enter this key in your authenticator or password manager
      </p>

      {/* Spaced in fours to be read and typed. `CopyButton` is handed the
          unspaced secret: a password manager given "ABCD EFGH" may keep the
          space, and a second factor producing codes that match nothing is
          discovered at the worst possible moment. */}
      {/* Wraps between groups, never inside one. `break-all` would split "XRXM"
          across two lines as "X" and "RXM", which is exactly the wrong place for
          a string somebody is reading a character at a time — and on a phone,
          where this affordance is needed most, it wrapped every time. */}
      <p ref={keyRef} className="font-mono text-quiet tracking-[0.08em] text-ink">
        {groupSecret(secret)}
      </p>

      <CopyButton value={secret} displayRef={keyRef} describes="Copy the setup key" />
    </div>
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
    <div className="flex flex-col gap-2">
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
