import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getContractSignal,
  getWalkForwardResults,
  isContractWin,
  multipleTestingZScore,
  scanMarkets,
  wilsonLowerBound,
  type LiveTick,
} from './analysis-engine.ts';

function createMarket(digitAt: (index: number) => number): LiveTick[] {
  return Array.from({ length: 1_000 }, (_, index) => {
    const digit = digitAt(index);
    return { price: `100.${digit}`, digit };
  });
}

function createTransitionMarket(length: number): LiveTick[] {
  const pattern = [4, 0, 0, 8, 4, 1, 1, 8];
  return Array.from({ length }, (_, index) => {
    const digit = pattern[index % pattern.length];
    return { price: `100.${digit}`, digit };
  });
}

test('contract evaluation uses the specified digit barriers and parity', () => {
  assert.equal(isContractWin('match-digit', '4', 4, 4), true);
  assert.equal(isContractWin('match-digit', '4', 4, 5), false);
  assert.equal(isContractWin('differ', '4', 4, 5), true);
  assert.equal(isContractWin('over', 'over-3', 3, 4), true);
  assert.equal(isContractWin('over', 'over-3', 3, 3), false);
  assert.equal(isContractWin('under', 'under-6', 6, 5), true);
  assert.equal(isContractWin('under', 'under-6', 6, 6), false);
  assert.equal(isContractWin('even-odd', 'even', null, 2), true);
  assert.equal(isContractWin('even-odd', 'even', null, 3), false);
  assert.equal(isContractWin('match-digit', 'invalid', 10, 10), false);
});

test('signal generation requires observations and uses the latest context', () => {
  assert.equal(getContractSignal([], 'match-digit'), null);
  const signal = getContractSignal(createMarket(() => 7).slice(0, 10), 'match-digit');
  assert.equal(signal?.signalKey, '7');
  assert.equal(signal?.baselineRate, 0.1);
  assert.equal(signal?.recentSampleSize, 7);
});

test('automatic MATCHES still returns a fallback when prior transition support is absent', () => {
  const ticks = Array.from({ length: 10 }, (_, digit) => ({
    price: `100.${digit}`,
    digit,
  }));
  const signal = getContractSignal(ticks, 'match-digit');
  assert.equal(signal?.signalKey, '9');
  assert.equal(signal?.recentSampleSize, 0);
});

test('matches/differs, over/under, and parity signals keep independent configuration', () => {
  const ticks = createMarket((index) => index % 10);
  const matches = getContractSignal(ticks, 'match-digit', undefined, {
    signalWindow: 50,
    targetDigit: 6,
  });
  const over = getContractSignal(ticks, 'over', undefined, {
    signalWindow: 80,
    barrier: 6,
  });
  const parity = getContractSignal(ticks, 'even-odd', undefined, {
    signalWindow: 60,
    parity: 'odd',
  });

  assert.equal(matches?.signalKey, '6');
  assert.equal(matches?.analyzedTickCount, 50);
  assert.equal(over?.signalKey, 'over-6');
  assert.equal(over?.baselineRate, 0.3);
  assert.equal(over?.analyzedTickCount, 80);
  assert.equal(parity?.signalKey, 'odd');
  assert.equal(parity?.analyzedTickCount, 60);
  assert.throws(
    () => getContractSignal(ticks, 'over', undefined, { barrier: 10 }),
    RangeError,
  );
  assert.equal(getContractSignal(ticks, 'even-odd', undefined, { parity: 'odd' })?.signalKey, 'odd');
});

test('multiple-market correction raises the confidence threshold', () => {
  const oneTestZ = multipleTestingZScore(1);
  const manyTestsZ = multipleTestingZScore(200);
  assert.ok(oneTestZ > 1.6 && oneTestZ < 1.7);
  assert.ok(manyTestsZ > 3.4);
  assert.ok(manyTestsZ > oneTestZ);
  assert.throws(() => multipleTestingZScore(0), RangeError);
});

test('Wilson lower bound is conservative and bounded', () => {
  assert.equal(wilsonLowerBound(0, 0, 2), 0);
  assert.equal(wilsonLowerBound(0, 100, 2), 0);
  assert.ok(wilsonLowerBound(90, 100, 2) < 0.9);
  assert.ok(wilsonLowerBound(90, 100, 2) > 0.8);
  assert.ok(wilsonLowerBound(100, 100, 2) > 0.9);
  assert.ok(wilsonLowerBound(100, 100, 2) < 1);
});

