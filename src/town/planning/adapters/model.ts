// Site Planning Core · Model 适配器
//
// 把工程现有的 `Model / Patch / RoadNet` 翻译成纯数据的 `SiteContext`。
// 放在 adapters/ 而不是 core/ 是刻意的：core 只认 PlanSurface 和 SiteRoadEdge，
// 不认识 Model；将来换城市数据结构只改这一层。

import { Model } from '../../model';
import { Patch, patchKey } from '../../patch';
import { buildRoadNet, type RoadNet } from '../../../road/system';
import type { Pt as GeoPt } from '../../../core/geom';
import { surface, insetPerEdge, surfaceInset, surfaceArea, type PlanSurface } from '../core/surface';
import { buildSiteContext, queryNeighbors, summarizeSite, eligibleArchetypes } from '../core/context';
import type { SiteContext, SiteRoadEdge, SiteTypology } from '../core/types';

export interface FromModelOptions {
  /** 复用已有路网（一次生成内多块地要读，别每块都 buildRoadNet） */
  net?: RoadNet;
  /** 退线（世界单位，默认 5 m） */
  setback?: number;
  typology?: SiteTypology;
  /** 相邻地块的 bbox 预筛半径（世界单位） */
  neighborRadius?: number;
}

/**
 * 从一个 Patch 读出 SiteContext。
 *
 * 关键点：`RoadEdge.patchL / patchR` 直接记录了这条路边是哪个地块 ——
 * 所以"这个地块临哪几条路"是**精确引用**，不是几何最近邻猜出来的。
 */
export function siteContextFromModel(model: Model, patch: Patch, opts: FromModelOptions = {}): SiteContext {
  const net = opts.net ?? buildRoadNet(model);
  const edges = edgesForPatch(net, patch);
  const use = useOf(patch);

  return buildSiteContext({
    parcelId: patchKey(patch),
    parcel: parcelOf(net, patch),
    use,
    typology: opts.typology,
    edges,
    setback: opts.setback,
  });
}

/**
 * patch → 地块（红线以内）。
 *
 * **patch 的边是道路中心线**，直接拿 `patch.shape` 当地块等于把半条路吃进来 ——
 * 实测旧口径下 99 块地全部与路面重叠、重叠占地块总面积 33.5%（最严重的一块 159%）。
 * 地块必须沿每条边让出各自的「车行道 + 人行道 + 绿化带」，而各边宽度不同
 *（一条街 10 m 红线、另一条 28 m），所以用变距内缩。
 */
function parcelOf(net: RoadNet, patch: Patch): PlanSurface {
  const ring = Array.from(patch.shape) as GeoPt[];
  if (ring.length < 3) return surface(ring);
  const dists = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const e = findEdge(net, patch, a, b);
    if (!e) return 0;
    const isL = e.patchL === patch;
    return isL ? e.carL + e.swL + e.vgL : e.carR + e.swR + e.vgR;
  });
  const inset = insetPerEdge(ring, dists);
  const before = Math.abs(
    ring.reduce((acc, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return acc + p.x * q.y - q.x * p.y;
    }, 0) / 2
  );
  if (inset.length < 3 || Math.abs(surfaceArea(surface(inset))) < before * 0.15) {
    // 内缩把地块吃光了：退回"统一 2 m 内缩"，让开一点路缘。
    // **不能**直接返回原始 patch —— 那等于把半条路当成地块。
    const uniform = surfaceInset(surface(Array.from(patch.shape)), 0.3);
    return uniform.length > 0 && surfaceArea(uniform[0]) > before * 0.05
      ? uniform[0]
      : surface(Array.from(patch.shape));
  }
  return surface(inset);
}

/** 找 patch 上 (a,b) 这条边对应的 road edge */
function findEdge(net: RoadNet, patch: Patch, a: GeoPt, b: GeoPt) {
  for (const e of net.edges) {
    if (e.patchL !== patch && e.patchR !== patch) continue;
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e;
  }
  return null;
}

