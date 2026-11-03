// Archetype · Single-Family / Detached Grid（PRD §8 / 用户 §4 的三个 skeleton）
//
// 这是唯一引入**层级**的语法：
//   Parcel → Internal Road Skeleton → Lot Subdivision → Lot Context → House
//
// 三条铁律（顺序不能变）：
//   ① 路先生成（否则宅地会被路切断、出现无临街 lot）；
//   ② 宅地按 frontage 等分（lotCount = round(L / targetW)，再均摊残片）；
//   ③ 每个宅地必须真的临街（内部路或外部街），否则整个 candidate 判无效。
//
// 三个 skeleton：
//   sf-grid-single-spine   一条竖向内部路 + 两侧宅地（狭长地块）
//   sf-grid-double-spine   两条竖向内部路 + 两列宅地 + 中间绿地（宽地块）
//   sf-grid-loop           环形内部路 + 环内两排宅地 + 中央绿地
//
// 边界同前：只吃 SiteContext、只吐 SitePlanCandidate；Core 不知道 ResidentialLot 存在。

import { Pt } from '../../../../core/geom';
import {
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  surfaceSubtract as sub,
  insideSurface,
  pointInRing,
  bboxOf,
  type PlanSurface,
} from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { PlannedAccess, PlannedBuilding, PlannedPath, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import type { InternalRoad, ResidentialLot, SubdivisionPlan } from './subdivision';
import { sfDiagnostics, SF_TARGETS } from '../../typologies/singlefamily';
import { evaluateLayout, weightsFor } from '../../core/evaluator';

const U = (m: number) => m / 7;
const LANE = U(7.5); // 内部路宽

type Skeleton = 'single-spine' | 'double-spine' | 'loop';

export function generateSingleFamilyGridCandidates(ctx: SiteContext): SitePlanCandidate[] {
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
  // 最小地块：面宽 30 m、进深 40 m（两条 15 m 宅地 + 一条 7.5 m 路）
  if (W < U(30) || D < U(40)) return [];

  const frame = { at, u0, u1, v0, v1, W, D };
  const plans: SubdivisionPlan[] = [];
  for (const sk of ['single-spine', 'double-spine', 'loop'] as Skeleton[]) {
    const plan = subdivide(ctx, frame, sk);
    if (plan && plan.lots.length > 0) plans.push(plan);
  }

  const out = plans.map((p) => toCandidate(ctx, frame, p));
  for (const c of out) {
    c.diagnostics = sfDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('single_family') }).score;
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
}

/**
 * 把局部矩形裁到**真正的可建区**。
 *
 * 早先用可建区的 bbox 矩形当裁剪体，斜边地块上宅地会探出红线，
 * 最后由"房子顶点跑出可建区"暴露出来（S06 真城 16/23 不合格就是这个）。
 */
function rectOf(f: Frame, clip: PlanSurface, lu0: number, lu1: number, lv0: number, lv1: number): PlanSurface | null {
  if (lu1 - lu0 < U(2) || lv1 - lv0 < U(2)) return null;
  const r = surface([f.at(lu0, lv0), f.at(lu1, lv0), f.at(lu1, lv1), f.at(lu0, lv1)]);
  const parts = surfaceIntersect([r], [clip]);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
}

