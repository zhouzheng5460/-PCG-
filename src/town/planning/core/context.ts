// Site Planning Core · SiteContext（PRD §5 / 用户 P1.1~P1.5）
//
// 职责只有一句话：**把一个地块"读懂"** —— 它临哪几条路、哪边是主街、
// 哪里可以建、从哪里可以进、周围是什么。不生成任何建筑、不碰渲染。
//
// 三条冻结原则：
//   ① 纯数据：可 JSON.stringify、可单测，不 import three / DOM；
//   ② 临时几何实现必须标 `TEMP_GEOMETRY_BACKEND`，接口不变、实现可换；
//   ③ 邻接查询只暴露 `queryNeighbors()`，业务层不知道内部是 for 循环还是 RBush。

import { Pt } from '../../../core/geom';
import {
  surfaceArea,
  surfaceInset,
  surfaceSubtract,
  surfaceValid,
  insideSurface,
  pointInRing,
  bboxOf,
  type PlanSurface,
} from './surface';
import type {
  AccessKind,
  AccessPoint,
  ArchetypeCandidate,
  Frontage,
  FrontageRole,
  NeighborContext,
  SiteContext,
  SiteRoadEdge,
  SiteTypology,
} from './types';

// ---------------------------------------------------------------- 构建入口

export interface SiteContextInput {
  parcelId: string;
  /** 地块（外环 + 洞） */
  parcel: PlanSurface;
  /** 原始用途字符串（'industrial' / 'residential' / ...） */
  use: string;
  /** 显式指定 typology；不给就按用途推 */
  typology?: SiteTypology;
  /** **与该地块相邻**的城市道路边（已过滤好，不是全城路网） */
  edges: SiteRoadEdge[];
  /** 邻接地块（可选，不给就靠 queryNeighbors 从 parcelList 里找） */
  neighbors?: NeighborContext[];
  /** 其他地块，用于 queryNeighbors */
  parcelList?: { parcelId: string; use: string; parcel: PlanSurface }[];
  /** 退线距离（世界单位；1 单位 = 7 m）。默认 5 m */
  setback?: number;
  /** 不可建障碍（已有建筑保留 / 保护区 / 地下设施） */
  obstacles?: PlanSurface[];
}

/** 用途 → 场地类型。Phase 1 只做粗映射，细节由 typology 参数覆盖。 */
export function typologyOfUse(use: string): SiteTypology {
  switch (use) {
    case 'industrial':
      return 'industrial';
    case 'residential':
      return 'multi_family';
    case 'commercial':
    case 'cbd':
      return 'retail';
    case 'green':
      return 'green';
    case 'park':
      return 'park';
    case 'civic':
      return 'civic';
    default:
      return 'generic';
  }
}

/**
 * 读一个地块。
 *
 * 输出是**纯数据**，不会被后续规划修改；Phase 2 的每个 Candidate 都从它出发。
 */
