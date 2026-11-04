import { describe, it, expect } from 'vitest';
import * as Organ from '../src/systems/OrganSystem';
import { DataStore } from '../src/systems/DataStore';
import { newRun } from '../src/systems/RunState';
import { Metab, pressureTier } from '../src/systems/MetabolismSystem';
import { Logistics } from '../src/systems/LogisticsSystem';

/** 器官槽位与上位替代（v0.6） */
describe('槽位：安装判定', () => {
  it('空槽可直接安装', () => {
    const v = Organ.checkInstall('muscle_fiber', []);
    expect(v.ok).toBe(true);
  });

  it('同槽低阶 → 高阶：允许（上位替代）', () => {
    const v = Organ.checkInstall('fang', ['oral_groove']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.replaced).toEqual(['oral_groove']);
  });

  it('同槽高阶 → 低阶：拒绝（不能退步）', () => {
    const v = Organ.checkInstall('oral_groove', ['fang']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.blocker).toBe('fang');
  });

  it('同阶同级：拒绝', () => {
    const v = Organ.checkInstall('mouth_basic', ['oral_groove']);
    // 口沟 tier0，口器 tier1 → 应允许替代
    expect(v.ok).toBe(true);
  });

  it('不同槽互不影响', () => {
    // 外骨骼（防御位）与尖牙（口器位）可共存
    const v = Organ.checkInstall('fang', ['exoskeleton']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.replaced).toEqual([]);
  });

  it('无 slot 的器官（代谢件）可自由安装', () => {
    const v = Organ.checkInstall('primitive_stomach', ['primitive_stomach', 'primitive_heart']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.replaced).toEqual([]);
  });
});

describe('槽位：生效件计算', () => {
  it('同槽只保留最高 tier', () => {
    const act = Organ.activeModules(['oral_groove', 'mouth_basic', 'fang']);
    expect(act).toContain('fang');
    expect(act).not.toContain('mouth_basic');
    expect(act).not.toContain('oral_groove');
  });

  it('先天低阶件被覆盖但仍在体内（不可拆）', () => {
    const all = ['oral_groove', 'mouth_basic'];
    const act = Organ.activeModules(all);
    expect(act).toHaveLength(1);
    expect(act[0]).toBe('mouth_basic');
    // 但它仍在 modules 列表里（卸载会被拒绝）
    expect(all).toContain('oral_groove');
    expect(Organ.shadowedModules(all)).toEqual(['oral_groove']);
  });

  it('无 slot 器官全部生效', () => {
    const act = Organ.activeModules(['primitive_stomach', 'energy_pool', 'primitive_heart']);
    expect(act).toHaveLength(3);
  });

  it('detach 拒绝拆除先天器官', () => {
    const mods = ['oral_groove', 'mouth_basic'];
    const nodes = [] as never[];
    const pipes = [] as never[];
    expect(Organ.detach('oral_groove', mods, nodes, pipes)).toBe(false);
    expect(mods).toContain('oral_groove');
  });
});

describe('槽位：替代链完整性', () => {
  it('每个槽位链都有唯一最高位次', () => {
    for (const slot of ['mouth', 'defense', 'movement', 'sense', 'head', 'trunk'] as const) {
      const chain = Organ.slotChain(slot);
      expect(chain.length).toBeGreaterThanOrEqual(2);
      const maxTier = Math.max(...chain.map((c) => c.tier));
      expect(chain.filter((c) => c.tier === maxTier)).toHaveLength(1);
    }
  });

  it('槽位链位次连续递增', () => {
    for (const slot of ['mouth', 'defense', 'movement', 'sense', 'head', 'trunk'] as const) {
      const tiers = Organ.slotChain(slot).map((c) => c.tier);
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i]).toBeGreaterThan(tiers[i - 1]);
      }
    }
  });

  it('槽位内器官同属一个 category', () => {
    for (const slot of ['mouth', 'defense', 'movement', 'sense', 'head', 'trunk'] as const) {
      const cats = new Set(Organ.slotChain(slot).map((c) => DataStore.module(c.id).category));
      expect(cats.size).toBe(1);
    }
  });

  it('slotLeader 返回槽内最高位次', () => {
    expect(Organ.slotLeader('mouth', ['oral_groove', 'mouth_basic'])).toBe('mouth_basic');
    expect(Organ.slotLeader('mouth', ['oral_groove', 'fang'])).toBe('fang');
    expect(Organ.slotLeader('mouth', [])).toBeNull();
  });

  it('数据完整性：tier 为 0 的先天件也有 slot', () => {
    for (const m of DataStore.modules.filter((x) => x.builtIn && x.category !== 'metabolism')) {
      expect(m.slot).toBeTruthy();
      expect(m.tier).toBe(0);
    }
  });
});

