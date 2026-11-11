import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAppPreferences } from './app-preferences.ts';

const markets = ['R_100', 'R_75'];

test('restores valid market and toggle preferences', () => {
  assert.deepEqual(
    parseAppPreferences({
      marketSymbol: 'R_75',
      autoScan: false,
      soundAlertsEnabled: true,
    }, markets),
    {
      marketSymbol: 'R_75',
      autoScan: false,
      soundAlertsEnabled: true,
    },
  );
});

test('falls back safely when saved preferences are invalid', () => {
  assert.deepEqual(
    parseAppPreferences({
      marketSymbol: 'not-a-market',
      autoScan: 'yes',
      soundAlertsEnabled: null,
    }, markets),
    {
      marketSymbol: 'R_100',
      autoScan: true,
      soundAlertsEnabled: false,
    },
  );
  assert.equal(parseAppPreferences(null, markets), null);
});
