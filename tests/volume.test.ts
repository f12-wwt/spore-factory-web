import { describe, it, expect } from 'vitest';
import { newRun } from '../src/systems/RunState';
import { Metab } from '../src/systems/MetabolismSystem';
import { DataStore } from '../src/systems/DataStore';

/** 体积机制（v0.4）：体积=已安装器官（不随时间变化）；上限=纪元上限 + 强化/进化提升
 *  v0.5：起始形态改为草履虫级先天器官（细胞质/细胞膜/细胞核/口沟/胞肛）= 10/14，留 4 点改造空间 */
describe('体积机制（v0.4/v0.5）', () => {
  it('初始 10/14：草履虫级先天器官，留 4 点改造空间', () => {
    const G = newRun();
    Metab.recompute(G);
    expect(G.player.bodyVol).toBe(10);
    expect(Metab.volumeCap(G)).toBe(14);
    expect(G.player.maxVolumeBonus).toBe(0);
  });

  it('进食溢出只进生长储备，不增加生长体积/体积', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    const m = G.player.metab;
    m.currentEnergy = m.maxEnergy;   // 满能量 → 消化全部转溢出
    G.player.digestBuffer = 20;
    Metab.update(G, 1);
    expect(m.growthReserve).toBeGreaterThan(0); // 储备照常积累（器官购置金）
    expect(G.player.growthVol).toBe(0);         // 生长体积不再增长
    expect(G.player.bodyVol).toBe(10);          // 体积不随时间/进食变化
  });

  it('防御类强化提升体积上限：每级 +1（细胞壁 Lv3 = +2）', () => {
    const G = newRun();
    G.eraIndex = 1;
    G.player.modules.push('cell_wall');
    G.player.modLevels.cell_wall = 3;
    Metab.recompute(G);
    expect(G.player.maxVolumeBonus).toBe(2);
    expect(Metab.volumeCap(G)).toBe(DataStore.era(1).volumeMax + 2); // 26 + 2
    expect(G.player.bodyVol).toBeLessThanOrEqual(Metab.volumeCap(G));
  });

  it('躯干类（细胞质/储能颗粒）强化同样扩仓', () => {
    const G = newRun();
    G.player.modLevels.cytoplasm = 4; // 躯干 Lv4 → +3
    Metab.recompute(G);
    expect(G.player.maxVolumeBonus).toBe(3);
    expect(Metab.volumeCap(G)).toBe(17);
  });

  it('非防御/躯干类强化不提升上限（鞭毛 Lv5 → +0）', () => {
    const G = newRun();
    G.player.modules.push('flagellum');
    G.player.modLevels.flagellum = 5;
    Metab.recompute(G);
    expect(G.player.maxVolumeBonus).toBe(0);
    expect(Metab.volumeCap(G)).toBe(14);
  });

  it('卸载强化器官后上限回落（强化等级清除 → 加成归零）', () => {
    const G = newRun();
    G.eraIndex = 1;
    G.player.modules.push('cell_wall');
    G.player.modLevels.cell_wall = 5;
    Metab.recompute(G);
    expect(G.player.maxVolumeBonus).toBe(4);
    // 卸载最后一个同类 → 清除强化等级（编辑器 removeOne 语义）
    G.player.modules = G.player.modules.filter(id => id !== 'cell_wall');
    delete G.player.modLevels.cell_wall;
    Metab.recompute(G);
    expect(G.player.maxVolumeBonus).toBe(0);
  });

  it('进化跳档提升上限：太古宙 14 → 元古宙 26 → 寒武纪 60', () => {
    const G = newRun();
    Metab.recompute(G);
    expect(Metab.volumeCap(G)).toBe(14);
    G.eraIndex = 1;
    Metab.recompute(G);
    expect(Metab.volumeCap(G)).toBe(26);
    G.eraIndex = 2;
    Metab.recompute(G);
    expect(Metab.volumeCap(G)).toBe(60);
  });
});
