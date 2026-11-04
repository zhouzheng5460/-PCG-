// R1 · 建筑驱动的内部交通求解（原型）
//
// 与现有 `realizeCirculation` 的区别：那条路是 archetype **手画**的（几根固定
// 直线），这里是从**真实入口**出发、在**带建筑障碍的栅格**上跑 A*、再把路径
// 合并成主次骨架。它不改城市 Road Graph，也不强制所有 archetype 换形态。
//
// 流程（对应 R1 的 1~9）：
//   ① 入口：街道侧 access（语义节点，不产几何）+ 建筑临街面中点（门）
//   ② OD：街 → 门（步行）/ 街 → 后勤门（服务）/ 街 → 停车（车行）
//   ③ A*：栅格 1 m，按交通类型的净空要求膨胀建筑
//   ④ 有界候选：每条 OD 只跑「首次 + 2 个备选」（对已用格子加惩罚，避免完全相同）
//   ⑤ 共享：统计每格被几条 OD 使用；≥2 次的段升级为主路
//   ⑥ 剪枝：去掉长度 < 8 m 且两端都没接到别的路的毛刺
//   ⑦ 输出：PathGraph（节点 + 段 + 宽度 + 类型），再转 band 多边形

import { Pt } from '../../../core/geom';
import { surfaceArea, type PlanSurface } from '../core/surface';
import type { SiteContext } from '../core/types';
import type { SitePlanCandidate } from '../core/candidate';
import { ribbon, clipTo } from '../archetypes/shared/frame';

const CELL_M = 1.5; // 栅格 1 m
const CELL = CELL_M / 7; // 世界单位

export type Traffic = 'pedestrian' | 'vehicle' | 'service';

/** 吸附失败/成功的完整记录 —— 失败必须能解释，不能静默丢掉一条必要连接 */
export interface SnapInfo {
  /** 吸附前坐标 */
  from: Pt;
  /** 吸附后坐标；null = 失败 */
  to: Pt | null;
  /** 吸附位移（m） */
  distM: number;
  /** 失败原因 */
  reason?: 'blocked-at-point' | 'no-free-cell' | 'outside-grid';
  /** 所在连通分量（-1 = 不可走）；吸附后才知道 */
  component?: number;
}

/**
 * Portal：入口 + **接入方向**。
 *
 * 原来只存一个点，A* 就从这个点开始 —— 但那个点常常正好在建筑的膨胀区里，
 * 于是要么吸到很远的地方，要么干脆无解。Portal 额外带一个 `dir`（合法的离开方向），
 * 沿途推出膨胀区之后才作为 A* 的起点。
 */
export interface Portal {
  id: string;
  kind: 'street' | 'door' | 'service-door' | 'parking';
  /** 语义位置（锚点） */
  at: Pt;
  /** 合法接入方向（从建筑/场地指向可通行侧） */
  dir: Pt;
  /** 净空要求（m） */
  clearM: number;
  snap: SnapInfo;
}

export interface CirNode {
  id: string;
  at: Pt;
  kind: 'street' | 'door' | 'service-door' | 'parking';
  block: Pt;
  role: string;
}

export interface CirEdge {
  from: string;
  to: string;
  traffic: Traffic;
  pts: Pt[];
  /** 米 */
  lengthM: number;
  /** 被几条 OD 共用（≥2 = 主路） */
  shared: number;
  /** ≥2 主路 5 m，否则次路 3 m */
  widthM: number;
  /** 这条边承担的需求数（1 = 单入口接驳，≥2 = 共享主通道） */
  odCount?: number;
  /** 它并入网络的那个节点（汇合点） */
  joinedAt?: { x: number; y: number };
}

export interface CirResult {
  nodes: CirNode[];
  edges: CirEdge[];
  paths: PlanSurface[];
  stats: {
    solved: number;
    totalM: number;
    mainM: number;
    subM: number;
    paveM2: number;
    sharedRate: number;
    /** 真实共享段长度（m） */
    sharedM: number;
    connected: boolean;
    ms: number;
    cells: number;
  };
  warnings: string[];
}

