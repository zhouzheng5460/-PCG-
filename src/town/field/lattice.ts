// 栅格 A* 寻路：把一块封闭区域离散成"位置 + 朝向"的状态图，求内部路中线。
//
// 为什么不是纯最短路径：
//   纯最短路在一张空地上必然退化成一条直线（或一条贴边的弧）——
//   没有障碍时，任何弯曲都只是加长路程。上一版沿张量场积分就吃过这个亏：
//   场是缓变的，沿场追一条 200 m 的线绕出一倍多长度，两条 7 m 路吃掉 17% 用地，
//   还把地块切成一大堆三角碎块。所以这里的代价函数必须有三个"反退化"项：
//
//   ① **转弯惩罚**（`turn`）：状态里带朝向，每转 45° 记一笔钱。
//      于是"为省一格距离而折两下"就不划算了，长直段自己长出来。
//      这是 Parish&Müller 那套 L-system 路网的核心手法之一，只是这里用代价表达。
//   ② **斜穿惩罚**（`gridPenalty`）：横平竖直比斜穿便宜。城市内部路是外围街网的
//      延续，斜着划过去在接缝处跟外面差出十几度，画面上就是两个路网硬怼。
//   ③ **随机扰动**（`jitter`）：每个节点的通行代价带一点噪声。
//      没有它，同一块地按同一组入口跑出来的路永远是同一条；城市会显得像练习题。
//
// 求出来的折线是栅格上的阶梯（45° 锯齿），必须过一遍 RDP 简化 +
// 共线合并，才是一条能直接铺沥青的中线。
//
// 与全城级 Dijkstra 的关系：这个模块是它的"地块内"局部版。
// 未来的全城路网只要把 `ok` 换成"可建 / 不可建"、把入口换成"既有路网节点"，
// 同一份 A* 就能直接用；现在只服务封闭地块的内部路。

import { Pt, distToSegment } from '../../core/geom';
import { pointInPolygon } from '../zones';

/** 8 邻域：(dx, dy) */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

export interface LatticeOpts {
  /** 栅格边长（世界单位）。越小路越顺，但状态数按平方涨 */
  cell: number;
  /** 节点离地块边界的最小距离：内部路不能贴着界边跑（那是外部道路的红线） */
  clear?: number;
  /** 每转 45° 的额外代价，单位是"走一格"的倍数 */
  turn?: number;
  /** 单格代价的随机扰动幅度（0~0.6） */
  jitter?: number;
  /** 城市主轴：横平竖直比斜穿便宜 */
  axis?: Pt;
  /**
   * 斜穿惩罚（0~4），默认 2。
   *
   * **必须是"加价"而不是"折扣"**：8 邻域里一步斜线只走 √2 格，
   * 两段正交是 2 格 —— 任何 [0,1] 范围内的折扣都压不住这个 1.41 倍的便宜，
   * 结果每条路都会退化成一整条 45° 直线（第一版就是这样：一块 L 形地块里
   * 长出一条从左上直接劈到右下的斜路）。
   * 要让"横平竖直"赢，斜线代价得乘到 > √2/1 = 1.414 以上：
   * `1 + 2 × (1 − 0.707) = 1.586`，再乘 √2 得 2.24 > 2，正交才划算。
   */
  gridPenalty?: number;
  /**
   * 允许 8 邻域的斜步，默认 **false**。
   *
   * 调用方会把多边形转到"街道坐标系"再建栅格（见 `pathSpine`），
   * 转完之后栅格的 4 个正交方向就是街道的两个方向 —— 斜步在任何情况下
   * 都是"斜穿街网"，没有必要存在。关掉之后路只有 H/V 两种走向，
   * 端头延长也自然是正交的（斜步会让端头延长出一条 45° 的斜切，
   * 地块边界跟着被斜切，铺装和车位的角全是歪的）。
   *
   * 只有当栅格坐标系与街道无关时（未来的全城粗网格）才需要打开。
   */
  diagonal?: boolean;
  /** 扰动用的种子（不消耗全局 Rng 流，避免改变下游随机序列） */
  seed?: number;
}

export interface Lattice {
  cell: number;
  nx: number;
  ny: number;
  ox: number;
  oy: number;
  /** 1 = 可通行 */
  ok: Uint8Array;
  /** 单格通行代价基线（含扰动），乘上移动长度才是真实开销 */
  w: Float32Array;
  ring: Pt[];
  /** 转弯惩罚（已从 LatticeOpts 带过来，A* 直接用） */
  turnPenalty: number;
  gridPenalty: number;
  axis: Pt | null;
  diagonal: boolean;
}

