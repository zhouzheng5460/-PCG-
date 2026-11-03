// Shadow Mode（R7）· Legacy vs Planner 并行对比
//
// 目的**不是**证明 Planner 的数字更好看，而是回答一个问题：
//   同一块 Parcel，Planner→Realizer 已经具备替代 modern.ts 场地规划职责的条件了吗？
//
// 两条链完全独立：
//   同一个 Patch
//     ├─ Legacy：modern.ts 生成的 Scene（预计算一次，按质心筛这块地）
//     └─ Planner：SiteContext → Archetype → Candidate → Realizer
//
// 没有 fallback、没有互相修正 —— Shadow 一旦串味，结论就没有意义。

import { Pt } from '../../core/geom';
import { Model } from '../model';
import { Patch, patchKey } from '../patch';
import { buildScene } from '../../scene/build';
import type { Scene } from '../../scene/types';
import type { RoadNet } from '../../road/system';
import { surface, surfaceArea, surfaceIntersect, ringArea, pointInRing, type PlanSurface } from '../planning/core/surface';
import { siteContextFromModel } from '../planning/adapters/model';
import { summarizeSite, eligibleArchetypes } from '../planning/core/context';
import { generateCandidates } from '../planning/generators';
import type { SitePlanCandidate } from '../planning/core/candidate';
import type { SiteContext, SiteTypology } from '../planning/core/types';
import { realizeSitePlan } from '../realize';
import type { RealizedSitePlan } from '../realize/contract';
import { surfaceUnion } from '../planning/core/surface';
import {
  INTENSITY_TARGETS,
  bandState,
  complianceOf,
  intensityValue,
  type BandState,
  type IntensityCompliance,
  type IntensityMeasure,
} from './intensity';

/**
 * Legacy 侧的归属三分（R7.5.1）。
 *
 * 早先用"建筑质心是否落在块内"筛选，结果把"质心在内、个别顶点在外"的邻居建筑
 * 也算成本块的，再记成 LEGACY_VIOLATION —— 那是在惩罚统计口径，不是在评价规划。
 * 现在按面积比拆成三级，只有 owned 参与比较。
 */
export interface AttributionSummary {
  /** footprint 完全在内，或交集占建筑 95% 以上 */
  owned: number;
  /** 交集比在 (0, 0.95) 之间：归属不清，单独统计不参与比较 */
  ambiguous: number;
  /** 几乎不相交 */
  outside: number;
}

/** 分级违规（R7.5.5）：Cutover Gate 只看 blocker */
export interface ViolationCounts {
  blocker: number;
  major: number;
  minor: number;
  total: number;
}

/** 某一侧的基础指标 —— 两侧同一张表，避免"对象多就是好"的误读 */
export interface ShadowMetrics {
  ms: number;
  objects: number;
  buildings: number;
  attribution?: AttributionSummary;
  groundRegions: number;

  /** 建筑基底面积（世界单位²）—— 强度比较的主指标 */
  buildingFootprintArea: number;
  /** buildingFootprintArea / 地块面积（两边同一口径） */
  buildingCoverageRatio: number;
  /** Σ footprint × 高度，粗略体量代理（不做真实层数法规） */
  floorProxy: number;

  parkingStalls: number;
  parkingArea: number;
  parkingRatio: number;
  openSpaceArea: number;
  openSpaceRatio: number;
  internalRoadM: number;

  /** 地面两两重叠率 */
  groundOverlapRatio: number;

  violations: ViolationCounts;
  /** 归一化违规：每千 m² 建筑面积 / 每栋 */
  violationsPer1000m2: number;
  violationsPerBuilding: number;

  warnings: string[];
}

export interface FidelityMetrics {
  buildingIou: number;
  groundCoverage: number;
  accessDrift: number;
  parkingContainment: number;
  roadDrift: number;
  /** P0 契约级别的阻断项 */
  blockers: string[];
}

export interface ShadowResult {
  parcelId: string;
  typology: SiteTypology;
  use: string;

