// Shadow · 绝对强度带（R7.8）
//
// ## 为什么要有这个文件
//
// R7 的强度闸门是**相对**的：`intensityRatio = planner覆盖 / legacy覆盖`。
// 跑完 R7.6（工业）和 R7.7（零售）之后，这个口径暴露出一个结构性问题：
// **三类 typology 全部被判 PLANNER_OVERBUILT**（工业 1.55×、零售 1.69×、住宅 2.68×）。
//
// 逐类查完带内占比后，结论是反的：
//
//   | typology      | legacy 覆盖 | planner 覆盖 | legacy 在带内 | planner 在带内 |
//   |---------------|-------------|--------------|---------------|----------------|
//   | industrial    | 17%         | 20%          | 4/6           | 5/6            |
//   | retail        | 13%         | 21%          | 19/27         | 27/27          |
//   | multi_family  | 13%         | 30%          | —             | —（本轮补上）  |
//
// 也就是说 **Legacy 才是偏离的一方**：它是郊区化的低密度产物，而 Planner 按
// "近郊 strip / 多层围合住宅" 的常规容积率在盖。把 Legacy 当基准，等于用
// "更稀" 当标准。
//
// ## 本文件的职责
//
// 只做一件事：**为每个 typology 声明一条"绝对强度目标带"**，并把覆盖率换算到
// 各自可比的口径上。带子来自规划实务里的常态区间（容积率 / 覆盖率），
// 不是从数据里反推的 —— 否则就变成"用结果证明结果"。
//
// 换算口径：
//   · `coverage` —— 单层类型（工业、零售）：覆盖率就是强度；
//   · `stories`  —— 多层类型（住宅、酒店）：强度 = 覆盖率 × 层数 ≈ 容积率。
//
// 没声明 typology（酒店 / 数据中心 / 独栋目前没有 Shadow 样本）继续走旧的相对比，
// 不假装它们已经校准过。

import type { SiteTypology } from '../planning/core/types';
import { INDUSTRIAL_INTENSITY } from '../planning/typologies/industrial';
import { RETAIL_INTENSITY } from '../planning/typologies/retail';

export type IntensityMeasure = 'coverage' | 'stories';

export interface IntensityTarget {
  typology: SiteTypology;
  /** 强度口径 */
  measure: IntensityMeasure;
  /** measure = 'stories' 时的标准层数（该 typology 的常规层数） */
  stories: number;
  /** 硬下界：低于此值 = 明显偏稀 */
  min: number;
  /** 偏好下界 */
  preferredMin: number;
  /** 偏好上界 */
  preferredMax: number;
  /** 硬上界：高于此值 = 明显偏密 */
  max: number;
  /** 带子从哪来（一句话，必须能对外解释） */
  rationale: string;
}

/** 多层住宅：Planner 的围合 bar 是 6 层（18 m），所以强度口径按容积率算 */
export const MF_STORIES = 6;

export const INTENSITY_TARGETS: Partial<Record<SiteTypology, IntensityTarget>> = {
  industrial: {
    typology: 'industrial',
    measure: 'coverage',
    stories: 1,
    min: INDUSTRIAL_INTENSITY.min,
    preferredMin: INDUSTRIAL_INTENSITY.preferredMin,
    preferredMax: INDUSTRIAL_INTENSITY.preferredMax,
    max: INDUSTRIAL_INTENSITY.max,
    rationale:
      '单层高标库：容积率 0.16~0.28 是"仓库 + 货场 + 员工停车"的常见区间，低于 0.16 说明货场撑不起来，高于 0.28 说明它其实该做成双层。',
  },
  retail: {
    typology: 'retail',
    measure: 'coverage',
    stories: 1,
    preferredMin: RETAIL_INTENSITY.preferredMin,
    preferredMax: RETAIL_INTENSITY.preferredMax,
    min: RETAIL_INTENSITY.min,
    max: RETAIL_INTENSITY.max,
    rationale:
      '单层大盒商业：单层 strip 的容积率常态就是 0.16~0.26，低于 0.12 是"停车场配一间店"，高于 0.34 的 strip 通常要上楼或做停车楼（那是 PAD / 城市商业）。',
  },
  multi_family: {
    typology: 'multi_family',
    measure: 'stories',
    stories: MF_STORIES,
    min: 1.2,
    preferredMin: 1.4,
    preferredMax: 2.2,
    max: 2.6,
    rationale:
      '6 层围合式多层住宅（18 m）：容积率 1.4~2.2 是多层住宅的常规区间；低于 1.2 其实是洋房/低密，高于 2.6 就不该再做多层。',
  },
};

/** 强度落在带里的哪一段 */
export type BandState = 'below' | 'in_hard' | 'in_preferred' | 'above';

/** 把覆盖率换算到该 typology 的强度口径 */
export function intensityValue(coverage: number, t: IntensityTarget): number {
  return t.measure === 'coverage' ? coverage : coverage * t.stories;
}

/** 带内分段判定 */
export function bandState(v: number, t: IntensityTarget): BandState {
  if (!Number.isFinite(v)) return 'below';
  if (v < t.min) return 'below';
  if (v < t.preferredMin) return 'in_hard';
  if (v <= t.preferredMax) return 'in_preferred';
  if (v <= t.max) return 'in_hard';
  return 'above';
}

/** 是否算"在带内"（硬界内就算，不要求落在偏好段） */
export function inBand(state: BandState): boolean {
  return state === 'in_hard' || state === 'in_preferred';
}

/** 两侧的合规性对照 */
export type IntensityCompliance =
  | 'both_in_band'
  | 'planner_in_band_only'
  | 'legacy_in_band_only'
  | 'neither_in_band'
  | 'not_declared';

export function complianceOf(
  pState: BandState | null,
  lState: BandState | null
): IntensityCompliance {
  if (!pState || !lState) return 'not_declared';
  const p = inBand(pState);
  const l = inBand(lState);
  if (p && l) return 'both_in_band';
  if (p) return 'planner_in_band_only';
  if (l) return 'legacy_in_band_only';
  return 'neither_in_band';
}
