// Single-Family 私有中间层（Archetype 内部 DTO，**不是 Core Contract**）
//
// 前五种 typology 都是「一个 Parcel → 一个 SitePlan」；
// 独栋住宅第一次是「一个 Parcel → 内部路网 → 多个宅地 → 多栋住宅」。
//
// 这一层只活在 archetypes/singlefamily/ 里面，Core 完全不知道 `ResidentialLot` 是什么。
// 最终仍然翻译成冻结的 `SitePlanCandidate`（`buildings` 本来就是数组）。

import { Pt } from '../../../../core/geom';
import type { PlanSurface } from '../../core/surface';

/** 内部道路（不当作 Ground Program：它是 circulation，最后交给 road realization） */
export interface InternalRoad {
  id: string;
  /** 中心线 */
  centerline: Pt[];
  width: number;
  /** 这条路服务哪些宅地（生成后回填，用于校验 frontage） */
  lotIds: string[];
}

/** 一块宅地 */
export interface ResidentialLot {
  id: string;
  surface: PlanSurface;
  /** 临街边（沿内部路或外部街），两端点 */
  frontage: [Pt, Pt];
  /** 临的是哪条路（内部路 id 或 'public' 表示直接面外部街道） */
  roadId: string;
  /** 宅地内可建区（前院退让之后的房子落位范围） */
  buildableArea: PlanSurface;
  /** 朝向（沿 frontage 的方向角） */
  orientation: number;
  /** 私有评分（0~1），不进入 Core Diagnostic，折算进 typologyFit / groundUsability */
  quality: number;
  /** 临街宽度（米） */
  frontageM: number;
  /** 进深（米） */
  depthM: number;
}

/** 一个街区的细分结果 */
export interface SubdivisionPlan {
  skeleton: string;
  roads: InternalRoad[];
  lots: ResidentialLot[];
  openSpace: PlanSurface[];
  /** 拒收原因（空 = 成立） */
  notes: string[];
}

/**
 * 多边形化接口（PRD §6 的 Adapter 位置）。
 *
 * 现在用"直接构造矩形 + 布尔裁剪"就够，因为第一版是 Detached **Grid**：
 * 路是正交的、宅地是矩形。等做 Curvilinear / Cul-de-sac 时再换
 * `@turf/polygonize`（装不上不阻塞）。
 */
export interface LotPolygonizer {
  polygonize(lines: Pt[][], clip: PlanSurface): PlanSurface[];
}

export const gridPolygonizer: LotPolygonizer = {
  // 正交网格下，"线 → 面"可以退化成"把线当矩形带去裁"，
  // 这里保留接口形态，等真正需要 noded graph 再换实现
  polygonize(_lines: Pt[][], clip: PlanSurface): PlanSurface[] {
    return [clip];
  },
};
