// 地块。原版 Patch 还带 withinWalls（是否在城墙内），城墙体系已随中世纪内容一起移除。

import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';
import type { Region } from '../core/voronoi';
import type { LandUse } from '../scene/types';
import type { Ward } from './wards';
import type { ZonePurpose } from './zones';

/**
 * 用户对单个地块的手动覆盖。
 *
 * 为什么需要这一层：用途分档（`planLandUse`）是**全城一次算完**的，
 * 它不知道"这一块我想做成商业"。要支持"点中地块改用途/改高度/改切分"，
 * 就必须有一条绕过自动分档的通道 —— 但又不能把自动分档改掉，
 * 否则用户清空覆盖之后回不到原样。
 *
 * 所以覆盖是**加法**：有覆盖就用覆盖，没有就走自动分档。
 */
export interface PatchEdit {
  /** 用地类型（覆盖 planLandUse 的结果） */
  use?: LandUse;
  /** 高度倍率，1 = 原样 */
  heightK?: number;
  /** 这个地块的切分目标面积（世界单位²）；不给就跟着全局「小地块边长」走 */
  parcelTargetA?: number;
}

export class Patch {
  shape: Polygon;
  ward: Ward | null = null;
  withinCity = false;
  /** 被禁建区整块占据（仍然产出地坪，只是不排建筑/不做用途分档） */
  blocked = false;
  /** 禁绘区的内容类型；普通地块为 undefined */
  purpose?: ZonePurpose;
  /** 用户手动覆盖（见 PatchEdit） */
  override?: PatchEdit;

  constructor(vertices: Pt[]) {
    this.shape = new Polygon(vertices);
  }

  static fromRegion(r: Region): Patch {
    return new Patch(r.vertices.map((tr) => tr.c));
  }
}

/**
 * 地块的身份键。
 *
 * 生成一次之后重建（拖顶点、改参数、改覆盖）会重新造 Patch 对象，
 * 引用相等就不作数了；而**下标**也不稳（切分会让数组长度变）。
 * 所以用质心取整当键：地块之间距离远大于 0.1 单位，一格不会撞。
 */
export function patchKey(p: Patch): string {
  let x = 0;
  let y = 0;
  const pts = Array.from(p.shape);
  for (const v of pts) {
    x += v.x;
    y += v.y;
  }
  const n = Math.max(1, pts.length);
  // 质心取到 0.1 单位（≈0.7 m），相邻地块的质心不可能落在同一格
  return `${Math.round((x / n) * 10)}:${Math.round((y / n) * 10)}`;
}
