// Planning Realization · Ground + Building + Access + Circulation 四类 Adapter
//
// 每个 Adapter 都是**纯转译**：读 Candidate 的几何，原样写成 Scene 特征。
// 不许出现 "如果面积小于 x 就合并" / "如果朝向不对就转 90°" 这类判断 ——
// 那是规划决策，Planner 已经做完了。
//
// Parking 的 R4（接 parking.ts 排车位）留了开关：第一版只把 ParkingRequest.region
// 铺成沥青面，不排车位（`ctx.solveParking` 默认 false）。

import { Pt } from '../../core/geom';
import type { SurfaceFeature, SolidFeature, PathFeature } from '../../scene/types';
import type { SitePlanCandidate } from '../planning/core/candidate';
import { surfaceArea, surfaceSubtract, surfaceIntersect, type PlanSurface } from '../planning/core/surface';
import { resolveGroundOwnership } from './ground-ownership';
import {
  GROUND_MATERIAL,
  GROUND_LIFT,
  ROLE_TO_KIND,
  ROLE_MATERIAL,
  TYPOLOGY_APPEARANCE,
  ACCESS_WIDTH_M,
  type RealizationContext,
  type RealizerPart,
} from './contract';

const U = (m: number) => m / 7;

/**
 * R1 · Ground Program → Surface
 *
 * 先过 `resolveGroundOwnership()`：Ground Region 允许语义重叠（车道压前院是正常画法），
 * 但最终地表只能有一层。切割后每个点只有一个所有者，面积之和才等于并集。
 */
export function realizeGround(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart,
  roadCorridors: PlanSurface[] = []
): void {
  const base = ctx.groundY ?? 0.012;
  const owned = resolveGroundOwnership(c.ground);
  if (owned.trimmed > 0 || owned.consumed > 0) {
    part.warnings.push({
      code: 'GROUND_OWNERSHIP_RESOLVED',
      message: `地面切割：${owned.trimmed} 块被裁小、${owned.consumed} 块被完全覆盖`,
    });
  }
  // R5.7：道路 > 地面。先把被道路走廊压到的部分扣掉，避免"前院草地压在路面上"
  // 只对**真的与道路相交**的面做减法：不相交的保持原样，
  // 否则每次 difference 都可能把洞（courtyard / 保留地）丢掉一次
  const pieces =
    roadCorridors.length > 0
      ? owned.regions.flatMap((g) => {
          const hit = surfaceIntersect([g.surface], roadCorridors).some((p) => surfaceArea(p) > 0.01);
          if (!hit) return [g];
          const rest = surfaceSubtract([g.surface], roadCorridors)
            .filter((p) => surfaceArea(p) > 0.02)
            .map((p) => ({ ...g, surface: p, area: surfaceArea(p) }));
          // 带洞的面被切之后洞经常保不住（polygon-clipping 的拓扑退化），留痕待修
          if (g.surface.holes.length > 0 && rest.every((p) => p.surface.holes.length === 0)) {
            part.warnings.push({
              code: 'GROUND_HOLE_LOST',
              message: `${g.program} 的洞在与道路求差时丢失（待修 topology）`,
            });
          }
          return rest;
        })
      : owned.regions;

  pieces.forEach((g, i) => {
    const mat = GROUND_MATERIAL[g.program] ?? 'gravel';
    part.surfaces.push({
      name: `${c.id}_${g.program}_${i}`,
      group: ctx.group,
      ring: g.surface.outer,
      mat,
      y: base + (GROUND_LIFT[g.program] ?? 0),
      ...(g.surface.holes.length > 0 ? { holes: g.surface.holes } : {}),
    });
  });
}

/** R2 · PlannedBuilding → Solid（footprint 原样，只补材质与 kind） */
export function realizeBuildings(c: SitePlanCandidate, ctx: RealizationContext, part: RealizerPart): void {
  // 外观表：优先用 typology 的（住宅暖色 / 商业幕墙 / 工业面板），
  // 没有就退回 role 的默认。同一个 typology 内按序号确定性交替，
  // 让相邻两栋不完全同色 —— 全城一个色调会读成"素白大盒子"。
  const look = ctx.typology ? TYPOLOGY_APPEARANCE[ctx.typology] : undefined;
  c.buildings.forEach((b, i) => {
    const kind = ROLE_TO_KIND[b.role] ?? 'podium';
    const mat =
      ctx.overrides?.[b.role] ??
      (look ? look.walls[i % look.walls.length] : undefined) ??
      ROLE_MATERIAL[b.role] ??
      ROLE_MATERIAL.podium;
    part.solids.push({
      name: `${c.id}_bld_${i}_${b.role}`,
      group: ctx.group,
      ring: b.footprint.outer,
      y0: 0.05,
      h: b.height,
      wallMat: mat.wall,
      roofMat: mat.roof,
      kind,
    });
    // 洞：PlannedBuilding.footprint 也可能带洞（例如围合式 L 形带内院）
    if (b.footprint.holes.length > 0) {
      part.warnings.push({
        code: 'BUILDING_HOLE_IGNORED',
        message: `建筑 ${i} 的轮廓带洞，Solid 目前不支持洞，已按外环生成`,
        target: `${c.id}_bld_${i}`,
      });
    }
  });
}

