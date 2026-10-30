// 道路等级与"边的规范键"。
//
// 单独一个模块，是因为它被两处需要，彼此不能互相 import：
//   grid.ts     —— 方格网 / 场线 / 放射环切块
//   field/*     —— 张量场 + 流线切块
// 两边都要给"地块的某条边"定等级，下游（内缩、横断面、标线）只认这个等级。

import { Pt } from '../core/geom';

/** 道路等级：主干道 / 次干道 / 支路 */
export type EdgeClass = 'arterial' | 'collector' | 'local';

/** 边的规范键：两个端点坐标排序后拼起来，和顶点对象身份无关 */
export function edgeKey(a: Pt, b: Pt): string {
  const k = (p: Pt) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const ka = k(a);
  const kb = k(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * 第 k 档街的等级 —— 按 **6 : 3 : 1** 的断面配比排：
 *
 *   k ≡ 1 (mod 10)       → 主干路（双向六车道）  10%
 *   k ≡ 5, 9 (mod 10)    → 支路  （双向两车道）  20%
 *   其余                 → 次干路（双向四车道）  70%
 *
 * 两个约定，都是踩过坑才定下来的：
 *
 * ① 主干道格位在 **1** 而不是 0。族内是按"离中心第几档"排的（`d = ceil(|rank - 中心|)`），
 *    中心那条线 d 只有一个值、两侧各一条的 d 却出现两次 —— 把主干放在 d=0 等于
 *    整族只出一条六车道，实测只占 7%（该 10%）。放在 d=1 就让中心那对都吃到，
 *    每一档的线数与比例才对得上。
 *
 * ② 支路格位只给 2/10（而不是 3/10）：`subdivideLargePatches` 切大块时新造的边
 *    一律记支路，那部分又贡献约 10 个百分点的长度。两处加起来才落到 6 : 3 : 1。
 */
export function lineClassOf(k: number, period = 10): EdgeClass {
  const n = Math.max(4, Math.round(period));
  const q = ((k % n) + n) % n;
  if (q === 1) return 'arterial';
  if (q === 5 || q === 9) return 'local';
  return 'collector';
}

export function classRank(c: EdgeClass): number {
  return c === 'arterial' ? 3 : c === 'collector' ? 2 : 1;
}