export function buildSiteContext(input: SiteContextInput): SiteContext {
  const notes: string[] = [];
  const typology = input.typology ?? typologyOfUse(input.use);
  const parcel = input.parcel;

  const roadEdges = input.edges.slice();
  const frontages = resolveFrontages(parcel, roadEdges, notes);

  // 转角地块的退线收紧。
  //
  // 街角是城市里最容易被眼睛读到的地方，但现在的几何是"收口 5.5~10 m
  //（路口铺装延伸）+ 退线 5 m"，建筑离路口中心 12~16 m —— 实测以度≥3 的
  // 路口顶点为圆心，8 m 环内只有 21% 有建筑，街角读起来是空的。
  //
  // 判据用**真转角**（primary 与 secondary 方向差 >25°），不是"有两条临街面"：
  // 夹在两条平行街之间的地块方向差只有 0~14°，它不是转角，不该收紧。
  const cornerBetween = (() => {
    const p = frontages.primary;
    const q = frontages.secondary;
    if (!p || !q) return 0;
    const ang = (f: NonNullable<typeof p>) =>
      Math.atan2(f.parcelEdge[1].y - f.parcelEdge[0].y, f.parcelEdge[1].x - f.parcelEdge[0].x);
    let d = Math.abs(ang(p) - ang(q)) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return (d * 180) / Math.PI;
  })();
  const isCorner = cornerBetween > 25;
  const baseSetback = input.setback ?? 5 / 7;
  // 收到 0.7 倍（5 m → 3.5 m）：够把街角读出来，又不至于让沿街界面整体失控。
  const buildable = resolveBuildable(
    parcel,
    isCorner ? baseSetback * 0.7 : input.setback,
    input.obstacles,
    notes
  );
  if (isCorner) {
    notes.push(`转角地块（两面夹角 ${cornerBetween.toFixed(0)}°）：退线 ${(baseSetback * 7).toFixed(1)} → ${(baseSetback * 7 * 0.7).toFixed(1)} m`);
  }

  const neighbors =
    input.neighbors ??
    (input.parcelList
      ? queryNeighbors(
          { parcelId: input.parcelId, use: input.use, parcel },
          input.parcelList.filter((p) => p.parcelId !== input.parcelId)
        )
      : []);

  const access = resolveAccess(parcel, frontages, notes);

  return {
    parcelId: input.parcelId,
    typology,
    parcel,
    use: input.use,
    roadEdges,
    primaryFrontage: frontages.primary,
    secondaryFrontage: frontages.secondary,
    serviceFrontage: frontages.service,
    orientation: frontages.orientation,
    buildableArea: buildable,
    pedestrianAccessCandidates: access.pedestrian,
    vehicleAccessCandidates: access.vehicle,
    serviceAccessCandidates: access.service,
    truckAccessCandidates: access.truck,
    neighbors,
    notes,
  };
}

// ---------------------------------------------------------------- P1.2 临街面

export interface FrontageResult {
  all: Frontage[];
  primary?: Frontage;
  secondary?: Frontage;
  service?: Frontage;
  orientation: number;
}

/**
 * 临街面评分（PRD §P1.2）。
 *
 * 早先的写法是"离地块最近的那条路就是主街"—— 转角地块上经常判反：
 * 支路贴着边 0.5 m、主干路 3 m，但主干路才是主街。所以这里按四项打分：
 *
 *   frontageScore = roadClass + sharedLength + visibility + accessibility − obstruction
 *
 * 输出 primary / secondary / service / none，六种 typology 复用同一套判定：
 * 住宅主入口找 primary、工业装卸找 service/secondary、数据中心服务门找 service。
 */
