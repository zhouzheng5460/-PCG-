// 移植自 Source/com/watabou/towngenerator/building/Cutter.hx

import { Pt, interpolate } from '../core/geom';
import { Polygon } from '../core/polygon';

export const Cutter = {
  bisect(poly: Polygon, vertex: Pt, ratio = 0.5, angle = 0.0, gap = 0.0): Polygon[] {
    const next = poly.next(vertex);
    const p1 = interpolate(vertex, next, ratio);
    const d = next.subtract(vertex);

    const cosB = Math.cos(angle);
    const sinB = Math.sin(angle);
    const vx = d.x * cosB - d.y * sinB;
    const vy = d.y * cosB + d.x * sinB;
    const p2 = new Pt(p1.x - vy, p1.y + vx);

    return poly.cut(p1, p2, gap);
  },

  radial(poly: Polygon, center: Pt | null = null, gap = 0.0): Polygon[] {
    const c = center ?? poly.centroid;
    const sectors: Polygon[] = [];
    poly.forEdge((v0, v1) => {
      let sector = new Polygon([c, v0, v1]);
      if (gap > 0) sector = sector.shrink([gap / 2, 0, gap / 2]);
      sectors.push(sector);
    });
    return sectors;
  },

  semiRadial(poly: Polygon, center: Pt | null = null, gap = 0.0): Polygon[] {
    let c = center;
    if (!c) {
      const centroid = poly.centroid;
      let best = poly[0];
      let bestD = Pt.distance(best, centroid);
      for (const v of poly) {
        const d = Pt.distance(v, centroid);
        if (d < bestD) {
          best = v;
          bestD = d;
        }
      }
      c = best;
    }

    const g = gap / 2;
    const sectors: Polygon[] = [];
    poly.forEdge((v0, v1) => {
      if (v0 !== c && v1 !== c) {
        let sector = new Polygon([c as Pt, v0, v1]);
        if (g > 0) {
          sector = sector.shrink([
            poly.findEdge(c as Pt, v0) === -1 ? g : 0,
            0,
            poly.findEdge(v1, c as Pt) === -1 ? g : 0,
          ]);
        }
        sectors.push(sector);
      }
    });
    return sectors;
  },

  ring(poly: Polygon, thickness: number): Polygon[] {
    const slices: { p1: Pt; p2: Pt; len: number }[] = [];
    poly.forEdge((v1, v2) => {
      const v = v2.subtract(v1);
      const n = v.rotate90().norm(thickness);
      slices.push({ p1: v1.add(n), p2: v2.add(n), len: v.length });
    });

    slices.sort((s1, s2) => s1.len - s2.len);

    const peel: Polygon[] = [];
    let p: Polygon = poly;
    for (let i = 0; i < slices.length; i++) {
      const halves = p.cut(slices[i].p1, slices[i].p2);
      p = halves[0];
      if (halves.length === 2) peel.push(halves[1]);
    }
    return peel;
  },
};
