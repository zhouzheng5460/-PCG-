// 网格基元：把 2D 要素变成 3D 三角形。
//
// 坐标系固定：地图 (x, y) → 3D (x, 0, y)，高度沿 +Y。
// 这样从上方俯视和 2D 编辑器完全一致，导进 DCC 也不用转轴。
//
// 手性提醒（踩过坑）：earcut 对 CCW 输入输出 CCW 三角形，映射到 XZ 平面后
// 外法线朝 −Y，所以索引必须两两交换；侧面顶点的顺序同理必须是
// a_bot → b_top → b_bot。

import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { Pt } from '../core/geom';

export interface Primitive {
  name: string;
  group: string;
  positions: number[];
  normals: number[];
  indices: number[];
  /** sRGB 0~1 */
  color: [number, number, number];
  doubleSided?: boolean;
}

/**
 * 退化三角形阈值（面积的一半，世界单位²）。
 *
 * earcut 在近共线的三个点上会吐出零面积三角形 —— 渲染上什么都不画，
 * 但它的面法线是零向量，绕序自检 `dot <= 0` 会判成翻转。
 * 一条 5 km 的中心线被切成 5000 段虚线时，这种三角一两块是常态，
 * 与其放宽断言，不如在这里就不产出无用的三角形。
 */
const DEGEN_AREA2 = 1e-9;

export function triangulate(ring: Pt[]): number[] {
  if (ring.length < 3) return [];
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.y);
  const idx = earcut(flat, undefined, 2);
  const out: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 2];
    const c = idx[i + 1];
    const ax = flat[a * 2];
    const ay = flat[a * 2 + 1];
    const area2 = (flat[b * 2] - ax) * (flat[c * 2 + 1] - ay) - (flat[c * 2] - ax) * (flat[b * 2 + 1] - ay);
    if (Math.abs(area2) <= DEGEN_AREA2) continue;
    out.push(a, b, c);
  }
  return out;
}

export function ensureCCW(ring: Pt[]): Pt[] {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s < 0 ? ring.slice().reverse() : ring;
}

function dedupeRing(ring: Pt[]): Pt[] {
  return ring.filter((p, i, arr) => i === 0 || Pt.distance(p, arr[i - 1]) > 1e-6);
}

/** 贴地平面多边形 */
/**
 * 环是否自交（O(n²)，n 一般 < 12，代价可以忽略）。
 *
 * 自交环交给 earcut 会吐出**跨到多边形外的三角形** —— 俯视图和三维里
 * 就是地面上伸出去的细长"尖刺"。这跟相机近平面裁剪无关：正交俯视、
 * 透视视图里都长一样，因为它本来就是几何错误。
 */
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

/**
 * 自交环 → 用布尔并集规范化成简单环（可能返回多块，取最大的）。
 * 布尔库对单个自交环做 union 等价于"抹掉自交形成的重叠区"，结果边数可能变化。
 */
function healRing(r: Pt[]): Pt[] | null {
  try {
    const res = polygonClipping.union([r.map((p) => [p.x, p.y])] as never) as unknown as number[][][][];
    let best: Pt[] | null = null;
    let bestA = 0;
    for (const poly of res) {
      const ring = poly[0];
      if (!ring) continue;
      const pts = ring.map((q) => new Pt(q[0], q[1]));
      const a = Math.abs(pts.reduce((acc, p, i) => {
        const n2 = pts[(i + 1) % pts.length];
        return acc + p.x * n2.y - n2.x * p.y;
      }, 0) / 2);
      if (a > bestA) {
        bestA = a;
        best = pts;
      }
    }
    return best;
  } catch {
    return null;
  }
}

export function flatPolygon(
  ring: Pt[],
  y: number,
  name: string,
  group: string,
  color: [number, number, number]
): Primitive | null {
  let clean = ensureCCW(dedupeRing(ring));
  if (clean.length < 3) return null;
  // 自交兜底：earcut 对自交环会吐出跨到多边形外的三角形（地面上的"尖刺"）
  if (selfIntersects(clean)) {
    const healed = healRing(clean);
    if (!healed) return null;
    clean = ensureCCW(dedupeRing(healed));
    if (clean.length < 3 || selfIntersects(clean)) return null;
  }
  const idx = triangulate(clean);
  if (idx.length === 0) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  for (const p of clean) {
    positions.push(p.x, y, p.y);
    normals.push(0, 1, 0);
  }
  return { name, group, positions, normals, indices: idx, color };
}