export function resolveFrontages(parcel: PlanSurface, edges: SiteRoadEdge[], notes: string[] = []): FrontageResult {
  const ring = parcel.outer;
  if (ring.length < 3) return { all: [], orientation: 0 };
  if (edges.length === 0) {
    // 连一条相邻道路边都没有：多半是被完全包围的内部地块（中心广场 / 保留地）。
    // 这不是错误，但要留痕 —— 下游看到"无临街面"就知道该走内部通道而不是街道。
    notes.push('无相邻城市道路边（内部地块），需要从内部通道进出');
    return { all: [], orientation: dominantAngle(ring) };
  }

  // 每条地块边配一条最近的临街道路边（8 m 内才算贴合）
  const matched: { edge: SiteRoadEdge; a: Pt; b: Pt; len: number; dist: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    let best: { edge: SiteRoadEdge; dist: number } | null = null;
    for (const e of edges) {
      // 注意：`RoadEdge.a/b` 是**道路中心线**，地块边界离它有"半条路宽 + 人行道"
      // 的距离（主干路约 1.5~2 单位）。所以这里的阈值是 3 单位（≈21 m），
      // 不是"贴着"的 0.6 —— 用 0.6 的话真实城市里一条都匹配不上。
      // 误配风险由调用方兜住：传进来的 edges 本来就该是"与该地块相邻"的边。
      const d = distToSegment(mid, e.a, e.b);
      if (d > 3) continue;
      if (!best || d < best.dist) best = { edge: e, dist: d };
    }
    if (!best) continue;
    matched.push({ edge: best.edge, a, b, len: Pt.distance(a, b), dist: best.dist });
  }
  // 兜底：地块可能被切分/内缩后离所有中心线都超过 3 单位（楔形地的尖角、
  // 被巷道夹住的小块）。这时取**最近的一条**作为唯一临街面 —— 每块地都临某条路，
  // 返回"没有临街面"会让下游（Access / Archetype）整个失效。
  if (matched.length === 0 && edges.length > 0) {
    const ctr = centroid(ring);
    let best: { edge: SiteRoadEdge; dist: number } | null = null;
    for (const e of edges) {
      const d = distToSegment(ctr, e.a, e.b);
      if (!best || d < best.dist) best = { edge: e, dist: d };
    }
    if (best) {
      // 用地块最长的一条边当代表边（Access 要在它上面开口）
      let longest: [Pt, Pt] = [ring[0], ring[1 % ring.length]];
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (Pt.distance(a, b) > Pt.distance(longest[0], longest[1])) longest = [a, b];
      }
      matched.push({ edge: best.edge, a: longest[0], b: longest[1], len: Pt.distance(longest[0], longest[1]), dist: best.dist });
      notes.push(`地块离道路中心线 ${(best.dist * 7).toFixed(0)} m，按最近路兜底`);
    }
  }
  if (matched.length === 0) {
    // 连一条相邻道路边都没有：多半是被完全包围的内部地块（中心广场 / 保留地）。
    // 这不是错误，但要留痕 —— 下游看到"无临街面"就知道该走内部通道而不是街道。
    notes.push('无相邻城市道路边（内部地块），需要从内部通道进出');
    return { all: [], orientation: dominantAngle(ring) };
  }

  // 先把"同一条街的连续段"合并成一条临街面。
  //
  // 为什么必须合并：路网是 Voronoi 边，一条街在数据里是 **5~8 条并列的
  // RoadEdge**（每条对应一个相邻街区的一条边）。原先按 edge.key 分组再逐条
  // 打分取 top2，primary 和 secondary 常常落在**同一条街的两段**上 ——
  // 真正的转角面被挤掉，于是下游以为这块地"只临一条街"。
  // 实测：按 primary/secondary 判"真转角"是 0 块，按地块形状判是 97/99 块。
  //
  // 合并规则：相邻（在 ring 上连续）且方向差 < 25° 就算同一条街。
  // 25° 能吃掉 Voronoi 折线的缓弯，但不会把真转角（通常 60°~120°）并掉。
  const dirOf = (e: SiteRoadEdge) => Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
  const sameStreet = (x: SiteRoadEdge, y: SiteRoadEdge) => {
    let d = Math.abs(dirOf(x) - dirOf(y)) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d < (25 * Math.PI) / 180;
  };

  interface Run {
    edge: SiteRoadEdge;
    len: number;
    dist: number;
    segs: [Pt, Pt][];
  }
  const runs: Run[] = [];
  for (const m of matched) {
    const prev = runs[runs.length - 1];
    if (prev && (prev.edge.key === m.edge.key || sameStreet(prev.edge, m.edge))) {
      prev.len += m.len;
      prev.dist = Math.min(prev.dist, m.dist);
      prev.segs.push([m.a, m.b]);
    } else {
      runs.push({ edge: m.edge, len: m.len, dist: m.dist, segs: [[m.a, m.b]] });
    }
  }
  // ring 是闭合的：首尾同街也要并（否则一条环绕地块的街会被拆成两半）
  while (runs.length > 1 && sameStreet(runs[0].edge, runs[runs.length - 1].edge)) {
    const last = runs.pop()!;
    runs[0].len += last.len;
    runs[0].dist = Math.min(runs[0].dist, last.dist);
    runs[0].segs.push(...last.segs);
  }

  const all: Frontage[] = [];
  for (const { edge, len, dist, segs } of runs) {
    const roadClass = edge.cls === 'arterial' ? 1 : edge.cls === 'collector' ? 0.72 : 0.46;
    const sharedLength = Math.min(1, len / 2.4); // 2.4 单位 ≈ 17 m 就算"占满一条边"
    const visibility = Math.max(0, 1 - dist / 3);
    const accessibility = edge.sidewalk > 0.05 ? 1 : edge.carriageSide > 0.05 ? 0.55 : 0.15;
    // obstruction：有中央分隔带的路开口受限；车道越宽越难开口
    const obstruction = Math.min(0.35, edge.median * 2 + Math.max(0, edge.carriageSide - 1.6) * 0.12);
    const score = clamp01(0.45 * roadClass + 0.25 * sharedLength + 0.2 * visibility + 0.1 * accessibility - obstruction);

    // 最长的那段作为这条临街面的代表边（Access 要在它上面开口）
    const longest = segs.reduce((x, y) => (Pt.distance(x[0], x[1]) >= Pt.distance(y[0], y[1]) ? x : y));
    all.push({
      role: 'none',
      edge,
      score,
      parts: { roadClass, sharedLength, visibility, accessibility, obstruction },
      parcelEdge: longest,
    });
  }

  all.sort((x, y) => y.score - x.score);
  if (all.length > 0) all[0].role = 'primary';
  if (all.length > 1 && all[1].score >= all[0].score * 0.55) all[1].role = 'secondary';
  // service 面：**能通车且不是主街**的那条。有次临街面就直接用它 ——
  // 工业 rear-load / 数据中心服务门要的就是"次临街面做后勤"，而不是第三条路。
  // 所以这里允许 service 指向一条 role 为 secondary 的边（同一个 Frontage 对象）。
  let serviceFace = all.find((f) => f.role === 'secondary' && f.edge.carriageSide > 0.05);
  if (!serviceFace) {
    serviceFace = all.find((f) => f.role === 'none' && f.edge.carriageSide > 0.05);
    if (serviceFace) serviceFace.role = 'service';
  }

  const primary = all.find((f) => f.role === 'primary');
  const secondary = all.find((f) => f.role === 'secondary');
  const service = serviceFace;

  if (primary) notes.push(`主临街面：${primary.edge.cls} 路，评分 ${primary.score.toFixed(2)}`);
  if (secondary) notes.push(`次临街面：${secondary.edge.cls} 路（转角地块，可做第二入口）`);
  if (service) notes.push(`服务临街面：${service.edge.cls} 路（适合货运/后勤开口）`);

  return {
    all,
    primary,
    secondary,
    service,
    orientation: primary ? Math.atan2(primary.parcelEdge[1].y - primary.parcelEdge[0].y, primary.parcelEdge[1].x - primary.parcelEdge[0].x) : dominantAngle(ring),
  };
}

