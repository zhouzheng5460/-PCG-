// 把模型汇总成一份 Scene：道路、标线、地块内容、街道设施。
// 2D 编辑器、three.js 预览、GLB 导出都从这里取数据，三者不可能不一致。

import type { Model } from '../town/model';
import { buildRoadNet, roadSurfaces } from '../road/system';
import { roadMarkings } from '../road/markings';
import { streetFurniture } from '../town/furniture';
import { roadsideRailings } from '../town/railings';
import { ModernWard } from '../town/modern';
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
  if (wantLots) {
    for (const patch of model.patches) {
      const ward = patch.ward;
      if (!(ward instanceof ModernWard)) continue;
      const lot = ward.lot;
      if (!lot) continue;

      scene.surfaces.push(...lot.surfaces);
      scene.paths.push(...lot.paths);
      scene.props.push(...lot.props);
      for (const s of lot.solids) {
        const scaled: SolidFeature = { ...s, h: s.h * heightScale };
        scene.solids.push(scaled);
      }

      scene.lots.push({
        index: model.patches.indexOf(patch),
        use: lot.use,
        area: lot.block ? Math.abs(lot.block.square) : 0,
        far: lot.buildings,
        buildings: lot.buildings,
        parkingBays: lot.bays,
        trees: lot.trees,
      } satisfies LotInfo);
    }
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
