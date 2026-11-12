export type MartingaleStrategy = 1 | 2 | 3;

export type MartingaleConfiguration = {
  enabled: boolean;
  strategy: MartingaleStrategy;
  factor: number | null;
  baseStake: number;
};

export type MartingaleProgress = {
  signature: string;
  nextStake: number;
  dynamicPhase: "flat" | "recovery" | "boost";
  hybridPhase: "flat" | "same-stake" | "recovery";
  unrecoveredLoss: number;
};

export function getMartingaleProgress(
  progress: MartingaleProgress | undefined,
  configuration: MartingaleConfiguration,
): MartingaleProgress {
  const signature = JSON.stringify(configuration);
  if (progress?.signature === signature) return progress;
  return {
    signature,
    nextStake: configuration.baseStake,
    dynamicPhase: "flat",
    hybridPhase: "flat",
    unrecoveredLoss: 0,
  };
}

export function getMartingaleStake(progress: MartingaleProgress): number {
  return progress.nextStake;
}

export function applyMartingaleResult(
  progress: MartingaleProgress,
  configuration: MartingaleConfiguration,
  currentStake: number,
  profit: number,
): MartingaleProgress {
  const baseStake = configuration.baseStake;
  const factor = configuration.factor ?? 1;
  let nextStake = baseStake;
  let dynamicPhase = progress.dynamicPhase;
  let hybridPhase = progress.hybridPhase;
  let unrecoveredLoss = progress.unrecoveredLoss;

  if (!configuration.enabled) {
    return {
      ...progress,
      nextStake: baseStake,
      dynamicPhase: "flat",
      hybridPhase: "flat",
      unrecoveredLoss: 0,
    };
  }

  if (configuration.strategy === 1) {
    nextStake = profit < 0
      ? currentStake * factor
      : baseStake;
  } else if (configuration.strategy === 2) {
    if (dynamicPhase === "flat") {
      dynamicPhase = profit < 0 ? "recovery" : "flat";
      nextStake = baseStake;
    } else if (dynamicPhase === "recovery") {
      if (profit > 0) {
        dynamicPhase = "boost";
        nextStake = baseStake * factor;
      } else {
        nextStake = baseStake;
      }
    } else {
      dynamicPhase = profit < 0 ? "recovery" : "flat";
      nextStake = baseStake;
    }
  } else if (hybridPhase === "flat") {
    if (profit < 0) {
      unrecoveredLoss = -profit;
      hybridPhase = "same-stake";
    }
    nextStake = baseStake;
  } else if (hybridPhase === "same-stake") {
    if (profit > 0) {
      unrecoveredLoss = Math.max(0, unrecoveredLoss - profit);
      hybridPhase = unrecoveredLoss > 0 ? "recovery" : "flat";
      nextStake = unrecoveredLoss > 0 ? baseStake * factor : baseStake;
    } else {
      if (profit < 0) unrecoveredLoss += -profit;
      nextStake = baseStake;
    }
  } else {
    if (profit < 0) {
      unrecoveredLoss += -profit;
    } else {
      unrecoveredLoss = Math.max(0, unrecoveredLoss - profit);
    }
    if (unrecoveredLoss === 0) {
      hybridPhase = "flat";
      nextStake = baseStake;
    } else {
      nextStake = baseStake * factor;
    }
  }

  return {
    ...progress,
    nextStake,
    dynamicPhase,
    hybridPhase,
    unrecoveredLoss,
  };
}
