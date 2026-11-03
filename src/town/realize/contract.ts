// Planning Realization · R0 契约
//
// 一句话：**把已经决定好的 Candidate 忠实造出来，不再做任何规划决策。**
//
// 这一层是单向的：
//   SitePlanCandidate → Realizer → Scene 特征（surfaces / solids / paths）
//
// 三条红线（Phase 3 的"❌ 规划"）：
//   ① 不移动 / 不旋转 / 不缩放 footprint（BuildingRule 只能改高度细分与外观）；
//   ② 不扩大停车区域（Parking Solver 只能在 ParkingRequest.region 里排）；
//   ③ 不重新决定"哪里放什么"（Realizer 里不许出现 area > x 之类的判定）。
//
// 也不修改 Stable Core：这里只 import Candidate 的类型，不回写。

import type { Pt } from '../../core/geom';
import type { MatKey } from '../../scene/palette';
import type { SurfaceFeature, SolidFeature, PathFeature, PropFeature, SolidKind } from '../../scene/types';
import type { GroundProgram, SitePlanCandidate } from '../planning/core/candidate';

/** 一条 Realization 的产物 */
export interface RealizedSitePlan {
  candidateId: string;

  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
  props: PropFeature[];

  /** 各类对象的 id（= Candidate 侧的名字），用于 parity 对拍 */
  buildingIds: string[];
  groundIds: string[];
  roadIds: string[];
  parkingIds: string[];

  warnings: RealizationWarning[];

  /** R5 的道路统计（每段 circulation 一条） */
  roadStats?: {
    name: string;
    consumedCenterline: { x: number; y: number }[];
    profile: string;
    segments: number;
    lengthM: number;
    junctions: number;
  }[];

  /** R4 的车位统计（每块 ParkingRequest 一条）：有多少位、多少条通道、用了什么角度 */
  parkingStats?: {
    requestIndex: number;
    role: string;
    usableArea: number;
    stalls: number;
    aisles: number;
    angleDeg: number;
  }[];
}

export interface RealizationWarning {
  code: string;
  message: string;
  /** 涉及的对象 */
  target?: string;
}

export interface RealizationContext {
  /** 分组前缀（导出到 glTF 时的节点分组） */
  group: string;
  /** 地面基准高度（默认与城市道路一致 0.012） */
  groundY?: number;
  /** 是否生成停车位（Phase 3 第一版不排，留 false） */
  solveParking?: boolean;
  /** 建筑材质覆盖（不覆盖就用 role 的默认值） */
  overrides?: Partial<Record<string, { wall: MatKey; roof: MatKey }>>;
}

/** Ground Program → 材质（R1 的唯一映射表，场景代码里不许再散落 if/else） */
export const GROUND_MATERIAL: Record<GroundProgram, MatKey> = {
  // 工业
  truck_court: 'asphaltLot',
  loading_apron: 'concrete',
  service_lane: 'asphalt',
  employee_parking: 'asphaltLot',
  office_forecourt: 'paver',
  landscape_buffer: 'grass',
  utility_yard: 'gravel',
  // 住宅 / 零售 / 酒店共用
  courtyard: 'stonePave',
  amenity: 'paver',
  entrance_forecourt: 'stonePave',
  pedestrian: 'paver',
  parking: 'asphaltLot',
  landscape: 'grass',
  service: 'asphalt',
  // 酒店
  arrival_court: 'stonePave',
  dropoff: 'asphalt',
  // 数据中心
  mechanical_yard: 'concrete',
  electrical_yard: 'concrete',
  security_buffer: 'grass',
  // 独栋
  front_yard: 'grass',
  rear_yard: 'grassDark',
  driveway: 'concrete',
  community_green: 'grass',
  // 兜底
  residual: 'gravel',
};

/** Ground Program → 相对基准的层高偏移（避免共面 z-fighting，同时保留语义层次） */
export const GROUND_LIFT: Partial<Record<GroundProgram, number>> = {
  truck_court: 0.0004,
  parking: 0.0004,
  employee_parking: 0.0004,
  dropoff: 0.0006,
  driveway: 0.0008,
  service: 0.0004,
  service_lane: 0.0004,
  loading_apron: 0.0004,
  pedestrian: 0.0012,
  entrance_forecourt: 0.001,
  arrival_court: 0.001,
  courtyard: 0.001,
};

/** PlannedBuilding.role → SolidKind（realize 层唯一映射） */
export const ROLE_TO_KIND: Record<string, SolidKind> = {
  warehouse: 'warehouse',
  hall: 'warehouse',
  house: 'house',
  tower: 'tower',
  podium: 'podium',
  office: 'retail',
  amenity: 'podium',
  slab: 'slab',
};

/** 每种 role 的默认墙 / 屋面材质 */
export const ROLE_MATERIAL: Record<string, { wall: MatKey; roof: MatKey }> = {
  warehouse: { wall: 'wallPanel', roof: 'roofMetal' },
  hall: { wall: 'wallPanel', roof: 'roofMetal' },
  house: { wall: 'wallConcrete', roof: 'roofLight' },
  tower: { wall: 'wallGlass', roof: 'roofLight' },
  podium: { wall: 'wallStone', roof: 'roofLight' },
  office: { wall: 'wallPanel', roof: 'roofLight' },
  amenity: { wall: 'wallStone', roof: 'roofLight' },
  slab: { wall: 'wallPanel', roof: 'roofLight' },
};

/** 一条"开口"在场景里的落地宽度（米） */
export const ACCESS_WIDTH_M: Record<string, number> = {
  pedestrian: 3,
  vehicle: 6,
  service: 5,
  truck: 10,
};

export interface RealizerPart {
  name: string;
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
  props: PropFeature[];
  warnings: RealizationWarning[];
}

export function emptyPart(name: string): RealizerPart {
  return { name, surfaces: [], solids: [], paths: [], props: [], warnings: [] };
}
