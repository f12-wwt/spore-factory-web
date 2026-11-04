import type { GameMode, Disaster } from '../types/GameState';
import type { EraDef } from '../types/Era';
import type { MemoryEntry } from '../types/Memory';
import type { SpeciesDef } from '../systems/DataStore';

/** 游戏事件名常量 */
export const Ev = {
  MODE_CHANGED: 'mode:changed',
  ERA_ADVANCED: 'era:advanced',
  ERA_MILESTONE_READY: 'era:milestoneReady',
  DISASTER_WARN: 'disaster:warn',
  DISASTER_BURST: 'disaster:burst',
  DISASTER_END: 'disaster:end',
  MEMORY_UNLOCKED: 'memory:unlocked',
  TASTE_CARD: 'taste:card',
  PLAYER_DIED: 'player:died',
  METABOLIC_CRASH: 'metabolic:crash',
  TOAST: 'ui:toast',
  HUD_DIRTY: 'hud:dirty',
  EDITOR_OPEN: 'editor:open',
  EDITOR_CLOSE: 'editor:close',
  MEMORY_PANEL_OPEN: 'memoryPanel:open',
  ERA_PANEL_OPEN: 'eraPanel:open',
  MENU_START: 'menu:start',
  RUN_COMPLETE: 'run:complete',
} as const;

/** Toast 提示负载（kind 与 style.css 的 .toast 类对应） */
export interface ToastPayload {
  text: string;
  kind: 'info' | 'good' | 'warn' | 'bad';
}

/**
 * 事件负载表（GDD 4.1）：事件名 → 负载类型。
 * emit/on 由此获得全类型安全，调用处不再需要 `as` 强转。
 */
export interface EventPayloadMap {
  [Ev.MODE_CHANGED]: GameMode;
  [Ev.ERA_ADVANCED]: EraDef;
  [Ev.ERA_MILESTONE_READY]: EraDef;
  [Ev.DISASTER_WARN]: Disaster;
  [Ev.DISASTER_BURST]: Disaster;
  [Ev.DISASTER_END]: Disaster;
  [Ev.MEMORY_UNLOCKED]: MemoryEntry;
  [Ev.TASTE_CARD]: SpeciesDef;
  [Ev.PLAYER_DIED]: undefined;
  [Ev.METABOLIC_CRASH]: undefined;
  [Ev.TOAST]: ToastPayload;
  [Ev.HUD_DIRTY]: undefined;
  [Ev.EDITOR_OPEN]: { milestone?: boolean };
  [Ev.EDITOR_CLOSE]: undefined;
  [Ev.MEMORY_PANEL_OPEN]: undefined;
  [Ev.ERA_PANEL_OPEN]: undefined;
  [Ev.MENU_START]: undefined;
  [Ev.RUN_COMPLETE]: EraDef;
}

/** 内部存储用的擦除类型（仅本文件可见的受控强转） */
type AnyHandler = (payload: never) => void;

/** 轻量事件总线：类型安全的 on/off/emit */
export class EventBus {
  private map = new Map<string, Set<AnyHandler>>();

  on<K extends keyof EventPayloadMap>(event: K, fn: (payload: EventPayloadMap[K]) => void): void {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(fn as AnyHandler);
  }

  off<K extends keyof EventPayloadMap>(event: K, fn: (payload: EventPayloadMap[K]) => void): void {
    this.map.get(event)?.delete(fn as AnyHandler);
  }

  emit<K extends keyof EventPayloadMap>(
    event: K,
    ...args: EventPayloadMap[K] extends undefined ? [] : [EventPayloadMap[K]]
  ): void {
    const set = this.map.get(event);
    if (!set) return;
    const payload = args[0] as EventPayloadMap[K];
    for (const fn of set) (fn as (p: EventPayloadMap[K]) => void)(payload);
  }

  clear(): void {
    this.map.clear();
  }
}

/** 全局总线：UI 与系统解耦的唯一通道 */
export const bus = new EventBus();
