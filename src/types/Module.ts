/** 模块类别（GDD 3.3 外部槽位：躯干/头部/口器/移动/防御/感官 + 代谢） */
export type ModuleCategory =
  | 'trunk'      // 躯干
  | 'head'       // 头部
  | 'mouth'      // 口器
  | 'movement'   // 移动
  | 'defense'    // 防御
  | 'sense'      // 感官
  | 'metabolism';// 代谢

/** 物流节点类型（GDD 3.3 内部物流） */
export type NodeType = 'source' | 'process' | 'storage' | 'sink';

/**
 * 物流系统分层（GDD 3.3 内部物流 / 按物种等级演进）：
 *  消化层 = 摄食→消化→能量池（单细胞即存在，决定代谢产出 P）
 *  循环层 = 心泵/鳃把养分铺到全身（多细胞后出现，铺开全网吞吐）
 *  神经层 = 神经网/神经节（脑化，出现后感知与决策增强）
 *  运动层 = 肌肉束/纤毛等运动器官的动力出口
 * 层级顺序即物种复杂度：解锁的层越多，物流网可分路越多。
 */
export type FlowLayer = 'digest' | 'circulation' | 'nerve' | 'motor';

/**
 * 器官功能槽（v0.6）：同一 slot 的器官互斥——
 * 装上高阶器官会自动"上位替代"低阶器官（低阶被顶掉并返还部分储备）。
 *
 * 设计意图：器官不是无脑堆叠的加法，而是形态演化的**位次竞争**。
 *  口沟 → 基础口器 → 尖牙   （口器位，进食/撕咬）
 *  细胞膜 → 细胞壁 → 外骨骼（防御位）
 *  鞭毛 → 纤毛丛 → 肌肉束  （运动位）
 *  同一位上装更强的，就得放弃旧的——这让"改装"成为真正的取舍。
 *
 * 未声明 slot 的器官（如代谢处理器、储能类）视为**可叠加的独立件**。
 */
export type ModuleSlot =
  | 'mouth'      // 口器位
  | 'defense'    // 防御位
  | 'movement'   // 运动位
  | 'sense'      // 主感官位
  | 'head'       // 神经中枢位
  | 'trunk';     // 躯体位

/** 模块定义（GDD 5.1 modules.json 结构 + 扩展字段） */
export interface ModuleDef {
  id: string;
  name: string;
  era: number;
  category: ModuleCategory;
  volume: number;
  residentDrain: number;
  speedMod: number;
  perceptionMod: number;
  armorMod: number;
  attackMod: number;
  growthCost: number;
  geneFragmentCost: number;
  /** 功能槽：同 slot 互斥，装高阶自动顶掉低阶（不填 = 可叠加） */
  slot?: ModuleSlot;
  /** 槽位内位次：越大越强。安装时若槽内已有更高位次则拒绝，顶替仅向更高位次 */
  tier?: number;
  /** 关键进化：安装并保存后可进入 order = keyTo 的纪元 */
  keyTo?: number;
  /** 先天器官：草履虫级起始形态自带，不可购买/卸载（形态页显示为"天生"） */
  builtIn?: boolean;
  /** 认知解锁：需先获得该物种记忆 */
  requiresMemory?: string;
  memoryHint?: string;
  /** 附带物流节点 */
  node?: { type: NodeType; rate: number; layer?: FlowLayer };
  desc: string;
}