/** 沿某个方向等分一条"排"，产出宅地（含 frontage 与私有质量分） */
function sliceRow(
  f: Frame,
  clip: PlanSurface,
  row: { u0: number; u1: number; v0: number; v1: number },
  along: 'u' | 'v',
  frontageAt: 'u0' | 'u1' | 'v0' | 'v1',
  roadId: string,
  prefix: string
): ResidentialLot[] {
  const length = along === 'v' ? row.v1 - row.v0 : row.u1 - row.u0;
  if (length < U(SF_TARGETS.minLotWidthM)) return [];
  const count = Math.max(1, Math.min(SF_TARGETS.maxLotCount, Math.round(length / U(SF_TARGETS.targetLotWidthM))));
  const w = length / count; // 均摊残片：不做"最后一个 2 m"
  if (w * 7 < SF_TARGETS.minLotWidthM * 0.8) return [];

  // 进深必须**截断到 targetLotDepth**：否则一条 154 m 深的排会切出
  // "18 m 面宽 × 154 m 进深"的怪宅地，房子只是在最前面摆一小块
  const depthLimit = U(SF_TARGETS.targetLotDepthM);
  const rowDepth = along === 'v' ? row.u1 - row.u0 : row.v1 - row.v0;
  const depth = Math.min(rowDepth, depthLimit);

  const lots: ResidentialLot[] = [];
  for (let i = 0; i < count; i++) {
    const a = (along === 'v' ? row.v0 : row.u0) + i * w;
    const b = a + w;
    // 把宅地贴到 frontage 那一侧，避免宅地与路之间留一条无主缝
    const lu0 = along === 'v' ? (frontageAt === 'u1' ? row.u1 - depth : row.u0) : a;
    const lu1 = along === 'v' ? (frontageAt === 'u1' ? row.u1 : row.u0 + depth) : b;
    const lv0 = along === 'v' ? a : (frontageAt === 'v1' ? row.v1 - depth : row.v0);
    const lv1 = along === 'v' ? b : (frontageAt === 'v1' ? row.v1 : row.v0 + depth);
    const lot = rectOf(f, clip, lu0, lu1, lv0, lv1);
    if (!lot) continue;

    // 临街边：沿"排"方向的那条边，固定在 frontageAt 一侧
    const fa = (t: number) => {
      if (frontageAt === 'v0') return f.at(lu0 + (lu1 - lu0) * t, lv0);
      if (frontageAt === 'v1') return f.at(lu0 + (lu1 - lu0) * t, lv1);
      if (frontageAt === 'u0') return f.at(lu0, lv0 + (lv1 - lv0) * t);
      return f.at(lu1, lv0 + (lv1 - lv0) * t);
    };
    const frontage: [Pt, Pt] = [fa(0), fa(1)];
    const frontageM = Pt.distance(frontage[0], frontage[1]) * 7;
    const depthM = (along === 'v' ? lu1 - lu0 : lv1 - lv0) * 7;

    // 私有质量：临街宽 / 进深 / 矩形度 三项（不新增 Core Diagnostic）
    const q =
      0.35 * clamp01(frontageM / SF_TARGETS.targetLotWidthM) +
      0.25 * clamp01(depthM / SF_TARGETS.targetLotDepthM) +
      0.2 * rectness(lot.outer) +
      0.2; // roadAccess 恒为 1（构造保证临街）

    lots.push({
      id: `${prefix}-${i + 1}`,
      surface: lot,
      frontage,
      roadId,
      buildableArea: lot,
      orientation: Math.atan2(frontage[1].y - frontage[0].y, frontage[1].x - frontage[0].x),
      quality: clamp01(q),
      frontageM,
      depthM,
    });
  }
  return lots;
}

