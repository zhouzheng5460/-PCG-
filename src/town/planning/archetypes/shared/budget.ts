// Archetype · 面积预算（C4）
//
// 原先把"绿地占多少、铺装占多少"散在各个 diagnostics 里各算各的：泊车用一套、
// 广场用一套、绿地又用一套，口径互相打架。这里收成**一张表**：
//
//   建筑 / 通行 / 前场 / 广场 / 绿地 / 服务+停车 / 保留 / 未覆盖
//
// 三件事靠它保证：
//   ① **面积守恒** —— 各项之和 + 未覆盖 = 可建区；
//   ② **互不重叠** —— 只能检查"口径"，几何重叠由 Ground Ownership 在落地时切；
//   ③ **可解释** —— 预算表直接进 candidate.notes，出问题能一眼看出是哪一项超了。
//
// 分段是"语义"而不是"材质"：`entrance_forecourt` 算前场，`amenity` 算广场，
// 两者在总图上都是硬地，但在方案里是两件事（一个是入口集散，一个是活动场地）。

import { surfaceArea, type PlanSurface } from '../../core/surface';
import type { GroundProgram, PlannedBuilding, PlannedRegion } from '../../core/candidate';
import type { SiteContext } from '../../core/types';

/** 地面程序 → 预算科目 */
const LEDGER: Record<string, keyof AreaBudget> = {
  // 通行
  pedestrian: 'circulation',
  park_path: 'circulation',
  driveway: 'circulation',
  // 前场（入口集散）
  entrance_forecourt: 'forecourt',
  office_forecourt: 'forecourt',
  arrival_court: 'forecourt',
  dropoff: 'forecourt',
  // 广场 / 活动场地
  amenity: 'plaza',
  // 服务 + 停车
  service: 'serviceParking',
  service_lane: 'serviceParking',
  loading_apron: 'serviceParking',
  truck_court: 'serviceParking',
  utility_yard: 'serviceParking',
  mechanical_yard: 'serviceParking',
  electrical_yard: 'serviceParking',
  parking: 'serviceParking',
  parking_aisle: 'serviceParking',
  parking_island: 'serviceParking',
  employee_parking: 'serviceParking',
  // 绿地
  lawn: 'green',
  planting: 'green',
  landscape: 'green',
  landscape_buffer: 'green',
  community_green: 'green',
  courtyard: 'green',
  front_yard: 'green',
  rear_yard: 'green',
  security_buffer: 'green',
  // 保留 / 残地
  residual: 'reserved',
};

export interface AreaBudget {
  /** 以下全部是世界单位²（×49 = m²） */
  buildable: number;
  building: number;
  circulation: number;
  forecourt: number;
  plaza: number;
  green: number;
  serviceParking: number;
  reserved: number;
  /** 可建区 − 上述之和；>0 说明有地没被任何 program 认领 */
  unclaimed: number;
  /** 各项占可建区的比例 */
  share: Record<string, number>;
}

const ZERO_KEYS = ['building', 'circulation', 'forecourt', 'plaza', 'green', 'serviceParking', 'reserved'] as const;

/**
 * 算预算。`ground` 必须是**互不重叠**的（我们的 archetype 都自己减过了），
 * 否则这里会把重叠面积重复计入，守恒立刻不成立 —— 这本身就是一道护栏。
 */
export function areaBudgetOf(
  ctx: SiteContext,
  ground: PlannedRegion[],
  buildings: PlannedBuilding[]
): AreaBudget {
  const buildable = surfaceArea(ctx.buildableArea);
  const b: AreaBudget = {
    buildable,
    building: 0,
    circulation: 0,
    forecourt: 0,
    plaza: 0,
    green: 0,
    serviceParking: 0,
    reserved: 0,
    unclaimed: 0,
    share: {},
  };
  const num = b as unknown as Record<string, number>;
  for (const g of ground) {
    const key = LEDGER[g.program as GroundProgram] ?? 'reserved';
    num[key] += g.area;
  }
  for (const bl of buildings) b.building += surfaceArea(bl.footprint);
  const claimed = ZERO_KEYS.reduce((s, k) => s + b[k], 0);
  b.unclaimed = Math.max(0, buildable - claimed);
  for (const k of [...ZERO_KEYS, 'unclaimed'] as const) {
    b.share[k] = buildable > 1e-9 ? num[k] / buildable : 0;
  }
  return b;
}

/** 一行文字版，直接进 candidate.notes */
export function formatBudget(b: AreaBudget): string {
  const pct = (k: string) => `${(b.share[k] * 100).toFixed(0)}%`;
  return (
    `面积预算(${(b.buildable * 49).toFixed(0)}m²)：` +
    `建筑 ${pct('building')} 通行 ${pct('circulation')} 前场 ${pct('forecourt')} ` +
    `广场 ${pct('plaza')} 绿地 ${pct('green')} 服务/停车 ${pct('serviceParking')} ` +
    `保留 ${pct('reserved')} 未覆盖 ${pct('unclaimed')}`
  );
}

/**
 * 守恒检查：返回问题描述（空数组 = 通过）。
 *
 * 阈值取 2%：布尔裁剪与量化误差会留下一点余量，但**不该超过 2%** ——
 * 超过就说明有整块地没被认领，或者同一块地被算了两遍。
 */
export function budgetIssues(b: AreaBudget): string[] {
  const out: string[] = [];
  const sum = ZERO_KEYS.reduce((s, k) => s + b[k], 0);
  const gap = (b.buildable - sum) / Math.max(b.buildable, 1e-9);
  if (gap > 0.02) out.push(`未覆盖 ${(gap * 100).toFixed(1)}%`);
  if (gap < -0.02) out.push(`重叠/超额 ${(-gap * 100).toFixed(1)}%`);
  if (b.share.green < 0.05) out.push(`绿地 ${(b.share.green * 100).toFixed(0)}% 偏少`);
  return out;
}

/** 便捷：某个程序集合的面积（m²） */
export function areaOfPrograms(ground: PlannedRegion[], progs: GroundProgram[]): number {
  return ground.filter((g) => progs.includes(g.program)).reduce((a, g) => a + g.area, 0) * 49;
}

export type { PlanSurface };
