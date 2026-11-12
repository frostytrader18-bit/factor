import type { MartingaleProgress } from "./martingale";

export type TradingSession = {
  profit: number;
  stopped: boolean;
  martingale?: MartingaleProgress;
};

export function isTradingSessionStopped(
  session: TradingSession,
  takeProfit: number,
  stopLoss: number,
): boolean {
  if (session.stopped || session.profit >= takeProfit || session.profit <= -stopLoss) {
    session.stopped = true;
  }
  return session.stopped;
}

export function applyTradeResult(
  session: TradingSession,
  profit: number,
  takeProfit: number,
  stopLoss: number,
): TradingSession {
  session.profit += profit;
  isTradingSessionStopped(session, takeProfit, stopLoss);
  return session;
}
