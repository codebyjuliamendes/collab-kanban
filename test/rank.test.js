'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Rank = require('../shared/rank');

test('between() returns a rank strictly between its bounds', () => {
  const cases = [
    [null, null],
    [null, 'V'],
    ['V', null],
    ['a', 'b'],
    ['a', 'a1'],
    ['az', 'b'],
    ['1', '2'],
    ['zzz', null],
    [null, '01'],
  ];
  for (const [before, after] of cases) {
    const rank = Rank.between(before, after);
    assert.ok(Rank.isValidRank(rank), `valid rank for ${before}..${after}: ${rank}`);
    if (before !== null) assert.ok(before < rank, `${before} < ${rank}`);
    if (after !== null) assert.ok(rank < after, `${rank} < ${after}`);
  }
});

test('between() rejects invalid or unordered bounds', () => {
  assert.throws(() => Rank.between('b', 'a'));
  assert.throws(() => Rank.between('a', 'a'));
  assert.throws(() => Rank.between('a0', null));
  assert.throws(() => Rank.between('', null));
  assert.throws(() => Rank.between('a b', null));
});

test('repeated inserts at the same spot stay ordered (no float exhaustion)', () => {
  // The previous float midpoint broke after ~50 inserts at the same position.
  let low = 'a';
  const high = 'b';
  for (let i = 0; i < 500; i++) {
    const mid = Rank.between(low, high);
    assert.ok(low < mid && mid < high);
    low = mid;
  }
});

test('random inserts keep a consistent total order', () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const ranks = [];
  for (let i = 0; i < 2000; i++) {
    const index = Math.floor(random() * (ranks.length + 1));
    const rank = Rank.between(ranks[index - 1] ?? null, ranks[index] ?? null);
    ranks.splice(index, 0, rank);
  }
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i - 1] < ranks[i]);
  assert.equal(new Set(ranks).size, ranks.length);
});

test('evenlySpaced() returns short ascending ranks', () => {
  for (const count of [0, 1, 2, 10, 61, 62, 63, 500]) {
    const ranks = Rank.evenlySpaced(count);
    assert.equal(ranks.length, count);
    ranks.forEach((rank) => assert.ok(Rank.isValidRank(rank), rank));
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i - 1] < ranks[i], `${ranks[i - 1]} < ${ranks[i]}`);
    assert.ok(ranks.every((rank) => rank.length <= 2));
  }
});

test('place() honours afterId, falls back to beforeId, then the end', () => {
  const list = [
    { id: 'a', rank: 'a' },
    { id: 'c', rank: 'c' },
    { id: 'b', rank: 'b' },
  ];
  assert.equal(Rank.place(list, { afterId: null }).index, 0);
  assert.equal(Rank.place(list, {}).index, 3);
  const afterA = Rank.place(list, { afterId: 'a' });
  assert.equal(afterA.index, 1);
  assert.ok(afterA.rank > 'a' && afterA.rank < 'b');
  assert.equal(Rank.place(list, { afterId: 'gone', beforeId: 'c' }).index, 2);
  assert.equal(Rank.place(list, { afterId: 'gone', beforeId: 'gone-too' }).index, 3);
});

test('place() rebalances the list when ranks get too long', () => {
  const list = [
    { id: 'x', rank: 'a' },
    { id: 'y', rank: 'a' + '0'.repeat(Rank.MAX_RANK_LENGTH) + '1' },
  ];
  const result = Rank.place(list, { afterId: 'x' });
  assert.ok(result.rebalanced);
  assert.deepEqual(
    result.rebalanced.map((item) => item.id),
    ['x', null, 'y'],
  );
  const ranks = result.rebalanced.map((item) => item.rank);
  assert.ok(ranks[0] < ranks[1] && ranks[1] < ranks[2]);
  assert.equal(result.rank, ranks[1]);
});

test('compare() breaks rank ties by id', () => {
  const items = [
    { id: 'b', rank: 'm' },
    { id: 'a', rank: 'm' },
    { id: 'c', rank: 'a' },
  ];
  assert.deepEqual(
    items.sort(Rank.compare).map((item) => item.id),
    ['c', 'a', 'b'],
  );
});
