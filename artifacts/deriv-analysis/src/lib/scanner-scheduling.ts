export type AutomaticScanState = {
  autoScan: boolean;
  feedLive: boolean;
  readyMarkets: number;
  isAnalyzing: boolean;
  tradingArmed: boolean;
  tradingBusy: boolean;
  predictionActive: boolean;
};

export function shouldScheduleAutomaticScan(state: AutomaticScanState): boolean {
  return state.autoScan
    && state.feedLive
    && state.readyMarkets > 0
    && !state.isAnalyzing
    && (state.tradingArmed ? !state.tradingBusy : !state.predictionActive);
}
