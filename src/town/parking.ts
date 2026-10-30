// 停车场排布：stripe → clip → score → 择优。
//
// 参考 ucalyptus/ParkSolver 的做法（GeoJSON 场地 → 车位与通道）：
//   1. 候选角度集合里逐个试；每个角度把场地转到局部坐标系，
//   2. 沿一个方向拉平行"排"（每次一排车位 + 一条通道，双面停车就是两排夹一条通道），
//      沿另一个方向按车位宽度拉"列"，得到一个网格状的车位阵列；
//   3. 用场地边界裁剪：整块落在场地内的才算数；
//   4. 打分（车位数），取最优角度；并列时取通道更少的那个。
//
// 与 ParkSolver 的差异：
//   - 不做 ADA / EV / 无障碍车位配比，也不导出 IFC/DXF —— 我们只要车位线和通道几何；
//   - 不做地形/坡度，场地一律按平地处理（城市生成器里地块本身就是平的）；
//   - 用"四角都在界内"代替多边形裁剪，省掉每格一次布尔运算（几百个车位时差一个数量级）。

import { Pt } from '../core/geom';
import { area, intersect } from './zones';
import { u } from '../road/spec';

export interface StallDims {
  /** 车位宽（沿通道方向） */
  w: number;
  /** 车位进深（垂直通道方向） */
  l: number;
  /** 通道宽 */
  aisle: number;
  /** 距场地边界的退让 */
  setback: number;
}

export const CAR_STALL: StallDims = { w: 0.36, l: 0.72, aisle: 0.9, setback: 0.1 };
export const TRUCK_STALL: StallDims = { w: 1.0, l: 2.6, aisle: 2.4, setback: 0.16 };

export interface ParkLayout {
  angle: number;
  /** 每条车位分隔线的线段（起点→终点），已按角度摆好 */
  dividers: [Pt, Pt][];
  /** 车位前缘线（贴着通道那一侧），用来画整齐的封口 */
  fronts: [Pt, Pt][];
  /** 通道多边形（已裁到场地内） */
  aisles: Pt[][];
  count: number;
  /** 通道占场地面积的比例，做"是否像停车场"的判据 */
  aisleRatio: number;
}

export interface ParkOptions extends Partial<StallDims> {
  /** 候选角度（弧度），通常给主朝向及其旋转 */
  angles: number[];
  /** 最多试几种角度（性能保护） */
  maxAngles?: number;
}

interface Box {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

function project(ring: Pt[], angle: number): { ring2: Pt[]; ux: Pt; uy: Pt; box: Box } {
  const ux = new Pt(Math.cos(angle), Math.sin(angle));
  const uy = new Pt(-Math.sin(angle), Math.cos(angle));
  const ring2 = ring.map((p) => new Pt(p.x * ux.x + p.y * ux.y, p.x * uy.x + p.y * uy.y));
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of ring2) {
    u0 = Math.min(u0, p.x);
    u1 = Math.max(u1, p.x);
    v0 = Math.min(v0, p.y);
    v1 = Math.max(v1, p.y);
  }
  return { ring2, ux, uy, box: { u0, u1, v0, v1 } };
}

/** 点是否在环内（先做包围盒快速否） */
function inside(p: Pt, ring: Pt[], box: Box): boolean {
  if (p.x < box.u0 || p.x > box.u1 || p.y < box.v0 || p.y > box.v1) return false;
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y) {
      const t = (p.y - a.y) / (b.y - a.y);
      if (p.x < a.x + t * (b.x - a.x)) hit = !hit;
    }
  }
  return hit;
}

/**
 * 单个角度下的排布：先试"双面停车"（两排夹一通道），
 * 末尾若还剩一条能放下单排的边，再补一排单面停车。
 */
