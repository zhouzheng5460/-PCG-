// B 类"为什么没归属"的原因标签（Phase G1/G2/G3 的诊断层）
//
// 这一层**只解释，不修改**。所有事实来自 `SurfaceSampler.sample()`，这里只做
// "为什么这个点是 B"的推断，输出标签 + 几何证据。
//
// ## 为什么不能靠距离
//
// 上一版用"离路口 < 12 m"和"离路面 < 14 m"分类，结果是**分类器自己决定了比例**：
// 想让它变成什么，调阈值就行。所以这一版三个标签都用**真实几何**：
//
//   in-corner-wedge        点落在**该路口各条臂围成的凸包**里，却没被任何路面盖住
//                          —— 凸包由 arm 的 origin / dir / pad / curb+sw+vg 算出，
//                          不是半径。
//   adjacent-edge-no-road  最近的那条 patch 边**在 Road Graph 里没有对应的边**
//                          —— 也就是城市边界那一侧，没有任何道路会铺到那里。
//   adjacent-edge-has-road 最近边有路，但点仍没被认领（窄缝/被裁掉的部分）。
//   outside-city           不在任何 withinCity 的 block 里。B 类按构造不会有，
//                          留这个标签是为了把"城外"和"城内未归属"分开统计。
//   unknown                都对不上（例如 legacy 底板）。
//
// 优先级：in-corner-wedge > adjacent-edge-no-road > adjacent-edge-has-road > unknown。
// 命中多个时**保留全部证据**，用 priority 生成互斥统计。

import type { Model } from '../town/model';
import type { RoadNet } from '../road/system';
import type { Pt } from '../core/geom';
import { Pt as P } from '../core/geom';
import type { SampleFact } from './sampling';

export type BLabel =
  | 'in-corner-wedge'
  | 'adjacent-edge-no-road'
  | 'adjacent-edge-has-road'
  | 'outside-city'
  | 'unknown';

const PRIORITY: BLabel[] = ['outside-city', 'in-corner-wedge', 'adjacent-edge-no-road', 'adjacent-edge-has-road', 'unknown'];

export interface BLabelResult {
  label: BLabel;
  /** 命中的全部标签（按优先级排序），便于复核 */
  all: BLabel[];
  /** 几何证据，人可读 */
  evidence: string;
}

interface JunctionHull {
  center: P;
  hull: P[];
  /** 包围盒外扩，做快速排除 */
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** 用各条臂的宽度 / 方向 / 收口距离算路口凸包（不是半径） */
export function junctionHulls(net: RoadNet): JunctionHull[] {
  const out: JunctionHull[] = [];
  for (const j of net.junctions) {
    const pts: P[] = [];
    for (const a of j.arms) {
      const near = a.origin ?? j.center;
      const far = new P(near.x + a.dir.x * a.pad, near.y + a.dir.y * a.pad);
      const l = a.curbL + a.swL + a.vgL;
      const r = a.curbR + a.swR + a.vgR;
      for (const base of [near, far]) {
        pts.push(new P(base.x + a.n.x * l, base.y + a.n.y * l));
        pts.push(new P(base.x - a.n.x * r, base.y - a.n.y * r));
      }
    }
    if (pts.length < 3) continue;
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of hull) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
    out.push({ center: j.center, hull, box: { x0, y0, x1, y1 } });
  }
  return out;
}

/** 一条 patch 边的几何 + 它有没有对应的 Road Graph 边 */
export interface PatchEdgeInfo {
  a: Pt;
  b: Pt;
  hasRoad: boolean;
}

export function patchEdges(model: Model, net: RoadNet): Map<string, PatchEdgeInfo[]> {
  const out = new Map<string, PatchEdgeInfo[]>();
  const has = (a: Pt, b: Pt) =>
    net.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a) || (e.len > 1e-9 && same(a, e.a) && same(b, e.b)) || same(a, e.b) && same(b, e.a));
  for (const p of model.patches) {
    if (p.blocked || !p.withinCity) continue;
    const r = Array.from(p.shape);
    const cx = r.reduce((s, q) => s + q.x, 0) / r.length;
    const cy = r.reduce((s, q) => s + q.y, 0) / r.length;
    const block = `${Math.round(cx)}:${Math.round(cy)}`;
    out.set(
      block,
      r.map((a, i) => {
        const b = r[(i + 1) % r.length];
        return { a, b, hasRoad: has(a, b) };
      })
    );
  }
  return out;
}

/** 给一个 B 采样点定因（互斥标签 + 全部证据） */
export function labelBPoint(
  f: SampleFact,
  hulls: JunctionHull[],
  edgesOf: (block: string) => PatchEdgeInfo[]
): BLabelResult {
  if (!f.inCity) return { label: 'outside-city', all: ['outside-city'], evidence: '不在任何 withinCity block 内' };

  const all: BLabel[] = [];
  const why: string[] = [];

  // ① 路口楔形：在臂围成的凸包里，却没被任何路面盖住
  for (const h of hulls) {
    if (f.x < h.box.x0 || f.x > h.box.x1 || f.y < h.box.y0 || f.y > h.box.y1) continue;
    if (!pointInConvex(new P(f.x, f.y), h.hull)) continue;
    all.push('in-corner-wedge');
    why.push(`在路口 (${h.center.x.toFixed(1)},${h.center.y.toFixed(1)}) 的臂凸包内，且无任何路面覆盖`);
    break;
  }

  // ② 最近的 patch 边有没有路（用真实 Road Graph 边关系，不用距离阈值）
  const edges = f.block ? edgesOf(f.block) : [];
  if (edges.length) {
    let best = edges[0];
    let bd = Infinity;
    for (const e of edges) {
      const d = distSeg(f.x, f.y, e.a, e.b);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (best.hasRoad) {
      all.push('adjacent-edge-has-road');
      why.push(`最近 patch 边有路，距该边 ${(bd * 7).toFixed(1)} m`);
    } else {
      all.push('adjacent-edge-no-road');
      why.push(`最近 patch 边**没有** Road Graph 边（城市边界侧），距该边 ${(bd * 7).toFixed(1)} m`);
    }
  }

  if (all.length === 0) all.push('unknown');
  const label = PRIORITY.find((p) => all.includes(p)) ?? 'unknown';
  return { label, all, evidence: why.join('；') || '无几何证据' };
}

// ---------------------------------------------------------------- 局部几何

function same(a: Pt, b: Pt): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

function distSeg(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  let t = L > 1e-12 ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

function convexHull(pts: P[]): P[] {
  const p = pts.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function pointInConvex(p: P, hull: P[]): boolean {
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