describe('槽位：属性结算只算生效件', () => {
  it('装上尖牙后，口沟属性不再叠加', () => {
    const G = newRun();
    const before = { atk: G.player.attackTotal, vol: G.player.bodyVol };
    G.player.modules.push('fang');
    Metab.recompute(G);
    // 口沟 attackMod=0，尖牙 attackMod=7 → 攻击应 +7（不是 +0+7 的双计）
    expect(G.player.attackTotal).toBe(before.atk + 7);
    expect(G.player.bodyVol).toBeGreaterThan(before.vol);
  });

  it('高阶器官覆盖低阶的体积（不双倍）', () => {
    const G = newRun();
    G.player.modules.push('cell_membrane');
    Metab.recompute(G);
    const vMembrane = G.player.bodyVol;
    G.player.modules.push('exoskeleton');
    Metab.recompute(G);
    // 外骨骼 volume5 应替换膜的 volume1，而非 1+5=6
    expect(G.player.bodyVol).toBe(vMembrane - 1 + 5);
  });

  it('装上外骨骼后护甲大幅提升（覆盖而非叠加）', () => {
    const G = newRun();
    G.eraIndex = 2;
    Metab.recompute(G);
    // 开局护甲 = 细胞质(2) + 细胞膜(3) = 5
    expect(G.player.armorTotal).toBe(5);
    G.player.modules.push('exoskeleton');
    Metab.recompute(G);
    // 细胞膜(3) 被外骨骼(26) 覆盖 → 细胞质(2) + 外骨骼(26) = 28，而非 5+26=31
    expect(G.player.armorTotal).toBe(28);
  });

  it('运行时与编辑器口径一致（activeModules 单一来源）', () => {
    const mods = ['oral_groove', 'mouth_basic', 'primitive_stomach', 'energy_pool'];
    const act = Organ.activeModules(mods);
    const G = newRun();
    G.player.modules = [...act];
    Metab.recompute(G);
    // 生效件 = 1 口器 + 2 代谢件
    expect(act).toHaveLength(3);
    expect(G.player.metab.residentLoad).toBeGreaterThan(0);
  });
});

