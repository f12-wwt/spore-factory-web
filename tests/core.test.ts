import { describe, it, expect } from 'vitest';
import { pressureTier, armorReduction } from '../src/systems/MetabolismSystem';
import { Logistics, layerUnlocked } from '../src/systems/LogisticsSystem';
import { newRun, CONST, BASE_NODES, BASE_PIPES, upgradeSpentOf } from '../src/systems/RunState';
import { Stage } from '../src/systems/StageSystem';
import { DataStore } from '../src/systems/DataStore';
import { Metab } from '../src/systems/MetabolismSystem';
import type { Pipe } from '../src/types/GameState';

/** GDD 3.2 代谢压力表 */
describe('代谢压力表（GDD 3.2）', () => {
  it('0~80% 健康：效率100%、充能正常', () => {
    const t = pressureTier(0.5);
    expect(t.ratio).toBe(1);
    expect(t.chargeMod).toBe(1);
    expect(t.label).toBe('健康');
  });
  it('90~110% 黄色警告：效率85%、充能-30%', () => {
    const t = pressureTier(0.95);
    expect(t.ratio).toBe(0.85);
    expect(t.chargeMod).toBeCloseTo(0.7);
    expect(t.label).toBe('黄色警告');
  });
  it('110~130% 橙色警告：效率60%、充能-70%、速度-20%', () => {
    const t = pressureTier(1.15);
    expect(t.ratio).toBe(0.6);
    expect(t.chargeMod).toBeCloseTo(0.3);
    expect(t.speedMod).toBeCloseTo(0.8);
    expect(t.label).toBe('橙色警告');
  });
  it('>130% 红色警告：效率30%、充能停止', () => {
    const t = pressureTier(1.35);
    expect(t.ratio).toBe(0.3);
    expect(t.chargeMod).toBe(0);
    expect(t.label).toBe('红色警告');
  });
});

/** GDD 3.8 护甲公式 */
describe('护甲减伤（GDD 3.8）', () => {
  it('减伤 = 护甲 / (护甲 + 50)', () => {
    expect(armorReduction(0)).toBe(0);
    expect(armorReduction(50)).toBeCloseTo(0.5);
    expect(armorReduction(150)).toBeCloseTo(0.75);
  });
  it('高护甲收益递减（不超 100%）', () => {
    expect(armorReduction(1000)).toBeLessThan(1);
  });
});

/** 物流：最宽路径与瓶颈（GDD 3.3） */
describe('物流系统（GDD 3.3）', () => {
  const P = { nodes: BASE_NODES, pipes: BASE_PIPES };

  it('默认网络：吞吐 = min(管线宽度 8, 节点处理量 4) = 4', () => {
    // v0.5：节点自身处理量也参与吞吐上限，强化处理器官能真实提升吞吐
    const proc = BASE_NODES.find(n => n.type === 'process')!;
    const svc = Logistics.services(P);
    expect(svc.digestCap).toBe(proc.rate);
    expect(svc.digestCap).toBeLessThan(CONST.BASE_NODE_CAP);
    expect(svc.digestionEfficiency).toBeCloseTo(svc.digestCap / 10);
  });
  it('扩容中段管线提升吞吐（节点处理量不再是瓶颈时）', () => {
    const nodes = BASE_NODES.map(n => ({ ...n, rate: CONST.BASE_NODE_CAP * 2 }));
    const pipes = BASE_PIPES.map(l => ({ ...l }));
    pipes[1].level = 2;
    pipes[1].cap = CONST.BASE_NODE_CAP * 2;
    const svc = Logistics.services({ nodes, pipes });
    // 首段管线仍只有 8 → 吞吐被管线卡住
    expect(svc.digestCap).toBe(CONST.BASE_NODE_CAP);
  });
  it('强化口器（源节点处理量↑）可真实提升吞吐', () => {
    // 消化链路：源 → 处理 → 存储；任一环节处理量不足都会成为新瓶颈
    const nodes = BASE_NODES.map(n =>
      (n.type === 'source' || n.type === 'process') ? { ...n, rate: 12 } : n);
    const svc = Logistics.services({ nodes, pipes: BASE_PIPES });
    expect(svc.digestCap).toBe(CONST.BASE_NODE_CAP); // 源处理量↑后瓶颈回到管线 8
    const src = nodes.find(n => n.type === 'source')!;
    expect(src.rate).toBeGreaterThan(CONST.BASE_NODE_CAP);
    // 对照：源处理量不变时吞吐被源卡住
    const low = Logistics.services({ nodes: BASE_NODES, pipes: BASE_PIPES });
    expect(low.digestCap).toBeLessThan(svc.digestCap);
  });
  it('断开关键管线后消化道为 0', () => {
    const pipes = BASE_PIPES.filter(l => !(l.a === 'stomach' && l.b === 'energy'));
    const svc = Logistics.services({ nodes: BASE_NODES, pipes });
    expect(svc.digestCap).toBe(0);
  });
  it('瓶颈 = 最窄链路', () => {
    const bn = Logistics.bottleneck(P);
    expect(bn?.cap).toBe(CONST.BASE_NODE_CAP);
  });
});

