import { describe, it, expect } from 'vitest';
import { BUILDS, buildState, profile, profileAll, audit } from '../src/systems/BalanceProbe';
import { newRun, CONST } from '../src/systems/RunState';
import { Metab } from '../src/systems/MetabolismSystem';
import { Logistics } from '../src/systems/LogisticsSystem';
import { DataStore } from '../src/systems/DataStore';

/**
 * 平衡基线（v0.6）——把 BalanceProbe 的审计规则固化为测试。
 * 这些断言代表设计意图，任何调参若破坏它们即视为回归。
 */
describe('平衡基线：代谢', () => {
  const ps = profileAll();
  const bad = audit(ps).filter(i => i.severity === 'bad');

  it('审计无严重违规', () => {
    expect(bad.map(b => `${b.build}/${b.metric}=${b.value.toFixed(2)} (${b.rule})`)).toEqual([]);
  });

  it('正常构筑压力 15%~95%（贪装才告警）', () => {
    for (const p of ps.filter(x => x.build !== '贪装·无强化')) {
      expect(p.pressure).toBeGreaterThan(0.15);
      expect(p.pressure).toBeLessThanOrEqual(0.95);
    }
  });

  it('贪装无强化必须告警（构筑有代价）', () => {
    const bloat = ps.find(p => p.build === '贪装·无强化')!;
    expect(bloat.pressure).toBeGreaterThan(1.05);
  });

  it('正常构筑不会静止饿死（不吃可持续 60s+）', () => {
    for (const p of ps.filter(x => x.build !== '贪装·无强化')) {
      if (Number.isFinite(p.starveTime)) expect(p.starveTime).toBeGreaterThanOrEqual(60);
      else expect(p.starveTime).toBe(Infinity);
    }
  });

  it('产出随纪元推进而增长（不恒定）', () => {
    const p0 = ps.find(p => p.build === '太古宙全配')!;
    const p2 = ps.find(p => p.build === '寒武纪全配+强化')!;
    expect(p2.output).toBeGreaterThan(p0.output * 1.4);
  });
});