describe('槽位：物流节点上位替代', () => {
  it('口沟与基础口器同为消化层 source，节点互斥', () => {
    const nodes = [
      { id: 'n_oral_groove', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8, moduleId: 'oral_groove' },
      { id: 'n_mouth_basic', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8, moduleId: 'mouth_basic' },
    ];
    const live = Organ.liveNodeIds(nodes);
    // 基础口器 tier1 > 口沟 tier0 → 口沟节点隐退
    expect(live.has('n_mouth_basic')).toBe(true);
    expect(live.has('n_oral_groove')).toBe(false);
  });

  it('基础口器在体内 → 消化层只有一个在役入口', () => {
    const G = newRun();
    G.player.modules.push('mouth_basic');
    G.player.nodes.push({
      id: 'n_mouth_basic', type: 'source', layer: 'digest',
      x: 300, y: 70, rate: 8, moduleId: 'mouth_basic', auto: true,
    });
    Logistics.autoWire({ ...G.player, eraIndex: G.eraIndex });
    const live = Organ.liveNodeIds(G.player.nodes);
    const liveSources = G.player.nodes.filter(n => live.has(n.id) && n.type === 'source');
    // 口沟节点已隐退，只剩基础口器一个在役 source
    expect(liveSources.map(n => n.id)).not.toContain('n_oral_groove');
    expect(liveSources).toHaveLength(1);
    expect(liveSources[0].id).toBe('n_mouth_basic');
  });

  it('卸下高级口器 → 先天口沟节点原位复活', () => {
    const nodes = [
      { id: 'n_oral_groove', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8, moduleId: 'oral_groove' },
      { id: 'n_mouth_basic', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8, moduleId: 'mouth_basic' },
    ];
    expect(Organ.liveNodeIds(nodes).has('n_oral_groove')).toBe(false);
    // 移除高级节点后，隐退的低阶节点自动恢复在役（无需额外标记）
    expect(Organ.liveNodeIds([nodes[0]]).has('n_oral_groove')).toBe(true);
  });

  it('神经链：细胞核 sink → 神经网 process → 神经节 sink 逐级顶替', () => {
    const nodes = [
      { id: 'n_nucleus', type: 'sink' as const, layer: 'nerve' as const, x: 0, y: 0, rate: 4, moduleId: 'nucleus' },
      { id: 'n_nerve_net', type: 'process' as const, layer: 'nerve' as const, x: 0, y: 0, rate: 12, moduleId: 'nerve_net' },
    ];
    const live = Organ.liveNodeIds(nodes);
    expect(live.has('n_nerve_net')).toBe(true);
    expect(live.has('n_nucleus')).toBe(false);
  });

  it('无 moduleId 的基础节点恒为在役', () => {
    const nodes = [
      { id: 'mouth', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 4 },
      { id: 'stomach', type: 'process' as const, layer: 'digest' as const, x: 0, y: 0, rate: 4 },
      { id: 'energy', type: 'storage' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8 },
    ];
    expect(Organ.liveNodeIds(nodes).size).toBe(3);
  });

  it('不可叠加件（代谢器官）节点全部在役', () => {
    const nodes = [
      { id: 'n_h1', type: 'process' as const, layer: 'digest' as const, x: 0, y: 0, rate: 16, moduleId: 'enzymatic_gland' },
      { id: 'n_h2', type: 'process' as const, layer: 'digest' as const, x: 0, y: 0, rate: 16, moduleId: 'enzymatic_gland' },
    ];
    expect(Organ.liveNodeIds(nodes).size).toBe(2);
  });

  it('隐退节点不可接线', () => {
    const P = {
      nodes: [
        { id: 'n_oral_groove', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8, moduleId: 'oral_groove' },
        { id: 'n_mouth_basic', type: 'source' as const, layer: 'digest' as const, x: 0, y: 0, rate: 8, moduleId: 'mouth_basic' },
        { id: 'stomach', type: 'process' as const, layer: 'digest' as const, x: 0, y: 0, rate: 4 },
      ] as never[],
      pipes: [] as never[],
    };
    expect(Logistics.connect(P as never, 'n_oral_groove', 'stomach')).toMatch(/隐退|替代/);
    expect(Logistics.connect(P as never, 'n_mouth_basic', 'stomach')).toBeNull();
  });

  it('autoWire 不会给隐退节点铺支线', () => {
    const G = newRun();
    G.player.modules.push('mouth_basic');
    G.player.nodes.push({
      id: 'n_mouth_basic', type: 'source', layer: 'digest',
      x: 300, y: 70, rate: 8, moduleId: 'mouth_basic', auto: true,
    });
    Logistics.autoWire({ ...G.player, eraIndex: G.eraIndex });
    // 没有任何管线端点挂在隐退的口沟节点上
    expect(G.player.pipes.some(l => l.a === 'n_oral_groove' || l.b === 'n_oral_groove')).toBe(false);
  });
});

describe('槽位：压力阈值放宽（v0.6）', () => {
  it('健康区上限 90%', () => {
    expect(pressureTier(0.5).label).toBe('健康');
    expect(pressureTier(0.9).label).toBe('健康');
  });

  it('90%~110% 黄色', () => {
    expect(pressureTier(0.95).label).toBe('黄色警告');
    expect(pressureTier(1.1).label).toBe('黄色警告');
  });

  it('110%~130% 橙色', () => {
    expect(pressureTier(1.15).label).toBe('橙色警告');
    expect(pressureTier(1.3).label).toBe('橙色警告');
  });

  it('>130% 红色（效率骤降）', () => {
    expect(pressureTier(1.35).label).toBe('红色警告');
    expect(pressureTier(1.35).ratio).toBe(0.3);
  });

  it('阈值严格递减（无重叠）', () => {
    const labels = [0.5, 0.95, 1.15, 1.35].map((p) => pressureTier(p).label);
    expect(new Set(labels).size).toBe(4);
  });
});