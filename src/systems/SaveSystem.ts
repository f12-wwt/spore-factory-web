import type { SpeciesSnapshot } from '../types/Snapshot';
import { CONST } from './RunState';

/**
 * 存档系统（GDD T14 / 2.1 本地 localStorage）：
 * 血统（记忆/代数/快照池）、聚合埋点、设置。
 * 读档带结构校验：损坏/异构 JSON 视为无效存档回退默认值，不把脏字段带进游戏。
 */
const KEY = 'sfw:save:v1';
const VERSION = 1;

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

/** 结构校验（写入面字段类型必须匹配；lifetime 允许缺省补齐） */
function isValid(d: unknown): d is SaveData {
  if (typeof d !== 'object' || d === null) return false;
  const x = d as Record<string, unknown>;
  const lifetimeOk = x.lifetime === undefined
    || (typeof x.lifetime === 'object' && x.lifetime !== null
      && Object.values(x.lifetime as object).every(v => typeof v === 'number'));
  return typeof x.generation === 'number'
    && Number.isFinite(x.generation)
    && Array.isArray(x.memories)
    && x.memories.every(m => typeof m === 'string')
    && Array.isArray(x.snapshots)
    && (x.version === undefined || typeof x.version === 'number')
    && lifetimeOk;
}

export const SaveSystem = {
  load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw) as unknown;
        if (!isValid(d)) return defaultSave();
        return {
          version: d.version ?? VERSION,
          generation: d.generation,
          memories: d.memories,
          snapshots: d.snapshots,
          lifetime: d.lifetime ?? defaultSave().lifetime,
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
    if (d.snapshots.length > 8) d.snapshots.length = 8;
    d.lifetime.runs++;
    d.lifetime.eraTransitions += G.analytics.firstEraTransitionAt !== null ? 1 : 0;
    d.lifetime.loopCompletions += G.analytics.loopCompleted ? 1 : 0;
    d.lifetime.crashes += G.analytics.metabolicCrashCount;
    this.save(d);
    return d;
  },
};
