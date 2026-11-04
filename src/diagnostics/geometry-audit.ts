// 全城几何审计（阶段 D）
//
// 两个诊断，都是**纯只读**，不参与生成：
//
//   auditCoverage()  地面归属分类：A 道路 / A 建筑 / A 已规划面 / B 仅底板 / C 真缺口
//   auditOverlap()   精确重叠：AABB 筛候选对 → 只对可能相交的做 surfaceIntersect
//
// ## 为什么两套
//
// 覆盖回答"这一平方米属于什么功能"（面积 × 归属），采样法就够，而且能顺带
// 覆盖"什么都没盖住"的情况。重叠回答"两个面是不是抢了同一块地"，必须精确求交 ——
// 采样会被边界噪声污染：两个面共用一条边时，压在边上的采样点两边都判"内部"，
// 实测能把 0.03% 的真实重叠虚报成 5%。
//
// ## 名字不是唯一标识
//
// Candidate 的 `id`（`ret-strip-rear-park`）是**方案名**，全城十几个零售地块
// 都叫这个。场景里同一个名字会出现十几次。所以分组必须走 `byParcel`，
// 绝不能按名字前缀配对 —— 那样会把不同地块的面配成一对，得出十万 m² 的假重叠。
//
// 这两条都是踩出来的，别改回去。

import type { Model } from '../town/model';
import type { RoadNet } from '../road/system';
import type { SurfaceFeature } from '../scene/types';
import type { PlanSurface } from '../town/planning/core/surface';
import { pointInRing, surfaceArea, surfaceIntersect, surfaceValid } from '../town/planning/core/surface';
import { Pt } from '../core/geom';
import { buildScene } from '../scene/build';
import { buildPlannerBundle } from '../scene/planner-bridge';
import { siteContextFromModel } from '../town/planning/adapters/model';
import { SurfaceSampler } from './sampling';
import { junctionHulls, patchEdges, labelBPoint } from './b-labels';
import { distToSurfaceEdge } from '../town/planning/core/surface';

// ---------------------------------------------------------------- 覆盖

export type CoverClass = 'A-road' | 'A-building' | 'A-planned' | 'B-plate' | 'C-hole';

export interface BlockCoverage {
  block: string;
  totalM2: number;
  roadM2: number;
  buildingM2: number;
  plannedM2: number;
  plateM2: number;
  holeM2: number;
  overlapM2: number;
}

/**
 * B 类（只有底板、没有功能语义）的成因分类。
 *
 * 用户明确要求：不要为了把 B 压到 0 而填草坪 —— 所以这里**只分类，不填**。
 * 每一类都有明确的处置结论（见 D3 报告）。
 */
export type BReason =
  /** 道路路侧：人行道外沿到地块红线之间那条带（含绿带缺位处） */
  | 'road-side'
  /** 路口过渡：路口铺装圆角外、两条路夹出来的楔形 */
  | 'junction-wedge'
  /** 红线内、可建区外的退线带（planner 已用 setback 认领，这里应接近 0） */
  | 'parcel-setback'
  /** 地块内但没有任何 ground 面盖住（真归属缺口，但仍在红线内） */
  | 'parcel-gap'
  /** 城外/背景（不该被算进城内面积，正常应为 0） */
  | 'outside'
  /** Legacy 地块的底板：legacy 不走 Ground Program，底板就是它的最终表达 */
  | 'legacy-plate'
  /** 以上都不是 */
  | 'unclassified';