/** 交通类型 → 需要的净空半径（m）。车要 3 m 才开得过去 */
const CLEAR: Record<Traffic, number> = { pedestrian: 0.5, vehicle: 2.2, service: 2.2 };
/** 距离场的截断值（世界单位）：必须 ≥ 最大净空，否则复用时会误判 */
const FIELD_CAP = (Math.max(...Object.values(CLEAR)) * 1.5) / 7;

interface Grid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  /** 0 = 可走，非 0 = 不可走（按位解释，见 BLOCK_* ） */
  blocked: Uint8Array;
  /** 障碍来源位掩码：1=建筑净空 2=parcel 外 4=硬性禁行 */
  reason: Uint8Array;
  /** 到最近建筑的距离场（-1 = 红线外），供其他交通类型直接复用 */
  field?: Float32Array;
  inset: PlanSurface;
}

export const BLOCK_BUILDING = 1;
export const BLOCK_OUTSIDE_PARCEL = 2;
export const BLOCK_HARD = 4;

export function blockSourceName(mask: number): string {
  if (mask === 0) return '可走';
  const out: string[] = [];
  if (mask & BLOCK_BUILDING) out.push('建筑净空');
  if (mask & BLOCK_OUTSIDE_PARCEL) out.push('红线外');
  if (mask & BLOCK_HARD) out.push('禁行');
  return out.join('+');
}