  legacy: ShadowMetrics;
  planner: ShadowMetrics & {
    candidateId: string;
    archetype: string;
    candidateScore: number;
    candidateCount: number;
    runnerUpScore: number | null;
    scoreMargin: number | null;
    lowSelectionConfidence: boolean;
    fidelity: FidelityMetrics;
    archetypesEligible: string[];
  };

  comparison: {
    generationRatio: number;
    buildingDelta: number;
    parkingDelta: number;
    roadLengthDelta: number;
    /** 开发强度比：planner / legacy 的 buildingCoverageRatio（R7.5.8 的闸门） */
    intensityRatio: number;
    intensityFlag: 'ok' | 'PLANNER_UNDERBUILT' | 'PLANNER_OVERBUILT' | 'no_baseline';
    /** 绝对强度带（R7.8）：声明过的 typology 用带子判，Legacy 只作旁证 */
    intensityBand: {
      measure: IntensityMeasure;
      stories: number;
      band: { min: number; preferredMin: number; preferredMax: number; max: number };
      plannerValue: number;
      legacyValue: number;
      plannerState: BandState;
      legacyState: BandState;
      compliance: IntensityCompliance;
      rationale: string;
    } | null;
    legacyViolations: ViolationCounts;
    plannerViolations: ViolationCounts;
    verdict:
      | 'planner_quality_better'
      | 'legacy_quality_better'
      | 'equivalent'
      | 'density_mismatch'
      | 'inconclusive';
    reason: string;
  };
}

export interface ShadowInput {
  model: Model;
  patch: Patch;
  /** 预计算的 legacy 场景（批量跑时只 buildScene 一次） */
  legacyScene: Scene;
  net: RoadNet;
  /** 强制指定 typology（默认按用途推） */
  typology?: SiteTypology;
}