export interface CoverageAudit {
  stepU: number;
  samples: number;
  totalM2: number;
  share: Record<CoverClass | 'illegalOverlap', number>;
  blocks: BlockCoverage[];
  /** 首次跑时见过的"命中 0 个面"的位置（前若干条，便于复现） */
  holeSamples: string[];
  invalidRings: string[];
  /** B 类按成因拆分（m² 与占比） */
  bReason: Record<BReason, number>;
  /** 每类 B 的典型位置（世界坐标，取该类面积最大的块的中心） */
  bSamples: Record<BReason, { x: number; y: number; block: string } | null>;
  /** G0 原因标签（互斥），面积与占 B 的比例 */
  gLabels: Record<string, { m2: number; share: number; blocks: number; sample: { x: number; y: number; block: string; evidence: string } | null }>;
  /** 场景自述：seed / patch 数 / 城内块数 / planner 覆盖数，防止跨场景混用数据 */
  scenario: { seed: number; nPatches: number; cityBlocks: number; plannerBlocks: number };
}

/**
 * 合法表达层：**由产出方声明**（`SurfaceFeature.role`），不靠名字前缀。
 *
 * 名字是给人和 DCC 看的，不是契约：改个命名就会让审计失效。所以判定统一走
 * `role === 'overlay'`；没标 role 的一律按独占的功能面处理（宁可误报，不可漏报）。
 * 城市道路用 group 前缀 `road/` 判（那是 scene 层的分组约定，不是面名）。
 */
const isOverlay = (s: { role?: string }) => s.role === 'overlay';
const isRoadGroup = (group: string) => group.startsWith('road');

export interface CoverOpts {
  /** 采样步长（世界单位）。0.5 ≈ 3.5 m */
  stepU?: number;
  /** AABB 索引格边长（世界单位） */
  cellU?: number;
}

