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
import { asRects } from './archetypes/shared/rect';
import { claimResidual } from './archetypes/shared/claim';
import { evaluateLayout, weightsFor } from './core/evaluator';
import { surfaceArea } from './core/surface';
import type { LayoutDiagnostics } from './core/types';
import { industrialDiagnostics } from './typologies/industrial';
import { mfDiagnostics } from './typologies/multifamily';
import { retailDiagnostics } from './typologies/retail';
import { hotelDiagnostics } from './typologies/hotel';
import { dcDiagnostics } from './typologies/datacenter';
import { sfDiagnostics } from './typologies/singlefamily';

/** typology → 生成器 */
export const PLANNING_GENERATORS: Partial<Record<SiteTypology, (ctx: SiteContext) => SitePlanCandidate[]>> = {
  industrial: generateIndustrialRearLoadCandidates,
  multi_family: generateMultiFamilyCourtyardCandidates,
  retail: generateRetailStripCandidates,
  hotel: generateHotelGurbanCandidates,
  data_center: generateDataCenterSingleHallCandidates,
  single_family: generateSingleFamilyGridCandidates,
};

/** typology → 诊断函数（矩形化之后要重算分，必须用同一个函数） */
const DIAGNOSTICS: Partial<Record<SiteTypology, (ctx: SiteContext, c: SitePlanCandidate) => LayoutDiagnostics>> = {
  industrial: industrialDiagnostics,
  multi_family: mfDiagnostics,
  retail: retailDiagnostics,
  hotel: hotelDiagnostics,
  data_center: dcDiagnostics,
  single_family: sfDiagnostics,
};

/**
 * 把所有建筑的 footprint 统一成**轴对齐矩形组**。
 *
 * 各 archetype 生成建筑时用的是 `矩形 ∩ 可建区`，在斜边 / 不规则地块上
 * 交出来的是梯形、五边形 —— 3D 里就是"被挤出来的怪形状"。
 *
 * 这一层放在**生成器出口**而不是每个 archetype 里：它是纯几何规整，
 * 与 typology 的语法无关。放在出口还保证了一件事 —— 所有走 Planner 的
 * 地块（六种类型、未来新增的类型）都自动是直角盒，不用逐个改。
 *
 * 矩形化之后 footprint 变了，diagnostics 必须**用同一个函数重算**，
 * 否则评分和几何对不上（覆盖率、围合度、碎片惩罚全都基于 footprint）。
 */
function rectifyBuildings(c: SitePlanCandidate): boolean {
  let changed = false;
  const out: typeof c.buildings = [];
  for (const b of c.buildings) {
    const rects = asRects(b.footprint, { step: 0.2, minSide: 0.5 });
    if (rects.length === 1 && rects[0] === b.footprint) {
      out.push(b);
      continue;
    }
    changed = true;
    for (const r of rects) {
      out.push({ ...b, footprint: r, notes: [...(b.notes ?? []), rects.length > 1 ? '矩形分解' : ''] });
    }
  }
  if (changed) c.buildings = out;
  return changed;
}

/** 按 typology 生成候选；没有对应生成器就返回空数组 */
export function generateCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const gen = PLANNING_GENERATORS[ctx.typology];
  if (!gen) return [];
  const cands = gen(ctx);

  const diag = DIAGNOSTICS[ctx.typology];
  for (const c of cands) {
    if (!rectifyBuildings(c)) continue;

    // 矩形化会把斜边上的三角格子丢掉（约 8% 的可建区）。
    // 这些地如果不管，就成了"可建区里没有 program 的空白" —— 2D 上是一片
    // 纸面底色，度量上是 8.3% 无主地。所以补一次残地认领：
    // 大块给 typology 的绿地 program、小块给 residual。
    claimResidual(
      ctx,
      ctx.typology,
      [...c.ground.map((g) => g.surface), ...c.buildings.map((b) => b.footprint)],
      (program, s2, note) => {
        if (s2) c.ground.push({ program, surface: s2, area: surfaceArea(s2), ...(note ? { notes: [note] } : {}) });
      }
    );

    if (diag) {
      const d = diag(ctx, c);
      c.diagnostics = d;
      c.score = evaluateLayout(d, { weights: weightsFor(ctx.typology) }).score;
    }
  }
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands;
}