// ---------------------------------------------------------------- P1.3 开口候选

export interface AccessResult {
  pedestrian: AccessPoint[];
  vehicle: AccessPoint[];
  service: AccessPoint[];
  truck: AccessPoint[];
}

/**
 * 开口候选（PRD §P1.3）。
 *
 * Phase 1 **只回答"应该在哪里开口"**，不回答"进去以后怎么走"——
 * 后者是 Phase 4 的 AccessGraph（graphology）。这里先用采样 + 评分，
 * 接口固定成 `resolveAccess()`，将来换 Graph 不影响调用方。
 */
export function resolveAccess(parcel: PlanSurface, frontages: FrontageResult, notes: string[] = []): AccessResult {
  const out: AccessResult = { pedestrian: [], vehicle: [], service: [], truck: [] };
  const ctr = centroid(parcel.outer);

  const push = (f: Frontage, kind: AccessKind, t: number) => {
    const [a, b] = f.parcelEdge;
    const p = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    // 朝外法线：从地块中心指向该点
    const nx = p.x - ctr.x;
    const ny = p.y - ctr.y;
    const nl = Math.hypot(nx, ny) || 1;
    const normal = new Pt(nx / nl, ny / nl);
    const roadClass = f.parts.roadClass;
    // 到路口的距离：道路边两端被路口吃掉的长度（padA/padB）越大说明越靠路口
    const intersectionDistance = clamp01(1 - Math.abs(t - 0.5) * 2);
    const frontageRole = f.role === 'primary' ? 1 : f.role === 'secondary' ? 0.7 : 0.45;
    const availableWidth = Math.min(1, Pt.distance(a, b) / 1.6);
    const cornerPenalty = Math.abs(t - 0.5) < 0.08 ? 0 : 0.15;
    const score = clamp01(
      0.32 * roadClass + 0.28 * intersectionDistance + 0.22 * frontageRole + 0.18 * availableWidth - cornerPenalty
    );
    out[kind].push({
      kind,
      at: p,
      normal,
      score,
      parts: { roadClass, intersectionDistance, frontageRole, availableWidth, cornerPenalty },
    });
  };

  // 主临街面：车行入口 + 人行入口各取中点；次临街面：第二个车行入口
  if (frontages.primary) {
    push(frontages.primary, 'vehicle', 0.5);
    push(frontages.primary, 'pedestrian', 0.5);
  }
  if (frontages.secondary) push(frontages.secondary, 'vehicle', 0.5);
  // 服务/货运：优先服务临街面，其次次临街面，取两端（避开主入口）
  const serviceFace = frontages.service ?? frontages.secondary;
  if (serviceFace) {
    push(serviceFace, 'service', 0.32);
    push(serviceFace, 'truck', 0.68);
  }

  for (const k of Object.keys(out) as AccessKind[]) out[k].sort((x, y) => y.score - x.score);
  if (out.vehicle.length > 0) notes.push(`车行开口候选 ${out.vehicle.length} 个，最高分 ${out.vehicle[0].score.toFixed(2)}`);
  if (out.truck.length > 0) notes.push(`货运开口候选在服务临街面`);
  return out;
}

