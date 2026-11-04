/**
 * 战斗深度（v0.8）：技能 + 状态效果 + 器官协同
 *
 * 技能通过键盘触发（Q/E/R），消耗能量或爆发池，与器官绑定——
 * 没有对应器官就无法使用，这让"装什么器官"直接影响战斗风格。
 *
 * 状态效果作用于玩家与实体，每帧由 CombatDepth.update 驱动。
 */

/** 状态效果类型 */
export type StatusKind = 'poison' | 'stun' | 'harden' | 'slow';

/** 挂在实体/玩家身上的状态效果实例 */
export interface StatusEffect {
  kind: StatusKind;
  /** 剩余秒数 */
  t: number;
  /** 效果强度（poison=每秒伤害, harden=护甲加成, slow=减速比例） */
  value: number;
  /** 叠加层数（poison 可叠 3 层） */
  stacks: number;
}

/** 技能定义 */
export interface SkillDef {
  id: string;
  name: string;
  key: string;
  desc: string;
  /** 能量消耗（0 = 不消耗能量） */
  energyCost: number;
  /** 爆发池消耗（0 = 不消耗爆发） */
  burstCost: number;
  /** 冷却秒数 */
  cooldown: number;
  /** 解锁所需器官（任一满足即可） */
  requires: string[];
}

/** 全部可用技能 */
export const SKILLS: SkillDef[] = [
  {
    id: 'toxin_spray',
    name: '毒素喷射',
    key: 'Q',
    desc: '向前方扇形喷射毒素：造成伤害 + 中毒（每秒掉血，可叠 3 层）',
    energyCost: 20,
    burstCost: 0,
    cooldown: 4,
    requires: ['enzymatic_gland', 'true_gut'],
  },
  {
    id: 'harden',
    name: '硬化',
    key: 'E',
    desc: '体壁硬化 3 秒：护甲 +50%、免疫击退、受到伤害 -30%',
    energyCost: 0,
    burstCost: 15,
    cooldown: 8,
    requires: ['cell_wall', 'exoskeleton', 'trilo_plate'],
  },
  {
    id: 'lunge',
    name: '猛冲',
    key: 'R',
    desc: '向前猛冲 200px：路径上所有敌人受 2×攻击伤害',
    energyCost: 0,
    burstCost: 10,
    cooldown: 5,
    requires: ['flagellum', 'cilia_cluster', 'muscle_fiber'],
  },
];

/** 器官协同加成 */
export interface SynergyBonus {
  attackBonus: number;    // 额外攻击力
  armorBonus: number;     // 额外护甲
  speedBonus: number;     // 额外速度
  visionBonus: number;    // 额外视野
  description: string;
}
