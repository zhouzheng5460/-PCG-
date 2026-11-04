// Archetype · Industrial / Rear-Load（PRD §P2.2 / §P2.3）
//
// 空间语法（一句话）：
//
//   PRIMARY ROAD
//   ── office forecourt / landscape buffer / employee parking
//   ┌──────────────────────────┐
//   │        WAREHOUSE         │   ← 长边平行主街，正立面朝主街
//   └──────────────────────────┘
//   ↓↓↓ loading apron ↓↓↓
//        truck court              ← 货车掉头 / 排队
//   ── service lane / truck gate ── SERVICE ROAD
//
// 一个 archetype 生成**三个方案**（居中 / 靠前 / 靠一侧），交给 Evaluator 选。
// 从这个文件开始正式摆脱"一个规则 → 一个结果"。
//
// 边界：只吃 SiteContext、只吐 SitePlanCandidate。不碰 Scene / three / renderer。

import { Pt } from '../../../../core/geom';
import {
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  insideSurface,
  type PlanSurface,
} from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type {
  PlannedAccess,
  PlannedBuilding,
  PlannedPath,
  PlannedRegion,
  ParkingRequest,
  SitePlanCandidate,
} from '../../core/candidate';
import { industrialDiagnostics } from '../../typologies/industrial';
import { evaluateLayout } from '../../core/evaluator';
import { INDUSTRIAL_WEIGHTS } from '../../typologies/industrial';
import { claimResidual } from '../shared/claim';

/** 米 → 世界单位（1 单位 ≈ 7 m） */
const U = (m: number) => m / 7;

/**
 * 强度档（R7.6）——不是"生成完再整体缩放"，而是**一开始就按不同强度生成**。
 *
 * 整体缩放会毁掉空间关系：仓库缩 0.6 倍，装卸面和货场跟着缩，卡车就掉不了头。
 * 这里的做法是：仓库按档位缩小，**让出来的纵深分给前场与货场**，
 * 于是 loading / truck court / service lane 的语法和层级完全不变。
 */
type Intensity = 'low' | 'medium' | 'high';

const INTENSITY_K: Record<Intensity, { w: number; d: number }> = {
  low: { w: 0.64, d: 0.62 },
  medium: { w: 0.7, d: 0.7 },
  high: { w: 0.78, d: 0.8 },
};

interface Variant {
  id: string;
  /** 前场进深占地块进深的比例 */
  frontRatio: number;
  /** 仓库在面宽方向的偏移比例（0 = 居中，正 = 偏一侧） */
  sideShift: number;
  /** 是否把 truck court 的进深加大（物流更强） */
  bigYard: boolean;
  /** 强度档：控制仓库基底占可建区的比例 */
  intensity: Intensity;
}

const VARIANTS: Variant[] = [
  // 位置 × 强度：4 个候选，不组合爆炸；强度档让 Evaluator 真有东西可选
  { id: 'centered-medium', frontRatio: 0.2, sideShift: 0, bigYard: false, intensity: 'medium' },
  { id: 'front-low', frontRatio: 0.12, sideShift: 0, bigYard: true, intensity: 'low' },
  { id: 'rear-high', frontRatio: 0.22, sideShift: 0, bigYard: false, intensity: 'high' },
  { id: 'side-medium', frontRatio: 0.19, sideShift: 0.14, bigYard: false, intensity: 'medium' },
];

/**
 * 生成 Rear-Load 候选。
 *
 * 没有主临街面（被完全包围的内部地块）时返回空数组 —— 这不是错误，
 * 那种地块该走另一套（内部通道）语法，不该硬套后装卸。
 */
export function generateIndustrialRearLoadCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const prim = ctx.primaryFrontage;
  if (!prim) return [];

  const buildable = ctx.buildableArea;
  if (buildable.outer.length < 3 || surfaceArea(buildable) < U(10) * U(10)) return [];

  // ---- 局部坐标系：o = 临街边中点，u = 沿街，v = 指向地块内部
  const [ea, eb] = prim.parcelEdge;
  const o = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const uDir = norm(new Pt(eb.x - ea.x, eb.y - ea.y));
  let vDir = new Pt(-uDir.y, uDir.x);
  if (!insideSurface(new Pt(o.x + vDir.x * 1.5, o.y + vDir.y * 1.5), buildable)) {
    vDir = new Pt(-vDir.x, -vDir.y);
  }
  const at = (lu: number, lv: number) => new Pt(o.x + uDir.x * lu + vDir.x * lv, o.y + uDir.y * lu + vDir.y * lv);

  // ---- 把可建区投影到局部系，得到面宽 / 进深
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of buildable.outer) {
    const du = (p.x - o.x) * uDir.x + (p.y - o.y) * uDir.y;
    const dv = (p.x - o.x) * vDir.x + (p.y - o.y) * vDir.y;
    if (du < u0) u0 = du;
    if (du > u1) u1 = du;
    if (dv < v0) v0 = dv;
    if (dv > v1) v1 = dv;
  }
  const W = u1 - u0;
  const D = v1 - v0;
  if (W < U(12) || D < U(30)) return []; // 太窄或太浅：放不下"前场 + 仓库 + 装卸"

  const out: SitePlanCandidate[] = [];
  for (const v of VARIANTS) {
    const cand = buildVariant(ctx, { at, u0, u1, v0, v1, W, D, variant: v });
    if (cand) out.push(cand);
  }
  // 评分 + 排序：从这一步开始"多个合理结果 → 评分选择"
  for (const c of out) {
    c.diagnostics = industrialDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: INDUSTRIAL_WEIGHTS }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

interface Frame {
  at: (lu: number, lv: number) => Pt;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  W: number;
  D: number;
  variant: Variant;
}

