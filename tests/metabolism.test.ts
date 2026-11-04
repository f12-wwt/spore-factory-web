import { describe, it, expect } from 'vitest';
import { newRun, CONST } from '../src/systems/RunState';
import { Metab } from '../src/systems/MetabolismSystem';
import { World } from '../src/systems/WorldSystem';
import { Logistics } from '../src/systems/LogisticsSystem';
import { DataStore } from '../src/systems/DataStore';

/**
 * 代谢出路（v0.5）：消化与产出都不能走进死路。
 *  1. 胃满 → 溢出即时转化（不再静默丢弃/永久堵塞）
 *  2. 消化速率随吞吐提升（装处理器官 = 胃排空更快）
 *  3. 代谢类器官强化 → 直接提高 P（R 的对冲通路）
 */
describe('消化与代谢出路（v0.5）', () => {
  function seedFood(G: ReturnType<typeof newRun>, nutrition: number): void {
    const food = DataStore.speciesList.find(s => s.type === 'food')!;
    const P = G.player;
    G.ents.push({
      id: 8000 + G.ents.length, kind: 'food', speciesId: food.id,
      x: P.x, y: P.y,
      vx: 0, vy: 0, radius: food.radius,
      hp: 1, hpMax: 1, armor: 0, attack: 0, nutrition, dangerLevel: 0, speed: 0,
      aiState: 'patrol', aiTimer: 0, hitFlash: 0, wobble: 0,
    });
  }

  it('胃满时进食不再丢失营养：溢出转为即时能量', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    // 把胃塞到满
    G.player.digestBuffer = G.player.digestCap;
    G.player.metab.currentEnergy = 0;
    const before = G.player.digestBuffer;
    seedFood(G, 40);
    World.updateEating(G);
    // 缓冲没再增加（已满），但能量确实涨了——营养没有被丢弃
    expect(G.player.digestBuffer).toBeCloseTo(before, 1);
    expect(G.player.metab.currentEnergy).toBeGreaterThan(0);
  });

  it('消化道吞吐越高，消化速率越快（胃排空提速）', () => {
    const G = newRun();
    Metab.recompute(G);
    const rateLow = G.player.digestRate;
    // 装原始胃（process 节点）→ 吞吐与容量双升
    G.player.nodes.push(Logistics.makeNode('n_stomach2', 'primitive_stomach', 400, 120));
    Logistics.autoWire(G.player);
    Metab.recompute(G);
    expect(G.player.digestRate).toBeGreaterThan(rateLow);
    expect(G.player.digestCap).toBeGreaterThan(CONST.BUFFER_BASE);
  });

  it('消化速率实际影响排空速度', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    G.player.digestBuffer = 40;
    const start = G.player.digestBuffer;
    Metab.update(G, 1);
    const drained = start - G.player.digestBuffer;
    expect(drained).toBeGreaterThan(0);
    expect(drained).toBeLessThanOrEqual(G.player.digestRate + 0.001);
  });

  it('代谢类器官强化按百分比提高 P（每级 +12% 乘算）', () => {
    const G = newRun();
    G.eraIndex = 2;
    Metab.recompute(G);
    G.player.modules.push('primitive_stomach', 'energy_pool', 'aerogenase');
    Metab.recompute(G);
    const p0 = G.player.metab.metabolicOutput;
    const up0 = G.player.metaUpTotal;
    expect(up0).toBe(0);

    // 强化 3 个代谢类器官各 2 级 → metaUpTotal = 3 × 2 × 12% = 72%
    for (const id of ['primitive_stomach', 'energy_pool', 'aerogenase']) {
      G.player.modLevels[id] = 3;
    }
    Metab.recompute(G);
    expect(G.player.metaUpTotal).toBeCloseTo(0.72);
    // P 按百分比放大，而非加固定值
    expect(G.player.metab.metabolicOutput).toBeCloseTo(p0 * 1.72, 5);
  });

  it('百分比加成是乘算而非加算（公式级验证）', () => {
    const G = newRun();
    G.eraIndex = 2;
    G.player.modules.push('aerogenase');
    Metab.recompute(G);
    const p0 = G.player.metab.metabolicOutput;

    G.player.modLevels.aerogenase = 3; // +24%
    Metab.recompute(G);
    const p1 = G.player.metab.metabolicOutput;

    // 乘算：p1 = p0 × 1.24；加算会得到 p0 + 0.24
    expect(p1 / p0).toBeCloseTo(1.24, 6);
    expect(p1 - p0).toBeCloseTo(p0 * 0.24, 6);

    // 再加一个代谢器官强化 2 级（+24%）→ 合计 +48%
    G.player.modules.push('primitive_stomach');
    G.player.modLevels.primitive_stomach = 3;
    Metab.recompute(G);
    expect(G.player.metab.metabolicOutput / p0).toBeCloseTo(1.48, 6);
  });

  it('代谢类强化是对冲 R 的可行通路：压力随强化下降', () => {
    const G = newRun();
    G.eraIndex = 2;
    // 装一堆代谢器官把 R 顶上去
    for (const id of ['primitive_stomach', 'energy_pool', 'aerogenase', 'primitive_heart', 'photosynth', 'gill', 'aerogenase']) {
      G.player.modules.push(id);
    }
    Metab.recompute(G);
    const press0 = G.player.metab.pressure;
    for (const id of ['primitive_stomach', 'energy_pool', 'aerogenase']) G.player.modLevels[id] = 5;
    Metab.recompute(G);
    // P 上升 → R/P 下降
    expect(G.player.metab.pressure).toBeLessThan(press0);
  });

  it('非代谢类器官强化不提供 P 加成（边界清晰）', () => {
    const G = newRun();
    G.eraIndex = 2;
    Metab.recompute(G);
    G.player.modules.push('muscle_fiber', 'flagellum');
    G.player.modLevels.muscle_fiber = 5;
    G.player.modLevels.flagellum = 5;
    Metab.recompute(G);
    expect(G.player.metaUpTotal).toBe(0);
  });

  it('消化层装满是可解的：加处理节点 → 容量与速率同时提升', () => {
    const G = newRun();
    Metab.recompute(G);
    const cap0 = G.player.digestCap;
    const rate0 = G.player.digestRate;
    for (let i = 0; i < 3; i++) {
      G.player.nodes.push(Logistics.makeNode(`n_st_${i}`, 'primitive_stomach', 400 + i * 20, 120));
    }
    Logistics.autoWire(G.player);
    Metab.recompute(G);
    expect(G.player.digestCap).toBeGreaterThan(cap0 + 20);
    expect(G.player.digestRate).toBeGreaterThan(rate0);
  });
});