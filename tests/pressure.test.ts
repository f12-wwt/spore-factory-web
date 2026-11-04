import { describe, it, expect } from 'vitest';
import { newRun, CONST } from '../src/systems/RunState';
import { Metab, pressureTier } from '../src/systems/MetabolismSystem';

/**
 * 代谢压力口径（v0.5 bug 修复）：
 * 旧公式 pressure = R / P 只看常驻器官消耗，完全漏掉 BMR（随体积涨）、移动、感知——
 * 于是 HUD 显示 15% 的"健康"，实际 drain 却是 P 的数倍，玩家必然饿死。
 * 正确口径：pressure = totalDrain / P，totalDrain 与实际扣能量逐项一致。
 */
describe('代谢压力口径正确性（回归）', () => {
  it('压力分子等于真实总消耗，不是只算器官常驻', () => {
    const G = newRun();
    G.eraIndex = 2;
    G.player.modules.push('primitive_stomach', 'energy_pool', 'aerogenase', 'primitive_heart');
    Metab.recompute(G);
    const P = G.player;
    const idle = CONST.BMR_BASE + CONST.BMR_PER_VOL * P.bodyVol
      + CONST.SENSE_DRAIN + CONST.SENSE_DRAIN_PER_PERCEPT * P.perceptionTotal
      + P.metab.residentLoad;
    expect(P.totalDrain).toBeCloseTo(idle, 5);
    expect(P.metab.pressure).toBeCloseTo(idle / P.metab.metabolicOutput, 5);
  });

  it('体型变大（BMR 上升）必然推高压力——不能出现「大体型却低压力」', () => {
    const small = newRun();
    Metab.recompute(small);
    const pSmall = small.player.metab.pressure;

    const big = newRun();
    big.eraIndex = 1;
    // 堆体积（躯干类）
    for (let i = 0; i < 6; i++) big.player.modules.push('multicell_agg');
    Metab.recompute(big);
    expect(big.player.bodyVol).toBeGreaterThan(small.player.bodyVol);
    expect(big.player.totalDrain).toBeGreaterThan(small.player.totalDrain);
    expect(big.player.metab.pressure).toBeGreaterThan(pSmall);
  });

  it('移动会推高压力与总消耗（不再隐形）', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    const idleDrain = G.player.totalDrain;
    const idlePress = G.player.metab.pressure;

    // 全速移动 1 秒
    const P = G.player;
    P.vx = CONST.BASE_SPEED;
    P.vy = 0;
    Metab.update(G, 1);
    expect(P.totalDrain).toBeGreaterThan(idleDrain);
    expect(P.metab.pressure).toBeGreaterThan(idlePress);
  });

  it('压力与档位一致：drain > P 时必须进入红色警告', () => {
    const G = newRun();
    G.eraIndex = 2;
    // 塞满高消耗器官，产出跟不上
    for (const id of ['primitive_heart', 'gill', 'primitive_heart', 'aerogenase',
      'aerogenase', 'energy_pool', 'energy_pool', 'primitive_stomach']) {
      G.player.modules.push(id);
    }
    Metab.recompute(G);
    const P = G.player;
    const ratio = P.totalDrain / P.metab.metabolicOutput;
    expect(P.metab.pressure).toBeCloseTo(ratio, 5);
    expect(P.metab.tier).toEqual(pressureTier(ratio));
    if (ratio > 1) expect(P.metab.tier.label).toBe('红色警告');
  });

  it('编辑态与运行期口径一致（编辑器看到的压力≈实际）', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    const P = G.player;
    P.vx = 0; P.vy = 0;
    Metab.update(G, 0.016);
    // 静止时 update 的 totalDrain 应与 recompute 的 idleDrain 一致
    expect(P.totalDrain).toBeCloseTo(
      P.metab.bmr + CONST.SENSE_DRAIN + CONST.SENSE_DRAIN_PER_PERCEPT * P.perceptionTotal + P.metab.residentLoad,
      5,
    );
  });

  it('真正的死局可被察觉：压力>100% 时能量持续下降', () => {
    const G = newRun();
    G.mode = 'playing';
    G.eraIndex = 2;
    for (const id of ['primitive_heart', 'aerogenase', 'aerogenase', 'energy_pool']) {
      G.player.modules.push(id);
    }
    Metab.recompute(G);
    const P = G.player;
    P.metab.currentEnergy = P.metab.maxEnergy;
    P.digestBuffer = 0; // 无食物补充
    const e0 = P.metab.currentEnergy;
    Metab.update(G, 2);
    if (P.metab.pressure > 1) {
      expect(P.metab.currentEnergy).toBeLessThan(e0);
    }
  });
});