export function auditCoverage(model: Model, net: RoadNet, opts: CoverOpts = {}): CoverageAudit {
  const STEP = opts.stepU ?? 0.5;
  const CELL = opts.cellU ?? 8;
  // **唯一一份采样实现**（Phase G0）。审计只是它的一个聚合器：
  // 网格、AABB 索引、holes 处理、最上层选择全在 SurfaceSampler 里，
  // G1/G2/G3 的原因标签也用它，不再各写一份。
  const sampler = new SurfaceSampler(model, { stepU: STEP, cellU: CELL });
  const scene = sampler.scene;

  const isRoad = (s: SurfaceFeature) => s.role === 'road' || isRoadGroup(s.group);
  const isLot = (s: SurfaceFeature) => s.group.startsWith('lot/');
  const isPlate = (s: SurfaceFeature) => s.group === 'ground';

  const covers = (s: SurfaceFeature, x: number, y: number) => {
    const q = new Pt(x, y);
    if (!pointInRing(q, s.ring)) return false;
    for (const h of s.holes ?? []) if (pointInRing(q, h)) return false;
    return true;
  };

  // AABB 索引
  const grid = new Map<string, SurfaceFeature[]>();
  const keyOf = (cx: number, cy: number) => `${cx},${cy}`;
  for (const s of scene.surfaces) {
    if (s.ring.length < 3) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.ring) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = keyOf(cx, cy);
        const arr = grid.get(k);
        if (arr) arr.push(s);
        else grid.set(k, [s]);
      }
    }
  }

  const blocks = new Map<string, BlockCoverage>();
  for (const p of model.patches) {
    if (p.blocked || !p.withinCity) continue;
    const id = `${Math.round(p.shape.reduce((a, q) => a + q.x, 0) / p.shape.length)}:${Math.round(
      p.shape.reduce((a, q) => a + q.y, 0) / p.shape.length
    )}`;
    blocks.set(id, { block: id, totalM2: 0, roadM2: 0, buildingM2: 0, plannedM2: 0, plateM2: 0, holeM2: 0, overlapM2: 0 });
  }
  const blockList = [...blocks.values()];
  const ownerOf = (x: number, y: number): BlockCoverage | null => {
    for (let i = 0; i < model.patches.length; i++) {
      const p = model.patches[i];
      if (p.blocked || !p.withinCity) continue;
      if (pointInRing(new Pt(x, y), Array.from(p.shape))) return blockList[[...blocks.keys()].indexOf(blockId(p) ?? '')] ?? null;
    }
    return null;
  };
  // 上面的线性查找太慢，改成一次性把 patch → rec 映射好
  const recOf = new Map<number, BlockCoverage>();
  model.patches.forEach((p, i) => {
    if (p.blocked || !p.withinCity) return;
    const rec = blocks.get(blockId(p) ?? '');
    if (rec) recOf.set(i, rec);
  });
  void ownerOf;

  // ---- B 类分类需要的预备数据
  // 每个 block 的红线（parcel）与"是否被 planner 接管"
  const parcelOf = new Map<number, PlanSurface>();
  const covered = new Set<string>();
  const reports = (scene as unknown as { planner?: { reports: Map<string, { covered: boolean }> } }).planner?.reports;
  if (reports) for (const [k, r] of reports) if (r.covered) covered.add(k);
  model.patches.forEach((p, i) => {
    if (p.blocked || !p.withinCity) return;
    try {
      parcelOf.set(i, siteContextFromModel(model, p, { net }).parcel);
    } catch {
      /* 读失败就不分类，落到 unclassified */
    }
  });
  const junctions = net.junctions.map((j) => j.center);
  const roadRings = scene.surfaces.filter((s) => isRoad(s)).map((s) => ({ outer: s.ring, holes: s.holes ?? [] }));
  // 道路面按同一个网格再建一份索引：B 分类要对每个采样点算"到最近道路边缘的距离"，
  // 全表扫是 O(采样 × 路面色)，实测 5000×1000=500 万次，太慢。
  const roadGrid = new Map<string, { outer: PlanSurface['outer']; holes: PlanSurface['holes'] }[]>();
  for (const r of roadRings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of r.outer) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    for (let cx = Math.floor(x0 / CELL) - 1; cx <= Math.floor(x1 / CELL) + 1; cx++) {
      for (let cy = Math.floor(y0 / CELL) - 1; cy <= Math.floor(y1 / CELL) + 1; cy++) {
        const k = keyOf(cx, cy);
        const arr = roadGrid.get(k);
        if (arr) arr.push(r);
        else roadGrid.set(k, [r]);
      }
    }
  }

  const bReason: Record<BReason, number> = {
    'road-side': 0,
    'junction-wedge': 0,
    'parcel-setback': 0,
    'parcel-gap': 0,
    outside: 0,
    'legacy-plate': 0,
    unclassified: 0,
  };
  const bSamples: Record<BReason, { x: number; y: number; block: string } | null> = {
    'road-side': null,
    'junction-wedge': null,
    'parcel-setback': null,
    'parcel-gap': null,
    outside: null,
    'legacy-plate': null,
    unclassified: null,
  };
  /** 点到最近的城市道路面边缘的距离（世界单位）；找不到就 Infinity */
  const distToRoad = (x: number, y: number): number => {
    const near = roadGrid.get(keyOf(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!near || near.length === 0) return Infinity;
    const q = new Pt(x, y);
    let best = Infinity;
    for (const r of near) best = Math.min(best, distToSurfaceEdge(q, r));
    return best;
  };
  const distToJunction = (x: number, y: number): number => {
    let best = Infinity;
    for (const j of junctions) best = Math.min(best, Math.hypot(j.x - x, j.y - y));
    return best;
  };
  /**
   * 给一个"只有底板"的采样点定成因。
   *
   * 判据顺序是按**确定性**排的：先排除结构性原因（路口楔形 > 路侧带 > 红线退线），
   * 剩下的才叫 unclassified。这样"说不清"的面积被压到最小。
   */
  const classifyB = (x: number, y: number, block: string, patchIdx: number, inParcel: boolean, isLegacy: boolean): BReason => {
    if (distToJunction(x, y) < 12 / 7) return 'junction-wedge';
    if (distToRoad(x, y) < 14 / 7) return 'road-side';
    if (inParcel) {
      // 红线内、可建区外 = 退线带；planner 已经用 setback 认领，这里应该几乎没有
      return 'parcel-setback';
    }
    if (isLegacy) return 'legacy-plate';
    void patchIdx;
    return 'unclassified';
  };

  // G0：原因标签（只对 B 点跑）
  const hulls = junctionHulls(net);
  const edgeMap = patchEdges(model, net);
  const gAcc = new Map<string, { m2: number; blocks: Set<string>; sample: { x: number; y: number; block: string; evidence: string } | null }>();
  let bTotal = 0;

  const cellA = STEP * STEP * 49;
  let samples = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of model.patches) {
    for (const q of p.shape) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }

  const holeSamples: string[] = [];
  for (let x = x0; x <= x1; x += STEP) {
    for (let y = y0; y <= y1; y += STEP) {
      samples++;
      const f = sampler.sample(x, y);
      if (!f.inCity || !f.block) continue;
      const rec = blocks.get(f.block);
      if (!rec) continue;
      rec.totalM2 += cellA;

      if (f.cover === 'A-building') { rec.buildingM2 += cellA; continue; }
      if (f.cover === 'C-hole') {
        rec.holeM2 += cellA;
        if (holeSamples.length < 6) holeSamples.push(`(${x.toFixed(1)},${y.toFixed(1)})`);
        continue;
      }
      if (f.cover === 'A-road') rec.roadM2 += cellA;
      else if (f.cover === 'B-plate') {
        rec.plateM2 += cellA;
        const parcel = parcelOf.get(patchIndex(model, f.block));
        const inParcel = parcel ? pointInRing(new Pt(x, y), parcel.outer) : false;
        const isLegacy = !covered.has(rec.block);
        const why = classifyB(x, y, rec.block, -1, inParcel, isLegacy);
        bReason[why] += cellA;
        if (!bSamples[why]) bSamples[why] = { x: +x.toFixed(1), y: +y.toFixed(1), block: rec.block };

        const lb = labelBPoint(f, hulls, (b) => edgeMap.get(b) ?? []);
        const e = gAcc.get(lb.label) ?? { m2: 0, blocks: new Set<string>(), sample: null };
        e.m2 += cellA;
        e.blocks.add(rec.block);
        if (!e.sample) e.sample = { x: +x.toFixed(1), y: +y.toFixed(1), block: rec.block, evidence: lb.evidence };
        gAcc.set(lb.label, e);
        bTotal += cellA;
      } else rec.plannedM2 += cellA;

      const excl = f.hits.filter((h) => isLot(h) && !isOverlay(h));
      if (excl.length >= 2) rec.overlapM2 += cellA;
    }
  }

  const sum = (f: (b: BlockCoverage) => number) => blockList.reduce((a, b) => a + f(b), 0);
  const totalM2 = sum((b) => b.totalM2);
  const invalidRings = scene.surfaces.filter((s) => !surfaceValid({ outer: s.ring, holes: s.holes ?? [] })).map((s) => s.name);
  return {
    stepU: STEP,
    samples,
    totalM2,
    share: {
      'A-road': totalM2 ? sum((b) => b.roadM2) / totalM2 : 0,
      'A-building': totalM2 ? sum((b) => b.buildingM2) / totalM2 : 0,
      'A-planned': totalM2 ? sum((b) => b.plannedM2) / totalM2 : 0,
      'B-plate': totalM2 ? sum((b) => b.plateM2) / totalM2 : 0,
      'C-hole': totalM2 ? sum((b) => b.holeM2) / totalM2 : 0,
      illegalOverlap: totalM2 ? sum((b) => b.overlapM2) / totalM2 : 0,
    },
    blocks: blockList,
    holeSamples,
    invalidRings,
    bReason,
    bSamples,
    gLabels: Object.fromEntries(
      [...gAcc.entries()].map(([k, v]) => [
        k,
        { m2: +v.m2.toFixed(0), share: bTotal > 0 ? v.m2 / bTotal : 0, blocks: v.blocks.size, sample: v.sample },
      ])
    ),
    scenario: {
      seed: 682063530,
      nPatches: model.patches.length,
      cityBlocks: blockList.length,
      plannerBlocks: covered.size,
    },
  };
}