function hash2(i: number, j: number, seed: number): number {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

/** 点到多边形边界的最短距离 */
export function edgeDist(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = distToSegment(p, ring[i], ring[(i + 1) % ring.length]);
    if (d < best) best = d;
  }
  return best;
}

export function buildLattice(ring: Pt[], o: LatticeOpts): Lattice {
  const cell = Math.max(o.cell, 0.05);
  const clear = o.clear ?? cell * 0.8;
  const jitter = Math.max(0, Math.min(0.6, o.jitter ?? 0.3));
  const seed = o.seed ?? 1;

  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of ring) {
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
  }
  // 外扩一格：入口点正好落在界边上，最近的可通行节点在里侧，不必为此特判
  const ox = minx - cell;
  const oy = miny - cell;
  const nx = Math.max(1, Math.ceil((maxx - minx) / cell) + 3);
  const ny = Math.max(1, Math.ceil((maxy - miny) / cell) + 3);

  const ok = new Uint8Array(nx * ny);
  const w = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = i + j * nx;
      const p = new Pt(ox + i * cell, oy + j * cell);
      const inside = pointInPolygon(p, ring) && edgeDist(p, ring) >= clear;
      ok[k] = inside ? 1 : 0;
      w[k] = 1 + jitter * (hash2(i, j, seed) - 0.5) * 2;
    }
  }
  return {
    cell,
    nx,
    ny,
    ox,
    oy,
    ok,
    w,
    ring,
    turnPenalty: Math.max(0, o.turn ?? 2.4),
    gridPenalty: Math.max(0, Math.min(4, o.gridPenalty ?? 2)),
    diagonal: o.diagonal === true,
    axis: o.axis ? o.axis.norm() : null,
  };
}

export function nodePt(lat: Lattice, k: number): Pt {
  const i = k % lat.nx;
  const j = (k - i) / lat.nx;
  return new Pt(lat.ox + i * lat.cell, lat.oy + j * lat.cell);
}

/** 离 p 最近的可通行节点下标，没有则 -1 */
function nearestOk(lat: Lattice, p: Pt): number {
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < lat.ok.length; k++) {
    if (!lat.ok[k]) continue;
    const i = k % lat.nx;
    const j = (k - i) / lat.nx;
    const dx = lat.ox + i * lat.cell - p.x;
    const dy = lat.oy + j * lat.cell - p.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** 简单二叉堆（按 f 值），A* 用 */
class Heap {
  private a: number[] = [];
  constructor(private f: Float32Array) {}
  get size(): number {
    return this.a.length;
  }
  push(s: number): void {
    const a = this.a;
    a.push(s);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[i]]) break;
      const t = a[p];
      a[p] = a[i];
      a[i] = t;
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === i) break;
        const t = a[m];
        a[m] = a[i];
        a[i] = t;
        i = m;
      }
    }
    return top;
  }
}

/**
 * 从 a 到 b 求一条路。
 *
 * 状态是 `节点 × 朝向`（8 朝向），所以同一格能被不同方向穿过 ——
 * 不这么做的话"转弯要花钱"这件事没法表达：节点没有记忆，A* 会把
 * "直着走三格" 和 "拐三下走三格" 当成同一个状态。
 */
