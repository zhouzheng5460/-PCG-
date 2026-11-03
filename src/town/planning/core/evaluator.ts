// Site Planning Core · LayoutEvaluator（PRD §15 / 用户 P1.6）
//
// Phase 1 还没有真正的 Candidate，所以这里只做**评分契约**：
// 定好诊断项、权重、typology 覆盖，Phase 2 的每个方案只要填 `LayoutDiagnostics`
// 就能被打分和比较。
//
// 顺序上它被放在 ArchetypeSelector **之前**（用户的调整）：Selector 不应该
// `if (area > x) return 'courtyard'` 地拍板，而应该是"筛出够格的 → 生成候选 →
// 用同一把尺子量 → 取最好"。所以尺子必须先存在。

import type { LayoutDiagnostics, LayoutEvaluation, ScoreWeights, SiteTypology } from './types';

/** 默认权重（PRD §15 原始数值） */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  accessClarity: 2.5,
  spatialCoreQuality: 1.6,
  pedestrianClarity: 1.5,
  serviceSeparation: 1.4,
  typologyFit: 2.0,
  circulationQuality: 1.8,
  buildingRegularity: 1.6,
  groundUsability: 1.5,
  parkingQuality: 1.4,
  frontageQuality: 1.2,
  openSpaceQuality: 1.0,
  overlap: 3.0,
  deadSpace: 2.5,
  fragmentation: 2.2,
  narrowResidual: 2.0,
  accessConflict: 2.0,
};

/**
 * typology 覆盖（PRD §15 的后半段）。
 *
 * 语义就是"这行生意最怕什么"：
 *   · 工业怕物流不通（circulation ↑↑、access ↑↑），不在乎沿街形象（frontage ↓）；
 *   · 住宅怕没有庭院和步行（openSpace ↑、frontage ↑）；
 *   · 商业怕停车和可达（parking ↑↑、access ↑↑）；
 *   · 酒店怕到达感（access ↑↑、typologyFit ↑）；
 *   · 数据中心怕服务和扩容（circulation ↑↑、deadSpace ↑）。
 */
export function weightsFor(typology: SiteTypology): ScoreWeights {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS };
  switch (typology) {
    case 'industrial':
      // 工业最怕"人和货车走一个口"
      w.serviceSeparation = 2.8;
      w.circulationQuality = 2.8;
      w.accessClarity = 2.6;
      w.frontageQuality = 0.5;
      w.openSpaceQuality = 0.4;
      w.deadSpace = 3.0;
      break;
    case 'multi_family': {
      // 住宅的命门是"围合 + 人行序列"，不是客货分离
      w.typologyFit = 2.5;
      w.spatialCoreQuality = 2.5;
      w.pedestrianClarity = 2.3;
      w.frontageQuality = 2.0;
      w.buildingRegularity = 1.8;
      w.groundUsability = 1.6;
      w.parkingQuality = 0.9;
      w.serviceSeparation = 0.5;
      w.accessClarity = 2.0;
      w.circulationQuality = 1.2;
      w.openSpaceQuality = 1.8;
      w.deadSpace = 2.2;
      w.fragmentation = 2.3;
      w.narrowResidual = 2.5;
      w.accessConflict = 2.5;
      break;
    }
    case 'single_family': {
      // 独栋不看庭院围合、不看客货分离、不看停车质量（每户自带车库/车道）
      // —— 这三项权重归零，否则它们恒为 0 却仍占归一化分母，把分数压到 4 分出头
      w.spatialCoreQuality = 0;
      w.serviceSeparation = 0;
      w.parkingQuality = 0;
      w.frontageQuality = 2.7;
      w.buildingRegularity = 2.4;
      w.circulationQuality = 2.3;
      w.groundUsability = 2.0;
      w.accessClarity = 1.8;
      w.openSpaceQuality = 1.2;
      w.fragmentation = 3.0;
      w.narrowResidual = 2.8;
      w.accessConflict = 2.5;
      w.deadSpace = 2.0;
      break;
    }
    case 'retail':
      // 零售的身份就是"临街界面 + 停车 + 顾客动线 + 强度"这四条，
      // 它们现在都折在 typologyFit 里（R7.7），所以这一项要压得住其它项，
      // 否则 15% 覆盖和 37% 覆盖总分只差 0.03，候选等于白给（margin 全进 LOW）
      w.typologyFit = 2.8;
      w.serviceSeparation = 1.8;
      w.parkingQuality = 2.6;
      w.accessClarity = 2.8;
      w.frontageQuality = 1.6;
      w.openSpaceQuality = 0.3;
      break;
    case 'hotel':
      // 落客与后勤必须分开（行李车 / 垃圾车 / 员工）
      w.serviceSeparation = 2.6;
      w.accessClarity = 3.0;
      w.typologyFit = 2.6;
      w.frontageQuality = 1.4;
      break;
    case 'data_center':
      w.circulationQuality = 2.4;
      w.typologyFit = 2.4;
      w.deadSpace = 2.8;
      w.frontageQuality = 0.4;
      break;
    default:
      break;
  }
  return w;
}

