// Planning Realization · R5 Road（PlannedPath → 路面 / 路缘 / 人行道 / 转角）
//
// 一条硬红线：**只 realize centerline，绝不修改 centerline。**
// Planner 已经决定路在哪；这里只决定"这条内部路长什么样"。
//
// 关于"接 road/system.ts"的判断（重要）：
//   `buildRoadNet(model)` 是**城市级**入口 —— 它需要整个 Model、街区拓扑、
//   路口连通性。它不认识"任意一条 centerline"。硬接只能靠伪造 RoadEdge + patchL/R，
//   那会把城市路网的推断逻辑（自动延伸 / 吸附 / 连通）带进来，
//   正好违反"Road System 不能重新规划路线"。
//   所以 R5 在 Realizer 里做 **corridor 构建**（路面 + 路缘 + 人行道 + 转角垫），
//   到 R7 Shadow Mode 再把 corridor 交给城市路网做衔接（那时才有 Model 上下文）。
//
// 不做：转弯半径求解 / swept path / 复杂 spline。90° 网格 + 转角方垫就够早期规划观感。

import { Pt } from '../../core/geom';
import type { MatKey } from '../../scene/palette';
import type { SitePlanCandidate, PlannedPath } from '../planning/core/candidate';
import { surface, surfaceArea, surfaceSubtract, surfaceIntersect, type PlanSurface } from '../planning/core/surface';
import type { RealizationContext, RealizerPart } from './contract';

const U = (m: number) => m / 7;

/** 道路的**实现在语义**（不是 Planner 的 role） */
export type RoadClassReal = 'internal_residential' | 'service' | 'truck' | 'customer_access' | 'campus_service';

export interface RoadProfile {
  class: RoadClassReal;
  /** 车行道宽（米） */
  surfaceM: number;
  /** 路缘宽（米） */
  curbM: number;
  /** 人行道宽（米），0 = 没有 */
  sidewalkM: number;
  mat: MatKey;
  curbMat: MatKey;
  walkMat: MatKey;
}

/**
 * 道路剖面表（Realization Profile）。
 *
 * Planner 只说"这是 internal / service circulation"，具体多宽、有没有人行道在这里定。
 * 这样 Planner 不用携带 curbHeight / laneMarking / lampSpacing 这类渲染参数。
 */
export const ROAD_PROFILES: Record<RoadClassReal, RoadProfile> = {
  internal_residential: { class: 'internal_residential', surfaceM: 7, curbM: 0.4, sidewalkM: 1.5, mat: 'asphalt', curbMat: 'stonePave', walkMat: 'paver' },
  service: { class: 'service', surfaceM: 7.5, curbM: 0.4, sidewalkM: 0, mat: 'asphaltLot', curbMat: 'concrete', walkMat: 'concrete' },
  truck: { class: 'truck', surfaceM: 10, curbM: 0.5, sidewalkM: 0, mat: 'asphaltLot', curbMat: 'concrete', walkMat: 'concrete' },
  customer_access: { class: 'customer_access', surfaceM: 7, curbM: 0.4, sidewalkM: 1.2, mat: 'asphalt', curbMat: 'stonePave', walkMat: 'paver' },
  campus_service: { class: 'campus_service', surfaceM: 6.5, curbM: 0.3, sidewalkM: 0, mat: 'asphaltLot', curbMat: 'concrete', walkMat: 'concrete' },
};

export interface RoadRealizationStat {
  name: string;
  /** 实际消费的中心线（parity 用：与 Planner 的 pts 必须逐点一致） */
  consumedCenterline: Pt[];
  profile: RoadClassReal;
  segments: number;
  lengthM: number;
  junctions: number;
}

export interface RoadRealizeOptions {
  /** Planner 的 role 是 'vehicle' 时用哪个剖面 */
  vehicleClass?: RoadClassReal;
  /** 人行道开关（默认按剖面） */
  sidewalk?: boolean;
  /**
   * 裁剪体（通常是地块）。
   *
   * 内部路的中心线贴着地块边界时，路面条带 / 路缘 / 转角方垫会探出红线 ——
   * 这不是"规划错了"，是 Realizer 忘了裁。不裁的话 Shadow 会把每条边界路
   * 都记成 blocker（实测工业每块 1 条）。
   */
  clip?: PlanSurface;
}

/** 把一块面裁到 clip 里（取最大块） */
function clipSurface(s: Pt[], clip?: PlanSurface): Pt[] | null {
  if (!clip) return s;
  const parts = surfaceIntersect([surface(s)], [clip]);
  if (parts.length === 0) return null;
  const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
  return surfaceArea(best) > 0.01 ? best.outer : null;
}

/**
 * 把 circulation 变成道路面。
 *
 * 输出：
 *   · 车行道（逐段矩形 + 顶点方垫，保证 90° 转角不裂）
 *   · 路缘（两侧窄条）
 *   · 人行道（可选，路缘外侧）
 *
 * 返回的 `corridors` 要拿去从 Ground 里减掉（道路 > 地面，R5.7）。
 */