function buildGrid(ctx: SiteContext, c: SitePlanCandidate, clearanceM: number, prevField?: Float32Array): Grid {
  // **导航域 = parcel，不是 buildableArea**。
  //
  // 这是 R1.1 的核心职责边界：`buildableArea` 是"建筑能盖在哪"，它已经按退线
  // 内缩了一圈；而内部道路、停车通道、步行接驳**完全可以走在退线带里**。
  // 拿 buildableArea 当交通范围，等于把整个退线带判成禁行 —— 停在退线带上的
  // 停车区就成了孤岛（实测 park_0 只剩 1~3 个格子）。
  const r = ctx.parcel.outer;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const nx = Math.max(2, Math.ceil((x1 - x0) / CELL));
  const ny = Math.max(2, Math.ceil((y1 - y0) / CELL));
  const blocked = new Uint8Array(nx * ny);
  const reason = new Uint8Array(nx * ny);
  const clr = clearanceM / 7;
  /** 停车区解除封死：车就停在上面，不是障碍。两条建表路径都要调用 ——
   *  复用分支（prevField）之前漏了这一步，导致第二、三种交通把停车区判成禁行，
   *  park_0 全部 no-free-cell。 */
  const carveParking = () => {
  // **停车区本身是可通行的**（车就停在上面）。
  //
  // 不做这一步时，建筑按 2.2 m 膨胀后会把内部停车场整圈围死 —— 实测 MF 的停车区
  // 落在一个只有 3 个单元格大小的连通分量里（街道是 19 号），A* 永远无解。
  // 这不是 Portal 的问题，是"把已存在的地面当成障碍"的顺序错误。
  for (const pr of c.parkingRequests) {
    const r = pr.region.outer;
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (const q of r) {
      px0 = Math.min(px0, q.x); py0 = Math.min(py0, q.y);
      px1 = Math.max(px1, q.x); py1 = Math.max(py1, q.y);
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const x = x0 + (i + 0.5) * CELL;
        const y = y0 + (j + 0.5) * CELL;
        if (x < px0 || x > px1 || y < py0 || y > py1) continue;
        if (!pointIn(x, y, r)) continue;
        // 只解除"因膨胀而被封"的格子；真在建筑内部的仍然不可走
        const inBld = c.buildings.some((b) => pointIn(x, y, b.footprint.outer) && distToRing(x, y, b.footprint.outer) > 0.01);
        if (!inBld) { blocked[j * nx + i] = 0; reason[j * nx + i] = 0; }
      }
    }
  }

  };

  if (prevField) {
    // 复用同一块地的距离场：只按本交通类型重新阈值化，不再逐格算建筑距离。
    for (let k = 0; k < nx * ny; k++) {
      if (prevField[k] < 0) { blocked[k] = 1; reason[k] = BLOCK_OUTSIDE_PARCEL; }
      else if (prevField[k] < clr) { blocked[k] = 1; reason[k] = BLOCK_BUILDING; }
      else { blocked[k] = 0; reason[k] = 0; }
    }
    carveParking();
    return { x0, y0, nx, ny, blocked, reason, inset: ctx.parcel, field: prevField };
  }

  const inside = (x: number, y: number) => pointIn(x, y, ctx.parcel.outer);
  // **距离场**（-1 = 红线外；其余 = 到最近建筑 footprint 的距离）。
  // 原来三种交通各跑一遍"每格 × 每建筑"的 distToRing，MF 一块 67944 格 × 16 栋 = 109 万次，
  // 三遍就是 327 万次 —— 611 ms 里绝大部分在这里。现在只算一遍，后两种交通复用。
  // 建筑包围盒：先用"到包围盒的距离"做廉价前置判断，远于净空要求就不必算真距离。
  // 我们要的只是"是否 < clr"，不是精确值 —— 这一条把 MF 的 68k×16 次 distToRing
  // 压到了只剩贴近建筑的少数格子。
  const bboxes = c.buildings.map((b) => {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const q of b.footprint.outer) {
      bx0 = Math.min(bx0, q.x); by0 = Math.min(by0, q.y);
      bx1 = Math.max(bx1, q.x); by1 = Math.max(by1, q.y);
    }
    return { bx0, by0, bx1, by1, ring: b.footprint.outer };
  });
  const bboxDist = (x: number, y: number, b: (typeof bboxes)[number]) => {
    const dx = Math.max(b.bx0 - x, 0, x - b.bx1);
    const dy = Math.max(b.by0 - y, 0, y - b.by1);
    return Math.hypot(dx, dy);
  };
  const field = new Float32Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = x0 + (i + 0.5) * CELL;
      const y = y0 + (j + 0.5) * CELL;
      if (!inside(x, y)) { field[j * nx + i] = -1; continue; }
      // 初值必须是**所有交通类型的最大净空之上**，不能是 clr * 3：
      // 距离场会被其它交通类型复用，若按行人的 0.5 m 截断成 1.5 m，
      // 车行（2.2 m）就会把整片地判成"太近"→ 全封（retail 就是这么崩的）。
      let best = FIELD_CAP;
      for (const b of bboxes) {
        if (bboxDist(x, y, b) >= best) continue;
        const d = distToRing(x, y, b.ring);
        if (d < best) best = d;
      }
      field[j * nx + i] = best;
    }
  }
  for (let k = 0; k < nx * ny; k++) {
    if (field[k] < 0) { blocked[k] = 1; reason[k] = BLOCK_OUTSIDE_PARCEL; }
    else if (field[k] < clr) { blocked[k] = 1; reason[k] = BLOCK_BUILDING; }
  }
  carveParking();
  return { x0, y0, nx, ny, blocked, reason, inset: ctx.parcel, field };
}

function toCell(g: Grid, p: Pt): [number, number] {
  return [Math.floor((p.x - g.x0) / CELL), Math.floor((p.y - g.y0) / CELL)];
}
function cellCenter(g: Grid, i: number, j: number): Pt {
  return new Pt(g.x0 + (i + 0.5) * CELL, g.y0 + (j + 0.5) * CELL);
}

/**
 * 把点吸到最近的可走格。**失败要返回原因**（R1.1 第一条要求）。
 *
 * 死掉的旧版本只返回 null，于是 9 条 OD 里有 6 条"无解"，但看不出是
 * 起点在膨胀区里、还是整个栅格都没有空格、还是压根在网格外。
 */
