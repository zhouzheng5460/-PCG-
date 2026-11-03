// 把模型汇总成一份 Scene：道路、标线、地块内容、街道设施。
// 2D 编辑器、three.js 预览、GLB 导出都从这里取数据，三者不可能不一致。

import type { Model } from '../town/model';
import { buildRoadNet, roadSurfaces } from '../road/system';
import { roadMarkings } from '../road/markings';
import { streetFurniture } from '../town/furniture';
import { roadsideRailings } from '../town/railings';
import { ModernWard } from '../town/modern';
import { patchKey } from '../town/patch';
import { buildPlannerBundle, type PlanningMode } from './planner-bridge';
import type { LandUse, LotInfo, Scene, SolidFeature } from './types';
import { emptyScene, toCCW } from './types';

export interface SceneOptions {
  /** 建筑高度倍率 */
  heightScale?: number;
  /** 是否生成道路标线 */
  markings?: boolean;
  /** 是否生成行道树 / 路灯 */
  furniture?: boolean;
  /** 是否生成地块内容（建筑、铺装、车位） */
  lots?: boolean;
  /** 是否铺地面底板 */
  ground?: boolean;
  /** 是否包含城墙（若模型有） */
  /**
   * 规划模式（R8）：
   *   · legacy  —— 全部走现有的 legacy 地块规划（默认，行为不变）
   *   · planner —— industrial / multi_family / retail 三类由 Planner 接管
   *   · shadow  —— 渲染仍是 legacy，Planner 的方案叠成红色虚线轮廓
   */
  planningMode?: PlanningMode;
}

export function buildScene(model: Model, opts: SceneOptions = {}): Scene {
  const scene = emptyScene();
  const heightScale = opts.heightScale ?? 1;
  const wantLots = opts.lots !== false;

  // 1. 地面底板：只覆盖城内，避免地块铺满整张图
  if (opts.ground !== false) {
    for (const patch of model.patches) {
      if (!patch.withinCity) continue;
      if (patch.shape.length < 3) continue;
      scene.surfaces.push({
        name: 'ground',
        group: 'ground',
        ring: toCCW(Array.from(patch.shape)),
        mat: 'ground',
        y: -0.02,
      });
    }
  }

  // 2. 道路网 + 标线
  const net = buildRoadNet(model);
  roadSurfaces(net, scene.surfaces);
  if (opts.markings !== false) roadMarkings(net, scene.surfaces);

  // 3. 地块内容
  //
  //    Planner 模式（R8）：被 Planner 接管的地块，**完全不用 legacy 的 lot 内容** ——
  //    realizeSitePlan() 产出的建筑 / 地面 / 开口 / 车位直接进 Scene，
  //    之后不再经过任何 legacy 地块规划逻辑。这是 R8 的核心红线。
  if (wantLots) {
    const mode = opts.planningMode ?? 'legacy';
    const planner = mode === 'legacy' ? null : buildPlannerBundle(model, net, mode);

    for (let pi = 0; pi < model.patches.length; pi++) {
      const patch = model.patches[pi];
      const ward = patch.ward;
      if (!(ward instanceof ModernWard)) continue;
      const lot = ward.lot;
      if (!lot) continue;

      // ---- Planner 接管？
      //    注意：只在 **planner** 模式接管。shadow 模式渲染的仍然是 legacy，
      //    Planner 的方案只作为红色虚线 overlay 叠在上面（这是"两套结果并排看"的语义）。
      const pf = mode === 'planner' ? planner?.byParcel.get(patchKey(patch)) : undefined;
      if (pf) {
        scene.surfaces.push(...pf.surfaces);
        scene.paths.push(...pf.paths);
        scene.props.push(...pf.props);
        for (const s of pf.solids) {
          const scaled: SolidFeature = { ...s, h: s.h * heightScale };
          scene.solids.push(scaled);
        }
        scene.lots.push({
          index: pi,
          use: lot.use,
          area: lot.block ? Math.abs(lot.block.square) : 0,
          far: 0,
          buildings: pf.solids.length,
          parkingBays: 0,
          trees: 0,
        } satisfies LotInfo);
        continue;
      }

      scene.surfaces.push(...lot.surfaces);
      scene.paths.push(...lot.paths);
      scene.props.push(...lot.props);
      for (const s of lot.solids) {
        const scaled: SolidFeature = { ...s, h: s.h * heightScale };
        scene.solids.push(scaled);
      }

      scene.lots.push({
        index: pi,
        use: lot.use,
        area: lot.block ? Math.abs(lot.block.square) : 0,
        far: lot.buildings,
        buildings: lot.buildings,
        parkingBays: lot.bays,
        trees: lot.trees,
      } satisfies LotInfo);
    }

    // shadow 模式：Planner 的方案作为叠加层（2D 画红色虚线）
    if (planner && opts.planningMode === 'shadow') {
      scene.overlay = { solids: planner.overlay.solids, surfaces: planner.overlay.surfaces };
    }
    // 逐地块报告挂到 scene 上，供 Debug HUD 读取
    if (planner) scene.planner = planner;
  }

  // 4. 街道设施（护栏拆成横杆 path + 立柱 prop，见 town/rails.ts）
  if (opts.furniture !== false) {
    const f = streetFurniture(model, net);
    scene.props.push(...f.props);
    const rail = roadsideRailings(net);
    scene.paths.push(...rail.paths);
    scene.props.push(...rail.props);
  }

  // 5. 统计
  const byUse: Record<string, number> = {};
  for (const l of scene.lots) byUse[l.use] = (byUse[l.use] ?? 0) + 1;
  const propsByKind: Record<string, number> = {};
  for (const p of scene.props) propsByKind[p.kind] = (propsByKind[p.kind] ?? 0) + 1;

  scene.stats = {
    surfaces: scene.surfaces.length,
    solids: scene.solids.length,
    props: scene.props.length,
    paths: scene.paths.length,
    byUse,
    propsByKind,
  };

  return scene;
}

/** 供 UI 显示用的用途名 */
export function useSummary(scene: Scene): { use: LandUse; n: number }[] {
  return Object.entries(scene.stats.byUse)
    .map(([use, n]) => ({ use: use as LandUse, n }))
    .sort((a, b) => b.n - a.n);
}
