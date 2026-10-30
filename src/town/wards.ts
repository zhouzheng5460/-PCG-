// 地块基类。
//
// 原版这里放的是 13 种中世纪 ward（Castle / Market / Slum / Cathedral …），
// 本项目只做现代城市，那些内容层已整体移除：地块内容一律由
// `town/modern.ts` 的 ModernWard 按土地用途规划。
// 保留下来的只有两类**空间**能力：
//   - getCityBlock()：按相邻道路宽度把地块内缩成可建区（与道路横断面同源）
//   - geometry：地块产出的建筑轮廓，供 Scene / SVG / GLB 读取

import { Polygon } from '../core/polygon';
import type { Patch } from './patch';
import type { Model } from './model';

export class Ward {
  model: Model;
  patch: Patch;
  geometry: Polygon[] = [];

  constructor(model: Model, patch: Patch) {
    this.model = model;
    this.patch = patch;
  }

  createGeometry(): void {
    this.geometry = [];
  }

  /**
   * 地块内缩得到可建区域；内缩量由相邻道路的宽度决定（与道路横断面同源）。
   * 这是整个系统的关键同源点：内缩量与 road/system 铺的车行道 / 人行道必须
   * 用同一个数，否则路面会压到建筑红线里，或者在路和楼之间留一条无主的缝。
   */
  getCityBlock(): Polygon {
    const insetDist: number[] = [];
    this.patch.shape.forEdge((v0, v1) => {
      insetDist.push(this.model.insetForEdge(this.patch, v0, v1));
    });

    return this.patch.shape.isConvex()
      ? this.patch.shape.shrink(insetDist)
      : this.patch.shape.buffer(insetDist);
  }
}
