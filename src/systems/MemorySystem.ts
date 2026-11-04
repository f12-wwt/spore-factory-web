import type { GameState } from '../types/GameState';
import { DataStore } from './DataStore';
import { Ev, bus } from '../core/EventBus';
import { Run, CONST } from './RunState';

/**
 * 认知记忆系统（GDD 3.5 / T5）：
 * 首次接触显示 ???；进食/攻击/观察后解锁；
 * 条目：名称、类型、营养、危险等级、首次纪元、互动次数；
 * 跨代继承 60%（血统），纪元过渡继承 100%。
 */
export const MemorySys = {
  ensure(G: GameState, speciesId: string): void {
    if (!G.memories.has(speciesId)) {
      G.memories.set(speciesId, DataStore.memoryOf(speciesId));
    }
  },

  /** 互动（进食/攻击/观察）累积，满阈值解锁 */
  interact(G: GameState, speciesId: string, amount = 1): boolean {
    this.ensure(G, speciesId);
    const mem = G.memories.get(speciesId)!;
    mem.interactionCount += amount;
    if (!mem.unlocked && mem.interactionCount >= 1) {
      mem.unlocked = true;
      mem.firstEra = DataStore.era(G.eraIndex).name;
      bus.emit(Ev.MEMORY_UNLOCKED, mem);
      bus.emit(Ev.TOAST, { text: `🧠 认知解锁：【${mem.name}】已写入记忆库`, kind: 'good' });
      return true;
    }
    return false;
  },

  count(G: GameState): number {
    let n = 0;
    for (const m of G.memories.values()) if (m.unlocked) n++;
    return n;
  },

  /** 纪元过渡：记忆 100% 保留（GDD 3.6） */
  onEraTransition(_G: GameState): void {
    // 记忆随玩家对象延续，无需裁剪
  },

  /** 死亡：提取可遗传记忆 id（60% 随机保留） */
  extractInheritable(G: GameState): string[] {
    const ids = [...G.memories.entries()].filter(([, m]) => m.unlocked).map(([id]) => id);
    const keep = Math.ceil(ids.length * CONST.MEMORY_INHERIT);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids.slice(0, keep);
  },

  /** 记录味觉/捕食互动（供里程碑统计） */
  noteTaste(G: GameState, speciesId: string): void {
    Run.speciesTasted.add(speciesId);
    this.interact(G, speciesId);
  },

  notePredation(G: GameState, speciesId: string): void {
    Run.speciesPredated.add(speciesId);
    this.interact(G, speciesId);
  },
};
