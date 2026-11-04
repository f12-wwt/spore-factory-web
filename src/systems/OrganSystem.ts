import type { ModuleSlot } from '../types/Module';
import type { FlowNode } from '../types/GameState';
import { DataStore } from './DataStore';

/**
 * 器官槽位系统（v0.6 / GDD 3.3 外部槽位）：
 *
 * 器官不是无脑堆叠的加法，而是**位次竞争**——
 *  同一功能槽上只能装一件器官，装更强的就得放弃旧的。
 *
 *    口沟 → 基础口器 → 尖牙        （口器位）
 *    细胞膜 → 细胞壁 → 外骨骼      （防御位）
 *    鞭毛 → 纤毛丛 → 肌肉束        （运动位）
 *    化学感毛 → 感光点 → 复眼      （主感官位）
 *    细胞核 → 神经网 → 神经节      （神经中枢位）
 *    细胞质躯干 → 多细胞聚合        （躯体位）
 *
 * 代谢处理器、储能件、附加防御件（骨针触突/尾刺/三叶虫甲片）不占槽位，仍可自由叠加——
 * 它们是"配置"而非"形态位次"，混在一起会堵死物流拓扑的组合空间。
 */

/** 槽位中文名（UI 用） */
export const SLOT_CN: Record<ModuleSlot, string> = {
  mouth: '口器位',
  defense: '防御位',
  movement: '运动位',
  sense: '感官位',
  head: '中枢位',
  trunk: '躯体位',
};

/** 安装结果 */
export type InstallVerdict =
  | { ok: true; replaced: string[] }              // 可安装，replaced 为被顶替的器官 id
  | { ok: false; reason: 'same' | 'weaker'; blocker: string };

/**
 * 判定安装 id 是否可行。
 * @param installed 当前已装器官 id 列表
 */
export function checkInstall(id: string, installed: readonly string[]): InstallVerdict {
  const m = DataStore.module(id);
  if (!m.slot) return { ok: true, replaced: [] };

  const tier = m.tier ?? 0;
  const occupants = installed.filter((x) => {
    if (x === id) return false;
    const d = DataStore.module(x);
    return d.slot === m.slot;
  });

  if (occupants.length === 0) return { ok: true, replaced: [] };

  // 槽内已有更高位次 → 拒绝（不能装弱的上位替代品）
  for (const oc of occupants) {
    if ((DataStore.module(oc).tier ?? 0) >= tier) {
      return { ok: false, reason: 'weaker', blocker: oc };
    }
  }
  // 所有占位者都更弱 → 全部顶替
  return { ok: true, replaced: occupants };
}

/** 该器官会顶替掉哪些已装器官 */
export function replacedBy(id: string, installed: readonly string[]): string[] {
  const v = checkInstall(id, installed);
  return v.ok ? v.replaced : [];
}

/** 某槽位当前的最高位次器官（无则 null） */
export function slotLeader(slot: ModuleSlot, installed: readonly string[]): string | null {
  let best: string | null = null;
  let bestTier = -1;
  for (const id of installed) {
    const d = DataStore.module(id);
    if (d.slot !== slot) continue;
    const t = d.tier ?? 0;
    if (t > bestTier) { best = id; bestTier = t; }
  }
  return best;
}

/** 该槽位的完整升级链（低 → 高），含尚未解锁的 */
export function slotChain(slot: ModuleSlot): { id: string; name: string; tier: number; era: number }[] {
  return DataStore.modules
    .filter((m) => m.slot === slot)
    .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0))
    .map((m) => ({ id: m.id, name: m.name, tier: m.tier ?? 0, era: m.era }));
}

/** 当前已装的槽位分布（UI 展示用） */
export function slotMap(installed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of installed) {
    const d = DataStore.module(id);
    if (d.slot) out[d.slot] = id;
  }
  return out;
}