export function runPlanningShadow(input: ShadowInput): ShadowResult | null {
  const { model, patch, legacyScene, net } = input;
  const ring = Array.from(patch.shape) as Pt[];
  if (ring.length < 3) return null;

  const parcel = surface(ring);
  const parcelArea = surfaceArea(parcel);
  const use = patchUse(patch);

  // ---- Legacy：按面积归属筛（contained / majority 才算本块的）
  const tL = Date.now();
  const legacy = collectLegacy(legacyScene, ring, parcelArea);
  legacy.ms = Date.now() - tL;

  // ---- Planner：Context → Candidate → **显式选优** → Realizer
  const tP = Date.now();
  const ctx = siteContextFromModel(model, patch, { net, typology: input.typology });
  const cands = generateCandidates(ctx);
  if (cands.length === 0) return null;
  const best = selectBestCandidate(cands);
  const cand = best.winner;
  const realized = realizeSitePlan(cand, { group: `lot/${ctx.typology}`, solveParking: true });
  const plannerMs = Date.now() - tP;

  const planner = collectPlanner(cand, realized, parcel, parcelArea);
  planner.ms = plannerMs;

  const fidelity = computeFidelity(cand, realized, parcel);

  // ---- 对比：先看强度是否可比，再谈质量
  const intensityRatio =
    legacy.buildingCoverageRatio > 1e-6 ? planner.buildingCoverageRatio / legacy.buildingCoverageRatio : 0;

  // ---- 绝对强度带（R7.8）
  //
  // 相对比把 Legacy 当基准；三类 typology 校准完之后都指向"Legacy 才是偏的那一方"。
  // 所以**声明过的 typology 一律用带子判**，Legacy 只留作对照信息。
  const target = INTENSITY_TARGETS[ctx.typology] ?? null;
  let intensityBand: ShadowResult['comparison']['intensityBand'] = null;
  let intensityFlag: ShadowResult['comparison']['intensityFlag'];
  if (target) {
    const pv = intensityValue(planner.buildingCoverageRatio, target);
    const lv = intensityValue(legacy.buildingCoverageRatio, target);
    const ps = bandState(pv, target);
    const ls = bandState(lv, target);
    intensityBand = {
      measure: target.measure,
      stories: target.stories,
      band: {
        min: target.min,
        preferredMin: target.preferredMin,
        preferredMax: target.preferredMax,
        max: target.max,
      },
      plannerValue: pv,
      legacyValue: lv,
      plannerState: ps,
      legacyState: ls,
      compliance: complianceOf(ps, ls),
      rationale: target.rationale,
    };
    intensityFlag = ps === 'below' ? 'PLANNER_UNDERBUILT' : ps === 'above' ? 'PLANNER_OVERBUILT' : 'ok';
  } else {
    intensityFlag =
      legacy.buildingCoverageRatio <= 1e-6
        ? 'no_baseline'
        : intensityRatio < 0.75
          ? 'PLANNER_UNDERBUILT'
          : intensityRatio > 1.25
            ? 'PLANNER_OVERBUILT'
            : 'ok';
  }

  let verdict: ShadowResult['comparison']['verdict'] = 'equivalent';
  let reason = '';
  if (fidelity.blockers.length > 0) {
    verdict = 'inconclusive';
    reason = `P0 blocker：${fidelity.blockers.join(',')}`;
  } else if (intensityFlag !== 'ok' && intensityFlag !== 'no_baseline') {
    // 强度不可比时**不允许**判质量优劣 —— 这正是"58:1"那种假胜利的来源
    verdict = 'density_mismatch';
    reason = intensityBand
      ? `开发强度 ${intensityBand.plannerValue.toFixed(2)} 落在带外（带 ${intensityBand.band.min}~${intensityBand.band.max}），质量对比不成立`
      : `开发强度比 ${intensityRatio.toFixed(2)}（${intensityFlag}），质量对比不成立`;
  } else if (planner.violations.blocker < legacy.violations.blocker) {
    verdict = 'planner_quality_better';
    reason = `blocker 更少（${planner.violations.blocker} vs ${legacy.violations.blocker}）`;
  } else if (planner.violations.blocker > legacy.violations.blocker) {
    verdict = 'legacy_quality_better';
    reason = `blocker 更多（${planner.violations.blocker} vs ${legacy.violations.blocker}）`;
  } else if (planner.violations.major < legacy.violations.major) {
    verdict = 'planner_quality_better';
    reason = `major 更少（${planner.violations.major} vs ${legacy.violations.major}）`;
  } else {
    reason = `blocker/major 相同（${planner.violations.blocker}/${planner.violations.major}）`;
  }

  const shape = summarizeSite(ctx);
  return {
    parcelId: patchKey(patch),
    typology: ctx.typology,
    use,
    legacy,
    planner: {
      ...planner,
      candidateId: cand.id,
      archetype: cand.archetype,
      candidateScore: cand.score ?? 0,
      candidateCount: best.count,
      runnerUpScore: best.runnerUp?.score ?? null,
      scoreMargin: best.margin,
      lowSelectionConfidence: best.lowConfidence,
      fidelity,
      archetypesEligible: eligibleArchetypes(ctx.typology, shape).map((a) => a.archetype).slice(0, 3),
    },
    comparison: {
      generationRatio: legacy.ms > 0 ? plannerMs / legacy.ms : 0,
      buildingDelta: planner.buildings - legacy.buildings,
      parkingDelta: planner.parkingStalls - legacy.parkingStalls,
      roadLengthDelta: planner.internalRoadM - legacy.internalRoadM,
      intensityRatio,
      intensityFlag,
      intensityBand,
      legacyViolations: legacy.violations,
      plannerViolations: planner.violations,
      verdict,
      reason,
    },
  };
}

// ---------------------------------------------------------------- Legacy 采集

/**
 * 按**面积归属**筛选：contained / majority 才算这块地的，ambiguous 单独记，
 * outside 直接不算（那是邻居的楼）。早先用"质心在内"筛选，把邻居的楼算进本块
 * 再记成违规 —— 那是在惩罚统计口径，不是在评价规划。
 */
