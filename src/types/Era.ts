/** 里程碑类型（GDD 3.7 纪元里程碑） */
export type MilestoneType =
  | 'survive'     // 存活 value 秒（游戏内时长）
  | 'energy'      // 当前能量达到 value
  | 'memoryCount' // 记忆库 ≥ value 种
  | 'foodTypes'   // 品尝过 value 种食物
  | 'predation'   // 捕食过 value 种生物
  | 'volume'      // 体积 ≥ value
  | 'module'      // 已安装 moduleId
  | 'disasterSurvived'; // 从 value 指定灾害中幸存

export interface Milestone {
  type: MilestoneType;
  value: number;
  /** type === 'module' | 'disasterSurvived' 时的目标 id */
  target?: string;
  desc: string;
}

/** 纪元定义（GDD 5.2 eras.json 结构 + 扩展字段） */
export interface EraDef {
  id: string;
  name: string;
  en: string;
  order: number;
  volumeMin: number;
  volumeMax: number;
  speedMin: number;
  speedMax: number;
  /** 纪元目标时长（游戏内分钟，用于节奏基准与存活里程碑参考） */
  durationMinutes: number;
  milestones: Milestone[];
  /** 过渡事件描述 */
  transitionEvent: string;
  /** 关键进化模块：装上并保存才进入下一纪元；null = 由条件（代谢效率）自动判定 */
  keyModule: string | null;
  /** 过渡/繁殖继承比例（GDD 3.6） */
  inherit: { memory: number; network: number; volume: number; growth: number };
  palette: { bg: string; bgAlt: string; food: string; accent: string; fog: string; player: string };
  spawn: { food: number; neutral: number; predator: number };
  disasters: string[];
}
