import type { Db } from '../db/client.js';
import { deriveRange, fingerprintOf, parseWalletInput } from '../bitcoin/descriptors.js';
import type { BitcoinNode } from '../bitcoin/esplora.js';
import { recordHoldingEvent } from './bitcoin-holdings.js';
import { nodeClient } from './bitcoin-node.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Wallets watched by extended public key or descriptor.
 *
 * A scan asks the configured node about derived addresses until it has seen
 * `gapLimit` unused ones in a row — twenty by convention, because that is what
 * every wallet uses to decide the same thing. Stopping earlier would miss coins;
 * never stopping would ask a free public service about addresses forever.
 *
 * What a scan produces is **one holding event**, not a rewritten quantity. The
 * ledger from ADR 023 stays the single account of what is held and when, so a
 * wallet-derived balance and a hand-entered purchase live in the same history
 * and the net worth chart reads one thing.
 */

/** Receive and change, which is every chain a scan looks at. */
const CHAINS = [0, 1] as const;

/** A scan is bounded even if the gap limit never closes. */
const MAX_ADDRESSES_PER_CHAIN = 500;

export interface WalletSummary {
  readonly id: string;
  readonly accountId: string;
  readonly label: string;
  readonly kind: string;
  readonly firstAddress: string;
  readonly gapLimit: number;
  readonly lastScannedAt: Date | null;
  readonly lastError: string | null;
  readonly lastBalanceSats: bigint | null;
  readonly addressesSeen: number;
}

export async function listWallets(db: Db, accountId: string): Promise<WalletSummary[]> {
  const wallets = await db.bitcoinWallet.findMany({
    where: { accountId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { addresses: true } } },
  });

  return wallets.map((wallet) => ({
    id: wallet.id,
    accountId: wallet.accountId,
    label: wallet.label,
    kind: wallet.kind,
    firstAddress: wallet.firstAddress,
    gapLimit: wallet.gapLimit,
    lastScannedAt: wallet.lastScannedAt,
    lastError: wallet.lastError,
    lastBalanceSats: wallet.lastBalanceSats,
    addressesSeen: wallet._count.addresses,
  }));
}

export interface AddWalletInput {
  readonly accountId: string;
  readonly label: string;
  /** An xpub, ypub, zpub, or a descriptor. Parsed rather than declared. */
  readonly key: string;
  readonly gapLimit?: number | undefined;
}

/**
 * Stores a wallet, having first proved an address can be derived from it.
 *
 * Proving it here rather than at the first scan is the difference between "that
 * key is not right" while the owner still has it on screen, and a wallet that
 * sits there reporting zero because it was never watching anything.
 */