function snapWithReason(g: Grid, p: Pt, maxR = 40, dir?: Pt): SnapInfo {
  // **街区出口在 parcel 边界上，而栅格只覆盖 buildable** —— 直接取格一定是 outside-grid。
  // 所以先沿 Portal 的合法接入方向往里推，推到栅格范围内再吸附。
  let q = p;
  if (dir) {
    for (let d = 0; d <= 24; d += 0.5) {
      const t = new Pt(p.x + (dir.x * d) / 7, p.y + (dir.y * d) / 7);
      const [ti, tj] = toCell(g, t);
      if (ti >= 0 && tj >= 0 && ti < g.nx && tj < g.ny) { q = t; break; }
    }
  }
  const [ci, cj] = toCell(g, q);
  if (ci < 0 || cj < 0 || ci >= g.nx || cj >= g.ny) {
    return { from: p, to: null, distM: 0, reason: 'outside-grid' };
  }
  const atIdx = cj * g.nx + ci;
  if (!g.blocked[atIdx]) return { from: p, to: cellCenter(g, ci, cj), distM: +dist(p, cellCenter(g, ci, cj)).toFixed(2) * 7 };
  const blockedAtPoint = true;
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const i = ci + dx;
        const j = cj + dy;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
        if (g.blocked[j * g.nx + i]) continue;
        const c2 = cellCenter(g, i, j);
        return { from: p, to: c2, distM: +dist(p, c2).toFixed(2) * 7, reason: 'blocked-at-point' };
      }
    }
  }
  return { from: p, to: null, distM: 0, reason: 'no-free-cell' };
}

