import { describe, it } from 'vitest';
import { report, difficultyReport, economyReport, profileAll } from "../src/systems/BalanceProbe";

// 仅在显式运行时打印（PROBE_VERBOSE=1 npx vitest run tests/probe.test.ts），
// 避免 npm test 全量运行时污染输出
const VERBOSE = (globalThis as Record<string, unknown>).process !== undefined
  && (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PROBE_VERBOSE === '1';

describe("probe", () => {
  it("report", () => {
    if (VERBOSE) {
      console.log(report(profileAll()));
      console.log(economyReport());
      console.log(difficultyReport());
    }
  });
});