test('walk-forward validation accepts a strong historical signal', () => {
  const ticks = createMarket(() => 0);
  const market = { symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 1 };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map([['R_100', ticks.slice(-10)]]),
  );

  assert.equal(candidates.length, 1);
  const zeroCandidate = candidates[0];
  assert.ok(zeroCandidate);
  assert.equal(zeroCandidate.signalKey, '0');
  assert.equal(zeroCandidate.backtestPredictions, 698);
  assert.equal(zeroCandidate.isValidated, true);
  assert.ok(zeroCandidate.wilsonLowerBound > zeroCandidate.baselineRate);
});

test('scan decisions use the prior 100 ticks plus the latest 10 fresh ticks without leaking fresh data into validation', () => {
  const historicalTicks = createMarket((index) => index % 10);
  const freshTicks = Array.from({ length: 11 }, (_, index) => ({
    price: `200.${index % 10}`,
    digit: index % 10,
  }));
  const alteredFreshTicks = freshTicks.map((tick) => ({
    ...tick,
    price: '200.0',
    digit: 0,
  }));
  const firstScanTicks = [...historicalTicks, ...freshTicks];
  const secondScanTicks = [...historicalTicks, ...alteredFreshTicks];
  const firstResult = scanMarkets(
    [{ symbol: 'R_100', label: 'Volatility 100 Index', ticks: firstScanTicks, tickVersion: 11 }],
    'match-digit',
    new Map([['R_100', freshTicks]]),
    { targetDigit: 0 },
  )[0];
  const secondResult = scanMarkets(
    [{ symbol: 'R_100', label: 'Volatility 100 Index', ticks: secondScanTicks, tickVersion: 11 }],
    'match-digit',
    new Map([['R_100', alteredFreshTicks]]),
    { targetDigit: 0 },
  )[0];

  assert.ok(firstResult);
  assert.ok(secondResult);
  assert.equal(firstResult.analyzedTickCount, 110);
  assert.deepEqual(firstResult.analyzedTicks, [
    ...historicalTicks.slice(-100),
    ...freshTicks.slice(-10),
  ]);
  assert.equal(firstResult.backtestHits, secondResult.backtestHits);
  assert.equal(firstResult.backtestPredictions, secondResult.backtestPredictions);
});

test('scan returns an unvalidated candidate when fewer than 10 fresh ticks arrive', () => {
  const ticks = createMarket(() => 0);
  const market = { symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 9 };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map([['R_100', ticks.slice(-9)]]),
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].freshTickCount, 9);
  assert.equal(candidates[0].isValidated, false);
});

test('automatic MATCHES predicts from recent digit transitions, not the most frequent digit', () => {
  const ticks = createTransitionMarket(1_000);
  const freshTicks = [
    4, 0, 0, 8, 4, 1, 1, 8, 4, 4,
  ].map((digit) => ({ price: `200.${digit}`, digit }));
  const market = {
    symbol: 'R_100',
    label: 'Volatility 100 Index',
    ticks: [...ticks, ...freshTicks],
    tickVersion: freshTicks.length,
  };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map([['R_100', freshTicks]]),
  );
  const digitCounts = [...ticks, ...freshTicks].reduce((counts, tick) => {
    counts[tick.digit] += 1;
    return counts;
  }, Array<number>(10).fill(0));
  const mostFrequentDigit = digitCounts.indexOf(Math.max(...digitCounts));

  assert.equal(mostFrequentDigit, 4);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].digit, 8);
  assert.equal(candidates[0].isValidated, true);
  assert.ok(candidates[0].backtestAccuracy > 0.5);
  assert.ok(candidates[0].recentOccurrences > 0);
});

test('MATCHES walk-forward outcomes score exactly three ticks after each prediction', () => {
  const ticks = createMarket((index) => index % 10);
  const result = getWalkForwardResults(ticks, 'match-digit', {
    signalWindow: 100,
    targetDigit: 3,
  });
  let expectedPredictions = 0;
  let expectedHits = 0;

  for (let index = 300; index + 2 < ticks.length; index += 1) {
    expectedPredictions += 1;
    if (ticks[index + 2].digit === 3) expectedHits += 1;
  }

  const digitThreeResult = result.signalResults.get('3');
  assert.equal(result.predictions, expectedPredictions);
  assert.equal(digitThreeResult?.predictions, expectedPredictions);
  assert.equal(digitThreeResult?.hits, expectedHits);
});

