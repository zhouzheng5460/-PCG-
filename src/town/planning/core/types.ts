// Site Planning Core · 契约类型
//
// 这一层只放**纯数据**：可 JSON 序列化、可单测、不 import three / DOM / 渲染。
// 对应 PRD §5 的 SiteContext，以及 §15 的评分 Contract。
//
// 冻结原则（Phase 1）：所有未来可能被第三方库替换的能力（offset / 邻接查询 /
// 核心点 / 寻路）都必须收在 Adapter 或稳定函数后面，业务层只认这里导出的类型。

import type { Pt } from '../../../core/geom';
import type { PlanSurface } from './surface';

/** 六种场地类型 + 兜底（civic / park 这类目前不套专用语法） */
export type SiteTypology =
  | 'industrial'
  | 'multi_family'
  | 'single_family'
  | 'retail'
  | 'hotel'
  | 'data_center'
  | 'generic';

/** 出入口类型（PRD §5 的 access 分组） */
export type AccessKind = 'pedestrian' | 'vehicle' | 'service' | 'truck';

/** 临街面的角色：谁来用它，比"哪条路更近"更重要 */
export type FrontageRole = 'primary' | 'secondary' | 'service' | 'none';

/** 一条与地块相邻的城市道路边（从 RoadEdge 提取，去掉渲染专用字段） */
export interface SiteRoadEdge {
  key: string;
  /** 边的两个端点（世界坐标） */
  a: Pt;
  b: Pt;
  len: number;
  cls: 'arterial' | 'collector' | 'local';
  /** 这条边在地块这一侧的车行道宽度（用来判"能不能开服务口"） */
  carriageSide: number;
  /** 这一侧有没有人行道 */
  sidewalk: number;
  /** 中央分隔带（有分隔带的路不能随便左转开口） */
  median: number;
}

/** 一条被评定过的临街面 */
export interface Frontage {
  role: FrontageRole;
  /** 对应的道路边 */
  edge: SiteRoadEdge;
  /** 综合分（0~1） */
  score: number;
  /** 分项，便于调试和 Phase 2 的评分复用 */
  parts: {
    roadClass: number;
    sharedLength: number;
    visibility: number;
    accessibility: number;
    obstruction: number;
  };
  /** 这条临街面在地块环上的对应边（两端点），供 Access 与之对齐 */
  parcelEdge: [Pt, Pt];
}

/** 一个候选开口 */
export interface AccessPoint {
  kind: AccessKind;
  at: Pt;
  /** 朝外法线（从地块指向道路），开门的朝向 */
  normal: Pt;
  /** 0~1 综合分 */
  score: number;
  /** 分项 */
  parts: {
    roadClass: number;
    intersectionDistance: number;
    frontageRole: number;
    availableWidth: number;
    cornerPenalty: number;
  };
}

/** 邻接地块 */
export interface NeighborContext {
  parcelId: string;
  use: string;
  /** 两个地块之间的最短距离（共享边界时为 0） */
  distance: number;
  /** 共享边界长度（0 = 不共边） */
  sharedBoundaryLength: number;
  relation: 'adjacent' | 'across_road' | 'nearby';
}

/** P1 的唯一产出：把一个地块"读懂" */
export interface SiteContext {
  /** 稳定 id（patchKey） */
  parcelId: string;
  typology: SiteTypology;
  /** 地块本身 */
  parcel: PlanSurface;
  /** 原始用途（LandUse 字符串，便于回溯） */
  use: string;

  roadEdges: SiteRoadEdge[];

  primaryFrontage?: Frontage;
  secondaryFrontage?: Frontage;
  serviceFrontage?: Frontage;

  /** 主轴角（弧度）：取最长临街边 / 地块最长边的方向 */
  orientation: number;

  /** 可建区（退线 + 扣障碍） */
  buildableArea: PlanSurface;

  pedestrianAccessCandidates: AccessPoint[];
  vehicleAccessCandidates: AccessPoint[];
  serviceAccessCandidates: AccessPoint[];
  truckAccessCandidates: AccessPoint[];

  neighbors: NeighborContext[];

  /** 诊断：让 Phase 2 的评分能解释"为什么这个地块长这样" */
  notes: string[];
}

/** 评分分项（PRD §15） */
export interface LayoutDiagnostics {
  accessClarity: number;
  frontageQuality: number;
  buildingRegularity: number;
  groundUsability: number;
  circulationQuality: number;

  deadSpacePenalty: number;
  fragmentationPenalty: number;
  accessConflictPenalty: number;

  /**
   * **核心空间**的质量（0~1）：住宅是 courtyard、酒店是 arrival court、
   * 零售是 plaza、园区是中央绿地。
   *
   * 之所以不叫 courtyardQuality：这是所有 typology 都会有的"场地中心空间"，
   * 只是形状和用途不同。名字留通用，语义由各 typology 的 diagnostics 填。
   */
  spatialCoreQuality?: number;
  /**
   * **人行清晰度**（0~1）：从街 → 入口 → 核心空间，这条序列是否连贯、
   * 有没有被停车区或车流切断。工业权重低，住宅/酒店权重高。
   */
  pedestrianClarity?: number;
  /**
   * **围合度**（0~1）：核心空间的周长里，有多少比例被建筑贴着。
   * 不是越高越好 —— 每个 archetype 有自己的目标区间（前后敞开的院子 0.7 左右，
   * 四面围合 0.95），由 typology 的 diagnostics 折算成 spatialCoreQuality。
   */
  enclosureRatio?: number;
  /**
   * 员工/访客流线 与 货运/服务流线 的分离度（0 = 完全混行，1 = 完全分开）。
   *
   * 这一项对工业是命门，对酒店（落客 vs 后勤）、零售（顾客 vs 卸货）、
   * 数据中心（员工 vs 设备）同样重要，所以放进**通用**诊断而不是各 typology 自己发明。
   */
  serviceSeparation?: number;
  /** 窄条残地的惩罚（住宅/零售特别怕院子被切出一条 2 m 宽的缝） */
  narrowResidualPenalty?: number;
  /** typology 专属分项（停车质量 / 到达感 / 服务可达……） */
  typologyFit?: number;
  parkingQuality?: number;
  openSpaceQuality?: number;
}

export interface LayoutEvaluation {
  score: number;
  diagnostics: LayoutDiagnostics;
  /** 触发扣分的理由，便于面板显示"为什么这个方案差" */
  reasons: string[];
}

/** 权重表：默认一套，typology 可覆盖 */
export interface ScoreWeights {
  accessClarity: number;
  /** 核心空间（庭院 / 广场 / 落客院） */
  spatialCoreQuality: number;
  /** 人行序列清晰度 */
  pedestrianClarity: number;
  serviceSeparation: number;
  typologyFit: number;
  circulationQuality: number;
  buildingRegularity: number;
  groundUsability: number;
  parkingQuality: number;
  frontageQuality: number;
  openSpaceQuality: number;
  overlap: number;
  deadSpace: number;
  fragmentation: number;
  narrowResidual: number;
  accessConflict: number;
}

/** Archetype 候选（P1 只做"够不够格"，不生成布局） */
export interface ArchetypeCandidate {
  archetype: string;
  /** 0~1，仅用于排序，不代表最终方案优劣 */
  fit: number;
  /** 为什么进 / 为什么出，给面板和日志看 */
  reasons: string[];
}
