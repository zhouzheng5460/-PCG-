// Typology · Data Center（PRD §11）
//
// 第五套语法：**设施邻接 + 安防分区 + 后勤可达**。
// 它看起来也像"一个大盒子 + 后场"，但读法完全不同：
//   工业 = 装卸口 + 巨大 truck court（货车在转）
//   数据中心 = 规整 hall + 贴着它的设备场 + 一圈安防缓冲 + 受控的后勤环
//
// 三个内部计算的分数**不新增诊断字段**（Freeze §6），全部折算进已有项：
//   adjacency（设备邻接）   → typologyFit
//   serviceReach（后勤可达）→ circulationQuality
//   securityDepth（安防纵深）→ groundUsability

import type { LayoutDiagnostics, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate, PlannedRegion } from '../core/candidate';
import { surfaceArea, pointInRing, insideSurface } from '../core/surface';
import { Pt } from '../../../core/geom';

/** Phase 2 允许的 DC 地面程序 */
export const DC_GROUND_WHITELIST: GroundProgram[] = [
  'parking',
  'service',
  'landscape',
  'mechanical_yard',
  'electrical_yard',
  'security_buffer',
  'utility_yard',
  'entrance_forecourt',
  'residual',
];

/**
 * 设备场与 hall 的邻接度（0~1）。
 *
 * 做法是纯几何的：取设备场的每条边、hall 的每条边，算"平行且贴近（≤1.2 单位）
 * 的重叠长度"，除以设备场周长。共享边越长，说明设备真的贴着 hall，
 * 而不是隔着一条停车场。
 */
export function adjacencyScore(hall: Pt[] | null, yard: Pt[] | null): number {
  if (!hall || !yard) return 0;
  let shared = 0;
  let perimeter = 0;
  for (let i = 0; i < yard.length; i++) {
    const a = yard[i];
    const b = yard[(i + 1) % yard.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    perimeter += L;
    if (L < 1e-6) continue;
    for (let j = 0; j < hall.length; j++) {
      const c = hall[j];
      const d = hall[(j + 1) % hall.length];
      shared += collinearOverlap(a, b, c, d, 1.2);
    }
  }
  // 分母取周长的一半：设备场通常只有一条边贴 hall（其余三边朝外），
  // 用整周长会让"完全贴合"也只有 0.25 分
  return perimeter > 1e-6 ? clamp01(shared / (perimeter * 0.5)) : 0;
}

/**
 * 后勤可达度：service 区域是否同时贴着 mechanical 与 electrical。
 * 这是"service gate → service lane → 设备场 → hall 后勤面"的第一版近似，
 * 不需要 AccessGraph（Phase 4 再换）。
 */
export function serviceReachScore(c: SitePlanCandidate): number {
  const svc = c.ground.filter((g) => g.program === 'service');
  const mech = c.ground.find((g) => g.program === 'mechanical_yard');
  const elec = c.ground.find((g) => g.program === 'electrical_yard');
  if (svc.length === 0) return 0;
  const near = (yard?: PlannedRegion) => {
    if (!yard) return false;
    return svc.some((s) => adjacencyScore(s.surface.outer, yard.surface.outer) > 0.08);
  };
  const mechNear = near(mech);
  const elecNear = near(elec);
  return (mechNear ? 0.5 : 0) + (elecNear ? 0.5 : 0);
}

/**
 * 安防纵深：data hall 到地块边界之间是否有缓冲。
 *
 * 判法：hall 的所有顶点到 parcel 边界的最小距离，≥ 6 m 记满分；
 * 有 security_buffer 区域再加一点。不追求真实围栏，只要求"hall 不贴红线"。
 */
export function securityDepthScore(ctx: SiteContext, hall: Pt[] | null): number {
  if (!hall) return 0;
  let minD = Infinity;
  for (const p of hall) minD = Math.min(minD, distToRing(p, ctx.parcel.outer));
  const depthM = minD * 7;
  const bySetback = clamp01(depthM / 18); // 18 m 以上算有纵深
  const hasBuffer = c0(ctx, hall) ? 0.15 : 0;
  return clamp01(bySetback + hasBuffer);
}

function c0(ctx: SiteContext, _hall: Pt[]): boolean {
  // 占位：真正的 buffer 判断在 diagnostics 里按 candidate 做（这里保持纯函数签名简单）
  void ctx;
  void _hall;
  return false;
}

export function dcDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotArea = Math.max(1e-6, surfaceArea(ctx.parcel));
  const hall = c.buildings[0];
  const mech = c.ground.find((g) => g.program === 'mechanical_yard');
  const elec = c.ground.find((g) => g.program === 'electrical_yard');
  const buffer = c.ground.find((g) => g.program === 'security_buffer');
  const parking = c.ground.find((g) => g.program === 'parking');
  const service = c.ground.find((g) => g.program === 'service');
  const residual = c.ground.find((g) => g.program === 'residual');

  const staffGate = c.access.find((a) => a.role === 'car');
  const svcGate = c.access.find((a) => a.role === 'service');

  // ① 邻接（折算进 typologyFit）
  const adjM = adjacencyScore(hall?.footprint.outer ?? null, mech?.surface.outer ?? null);
  const adjE = adjacencyScore(hall?.footprint.outer ?? null, elec?.surface.outer ?? null);
  const adjacency = (adjM + adjE) / 2;

  // ② 后勤可达（折算进 circulationQuality）
  const reach = serviceReachScore(c);

  // ③ 安防纵深（折算进 groundUsability）
  let hallMinD = Infinity;
  if (hall) for (const p of hall.footprint.outer) hallMinD = Math.min(hallMinD, distToRing(p, ctx.parcel.outer));
  const securityDepth = clamp01((hallMinD * 7) / 18);

  // ④ 规整度（DC 的高权重项）
  const buildingRegularity = hall ? rectness(hall.footprint.outer) : 0;

  // ⑤ 客货分离（staff gate vs service gate）
  const sharedFrontage = !!staffGate && !!svcGate && staffGate.frontage === svcGate.frontage;
  const gateDist = staffGate && svcGate ? Math.hypot(staffGate.at.x - svcGate.at.x, staffGate.at.y - svcGate.at.y) : 0;
  const serviceSeparation = !svcGate ? 0.4 : sharedFrontage ? (gateDist > 6 ? 0.6 : 0.3) : 1;

  const typologyFit = clamp01(0.5 * adjacency + 0.3 * (mech && elec ? 1 : 0) + 0.2 * securityDepth);
  const circulationQuality = clamp01(0.55 * reach + 0.25 * (service ? 1 : 0) + 0.2 * (c.ground.length > 4 ? 1 : 0));
  const groundUsability = clamp01(
    0.4 * securityDepth + 0.3 * (buffer ? 1 : 0) + 0.3 * ((mech ? 0.5 : 0) + (elec ? 0.5 : 0))
  );

  const has = (p: GroundProgram) => c.ground.some((g) => g.program === p);
  const parkRatio = parking ? parking.area / lotArea : 0;
  // DC 的停车很小：>15% 就开始扣（不该让停车吃设备场）
  const parkingQuality = clamp01(parkRatio < 0.02 ? 0.5 : 1 - Math.max(0, parkRatio - 0.15) / 0.2);
  const frontageQuality = ctx.primaryFrontage ? ctx.primaryFrontage.score : 0.2;
  const openSpaceQuality = clamp01(
    ((buffer?.area ?? 0) + c.ground.filter((g) => g.program === 'landscape').reduce((a, g) => a + g.area, 0)) /
      lotArea /
      0.15
  );

  const deadSpacePenalty = clamp01((residual ? residual.area / lotArea : 0) / 0.18);
  const tiny = c.ground.filter((g) => g.program !== 'residual' && g.area / lotArea < 0.012).length;
  const fragmentationPenalty = clamp01(tiny / 2.5);
  const narrowResidualPenalty = residual ? clamp01((3 - shortestSideM(residual.surface.outer)) / 3) : 0;
  let accessConflictPenalty = 0;
  if (sharedFrontage && gateDist < 6) accessConflictPenalty = 0.75;
  void has;

  return {
    accessClarity: clamp01((staffGate ? 0.5 : 0) + (svcGate ? 0.5 : 0)),
    typologyFit,
    circulationQuality,
    buildingRegularity,
    groundUsability,
    serviceSeparation,
    parkingQuality,
    frontageQuality,
    openSpaceQuality,
    deadSpacePenalty,
    fragmentationPenalty,
    narrowResidualPenalty,
    accessConflictPenalty,
  };
}

