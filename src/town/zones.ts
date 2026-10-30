// 新增模块：禁建区（禁止创建内容的固定形状范围）
//
// 设计要点：
// 1. 形状统一转成简单多边形（矩形/圆/自由多边形）。
// 2. 与地块做布尔差集，得到精确的可用区域边界 —— 这是"按形状范围禁止"的关键，
//    只做概率屏蔽的话边界一定是毛的。
// 3. 布尔运算会破坏原项目赖以生存的"顶点对象共享身份"假设（相邻地块共用同一个 Pt 实例），
//    所以裁剪后必须 weldVertices + fixTJunctions 把拓扑重新焊起来，否则 A* 找不到路。
// 4. 生成前的 Voronoi 种子点也要被推开，否则禁建区里会冒出半个地块。

import polygonClipping from 'polygon-clipping';
import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';

export type ZoneShape =
  | { kind: 'rect'; a: Pt; b: Pt }
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'poly'; pts: Pt[] };

/** 封闭地块里要长什么内容 —— 决定它走哪条规划分支 */
export type ZonePurpose = 'cbd' | 'forest' | 'park';

export interface Zone {
  id: string;
  label: string;
  enabled: boolean;
  /** 内容类型：CBD 街区 / 林地 / 公园。默认 cbd（上一版只有这一种） */
  purpose?: ZonePurpose;
  shape: ZoneShape;
  /** 地块与该区域重叠超过此比例时整块不再生成内容 */
  blockThreshold: number;
}

export function makeZone(id: string, label: string, shape: ZoneShape, purpose: ZonePurpose = 'cbd'): Zone {
  return { id, label, enabled: true, purpose, shape, blockThreshold: 0.35 };
}

type Ring = [number, number][];

/**
 * 布尔运算的坐标量化倍数。
 *
 * polygon-clipping 的扫描线对"几乎重合但不完全重合"的端点极其敏感，
 * 一旦踩中就在 RingOut 里抛 `Unable to complete output ring`，整城生成随之崩掉。
 * 把坐标吸附到整数格上能消掉这类数值噪声：1 世界单位 ≈ 7 m，
 * 1/2048 单位 ≈ 3.4 mm，量化误差远小于任何有意义的几何尺寸。
 */
const QS = 2048;

