// Typology · Hotel（PRD §10 / Freeze §6）
//
// 第四套语法：**到达序列**。
//   工业 测"前后勤"，住宅 测"围合核心"，零售 测"停车+店面"，酒店 测"到达序列"。
//
// 真正要成立的关系是两串：
//   Road → Guest Vehicle → Drop-off → Lobby → Hotel
//   Service Road → Service Access → BOH/Loading → Hotel Rear
// 两条不能混。`accessClarity` 在酒店里不是"有入口"，而是**序列是否成立**。

import type { LayoutDiagnostics, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea, pointInRing } from '../core/surface';
import { Pt } from '../../../core/geom';

/** Phase 2 允许的酒店地面程序（只加 arrival_court / dropoff，不加 porte_cochere / pool_deck） */
export const HOTEL_GROUND_WHITELIST: GroundProgram[] = [
  'arrival_court',
  'dropoff',
  'entrance_forecourt',
  'pedestrian',
  'parking',
  'amenity',
  'landscape',
  'service',
  'residual',
];

/** 落客区最小进深（米）：一辆车停着下人 + 一条通过车道 */
export const DROPOFF_MIN_DEPTH_M = 12;
/** 大堂到落客点的最大步行距离（米） */
export const LOBBY_MAX_WALK_M = 45;

/**
 * 酒店诊断。
 *
 * 没有新增诊断字段（Freeze 要求）："到达感"被拆成三块已有诊断——
 *   accessClarity（序列是否成立）+ spatialCoreQuality（到达院落质量）+ pedestrianClarity（落客→大堂）。
 */
