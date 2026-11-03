// Archetype · Data Center / Single Hall（PRD §11 / 用户 §4 的四个候选）
//
// 顺序（和工业像、但原因不同）：
//   Buildable Area → **Data Hall 先生成** → Mechanical 邻接 → Electrical 邻接
//   → Service 贯通 → Admin/Parking → Security Buffer
//
// 为什么 hall 必须先定：DC 的视觉可信度全在"一个非常规整的主 Hall +
// 有组织地贴着它的设备区"。如果反过来先切地面再塞设备，出来的就是
// "又一个仓库 + 几个杂物堆"。
//
// 四个候选：
//   dc-single-balanced      设备在后，左右分开（baseline）
//   dc-single-utility-side  设备集中一侧（窄地块用）
//   dc-single-rear-utility  设备全部退后（前人后设备）
//   dc-single-split-utility 设备分列 hall 两侧

import { Pt } from '../../../../core/geom';
import { surface, surfaceArea, surfaceIntersect, surfaceSubtract, insideSurface, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedBuilding, PlannedRegion, ParkingRequest, SitePlanCandidate } from '../../core/candidate';
import { dcDiagnostics } from '../../typologies/datacenter';
import { evaluateLayout, weightsFor } from '../../core/evaluator';

const U = (m: number) => m / 7;

interface Variant {
  id: string;
  /** 设备场布置：后侧左右 / 集中一侧 / 全部退后 / 分列两侧 */
  utility: 'rear' | 'side' | 'rear-full' | 'split';
  /** hall 占可建区的宽度比例 */
  hallW: number;
  /** hall 占可建区的进深比例 */
  hallD: number;
}

const VARIANTS: Variant[] = [
  { id: 'dc-single-balanced', utility: 'rear', hallW: 0.72, hallD: 0.42 },
  { id: 'dc-single-utility-side', utility: 'side', hallW: 0.6, hallD: 0.5 },
  { id: 'dc-single-rear-utility', utility: 'rear-full', hallW: 0.78, hallD: 0.36 },
  { id: 'dc-single-split-utility', utility: 'split', hallW: 0.56, hallD: 0.52 },
];

export function generateDataCenterSingleHallCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const prim = ctx.primaryFrontage;
  if (!prim) return [];
  const buildable = ctx.buildableArea;
  if (buildable.outer.length < 3) return [];

  const [ea, eb] = prim.parcelEdge;
  const o = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const uDir = norm(new Pt(eb.x - ea.x, eb.y - ea.y));
  let vDir = new Pt(-uDir.y, uDir.x);
  if (!insideSurface(new Pt(o.x + vDir.x * 1.5, o.y + vDir.y * 1.5), buildable)) vDir = new Pt(-vDir.x, -vDir.y);
  const at = (lu: number, lv: number) => new Pt(o.x + uDir.x * lu + vDir.x * lv, o.y + uDir.y * lu + vDir.y * lv);

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
  // 最小地块：面宽 40 m、进深 55 m（缓冲 + 员工区 + hall + 设备场 + 服务道）
  if (W < U(40) || D < U(55)) return [];

  const out: SitePlanCandidate[] = [];
  for (const v of VARIANTS) {
    const c = buildVariant(ctx, { at, u0, u1, v0, v1, W, D, variant: v });
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = dcDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('data_center') }).score;
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
  const frontD = U(16); // 员工/访客区（gate + 停车 + admin）
  const laneD = U(8); // 后勤环路
  const bufD = U(6); // 安防缓冲宽带

  const hallW = W * variant.hallW;
  const hallD = Math.max(U(28), D * variant.hallD);
  const uMid = (u0 + u1) / 2;

  // 侧向设备：让 hall 偏一侧，另一侧给设备
  const sideW = variant.utility === 'side' ? W * 0.26 : 0;
  const splitW = variant.utility === 'split' ? W * 0.16 : 0;

  let hU0 = uMid - hallW / 2;
  let hU1 = uMid + hallW / 2;
  if (variant.utility === 'side') {
    hU0 = u0 + sideW + W * 0.02;
    hU1 = hU0 + hallW;
  } else if (variant.utility === 'split') {
    hU0 = u0 + splitW + W * 0.02;
    hU1 = hU0 + hallW;
  }
  if (hU1 > u1 - U(2)) {
    hU1 = u1 - U(2);
    hU0 = Math.max(u0 + U(2), hU1 - hallW);
  }

  const hV0 = v0 + frontD;
  const hV1 = Math.min(v1 - laneD, hV0 + hallD);
  if (hV1 - hV0 < U(24)) {
    notes.push(`进深不足：hall 只有 ${((hV1 - hV0) * 7).toFixed(0)} m`);
    return null;
  }

  const cut = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null => {
    if (lu1 - lu0 < U(2) || lv1 - lv0 < U(2)) return null;
    const rect = surface([at(lu0, lv0), at(lu1, lv0), at(lu1, lv1), at(lu0, lv1)]);
    const parts = surfaceIntersect([rect], [ctx.buildableArea]);
    if (parts.length === 0) return null;
    const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    return surfaceArea(best) > U(1) * U(1) ? best : null;
  };

  // ---- ① Data Hall 先生成（规整矩形为主）
  const hall = cut(hU0, hU1, hV0, hV1);
  if (!hall) return null;
  const buildings: PlannedBuilding[] = [
    {
      role: 'hall',
      footprint: hall,
      height: U(14), // 单层高大厅（≈14 m）
      notes: [`data hall ${((hU1 - hU0) * 7).toFixed(0)}×${((hV1 - hV0) * 7).toFixed(0)} m`],
    },
  ];

  const ground: PlannedRegion[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };

  // ---- ② 设备场：按变体贴着 hall
  const yardD = Math.max(U(10), v1 - laneD - hV1); // 后侧进深
  if (variant.utility === 'rear' || variant.utility === 'rear-full') {
    const yardU0 = variant.utility === 'rear' ? hU0 : u0;
    const yardU1 = variant.utility === 'rear' ? hU1 : u1;
    const half = (yardU0 + yardU1) / 2;
    add('mechanical_yard', cut(yardU0, half - W * 0.01, hV1, hV1 + yardD), '贴着 hall 后侧（西半）');
    add('electrical_yard', cut(half + W * 0.01, yardU1, hV1, hV1 + yardD), '贴着 hall 后侧（东半）');
  } else if (variant.utility === 'side') {
    // 西侧一条设备带，沿 v **分两段**：两段都能贴着 hall 的侧边
    //（早先按 u 并排分，结果 mechanical 被 electrical 隔开、邻接度归零）
    const vMid = (hV0 + hV1) / 2;
    add('mechanical_yard', cut(u0, hU0 - W * 0.01, hV0, vMid), '西侧设备场（贴 hall 南段）');
    add('electrical_yard', cut(u0, hU0 - W * 0.01, vMid + W * 0.01, hV1), '西侧变电场（贴 hall 北段）');
  } else {
    add('mechanical_yard', cut(u0, hU0 - W * 0.01, hV0, hV1), 'hall 西侧');
    add('electrical_yard', cut(hU1 + W * 0.01, u1, hV0, hV1), 'hall 东侧');
  }

  // ---- ③ 后勤环路（后侧贯通一条，触达两个设备场）
  add('service', cut(u0, u1, v1 - laneD, v1), '后勤环道（贯通设备全场）');

  // ---- ④ 员工/访客区 + 安防缓冲
  add('parking', cut(u0 + W * 0.06, u0 + W * 0.34, v0 + bufD, v0 + frontD), '员工停车（小片区）');
  add('entrance_forecourt', cut(u0 + W * 0.4, u0 + W * 0.6, v0 + bufD, v0 + frontD), '门厅/安防岗');
  add('security_buffer', cut(u0, u1, v0, v0 + bufD), '临街安防缓冲（hall 不贴红线）');
  add('security_buffer', cut(u0, u0 + U(6), v0 + bufD, hV1), '西侧安防带');
  add('security_buffer', cut(u1 - U(6), u1, v0 + bufD, hV1), '东侧安防带');
  add('landscape', cut(u0 + W * 0.64, u0 + W * 0.94, v0 + bufD, v0 + frontD), '门前绿化');

  // ---- ⑤ 残地
  const used: PlanSurface[] = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  const rest = surfaceSubtract([ctx.buildableArea], used);
  if (rest.length > 0) {
    const big = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    if (surfaceArea(big) > surfaceArea(ctx.buildableArea) * 0.01) add('residual', big);
  }

  // ---- ⑥ 出入口：员工门 / 后勤门分开
  const edgePoint = (t: number): Pt => {
    const [a, b] = ctx.primaryFrontage!.parcelEdge;
    return new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  };
  const outward = norm(new Pt(o0(f).x - centroidOf(ctx.parcel.outer).x, o0(f).y - centroidOf(ctx.parcel.outer).y));
  const access: PlannedAccess[] = [
    { kind: 'vehicle', at: edgePoint(0.25), normal: outward, role: 'car', frontage: 'primary' },
    { kind: 'pedestrian', at: edgePoint(0.45), normal: outward, role: 'pedestrian', frontage: 'primary' },
  ];

  const svcFace = ctx.serviceFrontage;
  if (svcFace && svcFace !== ctx.primaryFrontage) {
    const [sa, sb] = svcFace.parcelEdge;
    const p = new Pt((sa.x + sb.x) / 2, (sa.y + sb.y) / 2);
    access.push({
      kind: 'service',
      at: p,
      normal: norm(new Pt(p.x - centroidOf(ctx.parcel.outer).x, p.y - centroidOf(ctx.parcel.outer).y)),
      role: 'service',
      frontage: 'service',
    });
  } else {
    const p = edgePoint(0.95);
    access.push({ kind: 'service', at: p, normal: outward, role: 'service', frontage: 'primary' });
    notes.push('SHARED_DC_SERVICE_FRONTAGE：没有独立服务临街面，后勤门与员工门共用主街');
  }

  // ---- ⑦ 停车需求（DC 很小）
  const park = ground.find((g) => g.program === 'parking');
  const parkingRequests: ParkingRequest[] = [];
  if (park) {
    parkingRequests.push({
      role: 'employee',
      region: park.surface,
      preferredEntry: edgePoint(0.25),
      targetDensity: 'low',
      notes: ['DC 员工停车：小片区，不给 Solver 大预算'],
    });
  }

  return {
    id: variant.id,
    typology: 'data_center',
    archetype: 'DC_SINGLE_HALL',
    buildings,
    ground,
    access,
    parkingRequests,
    circulation: [],
    notes,
  };
}

// ---------------------------------------------------------------- 工具

function o0(f: Frame): Pt {
  return f.at(0, 0);
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
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
