import type { SiteContext } from '../../core/types';
import type { GroundProgram, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import { type PlanSurface, surfaceArea, surfaceSubtract, geometryFailures } from '../../core/surface';

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
export const SETBACK_PROGRAM: Partial<Record<string, GroundProgram>> = {
  industrial: 'landscape_buffer',
};
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

/**
 * 认领**红线退线带**：`parcel − buildableArea`。
 *
 * ## 为什么必须认领
 *
 * 全城审计（D1，0.5 单位采样）发现 **17.4% 的城内面积只有底板、没有任何功能面**。
 * 其中最大的一块就是这条带子：地块是按"每条边各自的退线"内缩出可建区的，
 * 而 archetype 只往可建区里铺东西 —— 可建区和红线之间那一圈（路口转角处更宽）
 * 从头到尾没人管。底板按用途上色之后它"看起来像绿化"，但语义上是空的：
 * 既不是道路，也不是绿地，也不是保留地。
 *
 * 这条带子在真实总图上有明确身份：**红线内的绿化/铺装退线**。
 * 所以在 Candidate 出口统一认领成 typology 对应的绿地 program。
 *
 * 上限 45%：超过说明这个地块的退线比可建区还大（畸形片），那种情况认领了
 * 也只是把一块畸形面刷上颜色，不如留着让审计看见。
 */
export function claimSetback(
  ctx: SiteContext,
  typology: string,
  add: (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => void
): { pieces: number; area: number } {
  const parcelA = surfaceArea(ctx.parcel);
  const buildA = surfaceArea(ctx.buildableArea);
  if (parcelA < 1e-6) return { pieces: 0, area: 0 };
  const fail0 = geometryFailures.subtract;
  const raw = surfaceSubtract([ctx.parcel], [ctx.buildableArea]);
  if (geometryFailures.subtract > fail0) return { pieces: 0, area: 0 };
  // `surfaceSubtract` 失败时会**原样返回被减数**（返回整个 parcel）。那种情况下
  // 认领出来的"退线带"其实是整块地，会跟所有功能面重叠 —— 审计里表现为
  // "重叠率从 5% 涨到 39%"。所以这里必须挡一道：返回块有任何一个 ≥ 95% parcel
  // 就整体放弃。
  const ring = raw.filter((p) => surfaceArea(p) > 0.6 && surfaceArea(p) < parcelA * 0.95);
  if (!ring.length) return { pieces: 0, area: 0 };
  const area = ring.reduce((a, p) => a + surfaceArea(p), 0);
  if (area > parcelA * 0.45) return { pieces: 0, area: 0 };
  const prog = SETBACK_PROGRAM[typology] ?? 'landscape';
  let n = 0;
  for (const p of ring) {
    add(prog, p, '红线退线带（绿化/铺装退线）');
    n++;
  }
  void buildA;
  return { pieces: n, area };
}
