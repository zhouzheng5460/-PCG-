// Scene · Planner 前端接入（R8 Frontend Product Integration）
//
// ## 这一层是干什么的
//
// 把 Planner 的完整链路接进**真实的前端渲染**：
//
//   Parcel
//   → siteContextFromModel()
//   → generateCandidates()          （按 typology 路由）
//   → selectBestCandidate()         （显式选优 + margin）
//   → realizeSitePlan()             （忠实落地，不再做规划决策）
//   → Scene 特征
//   → 现有 2D / 3D Renderer
//
// ## 红线
//
// `realizeSitePlan()` 产出的特征**直接进 Scene**，不再经过 legacy 的地块规划逻辑
// （`ModernWard.lot` 那条链）。也就是说：被 Planner 接管的地块，
// 它的建筑、地面、开口、车位**全部**来自 Planner，legacy 一个字节都不进来。
// 只有"Planner 接不了的地块"才回落到 legacy —— 并且在报告里写明为什么。
//
// ## 三种模式
//
// | 模式 | 渲染 | 用途 |
// |---|---|---|
// | legacy  | 全部走 legacy | 现状基线 |
// | planner | 三类地块由 Planner 接管，其余 legacy | 看 Planner 真实产出 |
// | shadow  | 全部 legacy，Planner 的结果画成红色虚线轮廓叠在上面 | 一眼对比两套方案 |
//
// ## 第一批只接三类
//
// industrial / multi_family / retail —— 这三类有 Shadow 样本、有绝对强度带校准。
// hotel / data_center / single_family 暂时继续 legacy（没有 Shadow 样本，
// 假装校准过就是自欺）。
//
// **这一层不包含任何规划决策**：所有"放什么、放多大"都是 archetype 与
// evaluator 决定的；这里只负责调用、路由、汇总。

import type { Model } from '../town/model';
import { patchKey, type Patch } from '../town/patch';
import type { RoadNet } from '../road/system';
import { siteContextFromModel } from '../town/planning/adapters/model';
import { generateCandidates } from '../town/planning/generators';
import { selectBestCandidate } from '../town/shadow/runner';
import { realizeSitePlan } from '../town/realize';
import { INTENSITY_TARGETS, bandState, intensityValue, type BandState } from '../town/shadow/intensity';
import { surfaceArea } from '../town/planning/core/surface';
import type { SiteTypology } from '../town/planning/core/types';
import type { PathFeature, PropFeature, SolidFeature, SurfaceFeature } from './types';

export type PlanningMode = 'legacy' | 'planner' | 'shadow';

/** 第一批接管的 typology */
export const PLANNER_ENABLED_TYPOLOGIES: SiteTypology[] = ['industrial', 'multi_family', 'retail'];

export const TYPOLOGY_LABEL: Record<SiteTypology, string> = {
  industrial: 'Industrial',
  multi_family: 'Multi-Family',
  retail: 'Retail',
  hotel: 'Hotel',
  data_center: 'Data Center',
  single_family: 'Single-Family',
  generic: 'Generic',
};

export interface PlannerIntensityInfo {
  /** 口径说明，例如 "FAR 1.84 / preferred 1.4–2.2" */
  label: string;
  value: number;
  state: BandState;
  band: { min: number; preferredMin: number; preferredMax: number; max: number };
}

export interface PlannerParcelReport {
  parcelId: string;
  typology: SiteTypology;
  typologyLabel: string;
  /** Planner 是否接管了这块地 */
  covered: boolean;
  /** 没接管的原因（给人看，不是给机器看） */
  reason?: string;

  candidateId?: string;
  archetype?: string;
  score?: number;
  margin?: number | null;
  lowConfidence?: boolean;
  candidateCount?: number;

  buildings?: number;
  /** 建筑基底覆盖率 */
  coverage?: number;
  intensity?: PlannerIntensityInfo;
}

export interface PlannerParcelFeatures {
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
  props: PropFeature[];
}

export interface PlannerBundle {
  /** 每块被接管的地块的特征（key = patchKey） */
  byParcel: Map<string, PlannerParcelFeatures>;
  /** 每块地的报告（含没接管的） */
  reports: Map<string, PlannerParcelReport>;
  /** shadow 模式：Planner 的特征（画成红色虚线） */
  overlay: PlannerParcelFeatures;
  stats: {
    total: number;
    covered: number;
    byTypology: Record<string, { total: number; covered: number }>;
  };
}

/** 空特征包 */
function emptyFeatures(): PlannerParcelFeatures {
  return { surfaces: [], solids: [], paths: [], props: [] };
}