function collectLegacy(scene: Scene, ring: Pt[], parcelArea: number): ShadowMetrics {
  const parcel = surface(ring);
  const owned: typeof scene.solids = [];
  let ambiguous = 0;
  let outside = 0;
  for (const s of scene.solids) {
    const bArea = Math.abs(ringArea(s.ring));
    if (bArea < 1e-6) continue;
    const inter = surfaceIntersect([surface(s.ring)], [parcel]).reduce((a, q) => a + surfaceArea(q), 0);
    const ratio = inter / bArea;
    if (ratio >= 0.95) owned.push(s);
    else if (ratio > 0.001) ambiguous++;
    else outside++;
  }

  const inside = (p: Pt) => pointInRing(p, ring);
  const surfaces = scene.surfaces.filter((s) => inside(centroid(s.ring)));
  const paths = scene.paths.filter((p) => inside(centroid(p.pts)));

  let footprint = 0;
  let floorProxy = 0;
  for (const s of owned) {
    const a = Math.abs(ringArea(s.ring));
    footprint += a;
    floorProxy += a * s.h;
  }

  let parkingArea = 0;
  let openArea = 0;
  let gTotal = 0;
  let gOver = 0;
  const flats = surfaces.filter((s) => Math.abs(ringArea(s.ring)) > 0.5);
  for (const f of flats) {
    const a = Math.abs(ringArea(f.ring));
    gTotal += a;
    if (f.mat === 'asphaltLot' || f.mat === 'asphalt') parkingArea += a;
    if (f.mat === 'grass' || f.mat === 'grassDark') openArea += a;
  }
  for (let i = 0; i < flats.length; i++) {
    for (let j = i + 1; j < flats.length; j++) {
      const a = surfaceIntersect([surface(flats[i].ring)], [surface(flats[j].ring)]);
      gOver += a.reduce((x, q) => x + surfaceArea(q), 0);
    }
  }

  let blocker = 0;
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      const a = surfaceIntersect([surface(owned[i].ring)], [surface(owned[j].ring)]);
      if (a.reduce((x, q) => x + surfaceArea(q), 0) > 1) blocker++;
    }
  }
  for (const s of owned) {
    if (s.ring.some((p) => !inside(p) && distToRing(p, ring) > 0.15)) blocker++;
  }
  const minor = gTotal > 1e-9 && gOver / gTotal > 0.02 ? 1 : 0;
  const major = 0;

  const roadM = paths
    .filter((p) => p.mat === 'asphalt' || p.mat === 'asphaltLot' || p.mat === 'concrete')
    .reduce((acc, p) => {
      let len = 0;
      for (let i = 0; i + 1 < p.pts.length; i++) len += Pt.distance(p.pts[i], p.pts[i + 1]);
      return acc + len;
    }, 0);

  const total = blocker + major + minor;
  return {
    ms: 0,
    objects: owned.length + surfaces.length + paths.length,
    buildings: owned.length,
    attribution: { owned: owned.length, ambiguous, outside },
    groundRegions: flats.length,
    buildingFootprintArea: footprint,
    buildingCoverageRatio: parcelArea > 1e-9 ? footprint / parcelArea : 0,
    floorProxy,
    parkingStalls: paths.filter((p) => p.name.includes('stall')).length,
    parkingArea,
    parkingRatio: parcelArea > 1e-9 ? parkingArea / parcelArea : 0,
    openSpaceArea: openArea,
    openSpaceRatio: parcelArea > 1e-9 ? openArea / parcelArea : 0,
    internalRoadM: roadM * 7,
    groundOverlapRatio: gTotal > 1e-9 ? gOver / gTotal : 0,
    violations: { blocker, major, minor, total },
    violationsPer1000m2: footprint > 1e-9 ? (total / (footprint * 49)) * 1000 : 0,
    violationsPerBuilding: owned.length > 0 ? total / owned.length : 0,
    warnings: [],
  };
}

// ---------------------------------------------------------------- Planner 采集

const OPEN_PROGRAMS = new Set([
  'front_yard', 'rear_yard', 'courtyard', 'community_green', 'landscape',
  'landscape_buffer', 'security_buffer', 'amenity',
]);

