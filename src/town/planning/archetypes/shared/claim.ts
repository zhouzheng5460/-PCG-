import type { SiteContext } from '../../core/types';
import type { GroundProgram, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import { type PlanSurface, surfaceArea, surfaceSubtract } from '../../core/surface';

/**
 * 残地认领（R8 Visual Review）。
 *
 * 三个 archetype 原来都是"只认领最大一块残地，其余丢掉"。丢掉的部分在 Scene 里
 * **没有任何 ground program**，2D 上就是一片纸面底色 —— 视觉上是"这块地没规划完"。
 *
 * 实测无主地占比：工业 20.4% / 零售 9.3% / 住宅 0.1%。
 * 工业那块地是**新月形地块 + 矩形仓库**：仓库切不进弓形，两侧留下两条月牙。
 * 这些月牙在真实的工业场地里就是**沿边界的碎石/绿化缓冲带**，本来就该有归属。
 *
 * 分档规则（阈值都以"可建区面积"为单位）：
 *   · ≥ 0.8%  → 给 typology 指定的绿地 program（视觉上是草地，不是噪点）
 *   · ≥ 0.15% → residual（小碎块，落在"残地"这一档更诚实，不假装它是绿地）
 *   · 更小     → 丢弃（画出来只是噪点，还会被碎片惩罚算成"切碎"）
 *
 * 这是**归属问题，不是评分问题**：它不改变任何已生成几何的位置与尺寸，
 * 只是把原本无主的地面标上 program。绿化 program 会进 openSpaceQuality，
 * 所以改完必须回归验证 winner 分布没有整体漂移。
 */
export const RESIDUAL_CLAIM = {
  /** 这一档以上给绿地 */
  green: 0.008,
  /** 这一档以上给 residual，以下丢弃 */
  keep: 0.0015,
};

/** typology → 无主大块该变成什么绿地 program */
const GREEN_PROGRAM: Partial<Record<string, GroundProgram>> = {
  industrial: 'landscape_buffer',
  retail: 'landscape',
  multi_family: 'landscape',
  hotel: 'landscape',
  // 数据中心的 typology 白名单里是 `landscape`（不是 industrial 的 landscape_buffer），
  // 用错 program 会被 D01「只用白名单地面」直接判失败
  data_center: 'landscape',
  single_family: 'landscape',
  // 绿地/公园/公共建筑的残地就是草坪 —— 给 `landscape` 会被 Realizer 再切成网格，
  // 而这三类的绿是**组织出来的**，不能再撒一遍等距块。
  green: 'lawn',
  park: 'lawn',
  civic: 'lawn',
};

/**
 * 把可建区里剩下的地按档认领进 ground 表。
 *
 * @param typology 决定大块残地变成哪种绿地（工业是 landscape_buffer）。
 *   **由 archetype 显式传入，不从 ctx.typology 推导** —— 测试 fixture 里
 *   `use` 字段未必和被测的 typology 一致（DC 的 fixture 用了 `use: 'industrial'`），
 *   靠 ctx 推导会把工业的 landscape_buffer 漏进数据中心的白名单校验里。
 * @param used     已经被占用的面（已生成的 ground + 建筑 footprint）
 * @param add      候选自己的 add 闭包（保证同一套面积计算与命名）
 * @returns 认领了几块、以及无主面积的剩余占比（便于日志与测试）
 */
export function claimResidual(
  ctx: SiteContext,
  typology: string,
  used: PlanSurface[],
  add: (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => void
): { pieces: number; green: number; residual: number; unclaimed: number } {
  const buildable = surfaceArea(ctx.buildableArea);
  const rest = surfaceSubtract([ctx.buildableArea], used);
  const greenProg = GREEN_PROGRAM[typology] ?? 'landscape';

  let green = 0;
  let residual = 0;
  let pieces = 0;
  let unclaimed = 0;

  // 大块先认领：视觉上大块给草地、小块给残地，比反过来自然
  const sorted = [...rest].sort((a, b) => surfaceArea(b) - surfaceArea(a));
  for (const piece of sorted) {
    const a = surfaceArea(piece);
    const share = a / Math.max(1e-6, buildable);
    if (share >= RESIDUAL_CLAIM.green) {
      add(greenProg, piece, '周边缓冲带（原无主地）');
      green += a;
      pieces++;
    } else if (share >= RESIDUAL_CLAIM.keep) {
      add('residual', piece);
      residual += a;
      pieces++;
    } else {
      unclaimed += a;
    }
  }

  return { pieces, green, residual, unclaimed: unclaimed / Math.max(1e-6, buildable) };
}

/** 校验用：可建区里还有多少面积没有归属（0 = 全认领完） */
export function unclaimedShare(ctx: SiteContext, c: SitePlanCandidate): number {
  const used = [...c.ground.map((g) => g.surface), ...c.buildings.map((b) => b.footprint)];
  const rest = surfaceSubtract([ctx.buildableArea], used);
  return rest.reduce((s, p) => s + surfaceArea(p), 0) / Math.max(1e-6, surfaceArea(ctx.buildableArea));
}