/**
 * 计算真正参与属性结算的器官列表（v0.6 核心）。
 *
 * 规则：
 *  - 无 slot 的器官（代谢处理器、储能件、附加防御）全部参与；
 *  - 有 slot 的器官，每个槽位只有 **tier 最高** 的那件参与；
 *  - 其余同槽低阶件仍留在 mods 里（先天器官不可拆），但属性/体积/消耗不再计入。
 *
 * 这样"装上尖牙就告别口沟的属性"是自动成立的，无需物理拆除。
 */
export function activeModules(installed: readonly string[]): string[] {
  const best = new Map<ModuleSlot, { id: string; tier: number }>();
  const out: string[] = [];
  for (const id of installed) {
    const d = DataStore.module(id);
    if (!d.slot) { out.push(id); continue; }
    const tier = d.tier ?? 0;
    const cur = best.get(d.slot);
    if (!cur || tier > cur.tier) best.set(d.slot, { id, tier });
  }
  for (const { id } of best.values()) out.push(id);
  return out;
}

/** 被覆盖（同槽低阶、仍在体内但不生效）的器官 id */
export function shadowedModules(installed: readonly string[]): string[] {
  const active = new Set(activeModules(installed));
  return installed.filter((id) => !active.has(id));
}

/**
 * 物流节点的「上位替代」（v0.6）：器官被顶替时，它携带的物流节点也必须让位。
 *
 * 背景：口沟（先天 source 8）与基础口器（source 8）同属消化层，
 * 若两个节点并存，消化层就有**两条并行入口**——吞吐凭空翻倍，
 * 而先天节点永远无法拆除（builtIn），玩家无法靠改装改变这一事实。
 *
 * 规则：同槽位只保留 tier 最高的那一个节点为**在役（live）**，
 * 其余为**隐退（dormant）**。隐退节点不参与 services/autoWire 计算，
 * 但仍留在网里（先天节点无法物理移除），以便卸下高阶器官后原位复活。
 *
 * 完全由 nodes 自身推导（moduleId → slot/tier），不需要外部传入已装器官表，
 * 因此 Logistics 的所有计算入口都能自行保持口径一致。
 */
export function liveNodeIds(nodes: readonly FlowNode[]): Set<string> {
  const live = new Set<string>();
  const best = new Map<ModuleSlot, { id: string; tier: number }>();
  const slotOfNode = new Map<string, ModuleSlot>();
  for (const n of nodes) {
    live.add(n.id); // 无 moduleId 的基础节点（mouth/stomach/energy…）恒为在役
    if (!n.moduleId) continue;
    const d = DataStore.module(n.moduleId);
    if (!d.slot) continue;
    slotOfNode.set(n.id, d.slot);
    const tier = d.tier ?? 0;
    const cur = best.get(d.slot);
    if (!cur || tier > cur.tier) best.set(d.slot, { id: n.id, tier });
  }
  // 同槽位只保留最高位次节点的 id 在役
  for (const [slot, win] of best) {
    for (const [nid, sl] of slotOfNode) {
      if (sl === slot && nid !== win.id) live.delete(nid);
    }
  }
  return live;
}

/** 该节点是否已被同槽高阶器官顶替（隐退） */
export function isDormant(n: FlowNode, live: ReadonlySet<string>): boolean {
  return !live.has(n.id);
}

/**
 * 从待编辑集合中移除器官，同时清掉它的物流节点与相连管线。
 * 就地修改传入的数组/对象（编辑器 pend 与运行时共用同一语义）。
 *
 * 内置器官（builtIn，如先天口沟/细胞膜）**不可被拆除**——但它们都占着低阶槽位，
 * 高阶器官（外骨骼/尖牙）通过 tier 覆盖其属性而来，因此 checkInstall 返回的
 * replaced 列表需要过滤掉 builtIn——上位替代是「覆盖」而非「拆除」。
 */
