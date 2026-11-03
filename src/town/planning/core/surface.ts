// Site Planning Core · 面契约
//
// 这一层存在的理由（PRD §3 P0）：
//   整个工程原来只有 `ring: Pt[]` 一种面结构 —— 一个外环、没有洞。
//   于是所有"中庭 / 环路 / 停车岛 / 中央绿地 / 环形铺装"都只能画成
//   "大面 + 叠一块小面"，靠 y 值叠压来假装有洞。这套做法的代价是：
//     · 3D / GLB 里洞里其实还有一块面（俯视看不见、剖面就露馅）；
//     · 每一次布尔运算（subtract / difference）都得退化成一个或几个外环，
//       洞被静默丢掉 —— `unionParts` 现在只回一个 `holes: number` 计数就是证据。
//
// 所以这一层的职责只有一句话：
//   **让 `PlanSurface = { outer, holes }` 成为唯一的面结构，并让布尔 / 三角化 /
//     2D / 3D / GLB 全链路都真的认洞。**
//
// 约束（PRD 明确要求）：
//   · 第三方几何库的数据格式**不许出这个文件**（业务代码只调 surface* 系列）；
//   · 现有 `ring: Pt[]` 的调用点保持可用（用 `surfacesOf(ring)` 兼容）。

import { Pt } from '../../../core/geom';
import polygonClipping from 'polygon-clipping';

/** 一个平面区域：外环 + 若干洞（洞的方向与外环相反，此处不做强制，交给三角化处理） */
export interface PlanSurface {
  outer: Pt[];
  holes: Pt[][];
}

/** 多边形钳制库的嵌套元组格式：Polygon = Ring[]，MultiPolygon = Polygon[] */
type Nest = number[][][][];

export function surface(outer: Pt[], holes: Pt[][] = []): PlanSurface {
  return { outer: cleanRing(outer), holes: holes.map(cleanRing).filter((h) => h.length >= 3) };
}

/**
 * 清掉**相邻重复顶点**。
 *
 * 这不是洁癖，是硬需求：polygon-clipping 拒绝带重复点的多边形
 * （"Input geometry is not a valid Polygon or MultiPolygon"），
 * 而 `surfaceUnion` / `surfaceSubtract` / `surfaceIntersect` 都有
 * `catch { return 原值 }` 的兜底分支 —— 一旦几何非法，
 * **并集会静默退化成"把重叠部分算两遍"**，Fidelity Gate 的
 * groundCoverage 就从 1.00 掉到 0.95，看起来像 Realizer 漏做了 5% 的地面，
 * 实际上只是并集算错了。
 *
 * 实测来源：斜边地块上 `intersect(矩形, 可建区)` 会在裁切点留下
 * 一对完全相同的相邻顶点（-491:44 的 6 块地面**全部**中招）。
 *
 * 只删"完全相同"的相邻点（含首尾相同），不动几何形状。
 */
export function cleanRing(ring: Pt[]): Pt[] {
  if (ring.length < 3) return ring.slice();
  const out: Pt[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  // 首尾相同也要去掉（闭合环里不应该出现）
  while (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) out.pop();
    else break;
  }
  return out.length >= 3 ? out : ring.slice();
}

/** 老代码兼容：单个外环 → 无洞的面 */
export function surfacesOf(ring: Pt[]): PlanSurface[] {
  return ring.length >= 3 ? [{ outer: ring, holes: [] }] : [];
}

/** 面积（外环 − 洞，取绝对值，保证是正数） */
export function surfaceArea(s: PlanSurface): number {
  const a = Math.abs(ringArea(s.outer));
  let holes = 0;
  for (const h of s.holes) holes += Math.abs(ringArea(h));
  return Math.max(0, a - holes);
}

/** 带符号面积（逆时针为正） */
export function ringArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function toNest(ss: PlanSurface[]): Nest {
  return ss.map((s) => [
    s.outer.map((p) => [p.x, p.y] as number[]),
    ...s.holes.map((h) => h.map((p) => [p.x, p.y] as number[])),
  ]) as unknown as Nest;
}

function fromNest(n: Nest): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const poly of n ?? []) {
    if (!poly || poly.length === 0) continue;
    const outer = cleanRing((poly[0] ?? []).map((q) => new Pt(q[0], q[1])));
    if (outer.length < 3) continue;
    const holes: Pt[][] = [];
    for (let i = 1; i < poly.length; i++) {
      const h = cleanRing((poly[i] ?? []).map((q) => new Pt(q[0], q[1])));
      if (h.length >= 3) holes.push(h);
    }
    out.push({ outer, holes });
  }
  return out;
}

/** 并集（保留洞） */
export function surfaceUnion(ss: PlanSurface[]): PlanSurface[] {
  const list = ss.filter((s) => s.outer.length >= 3);
  if (list.length === 0) return [];
  if (list.length === 1) return list;
  try {
    return fromNest(polygonClipping.union(toNest(list)[0] as never, ...(toNest(list).slice(1) as never[])) as unknown as Nest);
  } catch {
    return list;
  }
}

/** a 减去 b（保留 a 上被 b 掏出来的洞） */
export function surfaceSubtract(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const as = a.filter((s) => s.outer.length >= 3);
  const bs = b.filter((s) => s.outer.length >= 3);
  if (as.length === 0) return [];
  if (bs.length === 0) return as;
  try {
    const A = toNest(as);
    const B = toNest(bs);
    return fromNest(polygonClipping.difference(A as never, B as never) as unknown as Nest);
  } catch {
    return as;
  }
}