export async function addWallet(
  db: Db,
  input: AddWalletInput,
  sessionSecret: string,
): Promise<{ id: string; firstAddress: string }> {
  const label = input.label.trim();
  if (label === '') throw new ValidationError('empty_label', 'Give the wallet a name.');

  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { managedAs: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', input.accountId);
  if (account.managedAs !== 'bitcoin') {
    throw new ConflictError('account_not_managed_here', 'That is not a Bitcoin holding.');
  }
  if (account.archivedAt) {
    throw new ConflictError('account_archived', 'That holding is archived. Restore it first.');
  }

  const parsed = parseWalletInput(input.key);
  const firstAddress = fingerprintOf(parsed);

  // The same wallet twice would double the holding on every scan.
  const existing = await db.bitcoinWallet.findFirst({
    where: { accountId: input.accountId, firstAddress, archivedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(
      'wallet_already_watched',
      'That wallet is already being watched on this holding.',
    );
  }

  const wallet = await db.bitcoinWallet.create({
    data: {
      accountId: input.accountId,
      label,
      kind: parsed.kind,
      receiveDescriptorEncrypted: encryptSecret(parsed.receiveDescriptor, sessionSecret),
      changeDescriptorEncrypted: encryptSecret(parsed.changeDescriptor, sessionSecret),
      firstAddress,
      gapLimit: input.gapLimit ?? 20,
    },
    select: { id: true },
  });

  return { id: wallet.id, firstAddress };
}

export async function archiveWallet(db: Db, walletId: string, now = new Date()): Promise<void> {
  const wallet = await db.bitcoinWallet.findUnique({
    where: { id: walletId },
    select: { id: true },
  });
  if (!wallet) throw new NotFoundError('BitcoinWallet', walletId);

  // Archived, never deleted, and the derived addresses go with it — but the
  // holding events a scan produced stay, because they are what the chart read.
  await db.bitcoinWallet.update({ where: { id: walletId }, data: { archivedAt: now } });
}

export interface ScanResult {
  readonly walletId: string;
  readonly balanceSats: bigint;
  readonly addressesChecked: number;
  readonly used: number;
  /** The event recorded, if the balance moved. Null when nothing changed. */
  readonly eventId: string | null;
}

/**
 * Walks a wallet's addresses until the gap limit closes, and records what it
 * found.
 *
 * The gap limit is the whole algorithm: derive, ask, and stop once `gapLimit`
 * consecutive addresses have never been used. Wallets agree on twenty, which is
 * why a wallet restored elsewhere finds the same coins.
 */
export async function scanWallet(
  db: Db,
  walletId: string,
  sessionSecret: string,
  options: { readonly node?: BitcoinNode } = {},
  now: Date = new Date(),
): Promise<ScanResult> {
  const wallet = await db.bitcoinWallet.findUnique({
    where: { id: walletId },
    select: {
      id: true,
      accountId: true,
      gapLimit: true,
      archivedAt: true,
      receiveDescriptorEncrypted: true,
      changeDescriptorEncrypted: true,
    },
  });
  if (!wallet) throw new NotFoundError('BitcoinWallet', walletId);
  if (wallet.archivedAt) {
    throw new ConflictError('wallet_archived', 'That wallet is archived.');
  }

  const node = options.node ?? (await nodeClient(db));
  if (!node) {
    throw new ValidationError(
      'node_not_configured',
      'Set a node under Settings → Bitcoin before watching a wallet. Nothing can be looked up without one.',
    );
  }

  const descriptors = [
    decryptSecret(wallet.receiveDescriptorEncrypted, sessionSecret),
    decryptSecret(wallet.changeDescriptorEncrypted, sessionSecret),
  ];

  let total = 0n;
  let checked = 0;
  let used = 0;

  try {
    for (const chain of CHAINS) {
      const descriptor = descriptors[chain];
      if (!descriptor) continue;

      let index = 0;
      let unusedRun = 0;

      while (unusedRun < wallet.gapLimit && index < MAX_ADDRESSES_PER_CHAIN) {
        // A batch the size of the remaining gap, so the common case — a wallet
        // with nothing new — is one round trip rather than twenty.
        const batchSize = Math.min(wallet.gapLimit - unusedRun, 20);
        const addresses = deriveRange(descriptor, index, batchSize);
        const stats = await node.addressStatsMany(addresses);
        checked += stats.length;

        for (const [offset, stat] of stats.entries()) {
          const at = index + offset;

          await db.bitcoinWalletAddress.upsert({
            where: { walletId_chain_index: { walletId: wallet.id, chain, index: at } },
            create: {
              walletId: wallet.id,
              chain,
              index: at,
              address: stat.address,
              balanceSats: stat.balanceSats,
              txCount: stat.txCount,
              lastSeenAt: stat.txCount > 0 ? now : null,
            },
            update: {
              balanceSats: stat.balanceSats,
              txCount: stat.txCount,
              ...(stat.txCount > 0 ? { lastSeenAt: now } : {}),
            },
          });

          total += stat.balanceSats;
          if (stat.txCount > 0) {
            used += 1;
            unusedRun = 0;
          } else {
            unusedRun += 1;
          }
        }

        index += batchSize;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The scan failed.';
    await db.bitcoinWallet.update({
      where: { id: wallet.id },
      data: { lastScannedAt: now, lastError: message },
    });
    throw error;
  }

  const eventId = await reconcileToLedger(db, wallet.accountId, wallet.id, total, now);

  await db.bitcoinWallet.update({
    where: { id: wallet.id },
    data: { lastScannedAt: now, lastError: null, lastBalanceSats: total },
  });

  return { walletId: wallet.id, balanceSats: total, addressesChecked: checked, used, eventId };
}

/**
 * Turns "the wallet now holds X" into a dated event for the difference.
 *
 * Not a rewrite of the quantity. The ledger stays the single account of what is
 * held and when, so a scan and a hand-entered purchase live in the same history
 * — and a scan that finds nothing new writes nothing at all, rather than a
 * stream of zero-value events every hour.
 */
async function reconcileToLedger(
  db: Db,
  accountId: string,
  walletId: string,
  observedSats: bigint,
  now: Date,
): Promise<string | null> {
  const previous = await db.bitcoinWallet.findUniqueOrThrow({
    where: { id: walletId },
    select: { lastBalanceSats: true },
  });

  const difference = observedSats - (previous.lastBalanceSats ?? 0n);
  if (difference === 0n) return null;

  const event = await recordHoldingEvent(
    db,
    {
      accountId,
      // The first scan is what was already there; later ones are corrections to
      // it. Neither is a purchase — a scan does not know what anything cost.
      eventType: previous.lastBalanceSats === null ? 'opening' : 'adjustment',
      sats: difference < 0n ? -difference : difference,
      signedSats: difference,
      occurredAt: now,
      note: previous.lastBalanceSats === null ? 'Found by a wallet scan.' : 'Wallet scan.',
    },
    now,
  );

  return event.id;
}

/** Just enough of pino for this to log without depending on the HTTP layer. */
interface ScanLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

/**
 * Scans every watched wallet, one at a time.
 *
 * One failure does not stop the rest: a single unreachable wallet — a bad
 * descriptor, a node that timed out on one request — must not leave the other
 * holdings un-updated. Each failure is recorded on its own wallet, where the
 * interface already shows it.
 *
 * Sequential rather than parallel. These go to one node, often a free public
 * one, and firing every wallet's gap scan at it simultaneously is how a
 * household budget gets rate limited.
 */
export async function scanAllWallets(
  db: Db,
  sessionSecret: string,
  logger: ScanLogger,
): Promise<number> {
  const node = await nodeClient(db);
  // Not an error: no node configured is the ordinary state until one is.
  if (!node) return 0;

  const wallets = await db.bitcoinWallet.findMany({
    where: { archivedAt: null, account: { archivedAt: null } },
    select: { id: true, label: true },
  });

  let scanned = 0;
  for (const wallet of wallets) {
    try {
      await scanWallet(db, wallet.id, sessionSecret, { node });
      scanned += 1;
    } catch (error) {
      logger.warn({ walletId: wallet.id, err: error }, 'wallet scan failed');
    }
  }
  return scanned;
}
