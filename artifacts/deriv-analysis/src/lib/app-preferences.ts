export interface AppPreferences {
  marketSymbol: string;
  autoScan: boolean;
  soundAlertsEnabled: boolean;
}

export function parseAppPreferences(
  value: unknown,
  availableMarketSymbols: readonly string[],
): AppPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const parsed = value as Record<string, unknown>;
  return {
    marketSymbol: typeof parsed.marketSymbol === 'string'
      && availableMarketSymbols.includes(parsed.marketSymbol)
      ? parsed.marketSymbol
      : availableMarketSymbols[0] ?? '',
    autoScan: typeof parsed.autoScan === 'boolean' ? parsed.autoScan : true,
    soundAlertsEnabled: typeof parsed.soundAlertsEnabled === 'boolean'
      ? parsed.soundAlertsEnabled
      : false,
  };
}
