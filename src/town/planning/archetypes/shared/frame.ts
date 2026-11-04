// Archetype · 共用的"地块局部坐标系"
//
// 所有 archetype 都在做同一件事：把可建区投影到"沿主临街面 / 往里进深"的
// 局部坐标里，然后按比例切成前场 / 建筑 / 后场。这段投影代码在每个 archetype
// 里都抄了一遍（工业 / 零售 / 住宅 / 独栋），四份几乎一样。
//
// 新增 green / park / civic 时不想再抄第五、第六、第七份 —— 抽到这里。
// **只放坐标与裁剪**，不放任何规划判断：谁往前排、谁在后场，仍然是各自 archetype 的事。

import { Pt } from '../../../../core/geom';
import {
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  insideSurface,
  ringArea,
  type PlanSurface,
} from '../../core/surface';
import type { SiteContext } from '../../core/types';

const U = (m: number) => m / 7;

export interface SiteFrame {
  /** 局部坐标 → 世界坐标 */
  at: (lu: number, lv: number) => Pt;
  /** 沿临街面方向的区间（0 = 主临街面中点） */
  u0: number;
  u1: number;
  /** 进深方向的区间（v0 ≈ 临街面，v1 ≈ 背街） */
  v0: number;
  v1: number;
  /** 面宽 / 进深（世界单位） */
  W: number;
  D: number;
  uDir: Pt;
  vDir: Pt;
  /** 临街面中点（世界坐标） */
  origin: Pt;
  /** 局部矩形 → 世界 → 裁到可建区；空的返回 null */
  cut: (lu0: number, lu1: number, lv0: number, lv1: number) => PlanSurface | null;
}

/**
 * 建局部坐标系。
 *
 * - 原点 = 主临街面的中点（没有临街面就用地块最长边的中点）；
 * - u 方向 = 临街面方向，v 方向 = 指向地块内部的法线；
 * - `flipV` 可以让 v 反过来 —— 有的 archetype 想把"正面"放在 v1 那侧。
 */
export function siteFrame(ctx: SiteContext, opts: { flipV?: boolean } = {}): SiteFrame | null {
  const buildable = ctx.buildableArea;
  if (buildable.outer.length < 3) return null;

  const edge: [Pt, Pt] | undefined = ctx.primaryFrontage?.parcelEdge;
  let ea: Pt;
  let eb: Pt;
  if (edge) {
    [ea, eb] = edge;
  } else {
    // 没有临街面（尽端/内部地块）：取最长边当基准，保证坐标系还是有意义的
    let best = -1;
    const ring = buildable.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > best) {
        best = l;
        ea = a;
        eb = b;
      }
    }
    if (!ea! || !eb!) return null;
  }

  const origin = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const lenU = Math.hypot(eb.x - ea.x, eb.y - ea.y);
  if (lenU < 1e-6) return null;
  const uDir = new Pt((eb.x - ea.x) / lenU, (eb.y - ea.y) / lenU);
  let vDir = new Pt(-uDir.y, uDir.x);
  // v 指向地块内部。
  //
  // 探针距离**必须大于退线**：临街面在原patch的边界上，而可建区已经按退线
  // 内缩了 5~14 m，拿 3 m 去探，脚下永远还在退线带里 —— 会误判成"v 指反了"，
  // 于是整个坐标系上下颠倒，入口带整块落在可建区外面（实测就是"绿地全都没有入口"）。
  // 所以按 8 / 4 / 16 / 28 m 依次试，先落进可建区的那个方向为准。
  {
    const probes = [U(8), U(4), U(16), U(28), U(45)];
    const hit = (dir: Pt) =>
      probes.some((d) => insideSurface(new Pt(origin.x + dir.x * d, origin.y + dir.y * d), buildable));
    if (!hit(vDir)) {
      const flipped = new Pt(-vDir.x, -vDir.y);
      if (hit(flipped)) vDir = flipped;
    }
  }
  if (opts.flipV) vDir = new Pt(-vDir.x, -vDir.y);

  const at = (lu: number, lv: number) =>
    new Pt(origin.x + uDir.x * lu + vDir.x * lv, origin.y + uDir.y * lu + vDir.y * lv);

  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of buildable.outer) {
    const du = (p.x - origin.x) * uDir.x + (p.y - origin.y) * uDir.y;
    const dv = (p.x - origin.x) * vDir.x + (p.y - origin.y) * vDir.y;
    if (du < u0) u0 = du;
    if (du > u1) u1 = du;
    if (dv < v0) v0 = dv;
    if (dv > v1) v1 = dv;
  }
  if (!Number.isFinite(u0) || !Number.isFinite(v0)) return null;

  const cut = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null => {
    if (lu1 - lu0 < U(1.5) || lv1 - lv0 < U(1.5)) return null;
    const rect = surface([at(lu0, lv0), at(lu1, lv0), at(lu1, lv1), at(lu0, lv1)]);
    let parts: PlanSurface[];
    try {
      parts = surfaceIntersect([rect], [buildable]);
    } catch {
      return null;
    }
    if (parts.length === 0) return null;
    const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    return surfaceArea(best) > U(1) * U(1) ? best : null;
  };

  return { at, u0, u1, v0, v1, W: u1 - u0, D: v1 - v0, uDir, vDir, origin, cut };
}

