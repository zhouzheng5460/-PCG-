// Archetype · Hotel / Gurban（PRD §10 / 用户 §3 的 H-A~H-D）
//
// 空间语法：**到达序列**。
//
//   ROAD ───────────────
//     ↓ vehicle entry
//   ┌──────────────┐
//   │  DROP-OFF    │   ← 落客带（贴街 12 m）
//   │  ARRIVAL     │   ← 到达院落
//   └──────┬───────┘
//          ↓ lobby anchor
//   ████████████████
//   ████  HOTEL ████
//   ████████████████
//     amenity / guest parking / service
//
// 四个候选：
//   hotel-gurban-centered     到达院居中（baseline）
//   hotel-gurban-side-dropoff 落客在一侧（窄 frontage 用）
//   hotel-gurban-court        酒店 L 形 + amenity 半围合到达院（逼 spatialCoreQuality）
//   hotel-gurban-rear-parking 停车退到建筑后方（TestFit 总图感）
//
// 边界同前：只吃 SiteContext、只吐 SitePlanCandidate。

import { Pt } from '../../../../core/geom';
import { surface, surfaceArea, surfaceIntersect, surfaceSubtract, insideSurface, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedBuilding, PlannedRegion, ParkingRequest, SitePlanCandidate } from '../../core/candidate';
import { hotelDiagnostics, DROPOFF_MIN_DEPTH_M } from '../../typologies/hotel';
import { evaluateLayout, weightsFor } from '../../core/evaluator';
import { claimResidual } from '../shared/claim';

const U = (m: number) => m / 7;

interface Variant {
  id: string;
  /** 到达院宽 / 进深占可建区的比例 */
  arrivalW: number;
  arrivalD: number;
  /** 酒店进深占可建区进深 */
  hotelD: number;
  /** 酒店沿面宽方向的偏移（0 = 居中，正 = 偏一侧） */
  hotelShift: number;
  /** 酒店是否做 L 形（侧翼围合到达院） */
  lHotel: boolean;
  /** 落客带是否贴一侧（side-dropoff 变体） */
  sideDrop: boolean;
  park: 'side' | 'rear';
}

const VARIANTS: Variant[] = [
  { id: 'hotel-gurban-centered', arrivalW: 0.46, arrivalD: 0.26, hotelD: 0.42, hotelShift: 0, lHotel: false, sideDrop: false, park: 'side' },
  { id: 'hotel-gurban-side-dropoff', arrivalW: 0.34, arrivalD: 0.3, hotelD: 0.44, hotelShift: -0.1, lHotel: false, sideDrop: true, park: 'side' },
  { id: 'hotel-gurban-court', arrivalW: 0.5, arrivalD: 0.3, hotelD: 0.38, hotelShift: 0, lHotel: true, sideDrop: false, park: 'rear' },
  { id: 'hotel-gurban-rear-parking', arrivalW: 0.58, arrivalD: 0.2, hotelD: 0.4, hotelShift: 0, lHotel: false, sideDrop: false, park: 'rear' },
];