function quant(ring: Pt[]): Ring {
  const out: Ring = [];
  let px = NaN;
  let py = NaN;
  for (const p of ring) {
    const x = Math.round(p.x * QS);
    const y = Math.round(p.y * QS);
    if (x === px && y === py) continue;
    out.push([x, y]);
    px = x;
    py = y;
  }
  if (out.length >= 2) {
    const f = out[0];
    const l = out[out.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  if (out.length >= 3) out.push([out[0][0], out[0][1]]); // 闭合环
  return out;
}

/**
 * 圆周自适应分段数：让**弦高**（弧到弦的距离）不超过 sag。
 *
 * 原来是写死 40 段。r=10（70 m 半径）时弦长只有 11 m、每个顶点只转 9° ——
 * 俯视图上看着像一条光滑的弧，实际是 40 条独立的路：每条边各自铺一遍
 * 车行道 / 人行道 / 绿化带，拐点处两条带子对不上，留一道
 * `w/2·tan(θ/2)` 的缺口（9° 时约 0.8 m），整圈读起来就是一条毛边。
 *
 * 现在按弦高定段数：想更圆就给更小的 sag，想少两个假折角就给大一点，
 * 不用再去猜"多少个点才像圆"。
 */
function arcSegments(r: number, sag: number): number {
  if (!(r > 0) || !(sag > 0)) return 40;
  const c = Math.max(-1, Math.min(1, 1 - Math.min(1, sag / r)));
  const n = Math.ceil(Math.PI / Math.acos(c));
  return Math.max(8, Math.min(64, n));
}

/** 轮廓的弦高容忍（世界单位，≈1 m）。画出来的圆和真正圆的偏差就在这个量级 */
export const ZONE_SAG = 0.15;

/**
 * 轮廓规整化：把"一堆看不清的碎折角"压成"看得清的几个角"。
 *
 * 自定义形状最终会变成一圈**道路红线**，而每个顶点都是一个折角：
 *   - 折角处两条路带各自为政，`w/2·tan(θ/2)` 的缺口就是那圈毛边；
 *   - 顶点太多还会切出一堆 10 m 级的碎边（实测圆禁区周边 247 条边里
 *     150 条短于 20 m），这些碎边既放不下楼，又会被路口求解当成独立approach。
 *
 * 两步，都很保守（轮廓位移 ≤ 弦高，肉眼不可辨）：
 *   ① 最短边合并：把短于 `minEdge` 的边的两个端点换成中点；
 *   ② 近平角合并：转角小于 `maxTurn` 的顶点直接去掉。
 * 四边及以下的轮廓（矩形 / L 形）原样返回 —— 那些角是人画的，不能动。
 */
export function simplifyRing(
  ring: Pt[],
  opts: { minEdge?: number; maxTurn?: number } = {}
): Pt[] {
  const minEdge = opts.minEdge ?? 1.2; // ≈ 8.4 m
  const maxTurn = ((opts.maxTurn ?? 10) * Math.PI) / 180;
  let r = dedupe(ring, 1e-7);
  if (r.length <= 4) return r;

  for (let guard = 0; guard < 400 && r.length > 4; guard++) {
    let bi = -1;
    let bl = Infinity;
    for (let i = 0; i < r.length; i++) {
      const L = Pt.distance(r[i], r[(i + 1) % r.length]);
      if (L < bl) {
        bl = L;
        bi = i;
      }
    }
    if (bl >= minEdge) break;
    const n = r.length;
    const a = r[bi];
    const b = r[(bi + 1) % n];
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    const out: Pt[] = [];
    for (let k = 0; k < n; k++) {
      if (k === bi) out.push(mid);
      else if (k === (bi + 1) % n) continue;
      else out.push(r[k]);
    }
    r = out;
  }

  for (let guard = 0; guard < 400 && r.length > 4; guard++) {
    let found = -1;
    const n = r.length;
    for (let i = 0; i < n; i++) {
      const a = r[(i - 1 + n) % n];
      const b = r[i];
      const c = r[(i + 1) % n];
      const t1 = Math.atan2(b.y - a.y, b.x - a.x);
      const t2 = Math.atan2(c.y - b.y, c.x - b.x);
      let d = t2 - t1;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < maxTurn) {
        found = i;
        break;
      }
    }
    if (found < 0) break;
    r.splice(found, 1);
  }
  return r;
}

/** 形状 → 多边形顶点（逆时针，去掉重复点） */
export function zoneToPolygon(zone: Zone): Pt[] {
  const s = zone.shape;
  let pts: Pt[];
  if (s.kind === 'rect') {
    const { a, b } = s;
    pts = [new Pt(a.x, a.y), new Pt(b.x, a.y), new Pt(b.x, b.y), new Pt(a.x, b.y)];
  } else if (s.kind === 'circle') {
    const n = arcSegments(s.r, ZONE_SAG);
    pts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      pts.push(new Pt(s.c.x + Math.cos(ang) * s.r, s.c.y + Math.sin(ang) * s.r));
    }
  } else {
    pts = s.pts.map((p) => new Pt(p.x, p.y));
  }
  return ccw(simplifyRing(dedupe(pts, 1e-6)));
}


export function dedupe(pts: Pt[], eps: number): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > eps || Math.abs(last.y - p.y) > eps) out.push(p);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f.x - l.x) <= eps && Math.abs(f.y - l.y) <= eps) out.pop();
  }
  return out;
}

export function signedArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function ccw(pts: Pt[]): Pt[] {
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts;
}

function toGeom(ring: Pt[]): [Ring] {
  return [quant(ring)];
}

function fromGeom(res: number[][][][]): Pt[][] {
  const rings: Pt[][] = [];
  for (const poly of res) {
    // 每个多边形只有第 0 个环是外环，后面的都是洞。
    // 洞绝对不能再当成独立多边形返回：调用方拿到的是"要铺出来的面"，
    // 若把洞也铺一遍，环形带的面积就会翻倍（路缘过渡带曾因此铺到地块面积的 175%，
    // 把整块基底盖成水泥色）。铺装是单环多边形，本来也表达不了洞。
    const ring = poly[0];
    if (!ring) continue;
    const pts: Pt[] = [];
    for (const [x, y] of ring) pts.push(new Pt(x / QS, y / QS));
    // polygon-clipping 会闭合环，去掉末尾重复点
    const d = dedupe(pts, 1e-7);
    if (d.length >= 3) rings.push(d);
  }
  return rings;
}

export function area(pts: Pt[]): number {
  return Math.abs(signedArea(pts));
}

/**
 * 环是否简单（无自交、无零长边）。
 *
 * 布尔运算在"两瓣都极窄"的输入上会吐出折返的环 —— 顶点顺序像
 * A→B→A→C 那样来回走，面积算出来还是正的，但任何下游的多边形运算
 * （求交、内缩、三角化）都会崩或者返回空。
 * 内部路的 A* 版把地块切得更碎（一条路可能贴着界边走），
 * `subtract` 出这种垃圾的概率明显高于张量版，所以切完必须验一遍。
 * n ≤ 16，直接 O(n²)。
 */