// ---------------------------------------------------------------- P1.4 可建区

/**
 * 可建区 = 地块内缩退线 − 障碍。
 *
 * TEMP_GEOMETRY_BACKEND：内缩目前用 `surfaceInset()` 里的自研 miter 偏移。
 * 只保证：普通凸多边形 / 普通凹多边形 / 带洞面 / 常见城市地块。
 * 以后换 clipper2-ts 时**只改 surface.ts 的实现**，这个函数与调用方都不动。
 */
export function resolveBuildable(
  parcel: PlanSurface,
  setbackU = 5 / 7,
  obstacles: PlanSurface[] = [],
  notes: string[] = []
): PlanSurface {
  const base = Math.max(0, setbackU);
  let inset = base > 0 ? surfaceInset(parcel, base) : [parcel];
  let merged = mergeSurfaces(inset);

  // 退线吃得太狠（面积掉到 45% 以下）说明地块本身就碎：退一半重试
  if (!merged || !surfaceValid(merged) || surfaceArea(merged) < surfaceArea(parcel) * 0.45) {
    const half = base * 0.5;
    const retry = half > 0 ? surfaceInset(parcel, half) : [parcel];
    const m2 = mergeSurfaces(retry);
    if (m2 && surfaceValid(m2)) {
      merged = m2;
      notes.push(`退线 ${(base * 7).toFixed(1)} m 后剩余不足 45%，改用 ${(half * 7).toFixed(1)} m`);
    }
  }
  if (!merged || !surfaceValid(merged)) return parcel;

  if (obstacles.length > 0) {
    const cut = surfaceSubtract([merged], obstacles);
    const m3 = mergeSurfaces(cut);
    if (m3 && surfaceValid(m3)) {
      merged = m3;
      notes.push(`可建区扣除 ${obstacles.length} 处障碍`);
    }
  }
  return merged;
}

// ---------------------------------------------------------------- P1.5 邻接

/**
 * 邻接地块查询（PRD §P1.5）。
 *
 * 第一版就是 bbox 粗筛 + 距离 + 共享边长度，故意不引 RBush：
 * 城市规模几百块地，暴力遍历一次是毫秒级。**调用方只认这个函数**，
 * 以后内部换成 RBush 不需要改业务代码。
 */
export function queryNeighbors(
  self: { parcelId: string; use: string; parcel: PlanSurface },
  others: { parcelId: string; use: string; parcel: PlanSurface }[],
  maxDist = 1.2
): NeighborContext[] {
  const sb = bboxOf(self.parcel.outer);
  const out: NeighborContext[] = [];
  for (const o of others) {
    const ob = bboxOf(o.parcel.outer);
    // bbox 粗筛
    const gapX = Math.max(0, Math.max(sb.minX - ob.maxX, ob.minX - sb.maxX));
    const gapY = Math.max(0, Math.max(sb.minY - ob.maxY, ob.minY - sb.maxY));
    if (Math.hypot(gapX, gapY) > maxDist) continue;

    let shared = 0;
    let best = Infinity;
    for (let i = 0; i < self.parcel.outer.length; i++) {
      const a = self.parcel.outer[i];
      const b = self.parcel.outer[(i + 1) % self.parcel.outer.length];
      for (let j = 0; j < o.parcel.outer.length; j++) {
        const c = o.parcel.outer[j];
        const d = o.parcel.outer[(j + 1) % o.parcel.outer.length];
        // 两条边共线且重叠 → 计入共享长度
        const overlap = collinearOverlap(a, b, c, d);
        if (overlap > 0.02) shared += overlap;
        best = Math.min(best, segSegDistance(a, b, c, d));
      }
    }
    const distance = shared > 0.02 ? 0 : best;
    if (distance > maxDist) continue;
    out.push({
      parcelId: o.parcelId,
      use: o.use,
      distance,
      sharedBoundaryLength: shared,
      relation: shared > 0.02 ? 'adjacent' : distance < 0.5 ? 'across_road' : 'nearby',
    });
  }
  out.sort((x, y) => x.distance - y.distance);
  return out;
}

