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

/**
 * 整个候选的统一停车朝向。
 *
 * 车位朝向有 90° 周期（转 90° 是同一套车位），所以先把每个面的最长边方向
 * 折到 0~90°，再按**面积加权**投票（10° 一档）。面积加权很重要：
 * 一个 5000 m² 的主停车面不该被旁边 200 m² 的碎角带偏。
 *
 * 没有它的时候，每个面各选各的最优角度 —— 那是"每片塞得最多"的局部最优，
 * 合起来就是"车位线歪七扭八"的整体最差。
 */
function globalParkingAxis(c: SitePlanCandidate, obstacles: PlanSurface[]): number {
  const PERIOD = Math.PI / 2;
  const BUCKET = Math.PI / 18; // 10°
  const votes = new Map<number, number>();
  for (const req of c.parkingRequests) {
    const parts = surfaceSubtract([req.region], obstacles).filter((p) => surfaceArea(p) > U(4) * U(4));
    for (const p of parts) {
      const a = longestEdgeAngle(p.outer);
      const folded = ((a % PERIOD) + PERIOD) % PERIOD;
      const key = Math.round(folded / BUCKET) * BUCKET;
      votes.set(key, (votes.get(key) ?? 0) + surfaceArea(p));
    }
  }
  let best = 0;
  let bestW = -1;
  for (const [a, w] of votes) {
    if (w > bestW) {
      bestW = w;
      best = a;
    }
  }
  return best;
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

  // 整个候选的统一停车朝向：所有停车面的最长边方向按面积加权投票，10° 一档
  const axis = globalParkingAxis(c, obstacles);

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

    // ② 角度：**用整个候选的统一朝向**，不是每个面自己的最长边。
    //
    // 原来每个停车面拿自己的最长边当主朝向，于是相邻两片可能一片 90°、
    // 一片 60° —— 车位线在交界处互相错开，一眼看就是"没设计过"。
    // 现在先全片投票出一个朝向（见 globalParkingAxis），每个面都从这个朝向
    // 出发，最多偏 45°（斜列兜底）。`solveParking` 里的 devOf 仍会惩罚斜列，
    // 所以能排下时一定用统一朝向。
    const angles = [axis, axis + Math.PI / 6, axis + Math.PI / 4, axis + Math.PI / 3];
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

    // ④b 通道面 + 树岛面：专业总图上"车位 / 通道 / 树岛"是三层不同材质。
    //
    // 之前通道"不单独成面"（为了避开重叠统计），整片 parking 一片灰。
    // 现在把它们作为**细节层**输出（和 road / parkreq 同一个惯例），
    // 铺在车位底色之上、用 y 偏移分层：
    //   parking     asphaltLot（浅）
    //   parking_aisle asphalt（深一档）
    //   parking_island grass（绿）
    // 细节层不参与"地面独占性"统计（测试里按名字前缀排除）。
    for (const [k, a] of layout.aisles.entries()) {
      part.surfaces.push({
        name: `${c.id}_pk_aisle_${i}_${k}`,
        group: ctx.group,
        ring: a,
        mat: 'asphalt',
        y: base + 0.0018,
      });
    }
    for (const [k, isl] of layout.islands.entries()) {
      part.surfaces.push({
        name: `${c.id}_pk_island_${i}_${k}`,
        group: ctx.group,
        ring: isl,
        mat: 'grass',
        y: base + 0.0022,
      });
    }

    // ⑤ 树岛：**按车位排的真实位置**种，不再随机撒。
    //
    // `layout.islands` 是每 6 个车位之间那条 1.5 m 的树池带（只占车位排、
    // 不穿通道）。一条树池种 1~2 棵，密度比绿地低得多，读起来是
    // "每 4~6 个车位一组、组间有绿化"的真实停车场，而不是"车停在树林里"。
    for (const [k, isl] of layout.islands.entries()) {
      // **隔一条树池种一条**：每条都种的话，双排 + 每 6 位一条 → 视觉上
      // 变成"一道绿篱横穿停车场"，比纯灰还难受。隔一条种，读起来才是
      // "每 10~12 个车位一组、组间有绿化"。
      if (k % 2 !== 0) continue;
      const cx = isl.reduce((a, q) => a + q.x, 0) / isl.length;
      const cy = isl.reduce((a, q) => a + q.y, 0) / isl.length;
      part.props.push({
        name: `${c.id}_island_${i}_${k}`,
        group: ctx.group,
        kind: 'treeSmall',
        at: new Pt(cx, cy),
        rot: ((k * 1.7 + i * 0.9) % 1) * Math.PI * 2,
        // 树池只有 1.5 m 宽，树冠要小 —— 不然会盖住两侧车位
        scale: 0.42 + ((k * 0.37) % 1) * 0.08,
        seed: (k * 0.61 + i * 0.23) % 1,
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