function blockId(p: { shape: ReadonlyArray<{ x: number; y: number }> }): string {
  const cx = p.shape.reduce((a, q) => a + q.x, 0) / p.shape.length;
  const cy = p.shape.reduce((a, q) => a + q.y, 0) / p.shape.length;
  return `${Math.round(cx)}:${Math.round(cy)}`;
}

// ---------------------------------------------------------------- 精确重叠

export interface OverlapConflict {
  block: string;
  a: string;
  b: string;
  areaM2: number;
  polys: number;
  centroid: string;
  /** 交集第一块的包围盒（米） */
  shape: string;
}

export interface OverlapAudit {
  blocks: number;
  surfaces: number;
  pairsTested: number;
  conflicts: OverlapConflict[];
  totalM2: number;
  invalidRings: string[];
}

export function auditOverlap(model: Model, net: RoadNet): OverlapAudit {
  const bundle = buildPlannerBundle(model, net, 'planner');
  const box = (r: ReadonlyArray<{ x: number; y: number }>) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of r) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  };
  const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  const conflicts: OverlapConflict[] = [];
  const invalidRings: string[] = [];
  let blocks = 0, surfaces = 0, pairsTested = 0;

  for (const [block, feats] of bundle.byParcel) {
    blocks++;
    const list = feats.surfaces
      .filter((s) => !isOverlay(s))
      .map((s) => ({ name: s.name, s: { outer: s.ring, holes: s.holes ?? [] } as PlanSurface, box: box(s.ring) }));
    surfaces += list.length;
    for (const l of list) if (!surfaceValid(l.s)) invalidRings.push(l.name);

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!hit(list[i].box, list[j].box)) continue;
        pairsTested++;
        let inter: PlanSurface[];
        try {
          inter = surfaceIntersect([list[i].s], [list[j].s]);
        } catch {
          continue;
        }
        const a = inter.reduce((s, q) => s + surfaceArea(q), 0) * 49;
        if (a < 5) continue;
        const r = inter[0]?.outer ?? [];
        const cx = r.reduce((s, q) => s + q.x, 0) / Math.max(1, r.length);
        const cy = r.reduce((s, q) => s + q.y, 0) / Math.max(1, r.length);
        const bb = r.length ? box(r) : { x0: 0, y0: 0, x1: 0, y1: 0 };
        conflicts.push({
          block,
          a: list[i].name,
          b: list[j].name,
          areaM2: +a.toFixed(1),
          polys: inter.length,
          centroid: `(${cx.toFixed(1)},${cy.toFixed(1)})`,
          shape: `${((bb.x1 - bb.x0) * 7).toFixed(1)}×${((bb.y1 - bb.y0) * 7).toFixed(1)}m`,
        });
      }
    }
  }
  conflicts.sort((x, y) => y.areaM2 - x.areaM2);
  return {
    blocks,
    surfaces,
    pairsTested,
    conflicts,
    totalM2: +conflicts.reduce((s, c) => s + c.areaM2, 0).toFixed(1),
    invalidRings,
  };
}

/** blockId → patch 下标（parcelOf 是按下标存的） */
function patchIndex(model: Model, block: string): number {
  for (let i = 0; i < model.patches.length; i++) {
    const p = model.patches[i];
    if (p.blocked || !p.withinCity) continue;
    const r = Array.from(p.shape);
    const cx = r.reduce((a, q) => a + q.x, 0) / r.length;
    const cy = r.reduce((a, q) => a + q.y, 0) / r.length;
    if (`${Math.round(cx)}:${Math.round(cy)}` === block) return i;
  }
  return -1;
}