// ---------------------------------------------------------------- Archetype（P1.7）

/** 第一版 Selector 的输入摘要（不直接吃整个 SiteContext，保持纯函数） */
export interface SiteShapeSummary {
  area: number;
  /** 外接矩形的长边 / 短边 */
  aspect: number;
  /** 有几条临街面（primary 之外还有没有 secondary/service） */
  frontageCount: number;
  /** 可建区 / 地块面积 */
  buildableRatio: number;
  /** 邻接的同类地块数（工业园 / 商业街的连续性） */
  sameUseNeighbors: number;
}

/**
 * Archetype 筛选（PRD §P1.7）。
 *
 * **第一版故意不聪明**：只按 typology + 形状 + 面积 + 长宽比 + 临街面数量
 * 返回"够格"的候选，不做最终选择。最终选择留给 Phase 2：
 * 生成 Candidate → LayoutEvaluator → winner。
 */
export function eligibleArchetypes(typology: SiteTypology, s: SiteShapeSummary): ArchetypeCandidate[] {
  const out: ArchetypeCandidate[] = [];
  const add = (archetype: string, fit: number, reasons: string[]) => out.push({ archetype, fit: clamp01(fit), reasons });

  if (typology === 'industrial') {
    if (s.area >= 18 && s.aspect >= 1.25) add('IND_REAR_LOAD', 0.9, ['足够大的矩形地块', '长边可布置装卸面']);
    if (s.frontageCount >= 2) add('IND_SIDE_LOAD', 0.72, ['两面临街，可把货运口放在次临街面']);
    if (s.area >= 40) add('IND_CROSS_DOCK', 0.66, ['大地块，可两侧装卸']);
    if (s.area >= 12 && s.area < 24) add('IND_SMALL_BAY', 0.7, ['中等地块，小单元厂房']);
    if (s.frontageCount === 1) add('IND_FRONT_LOAD', 0.6, ['单面临街，装卸放在前场']);
    if (s.area >= 60) add('IND_MULTI_BUILDING', 0.55, ['超大地块，可多栋']);
  } else if (typology === 'multi_family') {
    if (s.area >= 20 && s.aspect < 1.6) add('MF_COURTYARD', 0.88, ['接近方形的大地块，适合围合庭院']);
    if (s.area >= 34 && s.aspect < 1.4) add('MF_DOUBLE_COURTYARD', 0.7, ['足够大，可做双庭院']);
    if (s.aspect >= 1.7) add('MF_GURBAN', 0.82, ['狭长地块，适合条形围合']);
    if (s.area < 12) add('MF_TOWNHOME', 0.6, ['小地块，联排更合适']);
    if (s.area >= 28) add('MF_WRAP', 0.58, ['大地块，可围绕停车楼']);
    if (s.area >= 45 && s.buildableRatio > 0.5) add('MF_PODIUM', 0.5, ['超大地块，可做裙房 + 塔楼']);
  } else if (typology === 'single_family') {
    if (s.area >= 25) add('SF_DETACHED_GRID', 0.85, ['大地块，可做规整 subdivision']);
    if (s.area >= 35) add('SF_CURVILINEAR', 0.6, ['足够大，可做曲线路网']);
    if (s.area >= 30) add('SF_CULDESAC', 0.55, ['可做尽端路']);
    if (s.aspect >= 2) add('SF_TOWNHOME', 0.65, ['狭长地块适合联排']);
  } else if (typology === 'retail') {
    if (s.area >= 10 && s.aspect >= 1.4) add('RET_STRIP', 0.86, ['狭长地块，沿街条状商业']);
    if (s.area >= 8 && s.aspect < 1.4) add('RET_PAD', 0.7, ['中小地块，独立商业体']);
    if (s.area >= 30) add('RET_NEIGHBORHOOD', 0.72, ['大地块，邻里中心']);
    if (s.area >= 50) add('RET_POWER_CENTER', 0.6, ['超大地块，功率中心']);
    if (s.frontageCount >= 2 && s.area >= 16) add('RET_SHOPPING_CENTER', 0.55, ['两面临街，可组织环形车流']);
  } else if (typology === 'hotel') {
    if (s.area < 20) add('HOTEL_GURBAN', 0.8, ['中小地块，城市型酒店']);
    if (s.area >= 18) add('HOTEL_PODIUM', 0.72, ['大地块，裙房 + 客房塔']);
    if (s.area >= 30) add('HOTEL_WRAP', 0.55, ['大地块，可围绕停车']);
    if (s.area >= 26 && s.buildableRatio > 0.55) add('HOTEL_TOWER', 0.5, ['可做纯塔楼']);
  } else if (typology === 'data_center') {
    if (s.area < 30) add('DC_INFILL', 0.78, ['中小地块，填充型机房']);
    if (s.area >= 24) add('DC_SINGLE_HALL', 0.8, ['大地块，单栋机房 + 设备场']);
    if (s.area >= 45) add('DC_DUAL_HALL', 0.68, ['超大地块，双栋']);
    if (s.area >= 70) add('DC_CAMPUS', 0.6, ['超大地块，园区']);
  } else {
    add('GENERIC_BLOCK', 0.5, ['未归类用途：按通用街区处理']);
  }

  out.sort((x, y) => y.fit - x.fit);
  return out;
}

