export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

export const randInt = (lo: number, hi: number): number => Math.floor(rand(lo, hi + 1));

/** 平方距离（热路径比较用，免开方） */
export const dist2 = (x1: number, y1: number, x2: number, y2: number): number => {
  const dx = x2 - x1, dy = y2 - y1;
  return dx * dx + dy * dy;
};

export const dist = (x1: number, y1: number, x2: number, y2: number): number =>
  Math.sqrt(dist2(x1, y1, x2, y2));

export const angleTo = (x1: number, y1: number, x2: number, y2: number): number =>
  Math.atan2(y2 - y1, x2 - x1);

/** 线段到点最短距离（编辑器连线拾取） */
export function pointSegDist(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** 确定性伪随机（地图生态生成，同 seed 同布局） */
export function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const fmtNum = (v: number, digits = 0): string => {
  const p = 10 ** digits;
  return (Math.round(v * p) / p).toFixed(digits).replace(/\.0+$/, '');
};

export const fmtTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
