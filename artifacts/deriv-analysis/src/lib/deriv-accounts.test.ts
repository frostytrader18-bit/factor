import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultDerivAccountId, parseDerivAccountBalances } from './deriv-accounts.ts';

test('parses demo and real balances and skips inactive accounts', () => {
  assert.deepEqual(parseDerivAccountBalances({
    accounts: [
      { account_id: 'CR100', account_type: 'demo', balance: 10000, currency: 'USD', status: 'active' },
      { account_id: 'CR200', account_type: 'real', balance: 250.5, currency: 'EUR', status: 'active' },
      { account_id: 'CR300', account_type: 'real', balance: 0, currency: 'USD', status: 'inactive' },
    ],
  }), [
    { accountId: 'CR100', accountType: 'demo', balance: 10000, currency: 'USD' },
    { accountId: 'CR200', accountType: 'real', balance: 250.5, currency: 'EUR' },
  ]);
});

test('accepts camel-case account IDs and numeric balance strings', () => {
  assert.deepEqual(parseDerivAccountBalances({
    accounts: [
      { accountId: 'CR100', accountType: 'demo', balance: '10000.25', currency: 'USD' },
    ],
  }), [
    { accountId: 'CR100', accountType: 'demo', balance: 10000.25, currency: 'USD' },
  ]);
});

test("defaults to Deriv's first returned account instead of silently preferring real", () => {
  assert.equal(getDefaultDerivAccountId([
    { accountId: 'CR-DEMO', accountType: 'demo', balance: 10000, currency: 'USD' },
    { accountId: 'CR-REAL', accountType: 'real', balance: 250, currency: 'USD' },
  ]), 'CR-DEMO');
  assert.equal(getDefaultDerivAccountId([]), '');
});

test('rejects unusable account data and accepts an empty account list', () => {
  assert.throws(() => parseDerivAccountBalances({ accounts: [{ account_type: 'demo' }] }));
  assert.deepEqual(parseDerivAccountBalances({ accounts: [] }), []);
  assert.throws(() => parseDerivAccountBalances({}));
});
