import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SaveSystem } from '../src/systems/SaveSystem';
import { newRun } from '../src/systems/RunState';
import { DataStore } from '../src/systems/DataStore';
import { esc } from '../src/core/escape';

/** 内存版 localStorage：模拟同源页面写入的任意存档内容 */
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

const KEY = 'sfw:save:v1';
const VALID_ID = DataStore.speciesList[0].id;

beforeEach(() => {
  stubLocalStorage();
});

describe('安全回归：污染存档不得导致启动失败或脏数据扩散', () => {
  it('未知记忆 id 被数据表白名单过滤，newRun 不抛异常', () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1, generation: 2,
      memories: ['<img src=x onerror=alert(1)>', VALID_ID],
      snapshots: [],
    }));
    const d = SaveSystem.load();
    expect(d.memories).toEqual([VALID_ID]);
    expect(() => newRun(d.memories, d.generation)).not.toThrow();
    expect(newRun(d.memories, d.generation).memories.size).toBeGreaterThanOrEqual(0);
  });

  it('非法代数 / 版本不匹配 / 快照超限 → 整体回退默认存档', () => {
    localStorage.setItem(KEY, JSON.stringify({ generation: -1, memories: [], snapshots: [] }));
    expect(SaveSystem.load().generation).toBe(0);
    localStorage.setItem(KEY, JSON.stringify({ version: 999, generation: 5, memories: [], snapshots: [] }));
    expect(SaveSystem.load().generation).toBe(0);
    const many = Array.from({ length: 20 }, () => ({ speciesName: 'x' }));
    localStorage.setItem(KEY, JSON.stringify({ version: 1, generation: 5, memories: [], snapshots: many }));
    expect(SaveSystem.load().generation).toBe(0);
  });

  it('lifetime 脏字段逐项清洗，不把字符串/NaN 带进结算', () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1, generation: 1, memories: [], snapshots: [],
      lifetime: { runs: 'many', crashes: -3, eraTransitions: 2 },
    }));
    const l = SaveSystem.load().lifetime;
    expect(l.runs).toBe(0);
    expect(l.crashes).toBe(0);
    expect(l.eraTransitions).toBe(2);
    expect(Number.isFinite(l.loopCompletions)).toBe(true);
  });
});

describe('安全回归：innerHTML 动态值必须转义', () => {
  it('esc 覆盖 & < > 双引号 单引号', () => {
    const payload = `<img src=x onerror="alert('x')">&`;
    const out = esc(payload);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
    expect(out.startsWith('&lt;img')).toBe(true);
    expect(out).toContain('&amp;');
  });

  it('esc 处理非字符串输入不抛异常', () => {
    expect(esc(0)).toBe('0');
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
  });
});
