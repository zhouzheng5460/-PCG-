// 土地用途规划。
//
// 用同心圆 + 廊道模型的混合规则（现代城市最稳的一套经验规律），而不是随机贴标签：
//   中心  → CBD（高容积率塔楼）
//   中间环 + 临主干道 → 商业（沿街铺面 + 后场停车）
//   中间环 + 不临主路 → 住宅（板楼 + 院落 + 内部道路）
//   外圈 → 工业（厂房 + 堆场 + 货运停车）或绿地
// 再按"城市必须有公园和地面停车场"补位，避免某个种子下整城没有绿地。
//
// 用 Rng 而不是 Math.random：改路宽、拖顶点后重建必须得到同一套用途。

import { Pt } from '../core/geom';
import { Rng } from '../core/rng';
import type { Model } from './model';
import type { Patch } from './patch';
import type { LandUse } from '../scene/types';
import { USE_COLOR } from '../scene/palette';

/** 地块是否有一条边被主干道覆盖 —— 决定沿街商业的落位 */
export function frontsArterial(model: Model, patch: Patch): boolean {
  let hit = false;
  patch.shape.forEdge((v0, v1) => {
    if (hit) return;
    if (model.edgeIsArterial(v0, v1)) hit = true;
  });
  return hit;
}

export interface UsePlan {
  use: Map<Patch, LandUse>;
  /** 归一化半径（0 = 城市中心，1 = 城市边缘），UI 与内容生成都要用 */
  radius: Map<Patch, number>;
}

export function planLandUse(model: Model): UsePlan {
  const use = new Map<Patch, LandUse>();
  const radius = new Map<Patch, number>();

  // 禁建区不参与分区规划：既不占 CBD/商业/住宅的分档名额，
  // 也不会因为"这一档没地了"把别的街区挤走。但它们仍然要有一个用途 ——
  // 内容是"封闭地块 + 地坪、无建筑"，见 modern.ts 的 planReserved。
  const reserved = model.patches.filter((p) => p.blocked);
  const all = model.patches.filter((p) => !p.blocked);
  if (all.length === 0 && reserved.length === 0) return { use, radius };

  const R = Math.max(model.cityRadius, 1);

  // 半径按到原点的距离算 —— Voronoi 是从原点往外撒点的，城市中心就是原点。
  // 不能用 model.center，那是"某个参考顶点"，位置随种子漂移，会让整城的
  // 区位判断整体偏移（第一版就是这么错的：15 块地全长成工业区）。
  for (const patch of all) {
    radius.set(patch, patch.shape.centroid.length / R);
  }
  for (const patch of reserved) {
    radius.set(patch, patch.shape.centroid.length / R);
    // 半径照算（内容生成要用），但不进分位数、不抽用途
    use.set(patch, 'reserved');
  }

  const inside = all.filter((p) => p.withinCity);

  // 用分位数而不是绝对阈值：不管 6 块地还是 24 块地，都能分出中心/中间/外围三档
  const sorted = inside.slice().sort((a, b) => radius.get(a)! - radius.get(b)!);
  const rank = new Map<Patch, number>();
  sorted.forEach((p, i) => rank.set(p, sorted.length > 1 ? i / (sorted.length - 1) : 0));

  for (const patch of all) {
    if (!patch.withinCity) {
      // 城郊：1.3 倍半径以外不再生成内容，否则 3 倍半径的 Voronoi 地块
      // 会把城区埋进一片同质的绿地里（城看起来只剩中间一小块）
      if (radius.get(patch)! > 1.3) continue;
      use.set(patch, Rng.bool(0.18) ? 'industrial' : 'green');
      continue;
    }

    const q = rank.get(patch)!;
    const front = frontsArterial(model, patch);
    let u: LandUse;

    if (patch === model.plaza) {
      u = 'civic';
    } else if (q < 0.18) {
      u = Rng.bool(0.16) ? 'commercial' : 'cbd';
    } else if (q < 0.42) {
      u = front ? (Rng.bool(0.7) ? 'commercial' : 'civic') : Rng.bool(0.5) ? 'residential' : 'commercial';
    } else if (q < 0.72) {
      u = front ? (Rng.bool(0.5) ? 'commercial' : 'residential') : 'residential';
    } else if (q < 0.88) {
      // 外圈：住宅为主，公园次之，地面停车只是点缀。
      // 早先这里各 1/3，结果城郊有 1/4 的街区是空沥青场。
      u = Rng.bool(0.58) ? 'residential' : Rng.bool(0.72) ? 'park' : 'parking';
    } else {
      u = Rng.bool(0.45) ? 'industrial' : Rng.bool(0.5) ? 'green' : 'residential';
    }
    use.set(patch, u);
  }

  // 补位：保证城市里有绿地、有地面停车、有公共设施
  const count = (u: LandUse) => all.filter((p) => use.get(p) === u).length;
  const swapOne = (from: LandUse, to: LandUse) => {
    const pool = all.filter((p) => use.get(p) === from && p !== model.plaza && p.withinCity);
    if (pool.length === 0) return false;
    const pick = pool[Math.floor(Rng.float() * pool.length) % pool.length];
    use.set(pick, to);
    return true;
  };

  if (inside.length >= 6 && count('park') === 0) swapOne('residential', 'park');
  if (inside.length >= 6 && count('cbd') === 0) {
    // 中心必须有高层，否则整个城市没有一个视觉焦点
    const cand = inside
      .filter((p) => p !== model.plaza && use.get(p) !== 'civic')
      .sort((a, b) => radius.get(a)! - radius.get(b)!);
    if (cand.length > 0) use.set(cand[0], 'cbd');
  }
  if (inside.length >= 8 && count('parking') === 0) {
    if (!swapOne('residential', 'parking')) swapOne('commercial', 'parking');
  }
  if (inside.length >= 10 && count('civic') <= 1) {
    if (!swapOne('commercial', 'civic')) swapOne('residential', 'civic');
  }
  if (inside.length >= 10 && count('industrial') === 0) {
    const outer = inside
      .filter((p) => use.get(p) === 'residential' || use.get(p) === 'green')
      .sort((a, b) => radius.get(b)! - radius.get(a)!);
    if (outer.length > 0 && radius.get(outer[0])! > 0.55) use.set(outer[0], 'industrial');
  }

  return { use, radius };
}

/** 用途 → 中文名（UI 与导出分组都用） */
export const USE_LABEL: Record<LandUse, string> = {
  cbd: '中央商务',
  commercial: '商业',
  residential: '住宅',
  industrial: '工业',
  civic: '公共设施',
  park: '公园',
  parking: '停车场',
  green: '绿地',
  reserved: '禁建 / 保留',
};

export function useColor(u: LandUse): [number, number, number] {
  return USE_COLOR[u] ?? [0.6, 0.6, 0.6];
}
