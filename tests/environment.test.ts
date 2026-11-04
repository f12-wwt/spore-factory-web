import { describe, it, expect } from 'vitest';
import { newRun } from '../src/systems/RunState';
import { Env } from '../src/systems/EnvironmentSystem';
import { DataStore } from '../src/systems/DataStore';

/** 环境分区系统（v0.7） */
describe('环境分区', () => {
  it('每个纪元至少 2 个环境区域', () => {
    for (let i = 0; i < 3; i++) {
      expect(DataStore.zonesForEra(i).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('区域坐标在 0~1 范围内', () => {
    for (const z of DataStore.zones) {
      expect(z.x).toBeGreaterThanOrEqual(0);
      expect(z.x).toBeLessThanOrEqual(1);
      expect(z.y).toBeGreaterThanOrEqual(0);
      expect(z.y).toBeLessThanOrEqual(1);
    }
  });

  it('开放水域（远离所有区域）返回中性环境', () => {
    const G = newRun();
    // 放在世界顶部中央（远离任何区域中心）
    G.player.x = G.world.w * 0.5;
    G.player.y = 50;
    const env = Env.compute(G);
    expect(env.zone).toBeNull();
    expect(env.bmrMult).toBe(1);
    expect(env.outputMult).toBe(1);
    expect(env.toxicDps).toBe(0);
    expect(env.visionMult).toBe(1);
  });

  it('进入热泉区：BMR 提升、产出下降', () => {
    const G = newRun();
    const vent = DataStore.zonesForEra(0).find(z => z.id === 'vent_field')!;
    G.player.x = vent.x * G.world.w;
    G.player.y = vent.y * G.world.h;
    const env = Env.compute(G);
    expect(env.zone?.id).toBe('vent_field');
    expect(env.bmrMult).toBeGreaterThan(1);
    expect(env.outputMult).toBeLessThan(1);
  });

  it('进入冷泉区：BMR 降低', () => {
    const G = newRun();
    const seep = DataStore.zonesForEra(0).find(z => z.id === 'cold_seep')!;
    G.player.x = seep.x * G.world.w;
    G.player.y = seep.y * G.world.h;
    const env = Env.compute(G);
    expect(env.zone?.id).toBe('cold_seep');
    expect(env.bmrMult).toBeLessThan(1);
  });

  it('毒性区域：有氧酶中和 70%', () => {
    const G = newRun();
    const deep = DataStore.zonesForEra(1).find(z => z.id === 'sulfur_deep')!;
    G.player.x = deep.x * G.world.w;
    G.player.y = deep.y * G.world.h;
    // 无有氧酶：完整毒性
    let env = Env.compute(G);
    const fullToxic = env.toxicDps;
    expect(fullToxic).toBeGreaterThan(0);
    // 装有氧酶：毒性降到 30%
    G.player.modules.push('aerogenase');
    env = Env.compute(G);
    expect(env.toxicDps).toBeCloseTo(fullToxic * 0.3, 5);
  });

  it('边界软过渡：区域边缘效果减弱', () => {
    const G = newRun();
    const vent = DataStore.zonesForEra(0).find(z => z.id === 'vent_field')!;
    const zx = vent.x * G.world.w, zy = vent.y * G.world.h;
    // 中心：完整效果
    G.player.x = zx; G.player.y = zy;
    const center = Env.compute(G);
    // 边缘（radius × 0.95 处）：部分效果
    const edgeD = vent.radius * 0.95;
    G.player.x = zx + edgeD; G.player.y = zy;
    const edge = Env.compute(G);
    // 边缘效果弱于中心
    expect(Math.abs(edge.bmrMult - 1)).toBeLessThan(Math.abs(center.bmrMult - 1));
  });

  it('多个区域重叠时取效果最强的', () => {
    const G = newRun();
    const vent = DataStore.zonesForEra(0).find(z => z.id === 'vent_field')!;
    // 放在 vent 中心：zone 应为 vent_field
    G.player.x = vent.x * G.world.w;
    G.player.y = vent.y * G.world.h;
    const env = Env.compute(G);
    expect(env.zone?.id).toBe('vent_field');
  });

  it('每个区域 mods 至少声明一项', () => {
    for (const z of DataStore.zones) {
      expect(Object.keys(z.mods).length).toBeGreaterThan(0);
    }
  });

  it('区域描述非空', () => {
    for (const z of DataStore.zones) {
      expect(z.desc.length).toBeGreaterThan(5);
    }
  });
});