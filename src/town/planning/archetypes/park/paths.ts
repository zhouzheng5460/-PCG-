// Archetype · Park（城市公园）— 阶段 C 重写内部组织
//
// ## 从"十字两条线"改成"环路 + 节点"
//
// 阶段 B 的版本是在大草坪上打一个十字：入口→中心，中心→两侧。骨架只有两条
// 正交直线，其余全是草 —— 用户点名的就是这种「大面积草坪 + 几条交叉线」的
// 单调模式。它的问题不是难看，是**没有功能**：十字之外的地方没有任何理由去。
//
// 真实公园的组织永远是环路：
//
//     街 → 入口 → 环路 → 节点（可停留）→ 中心（可聚）
//
// 环路沿着地块形状走，人绕着走、随时能离开；节点挂在环路上，是有目的的点；
// 中心由环路引一条短支路，不是让所有路都穿过它。
//
// ## 顺序（C2 的联合规划）
//
//   ① 锚点：街道接入点（每条临街面一个）、绿核（内缩 14 m 后最大的一块）
//   ② 环路：`内缩(d−w/2) − 内缩(d+w/2)`，天然贴合地块形状
//   ③ 入口支路：街道接入点 → 环路（每条入口一条，长度 = d）
//   ④ 节点：沿环路的弧长等分取 3 个点，各挂一块 10~16 m 见方的场地
//   ⑤ 中心：绿核质心，由**最近的环路点**引一条支路进去
//   ⑥ 绿：草坪 = 可建区 − 环路 − 支路 − 场地；种植带 = 可建区 − 内缩(10 m)
//
// 环路失败（窄地块内缩塌掉）时退回十字骨架 —— 宁可简单，不要破面。