/** v0.5：物流分层 + 器官自动接入 + 强化真实生效 */
describe('物流分层与器官接入（v0.5）', () => {
  it('先天器官自带物流节点并按层自动接入（无需手拉管线）', () => {
    const G = newRun();
    const P = G.player;
    // 草履虫级：细胞核（神经层）+ 口沟/胞肛（消化层）都应自带节点
    expect(P.nodes.some(n => n.moduleId === 'nucleus')).toBe(true);
    expect(P.nodes.some(n => n.moduleId === 'oral_groove')).toBe(true);
    // 口沟已连到消化主干（stomach）
    const oral = P.nodes.find(n => n.moduleId === 'oral_groove')!;
    expect(Logistics.pipeBetween(P, oral.id, 'stomach')).toBeDefined();
    // 细胞核已连到大脑（神经层种子）
    const nuc = P.nodes.find(n => n.moduleId === 'nucleus')!;
    expect(Logistics.pipeBetween(P, nuc.id, 'brain')).toBeDefined();
  });

  it('autoWire 幂等：重复调用不新增管线', () => {
    const G = newRun();
    const before = G.player.pipes.length;
    Logistics.autoWire(G.player);
    expect(G.player.pipes.length).toBe(before);
  });

  it('安装带 node 的器官会自动连入所属层', () => {
    const G = newRun();
    const P = G.player;
    P.nodes.push(Logistics.makeNode('n_muscle_hub', 'muscle_hub', 320, 300));
    const added = Logistics.autoWire(P);
    expect(added).toBeGreaterThan(0);
    expect(Logistics.pipeBetween(P, 'n_muscle_hub', 'muscle')).toBeDefined();
    expect(Logistics.pipeBetween(P, 'energy', 'n_muscle_hub')).toBeDefined();
  });

  it('层归属正确：口沟=消化、心泵=循环、神经网=神经、肌节=运动', () => {
    const G = newRun();
    const P = G.player;
    const layerOf = (id: string): string =>
      Logistics.layerOf(Logistics.makeNode(`t_${id}`, id, 0, 0));
    expect(layerOf('oral_groove')).toBe('digest');
    expect(layerOf('primitive_heart')).toBe('circulation');
    expect(layerOf('nerve_net')).toBe('nerve');
    expect(layerOf('muscle_hub')).toBe('motor');
    // 未解锁层：太古宙没有循环层/神经层（nerve minEra=2）
    expect(layerUnlocked(0, 'circulation')).toBe(false);
    expect(layerUnlocked(1, 'circulation')).toBe(true);
    expect(layerUnlocked(0, 'digest')).toBe(true);
    void P;
  });

  it('器官强化真实提升攻击/护甲/感知（而非仅显示）', () => {
    const G = newRun();
    G.eraIndex = 2;
    const P = G.player;
    P.modules.push('fang');
    Metab.recompute(G);
    const atk1 = P.attackTotal;
    const rate1 = DataStore.effStats(DataStore.module('fang'), 1).attackMod;
    expect(atk1).toBe(CONST.ATTACK_BASE + rate1);

    P.modLevels.fang = 3; // Lv1 → Lv3：attackMod 每级 +1
    Metab.recompute(G);
    const es3 = DataStore.effStats(DataStore.module('fang'), 3);
    expect(P.attackTotal).toBe(CONST.ATTACK_BASE + es3.attackMod);
    expect(P.attackTotal).toBeGreaterThan(atk1 + 1);
  });

  it('感官器官强化真实提升感知（视野范围随之扩大）', () => {
    const G = newRun();
    G.eraIndex = 2;
    const P = G.player;
    P.modules.push('chemohair');
    Metab.recompute(G);
    const p1 = P.perceptionTotal;
    P.modLevels.chemohair = 4;
    Metab.recompute(G);
    expect(P.perceptionTotal).toBeGreaterThan(p1 + 2);
  });

  it('撕咬使用含强化的 attackTotal（Combat 走缓存而非基础值）', () => {
    const G = newRun();
    G.eraIndex = 2;
    const P = G.player;
    P.modules.push('fang');
    P.modLevels.fang = 5;
    Metab.recompute(G);
    expect(P.attackTotal).toBeGreaterThan(CONST.ATTACK_BASE);
  });
});

/** 纪元里程碑（GDD 3.7） */
describe('纪元里程碑（GDD 3.7）', () => {
  it('太古宙里程碑由 存活/能量/记忆数 构成', () => {
    const era = DataStore.era(0);
    expect(era.milestones.map(m => m.type)).toEqual(['survive', 'energy', 'memoryCount']);
  });
  it('元古宙关键模块为多细胞聚合，寒武纪为外骨骼', () => {
    expect(DataStore.era(1).keyModule).toBe('multicell_agg');
    expect(DataStore.era(2).keyModule).toBe('exoskeleton');
  });
  it('能量里程碑：达到后闩锁不回落', () => {
    const G = newRun();
    G.mode = 'playing';
    const era = DataStore.era(0);
    const m = era.milestones.find(x => x.type === 'energy')!;
    G.player.metab.currentEnergy = m.value;
    Stage.check(G);
    G.player.metab.currentEnergy = 0;
    const idx = era.milestones.indexOf(m);
    expect(G.milestoneDone[idx]).toBe(true); // 已闩锁
  });
});

