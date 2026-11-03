// Typology · Single-Family（PRD §8 / 用户 §13~§15）
//
// 权重和诊断都**复用现有字段**（Freeze §6）：
//   lotRegularity 折进 groundUsability + buildingRegularity；
//   meanLotQuality 折进 typologyFit；
//   不新开任何 Diagnostic。

import type { LayoutDiagnostics, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea } from '../core/surface';
import { Pt } from '../../../core/geom';

/** 独栋细分的目标尺寸（米） */
export const SF_TARGETS = {
  targetLotWidthM: 18,
  minLotWidthM: 12,
  maxLotCount: 30,
  targetLotDepthM: 32,
};

export const SF_GROUND_WHITELIST: GroundProgram[] = [
  'front_yard',
  'rear_yard',
  'driveway',
  'community_green',
  'residual',
];

/**
 * 独栋诊断。
 *
 * 注意评价口径：**不比谁房子多**（用户明确要求）。
 * 高分来自"每块宅地都规整、都有临街、都有车道"，而不是 lot 数。
 */
export function sfDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotArea = Math.max(1e-6, surfaceArea(ctx.parcel));
  const houses = c.buildings.filter((b) => b.role === 'house');
  const frontYards = c.ground.filter((g) => g.program === 'front_yard');
  const rearYards = c.ground.filter((g) => g.program === 'rear_yard');
  const driveways = c.ground.filter((g) => g.program === 'driveway');
  const green = c.ground.filter((g) => g.program === 'community_green');
  const residual = c.ground.find((g) => g.program === 'residual');

  // 内部路（走 circulation，不是 Ground）
  const roads = c.circulation.filter((p) => p.role === 'vehicle');

  // ① 宅地规整度：每栋房的矩形度（房子是矩形的，宅地才是关键，用房近似）
  const regs = houses.map((h) => rectness(h.footprint.outer));
  const buildingRegularity = regs.length === 0 ? 0 : regs.reduce((a, b) => a + b, 0) / regs.length;

  // ② 地面可用性 = 宅地配套齐全度（前院 / 后院 / 车道各覆盖多少栋房）
  const cover = (n: number) => (houses.length === 0 ? 0 : Math.min(1, n / houses.length));
  const groundUsability = clamp01(0.4 * cover(frontYards.length) + 0.3 * cover(rearYards.length) + 0.3 * cover(driveways.length));

  // ③ 循环：内部路存在 + 车道覆盖
  const circulationQuality = clamp01((roads.length > 0 ? 0.6 : 0) + 0.4 * cover(driveways.length));

  // ④ typologyFit：宅地均好度（房密度合理 + 每户有车道 + 有路）
  const houseDensity = houses.length / Math.max(1, lotArea * 49); // 户/m²
  const densityScore = clamp01(houseDensity / (1 / 900)); // 约 900 m²/户 打满分
  const typologyFit = clamp01(0.45 * densityScore + 0.35 * cover(driveways.length) + 0.2 * (roads.length > 0 ? 1 : 0));

  const frontageQuality = ctx.primaryFrontage ? ctx.primaryFrontage.score : 0.2;
  const openSpaceQuality = clamp01(green.reduce((a, g) => a + g.area, 0) / lotArea / 0.15);
  const pedestrianClarity = clamp01(0.5 + 0.5 * cover(frontYards.length));

  const deadSpacePenalty = clamp01((residual ? residual.area / lotArea : 0) / 0.2);
  // SF 的"碎片"是**残地**，不是前院/后院/车道 —— 一个 60 m² 的前院按地块面积比算
  // 永远是"tiny"，那样每户都会被罚，分数直接失真（第一版就是这个坑）
  const narrowFragments = c.ground.filter(
    (g) => g.program === 'residual' && shortestSideM(g.surface.outer) < 8
  ).length;
  const fragmentationPenalty = clamp01(narrowFragments / 2);
  const narrowResidualPenalty = residual ? clamp01((3 - shortestSideM(residual.surface.outer)) / 3) : 0;
  // SF 只有一个主街开口，客货不分是常态，不给冲突惩罚
  const accessConflictPenalty = 0;

  return {
    accessClarity: clamp01(roads.length > 0 ? 0.9 : 0.4),
    typologyFit,
    circulationQuality,
    buildingRegularity,
    groundUsability,
    frontageQuality,
    openSpaceQuality,
    pedestrianClarity,
    deadSpacePenalty,
    fragmentationPenalty,
    narrowResidualPenalty,
    accessConflictPenalty,
  };
}

export function sfProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return c.ground.map((g) => g.program).filter((p) => !SF_GROUND_WHITELIST.includes(p));
}

/** 每栋房是否有车道（S08 的断言用） */
export function housesWithDriveway(c: SitePlanCandidate): number {
  const houses = c.buildings.filter((b) => b.role === 'house');
  const dw = c.ground.filter((g) => g.program === 'driveway');
  return Math.min(houses.length, dw.length);
}

// ---------------------------------------------------------------- 工具

function bboxOf(ring: Pt[]) {
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

function rectness(ring: Pt[]): number {
  const b = bboxOf(ring);
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

function shortestSideM(ring: Pt[]): number {
  const b = bboxOf(ring);
  return Math.min(b.maxX - b.minX, b.maxY - b.minY) * 7;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
