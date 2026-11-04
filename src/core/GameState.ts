import type { GameState } from '../types/GameState';
import { Ev, bus } from './EventBus';

/**
 * 集中状态容器（GDD 4.1：GameState + EventBus）。
 * 全局单例 G，开局时整体重建，血统/埋点等跨局数据由 SaveSystem 注回。
 */
export let G: GameState;

export function setGameState(s: GameState): void {
  G = s;
}

export function getGameState(): GameState {
  return G;
}

export function changeMode(m: GameState['mode']): void {
  if (G.mode === m) return;
  G.mode = m;
  bus.emit(Ev.MODE_CHANGED, m);
  bus.emit(Ev.HUD_DIRTY);
}
