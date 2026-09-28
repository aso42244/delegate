import { describe, expect, it } from 'vitest';
import { restoreHidden } from './account-order.js';

describe('restoreHidden', () => {
  it('reproduces the order exactly when nothing was hidden', () => {
    // Every row visible: the answer is what the component already worked out.
    expect(restoreHidden(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('keeps a hidden row attached to the row it followed', () => {
    // `hidden` follows a, and nobody can see it. Dropping c in front of b must
    // leave it after a rather than moving or losing it.
    expect(restoreHidden(['a', 'hidden', 'b', 'c'], ['a', 'c', 'b'])).toEqual([
      'a',
      'hidden',
      'c',
      'b',
    ]);
  });

  it('carries a hidden row along with the row it follows', () => {
    // The anchor moved to the front, so its passenger goes with it. This is the
    // half that makes the rule predictable rather than merely lossless.
    expect(restoreHidden(['a', 'hidden', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'hidden']);
  });

  it('keeps a hidden row that followed nothing at the front', () => {
    expect(restoreHidden(['hidden', 'a', 'b'], ['b', 'a'])).toEqual(['hidden', 'b', 'a']);
  });

  it('never loses a hidden row, which is the failure this exists to stop', () => {
    const full = ['a', 'h1', 'b', 'h2', 'c'];
    const out = restoreHidden(full, ['c', 'a', 'b']);
    expect([...out].sort()).toEqual([...full].sort());
  });

  it('places a row arriving from another grouping, which is not in the full list', () => {
    expect(restoreHidden(['x', 'y'], ['x', 'moved', 'y'])).toEqual(['x', 'moved', 'y']);
  });

  it('places an arriving row after a hidden one when it was dropped last', () => {
    expect(restoreHidden(['x', 'hidden'], ['x', 'moved'])).toEqual(['x', 'hidden', 'moved']);
  });
});
