import { describe, it, expect } from 'vitest';
import { newRun, playerRadius, CONST } from '../src/systems/RunState';
import { Metab } from '../src/systems/MetabolismSystem';
import { World } from '../src/systems/WorldSystem';
import { Combat } from '../src/systems/CombatSystem';
import { DataStore } from '../src/systems/DataStore';

/**
 * 交互半径一致性（v0.5 bug 修复）：
 * 进食/撕咬判定曾用硬编码小常数（reach*0.4 / +14），
 * 而绘制半径是 10+√vol*2.2 —— 于是"看起来吃到了却没吃到"。
 * 规则：任何接触判定都必须 ≥ 玩家可见体型。
 */
describe('接触判定覆盖可见体型（回归）', () => {
  /** 把一个食物放到玩家可见边缘（刚好比可见半径多 1px） */
  function foodAtEdge(G: ReturnType<typeof newRun>): void {
    const P = G.player;
    const food = DataStore.speciesList.find(s => s.type === 'food')!;
    const r = playerRadius(P.bodyVol);
    G.ents.push({
      id: 9999, kind: 'food', speciesId: food.id,
      x: P.x + r + food.radius + 1, y: P.y,
      vx: 0, vy: 0, radius: food.radius,
      hp: 1, hpMax: 1, armor: 0, attack: 0, nutrition: 20, dangerLevel: 0, speed: 0,
      aiState: 'patrol', aiTimer: 0, hitFlash: 0, wobble: 0,
    });
  }

  it('视觉上贴脸的食物一定被吃到（起始形态）', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    const before = G.player.digestBuffer;
    foodAtEdge(G);
    World.updateEating(G);
    expect(G.player.digestBuffer).toBeGreaterThan(before);
  });

  it('视觉上贴脸的蛋白质一定被拾取', () => {
    const G = newRun();
    G.mode = 'playing';
    Metab.recompute(G);
    const eBefore = G.player.metab.currentEnergy;
    const P = G.player;
    const r = playerRadius(P.bodyVol);
    G.ents.push({
      id: 9998, kind: 'protein', speciesId: DataStore.speciesList[0].id,
      x: P.x + r + 4 + 1, y: P.y,
      vx: 0, vy: 0, radius: 4,
      hp: 1, hpMax: 1, armor: 0, attack: 0, nutrition: 10, dangerLevel: 0, speed: 0,
      aiState: 'patrol', aiTimer: 0, hitFlash: 0, wobble: 0,
    });
    World.updateEating(G);
    expect(G.player.metab.currentEnergy).toBeGreaterThan(eBefore);
  });

  it('体型变大后接触判定随之扩大（不再需要改多处常数）', () => {
    const G = newRun();
    G.mode = 'playing';
    G.player.modules.push('multicell_agg', 'multicell_agg');
    G.player.modLevels.multicell_agg = 3;
    G.eraIndex = 1;
    Metab.recompute(G);
    const r = playerRadius(G.player.bodyVol);
    expect(r).toBeGreaterThan(playerRadius(10));

    const P = G.player;
    G.ents.push({
      id: 9997, kind: 'food', speciesId: DataStore.speciesList[0].id,
      x: P.x + r + 6 + 1, y: P.y,
      vx: 0, vy: 0, radius: 6,
      hp: 1, hpMax: 1, armor: 0, attack: 0, nutrition: 20, dangerLevel: 0, speed: 0,
      aiState: 'patrol', aiTimer: 0, hitFlash: 0, wobble: 0,
    });
    const before = P.digestBuffer;
    World.updateEating(G);
    expect(P.digestBuffer).toBeGreaterThan(before);
  });

  it('口沟（先天口器）计入摄食半径', () => {
    const G = newRun();
    Metab.recompute(G);
    // 起始形态就带 oral_groove（category=mouth）——早前的 startsWith('mouth') 匹配不到它
    expect(G.player.modules.some(id => DataStore.module(id).category === 'mouth')).toBe(true);
    const mouths = G.player.modules.filter(id => DataStore.module(id).category === 'mouth').length;
    expect(mouths).toBeGreaterThanOrEqual(1);
  });

  it('撕咬范围 ≥ 可见体型（视觉贴身即可咬到）', () => {
    const G = newRun();
    G.mode = 'playing';
    G.eraIndex = 2;
    G.player.modules.push('muscle_fiber');
    Metab.recompute(G);
    const P = G.player;
    const r = playerRadius(P.bodyVol);
    const prey = DataStore.speciesList.find(s => s.type === 'neutral')!;
    const hpBefore = G.ents.length;
    G.ents.push({
      id: 9996, kind: 'neutral', speciesId: prey.id,
      x: P.x + r + prey.radius + 1, y: P.y,
      vx: 0, vy: 0, radius: prey.radius,
      hp: 9999, hpMax: 9999, armor: 0, attack: 0,
      nutrition: 10, dangerLevel: 1, speed: 0,
      aiState: 'patrol', aiTimer: 0, hitFlash: 0, wobble: 0,
    });
    expect(G.ents.length).toBe(hpBefore + 1);
    P.attackCd = 0;
    Combat.playerBite(G, 0.016);
    // 被咬到 → 进入冷却
    expect(P.attackCd).toBeGreaterThan(0);
  });

  it('极小体型也保有最小摄食范围（不会小到贴脸却吃不到）', () => {
    const G = newRun();
    Metab.recompute(G);
    // 起始体型 10 → 绘制半径 ≈17 < EAT_RADIUS_MIN(30)，实际判定取 30
    expect(playerRadius(G.player.bodyVol)).toBeLessThan(CONST.EAT_RADIUS_MIN);
    // 在 26px 处（小于绘制半径+食物半径之和？不，等于）放食物：应被吃到
    const P = G.player;
    const food = DataStore.speciesList.find(s => s.type === 'food')!;
    G.ents.push({
      id: 9995, kind: 'food', speciesId: food.id,
      x: P.x + 28, y: P.y,
      vx: 0, vy: 0, radius: food.radius,
      hp: 1, hpMax: 1, armor: 0, attack: 0, nutrition: 20, dangerLevel: 0, speed: 0,
      aiState: 'patrol', aiTimer: 0, hitFlash: 0, wobble: 0,
    });
    const before = P.digestBuffer;
    World.updateEating(G);
    expect(P.digestBuffer).toBeGreaterThan(before);
  });
});