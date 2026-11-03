// Planning · Typology → Candidate 生成器映射（唯一出口）
//
// 为什么单独抽出来：Shadow Runner 和前端 Planner Mode 都需要"按 typology 找生成器"。
// 之前映射表写在 `shadow/runner.ts` 里，前端若照抄一份就会变成两份真相 ——
// 改了一个 typology 的生成器，另一个不跟着改，Shadow 报的数和前端看到的数对不上。
//
// 这里只做**路由**，不含任何规划逻辑：
//   SiteContext → 生成器 → SitePlanCandidate[]
//
// 生成器自己只吃 SiteContext、只吐 SitePlanCandidate，不碰 Scene / three。

import type { SiteContext, SiteTypology } from './core/types';
import type { SitePlanCandidate } from './core/candidate';
import { generateIndustrialRearLoadCandidates } from './archetypes/industrial/rear-load';
import { generateMultiFamilyCourtyardCandidates } from './archetypes/multifamily/courtyard';
import { generateRetailStripCandidates } from './archetypes/retail/strip';
import { generateHotelGurbanCandidates } from './archetypes/hotel/gurban';
import { generateDataCenterSingleHallCandidates } from './archetypes/datacenter/single-hall';
import { generateSingleFamilyGridCandidates } from './archetypes/singlefamily/grid';

/** typology → 生成器 */
export const PLANNING_GENERATORS: Partial<Record<SiteTypology, (ctx: SiteContext) => SitePlanCandidate[]>> = {
  industrial: generateIndustrialRearLoadCandidates,
  multi_family: generateMultiFamilyCourtyardCandidates,
  retail: generateRetailStripCandidates,
  hotel: generateHotelGurbanCandidates,
  data_center: generateDataCenterSingleHallCandidates,
  single_family: generateSingleFamilyGridCandidates,
};

/** 按 typology 生成候选；没有对应生成器就返回空数组 */
export function generateCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const gen = PLANNING_GENERATORS[ctx.typology];
  return gen ? gen(ctx) : [];
}
