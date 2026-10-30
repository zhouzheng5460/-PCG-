// 道路带几何：把中心线扩成有宽度的多边形。
// 2D 渲染、3D 挤出、GLB 导出共用这一份结果，保证"看到的路宽"就是"导出的路宽"。

import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';

const MITER_LIMIT = 3.0;

/** 中心线 → 带状多边形（左右各半宽，斜接拐角） */
export function roadBand(path: Pt[], width: number): Polygon | null {
  const pts = path.filter((p, i) => i === 0 || Pt.distance(p, path[i - 1]) > 1e-6);
  if (pts.length < 2) return null;

  const hw = width / 2;
  const left: Pt[] = [];
  const right: Pt[] = [];

  for (let i = 0; i < pts.length; i++) {
    let n: Pt;
    if (i === 0) {
      const d = pts[1].subtract(pts[0]).norm(1);
      n = new Pt(-d.y, d.x);
    } else if (i === pts.length - 1) {
      const d = pts[i].subtract(pts[i - 1]).norm(1);
      n = new Pt(-d.y, d.x);
    } else {
      const d0 = pts[i].subtract(pts[i - 1]).norm(1);
      const d1 = pts[i + 1].subtract(pts[i]).norm(1);
      const n0 = new Pt(-d0.y, d0.x);
      const n1 = new Pt(-d1.y, d1.x);
      const m = new Pt(n0.x + n1.x, n0.y + n1.y);
      const mlen = m.length;
      if (mlen < 1e-6) {
        n = n0;
      } else {
        const u = m.scale(1 / mlen);
        const cosHalf = u.dot(n0);
        const factor = 1 / Math.max(cosHalf, 1 / MITER_LIMIT);
        n = u.scale(factor);
      }
    }
    left.push(pts[i].add(n.scale(hw)));
    right.push(pts[i].subtract(n.scale(hw)));
  }

  const ring = left.concat(right.reverse());
  return ring.length >= 3 ? new Polygon(ring) : null;
}

/** 中心线 → 左右两条边线，渲染时比整块带更好控制颜色 */
export function roadEdges(path: Pt[], width: number): { left: Pt[]; right: Pt[] } | null {
  const band = roadBand(path, width);
  if (!band) return null;
  const half = path.length;
  return { left: band.slice(0, half), right: band.slice(half).reverse() };
}
