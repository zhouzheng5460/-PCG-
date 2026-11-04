import { Pt, distToSegment } from '../../../core/geom';
import type { SiteContext, SiteTypology } from '../core/types';
import { surface, surfaceArea, surfaceIntersect, bboxOf, type PlanSurface } from '../core/surface';
import type { SiteRoadEdge } from '../core/types';

/**
 * 沿街切地块（Planner 自己的 subdivision）。
 *
 * ## 为什么 Planner 要自己切
 *
 * legacy 的 `planParcels` 已经在切地块了，但那套地块只喂给 legacy 的建筑生成，
 * Planner 拿到的仍然是**整个 patch（122 m 街区）**。于是 Planner 眼里一块地
 * 只有一个主体量，四周全是空地 —— 覆盖率 P50 只有 18~21%，用户看到的就是
 * "大片空地 + 几栋楼"。
 *
 * 这里按规划实务的 subdivision 规则重切一遍，让 Planner 拿到**地块级**的输入。
 *
 * ## 规则（来自 subdivision 规范，多份一致）
 *
 * | 规则 | 取值 | 出处 |
 * |---|---|---|
 * | 面宽:进深 | **1:2 最佳**，允许 1:1~1:5 | South Burlington / Maitland / Vanuatu |
 * | 住宅进深上限 | 面宽的 1~3 倍 | Heidelberg |
 * | 最小面宽 | 450 m²+ 地块 **12.5 m**；300~450 m² → 8 m | Maitland |
 * | 地块形状 | **矩形**，侧边垂直街道、后边平行街道 | South Burlington |
 * | 临街 | **每块必须临街**（街道/共享庭院/≥6 m 通道） | 多份 |
 * | 大街区 | 应容纳**两排地块**（two tiers of lots） | Haysville / Heidelberg |
 * | 街角地块 | 需额外宽度（两侧都要退线） | Haysville |
 *
 * ## 做法
 *
 * 1. 取 primary frontage 的方向为 u、指向内部为 v；
 * 2. 沿 u 按目标面宽切条（面宽按 typology 给，见 FRONTAGE_M）；
 * 3. 进深方向：地块进深 > 1.7×maxDepth 时切**两排**，排间留 6 m 巷道
 *    （规范里的 two tiers + alley）；
 * 4. 每块与可建区求交，短边 < 8 m 或面积 < 200 m² 的丢掉（碎渣）；
 * 5. 后排不直接临街 —— 它临巷道，巷道接 primary frontage。
 *
 * 注意：这里切出来的是**规划意义上的地块**，不是渲染用的面。它只用来给
 * 每个地块生成一个 SiteContext。
 */
export interface SubdivideOpts {
  /** 目标面宽（米） */
  frontageM?: number;
  /** 进深上限（米） */
  maxDepthM?: number;
  /** 排间巷道宽（米） */
  alleyM?: number;
}

/**
 * 各 typology 的目标面宽 / 进深（米）。
 *
 * ## 一个关键取舍：不是所有类型都该切
 *
 * 实测：把住宅街区切成 22×40 m 的地块之后，**只有 6% 能生成方案**。
 * 原因不是切分错了，是**形态尺度不匹配**：
 * 围合式住宅的院子最小 18×16 m、四边 bar 各深 14~18 m，
 * 一个组团至少要 60 m 见方 —— 22×40 m 装不下。
 *
 * 所以这里的数值要按"这类建筑的最小可行地块"给，而不是按规范下限给：
 *
 * | typology | 面宽 | 进深 | 形态 |
 * |---|---|---|---|
 * | single_family | 16 | 32 | 一栋独栋 + 前后院（规范 12.5 m 下限之上） |
 * | retail | 26 | 38 | 一栋店铺（22 m 进深）+ 后场 |
 * | multi_family | **70** | **70** | 一个围合组团（院子 + 四边 bar） |
 * | hotel | 60 | 60 | 塔楼 + 裙房 + 落客院 |
 * | industrial | 90 | 80 | 厂房 + 前后场（本身就是街区尺度） |
 * | data_center | 90 | 80 | 单厅 + 设备场 |
 *
 * 换成一句话：**只有独栋和零售适合切到"地块级"，住宅/酒店/工业的语法
 * 本身就是街区级的**。住宅块要"多"，靠的是"一个街区多个围合组团"，
 * 不是"一个街区切成一堆小地块"。
 */
export const SUBDIVIDE: Record<string, { frontageM: number; maxDepthM: number }> = {
  // 住宅：12.5 m 是 450 m²+ 地块的规范下限；排屋 8 m、独栋 18~25 m。
  // 取 22 m —— 一个 22×40 m ≈ 880 m² 的地块，正好是"一栋 6 层板楼 + 院子"。
  multi_family: { frontageM: 70, maxDepthM: 70 },
  single_family: { frontageM: 16, maxDepthM: 32 },
  // 商业：临街要宽（店面），进深 38 m 是"店铺 22 m + 后场 16 m"
  retail: { frontageM: 26, maxDepthM: 38 },
  hotel: { frontageM: 60, maxDepthM: 60 },
  // 工业：厂房要 55 m 进深，面宽 60 m（一个标准厂房 3600 m²）
  industrial: { frontageM: 90, maxDepthM: 80 },
  data_center: { frontageM: 90, maxDepthM: 80 },
};

/**
 * 把一块 SiteContext 的 parcel 切成若干地块。
 *
 * 返回的每块都是 PlanSurface，**都落在原可建区内**。
 * 如果切不动（地块太小 / 形状太碎），原样返回一块（整块当地块）。
 */
