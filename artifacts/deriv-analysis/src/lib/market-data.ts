export type QuoteDetails = {
  price: string;
  lastDigit: number;
};

export type TimestampedTick = QuoteDetails & {
  epoch: number;
  symbol: string;
};

const MAX_LIVE_TICK_AGE_SECONDS = 300;

export function isValidTickEpoch(epoch: number, nowSeconds = Date.now() / 1000): boolean {
  return Number.isSafeInteger(epoch)
    && epoch >= 0
    && epoch <= nowSeconds + 5
    && nowSeconds - epoch <= MAX_LIVE_TICK_AGE_SECONDS;
}

export function isValidPipSize(pipSize: number): boolean {
  return Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 10;
}

function expandScientificNotation(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return null;

  const sign = match[1];
  const whole = match[2];
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;

  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  if (decimalPosition <= 0) {
    return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

export function getQuoteDetails(
  quote: string | number,
  pipSize: number,
): QuoteDetails | null {
  if (!isValidPipSize(pipSize)) {
    return null;
  }
  if (typeof quote === 'number' && !Number.isFinite(quote)) {
    return null;
  }

  const expanded = expandScientificNotation(String(quote).trim());
  if (!expanded) return null;

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(expanded);
  if (!match) return null;

  const fraction = match[3] ?? '';
  const discardedDigits = fraction.slice(pipSize);
  if (/[1-9]/.test(discardedDigits)) {
    return null;
  }

  const normalizedFraction = fraction.slice(0, pipSize).padEnd(pipSize, '0');
  const price = `${match[1]}${match[2]}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
  const lastDigit = Number(price.at(-1));
  return Number.isInteger(lastDigit) ? { price, lastDigit } : null;
}

export function parseTickHistory(
  prices: readonly (string | number)[],
  pipSize: number,
): QuoteDetails[] | null {
  if (!isValidPipSize(pipSize) || prices.length === 0) return null;
  const parsed = prices.map((price) => getQuoteDetails(price, pipSize));
  if (parsed.some((quote) => quote === null)) return null;
  return parsed.filter((quote): quote is QuoteDetails => quote !== null);
}

export function parseTimestampedTickHistory(
  prices: readonly (string | number)[],
  times: readonly number[],
  pipSize: number,
  symbol: string,
  nowSeconds = Date.now() / 1000,
): TimestampedTick[] | null {
  if (!symbol || prices.length === 0 || prices.length !== times.length) return null;
  if (!isValidTickEpoch(times.at(-1)!, nowSeconds)) return null;
  const parsed = parseTickHistory(prices, pipSize);
  if (!parsed) return null;

  const ticks: TimestampedTick[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const epoch = times[index];
    if (!Number.isSafeInteger(epoch) || epoch < 0
      || (index > 0 && epoch <= times[index - 1])) {
      return null;
    }
    ticks.push({ ...parsed[index], epoch, symbol });
  }
  return ticks;
}

export function parseTimestampedTick(
  quote: string | number,
  pipSize: number,
  epoch: number,
  symbol: string,
  previousEpoch?: number,
): TimestampedTick | null {
  if (!symbol || !isValidTickEpoch(epoch)
    || (previousEpoch !== undefined && epoch <= previousEpoch)) {
    return null;
  }
  const details = getQuoteDetails(quote, pipSize);
  return details ? { ...details, epoch, symbol } : null;
}
