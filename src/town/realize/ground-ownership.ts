// Planning Realization · R3.5 Ground Ownership（空间所有权）
//
// 问题：Planner 的 Ground Region 允许**语义重叠**（车道压在前院上是正常的画法），
// 但最终地表只能有一层。SF 的 `sum(realized area) / sum(planned area) = 1.08`
// 就是这个问题的症状：front_yard 与 driveway 同时宣称拥有同一块地。
//
// 解决方式：在 Realization 里按优先级做**布尔切割**，让每块地只有一个所有者。
//
// 注意这仍然是 Realization 的工作，不是 Planner 的：
//   · 优先级只用来解决"几何占地冲突"，不重新决定"功能放在哪"；
//   · Planner 输出的 region 一个都不丢，只是被切小。

import type { GroundProgram, PlannedRegion } from '../planning/core/candidate';
import { surfaceArea, surfaceSubtract, type PlanSurface } from '../planning/core/surface';

/**
 * 两类 Program。
 *
 * Exclusive：最终只能有一层地表（草地 / 铺装 / 场地）。
 * Overlay：规划时是"连接件"，落地时必须从底层切出来（车道、人行带、落客、服务道）。
 *
 * 两者在切割上的处理其实一样（都参与优先级排序），区分它们是为了**表达意图**：
 * 以后要加"半透明叠加层"时，只有 Overlay 才可能允许叠加。
 */
export const EXCLUSIVE_PROGRAMS: GroundProgram[] = [
  'parking',
  'employee_parking',
  'front_yard',
  'rear_yard',
  'courtyard',
  'amenity',
  'landscape',
  'landscape_buffer',
  'truck_court',
  'loading_apron',
  'mechanical_yard',
  'electrical_yard',
  'utility_yard',
  'security_buffer',
  'community_green',
  'arrival_court',
  'office_forecourt',
  'residual',
];

export const OVERLAY_PROGRAMS: GroundProgram[] = [
  'driveway',
  'pedestrian',
  'entrance_forecourt',
  'dropoff',
  'service',
  'service_lane',
];

/**
 * 优先级：数字大的先占位，后面的从它里面被切掉。
 *
 * 排序原则是"谁更专属于人/车的移动，谁优先"：
 *   车道 > 人行 > 落客 > 装卸 > 货运场地 > 停车 > 庭院/配套 > 院子 > 绿化 > 残地。
 * 这样"草地压车道"这类错误从根上不会发生。
 */
export const GROUND_PRIORITY: Record<GroundProgram, number> = {
  driveway: 100,
  service_lane: 98,
  dropoff: 96,
  pedestrian: 92,
  entrance_forecourt: 88,
  loading_apron: 82,
  truck_court: 78,
  // 树岛和通道压在车位面上：树岛最高（树不能被车位吃掉），通道其次
  parking_island: 76,
  parking_aisle: 74,
  parking: 72,
  employee_parking: 72,
  arrival_court: 62,
  courtyard: 60,
  amenity: 60,
  mechanical_yard: 58,
  electrical_yard: 58,
  utility_yard: 56,
  office_forecourt: 55,
  front_yard: 48,
  rear_yard: 44,
  security_buffer: 40,
  landscape: 38,
  landscape_buffer: 38,
  community_green: 34,
  service: 76,
  residual: 10,
};

/** 切割后小于这个面积（世界单位²）的碎片直接丢掉：它们只会变成脏斑 */
const MIN_PIECE = 0.02;

export interface OwnershipResult {
  regions: PlannedRegion[];
  /** 因为被切掉而缩小的 region 数 */
  trimmed: number;
  /** 被完全吃掉的 region 数 */
  consumed: number;
}

/**
 * 按优先级切割，产出"每个点只有一个所有者"的地面集合。
 *
 * 复杂度 O(n²)（两两求差），城市尺度下 n < 100，可接受；
 * 真到上千个 region 再上 RBush 做候选筛选（接口不变）。
 */
export function resolveGroundOwnership(regions: PlannedRegion[]): OwnershipResult {
  const sorted = regions
    .slice()
    .sort((a, b) => (GROUND_PRIORITY[b.program] ?? 0) - (GROUND_PRIORITY[a.program] ?? 0));

  const out: PlannedRegion[] = [];
  const taken: PlanSurface[] = [];
  let trimmed = 0;
  let consumed = 0;

  for (const r of sorted) {
    if (taken.length === 0) {
      out.push(r);
      taken.push(r.surface);
      continue;
    }
    const rest = surfaceSubtract([r.surface], taken);
    const pieces = rest.filter((p) => surfaceArea(p) > MIN_PIECE);

    if (pieces.length === 0) {
      consumed++;
      continue;
    }
    // 面积没变（没被切到）就别动它，保持 1:1
    const before = surfaceArea(r.surface);
    const after = pieces.reduce((s, p) => s + surfaceArea(p), 0);
    if (pieces.length === 1 && Math.abs(after - before) < 1e-6) {
      out.push(r);
    } else {
      trimmed++;
      for (const p of pieces) {
        out.push({ ...r, surface: p, area: surfaceArea(p) });
      }
    }
    taken.push(r.surface);
  }

  return { regions: out, trimmed, consumed };
}

/**
 * 两两重叠率（parity 用）：重叠总面积 / 总面积。
 *
 * 用 bbox 先粗筛，避免 n² 次布尔运算里绝大多数是白算的。
 */
export function exclusiveOverlapRatio(regions: PlannedRegion[]): number {
  const n = regions.length;
  if (n < 2) return 0;
  const boxes = regions.map((r) => bbox(r.surface.outer));
  let overlap = 0;
  let total = 0;
  // 口径必须**处处一致**：`r.area` 是调用方给的，未必减过洞；
  // 而 surfaceArea() 是"外环 − 洞"。两者混用会把"带洞的面"当成重叠 ——
  // MF 院子加步道之后 parking 出现洞，这个函数立刻误报 6.47%。
  for (const r of regions) total += surfaceArea(r.surface);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!boxesOverlap(boxes[i], boxes[j])) continue;
      const inter = surfaceSubtract([regions[i].surface], [regions[j].surface]);
      const before = surfaceArea(regions[i].surface);
      const after = inter.reduce((s, p) => s + surfaceArea(p), 0);
      const interArea = before - after;
      if (interArea > 1e-6) overlap += interArea;
    }
  }
  return total > 1e-9 ? overlap / total : 0;
}

function bbox(ring: { x: number; y: number }[]) {
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

function boxesOverlap(a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}