export function realizeRoads(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart,
  opts: RoadRealizeOptions = {}
): { stats: RoadRealizationStat[]; corridors: PlanSurface[] } {
  const base = ctx.groundY ?? 0.012;
  const stats: RoadRealizationStat[] = [];
  const corridors: PlanSurface[] = [];
  const vehicleClass = opts.vehicleClass ?? 'internal_residential';

  c.circulation.forEach((path, i) => {
    if (path.pts.length < 2) return;
    const profile = path.role === 'truck' ? ROAD_PROFILES.truck : ROAD_PROFILES[vehicleClass];
    const surfW = U(path.width > 0 ? path.width : U(profile.surfaceM) * 7 / 7) * 7; // 以 Planner 的宽度为准
    const halfW = (path.width > 0 ? path.width : U(profile.surfaceM)) / 2;
    void surfW;

    const name = `${c.id}_road_${i}`;
    let len = 0;
    let junctions = 0;

    // ① 车行道：逐段矩形
    for (let k = 0; k + 1 < path.pts.length; k++) {
      const a = path.pts[k];
      const b = path.pts[k + 1];
      len += Pt.distance(a, b);
      const seg = segRect(a, b, path.width > 0 ? path.width : U(profile.surfaceM));
      if (!seg) continue;
      const segClipped = clipSurface(seg, opts.clip);
      if (segClipped) {
        part.surfaces.push({ name: `${name}_surf_${k}`, group: ctx.group, ring: segClipped, mat: profile.mat, y: base + 0.0016 });
        corridors.push(surface(segClipped));
      }
      // 路缘：两侧（垂直于段方向，偏移 halfW + curb/2）
      for (const side of [1, -1] as const) {
        const curb = sideStrip(a, b, halfW, U(profile.curbM), side);
        const c2 = curb ? clipSurface(curb, opts.clip) : null;
        if (c2) part.surfaces.push({ name: `${name}_curb_${k}_${side}`, group: ctx.group, ring: c2, mat: profile.curbMat, y: base + 0.0018 });
      }
      // 人行道（可选）
      if ((opts.sidewalk ?? profile.sidewalkM > 0) && profile.sidewalkM > 0) {
        for (const side of [1, -1] as const) {
          const walk = sideStrip(a, b, halfW + U(profile.curbM), U(profile.sidewalkM), side);
          const w2 = walk ? clipSurface(walk, opts.clip) : null;
          if (w2) part.surfaces.push({ name: `${name}_walk_${k}_${side}`, group: ctx.group, ring: w2, mat: profile.walkMat, y: base + 0.0014 });
        }
      }
    }

    // ② 顶点方垫：90° 转角不留裂缝（loop 的四个角全靠它）
    for (let k = 0; k < path.pts.length; k++) {
      const p = path.pts[k];
      const pad = square(p, path.width > 0 ? path.width : U(profile.surfaceM));
      const p2 = pad ? clipSurface(pad, opts.clip) : null;
      if (!p2) continue;
      part.surfaces.push({ name: `${name}_pad_${k}`, group: ctx.group, ring: p2, mat: profile.mat, y: base + 0.0016 });
      corridors.push(surface(p2));
      junctions++;
    }

    stats.push({
      name,
      consumedCenterline: path.pts.map((p) => new Pt(p.x, p.y)),
      profile: profile.class,
      segments: Math.max(0, path.pts.length - 1),
      lengthM: len * 7,
      junctions,
    });
  });

  return { stats, corridors };
}

/**
 * 把 Ground 从道路走廊里扣掉（R5.7：road surface > ground）。
 *
 * 不做这一步就会出现"前院草地压在路面上"的叠面 —— 和 R3.5 之前的问题同源。
 */
export function subtractRoadCorridor(regions: PlanSurface[], corridors: PlanSurface[]): PlanSurface[] {
  if (corridors.length === 0) return regions;
  const out: PlanSurface[] = [];
  for (const r of regions) {
    const rest = surfaceSubtract([r], corridors).filter((p) => surfaceArea(p) > 0.02);
    out.push(...rest);
  }
  return out;
}

// ---------------------------------------------------------------- 几何

/** 沿 a→b、宽 w 的矩形 */
function segRect(a: Pt, b: Pt, w: number): Pt[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const nx = (-dy / L) * (w / 2);
  const ny = (dx / L) * (w / 2);
  return [
    new Pt(a.x + nx, a.y + ny),
    new Pt(b.x + nx, b.y + ny),
    new Pt(b.x - nx, b.y - ny),
    new Pt(a.x - nx, a.y - ny),
  ];
}

/** 段一侧的偏移条（offset 是条的内边缘到中心线的距离） */
function sideStrip(a: Pt, b: Pt, offset: number, w: number, side: 1 | -1): Pt[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9 || w <= 0) return null;
  const nx = (-dy / L) * side;
  const ny = (dx / L) * side;
  const p = (t: number, d: number) => new Pt(a.x + dx * t + nx * d, a.y + dy * t + ny * d);
  return [p(0, offset), p(1, offset), p(1, offset + w), p(0, offset + w)];
}

/** 转角方垫 */
function square(c: Pt, w: number): Pt[] | null {
  if (w <= 0) return null;
  const h = w / 2;
  return [
    new Pt(c.x - h, c.y - h),
    new Pt(c.x + h, c.y - h),
    new Pt(c.x + h, c.y + h),
    new Pt(c.x - h, c.y + h),
  ];
}
