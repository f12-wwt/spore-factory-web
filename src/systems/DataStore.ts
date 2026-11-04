import modulesJson from '../data/modules.json';
import erasJson from '../data/eras.json';
import disastersJson from '../data/disasters.json';
import speciesJson from '../data/species.json';
import zonesJson from '../data/zones.json';
import type { ModuleDef } from '../types/Module';
import type { EraDef } from '../types/Era';
import type { MemoryEntry } from '../types/Memory';
import type { SpeciesSnapshot } from '../types/Snapshot';
import type { ZoneDef } from '../types/Zone';

/** 灾害定义（GDD 5.3） */
export interface DisasterDef {
  id: string;
  era: number;
  trigger: 'random' | 'scripted';
  warningTime: number;
  duration: number;
  recover: number;
  radius: number;
  zoneDps: number;
  globalDps: number;
  counterModules: string[];
  effects: { type: string; value: number }[];
  survivalStrategy: string;
}

/** 物种定义（GDD 5.4） */
export interface SpeciesDef {
  id: string;
  name: string;
  type: 'food' | 'neutral' | 'predator';
  era: number;
  nutrition: number;
  dangerLevel: number;
  radius: number;
  hp: number;
  armor: number;
  attack: number;
  speed: number;
  color: string;
  behavior: {
    aggression: number;
    predation: number;
    social: number;
    migration: number;
    reproduction: number;
  };
}

/** 数据仓库：全部配置由 JSON 驱动（GDD 使用说明 #2） */
export const DataStore = {
  modules: modulesJson as ModuleDef[],
  eras: erasJson as EraDef[],
  speciesList: speciesJson as SpeciesDef[],
  disasters: disastersJson as DisasterDef[],
  zones: zonesJson as ZoneDef[],

  module(id: string): ModuleDef {
    const m = this.modules.find(m => m.id === id);
    if (!m) throw new Error(`unknown module: ${id}`);
    return m;
  },

  era(order: number): EraDef {
    const e = this.eras.find(e => e.order === order);
    if (!e) throw new Error(`unknown era order: ${order}`);
    return e;
  },

  /** 安全版：越界（末纪元之后）返回 null */
  eraAt(order: number): EraDef | null {
    return this.eras.find(e => e.order === order) ?? null;
  },

  /**
   * 模块强化（Lv1 起）：按类别带来不同效果——
   * 防御/躯干类每级 +0.5 体积（细胞壁/外骨骼强化 = 长个）；移动/感官/武器类数值每级 +1；
   * 带物流节点的器官每级吞吐 +25%；常驻消耗每级 +15%（强化的代谢代价）。
   */
  effStats(m: ModuleDef, lv = 1): {
    speedMod: number; perceptionMod: number; armorMod: number; attackMod: number;
    volume: number; residentDrain: number; nodeRate: number;
  } {
    const k = Math.max(0, lv - 1);
    const bulky = m.category === 'defense' || m.category === 'trunk';
    return {
      speedMod: m.speedMod + (m.speedMod > 0 ? k : 0),
      perceptionMod: m.perceptionMod + (m.perceptionMod > 0 ? k : 0),
      armorMod: m.armorMod + (m.armorMod > 0 ? k * 3 : 0),
      attackMod: m.attackMod + (m.attackMod > 0 ? k : 0),
      volume: m.volume + (bulky ? k * 0.5 : 0),
      residentDrain: m.residentDrain * (1 + 0.15 * k),
      nodeRate: m.node ? Math.round(m.node.rate * (1 + 0.25 * k)) : 0,
    };
  },

  disaster(id: string): DisasterDef {
    const d = this.disasters.find(d => d.id === id);
    if (!d) throw new Error(`unknown disaster: ${id}`);
    return d;
  },

  /** 某纪元的环境分区 */
  zonesForEra(eraOrder: number): ZoneDef[] {
    return this.zones.filter(z => z.era === eraOrder);
  },

  species(id: string): SpeciesDef {
    const s = this.speciesList.find(s => s.id === id);
    if (!s) throw new Error(`unknown species: ${id}`);
    return s;
  },

  /** 某物种的记忆条目原型（??? → 解锁） */
  memoryOf(id: string): MemoryEntry {
    const s = this.species(id);
    return {
      id: s.id,
      name: s.name,
      unlocked: false,
      nutrition: s.nutrition,
      dangerLevel: s.dangerLevel,
      firstEra: this.era(s.era).name,
      interactionCount: 0,
    };
  },

  /** 玩家物种血统快照（GDD 4.4 SpeciesSnapshot） */
  makeSnapshot(opts: {
    eraName: string;
    morphology: Record<string, string>;
    networkSummary: string;
    cognitionTags: string[];
    aggression: number;
    predation: number;
    historicalScore: number;
    strategyTag: string;
  }): SpeciesSnapshot {
    return {
      version: 1,
      speciesName: '玩家物种',
      era: opts.eraName,
      morphology: opts.morphology,
      networkSummary: opts.networkSummary,
      cognitionTags: opts.cognitionTags,
      behavior: {
        aggression: opts.aggression,
        predation: opts.predation,
        social: 0.2,
        migration: 0.3,
        reproduction: 0.5,
      },
      historicalScore: Math.round(opts.historicalScore),
      strategyTag: opts.strategyTag,
    };
  },
};

/**
 * 启动即校验（fail-fast，坏数据在加载期暴露而不是运行期崩溃）：
 * 1. 每个纪元必须同时有 食物/中立/捕食者 三类物种——缺一类时生成逻辑会取到 undefined；
 * 2. 关键模块、纪元灾害、模块认知门槛必须存在于对应数据表。
 */
function validateData(): void {
  for (const era of erasJson) {
    const kinds = new Set(speciesJson.filter(s => s.era === era.order).map(s => s.type));
    for (const t of ['food', 'neutral', 'predator'] as const) {
      if (!kinds.has(t)) throw new Error(`[data] 纪元 ${era.id} 缺少 ${t} 类物种`);
    }
    if (era.keyModule && !modulesJson.some(m => m.id === era.keyModule)) {
      throw new Error(`[data] 纪元 ${era.id} 关键模块 ${era.keyModule} 不在 modules.json`);
    }
    for (const id of era.disasters) {
      if (!disastersJson.some(d => d.id === id)) {
        throw new Error(`[data] 纪元 ${era.id} 灾害 ${id} 不在 disasters.json`);
      }
    }
  }
  for (const m of modulesJson) {
    if (m.requiresMemory && !speciesJson.some(s => s.id === m.requiresMemory)) {
      throw new Error(`[data] 模块 ${m.id} 认知门槛 ${m.requiresMemory} 不在 species.json`);
    }
  }
}
validateData();