export function astar(
  lat: Lattice,
  a: Pt,
  b: Pt,
  opts?: { snapA?: boolean; snapB?: boolean }
): { pts: Pt[]; cost: number } | null {
  const s = nearestOk(lat, a);
  const g0 = nearestOk(lat, b);
  if (s < 0 || g0 < 0 || s === g0) return null;

  const nNode = lat.nx * lat.ny;
  const nState = nNode * 8;
  const g = new Float32Array(nState).fill(Infinity);
  const from = new Int32Array(nState).fill(-1);
  const f = new Float32Array(nState).fill(Infinity);
  const closed = new Uint8Array(nState);

  const cell = lat.cell;
  const turn = (turnPenalty: number, prev: number, next: number): number => {
    if (prev < 0) return 0;
    let d = Math.abs(next - prev);
    if (d > 4) d = 8 - d; // 环形差
    return d * turnPenalty * cell;
  };
  const turnPenalty = Math.max(0, lat.turnPenalty);
  const gridPenalty = Math.max(0, lat.gridPenalty);

  const goal = nodePt(lat, g0);
  const heur = (k: number): number => {
    const p = nodePt(lat, k);
    return Math.hypot(p.x - goal.x, p.y - goal.y) * 0.9;
  };

  // 起点：8 个朝向都可以，代价相同（起点没有"来向"）
  for (let d = 0; d < 8; d++) {
    const st = s * 8 + d;
    g[st] = 0;
    f[st] = heur(s);
  }
  const open = new Heap(f);
  for (let d = 0; d < 8; d++) open.push(s * 8 + d);

  let hit = -1;
  while (open.size > 0) {
    const st = open.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const node = (st / 8) | 0;
    const dir = st - node * 8;
    if (node === g0) {
      hit = st;
      break;
    }
    const i = node % lat.nx;
    const j = (node - i) / lat.nx;
    for (let nd = 0; nd < 8; nd++) {
      if (!lat.diagonal && (nd & 1) === 1) continue; // 只走 4 邻域
      const [dx, dy] = DIRS[nd];
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= lat.nx || nj >= lat.ny) continue;
      const nk = ni + nj * lat.nx;
      if (!lat.ok[nk]) continue;
      // 斜着穿墙角不行：两侧正交格至少有一个要通
      if (dx !== 0 && dy !== 0) {
        const s1 = okAt(lat, i + dx, j);
        const s2 = okAt(lat, i, j + dy);
        if (!s1 && !s2) continue;
      }
      const lenMul = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      // 顺轴折扣：|d·axis| 与 |d·perp| 取大者，横平竖直得满折扣，斜穿只拿到 0.707
      let align = 1;
      const ax = lat.axis;
      if (ax && gridPenalty > 0) {
        const ux = dx / (lenMul || 1);
        const uy = dy / (lenMul || 1);
        align = Math.max(Math.abs(ux * ax.x + uy * ax.y), Math.abs(ux * -ax.y + uy * ax.x));
      }
      const step =
        cell * lenMul * lat.w[nk] * (1 + gridPenalty * (1 - align)) + turn(turnPenalty, dir, nd);
      const nst = nk * 8 + nd;
      if (closed[nst]) continue;
      const ng = g[st] + step;
      if (ng < g[nst]) {
        g[nst] = ng;
        from[nst] = st;
        f[nst] = ng + heur(nk);
        open.push(nst);
      }
    }
  }
  if (hit < 0) return null;

  const raw: Pt[] = [];
  for (let st = hit; st >= 0; st = from[st]) {
    raw.push(nodePt(lat, (st / 8) | 0));
    if (((st / 8) | 0) === s) break;
  }
  raw.reverse();
  if (raw.length < 2) return null;
  // 端点处理：
  //   入口那一头要"顺着最后一跨的方向延长到界边"，而不是直接连到入口点。
  //   直接连会在路口处留下一个一格的斜跳（路的最后 8 m 突然歪 30°），
  //   放大看就是路口前打了一个折 —— 第一版就是这样。
  //   延长到界边之后，路的走向和出口方向完全一致。
  let pts = stripStubs(dedupePath(simplifyPath(raw, cell * 0.55)), cell * 1.5);
  if (pts.length < 2) return null;
  const snapA = opts?.snapA ?? true;
  const snapB = opts?.snapB ?? true;
  if (snapA) pts = snapTail(pts, lat.ring, true);
  if (snapB) pts = snapTail(pts, lat.ring, false);
  if (pts.length < 2) return null;
  return { pts, cost: g[hit] };
}

/**
 * 掐掉两端的"一格短棒"。
 *
 * A* 的终点常常与目标点差一格：路径走到目标格的正上/正下方，再横挪一格进去。
 * 这一格本身没错，但端点延长是**沿着末段方向**延长到界边的 —— 末段是一格横挪，
 * 延长方向就是横向，于是路从地块中间横向拉到对面的界边上去。
 * 实测：一条本该笔直竖向穿地的内部路，被拉成"直上 + 一条横贯全块地的长臂"，
 * 把地块切成两个折返的怪多边形，整整半块地一栋楼都放不进去。
 *
 * 掐掉之后端点延长用的是真正的走向，路口也是垂直出去的。
 */
function stripStubs(pts: Pt[], minLen: number): Pt[] {
  const a = pts.slice();
  while (a.length >= 3 && Pt.distance(a[a.length - 1], a[a.length - 2]) < minLen) a.pop();
  while (a.length >= 3 && Pt.distance(a[0], a[1]) < minLen) a.shift();
  return a;
}

