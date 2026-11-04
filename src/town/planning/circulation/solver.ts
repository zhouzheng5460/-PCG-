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
    connected: boolean;
    ms: number;
    cells: number;
  };
  warnings: string[];
}

/** 交通类型 → 需要的净空半径（m）。车要 3 m 才开得过去 */
const CLEAR: Record<Traffic, number> = { pedestrian: 0.5, vehicle: 2.2, service: 2.2 };

interface Grid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  /** 0 = 可走，1 = 建筑/不可走 */
  blocked: Uint8Array;
  inset: PlanSurface;
}

function buildGrid(ctx: SiteContext, c: SitePlanCandidate, clearanceM: number): Grid {
  const r = ctx.buildableArea.outer;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const nx = Math.max(2, Math.ceil((x1 - x0) / CELL));
  const ny = Math.max(2, Math.ceil((y1 - y0) / CELL));
  const blocked = new Uint8Array(nx * ny);
  const clr = clearanceM / 7;

  const inside = (x: number, y: number) => pointIn(x, y, ctx.buildableArea.outer);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = x0 + (i + 0.5) * CELL;
      const y = y0 + (j + 0.5) * CELL;
      if (!inside(x, y)) { blocked[j * nx + i] = 1; continue; }
      for (const b of c.buildings) {
        if (distToRing(x, y, b.footprint.outer) < clr) { blocked[j * nx + i] = 1; break; }
      }
    }
  }
  return { x0, y0, nx, ny, blocked, inset: ctx.buildableArea };
}

function toCell(g: Grid, p: Pt): [number, number] {
  return [Math.floor((p.x - g.x0) / CELL), Math.floor((p.y - g.y0) / CELL)];
}
function cellCenter(g: Grid, i: number, j: number): Pt {
  return new Pt(g.x0 + (i + 0.5) * CELL, g.y0 + (j + 0.5) * CELL);
}

/** 把起点吸到最近的可走格（入口常常正好贴着建筑/边界） */
function snap(g: Grid, p: Pt, maxR = 24): [number, number] | null {
  const [ci, cj] = toCell(g, p);
  for (let r = 0; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const i = ci + dx;
        const j = cj + dy;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
        if (!g.blocked[j * g.nx + i]) return [i, j];
      }
    }
  }
  return null;
}

/** A*（8 邻域）。`penalty` 让已用格子变贵，用来生成"不同的备选" */
function astar(g: Grid, s: [number, number], t: [number, number], penalty?: Float32Array): Pt[] | null {
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
      const cost = D[k] + (penalty ? penalty[idx] : 0);
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
    const r = pr.region.outer;
    const cx = r.reduce((s, q) => s + q.x, 0) / r.length;
    const cy = r.reduce((s, q) => s + q.y, 0) / r.length;
    nodes.push({ id: `park_${i}`, at: new Pt(cx, cy), kind: 'parking', block: new Pt(cx, cy), role: pr.role });
  }
  if (nodes.length < 2) {
    return { nodes, edges, paths: [], stats: { solved: 0, totalM: 0, mainM: 0, subM: 0, paveM2: 0, sharedRate: 0, connected: true, ms: performance.now() - t0, cells: 0 }, warnings: ['入口不足，跳过'] };
  }

  // ② OD（有界：只连"街 → 要素"，不做全入口两两搜索）
  const streets = nodes.filter((n) => n.kind === 'street');
  const targets = nodes.filter((n) => n.kind !== 'street');
  interface OD { a: CirNode; b: CirNode; traffic: Traffic }
  const ods: OD[] = [];
  for (const t of targets) {
    const traffic: Traffic = t.kind === 'parking' ? 'vehicle' : t.kind === 'service-door' ? 'service' : 'pedestrian';
    // 取最近的 2 个街道口，够用且不会爆
    const near = streets.slice().sort((x, y) => dist(x.at, t.at) - dist(y.at, t.at)).slice(0, 2);
    for (const s of near) ods.push({ a: s, b: t, traffic });
  }

  // ③~⑤ 逐个交通类型建栅格 → A* → 记账
  const usage = new Map<Traffic, Map<number, number>>();
  let cells = 0;
  const grids = new Map<Traffic, Grid>();
  for (const tr of ['pedestrian', 'vehicle', 'service'] as Traffic[]) {
    if (!ods.some((o) => o.traffic === tr)) continue;
    const g = buildGrid(ctx, c, CLEAR[tr]);
    grids.set(tr, g);
    cells += g.nx * g.ny;
    const use = new Map<number, number>();
    usage.set(tr, use);
    for (const od of ods.filter((o) => o.traffic === tr)) {
      const s = snap(g, od.a.block);
      const t = snap(g, od.b.block);
      if (!s || !t) { warnings.push(`${od.a.id}→${od.b.id} 落不进栅格`); continue; }
      // 有界候选：先跑一次；若与已有路径重复 >80%，对已用格子加惩罚再跑一次
      let best = astar(g, s, t);
      if (!best) { warnings.push(`${od.a.id}→${od.b.id} 无解`); continue; }
      const replay = best.filter((p) => {
        const [i, j] = toCell(g, p);
        return use.has(j * g.nx + i);
      }).length / Math.max(best.length, 1);
      if (replay > 0.8) {
        const pen = new Float32Array(g.nx * g.ny);
        for (const k of use.keys()) pen[k] = 6;
        const alt = astar(g, s, t, pen);
        if (alt && alt.length && lenM(alt) < lenM(best) * 1.6) best = alt;
      }
      for (const p of best) {
        const [i, j] = toCell(g, p);
        const k = j * g.nx + i;
        use.set(k, (use.get(k) ?? 0) + 1);
      }
      edges.push({
        from: od.a.id,
        to: od.b.id,
        traffic: od.traffic,
        pts: best,
        lengthM: +lenM(best).toFixed(1),
        shared: 1,
        widthM: od.traffic === 'pedestrian' ? 3 : 5,
      });
    }
  }

  // ⑥ 共享判定 + 剪枝（<8 m 且不接任何别的路的毛刺）
  for (const e of edges) {
    const g = grids.get(e.traffic);
    const use = usage.get(e.traffic);
    if (!g || !use) continue;
    let sharedCells = 0;
    for (const p of e.pts) {
      const [i, j] = toCell(g, p);
      if ((use.get(j * g.nx + i) ?? 0) >= 2) sharedCells++;
    }
    e.shared = Math.round((sharedCells / Math.max(e.pts.length, 1)) * 10) / 10;
    e.widthM = e.shared >= 0.5 ? 5 : 3;
  }
  const kept = edges.filter((e) => e.lengthM >= 8);
  const pruned = edges.length - kept.length;

  // ⑦ 路径 → 多边形（裁到可建区；与绿地用同一份最终几何）
  const paths: PlanSurface[] = [];
  for (const e of kept) {
    if (e.pts.length < 2) continue;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const r = ribbon(e.pts[i], e.pts[i + 1], e.widthM / 7);
      const c2 = r ? clipTo(r, [ctx.buildableArea]) : null;
      if (c2) paths.push(c2);
    }
  }

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
      sharedRate: kept.length ? +(kept.filter((e) => e.widthM >= 5).length / kept.length).toFixed(2) : 0,
      connected,
      ms: +(performance.now() - t0).toFixed(1),
      cells,
    },
    warnings: [...warnings, ...(pruned ? [`剪掉 ${pruned} 条 <8 m 毛刺`] : [])],
  };
}
