// Archetype · Retail / Strip（PRD §9）
//
// 第三套语法：**一条店铺 + 一大片顾客停车 + 前场人行 + 后侧服务**。
// 和工业、住宅的区别在于"多条流线并行"：
//
//   顾客：路 → 停车 → 前场 → 店门
//   货车：后侧/侧街 → 服务道 → 卸货
//
// 三个候选（PRD §14 的 candidate 思想）：
//   ret-strip-front-park  停车在临街（PRD 的 strip 典型剖面）
//   ret-strip-rear-park   店铺临街、停车在后（更城市化，街道界面连续）
//   ret-strip-side-park   停车占一侧，店铺 L 形，另一侧做前场
//
// 边界同前：只吃 SiteContext、只吐 SitePlanCandidate。

import { Pt } from '../../../../core/geom';
import { surface, surfaceArea, surfaceIntersect, surfaceSubtract, insideSurface, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedBuilding, PlannedRegion, ParkingRequest, SitePlanCandidate } from '../../core/candidate';
import { retailDiagnostics, SHOP_DEPTH_M } from '../../typologies/retail';
import { evaluateLayout, weightsFor } from '../../core/evaluator';

const U = (m: number) => m / 7;

interface Variant {
  id: string;
  /** 停车放哪：临街 / 后侧 / 一侧 */
  parking: 'front' | 'rear' | 'side';
  /** 店铺是否做成 L 形（临街一条 + 侧向一条） */
  lShop: boolean;
}

/**
 * 三个变体（R7.7 试过加"进深档"作为强度轴，已撤回）。
 *
 * 试过的做法：18 / 23 / 28 m 三档进深 × 三种停车位置 = 9 个候选，想给 Evaluator
 * 一个强度选择。实测不成立 —— 大楼块上三档覆盖率全部落进 16%~26% 的目标带，
 * coverageFit 都是 0.97~1.00，九选一的 margin 中位数只有 **0.03**，
 * 27 块地里 23 块变成 LOW_SELECTION_CONFIDENCE。那是把"分数噪声"当成"候选多样性"。
 *
 * 结论：strip 零售的强度**不是自由参数**，它由地块面宽 × 进深决定；真正的设计
 * 选择只有"停车摆哪儿"。要做出强度轴，得走结构性差异（liner + pad outparcel），
 * 那是独立特性，不属于本轮校准。
 */
const VARIANTS: Variant[] = [
  { id: 'ret-strip-front-park', parking: 'front', lShop: false },
  { id: 'ret-strip-rear-park', parking: 'rear', lShop: false },
  { id: 'ret-strip-side-park', parking: 'side', lShop: true },
];

export function generateRetailStripCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const prim = ctx.primaryFrontage;
  if (!prim) return [];
  const buildable = ctx.buildableArea;
  if (buildable.outer.length < 3) return [];

  const [ea, eb] = prim.parcelEdge;
  const o = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const uDir = norm(new Pt(eb.x - ea.x, eb.y - ea.y));
  let vDir = new Pt(-uDir.y, uDir.x);
  if (!insideSurface(new Pt(o.x + vDir.x * 1.5, o.y + vDir.y * 1.5), buildable)) vDir = new Pt(-vDir.x, -vDir.y);
  const at = (lu: number, lv: number) => new Pt(o.x + uDir.x * lu + vDir.x * lv, o.y + uDir.y * lu + vDir.y * lv);

  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of buildable.outer) {
    const du = (p.x - o.x) * uDir.x + (p.y - o.y) * uDir.y;
    const dv = (p.x - o.x) * vDir.x + (p.y - o.y) * vDir.y;
    if (du < u0) u0 = du;
    if (du > u1) u1 = du;
    if (dv < v0) v0 = dv;
    if (dv > v1) v1 = dv;
  }
  const W = u1 - u0;
  const D = v1 - v0;
  // 零售最小地块：面宽 24 m、进深 34 m（停车 + 前场 + 店铺）
  if (W < U(24) || D < U(34)) return [];

  const out: SitePlanCandidate[] = [];
  for (const v of VARIANTS) {
    const c = buildVariant(ctx, { at, u0, u1, v0, v1, W, D, variant: v });
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = retailDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('retail') }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