/** 挤出体块：顶面与侧面分成两个图元，便于分别换材质 */
export function extrudeSolid(
  ring: Pt[],
  y0: number,
  height: number,
  name: string,
  group: string,
  roofColor: [number, number, number],
  wallColor: [number, number, number],
  noRoof = false
): Primitive[] {
  const clean = ensureCCW(dedupeRing(ring));
  if (clean.length < 3 || height <= 1e-6) return [];
  const top = triangulate(clean);
  if (top.length === 0) return [];

  const n = clean.length;
  const out: Primitive[] = [];

  if (!noRoof) {
    const topPos: number[] = [];
    const topNrm: number[] = [];
    for (const p of clean) {
      topPos.push(p.x, y0 + height, p.y);
      topNrm.push(0, 1, 0);
    }
    out.push({ name: `${name}_roof`, group, positions: topPos, normals: topNrm, indices: top.slice(), color: roofColor });
  }

  const pos: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = clean[i];
    const b = clean[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = dy / len;
    const ny = -dx / len;

    const base = pos.length / 3;
    pos.push(a.x, y0, a.y, b.x, y0, b.y, b.x, y0 + height, b.y, a.x, y0 + height, a.y);
    for (let k = 0; k < 4; k++) normals.push(nx, 0, ny);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  if (indices.length > 0) out.push({ name: `${name}_wall`, group, positions: pos, normals, indices, color: wallColor });
  return out;
}

/** 圆柱（灯杆、树干、水塔） */
export function cylinder(
  c: Pt,
  r: number,
  y0: number,
  h: number,
  name: string,
  group: string,
  color: [number, number, number],
  seg = 8
): Primitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= seg; i++) {
    const ang = (i / seg) * Math.PI * 2;
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    positions.push(c.x + nx * r, y0, c.y + ny * r);
    normals.push(nx, 0, ny);
    positions.push(c.x + nx * r, y0 + h, c.y + ny * r);
    normals.push(nx, 0, ny);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    indices.push(a, a + 3, a + 2, a, a + 1, a + 3);
  }

  const centerIdx = positions.length / 3;
  positions.push(c.x, y0 + h, c.y);
  normals.push(0, 1, 0);
  for (let i = 0; i <= seg; i++) {
    const ang = (i / seg) * Math.PI * 2;
    positions.push(c.x + Math.cos(ang) * r, y0 + h, c.y + Math.sin(ang) * r);
    normals.push(0, 1, 0);
  }
  for (let i = 0; i < seg; i++) indices.push(centerIdx, centerIdx + i + 2, centerIdx + i + 1);

  return { name, group, positions, normals, indices, color };
}

/** 圆锥（树冠、塔顶）。tipUp=false 时锥尖朝下，做双层树冠的第二层 */
export function cone(
  c: Pt,
  r: number,
  y0: number,
  h: number,
  name: string,
  group: string,
  color: [number, number, number],
  seg = 6,
  tipUp = true
): Primitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const apexY = tipUp ? y0 + h : y0;
  const baseY = tipUp ? y0 : y0 + h;
  const apex = positions.length / 3;
  positions.push(c.x, apexY, c.y);
  normals.push(0, tipUp ? 1 : -1, 0);

  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = new Pt(c.x + Math.cos(a0) * r, c.y + Math.sin(a0) * r);
    const p1 = new Pt(c.x + Math.cos(a1) * r, c.y + Math.sin(a1) * r);

    // 侧面法线：水平方向取两点平均外法线，竖直分量 = 锥面斜率 r/h。
    // 尖朝上时法线朝外上方（+Y），尖朝下时朝外下方。
    const mx = (Math.cos(a0) + Math.cos(a1)) / 2;
    const my = (Math.sin(a0) + Math.sin(a1)) / 2;
    const ml = Math.hypot(mx, my) || 1;
    const slope = r / Math.max(h, 1e-6);
    const nx = mx / ml;
    const ny = my / ml;
    const up = tipUp ? slope : -slope;
    const nl = Math.hypot(nx, up, ny) || 1;

    const base = positions.length / 3;
    positions.push(p0.x, baseY, p0.y, p1.x, baseY, p1.y);
    normals.push(nx / nl, up / nl, ny / nl, nx / nl, up / nl, ny / nl);

    // 手性：XZ 平面上角度增大是顺时针，所以 (apex, p1, p0) 才是外向
    if (tipUp) indices.push(apex, base + 1, base);
    else indices.push(apex, base, base + 1);
  }

  return { name, group, positions, normals, indices, color };
}

