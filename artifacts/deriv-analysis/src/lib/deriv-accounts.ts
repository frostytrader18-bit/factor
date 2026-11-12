export type DerivAccountType = 'demo' | 'real';

export type DerivAccountBalance = {
  accountId: string;
  accountType: DerivAccountType;
  balance: number;
  currency: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseDerivAccountBalances(value: unknown): DerivAccountBalance[] {
  if (!isRecord(value) || !Array.isArray(value.accounts)) {
    throw new Error('Deriv account response did not contain balances.');
  }

  const accounts: DerivAccountBalance[] = [];
  for (const account of value.accounts) {
    if (!isRecord(account)) {
      continue;
    }

    const status = account.status;
    if (status === 'inactive') {
      continue;
    }
    if (status !== undefined && status !== 'active') {
      continue;
    }

    const accountId = account.accountId ?? account.account_id;
    const rawType = account.accountType ?? account.account_type;
    const accountType = rawType === 'demo' || rawType === 'real'
      ? rawType
      : typeof account.is_virtual === 'boolean'
        ? account.is_virtual ? 'demo' : 'real'
        : null;
    const rawBalance = account.balance;
    const balance = typeof rawBalance === 'number'
      ? rawBalance
      : typeof rawBalance === 'string' && rawBalance.trim() !== ''
        ? Number(rawBalance)
        : Number.NaN;
    const currency = account.currency;

    if (
      typeof accountId !== 'string'
      || accountId.length === 0
      || accountId.length > 64
      || accountType === null
      || !Number.isFinite(balance)
      || balance < 0
      || typeof currency !== 'string'
      || currency.length > 20
    ) {
      continue;
    }

    accounts.push({ accountId, accountType, balance, currency });
  }

  if (value.accounts.length > 0 && accounts.length === 0) {
    throw new Error('Deriv account response contained no usable account balances.');
  }
  return accounts;
}