function layoutAt(ring: Pt[], angle: number, dims: StallDims): ParkLayout {
  const { w, l, aisle, setback } = dims;
  const { ring2, ux, uy, box } = project(ring, angle);

  const dividers: [Pt, Pt][] = [];
  const fronts: [Pt, Pt][] = [];
  const aisles: Pt[][] = [];

  const u0 = box.u0 + setback;
  const u1 = box.u1 - setback;
  const vTop = box.v1 - setback;
  let v = box.v0 + setback;

  const world = (u: number, vv: number) => new Pt(ux.x * u + uy.x * vv, ux.y * u + uy.y * vv);

  // 沿 u 方向按车位宽切列
  const cols: number[] = [];
  for (let u = u0; u + w <= u1 + 1e-6; u += w) cols.push(u);

  const emitRow = (vBase: number, front: 'low' | 'high') => {
    for (const u of cols) {
      const quad = [
        new Pt(u, vBase),
        new Pt(u + w, vBase),
        new Pt(u + w, vBase + l),
        new Pt(u, vBase + l),
      ];
      if (!quad.every((p) => inside(p, ring2, box))) continue;
      // 分隔线落在车位的左边界；封口线落在靠通道那一侧
      dividers.push([world(u, vBase), world(u, vBase + l)]);
      const vf = front === 'low' ? vBase : vBase + l;
      fronts.push([world(u, vf), world(u + w, vf)]);
    }
  };

  const emitAisle = (vBase: number) => {
    const rect = [new Pt(u0, vBase), new Pt(u1, vBase), new Pt(u1, vBase + aisle), new Pt(u0, vBase + aisle)];
    const parts = intersect(rect, ring2, 0.25);
    for (const p of parts) if (area(p) > aisle * (u1 - u0) * 0.2) aisles.push(p.map((q) => world(q.x, q.y)));
  };

  const pitch = l * 2 + aisle;
  while (v + l <= vTop) {
    const remaining = vTop - v;
    if (remaining >= pitch) {
      emitRow(v, 'high');
      emitAisle(v + l);
      emitRow(v + l + aisle, 'low');
      v += pitch;
    } else if (remaining >= l + aisle + 0.4) {
      // 只够一排 + 通道
      emitRow(v, 'high');
      emitAisle(v + l);
      v += l + aisle;
    } else {
      // 只剩一条单排的位置（贴着对面边界停车）
      emitRow(vTop - l, 'high');
      v = vTop;
    }
  }

  const lawnArea = Math.abs(area(ring2));
  const aisleArea = aisles.reduce((s, r) => s + area(r), 0);
  return {
    angle,
    dividers,
    fronts,
    aisles,
    count: dividers.length,
    aisleRatio: lawnArea > 0 ? aisleArea / lawnArea : 0,
  };
}

/**
 * 求解最优停车排布。传进来的 ring 应该是"可建区"（已经内缩过的地块）。
 */