/**
 * 跑一遍 Planner，产出可直接进 Scene 的特征与报告。
 *
 * 注意 `realizeSitePlan` 之后**不再有任何 legacy 调用** —— 这是 R8 的核心红线。
 */
export function buildPlannerBundle(model: Model, net: RoadNet, mode: PlanningMode): PlannerBundle {
  const byParcel = new Map<string, PlannerParcelFeatures>();
  const reports = new Map<string, PlannerParcelReport>();
  const overlay = emptyFeatures();
  const stats = {
    total: 0,
    covered: 0,
    byTypology: {} as Record<string, { total: number; covered: number }>,
  };

  for (const patch of model.patches) {
    if (patch.blocked) continue;
    const key = patchKey(patch);
    const ctx = siteContextFromModel(model, patch, { net });

    const bucket = (stats.byTypology[ctx.typology] ??= { total: 0, covered: 0 });
    bucket.total++;
    stats.total++;

    const report: PlannerParcelReport = {
      parcelId: key,
      typology: ctx.typology,
      typologyLabel: TYPOLOGY_LABEL[ctx.typology] ?? ctx.typology,
      covered: false,
    };
    reports.set(key, report);

    if (!PLANNER_ENABLED_TYPOLOGIES.includes(ctx.typology)) {
      report.reason = `${report.typologyLabel} 暂未接入（没有 Shadow 样本与强度带）`;
      continue;
    }

    const candidates = generateCandidates(ctx);
    if (candidates.length === 0) {
      report.reason = '该地块没有可用候选（地块太小 / 形状不适合这类语法）';
      continue;
    }

    const best = selectBestCandidate(candidates);
    const cand = best.winner;
    const realized = realizeSitePlan(cand, { group: `lot/${ctx.typology}`, solveParking: true });

    const feats: PlannerParcelFeatures = {
      surfaces: realized.surfaces,
      solids: realized.solids,
      paths: realized.paths,
      props: realized.props,
    };
    byParcel.set(key, feats);

    // ---- 报告
    const parcelArea = surfaceArea(ctx.parcel);
    const fp = realized.solids.reduce((a, s) => a + Math.abs(ringAreaOf(s.ring)), 0);
    const coverage = parcelArea > 1e-9 ? fp / parcelArea : 0;
    report.covered = true;
    report.candidateId = cand.id;
    report.archetype = cand.archetype;
    report.score = cand.score ?? 0;
    report.margin = best.margin;
    report.lowConfidence = best.lowConfidence;
    report.candidateCount = best.count;
    report.buildings = realized.solids.length;
    report.coverage = coverage;

    const target = INTENSITY_TARGETS[ctx.typology];
    if (target) {
      const v = intensityValue(coverage, target);
      const st = bandState(v, target);
      // 覆盖率口径的数值很小（0.18 这种），用 1 位小数会显示成 "0.2–0.2"；
      // 容积率口径用 1 位小数就够。
      const fmt = (x: number) => (Math.abs(x) < 1 ? x.toFixed(2) : x.toFixed(1));
      report.intensity = {
        label: `${target.measure === 'stories' ? `FAR ×${target.stories}` : 'Cover'} ${fmt(v)} / preferred ${fmt(target.preferredMin)}–${fmt(target.preferredMax)}`,
        value: v,
        state: st,
        band: {
          min: target.min,
          preferredMin: target.preferredMin,
          preferredMax: target.preferredMax,
          max: target.max,
        },
      };
    }

    // shadow 模式：planner 的结果只进 overlay，不进主场景
    if (mode === 'shadow') {
      overlay.surfaces.push(...feats.surfaces);
      overlay.solids.push(...feats.solids);
      overlay.paths.push(...feats.paths);
      overlay.props.push(...feats.props);
    }
  }

  stats.covered = byParcel.size;
  for (const [k, r] of reports) {
    const b = stats.byTypology[r.typology];
    if (b && r.covered) b.covered++;
    void k;
  }

  return { byParcel, reports, overlay, stats };
}

/** 多边形环面积（带符号） */
function ringAreaOf(ring: { x: number; y: number }[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 给 UI 用的一句话摘要 */
export function summarizeBundle(b: PlannerBundle): string {
  const byType = Object.entries(b.stats.byTypology)
    .map(([t, v]) => `${TYPOLOGY_LABEL[t as SiteTypology] ?? t} ${v.covered}/${v.total}`)
    .join('  ');
  return `Planner 接管 ${b.stats.covered}/${b.stats.total} 块 · ${byType}`;
}
