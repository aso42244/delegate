import * as descriptorLib from '@bitcoinerlab/descriptors';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import bs58check from 'bs58check';
import { ValidationError } from '../domain/errors.js';

/**
 * Turning what a wallet exports into addresses.
 *
 * **The descriptor is the one internal representation.** An `xpub`, a `ypub` and
 * a `zpub` are the same key with different version bytes and a different implied
 * script — legacy, wrapped SegWit and native SegWit respectively. Storing that
 * distinction as a separate flag would mean every reader re-deriving what it
 * meant, so each is converted to an explicit descriptor once, on the way in, and
 * multisig arrives as a descriptor already. One representation, one derivation
 * path through the code.
 *
 * Derivation is not hand-rolled. Getting BIP32 or `sortedmulti` key ordering
 * subtly wrong produces addresses that are perfectly well-formed and belong to
 * somebody else, and the failure looks like "my wallet shows zero" rather than
 * like a bug. The library is checked against the published BIP44, BIP49 and
 * BIP84 vectors in the tests beside this file.
 */

const { Output } = descriptorLib.DescriptorsFactory(secp256k1);

/** Mainnet extended-public-key version bytes, by the prefix people paste. */
const VERSIONS: Record<string, { version: string; wrap: (key: string) => string }> = {
  // BIP44 — addresses starting 1…
  xpub: { version: '0488b21e', wrap: (key) => `pkh(${key})` },
  // BIP49 — SegWit wrapped in P2SH, addresses starting 3…
  ypub: { version: '049d7cb2', wrap: (key) => `sh(wpkh(${key}))` },
  // BIP84 — native SegWit, addresses starting bc1q…
  zpub: { version: '04b24746', wrap: (key) => `wpkh(${key})` },
};

const XPUB_VERSION = Buffer.from('0488b21e', 'hex');

/**
 * Rewrites any of the above to a plain `xpub`.
 *
 * The version bytes carry only the intended script type, which the descriptor
 * now states outright. The key material is identical, so this is a relabelling
 * rather than a conversion.
 */
function toXpub(key: string): string {
  let raw: Uint8Array;
  try {
    raw = bs58check.decode(key);
  } catch {
    throw new ValidationError(
      'wallet_key_unreadable',
      'That is not a valid extended public key — the checksum does not match. Copy it again from your wallet.',
    );
  }
  return bs58check.encode(Buffer.concat([XPUB_VERSION, Buffer.from(raw).subarray(4)]));
}

export type WalletKind = 'xpub' | 'ypub' | 'zpub' | 'descriptor';

export interface ParsedWallet {
  readonly kind: WalletKind;
  /**
   * The receive chain, with `*` where the index goes. Change is the same
   * descriptor with `/1/` in place of `/0/`.
   */
  readonly receiveDescriptor: string;
  readonly changeDescriptor: string;
}

/**
 * A descriptor as wallets export it may carry a `#checksum` suffix, and may use
 * the `<0;1>` multipath form for "receive and change in one string".
 */
function splitMultipath(descriptor: string): { receive: string; change: string } | null {
  const pattern = /<(\d+);(\d+)>/g;
  if (!pattern.test(descriptor)) return null;

  // Every key, not the first one. A multisig carries the multipath marker once
  // per co-signer, and rewriting only one of them produces a descriptor that
  // mixes chains — which parses, and derives somebody else's addresses.
  return {
    receive: descriptor.replace(/<(\d+);(\d+)>/g, (_match, receive: string) => receive),
    change: descriptor.replace(
      /<(\d+);(\d+)>/g,
      (_match, _receive: string, change: string) => change,
    ),
  };
}

/**
 * Reads what someone pasted, whatever form it is in.
 *
 * Deliberately forgiving about the input and strict about the result: it will
 * accept a bare key, a key with a derivation suffix, a descriptor with a
 * checksum, or a multipath descriptor — and then proves the outcome by deriving
 * the first address from it before returning. A descriptor that parses but
 * cannot produce an address is a descriptor that would silently watch nothing.
 */
export function parseWalletInput(raw: string): ParsedWallet {
  const text = raw.trim().replace(/\s+/g, '');
  if (text === '') {
    throw new ValidationError('wallet_empty', 'Paste an extended public key or a descriptor.');
  }

  // A bare extended key: no brackets, no function call.
  const bare = /^([xyz]pub)[1-9A-HJ-NP-Za-km-z]+$/.exec(text);
  if (bare) {
    const prefix = bare[1] as keyof typeof VERSIONS;
    const spec = VERSIONS[prefix];
    if (!spec) {
      throw new ValidationError(
        'wallet_key_unknown',
        `Delegate does not know what a ${prefix} is.`,
      );
    }
    const xpub = toXpub(text);
    const parsed: ParsedWallet = {
      kind: prefix as WalletKind,
      receiveDescriptor: spec.wrap(`${xpub}/0/*`),
      changeDescriptor: spec.wrap(`${xpub}/1/*`),
    };
    assertDerivable(parsed);
    return parsed;
  }

  // Anything else is treated as a descriptor. The checksum suffix is dropped:
  // the library computes its own, and a stale one from a hand-edited string
  // would be refused for the wrong reason.
  const withoutChecksum = text.replace(/#[a-z0-9]{8}$/i, '');

  const multipath = splitMultipath(withoutChecksum);
  const parsed: ParsedWallet = multipath
    ? {
        kind: 'descriptor',
        receiveDescriptor: multipath.receive,
        changeDescriptor: multipath.change,
      }
    : {
        kind: 'descriptor',
        receiveDescriptor: withoutChecksum,
        // A single-path descriptor is taken at its word rather than guessed at:
        // rewriting somebody's explicit `/0/*` into a change chain they did not
        // ask for would watch addresses that are not theirs.
        changeDescriptor: withoutChecksum.replace(/\/0\/\*/g, '/1/*'),
      };

  assertDerivable(parsed);
  return parsed;
}

function assertDerivable(wallet: ParsedWallet): void {
  try {
    deriveAddress(wallet.receiveDescriptor, 0);
  } catch (error) {
    throw new ValidationError(
      'wallet_not_derivable',
      error instanceof ValidationError
        ? error.message
        : 'That parses, but no address can be derived from it. Check it was copied whole.',
    );
  }
}

/** One address from a descriptor at an index. */
export function deriveAddress(descriptor: string, index: number): string {
  try {
    return new Output({ descriptor, index }).getAddress();
  } catch (error) {
    throw new ValidationError(
      'wallet_not_derivable',
      `That descriptor did not produce an address: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

/** A run of addresses, which is what a gap-limit scan asks for. */
export function deriveRange(descriptor: string, from: number, count: number): string[] {
  const addresses: string[] = [];
  for (let index = from; index < from + count; index += 1) {
    addresses.push(deriveAddress(descriptor, index));
  }
  return addresses;
}

/** Shown so the owner can confirm the right wallet without reading the key. */
export function fingerprintOf(wallet: ParsedWallet): string {
  return deriveAddress(wallet.receiveDescriptor, 0);
}