function collectPlanner(c: SitePlanCandidate, r: RealizedSitePlan, parcel: PlanSurface, parcelArea: number): ShadowMetrics {
  const inside = (p: Pt) => pointInRing(p, parcel.outer);
  const solids = r.solids;

  let footprint = 0;
  let floorProxy = 0;
  for (const s of solids) {
    const a = Math.abs(ringArea(s.ring));
    footprint += a;
    floorProxy += a * s.h;
  }

  const flats = r.surfaces.filter(
    (s) => !s.name.includes('_road_') && !s.name.includes('_parkreq_') && Math.abs(ringArea(s.ring)) > 0.5
  );
  let gTotal = 0;
  let gOver = 0;
  for (const f of flats) gTotal += Math.abs(ringArea(f.ring));
  for (let i = 0; i < flats.length; i++) {
    for (let j = i + 1; j < flats.length; j++) {
      const a = surfaceIntersect(
        [surface(flats[i].ring, flats[i].holes ?? [])],
        [surface(flats[j].ring, flats[j].holes ?? [])]
      );
      gOver += a.reduce((x, q) => x + surfaceArea(q), 0);
    }
  }

  const parkingGround = c.ground
    .filter((g) => g.program === 'parking' || g.program === 'employee_parking')
    .reduce((a, g) => a + g.area, 0);
  const openArea = c.ground.filter((g) => OPEN_PROGRAMS.has(g.program)).reduce((a, g) => a + g.area, 0);

  let blocker = 0;
  let major = 0;
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = surfaceIntersect([surface(solids[i].ring)], [surface(solids[j].ring)]);
      if (a.reduce((x, q) => x + surfaceArea(q), 0) > 1) blocker++;
    }
  }
  // 顶点落在边界上不算跑出（ray casting 对边界点不稳定，规划层的楼本来就贴着红线）
  for (const s of solids) {
    if (s.ring.some((p) => !inside(p) && distToRing(p, parcel.outer) > 0.15)) blocker++;
  }
  if (r.warnings.some((w) => w.code === 'GROUND_HOLE_LOST')) blocker++;
  for (const f of r.surfaces.filter((x) => x.name.includes('_road_'))) {
    if (f.ring.some((p) => !inside(p) && distToRing(p, parcel.outer) > 0.15)) {
      blocker++;
      break;
    }
  }

  const stalls = r.paths.filter((p) => p.name.includes('_stall_'));
  let stallOut = 0;
  for (const p of stalls) {
    const mid = new Pt((p.pts[0].x + p.pts[1].x) / 2, (p.pts[0].y + p.pts[1].y) / 2);
    if (!c.parkingRequests.some((q) => pointInRing(mid, q.region.outer))) stallOut++;
  }
  if (stallOut > 0) major++;

  const minor = gTotal > 1e-9 && gOver / gTotal > 0.02 ? 1 : 0;
  const total = blocker + major + minor;

  return {
    ms: 0,
    objects: r.solids.length + r.surfaces.length + r.paths.length,
    buildings: c.buildings.length,
    groundRegions: flats.length,
    buildingFootprintArea: footprint,
    buildingCoverageRatio: parcelArea > 1e-9 ? footprint / parcelArea : 0,
    floorProxy,
    parkingStalls: (r.parkingStats ?? []).reduce((a, x) => a + x.stalls, 0),
    parkingArea: parkingGround,
    parkingRatio: parcelArea > 1e-9 ? parkingGround / parcelArea : 0,
    openSpaceArea: openArea,
    openSpaceRatio: parcelArea > 1e-9 ? openArea / parcelArea : 0,
    internalRoadM: (r.roadStats ?? []).reduce((a, x) => a + x.lengthM, 0),
    groundOverlapRatio: gTotal > 1e-9 ? gOver / gTotal : 0,
    violations: { blocker, major, minor, total },
    violationsPer1000m2: footprint > 1e-9 ? (total / (footprint * 49)) * 1000 : 0,
    violationsPerBuilding: solids.length > 0 ? total / solids.length : 0,
    warnings: r.warnings.map((w) => w.code),
  };
}

/**
 * 显式选优：不再用"数组第一项"这种模糊语义。
 * margin 太小说明 Planner 自己也不确定（LOW_SELECTION_CONFIDENCE）。
 */