export function subdivideByFrontage(ctx: SiteContext, opts: SubdivideOpts = {}): PlanSurface[] {
  const rule = SUBDIVIDE[ctx.typology as string] ?? { frontageM: 24, maxDepthM: 40 };
  const frontageU = (opts.frontageM ?? rule.frontageM) / 7;
  const maxDepthU = (opts.maxDepthM ?? rule.maxDepthM) / 7;
  const alleyU = (opts.alleyM ?? 6) / 7;

  const area = ctx.buildableArea;
  if (surfaceArea(area) < (200 / 49) * 2) return [area];

  const f = ctx.primaryFrontage;
  if (!f) return [area];

  const [ea, eb] = f.parcelEdge;
  const len = Math.hypot(eb.x - ea.x, eb.y - ea.y);
  if (len < 1e-6) return [area];

  // u = 沿街方向，v = 指向地块内部（用可建区质心判方向）
  const ux = (eb.x - ea.x) / len;
  const uy = (eb.y - ea.y) / len;
  const bb = bboxOf(area.outer);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const mid = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  let vx = -uy;
  let vy = ux;
  if ((cx - mid.x) * vx + (cy - mid.y) * vy < 0) {
    vx = -vx;
    vy = -vy;
  }

  // 把可建区投到 (u, v) 坐标系里，拿到范围
  const proj = area.outer.map((p) => ({
    u: (p.x - ea.x) * ux + (p.y - ea.y) * uy,
    v: (p.x - ea.x) * vx + (p.y - ea.y) * vy,
  }));
  const u0 = Math.min(...proj.map((p) => p.u));
  const u1 = Math.max(...proj.map((p) => p.u));
  const v0 = Math.min(...proj.map((p) => p.v));
  const v1 = Math.max(...proj.map((p) => p.v));
  const depth = v1 - v0;
  const width = u1 - u0;
  if (depth < maxDepthU * 0.5 || width < frontageU * 0.5) return [area];

  // 切几排：进深超过 1.7 倍上限就切两排（规范要求大街区容两排地块）
  const rows = depth > maxDepthU * 1.7 ? 2 : 1;
  const alley = rows === 2 ? alleyU : 0;
  const rowDepth = (depth - alley) / rows;
  // 切几列：面宽按目标值等分，至少 1 列
  const cols = Math.max(1, Math.round(width / frontageU));
  const colW = width / cols;

  const at = (uu: number, vv: number) => new Pt(ea.x + ux * uu + vx * vv, ea.y + uy * uu + vy * vv);

  const out: PlanSurface[] = [];
  for (let r = 0; r < rows; r++) {
    const vLo = v0 + r * (rowDepth + alley);
    const vHi = vLo + rowDepth;
    for (let c = 0; c < cols; c++) {
      const uLo = u0 + c * colW;
      const uHi = uLo + colW;
      // 每列之间留 0 缝（相邻地块共边是正常的），只在排间留巷道
      const rect = surface([at(uLo, vLo), at(uHi, vLo), at(uHi, vHi), at(uLo, vHi)]);
      const parts = surfaceIntersect([rect], [area]);
      if (parts.length === 0) continue;
      const big = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
      const a2 = surfaceArea(big) * 49;
      if (a2 < 200) continue; // 碎渣
      out.push(big);
    }
  }

  // 一块都切不出来就退回整块
  return out.length > 0 ? out : [area];
}

/** 这个 typology 是否值得切（太小或形状太碎就不切） */
export function shouldSubdivide(typology: SiteTypology, buildableArea: number): boolean {
  void typology;
  // 可建区 < 1500 m² 就是一块地，切了只出碎渣
  return buildableArea * 49 > 1500;
}


/**
 * 给切出来的一块地找它自己临的道路边。
 *
 * ## 为什么不能沿用街区的 edges
 *
 * 街区（patch）的 `roadEdges` 是整个街区四面临的街。切出来的地块里，
 * **只有前排**真的贴着那些街；后排跟每一条街都隔着 20~40 m，
 * `resolveFrontages` 的 3 单位匹配阈值一个都命中不了 → `primaryFrontage` 为空
 * → archetype 全部失败（实测 257 块地只成功 15 块）。
 *
 * ## 巷道
 *
 * subdivision 规范里"每块必须临街"允许三种：街道 / 共享庭院 / ≥6 m 通道。
 * 后排地块走的就是第三条 —— 所以这里给它**造一条巷道的虚拟 edge**
 *（沿地块最长边、`cls: 'local'`、没有人行道）。有了它，后排才是一个
 * 合规的地块，而不是"没有出入口的空地"。
 */
export function edgesForPiece(piece: PlanSurface, ctx: SiteContext): SiteRoadEdge[] {
  const ring = piece.outer;
  const hit = ctx.roadEdges.filter((e) =>
    ring.some((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const mid = new Pt((p.x + q.x) / 2, (p.y + q.y) / 2);
      return distToSegment(mid, e.a, e.b) < 3;
    })
  );
  if (hit.length > 0) return hit;

  // 后排：沿最长边造巷道
  let best: [Pt, Pt] = [ring[0], ring[1 % ring.length]];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (Pt.distance(a, b) > Pt.distance(best[0], best[1])) best = [a, b];
  }
  return [
    {
      key: `${ctx.parcelId}#alley`,
      a: best[0],
      b: best[1],
      len: Pt.distance(best[0], best[1]),
      cls: 'local',
      // 巷道没有人行道，车行道也窄 —— 后排地块按"临一条服务性小路"读
      carriageSide: 0.45,
      sidewalk: 0,
      median: 0,
    },
  ];
}
