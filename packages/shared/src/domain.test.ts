import { describe, expect, it } from 'vitest';
import {
  CYCLES_PER_YEAR,
  canManageUsers,
  canModifyUser,
  isBalanceStale,
  suggestedPerCycleCents,
} from './domain.js';

describe('permissions', () => {
  it('gates only user management', () => {
    expect(canManageUsers('user')).toBe(false);
    expect(canManageUsers('admin')).toBe(true);
    expect(canManageUsers('super_admin')).toBe(true);
  });

  it('makes the Super Admin immune to everyone but themselves', () => {
    expect(canModifyUser('admin', 'super_admin')).toBe(false);
    expect(canModifyUser('super_admin', 'super_admin')).toBe(true);
    expect(canModifyUser('admin', 'user')).toBe(true);
    expect(canModifyUser('admin', 'admin')).toBe(true);
    expect(canModifyUser('user', 'user')).toBe(false);
  });
});

describe('isBalanceStale', () => {
  const now = new Date('2026-08-08T12:00:00Z');

  it('is never stale without an interval configured', () => {
    expect(isBalanceStale(new Date('2020-01-01T00:00:00Z'), null, now)).toBe(false);
  });

  it('is never stale without a confirmed date', () => {
    expect(isBalanceStale(null, 30, now)).toBe(false);
  });

  it('flags a balance older than its own interval', () => {
    expect(isBalanceStale(new Date('2026-08-01T12:00:00Z'), 30, now)).toBe(false);
    expect(isBalanceStale(new Date('2026-06-01T12:00:00Z'), 30, now)).toBe(true);
  });

  it('is not stale exactly on the boundary', () => {
    expect(isBalanceStale(new Date('2026-07-09T12:00:00Z'), 30, now)).toBe(false);
    expect(isBalanceStale(new Date('2026-07-09T11:59:59Z'), 30, now)).toBe(true);
  });

  it('supports the long intervals the owner named for property', () => {
    // 2026-05-20 → 2026-08-08 is 80 days; 2026-05-08 would be 92 and stale.
    expect(isBalanceStale(new Date('2026-05-20T12:00:00Z'), 90, now)).toBe(false);
    expect(isBalanceStale(new Date('2026-05-08T12:00:00Z'), 90, now)).toBe(true);
    expect(isBalanceStale(new Date('2026-01-08T12:00:00Z'), 180, now)).toBe(true);
  });
});

describe('suggestedPerCycleCents', () => {
  it('spreads a monthly average across 26 biweekly cycles', () => {
    expect(CYCLES_PER_YEAR).toBe(26);
    // $120/mo × 12 ÷ 26 = $55.3846… → $55.38
    expect(suggestedPerCycleCents(120_00n)).toBe(55_38n);
    // $260/mo × 12 ÷ 26 = exactly $120.00
    expect(suggestedPerCycleCents(260_00n)).toBe(120_00n);
  });

  it('rounds half away from zero', () => {
    // 13 cents × 12 = 156; 156 / 26 = exactly 6.
    expect(suggestedPerCycleCents(13n)).toBe(6n);
    // 1 cent × 12 = 12; 12 / 26 = 0.46 → 0.
    expect(suggestedPerCycleCents(1n)).toBe(0n);
    // 2 cents × 12 = 24; 24 / 26 = 0.92 → 1.
    expect(suggestedPerCycleCents(2n)).toBe(1n);
  });

  it('handles zero and negatives symmetrically', () => {
    expect(suggestedPerCycleCents(0n)).toBe(0n);
    expect(suggestedPerCycleCents(-120_00n)).toBe(-55_38n);
    expect(suggestedPerCycleCents(-2n)).toBe(-1n);
  });
});
