// 地块。原版 Patch 还带 withinWalls（是否在城墙内），城墙体系已随中世纪内容一起移除。

import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';
import type { Region } from '../core/voronoi';
import type { LandUse } from '../scene/types';
import type { Ward } from './wards';
import type { ZonePurpose } from './zones';
import type { ParcelPattern } from './params';

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
  /**
   * 这一块**指定**用哪种切分模式；不给就按全局「切分模式比重」抽。
   *
   * 全局比重管的是"整座城的肌理配比"，但总有那么一两块地读起来不对：
   * 沿主干道那块该切成排屋，斜街对面那块该顺着张量场转。单块指定就是
   * 为这一种需求留的通道 —— 也是唯一能"点一下就看到某种模式长什么样"的办法。
   */
  pattern?: ParcelPattern;
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
  /**
   * 本次生成**实际**用到的切分模式（抽签的结果，或用户指定的那个）。
   *
   * 只给面板读：全局比重是"抽签"，用户点中一块地想确认"这块到底切成了什么样"，
   * 光看画面得对着五种肌理猜。留一个字段比在 UI 里重跑一遍抽签可靠 ——
   * 重跑要复用同一条随机流，稍有偏差就是"面板报的和画面不是一回事"。
   */
  usedPattern?: ParcelPattern;

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
