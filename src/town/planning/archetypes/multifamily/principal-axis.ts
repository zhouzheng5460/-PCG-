// Archetype 私有 · 可建区主轴（TECH-04）
//
// ## 为什么需要它
//
// 围合式住宅的语法是"**沿临街方向**排 bar、围着院子转"。这个语法隐含一个前提：
// 地块的展开方向和它的临街方向大体一致。
//
// 但城市里有一类地块专门打破这个前提 —— **人字形 / boomerang 地块**：
// 临街只有 20~27 m，而地块真正展开的方向有 60~150 m，
// 而且两者差了 40°~90°。在这类地块上按 frontage 排 bar，
// 出来的不是"围合"，而是几条断头纸片 + 一大片空院子。
//
// ## 口径
//
// 用**最小外接矩形（OBB）的长轴**，不用 PCA：
//   · OBB 的长轴是"这块地朝哪个方向展开"，肉眼可解释；
//   · PCA 在 L 形 / 人字形上会被两个臂拉成一个不存在的平均方向；
//   · OBB 对同一输入永远给同一个答案（可复现）。
//
// **本文件是 archetype 私有实现**：主轴不进 SiteContext、不进 SitePlanCandidate、
// 不进 LayoutDiagnostics（Freeze §2 / §3 的键集合不变）。
// 它只是"这条地块要用另一套朝向"的一次性判断依据。

import { Pt } from '../../../../core/geom';
import type { PlanSurface } from '../../core/surface';

export interface PrincipalAxis {
  /** 长轴单位向量（世界坐标） */
  major: Pt;
  /** 短轴单位向量（长轴逆时针 90°） */
  minor: Pt;
  /** 长边长度（世界单位） */
  majorExtent: number;
  /** 短边长度（世界单位） */
  minorExtent: number;
  /** 长轴与短轴的夹角（度，取锐角） */
  angleDeg: number;
  /** OBB 四角，**按长轴坐标系**给出：p0 = (uMin,vMin)，p1 = (uMax,vMin)，p2 = (uMax,vMax)，p3 = (uMin,vMax) */
  rect: Pt[];
}

/** 凸包（Andrew monotone chain），按逆时针返回 */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice();
  const pts = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper).map((p) => new Pt(p.x, p.y));
}

/**
 * 最小外接矩形（OBB）。
 *
 * 经典结论：最小面积外接矩形一定有一条边与凸包的某条边重合，
 * 所以只要遍历凸包每条边当候选轴、投影取范围，取面积最小者即可。
 *
 * 返回的 `rect` 统一按**长轴坐标系**给出（u = 长轴，v = 短轴），
 * 调用方不必再关心"这条候选轴到底是不是长轴"。
 */
export function orientedBBox(ring: Pt[]): { rect: Pt[]; major: Pt; minor: Pt; majorExtent: number; minorExtent: number } | null {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;

  let bestU = new Pt(1, 0);
  let bestV = new Pt(0, 1);
  let bestArea = Infinity;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const vx = -uy;
    const vy = ux;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of hull) {
      const du = (p.x - a.x) * ux + (p.y - a.y) * uy;
      const dv = (p.x - a.x) * vx + (p.y - a.y) * vy;
      if (du < u0) u0 = du;
      if (du > u1) u1 = du;
      if (dv < v0) v0 = dv;
      if (dv > v1) v1 = dv;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area >= bestArea) continue;
    bestArea = area;
    bestU = new Pt(ux, uy);
    bestV = new Pt(vx, vy);
  }
  if (!Number.isFinite(bestArea)) return null;

  // 统一到长轴坐标系
  const ext = (axis: Pt) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of hull) {
      const d = p.x * axis.x + p.y * axis.y;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return { lo, hi, len: hi - lo };
  };
  const eu = ext(bestU);
  const ev = ext(bestV);
  const majorIsU = eu.len >= ev.len;
  const major = majorIsU ? bestU : bestV;
  const minor = majorIsU ? bestV : bestU;
  const em = majorIsU ? eu : ev;
  const en = majorIsU ? ev : eu;
  const corner = (u: number, v: number) => new Pt(major.x * u + minor.x * v, major.y * u + minor.y * v);

  return {
    rect: [corner(em.lo, en.lo), corner(em.hi, en.lo), corner(em.hi, en.hi), corner(em.lo, en.hi)],
    major,
    minor,
    majorExtent: em.len,
    minorExtent: en.len,
  };
}