interface Frame {
  at: (lu: number, lv: number) => Pt;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  W: number;
  D: number;
  variant: Variant;
}

function buildVariant(ctx: SiteContext, f: Frame): SitePlanCandidate | null {
  const { at, u0, u1, v0, v1, W, D, variant } = f;
  const notes: string[] = [];
  const shopD = U(SHOP_DEPTH_M);
  const foreD = U(8); // 店前人行带
  const laneD = U(7); // 后侧服务道 / 停车通道

  const cut = (lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null => {
    if (lu1 - lu0 < U(2) || lv1 - lv0 < U(2)) return null;
    const rect = surface([at(lu0, lv0), at(lu1, lv0), at(lu1, lv1), at(lu0, lv1)]);
    const parts = surfaceIntersect([rect], [ctx.buildableArea]);
    if (parts.length === 0) return null;
    const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    return surfaceArea(best) > U(1) * U(1) ? best : null;
  };

  const ground: PlannedRegion[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };
  const buildings: PlannedBuilding[] = [];

  // 沿 v 方向切三/四段：取决于是"停车在前"还是"店铺在前"
  let shopV0: number;
  let shopV1: number;
  let parkV0: number;
  let parkV1: number;

  if (variant.parking === 'front') {
    // 路 → 停车 → 前场 → 店铺 → 服务道
    const parkD = Math.max(U(16), D - foreD - shopD - laneD);
    parkV0 = v0;
    parkV1 = Math.min(v1 - foreD - shopD - laneD, v0 + parkD);
    shopV0 = parkV1 + foreD;
    shopV1 = shopV0 + shopD;
    if (parkV1 - parkV0 < U(12)) notes.push('停车进深不足 12 m');
  } else if (variant.parking === 'rear') {
    // 路 → 店铺 → 前场（在店铺与停车之间）→ 停车
    shopV0 = v0;
    shopV1 = v0 + shopD;
    parkV1 = v1;
    parkV0 = Math.max(shopV1 + foreD, v1 - Math.max(U(16), D - shopD - foreD));
  } else {
    // 侧向停车：店铺在临街一侧，停车占东半
    shopV0 = v0;
    shopV1 = v0 + shopD;
    parkV0 = shopV1 + foreD * 0.5;
    parkV1 = v1;
  }

  const shopU0 = u0;
  const shopU1 = variant.parking === 'side' ? u0 + W * 0.62 : u1;
  const shop = cut(shopU0, shopU1, shopV0, Math.min(shopV1, v1));
  if (!shop) return null;
  buildings.push({
    role: 'podium',
    footprint: shop,
    height: U(7), // 单层大盒商业（≈7 m），不做层数
    frontSide: new Pt(vDirOf(f).x, vDirOf(f).y),
    notes: [`店铺进深 ${SHOP_DEPTH_M} m，沿街 ${((shopU1 - shopU0) * 7).toFixed(0)} m`],
  });

  if (variant.lShop) {
    // L 形：侧向再伸一条，挡住侧街视线，形成半围合前场
    const wing = cut(u0 + W * 0.62, u1, shopV0, shopV0 + shopD * 0.7);
    if (wing) buildings.push({ role: 'podium', footprint: wing, height: U(7), notes: ['L 形侧翼'] });
  }

  // 停车（矩形块）
  const parkU0 = variant.parking === 'side' ? u0 + W * 0.66 : u0;
  const parkU1 = u1;
  const park = cut(parkU0, parkU1, parkV0, Math.min(parkV1, v1));
  // 停车不能压店铺（斜边地块上两段可能咬合）
  const parkClean = park
    ? (() => {
        const rest = surfaceSubtract([park], buildings.map((b) => b.footprint));
        if (rest.length === 0) return null;
        const big = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
        return surfaceArea(big) > surfaceArea(park) * 0.15 ? big : null;
      })()
    : null;
  if (!parkClean) notes.push('NO_PARKING：地块过小，停车区被店铺吃光（这类地块应走 PAD 而不是 STRIP）');
  add('parking', parkClean, variant.parking === 'front' ? '临街停车（顾客先停车再进店）' : variant.parking === 'rear' ? '后侧停车' : '侧向停车');

  // 店前人行带（贴着店铺的正面）
  const fore = cut(shopU0, shopU1, variant.parking === 'rear' ? shopV1 : shopV0 - foreD, variant.parking === 'rear' ? shopV1 + foreD : shopV0);
  add('entrance_forecourt', fore, '店前人行带');

  // 从停车到店门的步行通道（零售的核心动线）
  const midU = (shopU0 + shopU1) / 2;
  const walk = cut(midU - U(2.5), midU + U(2.5), Math.min(parkV0, shopV0), Math.max(parkV1, shopV1));
  add('pedestrian', walk, '停车 → 店门步行带');

  // 后侧服务道
  const svcV0 = Math.max(v1 - laneD, shopV1);
  add('service', cut(u0 + W * 0.5, u1, svcV0, v1), '卸货/后勤');

  // 沿街两端绿化
  add('landscape', cut(u0, u0 + W * 0.06, v0, Math.min(v1, v0 + shopD * 0.4)));
  add('landscape', cut(u1 - W * 0.06, u1, v0, Math.min(v1, v0 + shopD * 0.4)));

  // 残地
  const used: PlanSurface[] = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  const rest = surfaceSubtract([ctx.buildableArea], used);
  if (rest.length > 0) {
    const big = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    if (surfaceArea(big) > surfaceArea(ctx.buildableArea) * 0.01) add('residual', big);
  }

  // ---- 出入口：顾客从主街，货车走后侧/侧街
  const edgePoint = (t: number): Pt => {
    const [a, b] = ctx.primaryFrontage!.parcelEdge;
    return new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  };
  const outward = norm(new Pt(o0(f).x - centroidOf(ctx.parcel.outer).x, o0(f).y - centroidOf(ctx.parcel.outer).y));
  const access: PlannedAccess[] = [
    { kind: 'pedestrian', at: edgePoint(0.5), normal: outward, role: 'pedestrian', frontage: 'primary' },
    { kind: 'vehicle', at: edgePoint(0.22), normal: outward, role: 'car', frontage: 'primary' },
  ];
  const svcFace = ctx.serviceFrontage;
  if (svcFace && svcFace !== ctx.primaryFrontage) {
    const [sa, sb] = svcFace.parcelEdge;
    const p = new Pt((sa.x + sb.x) / 2, (sa.y + sb.y) / 2);
    access.push({
      kind: 'service',
      at: p,
      normal: norm(new Pt(p.x - centroidOf(ctx.parcel.outer).x, p.y - centroidOf(ctx.parcel.outer).y)),
      role: 'service',
      frontage: 'service',
    });
  } else {
    // 单面临街：服务口挤在主街另一端，留痕
    access.push({ kind: 'service', at: edgePoint(0.9), normal: outward, role: 'service', frontage: 'primary' });
    notes.push('SHARED_FRONTAGE_SERVICE：没有独立服务临街面，卸货口与顾客口共用主街');
  }

  const parkingRequests: ParkingRequest[] = [];
  if (parkClean) {
    parkingRequests.push({
      role: 'visitor',
      region: parkClean,
      preferredEntry: edgePoint(0.22),
      targetDensity: 'high',
      notes: ['顾客停车：Phase 2 只给区域'],
    });
  }

  return {
    id: variant.id,
    typology: 'retail',
    archetype: 'RET_STRIP',
    buildings,
    ground,
    access,
    parkingRequests,
    circulation: [],
    notes,
  };
}

// ---------------------------------------------------------------- 工具

function o0(f: Frame): Pt {
  return f.at(0, 0);
}

function vDirOf(f: Frame): Pt {
  const p0 = f.at(0, 0);
  const p1 = f.at(0, 1);
  return norm(new Pt(p1.x - p0.x, p1.y - p0.y));
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}
