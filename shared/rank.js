/**
 * Fractional ranks for ordering cards and columns.
 *
 * A rank is a non-empty string over a base-62 alphabet whose characters are in
 * ASCII order, so plain string comparison (`<`) gives the visual order. Between
 * any two distinct ranks there is always another one, so an item can be moved
 * by rewriting only its own rank: concurrent moves never have to renumber the
 * neighbours. Ranks never end in the zero digit, which keeps that guarantee.
 *
 * The same file runs on the server (CommonJS) and in the browser (global
 * `Rank`), so both sides compute positions with identical rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rank = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const BASE = DIGITS.length;
  const RANK_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
  /** Ranks longer than this trigger a rebalance of the list on the server. */
  const MAX_RANK_LENGTH = 48;

  function isValidRank(rank) {
    return typeof rank === 'string' && rank.length <= 256 && RANK_PATTERN.test(rank);
  }

  // Midpoint of two fractional digit strings. `a` may be '' (zero) and `b`
  // may be null (one). Requires a < b and neither ending in '0'.
  function midpoint(a, b) {
    if (b !== null) {
      let n = 0;
      while ((a[n] || '0') === b[n]) n++;
      if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
    const digitA = a ? DIGITS.indexOf(a[0]) : 0;
    const digitB = b !== null ? DIGITS.indexOf(b[0]) : BASE;
    if (digitB - digitA > 1) {
      return DIGITS[Math.round((digitA + digitB) / 2)];
    }
    if (b !== null && b.length > 1) return b.slice(0, 1);
    return DIGITS[digitA] + midpoint(a.slice(1), null);
  }

  /**
   * Returns a rank strictly between `before` and `after`.
   * @param {string|null} before rank of the previous item, or null for the start
   * @param {string|null} after rank of the next item, or null for the end
   * @returns {string}
   */
  function between(before, after) {
    if (before !== null && !isValidRank(before)) throw new Error(`Invalid rank: ${before}`);
    if (after !== null && !isValidRank(after)) throw new Error(`Invalid rank: ${after}`);
    if (before !== null && after !== null && before >= after) {
      throw new Error(`Ranks out of order: ${before} >= ${after}`);
    }
    return midpoint(before === null ? '' : before, after);
  }

  /**
   * Returns `count` evenly spaced, short, ascending ranks. Used to give a list
   * fresh ranks when repeated inserts at the same spot made them long.
   * @param {number} count
   * @returns {string[]}
   */
  function evenlySpaced(count) {
    if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer');
    let length = 1;
    while (BASE ** length <= count) length++;
    const space = BASE ** length;
    const ranks = [];
    for (let i = 1; i <= count; i++) {
      let value = Math.floor((i * space) / (count + 1));
      let digits = '';
      for (let d = 0; d < length; d++) {
        digits = DIGITS[value % BASE] + digits;
        value = Math.floor(value / BASE);
      }
      ranks.push(digits.replace(/0+$/, ''));
    }
    return ranks;
  }

  /** Orders items by rank, breaking (unexpected) ties by id. */
  function compare(a, b) {
    if (a.rank < b.rank) return -1;
    if (a.rank > b.rank) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }

  /**
   * Decides the rank of an item placed into an ordered list.
   *
   * @param {{ id: string, rank: string }[]} siblings the target list WITHOUT the moving item
   * @param {{ afterId?: string|null, beforeId?: string|null }} anchor `afterId` null places
   *   first; omitted places last; `beforeId` is the fallback when `afterId` is gone.
   * @returns {{ rank: string, index: number, rebalanced: { id: string|null, rank: string }[] | null }}
   *   `rebalanced` holds fresh ranks for the whole list (the placed item has id null) when
   *   ranks grew past MAX_RANK_LENGTH.
   */
  function place(siblings, anchor) {
    const afterId = anchor.afterId;
    const beforeId = anchor.beforeId;
    const list = siblings.slice().sort(compare);
    const indexOf = (id) => list.findIndex((item) => item.id === id);
    let index = list.length;
    if (afterId === null) index = 0;
    else if (afterId !== undefined && indexOf(afterId) !== -1) index = indexOf(afterId) + 1;
    else if (beforeId !== undefined && beforeId !== null && indexOf(beforeId) !== -1) index = indexOf(beforeId);

    const rank = between(index > 0 ? list[index - 1].rank : null, index < list.length ? list[index].rank : null);
    if (rank.length <= MAX_RANK_LENGTH) return { rank, index, rebalanced: null };

    const ordered = list.slice(0, index).concat([{ id: null }], list.slice(index));
    const fresh = evenlySpaced(ordered.length);
    return {
      rank: fresh[index],
      index,
      rebalanced: ordered.map((item, i) => ({ id: item.id, rank: fresh[i] })),
    };
  }

  return { between, evenlySpaced, compare, place, isValidRank, MAX_RANK_LENGTH };
});