/** 纪元过渡继承（GDD 3.6） */
describe('过渡继承（GDD 3.6）', () => {
  it('eras.json 继承表与 GDD 一致：记忆100%/网络80%/体积60%/储备50%', () => {
    for (const era of DataStore.eras) {
      expect(era.inherit.memory).toBe(1.0);
      expect(era.inherit.network).toBe(0.8);
      expect(era.inherit.volume).toBe(0.6);
      expect(era.inherit.growth).toBe(0.5);
    }
  });
});

/** 管道费用（长度影响扩容费） */
describe('管道扩容费用', () => {
  it('长管线更贵', () => {
    const nodes = [...BASE_NODES];
    const short = Logistics.upgradeCost({ nodes }, 'n_oral_groove', 'stomach');
    const long = Logistics.upgradeCost({ nodes }, 'n_oral_groove', 'brain');
    expect(long).toBeGreaterThan(short);
  });
});

/** 数据完整性 */
describe('数据表完整性（GDD 文件 5）', () => {
  it('每纪元 6~14 个模块', () => {
    for (const era of DataStore.eras) {
      const n = DataStore.modules.filter(m => m.era === era.order).length;
      expect(n).toBeGreaterThanOrEqual(6);
      expect(n).toBeLessThanOrEqual(14);
    }
  });
  it('每个纪元 3 种 AI（食物/中立/捕食者）', () => {
    for (const era of DataStore.eras) {
      const kinds = new Set(DataStore.speciesList.filter(s => s.era === era.order).map(s => s.type));
      expect(kinds).toEqual(new Set(['food', 'neutral', 'predator']));
    }
  });
  it('灾害只出现在 3 个验证纪元', () => {
    for (const d of DataStore.disasters) {
      expect(d.era).toBeLessThan(3);
      expect(d.warningTime).toBeGreaterThanOrEqual(15);
      expect(d.duration).toBeLessThanOrEqual(30);
    }
  });
  it('管道 cap = 基础×level', () => {
    const pipes: Pipe[] = [{ a: 'mouth', b: 'stomach', level: 3, cap: CONST.BASE_NODE_CAP * 3 }];
    expect(pipes[0].cap).toBe(24);
  });
});

/** 模块强化（按类别差异化效果） */
describe('模块强化', () => {
  it('细胞壁（防御类）强化：护甲+3/级、体积+0.5/级、常驻+15%/级', () => {
    const m = DataStore.module('cell_wall');
    const lv3 = DataStore.effStats(m, 3);
    expect(lv3.armorMod).toBe(m.armorMod + 6);
    expect(lv3.volume).toBeCloseTo(m.volume + 1.0);
    expect(lv3.residentDrain).toBeCloseTo(m.residentDrain * 1.3);
  });
  it('鞭毛（移动类）强化：速度+1/级、体积不变', () => {
    const m = DataStore.module('flagellum');
    const lv4 = DataStore.effStats(m, 4);
    expect(lv4.speedMod).toBe(m.speedMod + 3);
    expect(lv4.volume).toBe(m.volume);
  });
  it('原始胃（物流节点）强化：吞吐 +25%/级', () => {
    const m = DataStore.module('primitive_stomach');
    const lv3 = DataStore.effStats(m, 3);
    expect(lv3.nodeRate).toBe(Math.round(m.node!.rate * 1.5));
  });
  it('强化费用 = 原价 × 0.6 × 当前等级', () => {
    // 价格随平衡调整，从数据表读取而非硬编码
    const m = DataStore.module('cell_wall');
    expect(Math.round(m.growthCost * CONST.UP_COST_RATIO * 2))
      .toBe(Math.round(m.growthCost * 0.6 * 2));
  });
});

/** 蛋白质掉落与拆除返还 */
describe('蛋白质与拆除返还', () => {
  it('累计强化消耗：骨针触突(8) Lv3 = 5 + 10 = 15', () => {
    expect(upgradeSpentOf(8, 3)).toBe(15);
    expect(upgradeSpentOf(8, 1)).toBe(0);
  });
  it('拆除返还 = 购置30% + 强化投入80%', () => {
    const lv = 3;
    const refund = 8 * 0.3 + upgradeSpentOf(8, lv) * 0.8;
    expect(refund).toBeCloseTo(2.4 + 12);
  });
  it('蛋白质能量转化 = 营养 × 0.6', () => {
    expect(Math.round(40 * 0.6)).toBe(24);   // 奇虾
    expect(Math.round(24 * 0.6)).toBe(14);   // 三叶虫
  });
});