/**
 * 一条"带子"（沿 u 方向、给定进深范围），从局部矩形裁到可建区。
 * 与 `cut` 同一个东西，只是换个名字让调用处读起来像总图。
 */
export function strip(f: SiteFrame, lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null {
  return f.cut(lu0, lu1, lv0, lv1);
}

/**
 * 两点之间的一条"带子"（任意方向）。
 *
 * 公园和广场的路不是沿街正交的：从入口到中心节点的路是**斜的**。
 * `SiteFrame.cut` 只能切轴对齐矩形，所以这里单独给一个任意方向的。
 * 返回**未裁**的矩形，调用方自己裁到可建区。
 */
export function ribbon(a: Pt, b: Pt, width: number): PlanSurface | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6 || width <= 0) return null;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  // 两端各外扩半个路宽：两段路在节点处才不会留下一个方角缺口
  const ex = (dx / len) * (width / 2);
  const ey = (dy / len) * (width / 2);
  return surface([
    new Pt(a.x - ex + nx, a.y - ey + ny),
    new Pt(b.x + ex + nx, b.y + ey + ny),
    new Pt(b.x + ex - nx, b.y + ey - ny),
    new Pt(a.x - ex - nx, a.y - ey - ny),
  ]);
}

/** 把一个未裁的面裁到可建区，返回面积最大的那块 */
export function clipTo(area: PlanSurface, rings: PlanSurface[]): PlanSurface | null {
  try {
    const parts = surfaceIntersect([area], rings).filter((p) => surfaceArea(p) > 0.5);
    if (!parts.length) return null;
    return parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
  } catch {
    return null;
  }
}

/**
 * 从 `base` 里挖掉若干块，返回剩下的小块。
 *
 * 为什么 archetype 要自己挖，而不是留给 Realizer 的 ownership：
 * 诊断分（绿地率 / 铺装率 / 碎片数）是在 **Candidate 上**算的，
 * 那时 ownership 还没跑。如果 `lawn` 铺整块、广场再叠上去，诊断会读到
 * "绿地 100% + 广场 14%" = 114%，区间被打爆，分数直接掉到 0 ——
 * 这不是设计差，是口径错。
 *
 * 失败（布尔退化）时退回 `[base]`：宁可让诊断读到偏高的绿地率，
 * 也不要丢掉整块地面。
 */
export function minusAll(base: PlanSurface, cutters: PlanSurface[]): PlanSurface[] {
  const list = cutters.filter((c) => c && c.outer.length >= 3);
  if (list.length === 0) return [base];
  try {
    const rest = surfaceSubtract([base], list).filter((p) => surfaceArea(p) > 0.4);
    return rest.length > 0 ? rest : [];
  } catch {
    return [base];
  }
}