/** 从 SiteContext 里抽出 Selector 需要的形状摘要 */
export function summarizeSite(ctx: SiteContext): SiteShapeSummary {
  const b = bboxOf(ctx.parcel.outer);
  const w = Math.max(1e-6, b.maxX - b.minX);
  const h = Math.max(1e-6, b.maxY - b.minY);
  const area = surfaceArea(ctx.parcel);
  const buildable = surfaceArea(ctx.buildableArea);
  const frontageCount = [ctx.primaryFrontage, ctx.secondaryFrontage, ctx.serviceFrontage].filter(Boolean).length;
  return {
    area,
    aspect: Math.max(w, h) / Math.min(w, h),
    frontageCount,
    buildableRatio: area > 1e-9 ? buildable / area : 0,
    sameUseNeighbors: ctx.neighbors.filter((n) => n.use === ctx.use).length,
  };
}

// ---------------------------------------------------------------- 工具

function mergeSurfaces(list: PlanSurface[]): PlanSurface | null {
  const valid = list.filter((s) => s.outer.length >= 3);
  if (valid.length === 0) return null;
  // 多块时取面积最大的那块：Phase 1 的规划都假设单块可建区（多块留给 Phase 2 拆栋）
  return valid.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
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

/** 地块最长边的方向（没有临街面时的兜底 orientation） */
function dominantAngle(ring: Pt[]): number {
  let best = 0;
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const l = Pt.distance(a, b);
    if (l > len) {
      len = l;
      best = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return best;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function segSegDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  // 段-段最短距离（相交返回 0）
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(
    distToSegment(a, c, d),
    distToSegment(b, c, d),
    distToSegment(c, a, b),
    distToSegment(d, a, b)
  );
}

function collinearOverlap(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abl = Math.hypot(abx, aby);
  if (abl < 1e-9) return 0;
  const ux = abx / abl;
  const uy = aby / abl;
  // c、d 到 ab 所在直线的距离都要很小
  const offC = Math.abs((c.x - a.x) * uy - (c.y - a.y) * ux);
  const offD = Math.abs((d.x - a.x) * uy - (d.y - a.y) * ux);
  if (offC > 0.06 || offD > 0.06) return 0;
  const tc = (c.x - a.x) * ux + (c.y - a.y) * uy;
  const td = (d.x - a.x) * ux + (d.y - a.y) * uy;
  const lo = Math.max(0, Math.min(tc, td));
  const hi = Math.min(abl, Math.max(tc, td));
  return Math.max(0, hi - lo);
}

function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 供测试与诊断：地块是否真的把某个点算在可建区内 */
export function insideBuildable(ctx: SiteContext, p: Pt): boolean {
  return insideSurface(p, ctx.buildableArea) || pointInRing(p, ctx.buildableArea.outer);
}