export function solveParking(ring: Pt[], opts: ParkOptions): ParkLayout | null {
  if (ring.length < 3) return null;
  const dims: StallDims = {
    w: opts.w ?? CAR_STALL.w,
    l: opts.l ?? CAR_STALL.l,
    aisle: opts.aisle ?? CAR_STALL.aisle,
    setback: opts.setback ?? CAR_STALL.setback,
  };

  const bbArea = Math.abs(area(ring));
  if (bbArea < dims.w * dims.l * 2) return null;

  const angles = opts.angles.slice(0, opts.maxAngles ?? 8);
  const pref = angles[0] ?? 0;
  const HALF = Math.PI / 2;
  /** 与地块主朝向的夹角，折到 0~45°（转 90° 是同一套车位，不该被罚） */
  const devOf = (a: number): number => {
    let d = Math.abs(((a - pref) % HALF + HALF) % HALF);
    if (d > HALF / 2) d = HALF - d;
    return d;
  };
  /** 斜列最多打到 15% 折扣：多塞几个位不值得把车场转歪 */
  const scoreOf = (lay: ParkLayout): number => lay.count * (1 - 0.15 * Math.min(1, devOf(lay.angle) / (Math.PI / 4)));

  let best: ParkLayout | null = null;
  let bestScore = -Infinity;
  for (const a of angles) {
    const lay = layoutAt(ring, a, dims);
    if (lay.count === 0) continue;
    const s = scoreOf(lay);
    if (
      s > bestScore ||
      // 分数相同：通道更少的方案更规整
      (Math.abs(s - bestScore) < 1e-6 && best && lay.aisles.length < best.aisles.length)
    ) {
      best = lay;
      bestScore = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 需求与容量
//
// **停车是建筑的配套设施，不是"把剩下的地占满"。**
// 旧做法是 Parcel − Building − Road = Parking：地块里楼一放，剩下的全铺车位，
// 于是停车场成了城市里占比最高的地面类型，整块地读起来就是"一个大停车场"。
//
// 现在的顺序反过来：
//   AvailableGround → ParkingCandidate → 只消费"需求"那么多 → 余下进广场 / 绿地 / 服务院
// 需求由用途定（占用地比例），再被三道闸门封顶：
//   ① 硬上限（住宅/公共 18%、商业 22%、工业 15%、停车场地块 70%）；
//   ② 建筑支撑比：停车面积 ≤ 建筑占地 × 1.0~2.0（小楼配小车场）；
//   ③ 单块停车坪上限（城市约 2200 m²），超了就拆成两簇，中间留绿化/步道分隔。
// 这样停车不再是主体，也不会出现"一栋三层小楼配一个 3000 m² 车场"。

export type ParkContext = 'urban' | 'industrial' | 'rural';

/**
 * 停车配比三档。用户只控这三档，不暴露具体数值（§16）。
 * 每档是**两个倍率**：[目标面积倍率, 簇数倍率]。
 * 面积倍率只作用于"需求"，不放开硬上限。
 */
export type ParkLevel = 'low' | 'normal' | 'high';

export const PARK_LEVEL: Record<ParkLevel, { area: number; clusters: number }> = {
  low: { area: 0.65, clusters: 0.75 },
  normal: { area: 1.0, clusters: 1.0 },
  high: { area: 1.25, clusters: 1.2 },
};

/** 1 单位² = 49 m²（1 单位 ≈ 7 m） */
export const AREA_PER_M2 = 49;

/** 平方米 → 单位² */
export function uArea(meters2: number): number {
  return meters2 / AREA_PER_M2;
}

/** 单位² → 平方米 */
export function areaM2(units2: number): number {
  return units2 * AREA_PER_M2;
}

/**
 * 用途 → 停车需求占用地面积的比例。取规范区间中位（§2）：
 * 住宅 8~15%、办公 10~18%、商业 12~20%、工业 8~15%、仓储 5~10%、公共 8~15%。
 */
const DEMAND_RATIO: Record<string, number> = {
  residential: 0.10,
  commercial: 0.155,
  cbd: 0.15,
  civic: 0.115,
  industrial: 0.115,
  // 停车场地块本身就是配套设施，例外处理
  parking: 0.62,
};

/** 用途 → 硬上限比例（§3，任何倍率都不能突破） */
const DEMAND_CAP: Record<string, number> = {
  residential: 0.18,
  commercial: 0.22,
  cbd: 0.22,
  civic: 0.18,
  industrial: 0.15,
  parking: 0.70,
};

export interface ParkingDemand {
  /** 目标停车面积（单位²） */
  target: number;
  /** 硬上限（单位²） */
  cap: number;
  /** 单块停车坪上限（单位²） */
  maxLot: number;
  /** 建议簇数（1~2） */
  clusters: number;
  /** 绿化岛 / 分隔带占停车坪的比例 */
  islandRatio: number;
  /** 入口前禁停带长度（单位），0 表示不设 */
  entryClear: number;
}

/**
 * 算一个地块的停车需求。
 *
 * 三条闸门依次收紧：硬上限 → 建筑支撑比 → 需求面积；倍率只乘在需求上。
 * 目标面积**不含随机项**，所以换 seed 只会改位置 / 朝向 / 簇形状，
 * 不会让 `parkingTargetArea` 抖动（§17）。
 *
 * @param use        土地用途
 * @param parcelArea 用地面积（单位²）
 * @param supportArea 建筑占地合计（单位²）
 * @param ctx        城市语境（工业 / 乡村的单块坪更大、比例更低，§14）
 * @param level      三档配比，默认 normal
 */
export function parkingDemand(
  use: string,
  parcelArea: number,
  supportArea: number,
  ctx: ParkContext = 'urban',
  level: ParkLevel = 'normal'
): ParkingDemand {
  const lv = PARK_LEVEL[level] ?? PARK_LEVEL.normal;
  const capRatio = DEMAND_CAP[use] ?? 0.18;

  // ② 建筑支撑比（§4）：停车面积 ≤ 建筑占地 × 0.6~1.8
  //    小楼配小车场，楼越大允许配的车场越大，但增长慢于楼。
  //    例外：本身就没有建筑的地块（独立停车场 / 待建地）不受这条约束，
  //    否则 supportArea≈0 会把额度压到 4%，停车场地块上反而一个车位都排不出来。
  const mult = supportArea < 1.5 ? 1.0 : supportArea < 4 ? 1.35 : 1.8;
  const supportCap =
    supportArea < 0.05 ? Number.POSITIVE_INFINITY : Math.max(supportArea * mult, parcelArea * 0.04);

  // ① 硬上限：用途比例，但至少给建筑支撑比留出空间
  const cap = Math.min(parcelArea * capRatio, Math.max(supportCap, parcelArea * 0.04));

  // ③ 需求：用途比例 × 档位倍率
  const ratio = (DEMAND_RATIO[use] ?? 0.12) * lv.area;
  const target = Math.max(0, Math.min(parcelArea * ratio, cap));

  // ④ 单块坪上限（§5）：城市 2200 m²、工业 3500 m²、乡村 1200 m²
  const maxLotM2 = ctx === 'industrial' ? 3500 : ctx === 'rural' ? 1200 : 2200;
  const maxLot = uArea(maxLotM2);

  // ⑤ 簇数（§6）：preferred 1、最多 2
  const nominal = target > maxLot * 1.25 ? 2 : 1;
  const clusters = Math.max(1, Math.min(2, Math.round(nominal * lv.clusters)));

  // ⑥ 绿化岛（§10）：车位 >20 或面积 >1000 m² 时留 5%~12%
  const islandRatio = target > uArea(1000) ? 0.08 : target > uArea(550) ? 0.05 : 0;

  // ⑦ 入口前禁停带（§8）：8~20 m，按地块进深收一下
  const entryClear = Math.min(u(20), Math.max(u(8), Math.sqrt(parcelArea) * 0.35));

  return { target, cap, maxLot, clusters, islandRatio, entryClear };
}