/** 轴对齐（可绕 Y 旋转）长方体 */
export function box(
  c: Pt,
  w: number,
  d: number,
  y0: number,
  h: number,
  rot: number,
  name: string,
  group: string,
  color: [number, number, number],
  roofColor?: [number, number, number]
): Primitive[] {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cs: Pt[] = [
    new Pt(-w / 2, -d / 2),
    new Pt(w / 2, -d / 2),
    new Pt(w / 2, d / 2),
    new Pt(-w / 2, d / 2),
  ];
  const ring = cs.map((p) => new Pt(c.x + p.x * cos - p.y * sin, c.y + p.x * sin + p.y * cos));
  return extrudeSolid(ring, y0, h, name, group, roofColor ?? color, color);
}

/**
 * 沿折线生成有厚度的墙体。
 * 不能把整圈当成一个环带去三角化 —— 闭合环带是自交的，earcut 会吐出
 * 横穿全图的大三角形。这里按段生成再合并，两端各延长一点防裂缝。
 */
export function wallSolid(
  path: Pt[],
  thickness: number,
  y0: number,
  h: number,
  name: string,
  group: string,
  color: [number, number, number],
  closed = true
): Primitive | null {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const hw = thickness / 2;

  const appendBox = (ring: Pt[]) => {
    const clean = ensureCCW(ring);
    if (clean.length < 3) return;
    const topIdx = triangulate(clean);
    if (topIdx.length === 0) return;

    const topBase = pos.length / 3;
    for (const p of clean) {
      pos.push(p.x, y0 + h, p.y);
      nrm.push(0, 1, 0);
    }
    for (const i of topIdx) idx.push(topBase + i);

    const n = clean.length;
    for (let i = 0; i < n; i++) {
      const a = clean[i];
      const b = clean[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = dy / len;
      const ny = -dx / len;
      const base = pos.length / 3;
      pos.push(a.x, y0, a.y, b.x, y0, b.y, b.x, y0 + h, b.y, a.x, y0 + h, a.y);
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, ny);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  };

  const last = closed ? path.length : path.length - 1;
  for (let i = 0; i < last; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const d = b.subtract(a);
    const len = d.length;
    if (len < 1e-6) continue;
    const nx = -d.y / len;
    const ny = d.x / len;
    const ext = d.norm(hw * 0.7);
    const a2 = a.subtract(ext);
    const b2 = b.add(ext);

    appendBox([
      new Pt(a2.x + nx * hw, a2.y + ny * hw),
      new Pt(b2.x + nx * hw, b2.y + ny * hw),
      new Pt(b2.x - nx * hw, b2.y - ny * hw),
      new Pt(a2.x - nx * hw, a2.y - ny * hw),
    ]);
  }

  if (idx.length === 0) return null;
  return { name, group, positions: pos, normals: nrm, indices: idx, color };
}

/** 合并多个图元（减少 draw call / 节点数） */
export function mergePrimitives(prims: Primitive[], name: string, group: string): Primitive | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let color: [number, number, number] = [0.7, 0.7, 0.7];
  for (const p of prims) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    normals.push(...p.normals);
    for (const i of p.indices) indices.push(base + i);
    color = p.color;
  }
  if (indices.length === 0) return null;
  return { name, group, positions, normals, indices, color };
}