/** 射线从内点出发与多边形边界的最近正向交点参量 */
function rayHitParam(ring: Pt[], p: Pt, d: Pt): number | null {
  let best: number | null = null;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const den = d.x * sy - d.y * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / den;
    const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
    if (t < 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/** 把折线的 head 端（或 tail 端）沿自身方向延长到多边形边界上 */
function snapTail(pts: Pt[], ring: Pt[], first: boolean): Pt[] {
  if (pts.length < 2) return pts;
  const i0 = first ? 0 : pts.length - 1;
  const i1 = first ? 1 : pts.length - 2;
  const p = pts[i0];
  const q = pts[i1];
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return pts;
  const t = rayHitParam(ring, p, new Pt(dx / L, dy / L));
  if (t === null) return pts;
  const out = pts.slice();
  out[i0] = new Pt(p.x + (dx / L) * t, p.y + (dy / L) * t);
  return out;
}

function okAt(lat: Lattice, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= lat.nx || j >= lat.ny) return false;
  return lat.ok[i + j * lat.nx] === 1;
}

/** Ramer–Douglas–Peucker：把栅格阶梯压成少量长直段 */
export function simplifyPath(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let far = -1;
    let farD = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(pts[i], pts[lo], pts[hi]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** 去重（相邻重合点）+ 共线合并（中间点可以省掉） */
export function dedupePath(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Pt.distance(p, q) < 1e-4) continue;
    out.push(p);
  }
  if (out.length < 3) return out;
  const res: Pt[] = [out[0]];
  for (let i = 1; i + 1 < out.length; i++) {
    const a = res[res.length - 1];
    const b = out[i];
    const c = out[i + 1];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const l1 = Pt.distance(a, b);
    const l2 = Pt.distance(b, c);
    if (Math.abs(cr) < 1e-4 * Math.max(1, l1 * l2)) continue; // 近乎共线：丢掉 b
    res.push(b);
  }
  res.push(out[out.length - 1]);
  return res;
}

function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L = vx * vx + vy * vy;
  if (L < 1e-12) return a.clone();
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return new Pt(a.x + vx * t, a.y + vy * t);
}

/**
 * 把入口连成路网：一条主干 + 若干 T 形支路。
 *
 * 为什么不是"全两两连"：3 个入口两两连是 3 条路，多出来那条是纯浪费的对角线。
 * 为什么不是 MST：MST 的 2 条边会共享一个**入口点**，于是两条路从同一个
 * 界边开口分叉出去，成一个大 V 字 —— 现实里没有这么开口的。
 * 真实地块里是"一条主干横穿，另外的入口从别处 T 接到主干上"，
 * 所以这里先取相距最远的一对入口当主干，其余入口各自向主干投点做支路。
 */
export function connectEntries(lat: Lattice, entries: Pt[]): Pt[][] {
  const n = entries.length;
  if (n < 2) return [];

  let bi = 0;
  let bj = 1;
  let bd = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Pt.distance(entries[i], entries[j]);
      if (d > bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }
  const trunk = astar(lat, entries[bi], entries[bj]);
  if (!trunk) return [];
  const lines: Pt[][] = [trunk.pts];

  for (let k = 0; k < n; k++) {
    if (k === bi || k === bj) continue;
    let bestP: Pt | null = null;
    let bestD = Infinity;
    for (const ln of lines) {
      for (let i = 0; i + 1 < ln.length; i++) {
        const c = closestOnSeg(entries[k], ln[i], ln[i + 1]);
        const d = Pt.distance(entries[k], c);
        if (d < bestD) {
          bestD = d;
          bestP = c;
        }
      }
    }
    // 入口本来就贴着主干：再补一条 2 m 的支路没有意义
    if (!bestP || bestD < lat.cell * 1.6) continue;
    // 支路只有"入口"这一头在界边上；另一头落在主干中心线上，不能往外延长
    const r = astar(lat, entries[k], bestP, { snapA: true, snapB: false });
    if (r) lines.push(r.pts);
  }
  return lines;
}

/** 给定打分函数，从界边里挑 count 个中点当入口，彼此至少隔 minGap */
export function pickEntryPoints(
  ring: Pt[],
  count: number,
  score: (a: Pt, b: Pt) => number,
  minGap: number
): Pt[] {
  const cand: { mid: Pt; sc: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (Pt.distance(a, b) < minGap * 0.6) continue;
    cand.push({ mid: new Pt((a.x + b.x) / 2, (a.y + b.y) / 2), sc: score(a, b) });
  }
  cand.sort((p, q) => q.sc - p.sc);
  const out: Pt[] = [];
  for (const c of cand) {
    if (out.length >= count) break;
    if (out.some((p) => Pt.distance(p, c.mid) < minGap)) continue;
    out.push(c.mid);
  }
  return out;
}