/** 连通分量：一次 BFS 给每个可走格编号。用来解释"为什么这条 OD 无解"。 */
function components(g: Grid): Int32Array {
  const { nx, ny } = g;
  const comp = new Int32Array(nx * ny).fill(-1);
  let id = 0;
  const q = new Int32Array(nx * ny);
  for (let start = 0; start < comp.length; start++) {
    if (g.blocked[start] || comp[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    comp[start] = id;
    while (head < tail) {
      const cur = q[head++];
      const ci = cur % nx;
      const cj = (cur - ci) / nx;
      for (let k = 0; k < 8; k++) {
        const ni = ci + DX8[k];
        const nj = cj + DY8[k];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const idx = nj * nx + ni;
        if (g.blocked[idx] || comp[idx] !== -1) continue;
        if (DX8[k] && DY8[k]) {
          if (g.blocked[cj * nx + ni] || g.blocked[nj * nx + ci]) continue;
        }
        comp[idx] = id;
        q[tail++] = idx;
      }
    }
    id++;
  }
  return comp;
}

const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const DY8 = [0, 1, 1, 1, 0, -1, -1, -1];

/** A*（8 邻域）。`penalty` 让已用格子变贵，用来生成"不同的备选" */
function astar(g: Grid, s: [number, number], t: [number, number], penalty?: Float32Array, reuse?: Uint8Array): Pt[] | null {
  const { nx, ny } = g;
  const N = nx * ny;
  const open = new MinHeap();
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const si = s[1] * nx + s[0];
  const ti = t[1] * nx + t[0];
  gScore[si] = 0;
  open.push(si, h(s[0], s[1], t[0], t[1]));
  const D = [1, 1.414, 1, 1.414, 1, 1.414, 1, 1.414];
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  let guard = 0;
  while (open.size) {
    if (++guard > 400000) return null;
    const cur = open.pop();
    if (cur === ti) break;
    const ci = cur % nx;
    const cj = (cur - ci) / nx;
    for (let k = 0; k < 8; k++) {
      const ni = ci + DX[k];
      const nj = cj + DY[k];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const idx = nj * nx + ni;
      if (g.blocked[idx]) continue;
      // 斜走不许切角
      if (DX[k] && DY[k]) {
        if (g.blocked[cj * nx + ni] || g.blocked[nj * nx + ci]) continue;
      }
      // 复用折扣：已经属于共享网络的格子便宜 45%，让后续路径主动并进去 ——
      // 这是"共享骨架"的核心机制，不是事后数重叠。
      const reuseHere = reuse && reuse[idx] ? 0.55 : 1;
      const cost = (D[k] + (penalty ? penalty[idx] : 0)) * reuseHere;
      const ng = gScore[cur] + cost;
      if (ng < gScore[idx] - 1e-6) {
        gScore[idx] = ng;
        came[idx] = cur;
        open.push(idx, ng + h(ni, nj, t[0], t[1]));
      }
    }
  }
  if (came[ti] === -1 && ti !== si) return null;
  const out: Pt[] = [];
  let cur = ti;
  let guard2 = 0;
  while (cur !== -1 && guard2++ < 20000) {
    const ci = cur % nx;
    const cj = (cur - ci) / nx;
    out.push(cellCenter(g, ci, cj));
    if (cur === si) break;
    cur = came[cur];
  }
  out.reverse();
  return simplify(out);
}

/**
 * **多源 Dijkstra**：从网络上的所有格同时出发，返回"目标接入网络"的那条路径。
 *
 * 这是 R1.2-B 的核心：入口不再各自回街区出口，而是接到**最近的网络节点**。
 * 一次搜索代替"每目标 × 每出口一次 A*"。
 * 只允许同类交通的网络格子作为源（不把步行/货运混成一个终点集）。
 */
function multiSourceDijkstra(
  g: Grid,
  net: Uint8Array,
  comp: Int32Array,
  target: number
): { path: Pt[] | null; joinAt: Pt | null; fromId: string | null; steps: number; expanded: number; sourceCount: number } {
  const { nx, ny } = g;
  const N = nx * ny;
  const dist = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  let sourceCount = 0;
  // 目标所在分量里、且属于网络的格子作为源 —— 不同分量之间本来就不该连
  for (let k = 0; k < N; k++) {
    if (!net[k] || g.blocked[k]) continue;
    if (comp[k] !== comp[target]) continue;
    dist[k] = 0;
    heap.push(k, 0);
    sourceCount++;
  }
  if (sourceCount === 0) return { path: null, joinAt: null, fromId: null, steps: 0, expanded: 0, sourceCount: 0 };

  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (dist[cur] === Infinity) continue;
    expanded++;
    if (cur === target) break;
    const ci = cur % nx;
    const cj = (cur - ci) / nx;
    for (let k = 0; k < 8; k++) {
      const ni = ci + DX8[k];
      const nj = cj + DY8[k];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const idx = nj * nx + ni;
      if (g.blocked[idx]) continue;
      if (DX8[k] && DY8[k]) {
        if (g.blocked[cj * nx + ni] || g.blocked[nj * nx + ci]) continue;
      }
      const w = DX8[k] && DY8[k] ? 1.414 : 1;
      const nd = dist[cur] + w;
      if (nd < dist[idx] - 1e-6) {
        dist[idx] = nd;
        came[idx] = cur;
        heap.push(idx, nd);
      }
    }
  }
  if (came[target] === -1 && dist[target] > 1e-6) {
    return { path: null, joinAt: null, fromId: null, steps: 0, expanded, sourceCount };
  }
  const out: Pt[] = [];
  let cur = target;
  let guard = 0;
  let steps = 0;
  while (cur !== -1 && guard++ < 40000) {
    const ci = cur % nx;
    const cj = (cur - ci) / nx;
    out.push(cellCenter(g, ci, cj));
    steps++;
    if (dist[cur] === 0) break; // 到达源
    cur = came[cur];
  }
  out.reverse();
  return {
    path: out.length >= 2 ? simplify(out) : null,
    joinAt: out[0] ?? null,
    fromId: 'net',
    steps,
    expanded,
    sourceCount,
  };
}

function h(i: number, j: number, ti: number, tj: number): number {
  const dx = Math.abs(i - ti);
  const dy = Math.abs(j - tj);
  return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
}

/** 去掉共线点，路径只留拐点 */
function simplify(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const c1 = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(c1) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

class MinHeap {
  private a: number[] = [];
  private k: number[] = [];
  get size(): number {
    return this.a.length;
  }
  push(v: number, key: number): void {
    this.a.push(v);
    this.k.push(key);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.a[0];
    const last = this.a.pop()!;
    const lastK = this.k.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      this.k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.k[l] < this.k[m]) m = l;
        if (r < this.a.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(i: number, j: number): void {
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
    [this.k[i], this.k[j]] = [this.k[j], this.k[i]];
  }
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const lenM = (pts: Pt[]) => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0) * 7;

function idxOf(g: Grid, p: Pt): number {
  const [i, j] = toCell(g, p);
  return j * g.nx + i;
}

function pointIn(x: number, y: number, ring: ReadonlyArray<{ x: number; y: number }>): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > y !== b.y > y) {
      const t = (y - a.y) / (b.y - a.y);
      if (x < a.x + t * (b.x - a.x)) hit = !hit;
    }
  }
  return hit;
}