export function selectBestCandidate(cands: SitePlanCandidate[]): {
  winner: SitePlanCandidate;
  runnerUp: SitePlanCandidate | null;
  margin: number | null;
  lowConfidence: boolean;
  count: number;
} {
  const sorted = cands.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = sorted[0];
  const runnerUp = sorted[1] ?? null;
  const margin = runnerUp ? (winner.score ?? 0) - (runnerUp.score ?? 0) : null;
  return { winner, runnerUp, margin, lowConfidence: margin !== null && margin < 0.15, count: sorted.length };
}

// ---------------------------------------------------------------- Fidelity

function computeFidelity(c: SitePlanCandidate, r: RealizedSitePlan, parcel: PlanSurface): FidelityMetrics {
  const blockers: string[] = [];
  if (r.warnings.some((w) => w.code === 'GROUND_HOLE_LOST')) blockers.push('GROUND_HOLE_LOST');

  let worst = 1;
  for (let i = 0; i < Math.min(r.solids.length, c.buildings.length); i++) {
    const a = surface(r.solids[i].ring);
    const b = surface(c.buildings[i].footprint.outer);
    const inter = surfaceIntersect([a], [b]).reduce((s2, q) => s2 + surfaceArea(q), 0);
    const uni = surfaceUnion([a, b]).reduce((s2, q) => s2 + surfaceArea(q), 0);
    worst = Math.min(worst, uni > 1e-9 ? inter / uni : 1);
  }

  const planned = surfaceUnion(c.ground.map((g) => g.surface)).reduce((s2, q) => s2 + surfaceArea(q), 0);
  const realized = surfaceUnion(
    r.surfaces.filter((f) => !f.name.includes('_parkreq_')).map((f) => surface(f.ring, f.holes ?? []))
  ).reduce((s2, q) => s2 + surfaceArea(q), 0);

  const accPaths = r.paths.filter((p) => p.name.includes('_access_'));
  let drift = 0;
  for (let i = 0; i < Math.min(accPaths.length, c.access.length); i++) {
    drift = Math.max(drift, Math.hypot(accPaths[i].pts[0].x - c.access[i].at.x, accPaths[i].pts[0].y - c.access[i].at.y));
  }

  const stallPaths = r.paths.filter((p) => p.name.includes('_stall_'));
  let contained = 0;
  for (const p of stallPaths) {
    const mid = new Pt((p.pts[0].x + p.pts[1].x) / 2, (p.pts[0].y + p.pts[1].y) / 2);
    if (c.parkingRequests.some((q) => pointInRing(mid, q.region.outer))) contained++;
  }

  let roadDrift = 0;
  for (let k = 0; k < Math.min((r.roadStats ?? []).length, c.circulation.length); k++) {
    const planned2 = c.circulation[k].pts;
    const used = r.roadStats![k].consumedCenterline;
    for (let j = 0; j < Math.min(planned2.length, used.length); j++) {
      roadDrift = Math.max(roadDrift, Math.hypot(planned2[j].x - used[j].x, planned2[j].y - used[j].y));
    }
  }

  void parcel;
  return {
    buildingIou: worst,
    groundCoverage: planned > 1e-9 ? realized / planned : 1,
    accessDrift: drift,
    parkingContainment: stallPaths.length === 0 ? 1 : contained / stallPaths.length,
    roadDrift,
    blockers,
  };
}

// ---------------------------------------------------------------- 工具

function patchUse(patch: Patch): string {
  const ov = patch.override?.use;
  if (ov) return ov;
  const w = patch.ward as unknown as { use?: string } | null;
  return w?.use ?? 'residential';
}

function distToRing(p: Pt, ring: Pt[]): number {
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

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

/** 批量跑：同一座城，逐块地 Shadow */
export function runShadowBatch(
  model: Model,
  opts: { net: RoadNet; legacyScene: Scene; typologyOf?: (p: Patch) => SiteTypology | undefined }
): ShadowResult[] {
  const out: ShadowResult[] = [];
  for (const patch of model.patches) {
    if (patch.blocked) continue;
    const r = runPlanningShadow({
      model,
      patch,
      legacyScene: opts.legacyScene,
      net: opts.net,
      typology: opts.typologyOf?.(patch),
    });
    if (r) out.push(r);
  }
  return out;
}
