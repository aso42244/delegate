import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDENTITY_TOLERANCE_CENTS,
  classifyIdentity,
  computeIdentity,
  formatIdentityLabel,
} from './identity.js';
import { cents } from './money.js';

describe('computeIdentity', () => {
  it('subtracts debts and delegations from assets', () => {
    const result = computeIdentity({
      assetsCents: cents(1_000_00),
      debtsCents: cents(200_00),
      delegationsCents: cents(300_00),
    });
    expect(result.differenceCents).toBe(500_00n);
  });

  it('reads a landed paycheck as money available to delegate', () => {
    // Assets rose by the deposit; delegations were untouched. That gap is the
    // unallocated money — income needs no dedicated structure.
    const result = computeIdentity({
      assetsCents: cents(10_000_00),
      debtsCents: cents(0),
      delegationsCents: cents(5_110_00),
    });
    expect(result.status).toBe('to_delegate');
    expect(formatIdentityLabel(result)).toBe('$4,890.00 to delegate');
  });

  it('adds back a categorized pending spend the balance has not caught up with', () => {
    // The state the owner hits between charging a card and the charge settling:
    // the envelope is already down $361.47, the card balance is not yet up by it.
    // Without the pending term the page offers $361.47 that has already been spent.
    const result = computeIdentity({
      assetsCents: cents(15_298_29),
      debtsCents: cents(5_015_37),
      delegationsCents: cents(9_921_45),
      pendingCents: cents(-361_47),
    });
    expect(result.differenceCents).toBe(0n);
    expect(result.status).toBe('balanced');
  });

  it('subtracts a pending refund, which leans the other way', () => {
    // Categorizing a pending credit puts the money back in the envelope before
    // the account shows it, so the uncorrected reading is over-delegated.
    const result = computeIdentity({
      assetsCents: cents(1_000_00),
      debtsCents: cents(0),
      delegationsCents: cents(1_050_00),
      pendingCents: cents(50_00),
    });
    expect(result.differenceCents).toBe(0n);
    expect(result.status).toBe('balanced');
  });

  it('is unchanged when nothing is pending', () => {
    const withZero = computeIdentity({
      assetsCents: cents(1_000_00),
      debtsCents: cents(200_00),
      delegationsCents: cents(300_00),
      pendingCents: cents(0),
    });
    const omitted = computeIdentity({
      assetsCents: cents(1_000_00),
      debtsCents: cents(200_00),
      delegationsCents: cents(300_00),
    });
    expect(withZero.differenceCents).toBe(omitted.differenceCents);
    expect(omitted.pendingCents).toBe(0n);
  });

  it('treats normal drift as balanced', () => {
    const result = computeIdentity({
      assetsCents: cents(5_000_00),
      debtsCents: cents(0),
      delegationsCents: cents(5_000_01),
    });
    expect(result.differenceCents).toBe(-1n);
    expect(result.status).toBe('balanced');
    expect(formatIdentityLabel(result)).toBe('Balanced');
  });

  it('reports over-delegation', () => {
    const result = computeIdentity({
      assetsCents: cents(1_000_00),
      debtsCents: cents(0),
      delegationsCents: cents(1_212_00),
    });
    expect(result.status).toBe('over_delegated');
    expect(formatIdentityLabel(result)).toBe('$212.00 over-delegated');
  });

  it('does not let an off-budget mortgage move the identity', () => {
    // The house and the mortgage are in_net_worth only, so neither reaches
    // this calculation. Passing only in-budget totals must still balance.
    const withoutHouse = computeIdentity({
      assetsCents: cents(8_400_00),
      debtsCents: cents(1_200_00),
      delegationsCents: cents(7_200_00),
    });
    expect(withoutHouse.status).toBe('balanced');
    expect(withoutHouse.differenceCents).toBe(0n);
  });

  it('defaults the tolerance to $5 and honours an override', () => {
    expect(DEFAULT_IDENTITY_TOLERANCE_CENTS).toBe(500n);

    const drift = { assetsCents: cents(400), debtsCents: cents(0), delegationsCents: cents(0) };
    expect(computeIdentity(drift).status).toBe('balanced');
    expect(computeIdentity({ ...drift, toleranceCents: cents(100) }).status).toBe('to_delegate');
    expect(computeIdentity({ ...drift, toleranceCents: cents(0) }).status).toBe('to_delegate');
  });
});

describe('classifyIdentity', () => {
  it('is inclusive at the tolerance boundary', () => {
    expect(classifyIdentity(cents(500), cents(500))).toBe('balanced');
    expect(classifyIdentity(cents(-500), cents(500))).toBe('balanced');
    expect(classifyIdentity(cents(501), cents(500))).toBe('to_delegate');
    expect(classifyIdentity(cents(-501), cents(500))).toBe('over_delegated');
  });

  it('treats a zero difference as balanced even with zero tolerance', () => {
    expect(classifyIdentity(cents(0), cents(0))).toBe('balanced');
  });
});
