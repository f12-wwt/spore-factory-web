import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SaveSystem } from '../src/systems/SaveSystem';
import { newRun } from '../src/systems/RunState';
import { CONST } from '../src/systems/RunState';
import type { GameState } from '../src/types/GameState';

/** 内存版 localStorage（node 环境无浏览器存储） */
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

/** 造一个带 N 个已解锁记忆的对局 */
function runWithUnlocked(ids: string[]): GameState {
  const G = newRun();
  for (const id of ids) {
    const m = G.memories.get(id);
    if (m) { m.unlocked = true; m.interactionCount = 1; }
    else G.memories.set(id, { id, name: id, unlocked: true, nutrition: 1, dangerLevel: 1, firstEra: '太古宙', interactionCount: 1 });
  }
  return G;
}

const SPECIES_5 = ['microbe_food', 'proto_worm', 'vent_stalker', 'algae_mat', 'soft_jelly'];

beforeEach(() => {
  stubLocalStorage();
});

describe('存档往返（SaveSystem）', () => {
  it('save → load 字段一致，带版本号', () => {
    SaveSystem.save({
      version: 1, generation: 3, memories: ['microbe_food'], snapshots: [],
      lifetime: { runs: 2, eraTransitions: 1, reproductions: 1, loopCompletions: 0, crashes: 4 },
    });
    const d = SaveSystem.load();
    expect(d.generation).toBe(3);
    expect(d.memories).toEqual(['microbe_food']);
    expect(d.lifetime.crashes).toBe(4);
    expect(d.version).toBe(1);
  });

  it('空存档 → 默认值', () => {
    const d = SaveSystem.load();
    expect(d.generation).toBe(0);
    expect(d.memories).toEqual([]);
    expect(d.snapshots).toEqual([]);
    expect(d.lifetime.runs).toBe(0);
  });

  it('损坏 JSON → 回退默认值，不抛异常', () => {
    localStorage.setItem('sfw:save:v1', '{oops not json');
    expect(() => SaveSystem.load()).not.toThrow();
    expect(SaveSystem.load().generation).toBe(0);
  });

  it('结构不合法（memories 不是字符串数组）→ 回退默认值', () => {
    localStorage.setItem('sfw:save:v1', JSON.stringify({ generation: 2, memories: 'not-array', snapshots: [] }));
    expect(SaveSystem.load().generation).toBe(0);
  });

  it('lifetime 字段类型损坏 → 回退默认值', () => {
    localStorage.setItem('sfw:save:v1', JSON.stringify({
      generation: 1, memories: [], snapshots: [], lifetime: { runs: 'many' },
    }));
    expect(SaveSystem.load().lifetime.runs).toBe(0);
  });
});

describe('死亡落盘与血统遗传（GDD 3.6）', () => {
  it('commitDeath：代数 +1，记忆按 60% 入库，快照置顶且上限 8', () => {
    const G = runWithUnlocked(SPECIES_5);
    G.player.generation = 1;
    const snap = { version: 1, speciesName: '玩家物种', era: '太古宙', morphology: {}, networkSummary: '', cognitionTags: [], behavior: { aggression: 0, predation: 0, social: 0, migration: 0, reproduction: 0 }, historicalScore: 10, strategyTag: '生存' };
    for (let i = 0; i < 10; i++) {
      const d = SaveSystem.commitDeath(G, { ...snap, historicalScore: i });
      expect(d.snapshots.length).toBeLessThanOrEqual(8);
    }
    const d = SaveSystem.load();
    expect(d.generation).toBe(2); // 1 + 1
    expect(d.memories.length).toBe(Math.ceil(5 * CONST.MEMORY_INHERIT)); // 5 种解锁 → 3 种遗传
    expect(d.snapshots.length).toBe(8);
    expect(d.lifetime.runs).toBe(10);
  });

  it('newRun：血统记忆按 60% 继承，代数注入', () => {
    const G = newRun(SPECIES_5, 4);
    expect(G.player.generation).toBe(4);
    expect(G.memories.size).toBe(Math.ceil(5 * CONST.MEMORY_INHERIT));
    for (const m of G.memories.values()) {
      expect(m.unlocked).toBe(true);
    }
  });

  it('空血统 → 零继承', () => {
    const G = newRun([], 0);
    expect(G.memories.size).toBe(0);
  });
});

describe('开局初始化（GDD 3.8 公式）', () => {
  it('初始生命 = 体积×10 + 基础 30（不被钳制）', () => {
    const G = newRun();
    const expected = CONST.BASE_HP + G.player.bodyVol * CONST.HP_PER_VOL;
    expect(G.player.hpMax).toBe(expected);
    expect(G.player.hp).toBe(expected);
  });
});