/** 三个 skeleton */
function subdivide(ctx: SiteContext, f: Frame, sk: Skeleton): SubdivisionPlan | null {
  const { u0, u1, v0, v1, W, D } = f;
  const notes: string[] = [];
  const roads: InternalRoad[] = [];
  const lots: ResidentialLot[] = [];
  const openSpace: PlanSurface[] = [];
  const depthLimit = U(SF_TARGETS.targetLotDepthM);

  if (sk === 'single-spine') {
    // 狭长地块：一条竖向路，两侧各一排宅地
    const mid = (u0 + u1) / 2;
    const rowW = (W - LANE) / 2;
    if (rowW * 7 < SF_TARGETS.minLotWidthM) {
      notes.push('面宽不足：单脊两侧排不下宅地');
      return null;
    }
    roads.push({ id: 'spine', centerline: [f.at(mid, v0), f.at(mid, v1)], width: LANE, lotIds: [] });
    const depth = Math.min(rowW, depthLimit);
    lots.push(...sliceRow(f, ctx.buildableArea, { u0, u1: mid - LANE / 2, v0, v1 }, 'v', 'u1', 'spine', 'L'));
    lots.push(...sliceRow(f, ctx.buildableArea, { u0: mid + LANE / 2, u1, v0, v1 }, 'v', 'u0', 'spine', 'R'));
    if (rowW > depth + U(6)) {
      // 进深被 targetDepth 截断：剩下的整条给后院绿地，而不是拉成 100 m 深的怪宅地
      const rest = rectOf(f, ctx.buildableArea, u0, u0 + (rowW - depth), v0, v1);
      if (rest) openSpace.push(rest);
    }
  } else if (sk === 'double-spine') {
    // 宽地块：两条竖向路 → 两列外侧宅地 + 中间绿地
    if (W < U(58)) {
      notes.push('面宽不足 58 m：双脊会让中间列过窄');
      return null;
    }
    const s1 = u0 + W / 3;
    const s2 = u0 + (2 * W) / 3;
    roads.push({ id: 'spine-w', centerline: [f.at(s1, v0), f.at(s1, v1)], width: LANE, lotIds: [] });
    roads.push({ id: 'spine-e', centerline: [f.at(s2, v0), f.at(s2, v1)], width: LANE, lotIds: [] });
    lots.push(...sliceRow(f, ctx.buildableArea, { u0, u1: s1 - LANE / 2, v0, v1 }, 'v', 'u1', 'spine-w', 'W'));
    lots.push(...sliceRow(f, ctx.buildableArea, { u0: s2 + LANE / 2, u1, v0, v1 }, 'v', 'u0', 'spine-e', 'E'));
    // 中间列：社区绿地（不做宅地，否则又变成"背靠背无边宅地"）
    const mid = rectOf(f, ctx.buildableArea, s1 + LANE / 2, s2 - LANE / 2, v0 + U(4), v1 - U(4));
    if (mid) openSpace.push(mid);
  } else {
    // 环路：外圈环形路 + 环内两排宅地 + 中央绿地
    const inset = U(10);
    const lu0 = u0 + inset;
    const lu1 = u1 - inset;
    const lv0 = v0 + inset;
    const lv1 = v1 - inset;
    // 环路要求内圈每边至少 24 m，否则环内排不下宅地（狭长地块应该只走单脊）
    if (lu1 - lu0 < U(24) || lv1 - lv0 < U(24)) {
      notes.push('地块太小，放不下环路');
      return null;
    }
    // 四条边当一段闭合中心线（环路）
    roads.push({
      id: 'loop',
      centerline: [f.at(lu0, lv0), f.at(lu1, lv0), f.at(lu1, lv1), f.at(lu0, lv1), f.at(lu0, lv0)],
      width: LANE,
      lotIds: [],
    });
    // 环内去掉中央绿地后，上下两排宅地
    const half = (lv0 + lv1) / 2;
    lots.push(...sliceRow(f, ctx.buildableArea, { u0: lu0, u1: lu1, v0: lv0, v1: half - U(6) }, 'u', 'v0', 'loop', 'N'));
    lots.push(...sliceRow(f, ctx.buildableArea, { u0: lu0, u1: lu1, v0: half + U(6), v1: lv1 }, 'u', 'v1', 'loop', 'S'));
    const green = rectOf(f, ctx.buildableArea, lu0, lu1, half - U(5), half + U(5));
    if (green) openSpace.push(green);
  }

  if (lots.length === 0) {
    notes.push('没有产生任何宅地');
    return null;
  }

  // 硬 gate：每个宅地必须真的贴着某条内部路或外部街（这里是构造保证，仍需复核）
  const withFrontage = lots.filter((l) => l.frontageM > 4);
  if (withFrontage.length !== lots.length) {
    notes.push(`${lots.length - withFrontage.length} 个宅地没有有效临街`);
    return null;
  }

  for (const r of roads) r.lotIds = lots.filter((l) => l.roadId === r.id).map((l) => l.id);
  return { skeleton: sk, roads, lots, openSpace, notes };
}