export function dcProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return c.ground.map((g) => g.program).filter((p) => !DC_GROUND_WHITELIST.includes(p));
}

/** 设备场是否被停车场 / 景观隔开（D01~D08 的共同断言用） */
export function yardSeparatedFromHall(c: SitePlanCandidate): string[] {
  const hall = c.buildings[0];
  if (!hall) return ['没有 data hall'];
  const out: string[] = [];
  for (const program of ['mechanical_yard', 'electrical_yard'] as const) {
    const yard = c.ground.find((g) => g.program === program);
    if (!yard) {
      out.push(`缺少 ${program}`);
      continue;
    }
    if (adjacencyScore(hall.footprint.outer, yard.surface.outer) < 0.05) out.push(`${program} 没有贴着 hall`);
  }
  return out;
}

// ---------------------------------------------------------------- 几何工具

type Pt2 = { x: number; y: number };

/** 两条线段共线且贴近时，返回重叠长度 */
function collinearOverlap(a: Pt2, b: Pt2, c: Pt2, d: Pt2, tol: number): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abl = Math.hypot(abx, aby);
  if (abl < 1e-9) return 0;
  const ux = abx / abl;
  const uy = aby / abl;
  const offC = Math.abs((c.x - a.x) * uy - (c.y - a.y) * ux);
  const offD = Math.abs((d.x - a.x) * uy - (d.y - a.y) * ux);
  if (offC > tol || offD > tol) return 0;
  const tc = (c.x - a.x) * ux + (c.y - a.y) * uy;
  const td = (d.x - a.x) * ux + (d.y - a.y) * uy;
  const lo = Math.max(0, Math.min(tc, td));
  const hi = Math.min(abl, Math.max(tc, td));
  return Math.max(0, hi - lo);
}

function distToRing(p: Pt2, ring: Pt2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

function bbox(ring: Pt2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function rectness(ring: Pt2[]): number {
  const b = bbox(ring);
  const box = (b.maxX - b.minX) * (b.maxY - b.minY);
  if (box < 1e-9) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }
  return clamp01(Math.abs(s / 2) / box);
}

function shortestSideM(ring: Pt2[]): number {
  const b = bbox(ring);
  return Math.min(b.maxX - b.minX, b.maxY - b.minY) * 7;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export const DC_UNUSED = { pointInRing, insideSurface, Pt };
