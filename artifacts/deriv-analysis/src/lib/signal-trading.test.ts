import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDerivSignalTrade,
  DEFAULT_SIGNAL_TRADING_SETTINGS,
  hasReachedSessionLimit,
  parseSignalTradingSettings,
} from './signal-trading.ts';

test('trading defaults are disarmed with three unconfigured multiplier levels', () => {
  assert.equal(DEFAULT_SIGNAL_TRADING_SETTINGS.armed, false);
  assert.deepEqual(DEFAULT_SIGNAL_TRADING_SETTINGS.multipliers, [null, null, null]);
});

test('parses valid settings and falls back by rejecting malformed or unsafe values', () => {
  assert.deepEqual(
    parseSignalTradingSettings(DEFAULT_SIGNAL_TRADING_SETTINGS),
    DEFAULT_SIGNAL_TRADING_SETTINGS,
  );
  assert.equal(parseSignalTradingSettings({
    ...DEFAULT_SIGNAL_TRADING_SETTINGS,
    stake: -1,
  }), null);
  assert.equal(parseSignalTradingSettings({
    ...DEFAULT_SIGNAL_TRADING_SETTINGS,
    multipliers: [1, 1000, null],
  }), null);
});

test('preserves cleared value fields as blank instead of converting them to zero', () => {
  const cleared = {
    ...DEFAULT_SIGNAL_TRADING_SETTINGS,
    stake: null,
    takeProfit: null,
    stopLoss: null,
    multipliers: [null, null, null] as [null, null, null],
  };
  assert.deepEqual(parseSignalTradingSettings(cleared), cleared);
});

test('builds a Deriv trade with the selected multiplier and signal parameters', () => {
  const trade = createDerivSignalTrade({
    id: 'signal-1',
    engineId: 'matches-differs',
    contractType: 'match-digit',
    signalKey: '7',
    signalLabel: 'MATCH 7',
    digit: 7,
    marketSymbol: 'R_100',
    marketLabel: 'Volatility 100',
    startedAt: 1,
    expiresAt: 2,
    targetTickOffset: 3,
    baselineRate: 0.1,
    backtestHits: 0,
    backtestPredictions: 0,
    backtestAccuracy: 0,
    estimatedProbability: 0.1,
    wilsonLowerBound: 0,
    wilsonUpperBound: 1,
    expectedValue: null,
  }, {
    ...DEFAULT_SIGNAL_TRADING_SETTINGS,
    multiplierLevel: 2,
    multipliers: [null, 3, null],
  });
  assert.equal(trade.stake, 3);
  assert.equal(trade.multiplier, 3);
  assert.equal(trade.marketSymbol, 'R_100');
  assert.equal(trade.digit, 7);
});

test('session limits stop at configured profit or loss thresholds', () => {
  assert.equal(hasReachedSessionLimit(10, 10, 5), true);
  assert.equal(hasReachedSessionLimit(-5, 10, 5), true);
  assert.equal(hasReachedSessionLimit(0, 10, 5), false);
});