export function hotelDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotArea = Math.max(1e-6, surfaceArea(ctx.parcel));
  const hotel = c.buildings[0];
  const arrival = c.ground.find((g) => g.program === 'arrival_court');
  const dropoff = c.ground.find((g) => g.program === 'dropoff');
  const parking = c.ground.find((g) => g.program === 'parking');
  const amenity = c.ground.find((g) => g.program === 'amenity');
  const service = c.ground.find((g) => g.program === 'service');
  const residual = c.ground.find((g) => g.program === 'residual');

  const car = c.access.find((a) => a.role === 'car');
  const lobby = c.access.find((a) => a.role === 'main_lobby');
  const svcAcc = c.access.find((a) => a.role === 'service');

  // ① 到达序列：车行口 → 落客 → 大堂，三段齐全 + 落客到大堂不被停车/后勤切断
  let sequence = 0;
  let walkBlocked = 0;
  let walkDistM = 0;
  if (car && dropoff) sequence += 0.35;
  if (dropoff && lobby) {
    sequence += 0.35;
    const a = centroid(dropoff.surface.outer);
    const b = lobby.at;
    walkDistM = Math.hypot(a.x - b.x, a.y - b.y) * 7;
    const steps = 10;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const p = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      if (parking && pointInRing(p, parking.surface.outer)) walkBlocked++;
      else if (service && pointInRing(p, service.surface.outer)) walkBlocked++;
    }
    if (walkBlocked === 0) sequence += 0.2;
    else if (walkBlocked <= 2) sequence += 0.08;
  }
  if (arrival && lobby && pointInRing(lobby.at, arrival.surface.outer)) sequence += 0.1;
  const accessClarity = clamp01(sequence);

  // ② 到达院落质量（spatialCoreQuality 在酒店是"arrival court / amenity core"）
  let spatialCoreQuality = 0;
  if (arrival) {
    const b = bbox(arrival.surface.outer);
    const wM = (b.maxX - b.minX) * 7;
    const dM = (b.maxY - b.minY) * 7;
    const size = clamp01(Math.min(wM, dM) / (DROPOFF_MIN_DEPTH_M * 2.2));
    const aspect = Math.max(wM, dM) / Math.max(1, Math.min(wM, dM));
    const shape = clamp01(1 - (aspect - 1) / 2.5);
    const anchored = lobby && pointInRing(lobby.at, arrival.surface.outer) ? 0.35 : 0;
    spatialCoreQuality = clamp01(0.35 * size + 0.3 * shape + anchored);
  }

  // ③ 落客 → 大堂的步行清晰度（以"距离 + 是否被切断"为准）
  let pedestrianClarity = 0;
  if (dropoff && lobby) {
    const near = clamp01(1 - Math.max(0, walkDistM - 10) / (LOBBY_MAX_WALK_M * 2));
    const clean = clamp01(1 - walkBlocked / 9);
    pedestrianClarity = clamp01(0.55 * near + 0.45 * clean);
  }

  // ④ 客货分离（酒店是第二个最需要它的类型：行李车 / 布草车 / 垃圾车 vs 客人）
  const sharedFrontage = !!car && !!svcAcc && car.frontage === svcAcc.frontage;
  const sepDist = car && svcAcc ? Math.hypot(car.at.x - svcAcc.at.x, car.at.y - svcAcc.at.y) : 0;
  const serviceSeparation = !svcAcc ? 0.55 : sharedFrontage ? (sepDist > 5 ? 0.55 : 0.28) : 1;

  // ⑤ 其余通用项
  const buildingRegularity = hotel ? rectness(hotel.footprint.outer) : 0;
  const has = (p: GroundProgram) => c.ground.some((g) => g.program === p);
  const key: GroundProgram[] = ['arrival_court', 'dropoff', 'parking', 'service'];
  const groundUsability = key.filter(has).length / key.length;

  const parkRatio = parking ? parking.area / lotArea : 0;
  // 酒店停车 8%~30% 合理；停车占掉主街正面会重罚（在 accessConflictPenalty 里）
  const parkingQuality = clamp01(parkRatio < 0.05 ? parkRatio / 0.05 * 0.4 : 1 - Math.max(0, parkRatio - 0.3) / 0.25);

  const frontageQuality = ctx.primaryFrontage ? ctx.primaryFrontage.score : 0.2;
  const openSpaceQuality = clamp01(((arrival?.area ?? 0) + (amenity?.area ?? 0)) / lotArea / 0.2);

  const deadSpacePenalty = clamp01((residual ? residual.area / lotArea : 0) / 0.2);
  const tiny = c.ground.filter((g) => g.program !== 'residual' && g.area / lotArea < 0.012).length;
  const fragmentationPenalty = clamp01(tiny / 3);
  const narrowResidualPenalty = residual ? clamp01((3 - shortestSideM(residual.surface.outer)) / 3) : 0;

  // 冲突：停车占了主街正面（酒店最忌讳"路 → 大停车场 → 酒店"），或客货口叠在一起
  let accessConflictPenalty = 0;
  if (sharedFrontage && sepDist < 5) accessConflictPenalty = 0.7;
  if (parking && ctx.primaryFrontage) {
    const [pa, pb] = ctx.primaryFrontage.parcelEdge;
    const mid = new Pt((pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
    if (pointInRing(mid, parking.surface.outer)) accessConflictPenalty = Math.max(accessConflictPenalty, 0.9);
  }

  return {
    accessClarity,
    spatialCoreQuality,
    pedestrianClarity,
    serviceSeparation,
    typologyFit: clamp01(0.5 * accessClarity + 0.3 * spatialCoreQuality + 0.2 * (dropoff ? 1 : 0)),
    circulationQuality: clamp01(0.5 + (dropoff ? 0.3 : 0) + (c.circulation.length > 0 ? 0.2 : 0)),
    buildingRegularity,
    groundUsability,
    parkingQuality,
    frontageQuality,
    openSpaceQuality,
    deadSpacePenalty,
    fragmentationPenalty,
    narrowResidualPenalty,
    accessConflictPenalty,
  };
}

/** 白名单校验 */
export function hotelProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return c.ground.map((g) => g.program).filter((p) => !HOTEL_GROUND_WHITELIST.includes(p));
}

// ---------------------------------------------------------------- 工具

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function bbox(ring: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function rectness(ring: Pt[]): number {
  const b = bbox(ring);
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

function shortestSideM(ring: Pt[]): number {
  const b = bbox(ring);
  return Math.min(b.maxX - b.minX, b.maxY - b.minY) * 7;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
