import { describe, expect, it } from 'vitest';
import { deriveAddress, deriveRange, parseWalletInput } from './descriptors.js';

/**
 * Derivation, against the published BIP vectors.
 *
 * This is the one place in the application where being subtly wrong produces
 * output that looks perfectly correct and belongs to somebody else. A wrong
 * derivation path or a mis-ordered `sortedmulti` gives well-formed addresses for
 * a wallet that is not yours, and the symptom is "it says I have nothing" rather
 * than an error. So the vectors are the published ones, and the expected
 * addresses are written out rather than computed.
 */

// The BIP32/44/49/84 test-vector wallet: "abandon abandon … about".
const XPUB =
  'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
const YPUB =
  'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP';
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('a bare extended key', () => {
  it('derives BIP44 addresses from an xpub', () => {
    const wallet = parseWalletInput(XPUB);
    expect(wallet.kind).toBe('xpub');
    expect(deriveAddress(wallet.receiveDescriptor, 0)).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
    expect(deriveAddress(wallet.receiveDescriptor, 1)).toBe('1Ak8PffB2meyfYnbXZR9EGfLfFZVpzJvQP');
  });

  it('derives BIP49 addresses from a ypub', () => {
    const wallet = parseWalletInput(YPUB);
    expect(wallet.kind).toBe('ypub');
    expect(deriveAddress(wallet.receiveDescriptor, 0)).toBe('37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  });

  it('derives BIP84 addresses from a zpub', () => {
    const wallet = parseWalletInput(ZPUB);
    expect(wallet.kind).toBe('zpub');
    expect(deriveAddress(wallet.receiveDescriptor, 0)).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(deriveAddress(wallet.receiveDescriptor, 1)).toBe(
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    );
  });

  it('gives each key its own change chain', () => {
    const wallet = parseWalletInput(ZPUB);
    // BIP84 vector, change chain.
    expect(deriveAddress(wallet.changeDescriptor, 0)).toBe(
      'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
    );
  });

  it('refuses a key whose checksum does not match', () => {
    // A truncated paste is the ordinary mistake, and it has to be caught here
    // rather than becoming a wallet that silently watches nothing.
    expect(() => parseWalletInput(`${ZPUB.slice(0, -1)}x`)).toThrow(/checksum/);
  });

  it('refuses something that is neither a key nor a descriptor', () => {
    expect(() => parseWalletInput('my wallet')).toThrow();
    expect(() => parseWalletInput('   ')).toThrow(/Paste an extended public key/);
  });
});

describe('a descriptor', () => {
  const MULTISIG = `wsh(sortedmulti(2,${XPUB}/0/*,${parseWalletInput(ZPUB).receiveDescriptor.replace(/^wpkh\(|\/0\/\*\)$/g, '')}/0/*))`;

  it('derives a 2-of-2 multisig, with the keys sorted', () => {
    const wallet = parseWalletInput(MULTISIG);
    expect(wallet.kind).toBe('descriptor');
    // `sortedmulti` orders the keys itself, so the same set in any order gives
    // the same address. That is the property that makes a multisig watchable
    // without knowing which co-signer was listed first.
    const swapped = MULTISIG.replace(
      /sortedmulti\(2,([^,]+),([^)]+)\)/,
      (_match, a: string, b: string) => `sortedmulti(2,${b},${a})`,
    );
    expect(deriveAddress(parseWalletInput(swapped).receiveDescriptor, 0)).toBe(
      deriveAddress(wallet.receiveDescriptor, 0),
    );
  });

  it('accepts the checksum suffix wallets export', () => {
    // Dropped rather than verified: the library computes its own, and a stale
    // one from a hand-edited string would be refused for the wrong reason.
    const withChecksum = `${MULTISIG}#abcdefgh`;
    expect(deriveAddress(parseWalletInput(withChecksum).receiveDescriptor, 0)).toBe(
      deriveAddress(parseWalletInput(MULTISIG).receiveDescriptor, 0),
    );
  });

  it('understands the multipath form', () => {
    const single = parseWalletInput(MULTISIG);
    const multipath = parseWalletInput(MULTISIG.replace(/\/0\/\*/g, '/<0;1>/*'));

    expect(deriveAddress(multipath.receiveDescriptor, 0)).toBe(
      deriveAddress(single.receiveDescriptor, 0),
    );
    expect(deriveAddress(multipath.changeDescriptor, 0)).toBe(
      deriveAddress(single.changeDescriptor, 0),
    );
  });

  it('refuses a descriptor that parses but derives nothing', () => {
    expect(() => parseWalletInput('wsh(sortedmulti(2))')).toThrow();
  });
});

describe('a run of addresses', () => {
  it('is contiguous from where it is asked to start', () => {
    const wallet = parseWalletInput(ZPUB);
    const run = deriveRange(wallet.receiveDescriptor, 0, 3);

    expect(run).toHaveLength(3);
    expect(run[0]).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(run[2]).toBe(deriveAddress(wallet.receiveDescriptor, 2));
    // No repeats: a gap-limit scan that asked the same address twenty times
    // would look like twenty unused addresses and stop immediately.
    expect(new Set(run).size).toBe(3);
  });
});
