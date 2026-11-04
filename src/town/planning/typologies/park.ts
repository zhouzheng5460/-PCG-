// Typology · Park（城市公园）
//
// 公园的"好"由三件事决定，缺一个就从公园退化成绿地：
//
//   ① **入口**：临街面上有真正的入口，人能进去；
//   ② **骨架**：主步道把人从入口带到中心，次步道展开到活动节点 ——
//      这是"游览路径"和"随机撒几条路"的分水岭；
//   ③ **层次**：草坪（可进入）和种植区（不可进入）在面积和位置上分得开。
//
// 所以诊断里 `circulationQuality` 的权重比 Green 高得多，
// 而 `openSpaceQuality` 仍然保留（公园不能变成一片铺装）。

import type { LayoutDiagnostics, ScoreWeights, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea, pointInRing } from '../core/surface';
import { Pt } from '../../../core/geom';

/** 允许出现的地面程序 */
export const PARK_PROGRAMS: GroundProgram[] = [
  'lawn',
  'planting',
  'pedestrian',
  'park_path',
  'amenity',
  'entrance_forecourt',
  'residual',
];

const U = (m: number) => m / 7;

export const PARK_TARGETS = {
  /** 步道占可建区的比例（主 + 次），公园大致 8~18% */
  pathShare: { min: 0.03, preferredMin: 0.08, preferredMax: 0.2, max: 0.34 },
  /** 硬质节点（广场 + 活动场地）占可建区 */
  plazaShare: { min: 0.01, preferredMin: 0.03, preferredMax: 0.15, max: 0.3 },
  /** 绿地占可建区：公园怎么也得一半以上 */
  // 上限放到 0.9：一个 90% 是绿地的公园很正常（城市公园的铺装就是 10~20%），
  // 原来卡在 0.85 会把「绿得多」当缺点扣分，方向反了。
  greenShare: { min: 0.4, preferredMin: 0.55, preferredMax: 0.9, max: 1 },
  /** 主步道最窄宽度（m） */
  minMainPathM: 3,
};

export function parkProgramsOf(c: SitePlanCandidate): GroundProgram[] {
  return Array.from(new Set(c.ground.map((g) => g.program)));
}

export function parkProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return parkProgramsOf(c).filter((p) => !PARK_PROGRAMS.includes(p));
}

/** 区间打分：落在 [preferredMin, preferredMax] 给 1，越界线性衰减到 0 */
function bandScore(v: number, b: { preferredMin: number; preferredMax: number; max: number }): number {
  if (v >= b.preferredMin && v <= b.preferredMax) return 1;
  if (v < b.preferredMin) return b.preferredMin <= 1e-9 ? 1 : Math.max(0, v / b.preferredMin);
  const span = Math.max(b.max - b.preferredMax, 1e-6);
  return Math.max(0, 1 - (v - b.preferredMax) / span);
}

