import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTradeResult,
  isTradingSessionStopped,
} from "../src/lib/trading-session.ts";

test("profit or loss reaching its boundary locks the session against further trades", () => {
  const profitSession = { profit: 8, stopped: false };
  assert.deepEqual(applyTradeResult(profitSession, 2, 10, 5), {
    profit: 10,
    stopped: true,
  });
  assert.equal(isTradingSessionStopped(profitSession, 10, 5), true);

  const lossSession = { profit: -3, stopped: false };
  assert.deepEqual(applyTradeResult(lossSession, -2, 10, 5), {
    profit: -5,
    stopped: true,
  });
  assert.equal(isTradingSessionStopped(lossSession, 10, 5), true);
});

test("a stopped session remains stopped until the session is explicitly reset", () => {
  const session = { profit: 10, stopped: true };
  assert.equal(isTradingSessionStopped(session, 100, 100), true);
  assert.deepEqual(session, { profit: 10, stopped: true });
  assert.equal(isTradingSessionStopped({ profit: 0, stopped: false }, 10, 5), false);
});
