/**
 * 物种解剖坐标系（v0.6）
 *
 * 内部物流页的底座不再是抽象的方框分区，而是**物种本体俯视图**：
 * 身体轮廓按当前体积与已装器官实时绘制，器官节点直接长在解剖位置上。
 *
 * 坐标系（原点在身体中心，**+x = 正前方（朝向），+y = 侧后方**）：
 *   屏幕映射：screenX = cx + anatX，screenY = cy + anatY
 *   俯视视角下，身体朝向屏幕右方，因此"正前方"就是圆的右侧 3 点钟方向。
 *
 * 这样做的意义：物流拓扑与形态长得一样，玩家能一眼看出
 * "口器在嘴的位置、胃在腹腔、心脏偏前腹、脑在背侧"，
 * 而不是面对四个互不相关的矩形分区去猜哪个是哪个。
 */

export interface Anatomy {
  /** 身体中心（画布坐标） */
  cx: number;
  cy: number;
  /** 身体半径（体细胞外缘） */
  radius: number;
  /** 正前方单位向量（俯视：指向屏幕右方） */
  facingX: number;
  facingY: number;
}

/** 各器官的解剖位置（相对身体半径的比例，+x 为正前方）
 *
 * 取值依据：口器在嘴（最前）、胃在腹腔偏后、心偏前腹、脑在背侧中后、
 * 循环器官沿体轴铺开、运动器官在后侧（尾部发力点）、废物出口在后端。
 */
export const ORGAN_ANCHOR: Record<string, { x: number; y: number }> = {
  // —— 口器：正前方（用户明确要求「口沟位于圆形正前方」）——
  oral_groove:     { x: 0.86, y: 0.00 },
  mouth_basic:     { x: 0.86, y: 0.00 },
  fang:            { x: 0.94, y: 0.00 },

  // —— 消化：从前向后串联，胃在腹腔中后、废物出口在尾端 ——
  stomach:         { x: 0.10, y: 0.16 },
  primitive_stomach: { x: 0.06, y: 0.18 },
  enzymatic_gland: { x: -0.16, y: 0.26 },
  true_gut:        { x: -0.30, y: 0.30 },
  anal_pore:       { x: -0.84, y: 0.06 },

  // —— 能量存储：体中央偏下（细胞质基质）——
  energy:          { x: -0.12, y: -0.30 },

  // —— 循环：前腹偏左（心在前腹腔正中偏左，鳃在更前）——
  primitive_heart: { x: 0.34, y: -0.30 },
  aerogenase:      { x: 0.46, y: 0.34 },
  gill:            { x: 0.62, y: -0.40 },

  // —— 神经：背侧中后（贴近体表，俯视看得见）——
  nucleus:         { x: -0.34, y: -0.62 },
  nerve_net:       { x: -0.30, y: -0.56 },
  ganglion:        { x: -0.52, y: -0.44 },
  brain:           { x: -0.56, y: -0.40 },

  // —— 运动：后侧（尾部发力点）——
  muscle:          { x: -0.58, y: 0.44 },
  muscle_hub:      { x: -0.52, y: 0.46 },
  muscle_fiber:    { x: -0.72, y: 0.34 },
  flagellum:       { x: -0.92, y: 0.10 },
  cilia_cluster:   { x: -0.30, y: 0.82 },
};

/** 兜底：未知器官按所在层摆在体侧 */
const LAYER_FALLBACK: Record<string, { x: number; y: number }> = {
  digest:      { x: -0.10, y: 0.55 },
  circulation: { x: 0.30, y: 0.62 },
  nerve:       { x: -0.45, y: -0.70 },
  motor:       { x: -0.70, y: 0.60 },
};

/**
 * 解剖位 → 画布坐标。
 * @param id 节点 id（模块节点取 moduleId，基础节点取 id）
 * @param layer 节点所属层（未知器官兜底用）
 */
export function anchorOf(id: string, moduleId: string | undefined, layer: string, a: Anatomy): { x: number; y: number } {
  const key = moduleId && ORGAN_ANCHOR[moduleId] ? moduleId : id;
  const r = ORGAN_ANCHOR[key] ?? LAYER_FALLBACK[layer] ?? LAYER_FALLBACK.digest;
  return {
    x: a.cx + r.x * a.radius,
    y: a.cy + r.y * a.radius,
  };
}

/** 多个节点落在同一位时按序号做偏移散开，避免完全重叠 */
export function spread(base: { x: number; y: number }, idx: number, gap: number): { x: number; y: number } {
  if (idx <= 0) return base;
  // 1→右上, 2→右下, 3→左上, 4→左下
  const off = [
    { x: gap * 0.8, y: -gap * 0.8 },
    { x: gap * 0.8, y: gap * 0.8 },
    { x: -gap * 0.8, y: -gap * 0.8 },
    { x: -gap * 0.8, y: gap * 0.8 },
    { x: 0, y: -gap * 1.2 },
  ];
  const o = off[(idx - 1) % 5];
  return { x: base.x + o.x, y: base.y + o.y };
}