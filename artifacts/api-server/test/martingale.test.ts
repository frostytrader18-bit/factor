import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMartingaleResult,
  getMartingaleProgress,
  getMartingaleStake,
  type MartingaleConfiguration,
} from "../src/lib/martingale.ts";

const classic: MartingaleConfiguration = {
  enabled: true,
  strategy: 1,
  factor: 2,
  baseStake: 1,
};

function settle(
  strategy: MartingaleConfiguration,
  profits: number[],
  stakes = [1, 1, 1, 1, 1],
) {
  let progress = getMartingaleProgress(undefined, strategy);
  const results: number[] = [];
  profits.forEach((profit, index) => {
    const stake = getMartingaleStake(progress);
    results.push(stake);
    progress = applyMartingaleResult(progress, strategy, stake, profit);
  });
  return { results, progress };
}

test("classic multiplies after each loss and resets to base after a win", () => {
  const { results } = settle(classic, [-1, -2, 4, 1]);
  assert.deepEqual(results, [1, 2, 4, 1]);
});

test("dynamic repeats base after a loss, applies one boost after recovery, then resets", () => {
  const { results } = settle({ ...classic, strategy: 2 }, [-1, 1, 2, -1, 1, 2]);
  assert.deepEqual(results, [1, 1, 2, 1, 1, 2]);
});

test("dynamic hybrid keeps base for one recovery win then holds the multiplied stake until prior losses are earned back", () => {
  const { results, progress } = settle(
    { ...classic, strategy: 3 },
    [-1, 0.4, 0.5, -2, 3.1, 1],
  );
  assert.deepEqual(results, [1, 1, 2, 2, 2, 1]);
  assert.equal(progress.unrecoveredLoss, 0);
  assert.equal(progress.hybridPhase, "flat");
});

test("dynamic hybrid does not start multiplied recovery after a break-even recovery trade", () => {
  const { results, progress } = settle(
    { ...classic, strategy: 3 },
    [-1, 0, 0.4],
  );
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(progress.hybridPhase, "recovery");
  assert.equal(getMartingaleStake(progress), 2);
});

test("martingale disabled always uses base stake and clears progression", () => {
  const enabled = getMartingaleProgress(undefined, classic);
  const afterLoss = applyMartingaleResult(enabled, classic, 1, -1);
  assert.equal(getMartingaleStake(afterLoss), 2);

  const disabled = { ...classic, enabled: false };
  const reset = getMartingaleProgress(afterLoss, disabled);
  assert.equal(getMartingaleStake(reset), 1);
  assert.equal(applyMartingaleResult(reset, disabled, 1, -1).nextStake, 1);
});

test("changing martingale configuration starts a fresh progression", () => {
  const progress = getMartingaleProgress(undefined, classic);
  const afterLoss = applyMartingaleResult(progress, classic, 1, -1);
  const changed = getMartingaleProgress(afterLoss, { ...classic, factor: 3 });
  assert.equal(getMartingaleStake(changed), 1);
});
