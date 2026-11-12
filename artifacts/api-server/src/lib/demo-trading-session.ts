export type DemoTradingSession = {
  profit: number;
  stopped: boolean;
};

export function isDemoTradingSessionStopped(
  session: DemoTradingSession,
  takeProfit: number,
  stopLoss: number,
): boolean {
  if (session.stopped || session.profit >= takeProfit || session.profit <= -stopLoss) {
    session.stopped = true;
  }
  return session.stopped;
}

export function applyDemoTradeResult(
  session: DemoTradingSession,
  profit: number,
  takeProfit: number,
  stopLoss: number,
): DemoTradingSession {
  session.profit += profit;
  isDemoTradingSessionStopped(session, takeProfit, stopLoss);
  return session;
}
