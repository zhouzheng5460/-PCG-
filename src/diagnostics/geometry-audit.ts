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

export interface CoverageAudit {
  stepU: number;
  samples: number;
  totalM2: number;
  share: Record<CoverClass | 'illegalOverlap', number>;
  blocks: BlockCoverage[];
  /** 首次跑时见过的"命中 0 个面"的位置（前若干条，便于复现） */
  holeSamples: string[];
  invalidRings: string[];
}

/** 合法表达层：叠在功能面之上本来就允许，不计入重叠 */
const OVERLAY_RE = /_pk_|_island_|_stall_|_parkreq_|_circ_|_access_|_setback_|_road_|_pad_/;

export interface CoverOpts {
  /** 采样步长（世界单位）。0.5 ≈ 3.5 m */
  stepU?: number;
  /** AABB 索引格边长（世界单位） */
  cellU?: number;
}

export function auditCoverage(model: Model, opts: CoverOpts = {}): CoverageAudit {
  const STEP = opts.stepU ?? 0.5;
  const CELL = opts.cellU ?? 8;
  const scene = buildScene(model, { planningMode: 'planner', furniture: false, markings: false });

  const isRoad = (s: SurfaceFeature) => s.group.startsWith('road');
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
      let rec: BlockCoverage | null = null;
      for (let i = 0; i < model.patches.length; i++) {
        const p = model.patches[i];
        if (p.blocked || !p.withinCity) continue;
        if (!pointInRing(new Pt(x, y), Array.from(p.shape))) continue;
        rec = recOf.get(i) ?? null;
        break;
      }
      if (!rec) continue;
      rec.totalM2 += cellA;

      let inBuilding = false;
      for (const b of scene.solids) if (pointInRing(new Pt(x, y), b.ring)) { inBuilding = true; break; }
      if (inBuilding) { rec.buildingM2 += cellA; continue; }

      const cands = grid.get(keyOf(Math.floor(x / CELL), Math.floor(y / CELL))) ?? [];
      const hits = cands.filter((s) => covers(s, x, y));
      if (hits.length === 0) {
        rec.holeM2 += cellA;
        if (holeSamples.length < 6) holeSamples.push(`(${x.toFixed(1)},${y.toFixed(1)})`);
        continue;
      }
      hits.sort((a, b) => b.y - a.y);
      const top = hits[0];
      if (isRoad(top)) rec.roadM2 += cellA;
      else if (isPlate(top)) rec.plateM2 += cellA;
      else if (isLot(top)) rec.plannedM2 += cellA;
      else rec.plannedM2 += cellA;

      const excl = hits.filter((h) => isLot(h) && !OVERLAY_RE.test(h.name));
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
      .filter((s) => !OVERLAY_RE.test(s.name))
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
