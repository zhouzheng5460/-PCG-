// Typology · Green（城市绿地）
//
// 这一层只做三件事：地面程序白名单、权重、把 Candidate 读成诊断分。
//
// ## 绿的"好"和建筑的"好"不是一回事
//
// 建筑用地看覆盖率、看规整、看临街面；绿地看的是**连续**和**可进入**：
// 一片 8000 m² 的绿地被切成 40 块 200 m² 的小草坪，覆盖率一分不差，
// 但从街上走过去是一片"补丁"，不是一块绿地。所以这里：
//   · `openSpaceQuality` 用"最大一片绿 / 全部绿"衡量连续性 —— 越整越高；
//   · `fragmentationPenalty` 直接数绿的块数，超过 3 块就开始扣；
//   · 建筑相关的项（规整度、停车、客货分离）**权重归零**，
//     否则它们恒为 0 却仍占归一化分母，把分数压到 4 分出头（和独栋当年一样）。

import type { LayoutDiagnostics, ScoreWeights, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea } from '../core/surface';

/** 允许出现的地面程序。出现白名单外的程序就算 bug（自检用） */
export const GREEN_PROGRAMS: GroundProgram[] = ['lawn', 'planting', 'pedestrian', 'residual'];

/** 绿地强度目标：这里不是覆盖率，是"可进入的草坪占比" */
export const GREEN_TARGETS = {
  /** 草坪（可进入）占绿地的比例 */
  // 上限就是 1：一片全是草坪的绿地（社区小游园）没有任何问题。
  // 给它扣分等于逼着生成「必须有点树丛」，那是为了指标而设计。
  lawnShare: { min: 0.25, preferredMin: 0.45, preferredMax: 1, max: 1 },
  /** 绿地的最大片数（超过就说明被切碎了） */
  maxPieces: 4,
};

export function greenProgramsOf(c: SitePlanCandidate): GroundProgram[] {
  return Array.from(new Set(c.ground.map((g) => g.program)));
}

/** 白名单校验：返回越界的程序名 */
export function greenProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return greenProgramsOf(c).filter((p) => !GREEN_PROGRAMS.includes(p));
}

export function greenDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotA = Math.max(1e-9, surfaceArea(ctx.buildableArea));

  const greenPieces = c.ground.filter((g) => g.program === 'lawn' || g.program === 'planting');
  const greenA = greenPieces.reduce((a, g) => a + g.area, 0);
  const lawnA = c.ground.filter((g) => g.program === 'lawn').reduce((a, g) => a + g.area, 0);
  const biggest = greenPieces.reduce((a, g) => Math.max(a, g.area), 0);
  const residualA = c.ground.filter((g) => g.program === 'residual').reduce((a, g) => a + g.area, 0);
  const pathA = c.ground.filter((g) => g.program === 'pedestrian').reduce((a, g) => a + g.area, 0);

  // 连续度：**只看草坪**。
  //
  // 原来的口径是"最大一片绿 / 全部绿"，于是沿街加一条 5 m 种植带就把
  // "连续性"从 1.0 打到 0.88 —— 可种植带本来就不该算"被切碎的草坪"：
  // 用户要的是"保留大块完整绿地"，说的是可进入的那块。
  const lawnBiggest = c.ground.filter((g) => g.program === 'lawn').reduce((a, g) => Math.max(a, g.area), 0);
  const continuity = lawnA > 1e-9 ? lawnBiggest / lawnA : greenA > 1e-9 ? biggest / greenA : 0;
  // 可进入度：草坪占绿地的比例，落在 GREEN_TARGETS.lawnShare 的偏好区间内给满分
  const lawnShare = greenA > 1e-9 ? lawnA / greenA : 0;
  const band = GREEN_TARGETS.lawnShare;
  const lawnScore =
    lawnShare < band.preferredMin
      ? 0.6 + 0.4 * (lawnShare / Math.max(band.preferredMin, 1e-6))
      : lawnShare > band.preferredMax
        ? Math.max(0.5, 1 - 0.5 * ((lawnShare - band.preferredMax) / Math.max(1 - band.preferredMax, 1e-6)))
        : 1;

  // 可进入性：有临街面时必须有接入口；没有临街面的保留地本来就不进人
  const hasFrontage = !!ctx.primaryFrontage;
  const hasEntry = c.access.some((a) => a.kind === 'pedestrian');
  const reach = hasFrontage ? (hasEntry ? 1 : 0.25) : 1;

  // 步行序列：接入口那一段够不够长（≥ 一条 4.4×10 m 的入口带就算到位）
  const entryRefA = (4.4 * 10) / 49;
  const pathReach = Math.min(1, pathA / entryRefA);

  // 临街观感：临街那一侧看到的是不是绿。
  // 用一个诚实的**代理指标**：草坪占绿地的比例 —— 种植带贴街时草坪占比低，
  // 街上看过去就是一道绿篱而不是一块绿地；草坪占主导时视线是通透的。
  // （真正的"沿街 10 m 内绿的占比"要逐段求交，代价不该由诊断付。）
  const frontGreen = lawnScore;

  const pieces = greenPieces.length;
  const fragPenalty = pieces <= 3 ? 0 : Math.min(1, (pieces - 3) / 8);
  const deadPenalty = Math.min(1, residualA / lotA / 0.08);

  const d: LayoutDiagnostics = {
    accessClarity: reach,
    frontageQuality: frontGreen,
    buildingRegularity: 0,
    groundUsability: Math.min(1, greenA / lotA / 0.9),
    circulationQuality: pathReach,
    deadSpacePenalty: deadPenalty,
    fragmentationPenalty: fragPenalty,
    accessConflictPenalty: 0,
    spatialCoreQuality: continuity,
    pedestrianClarity: reach,
    openSpaceQuality: 0.5 * continuity + 0.5 * lawnScore,
    typologyFit: 0.5 * continuity + 0.3 * lawnScore + 0.2 * reach,
    parkingQuality: 0,
    serviceSeparation: 0,
    narrowResidualPenalty: 0,
  };
  return d;
}

export function greenWeights(): ScoreWeights {
  return {
    accessClarity: 1.6,
    spatialCoreQuality: 1.2,
    pedestrianClarity: 1.6,
    serviceSeparation: 0,
    typologyFit: 3.0,
    circulationQuality: 1.2,
    buildingRegularity: 0,
    groundUsability: 1.4,
    parkingQuality: 0,
    frontageQuality: 1.8,
    openSpaceQuality: 3.0,
    overlap: 3.0,
    deadSpace: 2.0,
    fragmentation: 3.2,
    narrowResidual: 1.0,
    accessConflict: 0,
  };
}