export function generateHotelGurbanCandidates(ctx: SiteContext): SitePlanCandidate[] {
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
  // 酒店最小地块：面宽 30 m、进深 46 m（落客 + 到达院 + 酒店进深）
  if (W < U(30) || D < U(46)) return [];

  const out: SitePlanCandidate[] = [];
  for (const v of VARIANTS) {
    const c = buildVariant(ctx, { at, u0, u1, v0, v1, W, D, variant: v });
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = hotelDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('hotel') }).score;
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
  const dropDepth = Math.max(U(DROPOFF_MIN_DEPTH_M), D * 0.08);
  const arrivalD = Math.max(dropDepth + U(6), D * variant.arrivalD);
  const hotelD = Math.max(U(24), D * variant.hotelD);
  const laneD = U(7);

  if (arrivalD + hotelD + laneD > D) {
    notes.push(`进深不足（到达 ${(arrivalD * 7).toFixed(0)} m + 酒店 ${(hotelD * 7).toFixed(0)} m + 服务 ${(laneD * 7).toFixed(0)} m > ${(D * 7).toFixed(0)} m）`);
    return null;
  }

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

  // ---- 到达院（居中或让一侧给落客带）
  const arrivalW = W * variant.arrivalW;
  const aU0 = variant.sideDrop ? u0 + W * 0.06 : u0 + (W - arrivalW) / 2;
  const aU1 = aU0 + arrivalW;
  const aV0 = v0;
  const aV1 = v0 + arrivalD;

  const arrival = cut(aU0, aU1, aV0, aV1);
  if (!arrival) return null;
  add('arrival_court', arrival, variant.sideDrop ? '侧向到达院' : '居中到达院');

  // 落客带：到达院贴街那一条
  const drop = cut(aU0, aU1, aV0, v0 + dropDepth);
  add('dropoff', drop, `落客带 ${(dropDepth * 7).toFixed(0)} m 深`);

  // ---- 酒店主体（可 L 形）
  const hD = hotelD;
  const hV0 = aV1;
  const hV1 = Math.min(v1 - laneD, hV0 + hD);
  const hU0 = Math.max(u0, aU0 + variant.hotelShift * W - W * 0.05);
  const hU1 = Math.min(u1, aU1 + variant.hotelShift * W + W * 0.05);
  const hotel = cut(hU0, hU1, hV0, hV1);
  if (!hotel) return null;

  const buildings: PlannedBuilding[] = [
    {
      role: 'tower',
      footprint: hotel,
      height: U(36), // ≈ 10~12 层（不做真实层数）
      frontSide: new Pt(-vDirOf(f).x, -vDirOf(f).y),
      notes: [`酒店主体 ${((hU1 - hU0) * 7).toFixed(0)}×${((hV1 - hV0) * 7).toFixed(0)} m`],
    },
  ];

  if (variant.lHotel) {
    // L 形侧翼：沿到达院一侧再伸一条，和 amenity 一起半围合
    const wing = cut(aU1, Math.min(u1, aU1 + W * 0.3), aV1, Math.min(v1 - laneD, aV1 + hD * 0.55));
    if (wing) buildings.push({ role: 'podium', footprint: wing, height: U(12), notes: ['L 形侧翼（围合到达院）'] });
  }

  // ---- Lobby anchor：酒店临院的中点，向院内偏 1.5 单位（保证落在院里）
  const lobbyAt = at((hU0 + hU1) / 2, hV0 - U(1.5));

  // ---- Amenity（到达院一侧）+ 沿街绿化
  add('amenity', cut(aU1 + W * 0.02, Math.min(u1, aU1 + W * 0.26), aV0, aV1), '大堂吧/配套');
  add('landscape', cut(u0, Math.min(u0 + W * 0.08, aU0), aV0, aV1), '沿街绿化（左）');
  add('entrance_forecourt', cut((hU0 + hU1) / 2 - W * 0.08, (hU0 + hU1) / 2 + W * 0.08, hV0 - U(4), hV0), '入口前厅');

  // ---- 停车：侧 / 后，**不占主街正面**
  let park: PlanSurface | null = null;
  if (variant.park === 'rear') {
    park = cut(u0 + W * 0.04, u1, hV1, v1 - laneD);
  } else {
    park = cut(Math.min(u1 - W * 0.3, aU1 + W * 0.28), u1, aV0, Math.min(v1 - laneD, hV1));
  }
  // 停车不能压酒店 / 到达院
  if (park) {
    const rest = surfaceSubtract([park], [...buildings.map((b) => b.footprint), arrival]);
    park = rest.length > 0 ? rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b)) : null;
    if (park && surfaceArea(park) < U(8) * U(8)) park = null;
  }
  add('parking', park, variant.park === 'rear' ? '后侧停车' : '侧向停车');

  // ---- 后勤：后侧一条，避开主街正面
  const svc = cut(u0 + W * 0.55, u1, v1 - laneD, v1);
  add('service', svc, '后勤/BOH（布草、垃圾、供货）');

  // ---- 残地：全部认领
  claimResidual(ctx, 'hotel', [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)], add);

  // ---- 出入口：客人走主街（进入落客带），后勤走后侧/侧街
  const edgePoint = (t: number): Pt => {
    const [a, b] = ctx.primaryFrontage!.parcelEdge;
    return new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  };
  const outward = norm(new Pt(o0(f).x - centroidOf(ctx.parcel.outer).x, o0(f).y - centroidOf(ctx.parcel.outer).y));

  // 车行口正对到达院（落客带的中心）
  const carT = (aU0 + aU1) / 2;
  const carAt = edgePoint((carT / Math.max(0.1, u1 - u0)) * 1);
  const access: PlannedAccess[] = [
    { kind: 'vehicle', at: carAt, normal: outward, role: 'car', frontage: 'primary' },
    { kind: 'pedestrian', at: carAt, normal: outward, role: 'pedestrian', frontage: 'primary' },
    { kind: 'pedestrian', at: lobbyAt, normal: new Pt(-vDirOf(f).x, -vDirOf(f).y), role: 'main_lobby', frontage: 'primary' },
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
    // 单面临街：后勤口压在主街另一端，如实标注
    const p = edgePoint(0.95);
    access.push({ kind: 'service', at: p, normal: outward, role: 'service', frontage: 'primary' });
    notes.push('SHARED_HOTEL_SERVICE_FRONTAGE：没有独立服务临街面，后勤口与客人共用主街');
  }

  const parkingRequests: ParkingRequest[] = [];
  if (park) {
    parkingRequests.push({
      role: 'guest',
      region: park,
      preferredEntry: carAt,
      targetDensity: 'medium',
      notes: ['客人停车：Phase 2 只给区域'],
    });
  }

  // 到达路径（只是候选里已知的序列，不是 AccessGraph）
  const dropRegion = ground.find((g) => g.program === 'dropoff');
  const circulation = dropRegion
    ? [{ pts: [carAt, centroidOf(dropRegion.surface.outer), lobbyAt], width: U(6), role: 'vehicle' as const }]
    : [];

  return {
    id: variant.id,
    typology: 'hotel',
    archetype: 'HOTEL_GURBAN',
    buildings,
    ground,
    access,
    parkingRequests,
    circulation,
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
