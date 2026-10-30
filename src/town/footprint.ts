// 城市轮廓：不是正圆，半径带 3 / 5 / 8 阶谐波起伏。
// 方格网切块和张量场切块都用同一份轮廓，保证两种布局的"城市形状"可比。

import { Pt } from '../core/geom';
import { Rng } from '../core/rng';

export function makeFootprint(R: number): Pt[] {
  const f1 = Rng.float() * 6.283;
  const f2 = Rng.float() * 6.283;
  const f3 = Rng.float() * 6.283;
  const out: Pt[] = [];
  const NF = 168;
  for (let k = 0; k < NF; k++) {
    const t = (k / NF) * Math.PI * 2;
    const r =
      R * (1 + 0.085 * Math.sin(3 * t + f1) + 0.05 * Math.sin(5 * t + f2) + 0.028 * Math.sin(8 * t + f3));
    out.push(new Pt(Math.cos(t) * r, Math.sin(t) * r));
  }
  return out;
}
