// Planning Realization · R4 Parking（ParkingRequest → 现有 parking.ts）
//
// 架构红线：**Solver 没有权利修改 region。**
//   request.region − obstacles = 真正可停的面积，Solver 只在这个结果里排。
// 这样"为了多塞几个车位就往外扩停车场"从 Contract 层就被堵死了。
//
// 第一版不追求车位数：角度集合（主朝向 + 30/45/60/90）里挑 aisleRatio 合理的那个，
// 排不出来就如实告警，而不是硬塞。

import { Pt } from '../../core/geom';
import { surfaceArea, surfaceSubtract, type PlanSurface } from '../planning/core/surface';
import { solveParking } from '../parking';
import type { SitePlanCandidate } from '../planning/core/candidate';
import type { RealizationContext, RealizerPart } from './contract';

const U = (m: number) => m / 7;

export interface ParkingRealizationStat {
  requestIndex: number;
  role: string;
  usableArea: number;
  stalls: number;
  aisles: number;
  angleDeg: number;
}

/** 把每个 ParkingRequest 变成一个真实车位布局 */
export function realizeParking(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart,
  obstacles: PlanSurface[]
): ParkingRealizationStat[] {
  const base = ctx.groundY ?? 0.012;
  const stats: ParkingRealizationStat[] = [];
  if (!ctx.solveParking) return stats;

  c.parkingRequests.forEach((req, i) => {
    // ① region − obstacles（建筑 / 庭院 / 装卸坪 / 服务区 / 洞）
    const usableParts = surfaceSubtract([req.region], obstacles).filter((p) => surfaceArea(p) > U(4) * U(4));
    if (usableParts.length === 0) {
      part.warnings.push({
        code: 'PARKING_REGION_CONSUMED',
        message: `停车区域被障碍完全占据（${req.role}）`,
        target: `${c.id}_parkreq_${req.role}_${i}`,
      });
      return;
    }
    const usable = usableParts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));

    // ② 角度集合：主朝向 + 30/45/60/90
    const axis = longestEdgeAngle(usable.outer);
    const angles = [axis, axis + Math.PI / 6, axis + Math.PI / 4, axis + Math.PI / 3, axis + Math.PI / 2];
    const layout = solveParking(usable.outer, { angles });
    if (!layout) {
      part.warnings.push({
        code: 'PARKING_NOT_SOLVED',
        message: `区域排不下车位（${(surfaceArea(usable) * 49).toFixed(0)} m²，${req.role}）`,
        target: `${c.id}_parkreq_${req.role}_${i}`,
      });
      return;
    }

    // ③ 通道**不单独成面**：停车区底色已经是 asphaltLot，再叠一层沥青会让
    //    "地面独占性"失真（parity 的 overlap 会算进去）。通道信息保留在 stats 里。
    // ④ 车位分隔线
    for (const [k, seg] of layout.dividers.entries()) {
      part.paths.push({
        name: `${c.id}_stall_${i}_${k}`,
        group: ctx.group,
        pts: [seg[0], seg[1]],
        width: U(0.1),
        mat: 'markWhite',
        y: base + 0.0026,
      });
    }

    stats.push({
      requestIndex: i,
      role: req.role,
      usableArea: surfaceArea(usable),
      stalls: layout.count,
      aisles: layout.aisles.length,
      angleDeg: Math.round((layout.angle * 180) / Math.PI),
    });
  });

  return stats;
}

function longestEdgeAngle(ring: Pt[]): number {
  let best = 0;
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > len) {
      len = l;
      best = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return best;
}