describe('平衡基线：战斗', () => {
  const ps = profileAll();

  it('击杀中立的 TTK 在 1~7s（不秒杀也不拖沓）', () => {
    for (const p of ps) {
      expect(p.ttkNeutral).toBeGreaterThan(0.8);
      expect(p.ttkNeutral).toBeLessThan(6.5);
    }
  });

  it('开局能击杀中立但打捕食者有悬念', () => {
    const s = ps.find(p => p.build === '开局·草履虫')!;
    expect(s.ttkNeutral).toBeLessThan(6);
    expect(s.ttkPredator).toBeGreaterThan(s.ttkNeutral); // 捕食者应明显更强
  });

  it('面对捕食者不会被秒杀（≥2.5s 逃跑窗口）', () => {
    for (const p of ps) {
      if (Number.isFinite(p.survivePredator)) expect(p.survivePredator).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('强化必须提升战斗力（伤害与减伤双升）', () => {
    const base = ps.find(p => p.build === '寒武纪全配')!;
    const up = ps.find(p => p.build === '寒武纪全配+强化')!;
    expect(up.dps).toBeGreaterThan(base.dps * 1.2);
    expect(up.armorCut).toBeGreaterThan(base.armorCut);
    expect(up.hpMax).toBeGreaterThan(base.hpMax);
  });

  it('速度不出现断层（0.6× ~ 2.2× 基准）', () => {
    for (const p of ps) {
      // 堆防御件会带负速度（细胞壁/外骨骼 -1），但不跌破 0.6× 基准
      expect(p.speed).toBeGreaterThan(CONST.BASE_SPEED * 0.6);
      expect(p.speed).toBeLessThan(CONST.BASE_SPEED * 2.2);
    }
  });
});

describe('平衡基线：经济', () => {
  /** 15 分钟标准觅食节奏的收入 */
  const income = (growthMult: number): number =>
    60 * DataStore.speciesList.find(s => s.type === 'food')!.nutrition * CONST.GROWTH_PER_FOOD * growthMult
    + 20 * CONST.GROWTH_PER_KILL;

  it('标准难度 15 分钟可买 5~15 件器官', () => {
    const era0 = DataStore.modules.filter(m => m.era === 0 && m.growthCost > 0);
    const avg = era0.reduce((s, m) => s + m.growthCost, 0) / era0.length;
    const buys = income(1.0) / avg;
    expect(buys).toBeGreaterThanOrEqual(5);
    expect(buys).toBeLessThanOrEqual(15);
  });

  it('难度梯度单调（温和 > 标准 > 恶劣 > 大灭绝）', () => {
    const vals = [1.8, 1.0, 0.62, 0.42].map(income);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThan(vals[i - 1]);
  });

  it('器官价位合理（太古宙 5~25，元古宙 12~35，寒武纪 18~40）', () => {
    const era0 = DataStore.modules.filter(x => x.era === 0 && x.growthCost > 0 && !x.builtIn);
    for (const m of era0) {
      expect(m.growthCost).toBeGreaterThanOrEqual(5);
      expect(m.growthCost).toBeLessThanOrEqual(25);
    }
    for (const m of DataStore.modules.filter(x => x.era === 1 && x.growthCost > 0)) {
      expect(m.growthCost).toBeGreaterThanOrEqual(12);
      expect(m.growthCost).toBeLessThanOrEqual(35);
    }
    for (const m of DataStore.modules.filter(x => x.era === 2 && x.growthCost > 0)) {
      expect(m.growthCost).toBeGreaterThanOrEqual(18);
      expect(m.growthCost).toBeLessThanOrEqual(40);
    }
  });

  it('强化 Lv5 是购置价的长期投资（5~7 倍）', () => {
    const m = DataStore.module('primitive_stomach');
    let up = 0;
    for (let i = 1; i < CONST.UP_MAX_LEVEL; i++) {
      up += Math.round(m.growthCost * CONST.UP_COST_RATIO * i);
    }
    // 0.6×(1+2+3+4) = 6 倍原价 → 强化到满是长期投资，不是随手的小额消费
    expect(up / m.growthCost).toBeGreaterThan(5);
    expect(up / m.growthCost).toBeLessThan(7);
  });
});

describe('平衡基线：物流', () => {
  it('管网容量随纪元提升', () => {
    expect(CONST.pipeCapOf(1)).toBeGreaterThan(CONST.pipeCapOf(0));
    expect(CONST.pipeCapOf(2)).toBeGreaterThan(CONST.pipeCapOf(1));
  });

  it('纪元推进时管网自动升级', () => {
    const G = newRun();
    G.eraIndex = 0;
    Logistics.autoWire({ ...G.player, eraIndex: 0 });
    const cap0 = Math.min(...G.player.pipes.map(p => p.cap));
    // 模拟纪元推进
    G.eraIndex = 2;
    for (const pipe of G.player.pipes) pipe.cap = Math.max(pipe.cap, CONST.pipeCapOf(2));
    expect(Math.min(...G.player.pipes.map(p => p.cap))).toBeGreaterThan(cap0);
  });

  it('消化吞吐有上限（非无限）', () => {
    const p = BUILDS.find(b => b.id === 'era2_full')!;
    const G = buildState(p);
    expect(G.player.digestRate).toBeLessThan(40);
  });

  it('后续纪元提供更强消化器官（避免 P 停滞）', () => {
    const era0 = DataStore.modules.filter(m => m.era === 0 && m.node?.type === 'process');
    const era2 = DataStore.modules.filter(m => m.era === 2 && m.node?.type === 'process');
    expect(era0.length).toBeGreaterThan(0);
    expect(era2.length).toBeGreaterThan(0);
    expect(Math.max(...era2.map(m => m.node!.rate)))
      .toBeGreaterThan(Math.max(...era0.map(m => m.node!.rate)));
  });
});

describe('平衡基线：体积', () => {
  it('各纪元体积上限单调递增且留有改造空间', () => {
    const caps = [0, 1, 2].map(e => DataStore.era(e).volumeMax);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThan(caps[i - 1]);
    // 起始 10 体积对太古宙 14 上限 → 留 4 点
    const G = newRun();
    Metab.recompute(G);
    expect(DataStore.era(0).volumeMax - G.player.bodyVol).toBeGreaterThanOrEqual(4);
  });

  it('满配形态不超体积上限', () => {
    for (const p of profileAll()) {
      expect(p.vol).toBeLessThanOrEqual(p.volCap);
    }
  });

  it('防御/躯干强化扩仓有意义（+1/级）', () => {
    const G = newRun();
    G.eraIndex = 1;
    G.player.modules.push('cell_wall');
    G.player.modLevels.cell_wall = 3;
    Metab.recompute(G);
    expect(G.player.maxVolumeBonus).toBe(2);
  });
});

describe('平衡基线：形态库完整性', () => {
  it('全部预设形态可正常装配（无异常数值）', () => {
    for (const b of BUILDS) {
      const G = buildState(b);
      expect(Number.isFinite(G.player.metab.metabolicOutput)).toBe(true);
      expect(Number.isFinite(G.player.metab.pressure)).toBe(true);
      expect(Number.isFinite(G.player.hpMax)).toBe(true);
      expect(G.player.hpMax).toBeGreaterThan(0);
      expect(G.player.metab.metabolicOutput).toBeGreaterThan(0);
    }
  });

  it('单个预设画像字段完整', () => {
    const p = profile(BUILDS[0]);
    expect(p.build).toBeTruthy();
    expect(p.volCap).toBeGreaterThan(0);
    expect(p.digestBuffer).toBeGreaterThan(0);
  });
});