/** 可建区主轴（长轴 + 短轴 + 展向 + OBB 四角） */
export function principalAxisOf(buildable: PlanSurface): PrincipalAxis | null {
  const obb = orientedBBox(buildable.outer);
  if (!obb) return null;
  const ang = (Math.atan2(obb.major.y, obb.major.x) * 180) / Math.PI;
  return {
    major: obb.major,
    minor: obb.minor,
    majorExtent: obb.majorExtent,
    minorExtent: obb.minorExtent,
    angleDeg: ((ang % 180) + 180) % 180,
    rect: obb.rect,
  };
}

/** 两个方向之间的夹角（度，0~90） */
export function angleBetween(a: Pt, b: Pt): number {
  const dot = a.x * b.x + a.y * b.y;
  const la = Math.hypot(a.x, a.y) || 1;
  const lb = Math.hypot(b.x, b.y) || 1;
  const c = Math.max(-1, Math.min(1, dot / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * 轴失配判据。
 *
 * 触发条件**故意保守**（两个条件同时成立才触发）：
 *   ① 临街面长度相对地块展开方向明显偏短 —— "临街只有 20 m，地却展开 60 m+"
 *   ② 临街方向和主轴明显不在一条线上 —— 差 25° 以上
 *
 * 只满足①（长条形但正对街道）不触发：那种地块按 frontage 排 bar 是对的。
 * 只满足②（方向错但临街很长）也不触发：那种地块围合面本身够长。
 */
export const AXIS_MISMATCH = {
  /** 临街长度 / 主轴展向 的阈值：低于它才算"临街太短" */
  frontageRatio: 0.42,
  /** 夹角阈值（度）：超过它才算"方向错位" */
  angleDeg: 25,
};

export interface AxisMismatch {
  mismatch: boolean;
  frontageLength: number;
  frontageRatio: number;
  angleDeg: number;
  majorExtent: number;
  minorExtent: number;
  reason: string;
}

export function detectAxisMismatch(
  buildable: PlanSurface,
  frontageEdge: [Pt, Pt]
): AxisMismatch | null {
  const pa = principalAxisOf(buildable);
  if (!pa) return null;
  const a = frontageEdge[0];
  const b = frontageEdge[1];
  const frontageLength = Math.hypot(b.x - a.x, b.y - a.y);
  if (frontageLength < 1e-6) return null;
  const frontDir = new Pt((b.x - a.x) / frontageLength, (b.y - a.y) / frontageLength);
  const ang = angleBetween(frontDir, pa.major);
  const ratio = frontageLength / Math.max(1e-6, pa.majorExtent);
  const mismatch = ratio < AXIS_MISMATCH.frontageRatio && ang > AXIS_MISMATCH.angleDeg;
  return {
    mismatch,
    frontageLength,
    frontageRatio: ratio,
    angleDeg: ang,
    majorExtent: pa.majorExtent,
    minorExtent: pa.minorExtent,
    reason: mismatch
      ? `临街面 ${(frontageLength * 7).toFixed(0)} m 只有地块展向 ${(pa.majorExtent * 7).toFixed(0)} m 的 ${(ratio * 100).toFixed(0)}%，且方向差 ${ang.toFixed(0)}°`
      : `临街面 ${(frontageLength * 7).toFixed(0)} m / 展向 ${(pa.majorExtent * 7).toFixed(0)} m = ${(ratio * 100).toFixed(0)}%，方向差 ${ang.toFixed(0)}°`,
  };
}
