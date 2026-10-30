// 移植自 Source/com/watabou/geom/Polygon.hx
// 原版是 abstract Polygon(Array<Point>)，带 @:forward 所以能直接用数组方法。
// 这里用 class Polygon extends Array<Pt> 等价表达：length / [i] / push / indexOf / splice 都可用。
// 关键：顶点是共享引用对象，不要在几何运算里创建重复顶点实例。

import { Pt, cross, distance2line, intersectLines, sign } from './geom';
import { Rng } from './rng';

const DELTA = 0.000001;

export class Polygon extends Array<Pt> {
  constructor(vertices?: Pt[]) {
    super();
    if (vertices) for (let i = 0; i < vertices.length; i++) this.push(vertices[i]);
  }

  static rect(w = 1.0, h = 1.0): Polygon {
    return new Polygon([
      new Pt(-w / 2, -h / 2),
      new Pt(w / 2, -h / 2),
      new Pt(w / 2, h / 2),
      new Pt(-w / 2, h / 2),
    ]);
  }

  static regular(n = 8, r = 1.0): Polygon {
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(new Pt(r * Math.cos(a), r * Math.sin(a)));
    }
    return new Polygon(pts);
  }

  static circle(r = 1.0): Polygon {
    return Polygon.regular(16, r);
  }

  set(p: Array<Pt>): void {
    for (let i = 0; i < p.length; i++) this[i].set(p[i]);
  }

  /** 带符号面积（与 Haxe get_square 一致） */
  get square(): number {
    let v1 = this[this.length - 1];
    let v2 = this[0];
    let s = v1.x * v2.y - v2.x * v1.y;
    for (let i = 1; i < this.length; i++) {
      v1 = v2;
      v2 = this[i];
      s += v1.x * v2.y - v2.x * v1.y;
    }
    return s * 0.5;
  }

  get perimeter(): number {
    let len = 0;
    this.forEdge((v0, v1) => {
      len += Pt.distance(v0, v1);
    });
    return len;
  }

  /** 圆 = 1.00，正方形 = 0.79，三角 = 0.60 */
  get compactness(): number {
    const p = this.perimeter;
    return (4 * Math.PI * this.square) / (p * p);
  }

  /** 顶点平均（原版注释：faster approximation of centroid） */
  get center(): Pt {
    const c = new Pt();
    for (const v of this) c.addEq(v);
    c.scaleEq(1 / this.length);
    return c;
  }

  get centroid(): Pt {
    let x = 0;
    let y = 0;
    let a = 0;
    this.forEdge((v0, v1) => {
      const f = cross(v0.x, v0.y, v1.x, v1.y);
      a += f;
      x += (v0.x + v1.x) * f;
      y += (v0.y + v1.y) * f;
    });
    const s6 = 1 / (3 * a);
    return new Pt(s6 * x, s6 * y);
  }

  /** 注意：原版这里的 contains 是"顶点是否存在"，不是点在多边形内 */
  contains(v: Pt): boolean {
    return this.indexOf(v) !== -1;
  }

  forEdge(f: (v0: Pt, v1: Pt) => void): void {
    const len = this.length;
    for (let i = 0; i < len; i++) f(this[i], this[(i + 1) % len]);
  }

  forSegment(f: (v0: Pt, v1: Pt) => void): void {
    for (let i = 0; i < this.length - 1; i++) f(this[i], this[i + 1]);
  }

  offset(p: Pt): void {
    for (const v of this) v.offset(p.x, p.y);
  }

  rotate(a: number): void {
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    for (const v of this) {
      const vx = v.x * cosA - v.y * sinA;
      const vy = v.y * cosA + v.x * sinA;
      v.setTo(vx, vy);
    }
  }

  isConvexVertexi(i: number): boolean {
    const len = this.length;
    const v0 = this[(i + len - 1) % len];
    const v1 = this[i];
    const v2 = this[(i + 1) % len];
    return cross(v1.x - v0.x, v1.y - v0.y, v2.x - v1.x, v2.y - v1.y) > 0;
  }

  isConvexVertex(v1: Pt): boolean {
    const v0 = this.prev(v1);
    const v2 = this.next(v1);
    return cross(v1.x - v0.x, v1.y - v0.y, v2.x - v1.x, v2.y - v1.y) > 0;
  }

  isConvex(): boolean {
    for (const v of this) if (!this.isConvexVertex(v)) return false;
    return true;
  }

  smoothVertexi(i: number, f = 1.0): Pt {
    const v = this[i];
    const len = this.length;
    const prev = this[(i + len - 1) % len];
    const next = this[(i + 1) % len];
    return new Pt((prev.x + v.x * f + next.x) / (2 + f), (prev.y + v.y * f + next.y) / (2 + f));
  }

  smoothVertex(v: Pt, f = 1.0): Pt {
    const prev = this.prev(v);
    const next = this.next(v);
    return new Pt(prev.x + v.x * f + next.x, prev.y + v.y * f + next.y).scale(1 / (2 + f));
  }

  /** 到最近顶点的距离（不是到多边形的真实距离） */
  distance(p: Pt): number {
    let v0 = this[0];
    let d = Pt.distance(v0, p);
    for (let i = 1; i < this.length; i++) {
      const v1 = this[i];
      const d1 = Pt.distance(v1, p);
      if (d1 < d) v0 = v1;
    }
    return d;
  }

  smoothVertexEq(f = 1.0): Polygon {
    const len = this.length;
    let v1 = this[len - 1];
    let v2 = this[0];
    const out: Pt[] = [];
    for (let i = 0; i < len; i++) {
      const v0 = v1;
      v1 = v2;
      v2 = this[(i + 1) % len];
      out.push(new Pt((v0.x + v1.x * f + v2.x) / (2 + f), (v0.y + v1.y * f + v2.y) / (2 + f)));
    }
    return new Polygon(out);
  }

  filterShort(threshold: number): Polygon {
    let i = 1;
    let v0 = this[0];
    let v1 = this[1];
    const result: Pt[] = [v0];
    do {
      do {
        v1 = this[i++];
      } while (Pt.distance(v0, v1) < threshold && i < this.length);
      v0 = v1;
      result.push(v0);
    } while (i < this.length);
    return new Polygon(result);
  }

  /** 内缩一条边（由该边起点定义）。顶点数不变，凹顶点上不太可靠 */
  inset(p1: Pt, d: number): void {
    const i1 = this.indexOf(p1);
    const i0 = i1 > 0 ? i1 - 1 : this.length - 1;
    const p0 = this[i0];
    const i2 = i1 < this.length - 1 ? i1 + 1 : 0;
    const p2 = this[i2];
    const i3 = i2 < this.length - 1 ? i2 + 1 : 0;
    const p3 = this[i3];

    let v0 = p1.subtract(p0);
    const v1 = p2.subtract(p1);
    const v2 = p3.subtract(p2);

    let cos = v0.dot(v1) / v0.length / v1.length;
    let z = v0.x * v1.y - v0.y * v1.x;
    let t = d / Math.sqrt(1 - cos * cos);
    if (z > 0) t = Math.min(t, v0.length * 0.99);
    else t = Math.min(t, v1.length * 0.5);
    t *= sign(z);
    this[i1] = p1.subtract(v0.norm(t));

    cos = v1.dot(v2) / v1.length / v2.length;
    z = v1.x * v2.y - v1.y * v2.x;
    t = d / Math.sqrt(1 - cos * cos);
    if (z > 0) t = Math.min(t, v2.length * 0.99);
    else t = Math.min(t, v1.length * 0.5);
    this[i2] = p2.add(v2.norm(t));
  }

  insetAll(d: number[]): Polygon {
    const p = new Polygon(this);
    for (let i = 0; i < p.length; i++) if (d[i] !== 0) p.inset(p[i], d[i]);
    return p;
  }

  insetEq(d: number): void {
    for (let i = 0; i < this.length; i++) this.inset(this[i], d);
  }

  /**
   * 按边内缩，允许每条边不同距离。
   * 处理自交时会插入交点，最后取面积最大的连通部分。
   */
  buffer(d: number[]): Polygon {
    const q = new Polygon();
    let i = 0;
    this.forEdge((v0, v1) => {
      const dd = d[i++];
      if (dd === 0) {
        q.push(v0);
        q.push(v1);
      } else {
        const v = v1.subtract(v0);
        const n = v.rotate90().norm(dd);
        q.push(v0.add(n));
        q.push(v1.add(n));
      }
    });

    let wasCut: boolean;
    let lastEdge = 0;
    do {
      wasCut = false;
      const n = q.length;
      for (let a = lastEdge; a < n - 2; a++) {
        lastEdge = a;
        const p11 = q[a];
        const p12 = q[a + 1];
        const x1 = p11.x;
        const y1 = p11.y;
        const dx1 = p12.x - x1;
        const dy1 = p12.y - y1;

        for (let b = a + 2; b < (a > 0 ? n : n - 1); b++) {
          const p21 = q[b];
          const p22 = b < n - 1 ? q[b + 1] : q[0];
          const x2 = p21.x;
          const y2 = p21.y;
          const dx2 = p22.x - x2;
          const dy2 = p22.y - y2;

          const int = intersectLines(x1, y1, dx1, dy1, x2, y2, dx2, dy2);
          if (int !== null && int.x > DELTA && int.x < 1 - DELTA && int.y > DELTA && int.y < 1 - DELTA) {
            const pn = new Pt(x1 + dx1 * int.x, y1 + dy1 * int.x);
            q.splice(b + 1, 0, pn);
            q.splice(a + 1, 0, pn);
            wasCut = true;
            break;
          }
        }
        if (wasCut) break;
      }
    } while (wasCut);

    const regular: number[] = [];
    for (let k = 0; k < q.length; k++) regular.push(k);

    let bestPart: Polygon | null = null;
    let bestPartSq = -Infinity;

    while (regular.length > 0) {
      const indices: number[] = [];
      const start = regular[0];
      let cur = start;
      do {
        indices.push(cur);
        const pos = regular.indexOf(cur);
        if (pos !== -1) regular.splice(pos, 1);

        const next = (cur + 1) % q.length;
        const v = q[next];
        let next1 = q.indexOf(v);
        if (next1 === next) next1 = q.lastIndexOf(v);
        cur = next1 === -1 ? next : next1;
      } while (cur !== start);

      const p = new Polygon(indices.map((k) => q[k]));
      const s = p.square;
      if (s > bestPartSq) {
        bestPart = p;
        bestPartSq = s;
      }
    }

    return bestPart as unknown as Polygon;
  }

  bufferEq(d: number): Polygon {
    const dists: number[] = [];
    for (let i = 0; i < this.length; i++) dists.push(d);
    return this.buffer(dists);
  }

  /** 对凸多边形效果很好，会产生凸多边形；不支持外扩 */
  shrink(d: number[]): Polygon {
    let q: Polygon = new Polygon(this);
    let i = 0;
    this.forEdge((v1, v2) => {
      const dd = d[i++];
      if (dd > 0) {
        const v = v2.subtract(v1);
        const n = v.rotate90().norm(dd);
        q = q.cut(v1.add(n), v2.add(n), 0)[0];
      }
    });
    return q;
  }

  shrinkEq(d: number): Polygon {
    const dists: number[] = [];
    for (let i = 0; i < this.length; i++) dists.push(d);
    return this.shrink(dists);
  }

  /** 沿一条边"削皮" */
  peel(v1: Pt, d: number): Polygon {
    const i1 = this.indexOf(v1);
    const i2 = i1 === this.length - 1 ? 0 : i1 + 1;
    const v2 = this[i2];
    const v = v2.subtract(v1);
    const n = v.rotate90().norm(d);
    return this.cut(v1.add(n), v2.add(n), 0)[0];
  }

  simplyfy(n: number): void {
    let len = this.length;
    while (len > n) {
      let result = 0;
      let min = Infinity;
      let b = this[len - 1];
      let c = this[0];
      for (let i = 0; i < len; i++) {
        const a = b;
        b = c;
        c = this[(i + 1) % len];
        const measure = Math.abs(a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
        if (measure < min) {
          result = i;
          min = measure;
        }
      }
      this.splice(result, 1);
      len--;
    }
  }

  findEdge(a: Pt, b: Pt): number {
    const index = this.indexOf(a);
    return index !== -1 && this[(index + 1) % this.length] === b ? index : -1;
  }

  next(a: Pt): Pt {
    return this[(this.indexOf(a) + 1) % this.length];
  }

  prev(a: Pt): Pt {
    return this[(this.indexOf(a) + this.length - 1) % this.length];
  }

  vector(v: Pt): Pt {
    return this.next(v).subtract(v);
  }

  vectori(i: number): Pt {
    return this[i === this.length - 1 ? 0 : i + 1].subtract(this[i]);
  }

  borders(another: Polygon): boolean {
    const len1 = this.length;
    const len2 = another.length;
    for (let i = 0; i < len1; i++) {
      const j = another.indexOf(this[i]);
      if (j !== -1) {
        const next = this[(i + 1) % len1];
        // 原版注释：理论上应返回 false，但实际依赖此宽松判断
        if (next === another[(j + 1) % len2] || next === another[(j + len2 - 1) % len2]) return true;
      }
    }
    return false;
  }

  getBounds(): { left: number; top: number; right: number; bottom: number } {
    const rect = { left: this[0].x, top: this[0].y, right: this[0].x, bottom: this[0].y };
    for (const v of this) {
      rect.left = Math.min(rect.left, v.x);
      rect.right = Math.max(rect.right, v.x);
      rect.top = Math.min(rect.top, v.y);
      rect.bottom = Math.max(rect.bottom, v.y);
    }
    return rect;
  }

  split(p1: Pt, p2: Pt): Polygon[] {
    return this.spliti(this.indexOf(p1), this.indexOf(p2));
  }

  spliti(i1: number, i2: number): Polygon[] {
    if (i1 > i2) {
      const t = i1;
      i1 = i2;
      i2 = t;
    }
    return [
      new Polygon(this.slice(i1, i2 + 1)),
      new Polygon(this.slice(i2).concat(this.slice(0, i1 + 1))),
    ];
  }

  /** 用一条无限长直线切分，返回两半；gap 为切缝宽度 */
  cut(p1: Pt, p2: Pt, gap = 0): Polygon[] {
    const x1 = p1.x;
    const y1 = p1.y;
    const dx1 = p2.x - x1;
    const dy1 = p2.y - y1;

    const len = this.length;
    let edge1 = 0;
    let ratio1 = 0;
    let edge2 = 0;
    let ratio2 = 0;
    let count = 0;

    for (let i = 0; i < len; i++) {
      const v0 = this[i];
      const v1 = this[(i + 1) % len];
      const x2 = v0.x;
      const y2 = v0.y;
      const dx2 = v1.x - x2;
      const dy2 = v1.y - y2;

      const t = intersectLines(x1, y1, dx1, dy1, x2, y2, dx2, dy2);
      if (t !== null && t.y >= 0 && t.y <= 1) {
        if (count === 0) {
          edge1 = i;
          ratio1 = t.x;
        } else if (count === 1) {
          edge2 = i;
          ratio2 = t.x;
        }
        count++;
      }
    }

    if (count === 2) {
      const point1 = p1.add(p2.subtract(p1).scale(ratio1));
      const point2 = p1.add(p2.subtract(p1).scale(ratio2));

      let half1 = new Polygon(this.slice(edge1 + 1, edge2 + 1));
      half1.unshift(point1);
      half1.push(point2);

      let half2 = new Polygon(this.slice(edge2 + 1).concat(this.slice(0, edge1 + 1)));
      half2.unshift(point2);
      half2.push(point1);

      if (gap > 0) {
        half1 = half1.peel(point2, gap / 2);
        half2 = half2.peel(point1, gap / 2);
      }

      const v = this.vectori(edge1);
      return cross(dx1, dy1, v.x, v.y) > 0 ? [half1, half2] : [half2, half1];
    }
    return [new Polygon(this)];
  }

  /** 顶点权重插值（用于郊区建筑密度衰减） */
  interpolate(p: Pt): number[] {
    let sum = 0;
    const dd: number[] = [];
    for (const v of this) {
      const d = 1 / Pt.distance(v, p);
      sum += d;
      dd.push(d);
    }
    return dd.map((d) => d / sum);
  }

  /** 仅供调试：判断点是否在多边形内部（射线法），原版没有 */
  pointInside(p: Pt): boolean {
    let inside = false;
    for (let i = 0, j = this.length - 1; i < this.length; j = i++) {
      const xi = this[i].x;
      const yi = this[i].y;
      const xj = this[j].x;
      const yj = this[j].y;
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}

// 供 ward 生成使用：随机取一个顶点
export function randomVertex(p: Polygon): Pt {
  return p[Math.floor(Rng.float() * p.length)];
}

export { distance2line };
