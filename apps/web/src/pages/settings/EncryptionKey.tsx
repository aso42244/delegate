import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client.js';
import { CopyButton } from '../../components/CopyButton.jsx';
import { Alert, Button, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Sync: the key that opens what is in the backups.
 *
 * It sits beside the backup card rather than anywhere else because that is where
 * its consequence lands. Three things are encrypted in the database — each
 * account's second factor, the SimpleFIN credential, and every wallet descriptor
 * — and the key for them lives in a volume rather than in the database itself,
 * because a key kept beside the ciphertext it opens protects nothing. A stolen
 * `pg_dump` is the copy most likely to leave the machine, and it is exactly what
 * that arrangement defends against.
 *
 * The cost is the sentence on this card: **a dump alone is not a whole restore.**
 * Somebody who has only the dumps can bring back every transaction and no
 * credential. That is worth knowing before the day it matters rather than on it,
 * which is the whole reason this card exists instead of a line in the README.
 *
 * The password is asked for again to show the value, exactly as enrolling or
 * disabling a second factor asks. A stolen session must not be enough to walk
 * off with the key to every backup.
 */

const encryptionKeyApi = {
  reveal: (currentPassword: string) =>
    api.post<{ key: string }>('/api/settings/encryption-key', { currentPassword }),
};

export function EncryptionKey(): ReactNode {
  const [password, setPassword] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The element showing the key, handed to CopyButton.
   *
   * It needs one because `navigator.clipboard` does not exist on a plain-http
   * origin, which is most of the LAN deployments this runs on — the fallback
   * selects the text so a manual copy still works. Passing the value alone would
   * leave the button silently useless in exactly the common case.
   */
  const shown = useRef<HTMLParagraphElement>(null);

  const reveal = useMutation({
    mutationFn: () => encryptionKeyApi.reveal(password),
    onSuccess: (result) => {
      setProblem(null);
      setPassword('');
      setKey(result.key);
    },
    onError: (error: unknown) => {
      setKey(null);
      setProblem(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    },
  });

  return (
    <SettingsCard
      span="third"
      title="Encryption key"
      description="Opens the second factors and credentials inside a backup."
    >
      {key === null ? (
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            reveal.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-quiet text-muted">
            Kept outside the database, so a stolen dump cannot read what it protects — and so a dump
            on its own will not restore your second factors or the bank connection. Keep a copy
            somewhere safe.
          </p>

          <TextField
            width="lg"
            label="Your password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />

          {problem && <Alert>{problem}</Alert>}

          <div>
            <Button type="submit" variant="primary" disabled={password === '' || reveal.isPending}>
              {reveal.isPending ? 'Checking…' : 'Show key'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          {/*
            `break-all` because this is 64 characters of base64 with no spaces in
            it: without it the card grows a horizontal scrollbar on a phone, and
            a key you have to scroll to read is a key nobody copies correctly.
          */}
          <p ref={shown} className="font-mono text-quiet break-all text-ink">
            {key}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <CopyButton
              value={key}
              displayRef={shown}
              label="Copy key"
              describes="the encryption key"
            />
            {/* Not a toggle. Once it is on screen the only useful thing left is
                to put it away, and a control that could put it back would be one
                more way to leave it showing. */}
            <Button type="button" variant="ghost" onClick={() => setKey(null)}>
              Hide
            </Button>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