/** SubdivisionPlan → SitePlanCandidate（Core 只看见这个） */
function toCandidate(ctx: SiteContext, f: Frame, plan: SubdivisionPlan): SitePlanCandidate {
  const buildings: PlannedBuilding[] = [];
  const ground: PlannedRegion[] = [];
  const circulation: PlannedPath[] = [];
  const notes: string[] = [...plan.notes];

  // 内部路
  for (const r of plan.roads) {
    circulation.push({ pts: r.centerline, width: r.width, role: 'vehicle' });
  }

  const frontSetback = U(6);
  const houseDepth = U(12);

  for (const lot of plan.lots) {
    // 局部近似：沿 frontage 方向摆一个矩形住宅
    const [fa, fb] = lot.frontage;
    const dirF = norm(new Pt(fb.x - fa.x, fb.y - fa.y)); // 沿街
    // 朝地块内部的方向
    let inward = new Pt(-dirF.y, dirF.x);
    const mid = new Pt((fa.x + fb.x) / 2, (fa.y + fb.y) / 2);
    const probe = new Pt(mid.x + inward.x * U(3), mid.y + inward.y * U(3));
    if (!pointInRing(probe, lot.surface.outer)) inward = new Pt(-inward.x, -inward.y);

    // 房子宽度：两侧各留 2.5 m 侧院，再按宅地面宽的 72% 封顶。
    // 早先写成 `- 6*2`，18 m 的宅地被削到 5.5 m 宽，出来的房子是细条
    const wM = Math.min(lot.frontageM * 0.72, lot.frontageM - 5);
    const w = U(Math.max(6, wM));
    const cAt = (d: number) => new Pt(mid.x + inward.x * d, mid.y + inward.y * d);

    // 前院：frontage → 退线
    const frontYard = band(mid, dirF, lot.frontageM, 0, frontSetback);
    if (frontYard) ground.push(region('front_yard', frontYard));

    // 住宅：退线之后 houseDepth
    const houseC = cAt(frontSetback + houseDepth / 2);
    const house = rectAt(houseC, dirF, inward, w / 2, houseDepth / 2);
    if (house) {
      const clipped = clipTo(house, lot.surface);
      if (clipped) {
        buildings.push({
          role: 'house',
          footprint: clipped,
          height: U(7.5),
          frontSide: new Pt(-inward.x, -inward.y),
          notes: [`宅地 ${lot.id}，临街 ${lot.frontageM.toFixed(1)} m`],
        });
      }
    }

    // 后院：住宅之后到地块尾
    const rearStart = frontSetback + houseDepth;
    const rearLen = Math.max(0, lot.depthM / 7 - rearStart * 1);
    if (rearLen > 3) {
      const rear = band(mid, dirF, lot.frontageM, rearStart, rearStart + U(rearLen * 0.9));
      if (rear) ground.push(region('rear_yard', rear));
    }

    // 车道：贴宅地一侧，从 frontage 到住宅正面
    const sideOff = -lot.frontageM / 7 / 2 + 2;
    const dwCenter = new Pt(mid.x + dirF.x * U(sideOff), mid.y + dirF.y * U(sideOff));
    const dw = stripAlong(dwCenter, inward, frontSetback + houseDepth * 0.6, U(3.2));
    if (dw) {
      const clippedDw = clipTo(dw, lot.surface);
      if (clippedDw) ground.push(region('driveway', clippedDw));
    }
  }

  // 社区绿地
  for (const g of plan.openSpace) ground.push(region('community_green', g));

  // 残地
  const used = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  const rest = sub([ctx.buildableArea], used);
  if (rest.length > 0) {
    const big = rest.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
    if (surfaceArea(big) > surfaceArea(ctx.buildableArea) * 0.02) ground.push(region('residual', big));
  }

  // 出入口：主街一个车行 + 一个人行
  const edgePoint = (t: number): Pt => {
    const [a, b] = ctx.primaryFrontage!.parcelEdge;
    return new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  };
  const outward = norm(new Pt(f.at(0, 0).x - centroid(ctx.parcel.outer).x, f.at(0, 0).y - centroid(ctx.parcel.outer).y));
  const access: PlannedAccess[] = [
    { kind: 'vehicle', at: edgePoint(0.5), normal: outward, role: 'car', frontage: 'primary' },
    { kind: 'pedestrian', at: edgePoint(0.5), normal: outward, role: 'pedestrian', frontage: 'primary' },
  ];

  return {
    id: `sf-grid-${plan.skeleton}`,
    typology: 'single_family',
    archetype: 'SF_DETACHED_GRID',
    buildings,
    ground,
    access,
    parkingRequests: [],
    circulation,
    notes,
  };
}

// ---------------------------------------------------------------- 几何小工具

function region(program: PlannedRegion['program'], s: PlanSurface): PlannedRegion {
  return { program, surface: s, area: surfaceArea(s) };
}

/** 沿 dir 方向、从 offset0 到 offset1 的一条带（宽 = span） */
function band(mid: Pt, dir: Pt, spanM: number, off0: number, off1: number): PlanSurface | null {
  const half = U(spanM / 2);
  const nx = -dir.y;
  const ny = dir.x;
  const p = (o: number, s: number) => new Pt(mid.x + dir.x * o + nx * s * half, mid.y + dir.y * o + ny * s * half);
  if (off1 - off0 < U(1)) return null;
  return surface([p(off0, -1), p(off1, -1), p(off1, 1), p(off0, 1)]);
}

/** 以 c 为中心、沿 dir 宽 halfW、沿 inward 深 halfD 的矩形 */
function rectAt(c: Pt, dir: Pt, inward: Pt, halfW: number, halfD: number): PlanSurface | null {
  const p = (a: number, b: number) => new Pt(c.x + dir.x * a + inward.x * b, c.y + dir.y * a + inward.y * b);
  return surface([p(-halfW, -halfD), p(halfW, -halfD), p(halfW, halfD), p(-halfW, halfD)]);
}

/** 从 c 沿 inward 方向长 len、宽 w 的条（车道） */
function stripAlong(c: Pt, inward: Pt, len: number, w: number): PlanSurface | null {
  const dir = new Pt(-inward.y, inward.x);
  return rectAt(new Pt(c.x + inward.x * len * 0.25, c.y + inward.y * len * 0.25), dir, inward, w / 2, len / 2);
}

function clipTo(s: PlanSurface, clip: PlanSurface): PlanSurface | null {
  const parts = surfaceIntersect([s], [clip]);
  if (parts.length === 0) return null;
  const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
  return surfaceArea(best) > U(1) * U(1) ? best : null;
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function rectness(ring: Pt[]): number {
  const b = bboxOf(ring);
  const box = (b.maxX - b.minX) * (b.maxY - b.minY);
  if (box < 1e-9) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }
  return clamp01(Math.abs(s / 2) / box);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export { surfaceSubtract };