export function parkDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotA = Math.max(1e-9, surfaceArea(ctx.buildableArea));

  const share = (progs: GroundProgram[]) =>
    c.ground.filter((g) => progs.includes(g.program)).reduce((a, g) => a + g.area, 0) / lotA;

  const pathShare = share(['pedestrian', 'park_path']);
  const plazaShare = share(['amenity', 'entrance_forecourt']);
  const greenShare = share(['lawn', 'planting']);
  const residualShare = share(['residual']);

  // 骨架：主步道有没有把人从临街面带到中心
  const mainA = c.ground.filter((g) => g.program === 'pedestrian').reduce((a, g) => a + g.area, 0);
  const subA = c.ground.filter((g) => g.program === 'park_path').reduce((a, g) => a + g.area, 0);
  const hasEntry = c.access.some((a) => a.kind === 'pedestrian');
  const needEntry = !!ctx.primaryFrontage;
  const entryScore = needEntry ? (hasEntry ? 1 : 0.15) : 1;

  // 层级：有次步道才谈得上"主次"
  const hierarchy = mainA > 1e-6 ? Math.min(1, subA / (mainA * 0.6)) : 0;
  // 节点：有没有一块像样的活动场地
  const nodeA = c.ground.filter((g) => g.program === 'amenity').reduce((a, g) => a + g.area, 0);
  // 一块 12x12 m 的场地 = 2.94 世界单位^2，到这一档就算有活动节点
  const NODE_REF = (12 * 12) / 49;
  const nodeScore = Math.min(1, nodeA / NODE_REF);

  // 层次绿：草坪和种植都要有，且草坪占多数
  const lawnA = c.ground.filter((g) => g.program === 'lawn').reduce((a, g) => a + g.area, 0);
  const plantA = c.ground.filter((g) => g.program === 'planting').reduce((a, g) => a + g.area, 0);
  const bothGreens = lawnA > 1e-6 && plantA > 1e-6 ? 1 : 0.55;

  // 入口是否真的连着步道（在入口点 8 m 内能不能找到步道面）
  let connected = 0;
  let checked = 0;
  for (const a of c.access) {
    if (a.kind !== 'pedestrian') continue;
    checked++;
    const probe = new Pt(a.at.x + a.normal.x * U(6), a.at.y + a.normal.y * U(6));
    const onPath = c.ground
      .filter((g) => g.program === 'pedestrian' || g.program === 'park_path' || g.program === 'entrance_forecourt')
      .some((g) => pointInRing(probe, g.surface.outer));
    if (onPath) connected++;
  }
  const connectivity = checked > 0 ? connected / checked : needEntry ? 0.3 : 1;

  const d: LayoutDiagnostics = {
    accessClarity: 0.5 * entryScore + 0.5 * connectivity,
    frontageQuality: entryScore,
    buildingRegularity: 0,
    groundUsability: Math.min(1, (pathShare + plazaShare + greenShare) / 0.95),
    circulationQuality: 0.45 * bandScore(pathShare, PARK_TARGETS.pathShare) + 0.3 * hierarchy + 0.25 * connectivity,
    deadSpacePenalty: Math.min(1, residualShare / 0.06),
    // 碎片惩罚按**有功能意义的块**算：小于可建区 2% 的块不算独立功能区
    //（布尔裁剪会把一条环路切成几段，那些 5 m² 的碎角不是"规划碎片"）。
    fragmentationPenalty: Math.min(
      1,
      // 阈值放到 10：一个环路 + 3 个节点 + 中心 + 2 条入口 + 草坪/种植，
      // 本来就接近十块；再往上才叫"撒一地"。
      Math.max(0, c.ground.filter((g) => g.area / Math.max(lotA, 1e-9) >= 0.02).length - 10) / 8
    ),
    accessConflictPenalty: 0,
    spatialCoreQuality: nodeScore,
    pedestrianClarity: connectivity,
    openSpaceQuality: 0.6 * bandScore(greenShare, PARK_TARGETS.greenShare) + 0.4 * bothGreens,
    typologyFit:
      0.35 * bandScore(greenShare, PARK_TARGETS.greenShare) +
      0.25 * bandScore(pathShare, PARK_TARGETS.pathShare) +
      0.2 * bandScore(plazaShare, PARK_TARGETS.plazaShare) +
      0.2 * hierarchy,
    parkingQuality: 0,
    serviceSeparation: 0,
    narrowResidualPenalty: 0,
  };
  return d;
}

export function parkWeights(): ScoreWeights {
  return {
    accessClarity: 2.2,
    spatialCoreQuality: 1.6,
    pedestrianClarity: 2.4,
    serviceSeparation: 0,
    typologyFit: 3.0,
    circulationQuality: 2.8,
    buildingRegularity: 0,
    groundUsability: 1.4,
    parkingQuality: 0,
    frontageQuality: 1.4,
    openSpaceQuality: 2.6,
    overlap: 3.0,
    deadSpace: 1.8,
    fragmentation: 1.6,
    narrowResidual: 1.0,
    accessConflict: 0,
  };
}
