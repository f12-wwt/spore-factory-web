/** 记忆条目（GDD 4.4 MemoryEntry） */
export interface MemoryEntry {
  id: string;
  name: string;
  /** ??? → 交互后解锁 */
  unlocked: boolean;
  nutrition: number;
  dangerLevel: number;
  firstEra: string;
  interactionCount: number;
}
