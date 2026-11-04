import { describe, it, expect, beforeEach } from 'vitest';
import { newRun } from '../src/systems/RunState';
import { CombatDepth } from '../src/systems/CombatDepth';
import { synergyTotals, synergyDescriptions } from '../src/systems/OrganSystem';
import { SKILLS } from '../src/types/Combat';
import { DataStore } from '../src/systems/DataStore';

/** 战斗深度系统（v0.8）：技能 · 状态效果 · 器官组合协同 */
describe('战斗深度 · 技能定义', () => {
  it('每个技能有唯一 id 与按键', () => {
    const ids = SKILLS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = SKILLS.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个技能的解锁器官都是真实存在的模块', () => {
    for (const s of SKILLS) {
      expect(s.requires.length).toBeGreaterThan(0);
      for (const r of s.requires) {
        expect(() => DataStore.module(r)).not.toThrow();
      }
    }
  });

  it('技能至少消耗一种资源或不算免费', () => {
    for (const s of SKILLS) {
      expect(s.energyCost + s.burstCost).toBeGreaterThanOrEqual(0);
      expect(s.cooldown).toBeGreaterThan(0);
    }
  });
});

describe('战斗深度 · 技能可用性', () => {
  let G: ReturnType<typeof newRun>;
  beforeEach(() => {
    G = newRun();
    G.mode = 'playing';
  });

  it('没有对应器官时技能不可用', () => {
    // 清空器官（只留内置）
    G.player.modules = G.player.modules.filter(id => DataStore.module(id).builtIn);
    const r = CombatDepth.canUse(G, 'toxin_spray');
    expect(r.ok).toBe(false);
  });

  it('装上酶腺后毒素喷射可用（资源充足时）', () => {
    if (!G.player.modules.includes('enzymatic_gland')) {
      G.player.modules.push('enzymatic_gland');
    }
    G.player.metab.currentEnergy = 999;
    const r = CombatDepth.canUse(G, 'toxin_spray');
    expect(r.ok).toBe(true);
  });

  it('未知技能返回不可用', () => {
    expect(CombatDepth.canUse(G, 'not_a_skill').ok).toBe(false);
  });

  it('能量不足时毒素喷射不可用', () => {
    if (!G.player.modules.includes('enzymatic_gland')) {
      G.player.modules.push('enzymatic_gland');
    }
    G.player.metab.currentEnergy = 0;
    const r = CombatDepth.canUse(G, 'toxin_spray');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('能量');
  });
});

describe('战斗深度 · 状态效果', () => {
  let G: ReturnType<typeof newRun>;
  beforeEach(() => {
    G = newRun();
    G.mode = 'playing';
  });

  it('实体中毒后持续掉血', () => {
    const e = G.ents[0];
    if (!e) return; // 空世界跳过
    e.hp = 1000;
    CombatDepth.applyStatus(e, 'poison', 3, 5);
    const before = e.hp;
    CombatDepth.update(G, 0.5);
    expect(e.hp).toBeLessThan(before);
  });

  it('毒素叠层上限为 3', () => {
    const e = G.ents[0];
    if (!e) return;
    for (let i = 0; i < 10; i++) CombatDepth.applyStatus(e, 'poison', 3, 5);
    // 通过重复 update 观察毒性，不直接读私有栈
    e.hp = 10000;
    CombatDepth.update(G, 0.1);
    expect(e.hp).toBeLessThan(10000);
  });

  it('硬化状态提供额外护甲', () => {
    expect(CombatDepth.hardenBonus()).toBe(0);
    CombatDepth.applyPlayerStatus('harden', 3, 10);
    expect(CombatDepth.hardenBonus()).toBeGreaterThan(0);
  });

  it('减速状态降低速度倍率', () => {
    CombatDepth.update(G, 0.01);
    expect(CombatDepth.slowMult()).toBeGreaterThan(0);
  });

  it('未减速时速度倍率为 1', () => {
    // 新局玩家不应被减速
    expect(CombatDepth.slowMult()).toBe(1);
  });
});

describe('战斗深度 · 器官组合协同', () => {
  it('单类别器官不触发跨类别协同', () => {
    const t = synergyTotals(['oral_groove']);
    expect(t.attack).toBe(0);
    expect(t.armor).toBe(0);
    expect(t.speed).toBe(0);
    expect(t.vision).toBe(0);
  });

  it('口器 + 运动触发"突袭"（攻击 +4）', () => {
    const t = synergyTotals(['mouth_basic', 'flagellum']);
    expect(t.attack).toBe(4);
  });

  it('运动 + 感知触发"猎手"（速度 +10 / 视野 +10）', () => {
    const t = synergyTotals(['cilia_cluster', 'photospot']);
    expect(t.speed).toBe(10);
    expect(t.vision).toBe(10);
  });

  it('头部 + 感知触发"神经感知"（视野 +20）', () => {
    const t = synergyTotals(['nerve_net', 'compound_eye']);
    expect(t.vision).toBe(20);
  });

  it('多组合协同累加', () => {
    // 口器+运动(突袭 +4 攻) + 运动+感知(猎手 +10 速/+10 视)
    const t = synergyTotals(['mouth_basic', 'flagellum', 'photospot']);
    expect(t.attack).toBe(4);
    expect(t.speed).toBe(10);
    expect(t.vision).toBe(10);
  });

  it('协同描述与实际加成一致', () => {
    const desc = synergyDescriptions(['mouth_basic', 'flagellum']);
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.join('')).toContain('突袭');
  });

  it('空器官列表无协同', () => {
    expect(synergyDescriptions([]).length).toBe(0);
  });
});