function buildVariant(ctx: SiteContext, f: Frame): SitePlanCandidate | null {
  const { at, u0, u1, v0, v1, W, D, variant } = f;
  const notes: string[] = [];

  // ---- 纵深分配（从后往前切，保证"仓库 + 装卸 + 货场"三者都在）
  // 纵深按**比例**分，只给"绝对下限"兜底。
  // 早先前后场都写成 clamp(比例, 6m, 18m)，大工地上比例算出来 50 m 会被夹到 18 m，
  // 三个变体于是长得一模一样 —— 变体差异必须由比例决定，不能被固定米数抹平。
  // 纵深分配按 TestFit Industrial 参考的比例：厂房 ~40%、货场/停车 ~45%、绿化带 ~15%。
  // 原来货场占 26~34%、前场再吃 20%，厂房只剩 21~25% 的进深 ——
  // 实测整块地建筑只占 13%（强度带下限是 16%），读起来是"一大片空场 + 一间仓"。
  const lane = U(7);
  let truck = Math.max(U(12), D * (variant.bigYard ? 0.28 : 0.21));
  const apron = Math.max(U(6), D * 0.07);
  let front = Math.max(U(6), D * variant.frontRatio * 0.6);
  let whDepth = D - front - apron - truck - lane;

  // 进深不够：先压前场，再压货场，保住仓库最小 18 m
  if (whDepth < U(18)) {
    front = Math.min(front, Math.max(U(5), D * 0.1));
    whDepth = D - front - apron - truck - lane;
    if (whDepth < U(18)) {
      truck = Math.max(U(12), D - front - apron - lane - U(18));
      whDepth = D - front - apron - truck - lane;
    }
  }
  // 强度档：仓库按档位缩小，**让出的纵深分给前场（45%）与货场（55%）**。
  // 这样仓库变小时，装卸坪/货场/服务道的关系不变，只是更宽松。
  const kk = INTENSITY_K[variant.intensity];
  const baseDepth = whDepth;
  whDepth = baseDepth * kk.d;
  const slack = baseDepth - whDepth;
  front += slack * 0.45;
  truck += slack * 0.55;

  if (whDepth < U(12)) {
    notes.push('进深不足：仓库 < 12 m，方案不可用');
    return null;
  }
  if (truck < U(10)) notes.push('truck court 偏浅（< 10 m），大车掉头困难');

  // ---- 仓库面宽与偏移
  const whW = Math.min(W * 0.86 * kk.w, W - U(8));
  if (whW < U(10)) return null;
  const shift = variant.sideShift * W;
  let whU0 = u0 + (W - whW) / 2 + shift;
  whU0 = Math.max(u0 + U(1), Math.min(u1 - whW - U(1), whU0));
  const whU1 = whU0 + whW;

  // ---- 各程序（局部矩形 → 世界 → 裁到可建区）
  const cut = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null => {
    if (lu1 - lu0 < U(2) || lv1 - lv0 < U(2)) return null;
    const rect = surface([at(lu0, lv0), at(lu1, lv0), at(lu1, lv1), at(lu0, lv1)]);
    const parts = surfaceIntersect([rect], [ctx.buildableArea]);
    if (parts.length === 0) return null;
    const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    return surfaceArea(best) > U(1) * U(1) ? best : null;
  };

  const ground: PlannedRegion[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };

  // 前场：靠街 40% 做办公前场（居中），两侧做绿化隔离，其余给员工停车
  const frontTop = v0 + front;
  add('office_forecourt', cut(u0 + W * 0.3, u0 + W * 0.7, v0, v0 + front * 0.45));
  add('landscape_buffer', cut(u0, u0 + W * 0.22, v0, v0 + front * 0.6));
  add('landscape_buffer', cut(u0 + W * 0.78, u1, v0, v0 + front * 0.6), '端部绿化');
  add('employee_parking', cut(u0 + W * 0.12, u0 + W * 0.88, v0 + front * 0.5, frontTop));

  // 仓库（正立面朝街 = -v，装卸面朝后 = +v）
  const wh = cut(whU0, whU1, frontTop, frontTop + whDepth);
  if (!wh) return null;

  // 后场：装卸面 → 货场 → 服务道
  const apronTop = frontTop + whDepth + apron;
  add('loading_apron', cut(whU0 - U(1), whU1 + U(1), frontTop + whDepth, apronTop));
  add('truck_court', cut(u0, u1, apronTop, v1 - lane));
  // 服务道在东端让出 22% 给设备场 —— 两个 program 不能压在同一个矩形上
  add('service_lane', cut(u0, u1 - W * 0.22, v1 - lane, v1));
  add('utility_yard', cut(u1 - W * 0.22, u1, v1 - lane, v1), '设备/变电');

  // 残地：可建区减掉已铺 + 仓库。
  //
  // 原来只认领**最大一块**，其余直接丢掉。丢掉的是新月形地块两侧的两条月牙
  // （合计 20.4% 的可建区）—— 它们在 Scene 里没有任何 program，
  // 2D 上就是一片纸面底色，读起来像"这块地没规划完"。
  claimResidual(ctx, 'industrial', [...ground.map((g) => g.surface), wh], add);

  // ---- 仓库的朝向：**按真实几何算**，不要简单用 ±v。
  // 不规则地块上（或 side-biased 变体里仓库偏在一侧），"从仓库中心指向
  // 临街边中点"的方向会明显偏离 v —— 用 ±v 当 frontSide 会让校验判成"正面没朝街"。
  const whCtr = centroidOf(wh.outer);
  const [pa, pb] = ctx.primaryFrontage!.parcelEdge;
  const frontTarget = nearestPointOnSegment(whCtr, pa, pb);
  const court0 = ground.find((g) => g.program === 'truck_court');
  const courtTarget = court0 ? centroidOf(court0.surface.outer) : at((whU0 + whU1) / 2, frontTop + whDepth + apron);
  const buildings: PlannedBuilding[] = [
    {
      role: 'warehouse',
      footprint: wh,
      height: U(9), // 单层高标库约 9 m（不做层数计算）
      frontSide: norm(new Pt(frontTarget.x - whCtr.x, frontTarget.y - whCtr.y)),
      loadingSide: norm(new Pt(courtTarget.x - whCtr.x, courtTarget.y - whCtr.y)),
      notes: [`进深 ${(whDepth * 7).toFixed(0)} m，面宽 ${(whW * 7).toFixed(0)} m`],
    },
  ];

  // ---- 出入口：车/人走主街，货车走后侧（有服务临街面就优先用它）
  const access: PlannedAccess[] = [];
  const edgePoint = (t: number): Pt => new Pt(
    ctx.primaryFrontage!.parcelEdge[0].x + (ctx.primaryFrontage!.parcelEdge[1].x - ctx.primaryFrontage!.parcelEdge[0].x) * t,
    ctx.primaryFrontage!.parcelEdge[0].y + (ctx.primaryFrontage!.parcelEdge[1].y - ctx.primaryFrontage!.parcelEdge[0].y) * t
  );
  const carAt = edgePoint(0.5);
  access.push({ kind: 'vehicle', at: carAt, normal: negate(dirV(f)), role: 'car', frontage: 'primary' });
  access.push({ kind: 'pedestrian', at: edgePoint(0.32), normal: negate(dirV(f)), role: 'pedestrian', frontage: 'primary' });

  const svc = ctx.serviceFrontage;
  const svcIsPrimary = !svc || svc === ctx.primaryFrontage;
  if (svcIsPrimary) {
    // 只有一条临街面：货车口也开在这条上，但要拉开距离并留痕
    access.push({
      kind: 'truck',
      at: edgePoint(0.88),
      normal: negate(dirV(f)),
      role: 'truck',
      frontage: 'primary',
      notes: ['SHARED_FRONTAGE_SERVICE'],
    });
    notes.push('SHARED_FRONTAGE_SERVICE：没有独立服务临街面，货车口与客用口共用主街');
  } else {
    const [sa, sb] = svc.parcelEdge;
    access.push({
      kind: 'truck',
      at: new Pt((sa.x + sb.x) / 2, (sa.y + sb.y) / 2),
      normal: norm(new Pt((sa.x + sb.x) / 2 - centroidOf(ctx.parcel.outer).x, (sa.y + sb.y) / 2 - centroidOf(ctx.parcel.outer).y)),
      role: 'truck',
      frontage: 'service',
    });
  }

  // ---- 停车需求（只声明区域，不排车位）
  const parking = ground.find((g) => g.program === 'employee_parking');
  const parkingRequests: ParkingRequest[] = [];
  if (parking) {
    parkingRequests.push({
      role: 'employee',
      region: parking.surface,
      preferredEntry: carAt,
      targetDensity: 'medium',
      notes: ['Phase 2 只给区域，车位由 parking.ts 消费'],
    });
  }

  // ---- 内部通道（货车从 gate 到 apron 的一条线）
  const circulation: PlannedPath[] = [];
  const court = ground.find((g) => g.program === 'truck_court');
  if (court) {
    const c0 = at((whU0 + whU1) / 2, apronTop);
    const c1 = at((whU0 + whU1) / 2, v1 - lane);
    circulation.push({ pts: [c0, c1], width: U(7), role: 'truck' });
  }

  const id = `ind-rear-${variant.id}`;
  return {
    id,
    typology: 'industrial',
    archetype: 'IND_REAR_LOAD',
    buildings,
    ground,
    access,
    parkingRequests,
    circulation,
    notes,
  };
}

// ---------------------------------------------------------------- 局部工具

function dirV(f: Frame): Pt {
  // 由 at() 反推 v 方向：at(0,1) - at(0,0)
  const p0 = f.at(0, 0);
  const p1 = f.at(0, 1);
  return norm(new Pt(p1.x - p0.x, p1.y - p0.y));
}

function negate(p: Pt): Pt {
  return new Pt(-p.x, -p.y);
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

/** 点到线段的最近点（求"正面朝向"用） */
function nearestPointOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return new Pt(a.x + dx * t, a.y + dy * t);
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}