/** 这个地块临的全部道路边 → 纯数据 */
export function edgesForPatch(net: RoadNet, patch: Patch): SiteRoadEdge[] {
  const out: SiteRoadEdge[] = [];
  for (const e of net.edges) {
    const isL = e.patchL === patch;
    const isR = e.patchR === patch;
    if (!isL && !isR) continue;
    out.push({
      key: e.key,
      a: e.a,
      b: e.b,
      len: e.len,
      cls: e.cls,
      // 地块在哪一侧，就用那一侧的断面宽度
      carriageSide: isL ? e.carL : e.carR,
      sidewalk: isL ? e.swL : e.swR,
      median: e.median,
    });
  }
  return out;
}

/**
 * 批量读一批地块（Phase 2 的入口）。
 *
 * 邻接先用"同城地块里 bbox 靠近的"缩小范围，再交给 queryNeighbors ——
 * 城市规模几百块地，这一步是毫秒级，不需要 RBush。
 */
export function siteContextsForModel(model: Model, opts: FromModelOptions = {}): SiteContext[] {
  const net = opts.net ?? buildRoadNet(model);
  const patches = model.patches.filter((p) => !p.blocked);
  const radius = opts.neighborRadius ?? 1.6;
  const ctxs: SiteContext[] = [];

  for (const p of patches) {
    const ctx = siteContextFromModel(model, p, { ...opts, net });
    // 只把 bbox 附近的邻居喂给 queryNeighbors
    const near = patches
      .filter((q) => q !== p && bboxNear(Array.from(p.shape), Array.from(q.shape), radius))
      .map((q) => ({ parcelId: patchKey(q), use: useOf(q), parcel: surface(Array.from(q.shape)) }));
    ctx.neighbors = queryNeighbors(
      { parcelId: ctx.parcelId, use: ctx.use, parcel: ctx.parcel },
      near,
      radius
    );
    ctxs.push(ctx);
  }
  return ctxs;
}

/** 读一个地块 + 给出够格的 archetype（Phase 1 的最终验收形态） */
export function planSummary(model: Model, patch: Patch, opts: FromModelOptions = {}) {
  const ctx = siteContextFromModel(model, patch, opts);
  const shape = summarizeSite(ctx);
  return { ctx, shape, archetypes: eligibleArchetypes(ctx.typology, shape) };
}

function bboxNear(a: Pt[], b: Pt[], pad: number): boolean {
  let aMinX = Infinity, aMaxX = -Infinity, aMinY = Infinity, aMaxY = -Infinity;
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (const p of a) {
    if (p.x < aMinX) aMinX = p.x;
    if (p.x > aMaxX) aMaxX = p.x;
    if (p.y < aMinY) aMinY = p.y;
    if (p.y > aMaxY) aMaxY = p.y;
  }
  for (const p of b) {
    if (p.x < bMinX) bMinX = p.x;
    if (p.x > bMaxX) bMaxX = p.x;
    if (p.y < bMinY) bMinY = p.y;
    if (p.y > bMaxY) bMaxY = p.y;
  }
  const gapX = Math.max(0, Math.max(aMinX - bMaxX, bMinX - aMaxX));
  const gapY = Math.max(0, Math.max(aMinY - bMaxY, bMinY - aMaxY));
  return Math.hypot(gapX, gapY) <= pad;
}

type Pt = { x: number; y: number };

/**
 * 地块用途的读法。
 *
 * 用途不在基类 Ward 上，而是 `ModernWard.use`（生成时按分区计划定下来的那一份）。
 * 手动覆盖优先 —— 与 model.buildAll 里的优先级保持一致。
 */
function useOf(patch: Patch): string {
  const ov = patch.override?.use;
  if (ov) return ov;
  const w = patch.ward as unknown as { use?: string } | null;
  return w?.use ?? 'residential';
}