export function isSimpleRing(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (Pt.distance(a, b) < 1e-6) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (
        ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
        ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
      )
        return false;
    }
  }
  return true;
}

/**
 * 把环吸附到布尔运算的量化格点上。
 *
 * 为了"多边形的边界"与"布尔输出的切口"落在**完全相同的坐标**上，两边必须走同一套量化。
 * 只要有一个顶点差 1e-4，焊接就会把它判成两个点，地块与禁区之间随即裂开一条缝 ——
 * 缝里既不是路也不是地块，俯视图上就是一条底色带。
 */
export function quantizeRing(ring: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of ring) out.push(new Pt(Math.round(p.x * QS) / QS, Math.round(p.y * QS) / QS));
  return dedupe(out, 1e-7);
}

/**
 * 多个多边形的并集里面积最大的那个外环。
 *
 * 用来求"城区覆盖范围"：地块本来就是无缝拼起来的，并集就是城市轮廓。
 * 只取最大环是因为城市轮廓是单连通的一块；若真有飞地，那块地会退化成
 * "周围没有邻居"的孤岛，铺不出路，不如不要。
 */
export function unionAll(rings: Pt[][]): Pt[] {
  const valid = rings.filter((r) => r.length >= 3);
  if (valid.length === 0) return [];
  if (valid.length === 1) return valid[0];
  try {
    const res = polygonClipping.union(
      toGeom(valid[0]),
      ...valid.slice(1).map((r) => toGeom(r))
    ) as unknown as number[][][][];
    const parts = fromGeom(res);
    let best: Pt[] = [];
    let bestA = -1;
    for (const p of parts) {
      const a = area(p);
      if (a > bestA) {
        best = p;
        bestA = a;
      }
    }
    return best;
  } catch {
    return valid.reduce((a, b) => (area(a) >= area(b) ? a : b));
  }
}

/** 保留关联外环中面积最大的那些（丢弃洞和碎屑） */
export function keepLargestRing(subject: Pt[], result: Pt[][]): Pt[] | null {
  if (result.length === 0) return null;
  let best: Pt[] | null = null;
  let bestArea = -1;
  for (const r of result) {
    const a = area(r);
    if (a > bestArea) {
      best = r;
      bestArea = a;
    }
  }
  if (!best) return null;
  // 剩余面积过小视作被完全占用
  if (bestArea < area(subject) * 0.04) return null;
  return best;
}

export function subtract(subject: Pt[], clips: Pt[][]): Pt[][] {
  if (clips.length === 0) return [subject];
  try {
    const res = polygonClipping.difference(
      toGeom(subject),
      ...clips.map((c) => toGeom(c))
    ) as unknown as number[][][][];
    return fromGeom(res);
  } catch {
    // 布尔运算失败时宁可退回"不裁剪"，也不要让整城生成崩掉
    return [subject];
  }
}

export function intersectArea(a: Pt[], b: Pt[]): number {
  try {
    const res = polygonClipping.intersection(toGeom(a), toGeom(b)) as unknown as number[][][][];
    let total = 0;
    for (const ring of fromGeom(res)) total += area(ring);
    return total;
  } catch {
    return 0;
  }
}

/** 交集多边形（可能有多个）。建筑体块裁到地块可用区内时用 */
export function intersect(subject: Pt[], clip: Pt[], minRatio = 0.05): Pt[][] {
  const base = area(subject);
  try {
    const res = polygonClipping.intersection(toGeom(subject), toGeom(clip)) as unknown as number[][][][];
    const rings = fromGeom(res);
    if (rings.length === 0) return [];
    const out = rings.filter((r) => area(r) > base * minRatio);
    return out.length > 0 ? out : [];
  } catch {
    return [];
  }
}

export function overlapRatio(patch: Pt[], zone: Pt[]): number {
  const pa = area(patch);
  if (pa <= 0) return 1;
  return intersectArea(patch, zone) / pa;
}

/** 把落在禁建区内部的种子点推到外面，让 Voronoi 自然绕开该区域 */
export function pushSeedsOutOfZones(seeds: Pt[], zones: Pt[][], margin: number): void {
  for (const seed of seeds) {
    for (const zone of zones) {
      if (!pointInPolygon(seed, zone)) continue;
      const c = centroid(zone);
      let dir = new Pt(seed.x - c.x, seed.y - c.y);
      if (dir.length < 1e-6) dir = new Pt(1, 0);
      dir.normalize(1);
      // 二分找到边界外侧的位置
      let lo = 0;
      let hi = Math.max(zoneRadius(zone, c) * 2, 20);
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const probe = new Pt(c.x + dir.x * mid, c.y + dir.y * mid);
        if (pointInPolygon(probe, zone)) lo = mid;
        else hi = mid;
      }
      seed.setTo(c.x + dir.x * (hi + margin), c.y + dir.y * (hi + margin));
    }
  }
}