/** 交集（保留洞） */
export function surfaceIntersect(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const as = a.filter((s) => s.outer.length >= 3);
  const bs = b.filter((s) => s.outer.length >= 3);
  if (as.length === 0 || bs.length === 0) return [];
  try {
    return fromNest(polygonClipping.intersection(toNest(as) as never, toNest(bs) as never) as unknown as Nest);
  } catch {
    return [];
  }
}

/** 外扩（正数）/ 内缩（负数）。洞的方向相反：内缩时洞会变大。 */
export function surfaceOffset(s: PlanSurface, d: number): PlanSurface[] {
  if (Math.abs(d) < 1e-9) return [s];
  // buffered() 的符号约定：**正数 = 内缩**（沿 CCW 环的左手法线走）。
  // 对外语义反过来（正数 = 外扩），所以这里要取反。
  const out: PlanSurface = {
    outer: buffered(s.outer, -d),
    // 洞的方向与外环相反：外环外扩时洞要变小
    holes: s.holes.map((h) => buffered(h, d)),
  };
  if (!surfaceValid(out)) return [];
  // 凹角处的 miter 可能自交 —— 交给并集规范化一次（只在自交时才做，省开销）
  if (selfIntersects(out.outer)) {
    const fixed = surfaceUnion([out]);
    return fixed.filter((q) => surfaceArea(q) > 1e-9);
  }
  return [out];
}

/** 环是否自交（偏移后的自检） */
function selfIntersects(r: Pt[]): boolean {
  const n = r.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = r[i];
    const b = r[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = r[j];
      const d = r[(j + 1) % n];
      const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
      const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** 内缩（正数距离） */
export function surfaceInset(s: PlanSurface, d: number): PlanSurface[] {
  return surfaceOffset(s, -Math.abs(d));
}

/**
 * 单环的简单偏移（沿顶点法线做 miter）。
 *
 * 真正的 offset 应该走 Clipper2（PRD §5），但这里先给出**不引入新依赖**的
 * 可用实现：对规划层的矩形 / 梯形 / 凸多边形足够准；凹角处靠 miter 上限兜住。
 * 需要工业级 offset 时只改这一个函数，调用方不动。
 */
function buffered(ring: Pt[], delta: number): Pt[] {
  const n = ring.length;
  if (n < 3 || delta === 0) return ring;
  const ccw = ringArea(ring) > 0;
  const sgn = ccw ? 1 : -1;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i + n - 1) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const e0 = unit(new Pt(cur.x - prev.x, cur.y - prev.y));
    const e1 = unit(new Pt(next.x - cur.x, next.y - cur.y));
    // 左手法线；CCW 环的左手边是内侧
    const n0 = new Pt(-e0.y * sgn, e0.x * sgn);
    const n1 = new Pt(-e1.y * sgn, e1.x * sgn);
    let mid = new Pt(n0.x + n1.x, n0.y + n1.y);
    const ml = Math.hypot(mid.x, mid.y);
    // 折返点（两条边几乎反向）法线相加会归零：这时退回用第一条边的法线，
    // 否则除以 0 会把顶点甩到原点，整个面直接炸掉
    mid = ml < 1e-6 ? new Pt(n0.x, n0.y) : new Pt(mid.x / ml, mid.y / ml);
    const cos = Math.max(0.35, mid.x * n0.x + mid.y * n0.y);
    out.push(new Pt(cur.x + mid.x * (delta / cos), cur.y + mid.y * (delta / cos)));
  }
  return out;
}

function unit(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

/** 面是否退化（外环 < 3 点 / 面积近似 0） */
export function surfaceValid(s: PlanSurface): boolean {
  return s.outer.length >= 3 && surfaceArea(s) > 1e-9;
}

/**
 * 内部最稳的核心点（PRD §8 的 polylabel 轻量替代）。
 *
 * 做法：取外环的中轴采样，选"到边界距离最大"的那个点 —— 对矩形 / L 形 / 梯形
 * 已经足够稳，且不需要额外依赖。用途：庭院中心、水景、停车撒点、标签位置。
 */
export function surfaceAnchor(s: PlanSurface, samples = 24): Pt {
  const b = bboxOf(s.outer);
  let best = new Pt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  if (!insideSurface(best, s)) best = s.outer[0];
  let bestD = -Infinity;
  // 网格采样 + 到边界的距离，取最大者
  const nx = samples;
  const ny = samples;
  for (let i = 1; i < nx; i++) {
    for (let j = 1; j < ny; j++) {
      const p = new Pt(b.minX + ((b.maxX - b.minX) * i) / nx, b.minY + ((b.maxY - b.minY) * j) / ny);
      if (!insideSurface(p, s)) continue;
      const d = distToSurfaceEdge(p, s);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

export function bboxOf(ring: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 点是否在面内（外环内且不在洞里） */
export function insideSurface(p: Pt, s: PlanSurface): boolean {
  if (!pointInRing(p, s.outer)) return false;
  for (const h of s.holes) if (pointInRing(p, h)) return false;
  return true;
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到面边界（外环 + 洞）的最短距离 */
export function distToSurfaceEdge(p: Pt, s: PlanSurface): number {
  let best = distToRing(p, s.outer);
  for (const h of s.holes) best = Math.min(best, distToRing(p, h));
  return best;
}

function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}