/** R3 · PlannedAccess → 短带（gate / walkway / apron） */
export function realizeAccess(c: SitePlanCandidate, ctx: RealizationContext, part: RealizerPart): void {
  const base = ctx.groundY ?? 0.012;
  c.access.forEach((a, i) => {
    const w = ACCESS_WIDTH_M[a.kind] ?? 4;
    // 门带：从开口点沿法线向内 6 m（不长到穿进建筑，那由 Planner 的 access 位置决定）
    const len = a.kind === 'pedestrian' ? U(6) : U(9);
    const n = a.normal;
    const p0 = a.at;
    const p1 = new Pt(a.at.x + n.x * len, a.at.y + n.y * len);
    part.paths.push({
      name: `${c.id}_access_${a.role}_${i}`,
      group: ctx.group,
      pts: [p0, p1],
      width: U(w),
      mat: a.kind === 'pedestrian' ? 'paver' : 'asphalt',
      y: base + 0.0014,
    });
  });
}

/** R5（轻量版） · circulation → 场景路径（还没有接 road/system，先成面） */
export function realizeCirculation(c: SitePlanCandidate, ctx: RealizationContext, part: RealizerPart): void {
  const base = ctx.groundY ?? 0.012;
  c.circulation.forEach((p, i) => {
    part.paths.push({
      name: `${c.id}_circ_${p.role}_${i}`,
      group: ctx.group,
      pts: p.pts,
      width: p.width,
      mat: p.role === 'truck' ? 'asphaltLot' : 'asphalt',
      y: base + 0.0006,
    });
  });
}

/** R4（第一版） · ParkingRequest.region → 沥青面；车位留给 parking.ts */
export function realizeParkingRequests(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart
): void {
  const base = ctx.groundY ?? 0.012;
  c.parkingRequests.forEach((r, i) => {
    part.surfaces.push({
      name: `${c.id}_parkreq_${r.role}_${i}`,
      group: ctx.group,
      ring: r.region.outer,
      // 停车请求面走**车位色**（浅灰），和 ground 的 `parking` 底色一致。
      // 它是 Solver 的输入区，铺出来只是"这块地要停车"的底；
      // 通道 / 树岛 / 车位线由 realizeParking 叠在上面。
      // 之前这里用 asphaltLot（深灰）而 parking 底色用浅灰，结果深灰把浅灰盖住 ——
      // 整个停车场读成一片深灰，改哪边材质都看不出来。
      mat: 'concrete',
      y: base + 0.0005,
      ...(r.region.holes.length > 0 ? { holes: r.region.holes } : {}),
    });
    if (ctx.solveParking) {
      // 留位：这里将来调用 parking.ts 的 solveParking(region, {obstacles, entry, dims})
      part.warnings.push({
        code: 'PARKING_NOT_SOLVED',
        message: `车位排布尚未接入 parking.ts（区域已铺好，${(r.region.outer.length)} 点）`,
        target: `${c.id}_parkreq_${r.role}_${i}`,
      });
    }
  });
}

/** 校验：Realizer 不许改几何（R6 parity 的第一道自检） */
export function assertNoGeometryDrift(
  c: SitePlanCandidate,
  part: RealizerPart
): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = [];
  const solids = part.solids.length;
  if (solids !== c.buildings.length) {
    out.push({ code: 'BUILDING_COUNT_MISMATCH', message: `${solids} vs ${c.buildings.length}` });
  }
  // 逐个比对顶点数（原样转译时必然相同）
  for (let i = 0; i < Math.min(solids, c.buildings.length); i++) {
    const a = part.solids[i].ring.length;
    const b = c.buildings[i].footprint.outer.length;
    if (a !== b) out.push({ code: 'BUILDING_RING_CHANGED', message: `#${i} ${a} vs ${b} 点` });
  }
  return out;
}

/** 供 parity 测试用：把 surface 也当作几何核对 */
export function collectGeom(part: RealizerPart): {
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
} {
  return { surfaces: part.surfaces, solids: part.solids, paths: part.paths };
}