function centroid(pts: Pt[]): Pt {
  const c = new Pt();
  for (const p of pts) c.addEq(p);
  c.scaleEq(1 / pts.length);
  return c;
}

function zoneRadius(pts: Pt[], c: Pt): number {
  let r = 0;
  for (const p of pts) r = Math.max(r, Pt.distance(p, c));
  return r;
}

export function pointInPolygon(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 顶点焊接：把坐标相同的顶点替换为同一个 Pt 实例。
 * 这是布尔裁剪后修复拓扑的必需步骤 —— 原项目的 Graph 按对象身份匹配顶点。
 */
export function weldVertices(polys: Polygon[], eps: number): Pt[] {
  const table = new Map<string, Pt>();
  const key = (x: number, y: number) => `${Math.round(x / eps)}_${Math.round(y / eps)}`;
  const all: Pt[] = [];

  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i];
      const k = key(v.x, v.y);
      let shared = table.get(k);
      if (!shared) {
        shared = v;
        table.set(k, v);
        all.push(v);
      }
      poly[i] = shared;
    }
    // 去掉焊接后相邻重复的顶点
    for (let i = poly.length - 1; i >= 0 && poly.length > 3; i--) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a === b) poly.splice((i + 1) % poly.length, 1);
    }
  }
  return all;
}

/**
 * 修复 T 型连接：若某个顶点落在一条边的内部，就在这条边上插入该顶点。
 * 禁建区裁剪会在相邻地块的公共边中间制造单侧顶点，不插点会让路网断开。
 */
export function fixTJunctions(polys: Polygon[], vertices: Pt[], eps: number): void {
  for (const poly of polys) {
    const len = poly.length;
    const inserts: { edgeIndex: number; t: number; pt: Pt }[] = [];

    for (let i = 0; i < len; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % len];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      if (len2 < eps * eps) continue;

      for (const v of vertices) {
        if (v === a || v === b) continue;
        const t = ((v.x - a.x) * vx + (v.y - a.y) * vy) / len2;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        const px = a.x + vx * t;
        const py = a.y + vy * t;
        if (Math.hypot(v.x - px, v.y - py) > eps) continue;
        // 该顶点必须确实属于这条边（相邻地块共享）
        inserts.push({ edgeIndex: i, t, pt: v });
      }
    }

    if (inserts.length === 0) continue;
    inserts.sort((p, q) => (p.edgeIndex === q.edgeIndex ? p.t - q.t : p.edgeIndex - q.edgeIndex));

    // 从后往前插，避免索引漂移
    const byEdge = new Map<number, { t: number; pt: Pt }[]>();
    for (const ins of inserts) {
      const list = byEdge.get(ins.edgeIndex) ?? [];
      list.push(ins);
      byEdge.set(ins.edgeIndex, list);
    }
    const edgeIdx = Array.from(byEdge.keys()).sort((a, b) => b - a);
    for (const ei of edgeIdx) {
      const list = byEdge.get(ei) as { t: number; pt: Pt }[];
      list.sort((p, q) => q.t - p.t);
      for (const ins of list) poly.splice(ei + 1, 0, ins.pt);
    }
  }
}

/** 沿外法线把地块缩小 margin，用于给道路让出空间（禁建区边缘） */
export function insetRing(ring: Pt[], d: number): Pt[] {
  if (d <= 0) return ring;
  const poly = new Polygon(ring);
  const inner = poly.shrink(ring.map(() => d));
  return inner && inner.length >= 3 ? Array.from(inner) : ring;
}

/** 边被禁建区覆盖的比例超过 70% 就算"这条边在禁区里" */
const EDGE_SAMPLES = 9;
const BLOCK_RATIO = 0.7;

/** 这条路中线是否被禁建区遮住（原在 topology.ts，中世纪寻路移除后归到几何层） */
export function edgeInsideZones(a: Pt, b: Pt, zones: Pt[][]): boolean {
  if (zones.length === 0) return false;
  let inside = 0;
  for (let i = 1; i < EDGE_SAMPLES; i++) {
    const t = i / EDGE_SAMPLES;
    const p = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (zones.some((z) => pointInPolygon(p, z))) inside++;
  }
  return inside / (EDGE_SAMPLES - 1) >= BLOCK_RATIO;
}
