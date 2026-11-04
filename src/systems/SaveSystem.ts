import type { SpeciesSnapshot } from '../types/Snapshot';
import { CONST } from './RunState';
import { DataStore } from './DataStore';

/**
 * 存档系统（GDD T14 / 2.1 本地 localStorage）：
 * 血统（记忆/代数/快照池）、聚合埋点、设置。
 * 读档带结构校验：损坏/异构 JSON 视为无效存档回退默认值，不把脏字段带进游戏。
 */
const KEY = 'sfw:save:v1';
const VERSION = 1;
const MAX_SNAPSHOTS = 8;
const MAX_MEMORIES = 512;
const LIFETIME_KEYS = ['runs', 'eraTransitions', 'reproductions', 'loopCompletions', 'crashes'] as const;
/** 存档中的记忆 id 必须落在数据表白名单内，否则 newRun → DataStore.species() 会抛错导致启动白屏 */
const KNOWN_SPECIES = new Set(DataStore.speciesList.map(s => s.id));

export interface SaveData {
  version: number;
  generation: number;
  memories: string[];
  snapshots: SpeciesSnapshot[];
  lifetime: {
    runs: number;
    eraTransitions: number;
    reproductions: number;
    loopCompletions: number;
    crashes: number;
  };
}

function defaultSave(): SaveData {
  return {
    version: VERSION,
    generation: 0,
    memories: [],
    snapshots: [],
    lifetime: { runs: 0, eraTransitions: 0, reproductions: 0, loopCompletions: 0, crashes: 0 },
  };
}

/** 结构校验：类型、版本、数量上限。脏字段一律不进入运行时状态。 */
function isValid(d: unknown): d is SaveData {
  if (typeof d !== 'object' || d === null) return false;
  const x = d as Record<string, unknown>;
  return Number.isInteger(x.generation)
    && (x.generation as number) >= 0
    && (x.generation as number) <= 1_000_000
    && Array.isArray(x.memories)
    && (x.memories as unknown[]).every(m => typeof m === 'string')
    && Array.isArray(x.snapshots)
    && (x.snapshots as unknown[]).length <= MAX_SNAPSHOTS
    && (x.snapshots as unknown[]).every(s => typeof s === 'object' && s !== null)
    && (x.version === undefined || x.version === VERSION);
}

/** 生命周期统计逐字段清洗：缺失/非法字段补 0，不让 NaN 或字符串扩散到结算逻辑。 */
function sanitizeLifetime(v: unknown): SaveData['lifetime'] {
  const out = defaultSave().lifetime;
  if (typeof v !== 'object' || v === null) return out;
  const src = v as Record<string, unknown>;
  for (const k of LIFETIME_KEYS) {
    const n = src[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  return out;
}

export const SaveSystem = {
  load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw) as unknown;
        if (!isValid(d)) return defaultSave();
        return {
          version: VERSION,
          generation: d.generation,
          memories: d.memories.filter(id => KNOWN_SPECIES.has(id)).slice(0, MAX_MEMORIES),
          snapshots: d.snapshots.slice(0, MAX_SNAPSHOTS),
          lifetime: sanitizeLifetime(d.lifetime),
        };
      }
    } catch { /* 存档损坏则重置 */ }
    return defaultSave();
  },

  save(data: SaveData): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...data, version: VERSION }));
    } catch { /* 隐私模式等场景静默失败 */ }
  },

  /** 死亡/通关时落盘：血统记忆 60% 遗传 + 快照入库（GDD 3.5/3.6） */
  commitDeath(G: import('../types/GameState').GameState, snapshot: SpeciesSnapshot): SaveData {
    const d = this.load();
    const memIds = [...G.memories.entries()].filter(([, m]) => m.unlocked).map(([id]) => id);
    const keep = Math.ceil(memIds.length * CONST.MEMORY_INHERIT);
    const merged = new Set<string>([...d.memories, ...memIds.slice(0, keep)]);
    d.memories = [...merged];
    d.generation = Math.max(d.generation, G.player.generation + 1);
    d.snapshots.unshift(snapshot);
    if (d.snapshots.length > MAX_SNAPSHOTS) d.snapshots.length = MAX_SNAPSHOTS;
    d.lifetime.runs++;
    d.lifetime.eraTransitions += G.analytics.firstEraTransitionAt !== null ? 1 : 0;
    d.lifetime.loopCompletions += G.analytics.loopCompleted ? 1 : 0;
    d.lifetime.crashes += G.analytics.metabolicCrashCount;
    this.save(d);
    return d;
  },
};