import { Pt } from '../../../../core/geom';
import { surfaceArea, surfaceInset, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import { siteFrame, ribbon, clipTo, minusAll, type SiteFrame } from '../shared/frame';
import { streetAccessPoints, greenCoreOf, streetBuffer } from '../shared/anchors';
import { areaBudgetOf, formatBudget } from '../shared/budget';
import { evaluateLayout, weightsFor } from '../../core/evaluator';
import { parkDiagnostics } from '../../typologies/park';

const U = (m: number) => m / 7;

type Variant = 'park-loop' | 'park-cross' | 'park-pocket';

interface Spec {
  id: Variant;
  /** 环路中心线到边界的距离（m） */
  loopM: number;
  /** 环路宽（m） */
  loopW: number;
  /** 挂几个节点 */
  nodes: number;
  /** 是否从环路引一条支路去中心 */
  center: boolean;
}

const LOOP: Spec = { id: 'park-loop', loopM: 17, loopW: 4, nodes: 3, center: true };
const CROSS: Spec = { id: 'park-cross', loopM: 0, loopW: 0, nodes: 2, center: true };
const POCKET: Spec = { id: 'park-pocket', loopM: 0, loopW: 0, nodes: 1, center: false };

const POCKET_ONLY_M2 = 4000;
const LOOP_MIN_M2 = 9000;

export function generateParkCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const f = siteFrame(ctx);
  if (!f) return [];
  const lotM2 = surfaceArea(ctx.parcel) * 49;
  if (lotM2 < 400) return [];

  // 变体由**规模**决定，不是让评分器在同分方案里挑：
  //   小 → 口袋公园（一块场地 + 一条路，别硬塞环路）
  //   中 → 十字骨架
  //   大 → 环路（首选）+ 十字（兜底候选）
  const specs: Spec[] = lotM2 < POCKET_ONLY_M2 ? [POCKET] : lotM2 < LOOP_MIN_M2 ? [CROSS] : [LOOP, CROSS];
  const out: SitePlanCandidate[] = [];
  for (const spec of specs) {
    const c = build(ctx, f, spec);
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = parkDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('park') }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

function build(ctx: SiteContext, f: SiteFrame, spec: Spec): SitePlanCandidate | null {
  const buildable = ctx.buildableArea;
  const lotA = surfaceArea(buildable);
  if (lotA < U(10) * U(10)) return null;

  const ground: PlannedRegion[] = [];
  const access: PlannedAccess[] = [];
  const notes: string[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };
  /** 已经铺掉的硬质面（环路 / 支路 / 场地），草坪要减掉它们 */
  const hard: PlanSurface[] = [];

  // ---- ① 锚点
  const streets = streetAccessPoints(ctx, f);
  const core = greenCoreOf(buildable, 14);
  const center = centroid(core ?? buildable);

  // ---- ② 环路
  const loop = spec.loopM > 0 ? buildLoop(buildable, spec) : null;
  const used: 'loop' | 'cross' = loop ? 'loop' : 'cross';
  if (loop) {
    for (const piece of loop) {
      add('pedestrian', piece, `环路（距边界 ${spec.loopM} m，宽 ${spec.loopW} m）`);
      hard.push(piece);
    }
    notes.push(`环形主路：距边界 ${spec.loopM} m，宽 ${spec.loopW} m`);
  }

  // ---- ③ 入口支路
  for (const e of streets.slice(0, 2)) {
    // 起点必须**贴到红线**（0.5 m），不能从 1.5 m 处起 —— 原来留的这 10.5 m 缝
    // 让"街道 → 入口"断在半路（D4 实测：入口连通 0/2，所有公园都这样）。
    // 方向仍用 `f.vDir`（主临街面内向）。
    //
    // D4 试过改成"每条边自己的法线"，结果 3/4 变 2/4 —— 次临街面在张量场切出来的
    // 地块上常常是斜的，自己的法线指向的并不是"往里去"而是"斜着穿"。这条留作
    // 已知问题记录在报告里（要修得先有"从边到环路的最近落点"，属于重写生成器）。
    const dir = f.vDir;
    const start = new Pt(e.at.x + dir.x * U(0.5), e.at.y + dir.y * U(0.5));
    const lenU = used === 'loop' ? U(spec.loopM + spec.loopW) : null;
    const end = lenU !== null ? new Pt(start.x + dir.x * lenU, start.y + dir.y * lenU) : center;
    // 入口支路裁到**红线**而不是可建区：它本来就是穿过退线带接到街上的那一段，
    // 裁到可建区就等于在离街 5 m 的地方断头（D4 实测入口连通 0/2 —— 差的正是这 5 m）。
    const r = ribbon(start, end, U(4));
    const clipped = r ? clipTo(r, [ctx.parcel]) : null;
    if (clipped) {
      add('pedestrian', clipped, used === 'loop' ? '入口支路（街 → 环路）' : '主步道（入口 → 中心）');
      hard.push(clipped);
    }
    access.push({
      kind: 'pedestrian',
      at: e.at,
      normal: dir,
      role: 'pedestrian',
      frontage: e.note.includes('主') ? 'primary' : 'secondary',
      notes: [e.note],
    });
  }

  // ---- ④ 节点：挂在环路上（沿弧长等分）
  const nodeSize = Math.min(U(16), Math.max(U(9), Math.sqrt(lotA) * 0.16));
  const ring = loop ? largestRing(loop) : null;
  const nodePts = ring ? pickAlongRing(ring, spec.nodes) : [];
  for (const p of nodePts) {
    const n = squareAt(f, p, nodeSize);
    const clipped = n ? clipTo(n, [buildable]) : null;
    if (!clipped) continue;
    add('amenity', clipped, '活动节点（挂在环路上）');
    hard.push(clipped);
  }

  // ---- ⑤ 中心：由环路引一条支路，不穿过它
  if (spec.center) {
    const plaza = squareAt(f, center, nodeSize * 1.15);
    const clipped = plaza ? clipTo(plaza, [buildable]) : null;
    if (clipped) {
      add('entrance_forecourt', clipped, '中心场地');
      hard.push(clipped);
      const from = ring ? nearestRingPoint(ring, center) : null;
      if (from) {
        const r = ribbon(from, center, U(3));
        const c2 = r ? clipTo(r, [buildable]) : null;
        if (c2) {
          add('park_path', c2, '中心支路（环路 → 中心）');
          hard.push(c2);
        }
      }
    }
  }

  // ---- ⑥ 绿：草坪 = 可建区 − 硬质；种植带 = 外围 10 m
  const bandPieces = surfaceInset(buildable, U(10)).filter((p) => surfaceArea(p) > U(6) * U(6));
  const big = surfaceArea(buildable) > U(40) * U(40);
  const lawnBase =
    bandPieces.length > 0 && big ? bandPieces.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b)) : buildable;
  for (const lp of minusAll(lawnBase, hard)) add('lawn', lp, lawnBase === buildable ? '整片草坪' : '环路内草坪');
  if (lawnBase !== buildable) {
    for (const p of minusAll(buildable, [lawnBase])) add('planting', p, '外圈 10 m 种植带（不可进入）');
    notes.push('外圈 10 m 种植带 + 环路内草坪');
  } else {
    // 没有外圈种植带时，沿街至少留一条 5 m 绿化缓冲（"对道路边界形成合理缓冲"）
    for (const s of streetBuffer(ctx, f, buildable, 5)) add('planting', s, '沿街绿化缓冲 5 m');
  }

  if (ground.length === 0) return null;

  const budget = areaBudgetOf(ctx, ground, []);
  notes.push(formatBudget(budget));

  return {
    id: spec.id,
    typology: 'park',
    archetype: spec.id,
    buildings: [],
    ground,
    access,
    parkingRequests: [],
    circulation: [],
    notes,
  };
}

