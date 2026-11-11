import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPredictionTick,
  calculateExpectedValue,
  parsePerformanceHistory,
  summarizePerformance,
  type PredictionOutcomeRecord,
} from './performance.ts';

function createOutcome(
  overrides: Partial<PredictionOutcomeRecord> = {},
): PredictionOutcomeRecord {
  return {
    id: 'outcome-1',
    engineId: 'matches-differs',
    contractType: 'match-digit',
    signalKey: '4',
    signalLabel: 'MATCH 4',
    digit: 4,
    marketSymbol: 'R_100',
    marketLabel: 'Volatility 100 Index',
    startedAt: 1,
    expiresAt: 30,
    targetTickOffset: 0,
    baselineRate: 0.1,
    backtestHits: 80,
    backtestPredictions: 100,
    backtestAccuracy: 0.8,
    estimatedProbability: 0.8,
    wilsonLowerBound: 0.7,
    wilsonUpperBound: 0.9,
    expectedValue: null,
    wins: 3,
    losses: 1,
    observedTicks: 4,
    pendingTicks: 0,
    squaredProbabilityError: 0.4,
    status: 'complete',
    ...overrides,
  };
}

test('performance is grouped per engine, market, and contract with accuracy and calibration', () => {
  const summaries = summarizePerformance([
    createOutcome(),
    createOutcome({ id: 'outcome-2', wins: 1, losses: 3, observedTicks: 4 }),
    createOutcome({
      id: 'outcome-3',
      engineId: 'even-odd',
      marketSymbol: 'R_75',
      marketLabel: 'Volatility 75 Index',
      contractType: 'even-odd',
      signalKey: 'even',
      signalLabel: 'EVEN',
      digit: null,
      baselineRate: 0.5,
      wins: 0,
      losses: 0,
      observedTicks: 0,
    }),
  ]);

  assert.equal(summaries.length, 2);
  const r100 = summaries.find((summary) => summary.marketSymbol === 'R_100');
  assert.equal(r100?.signalCount, 2);
  assert.equal(r100?.observedTicks, 8);
  assert.equal(r100?.wins, 4);
  assert.equal(r100?.losses, 4);
  assert.equal(r100?.accuracy, 0.5);
  assert.equal(r100?.brierScore, 0.1);
  assert.equal(r100?.expectedValue, null);

  const r75 = summaries.find((summary) => summary.marketSymbol === 'R_75');
  assert.equal(r75?.accuracy, null);
  assert.equal(r75?.brierScore, null);
});

test('MATCHES tracks every tick after the three-tick execution delay', () => {
  let outcome = createOutcome({
    targetTickOffset: 3,
    wins: 0,
    losses: 0,
    observedTicks: 0,
    pendingTicks: 0,
    squaredProbabilityError: 0,
    estimatedProbability: 0.2,
    signalKey: '8',
    signalLabel: 'MATCH 8',
    digit: 8,
    status: 'tracking',
  });

  const firstTick = applyPredictionTick(outcome, 1);
  outcome = firstTick.outcome;
  assert.equal(firstTick.recorded, false);
  assert.equal(outcome.pendingTicks, 1);
  assert.equal(outcome.observedTicks, 0);

  const secondTick = applyPredictionTick(outcome, 8);
  outcome = secondTick.outcome;
  assert.equal(secondTick.recorded, false);
  assert.equal(outcome.pendingTicks, 2);
  assert.equal(outcome.observedTicks, 0);

  const thirdTick = applyPredictionTick(outcome, 8);
  outcome = thirdTick.outcome;
  assert.equal(thirdTick.recorded, true);
  assert.equal(outcome.wins, 1);
  assert.equal(outcome.losses, 0);
  assert.equal(outcome.observedTicks, 1);
  assert.equal(outcome.status, 'tracking');

  const fourthTick = applyPredictionTick(outcome, 4);
  outcome = fourthTick.outcome;
  assert.equal(fourthTick.recorded, true);
  assert.equal(outcome.wins, 1);
  assert.equal(outcome.losses, 1);
  assert.equal(outcome.observedTicks, 2);
  assert.equal(outcome.pendingTicks, 3);
  assert.equal(outcome.status, 'tracking');

  for (let tick = 0; tick < 26; tick += 1) {
    outcome = applyPredictionTick(outcome, tick % 2 === 0 ? 8 : 4).outcome;
  }
  assert.equal(outcome.observedTicks, 28);
  assert.equal(outcome.status, 'tracking');
});

test('predictions without an execution delay record every tick while tracking', () => {
  const outcome = createOutcome({
    targetTickOffset: 0,
    wins: 0,
    losses: 0,
    observedTicks: 0,
    pendingTicks: 0,
    squaredProbabilityError: 0,
    status: 'tracking',
  });

  const firstTick = applyPredictionTick(outcome, 4);
  assert.equal(firstTick.recorded, true);
  assert.equal(firstTick.outcome.observedTicks, 1);
  assert.equal(firstTick.outcome.status, 'tracking');

  const secondTick = applyPredictionTick(firstTick.outcome, 2);
  assert.equal(secondTick.recorded, true);
  assert.equal(secondTick.outcome.observedTicks, 2);
  assert.equal(secondTick.outcome.status, 'tracking');
});

test('expected value is unavailable without an actual proposal payout', () => {
  assert.equal(calculateExpectedValue(0.7, null, null), null);
  assert.ok(Math.abs((calculateExpectedValue(0.7, 1, 0.8) ?? 0) - 0.26) < 1e-12);
  assert.equal(calculateExpectedValue(1.1, 1, 0.8), null);
});

test('persisted tracking records are recovered as interrupted and invalid records are skipped', () => {
  const tracking = createOutcome({ id: 'in-progress', status: 'tracking' });
  const restored = parsePerformanceHistory([tracking, { id: 'invalid' }]);

  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, 'interrupted');
});

test('legacy saved outcomes retain their market history and receive a migration estimate', () => {
  const legacy = createOutcome({ id: 'legacy' });
  const {
    engineId: _engineId,
    estimatedProbability: _estimatedProbability,
    wilsonUpperBound: _wilsonUpperBound,
    squaredProbabilityError: _squaredProbabilityError,
    ...oldRecord
  } = legacy;
  const migrated = parsePerformanceHistory([oldRecord]);

  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].engineId, 'matches-differs');
  assert.equal(migrated[0].estimatedProbability, legacy.backtestAccuracy);
  assert.ok(Math.abs(migrated[0].squaredProbabilityError - 0.76) < 1e-12);
});
