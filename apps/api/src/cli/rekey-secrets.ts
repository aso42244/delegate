/**
 * `secrets:rekey` — re-encrypts every stored secret under a new key.
 *
 * Delegate encrypts three things at rest: each account's TOTP secret, the
 * SimpleFIN access URL, and every watched wallet's descriptors. Until now the
 * key for all of them was derived from `SESSION_SECRET`, which meant rotating
 * that — after a suspected compromise, say — also made every one of them
 * unreadable in the same moment. That coupling is the reason never to rotate
 * either, which is the opposite of what a secret wants.
 *
 * This is the way out. It reads everything with the key in force now, writes it
 * back under `DATA_ENCRYPTION_KEY_NEW`, and does the whole thing in one
 * transaction: either every secret moves or none does.
 *
 *   DATA_ENCRYPTION_KEY_NEW='…' npm run secrets:rekey --workspace @budget/api
 *
 * Then set `DATA_ENCRYPTION_KEY` to that value in `.env` and restart. Until you
 * do, the application is still reading with the old key and nothing works —
 * which is why `--check` exists, and why this refuses to run against a database
 * it cannot read completely first.
 */

import { prisma } from '../db/client.js';
import { getConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../domain/secrets.js';

/**
 * One thing to move, which may hold more than one secret.
 *
 * `read` gives back plaintexts and `write` takes ciphertexts in the same order.
 * The first version packed a wallet's two descriptors into JSON at read time and
 * tried to unpack them at write time — by which point the value was the
 * *encrypted* JSON, so it parsed as nothing. Keeping the parts as a list means
 * there is no encoding to get wrong.
 *
 * `write` takes the transaction client. The first version closed over the global
 * one, so nothing it did was actually inside the transaction it appeared to be
 * in: a failure halfway would have left some secrets on the new key and some on
 * the old, which is precisely the state this command exists to make impossible.
 */
interface Rewrite {
  readonly what: string;
  /** Reads the current values, or throws if the key in force cannot. */
  readonly read: () => string[];
  readonly write: (tx: TransactionClient, values: string[]) => Promise<void>;
}

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function collect(oldKey: string): Promise<Rewrite[]> {
  const rewrites: Rewrite[] = [];

  const users = await prisma.user.findMany({
    where: { totpSecretEncrypted: { not: null } },
    select: { id: true, username: true, totpSecretEncrypted: true },
  });
  for (const user of users) {
    rewrites.push({
      what: `second factor for ${user.username}`,
      read: () => [decryptSecret(user.totpSecretEncrypted!, oldKey)],
      write: async (tx, [value]) => {
        await tx.user.update({
          where: { id: user.id },
          data: { totpSecretEncrypted: value! },
        });
      },
    });
  }

  const settings = await prisma.budgetSettings.findUnique({
    where: { id: 1 },
    select: { simplefinAccessUrlEncrypted: true },
  });
  if (settings?.simplefinAccessUrlEncrypted) {
    const stored = settings.simplefinAccessUrlEncrypted;
    rewrites.push({
      what: 'the SimpleFIN credential',
      read: () => [decryptSecret(stored, oldKey)],
      write: async (tx, [value]) => {
        await tx.budgetSettings.update({
          where: { id: 1 },
          data: { simplefinAccessUrlEncrypted: value! },
        });
      },
    });
  }

  const wallets = await prisma.bitcoinWallet.findMany({
    select: {
      id: true,
      label: true,
      receiveDescriptorEncrypted: true,
      changeDescriptorEncrypted: true,
    },
  });
  for (const wallet of wallets) {
    // Both chains together: half a re-keyed wallet is a wallet that scans one
    // chain and fails on the other, which reads as "my balance halved".
    rewrites.push({
      what: `wallet ${wallet.label}`,
      read: () => [
        decryptSecret(wallet.receiveDescriptorEncrypted, oldKey),
        decryptSecret(wallet.changeDescriptorEncrypted, oldKey),
      ],
      write: async (tx, [receive, change]) => {
        await tx.bitcoinWallet.update({
          where: { id: wallet.id },
          data: {
            receiveDescriptorEncrypted: receive!,
            changeDescriptorEncrypted: change!,
          },
        });
      },
    });
  }

  return rewrites;
}

async function main(): Promise<number> {
  const checkOnly = process.argv.includes('--check');
  const config = getConfig();
  const oldKey = config.dataKey;
  const newKey = process.env['DATA_ENCRYPTION_KEY_NEW'] ?? '';

  if (!checkOnly && newKey === '') {
    console.error('Set DATA_ENCRYPTION_KEY_NEW to the key you want to move to.');
    console.error('Run with --check first to prove everything can be read as it stands.');
    return 2;
  }
  if (!checkOnly && newKey.length < 32) {
    console.error('DATA_ENCRYPTION_KEY_NEW is too short. Use at least 32 characters.');
    return 2;
  }
  if (!checkOnly && newKey === oldKey) {
    console.error('DATA_ENCRYPTION_KEY_NEW is the key already in use. Nothing to do.');
    return 2;
  }

  const rewrites = await collect(oldKey);
  console.log(`Found ${rewrites.length} stored secret(s).`);

  // Read everything before writing anything. A key that cannot open one of them
  // has to be found now, while the database is untouched — not halfway through.
  const plaintexts: string[][] = [];
  for (const rewrite of rewrites) {
    try {
      plaintexts.push(rewrite.read());
      console.log(`  ✓ ${rewrite.what}`);
    } catch {
      console.error(`  ✘ ${rewrite.what} — cannot be decrypted with the key in force.`);
      console.error('Nothing has been changed. Check DATA_ENCRYPTION_KEY / SESSION_SECRET.');
      return 1;
    }
  }

  if (checkOnly) {
    console.log('Every stored secret reads cleanly. Nothing was written.');
    return 0;
  }

  await prisma.$transaction(async (tx) => {
    for (const [index, rewrite] of rewrites.entries()) {
      const encrypted = plaintexts[index]!.map((value) => encryptSecret(value, newKey));
      await rewrite.write(tx, encrypted);
    }
  });

  console.log(`\nRe-encrypted ${rewrites.length} secret(s).`);
  console.log('Now set DATA_ENCRYPTION_KEY to the new value in .env and restart:');
  console.log('  sudo docker compose up -d');
  console.log('\nUntil you do, the application is reading with the old key and will fail.');
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
