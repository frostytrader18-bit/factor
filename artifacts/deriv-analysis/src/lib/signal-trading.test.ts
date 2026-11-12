import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDerivSignalTrade,
  DEFAULT_SIGNAL_TRADING_SETTINGS,
  hasReachedSessionLimit,
  parseSignalTradingSettings,
} from './signal-trading.ts';

test('trading defaults are disarmed with a single unconfigured martingale value', () => {
  assert.equal(DEFAULT_SIGNAL_TRADING_SETTINGS.armed, false);
  assert.equal(DEFAULT_SIGNAL_TRADING_SETTINGS.martingaleEnabled, false);
  assert.equal(DEFAULT_SIGNAL_TRADING_SETTINGS.martingaleFactor, null);
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
    martingaleFactor: 1000,
  }), null);
});

test('preserves cleared value fields as blank instead of converting them to zero', () => {
  const cleared = {
    ...DEFAULT_SIGNAL_TRADING_SETTINGS,
    stake: null,
    takeProfit: null,
    stopLoss: null,
    martingaleFactor: null,
  };
  assert.deepEqual(parseSignalTradingSettings(cleared), cleared);
});

test('migrates the previous selected strategy factor into the single martingale field', () => {
  const parsed = parseSignalTradingSettings({
    ...DEFAULT_SIGNAL_TRADING_SETTINGS,
    martingaleEnabled: true,
    multiplierLevel: 2,
    multipliers: [2, 3, 4],
  });
  assert.equal(parsed?.martingaleFactor, 3);
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
    martingaleEnabled: true,
    multiplierLevel: 2,
    martingaleFactor: 3,
  });
  assert.equal(trade.stake, 1);
  assert.equal(trade.strategy, 2);
  assert.equal(trade.martingaleFactor, 3);
  assert.equal(trade.marketSymbol, 'R_100');
  assert.equal(trade.digit, 7);
});

test('martingale off always uses the base stake even when a strategy factor is configured', () => {
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
    stake: 2,
    martingaleEnabled: false,
    multiplierLevel: 3,
    martingaleFactor: 8,
  });
  assert.equal(trade.stake, 2);
  assert.equal(trade.martingaleFactor, null);
});

test('session limits stop at configured profit or loss thresholds', () => {
  assert.equal(hasReachedSessionLimit(10, 10, 5), true);
  assert.equal(hasReachedSessionLimit(-5, 10, 5), true);
  assert.equal(hasReachedSessionLimit(0, 10, 5), false);
});
