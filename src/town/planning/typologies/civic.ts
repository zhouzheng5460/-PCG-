// Typology · Civic（公共服务设施用地）
//
// 判断一块公共建筑用地做得好不好，看的不是覆盖率，是**序列**：
//
//   街上 → 广场 → 主入口 → 门厅
//
// 这条序列只要断了一处（广场被停车占了、入口对着后勤道、人行从绿地穿过去），
// 整块地就废了 —— 盖得再满也是"一个堵在路边的盒子"。
//
// 所以诊断的重心：
//   · `pedestrianClarity` —— 主入口有没有一条直接的硬地通到街上；
//   · `spatialCoreQuality` —— 正面那块广场够不够大、够不够完整；
//   · `serviceSeparation` —— 后勤口和公众口有没有分开（公共建筑最忌讳混行）；
//   · `buildingRegularity` —— 主体是不是一个方正的体量（不是被地块挤出来的怪形）。

import type { LayoutDiagnostics, ScoreWeights, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea, pointInRing } from '../core/surface';
import { Pt } from '../../../core/geom';

const U = (m: number) => m / 7;

/** 允许出现的地面程序 */
export const CIVIC_PROGRAMS: GroundProgram[] = [
  'entrance_forecourt',
  'pedestrian',
  'service',
  'service_lane',
  'parking',
  'lawn',
  'planting',
  'amenity',
  'residual',
];

export const CIVIC_TARGETS = {
  /** 建筑基底占可建区 */
  coverage: { min: 0.12, preferredMin: 0.2, preferredMax: 0.42, max: 0.55 },
  /** 主入口广场占可建区 */
  // 前场偏好区间放到 8%~25%：公共建筑前面那一块占场地 1/4 是常态
  //（政务中心、文化馆、卫生中心都是这个量级），原来卡在 15% 会把
  // 「前场做得够气派」当成缺点扣分。
  plaza: { min: 0.05, preferredMin: 0.08, preferredMax: 0.25, max: 0.42 },
  /** 绿地占可建区 */
  green: { min: 0.15, preferredMin: 0.25, preferredMax: 0.55, max: 0.7 },
};

function bandScore(
  v: number,
  b: { preferredMin: number; preferredMax: number; max: number; min?: number }
): number {
  if (v >= b.preferredMin && v <= b.preferredMax) return 1;
  if (v < b.preferredMin) {
    const lo = b.min ?? 0;
    return b.preferredMin - lo <= 1e-9 ? 1 : Math.max(0, (v - lo) / (b.preferredMin - lo));
  }
  const span = Math.max(b.max - b.preferredMax, 1e-6);
  return Math.max(0, 1 - (v - b.preferredMax) / span);
}

export function civicProgramsOf(c: SitePlanCandidate): GroundProgram[] {
  return Array.from(new Set(c.ground.map((g) => g.program)));
}

export function civicProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return civicProgramsOf(c).filter((p) => !CIVIC_PROGRAMS.includes(p));
}

export function civicDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotA = Math.max(1e-9, surfaceArea(ctx.buildableArea));
  const share = (progs: GroundProgram[]) =>
    c.ground.filter((g) => progs.includes(g.program)).reduce((a, g) => a + g.area, 0) / lotA;

  const bldA = c.buildings.reduce((a, b) => a + surfaceArea(b.footprint), 0);
  const coverage = bldA / lotA;
  const plazaShare = share(['entrance_forecourt']);
  const greenShare = share(['lawn', 'planting']);
  const parkShare = share(['parking']);
  const residualShare = share(['residual']);

  // 主入口序列：从公众入口往里 8 m 处，脚下是不是硬地（广场或步行带）
  const ped = c.access.filter((a) => a.kind === 'pedestrian');
  let plazaHit = 0;
  for (const a of ped) {
    const probe = new Pt(a.at.x + a.normal.x * U(8), a.at.y + a.normal.y * U(8));
    const ok = c.ground
      .filter((g) => g.program === 'entrance_forecourt' || g.program === 'pedestrian' || g.program === 'amenity')
      .some((g) => pointInRing(probe, g.surface.outer));
    if (ok) plazaHit++;
  }
  const sequence = ped.length > 0 ? plazaHit / ped.length : 0;

  // 客货分离：服务口不能和公众口落在同一个象限
  const svc = c.access.filter((a) => a.kind === 'service');
  let separation = 1;
  if (svc.length > 0 && ped.length > 0) {
    let minD = Infinity;
    for (const s of svc) for (const p of ped) minD = Math.min(minD, Math.hypot(s.at.x - p.at.x, s.at.y - p.at.y));
    separation = Math.min(1, (minD * 7) / 30); // 30 m 以上算分得开
  }

  // 建筑方正度：footprint 的"面积 / 包围盒面积"
  let regularity = 1;
  if (c.buildings.length > 0) {
    const b = c.buildings[0].footprint.outer;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of b) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const bboxA = (x1 - x0) * (y1 - y0);
    regularity = bboxA > 1e-9 ? Math.min(1, surfaceArea(c.buildings[0].footprint) / bboxA) : 0;
  }

  const d: LayoutDiagnostics = {
    accessClarity: sequence,
    frontageQuality: sequence,
    buildingRegularity: regularity,
    groundUsability: Math.min(1, (coverage + plazaShare + greenShare + parkShare) / 0.95),
    circulationQuality: 0.6 * sequence + 0.4 * separation,
    deadSpacePenalty: Math.min(1, residualShare / 0.06),
    // 与 park 一致：只数 ≥2% 可建区的块。草坪被广场/后勤/停车切出来的
    // 几块边角不是"规划碎片"，是同一个功能区的不同位置。
    fragmentationPenalty: Math.min(
      1,
      Math.max(0, c.ground.filter((g) => g.area / Math.max(lotA, 1e-9) >= 0.02).length - 7) / 8
    ),
    accessConflictPenalty: Math.max(0, 1 - separation) * 0.8,
    spatialCoreQuality: bandScore(plazaShare, CIVIC_TARGETS.plaza),
    pedestrianClarity: sequence,
    openSpaceQuality: bandScore(greenShare, CIVIC_TARGETS.green),
    typologyFit:
      0.35 * bandScore(coverage, CIVIC_TARGETS.coverage) +
      0.3 * bandScore(plazaShare, CIVIC_TARGETS.plaza) +
      0.2 * bandScore(greenShare, CIVIC_TARGETS.green) +
      0.15 * regularity,
    parkingQuality: Math.min(1, parkShare / 0.08),
    serviceSeparation: separation,
    narrowResidualPenalty: 0,
  };
  return d;
}

export function civicWeights(): ScoreWeights {
  return {
    accessClarity: 2.8,
    spatialCoreQuality: 2.6,
    pedestrianClarity: 3.0,
    serviceSeparation: 2.2,
    typologyFit: 2.8,
    circulationQuality: 1.8,
    buildingRegularity: 2.0,
    groundUsability: 1.2,
    parkingQuality: 0.8,
    frontageQuality: 1.6,
    openSpaceQuality: 1.4,
    overlap: 3.0,
    deadSpace: 2.0,
    fragmentation: 1.8,
    narrowResidual: 1.2,
    accessConflict: 2.4,
  };
}
