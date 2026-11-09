import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getQuoteDetails,
  isValidPipSize,
  isValidTickEpoch,
  parseTickHistory,
  parseTimestampedTick,
  parseTimestampedTickHistory,
} from './market-data.ts';

test('digit extraction preserves configured decimal precision and trailing zeroes', () => {
  assert.deepEqual(getQuoteDetails('123.45', 2), { price: '123.45', lastDigit: 5 });
  assert.deepEqual(getQuoteDetails('1.2', 3), { price: '1.200', lastDigit: 0 });
  assert.deepEqual(getQuoteDetails('5', 2), { price: '5.00', lastDigit: 0 });
  assert.deepEqual(getQuoteDetails('123', 0), { price: '123', lastDigit: 3 });
});

test('digit extraction expands numeric scientific notation', () => {
  assert.deepEqual(getQuoteDetails(1e-7, 7), { price: '0.0000001', lastDigit: 1 });
  assert.deepEqual(getQuoteDetails(1.25e2, 2), { price: '125.00', lastDigit: 0 });
});

test('invalid precision and quotes are rejected instead of guessed', () => {
  assert.equal(isValidPipSize(0), true);
  assert.equal(isValidPipSize(10), true);
  assert.equal(isValidPipSize(-1), false);
  assert.equal(isValidPipSize(2.5), false);
  assert.equal(getQuoteDetails('1.23', 11), null);
  assert.equal(getQuoteDetails('1.234', 2), null);
  assert.equal(getQuoteDetails(Number.NaN, 2), null);
  assert.equal(getQuoteDetails('not-a-price', 2), null);
});

test('tick history rejects partial invalid data', () => {
  assert.deepEqual(parseTickHistory(['1.20', '1.35'], 2), [
    { price: '1.20', lastDigit: 0 },
    { price: '1.35', lastDigit: 5 },
  ]);
  assert.equal(parseTickHistory(['1.20', 'bad'], 2), null);
  assert.equal(parseTickHistory([], 2), null);
});

test('timestamped history requires ordered epochs aligned with every quote and tags the symbol', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.deepEqual(parseTimestampedTickHistory(
    ['1.20', '1.35'],
    [nowSeconds - 1, nowSeconds],
    2,
    'R_100',
    nowSeconds,
  ), [
    { price: '1.20', lastDigit: 0, epoch: nowSeconds - 1, symbol: 'R_100' },
    { price: '1.35', lastDigit: 5, epoch: nowSeconds, symbol: 'R_100' },
  ]);
  assert.equal(parseTimestampedTickHistory(['1.20'], [], 2, 'R_100', nowSeconds), null);
  assert.equal(parseTimestampedTickHistory(
    ['1.20', '1.35'],
    [nowSeconds - 1, nowSeconds - 1],
    2,
    'R_100',
    nowSeconds,
  ), null);
  assert.equal(parseTimestampedTickHistory(
    ['1.20', '1.35'],
    [nowSeconds, nowSeconds - 1],
    2,
    'R_100',
    nowSeconds,
  ), null);
  assert.equal(parseTimestampedTickHistory(
    ['1.20'],
    [nowSeconds - 301],
    2,
    'R_100',
    nowSeconds,
  ), null);
});

test('live tick validation rejects missing, stale, future, duplicate, and out-of-order epochs', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.equal(isValidTickEpoch(nowSeconds, nowSeconds), true);
  assert.equal(isValidTickEpoch(nowSeconds + 6, nowSeconds), false);
  assert.equal(isValidTickEpoch(nowSeconds - 301, nowSeconds), false);
  assert.deepEqual(
    parseTimestampedTick('1.25', 2, nowSeconds, 'R_100', nowSeconds - 1),
    { price: '1.25', lastDigit: 5, epoch: nowSeconds, symbol: 'R_100' },
  );
  assert.equal(parseTimestampedTick('1.25', 2, nowSeconds, 'R_100', nowSeconds), null);
  assert.equal(parseTimestampedTick('1.25', 2, nowSeconds - 301, 'R_100'), null);
});