export function detach(
  id: string,
  mods: string[],
  nodes: FlowNode[],
  pipes: { a: string; b: string; level: number; cap: number }[],
): boolean {
  if (DataStore.module(id).builtIn) return false;
  const idx = mods.lastIndexOf(id);
  if (idx < 0) return false;
  mods.splice(idx, 1);
  const nIdx = nodes.findIndex((n) => n.moduleId === id);
  if (nIdx >= 0) {
    const nid = nodes[nIdx].id;
    nodes.splice(nIdx, 1);
    for (let i = pipes.length - 1; i >= 0; i--) {
      if (pipes[i].a === nid || pipes[i].b === nid) pipes.splice(i, 1);
    }
  }
  return true;
}

/* ---------------- 器官协同（v0.8） ---------------- */

/** 协同加成汇总 */
export interface SynergyTotals {
  attack: number;
  armor: number;
  speed: number;
  vision: number;
}

/**
 * 器官组合协同（v0.8）。
 *
 * 注意：同类别器官在 v0.8 已改为互斥（上位替代），因此协同必须是
 * **跨类别组合**——两类功能器官同时装配才触发，鼓励"专精 + 搭配"而非无脑堆叠。
 *
 * 放在 OrganSystem 而非 CombatDepth，避免 Metab → CombatDepth → Metab 循环依赖。
 */
interface ComboDef {
  catA: string;
  catB: string;
  totals: SynergyTotals;
  label: string;
  detail: string;
}

const COMBOS: ComboDef[] = [
  {
    catA: 'mouth', catB: 'movement',
    totals: { attack: 4, armor: 0, speed: 0, vision: 0 },
    label: '突袭', detail: '攻击 +4',
  },
  {
    catA: 'defense', catB: 'mouth',
    totals: { attack: 2, armor: 3, speed: 0, vision: 0 },
    label: '重装', detail: '攻击 +2 · 护甲 +3',
  },
  {
    catA: 'metabolism', catB: 'defense',
    totals: { attack: 0, armor: 4, speed: 0, vision: 0 },
    label: '厚积', detail: '护甲 +4',
  },
  {
    catA: 'movement', catB: 'sense',
    totals: { attack: 0, armor: 0, speed: 10, vision: 10 },
    label: '猎手', detail: '速度 +10 · 视野 +10',
  },
  {
    catA: 'trunk', catB: 'metabolism',
    totals: { attack: 0, armor: 0, speed: 6, vision: 0 },
    label: '代谢耦合', detail: '速度 +6',
  },
  {
    catA: 'head', catB: 'sense',
    totals: { attack: 0, armor: 0, speed: 0, vision: 20 },
    label: '神经感知', detail: '视野 +20',
  },
  {
    catA: 'trunk', catB: 'defense',
    totals: { attack: 0, armor: 2, speed: 0, vision: 0 },
    label: '骨架支撑', detail: '护甲 +2',
  },
];

/** 已激活器官的类别集合（仅统计后天装配的器官，先天件不算协同） */
function categorySet(installed: readonly string[]): Set<string> {
  const s = new Set<string>();
  for (const id of activeModules(installed)) {
    const d = DataStore.module(id);
    if (d.builtIn) continue; // 先天器官人人都有，参与协同等于白送
    s.add(d.category);
  }
  return s;
}

/** 计算跨类别组合协同加成 */
export function synergyTotals(installed: readonly string[]): SynergyTotals {
  const cats = categorySet(installed);
  const sum: SynergyTotals = { attack: 0, armor: 0, speed: 0, vision: 0 };
  for (const c of COMBOS) {
    if (cats.has(c.catA) && cats.has(c.catB)) {
      sum.attack += c.totals.attack;
      sum.armor += c.totals.armor;
      sum.speed += c.totals.speed;
      sum.vision += c.totals.vision;
    }
  }
  return sum;
}

/** 协同描述列表（HUD/编辑器展示用） */
export function synergyDescriptions(installed: readonly string[]): string[] {
  const cats = categorySet(installed);
  const out: string[] = [];
  for (const c of COMBOS) {
    if (cats.has(c.catA) && cats.has(c.catB)) {
      out.push(`${c.label}（${c.catA}+${c.catB}）：${c.detail}`);
    }
  }
  return out;
}