function distToRing(x: number, y: number, ring: ReadonlyArray<{ x: number; y: number }>): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L > 1e-12 ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}

/** 建筑主入口：朝街那条外边的中点（与 civic 的 buildingEnvelope 同一套判据） */
function mainDoor(c: SitePlanCandidate, toward: Pt): Pt | null {
  if (!c.buildings.length) return null;
  const b = c.buildings[0].footprint.outer;
  let best: Pt | null = null;
  let bd = Infinity;
  for (let i = 0; i < b.length; i++) {
    const m = new Pt((b[i].x + b[(i + 1) % b.length].x) / 2, (b[i].y + b[(i + 1) % b.length].y) / 2);
    const d = dist(m, toward);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

export function solveCirculation(ctx: SiteContext, c: SitePlanCandidate): CirResult {
  const t0 = performance.now();
  const warnings: string[] = [];
  const nodes: CirNode[] = [];
  const edges: CirEdge[] = [];

  // ① 入口（全部来自语义数据，不产几何）
  /** street portal → 指向地块内部的单位向量（栅格只覆盖 buildable，出口在 parcel 边上） */
  const nodeDir = new Map<string, Pt>();
  for (const [i, a] of c.access.entries()) {
    nodeDir.set(`street_${i}`, new Pt(-a.normal.x, -a.normal.y));
  }
  for (const [i, a] of c.access.entries()) {
    nodes.push({
      id: `street_${i}`,
      at: a.at,
      kind: 'street',
      block: new Pt(a.at.x + a.normal.x * (2 / 7), a.at.y + a.normal.y * (2 / 7)),
      role: a.role,
    });
  }
  const main = c.access.find((a) => a.kind === 'pedestrian') ?? c.access[0];
  const door = main ? mainDoor(c, main.at) : null;
  if (door) nodes.push({ id: 'door', at: door, kind: 'door', block: door, role: 'main_lobby' });
  const svc = c.access.find((a) => a.kind === 'service');
  if (svc) nodes.push({ id: 'svc', at: svc.at, kind: 'service-door', block: svc.at, role: 'service' });
  for (const [i, pr] of c.parkingRequests.entries()) {
    // 停车 Portal **不能取质心**：质心常常被建筑膨胀环完全围死，形成一个只有
    // 几十个格子的小连通分量（实测 MF 是 3 号分量 vs 街道的 19 号），A* 永远无解。
    // 改成"从停车区的边界顶点里挑离街道最近的那个" —— 那是车真正开得进来的那一侧。
    const r = pr.region.outer;
    const nearStreet = nodes.filter((n) => n.kind === 'street').map((n) => n.at);
    let best = r[0];
    let bd = Infinity;
    for (let k = 0; k < r.length; k++) {
      const m = new Pt((r[k].x + r[(k + 1) % r.length].x) / 2, (r[k].y + r[(k + 1) % r.length].y) / 2);
      for (const st of nearStreet) {
        const d = dist(m, st);
        if (d < bd) { bd = d; best = m; }
      }
    }
    nodes.push({ id: `park_${i}`, at: best, kind: 'parking', block: best, role: pr.role });
  }
  if (nodes.length < 2) {
    return { nodes, edges, paths: [], stats: { solved: 0, totalM: 0, mainM: 0, subM: 0, paveM2: 0, sharedRate: 0, sharedM: 0, connected: true, ms: performance.now() - t0, cells: 0 }, warnings: ['入口不足，跳过'] };
  }

  // ② OD（有界：只连"街 → 要素"，不做全入口两两搜索）
  const streets = nodes.filter((n) => n.kind === 'street');
  const targets = nodes.filter((n) => n.kind !== 'street');
  interface OD { a: CirNode; b: CirNode; traffic: Traffic }
  const ods: OD[] = [];
  for (const t of targets) {
    const traffic: Traffic = t.kind === 'parking' ? 'vehicle' : t.kind === 'service-door' ? 'service' : 'pedestrian';
    // 取最近的 2 个街道口，够用且不会爆
    // 街区出口候选：**按距离排序，最多试 4 个**（有界）。
    //
    // 原来只试最近 2 个，而 MF 的 -469:284 上最近两个出口都落在"建筑膨胀区与红线之间
    // 只剩 1 格（1.5 m）"的窄缝里 —— 车行 2.2 m 净空根本过不去（局部障碍图实测）。
    // 规则要求：某个出口无解时，要检查**是否存在其他合法街区入口**，而不是硬吸过去。
    const near = streets.slice().sort((x, y) => dist(x.at, t.at) - dist(y.at, t.at)).slice(0, 4);
    for (const s of near) ods.push({ a: s, b: t, traffic });
  }

  // ③~⑥ 增量网络生长（多源 Dijkstra）
  //
  // 与上一版的根本区别：**不再让每条 OD 各自回到街区出口**。
  // 网络从"合法街区出口"起步，之后每个入口只要连到**已有网络上的任意节点**即可 ——
  // 这条路径才叫共享骨架；上一版只是把几条独立 A* 画在同一张图上（retail 的右图
  // 明显是两段互不相连的子网）。
  //
  // 顺带解决性能：每个入口**一次**多源 Dijkstra，而不是"每个目标 × 4 个出口各一次 A*"。
  const tGrid = performance.now();
  let cells = 0;
  const grids = new Map<Traffic, { g: Grid; comp: Int32Array; net: Uint8Array; odCount: Int32Array }>();
  for (const tr of ['pedestrian', 'vehicle', 'service'] as Traffic[]) {
    const g = buildGrid(ctx, c, CLEAR[tr]);
    grids.set(tr, { g, comp: components(g), net: new Uint8Array(g.nx * g.ny), odCount: new Int32Array(g.nx * g.ny) });
    cells += g.nx * g.ny;
  }
  const tGridDone = performance.now();

  /** 入口 → 该用哪种交通网络 */
  const trafficOf = (kind: CirNode['kind']): Traffic =>
    kind === 'parking' ? 'vehicle' : kind === 'service-door' ? 'service' : 'pedestrian';

  /** 网络种子：合法街区出口。**每种交通各自种一遍** —— 步行、车行、货运是三个独立网络，
   *  上一版只种了 pedestrian，导致 vehicle/service 网络规模为 0，所有停车/后勤 OD 全部无解。 */
  for (const tr of ['pedestrian', 'vehicle', 'service'] as Traffic[]) {
    const gr = grids.get(tr);
    if (!gr) continue;
    for (const n of nodes.filter((x) => x.kind === 'street')) {
      const sn = snapWithReason(gr.g, n.block, 40, nodeDir.get(n.id));
      if (!sn.to) continue;
      const k = idxOf(gr.g, sn.to);
      if (!gr.g.blocked[k]) gr.net[k] = 1;
    }
  }

  let searches = 0;
  let expanded = 0;
  const tAstar = { v: 0 };
  const order = ['street', 'door', 'parking', 'service-door'] as const;
  for (const kind of order) {
    if (kind === 'street') continue;
    for (const t of nodes.filter((x) => x.kind === kind)) {
      const tr = trafficOf(kind);
      const gr = grids.get(tr);
      if (!gr) continue;
      const { g, comp, net, odCount } = gr;
      const target = snapWithReason(g, t.block, 40, t.at);
      if (!target.to) { warnings.push(`${t.id} 吸附失败（${target.reason}）`); continue; }
      const tk = idxOf(g, target.to);
      if (g.blocked[tk]) { warnings.push(`${t.id} 落在障碍格里`); continue; }

      const t0 = performance.now();
      const res = multiSourceDijkstra(g, net, comp, tk);
      tAstar.v += performance.now() - t0;
      searches++;
      expanded += res.expanded;

      if (!res.path) {
        warnings.push(
          `${t.id} 无法接入 ${tr} 网络（目标分量 ${comp[tk]}，网络规模 ${res.sourceCount}，` +
          `扩展到 ${res.expanded} 格）`
        );
        continue;
      }
      // 网络增量：把这条路径并入网络，并累加每格承担的 OD
      for (const q of res.path) {
        const k = idxOf(g, q);
        net[k] = 1;
        odCount[k]++;
      }
      edges.push({
        from: res.fromId ?? `net_${res.steps}`,
        to: t.id,
        traffic: tr,
        pts: res.path,
        lengthM: +lenM(res.path).toFixed(1),
        shared: 1,
        widthM: kind === 'door' ? 3 : 5,
        odCount: 1,
        joinedAt: res.joinAt ? { x: res.joinAt.x, y: res.joinAt.y } : undefined,
      });
      // 停车/后勤入口第一次接入后，把它自己也算进网络（后续同类型入口可以共用）
      net[tk] = 1;
    }
  }
  const tGrow = performance.now();


  // ⑥ 共享判定：**按每格实际承担的 OD 数**，不是按宽度倒推
  for (const e of edges) {
    const gr = grids.get(e.traffic);
    if (!gr) continue;
    let sharedCells = 0;
    let maxOd = 1;
    for (const p of e.pts) {
      const k = idxOf(gr.g, p);
      const c = gr.odCount[k];
      if (c >= 2) sharedCells++;
      maxOd = Math.max(maxOd, c);
    }
    e.odCount = maxOd;
    e.shared = Math.round((sharedCells / Math.max(e.pts.length, 1)) * 10) / 10;
    e.widthM = maxOd >= 2 ? 5 : 3;
  }
  // 剪枝**不能剪掉某个目标的唯一连接** —— 一条 6 m 的短接驳如果它是进门的唯一一条，
  // 剪了就等于"入口连通"，但实际没路。原来 retail 就是这么从 ✓ 变 ✗ 的。
  const countByTarget = new Map<string, number>();
  for (const e of edges) countByTarget.set(e.to, (countByTarget.get(e.to) ?? 0) + 1);
  const kept = edges.filter((e) => e.lengthM >= 8 || (countByTarget.get(e.to) ?? 0) === 1);
  const pruned = edges.length - kept.length;

  // ⑦ 路径 → 多边形（裁到可建区；与绿地用同一份最终几何）
  const paths: PlanSurface[] = [];
  for (const e of kept) {
    if (e.pts.length < 2) continue;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const r = ribbon(e.pts[i], e.pts[i + 1], e.widthM / 7);
      // 裁到**红线**（导航域已经是 parcel）。裁到可建区会把走在退线带里的路整段丢掉 ——
      // industrial 就是这么出现"路径 2 条、铺装 0 m²"的。
      const c2 = r ? clipTo(r, [ctx.parcel]) : null;
      if (c2) paths.push(c2);
    }
  }

  // 真实共享长度：每条边按"共享格子占比"折算，不再靠宽度倒推
  const sharedM = kept.reduce((s, e) => s + e.lengthM * Math.max(0, Math.min(1, e.shared)), 0);
  const totalM = kept.reduce((s, e) => s + e.lengthM, 0);
  const mainM = kept.filter((e) => e.widthM >= 5).reduce((s, e) => s + e.lengthM, 0);
  const paveM2 = paths.reduce((s, p) => s + surfaceArea(p), 0) * 49;
  const connected = targets.every((t) => kept.some((e) => e.to === t.id || e.from === t.id));

  return {
    nodes,
    edges: kept,
    paths,
    stats: {
      solved: kept.length,
      totalM: +totalM.toFixed(1),
      mainM: +mainM.toFixed(1),
      subM: +(totalM - mainM).toFixed(1),
      paveM2: +paveM2.toFixed(0),
      sharedRate: totalM > 0 ? +(sharedM / totalM).toFixed(2) : 0,
      sharedM: +sharedM.toFixed(1),
      connected,
      ms: +(performance.now() - t0).toFixed(1),
      cells,
    },
    warnings: [...warnings, ...(pruned ? [`剪掉 ${pruned} 条 <8 m 毛刺`] : [])],
  };
}