test('all contract predictions use their matching win rules on subsequent ticks', () => {
  const scenarios = [
    { contract: 'match-digit', digit: 0, lossDigit: 1, signalKey: '0', configuration: {} },
    { contract: 'differ', digit: 0, lossDigit: 9, signalKey: '9', configuration: { targetDigit: 9 } },
    { contract: 'over', digit: 9, lossDigit: 3, signalKey: 'over-3', configuration: { barrier: 3 } },
    { contract: 'under', digit: 0, lossDigit: 6, signalKey: 'under-6', configuration: { barrier: 6 } },
    { contract: 'even-odd', digit: 0, lossDigit: 1, signalKey: 'even', configuration: { parity: 'even' } },
  ] as const;

  for (const { contract, digit, lossDigit, signalKey, configuration } of scenarios) {
    const ticks = createMarket(() => digit);
    const candidates = scanMarkets(
      [{ symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 1 }],
      contract,
      new Map([['R_100', ticks.slice(-10)]]),
      configuration,
    );

    const candidate = candidates.find((item) => item.signalKey === signalKey);
    assert.ok(candidate, `${contract} should return a candidate`);
    assert.equal(candidate.isValidated, true, `${contract} should pass its configured validation`);
    assert.equal(
      isContractWin(contract, candidate.signalKey, candidate.digit, digit),
      true,
      `${contract} should score the subsequent matching digit as a win`,
    );
    assert.equal(
      isContractWin(contract, candidate.signalKey, candidate.digit, lossDigit),
      false,
      `${contract} should score a nonmatching subsequent digit as a loss`,
    );
  }
});

test('walk-forward validation retains but rejects a weak candidate', () => {
  const ticks = createMarket((index) => index % 10);
  const market = { symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 1 };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map([['R_100', ticks.slice(-10)]]),
    { targetDigit: 0 },
  );

  assert.equal(candidates.length, 1);
  assert.ok(candidates.every((candidate) => !candidate.isValidated));
  assert.ok(candidates.every((candidate) => candidate.wilsonLowerBound <= candidate.baselineRate));
});

test('cross-market scan ranks each market candidate instead of hiding unvalidated markets', () => {
  const ticks = createMarket((index) => index % 10);
  const markets = Array.from({ length: 13 }, (_, index) => ({
    symbol: `R_${index + 1}`,
    label: `Volatility ${index + 1} Index`,
    ticks,
    tickVersion: 1,
  }));
  const scanTicks = new Map(markets.map((market) => [market.symbol, ticks.slice(-10)]));
  const candidates = scanMarkets(markets, 'match-digit', scanTicks, { targetDigit: 0 });

  assert.equal(candidates.length, 13);
  assert.ok(candidates.every((candidate) => !candidate.isValidated));
  assert.equal(new Set(candidates.map((candidate) => candidate.symbol)).size, 13);
  assert.ok(candidates.every((candidate) => candidate.digit === 0));
});

test('scan returns an unvalidated prediction when pre-scan history is insufficient', () => {
  const ticks = createMarket(() => 0).slice(-399);
  const market = { symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 1 };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map([['R_100', ticks.slice(-10)]]),
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].isValidated, false);
  assert.equal(candidates[0].backtestPredictions, 277);
});

test('scan returns an unvalidated prediction when no fresh ticks arrived', () => {
  const ticks = createMarket((index) => index % 10);
  const market = { symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 0 };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map(),
    { targetDigit: 3 },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].freshTickCount, 0);
  assert.equal(candidates[0].isValidated, false);
});

test('scan uses fewer than ten fresh ticks to produce a labeled fallback candidate', () => {
  const ticks = createMarket(() => 0);
  const freshTicks = ticks.slice(-2);
  const market = { symbol: 'R_100', label: 'Volatility 100 Index', ticks, tickVersion: 2 };
  const candidates = scanMarkets(
    [market],
    'match-digit',
    new Map([['R_100', freshTicks]]),
    { targetDigit: 0 },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].freshTickCount, 2);
  assert.equal(candidates[0].isValidated, false);
});