/**
 * 打分。
 *
 * 正分项按权重加权求和后**归一化到 0~10**，惩罚项按权重直接扣。
 * 之所以不直接照 PRD 原式相加：正分项有 8 个、每个都是 0~1，总和会到 16+，
 * 惩罚项却只有 0~3 的量纲 —— 不归一化的话"扣分"永远赢不了，"差方案"看起来
 * 也像好方案。归一化后 0~10 的分布才和"这个方案能不能用"对得上。
 */
export function evaluateLayout(
  diag: LayoutDiagnostics,
  opts: { typology?: SiteTypology; weights?: ScoreWeights } = {}
): LayoutEvaluation {
  const w = opts.weights ?? (opts.typology ? weightsFor(opts.typology) : DEFAULT_WEIGHTS);
  const reasons: string[] = [];

  const c = (v: number | undefined) => clamp01(v ?? 0);

  const positiveWeights =
    w.accessClarity + w.typologyFit + w.circulationQuality + w.buildingRegularity +
    w.groundUsability + w.parkingQuality + w.frontageQuality + w.openSpaceQuality +
    w.serviceSeparation + w.spatialCoreQuality + w.pedestrianClarity;

  const positive =
    w.accessClarity * c(diag.accessClarity) +
    w.serviceSeparation * c(diag.serviceSeparation) +
    w.spatialCoreQuality * c(diag.spatialCoreQuality) +
    w.pedestrianClarity * c(diag.pedestrianClarity) +
    w.typologyFit * c(diag.typologyFit) +
    w.circulationQuality * c(diag.circulationQuality) +
    w.buildingRegularity * c(diag.buildingRegularity) +
    w.groundUsability * c(diag.groundUsability) +
    w.parkingQuality * c(diag.parkingQuality) +
    w.frontageQuality * c(diag.frontageQuality) +
    w.openSpaceQuality * c(diag.openSpaceQuality);

  const base = positiveWeights > 0 ? (positive / positiveWeights) * 10 : 0;

  const penalty =
    w.narrowResidual * c(diag.narrowResidualPenalty) +
    w.deadSpace * c(diag.deadSpacePenalty) +
    w.fragmentation * c(diag.fragmentationPenalty) +
    w.accessConflict * c(diag.accessConflictPenalty);

  if (c(diag.deadSpacePenalty) > 0.3) reasons.push(`死空间偏多（-${(c(diag.deadSpacePenalty) * w.deadSpace).toFixed(2)}）`);
  if (c(diag.fragmentationPenalty) > 0.3) reasons.push(`地块被切碎（-${(c(diag.fragmentationPenalty) * w.fragmentation).toFixed(2)}）`);
  if (c(diag.accessConflictPenalty) > 0.3) reasons.push(`出入口与主街冲突（-${(c(diag.accessConflictPenalty) * w.accessConflict).toFixed(2)}）`);
  if (c(diag.serviceSeparation) < 0.4) reasons.push('客货流线未分离');
  if (c(diag.narrowResidualPenalty) > 0.3) reasons.push(`残地过窄（-${(c(diag.narrowResidualPenalty) * w.narrowResidual).toFixed(2)}）`);
  if (c(diag.pedestrianClarity) < 0.4) reasons.push('人行入口与核心空间不连贯');

  return { score: Math.max(0, base - penalty), diagnostics: diag, reasons };
}

/** 空诊断（Phase 2 的 Candidate 只填自己算得出的那几项） */
export function emptyDiagnostics(): LayoutDiagnostics {
  return {
    accessClarity: 0,
    spatialCoreQuality: 0,
    pedestrianClarity: 0,
    enclosureRatio: 0,
    narrowResidualPenalty: 0,
    serviceSeparation: 0,
    frontageQuality: 0,
    buildingRegularity: 0,
    groundUsability: 0,
    circulationQuality: 0,
    deadSpacePenalty: 0,
    fragmentationPenalty: 0,
    accessConflictPenalty: 0,
    typologyFit: 0,
    parkingQuality: 0,
    openSpaceQuality: 0,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