// ---------------------------------------------------------------- 局部工具

/** 环路：对**同一个**可建区做两次内缩再求差，得到一圈等宽的环。 */
function buildLoop(buildable: PlanSurface, spec: Spec): PlanSurface[] | null {
  const d = U(spec.loopM);
  const hw = U(spec.loopW) / 2;
  if (d - hw < U(6)) return null;
  const outer = surfaceInset(buildable, d - hw).filter((q) => surfaceArea(q) > U(4) * U(4));
  const inner = surfaceInset(buildable, d + hw).filter((q) => surfaceArea(q) > U(4) * U(4));
  if (!outer.length || !inner.length) return null;
  const shell = outer.reduce((a, c) => (surfaceArea(a) >= surfaceArea(c) ? a : c));
  const hole = inner.reduce((a, c) => (surfaceArea(a) >= surfaceArea(c) ? a : c));
  // 两次内缩都是**同一个面**的结果，边界平行，减出来的环带面积是对的。
  // （如果第二次内缩是拿第一次的结果再缩，边界已经带锯齿，减法会碎成十几片。）
  const ring = minusAll(shell, [hole]).filter((q) => surfaceArea(q) > U(6) * U(6));
  if (!ring.length) return null;
  const a = ring.reduce((s2, q) => s2 + surfaceArea(q), 0);
  if (a < U(30) || a > surfaceArea(buildable) * 0.45) return null;
  return ring;
}

function largestRing(pieces: PlanSurface[]): Pt[] {
  return pieces.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b)).outer;
}

/** 沿环的弧长等分取 n 个点 */
function pickAlongRing(ring: Pt[], n: number): Pt[] {
  if (ring.length < 4 || n <= 0) return [];
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push(l);
    total += l;
  }
  if (total < 1e-6) return [];
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const target = (total * (k + 0.5)) / n;
    let acc = 0;
    for (let i = 0; i < ring.length; i++) {
      if (acc + segs[i] >= target) {
        const t = (target - acc) / Math.max(segs[i], 1e-9);
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        out.push(new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        break;
      }
      acc += segs[i];
    }
  }
  return out;
}

/** 环上离 p 最近的点 */
function nearestRingPoint(ring: Pt[], p: Pt): Pt | null {
  let best: Pt | null = null;
  let bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const q = new Pt(a.x + dx * t, a.y + dy * t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** 以 p 为中心、边长 side 的方块（局部坐标对齐） */
function squareAt(f: SiteFrame, p: Pt, side: number): PlanSurface | null {
  const du = (p.x - f.origin.x) * f.uDir.x + (p.y - f.origin.y) * f.uDir.y;
  const dv = (p.x - f.origin.x) * f.vDir.x + (p.y - f.origin.y) * f.vDir.y;
  return f.cut(du - side / 2, du + side / 2, dv - side / 2, dv + side / 2);
}

function centroid(s: PlanSurface): Pt {
  const r = s.outer;
  return new Pt(r.reduce((a, p) => a + p.x, 0) / r.length, r.reduce((a, p) => a + p.y, 0) / r.length);
}
