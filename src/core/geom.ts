// 逐行移植自 Source/com/watabou/geom/GeomUtils.hx + openfl.geom.Point
// 保留 Haxe 版本的对象身份语义：Point 是引用类型，全项目大量用 indexOf / === 判断顶点相同。

export class Pt {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  clone(): Pt {
    return new Pt(this.x, this.y);
  }

  set(q: Pt): void {
    this.x = q.x;
    this.y = q.y;
  }

  setTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  get length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  add(q: Pt): Pt {
    return new Pt(this.x + q.x, this.y + q.y);
  }

  subtract(q: Pt): Pt {
    return new Pt(this.x - q.x, this.y - q.y);
  }

  addEq(q: Pt): void {
    this.x += q.x;
    this.y += q.y;
  }

  subEq(q: Pt): void {
    this.x -= q.x;
    this.y -= q.y;
  }

  scale(f: number): Pt {
    return new Pt(this.x * f, this.y * f);
  }

  scaleEq(f: number): void {
    this.x *= f;
    this.y *= f;
  }

  offset(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  normalize(length = 1): void {
    const len = this.length;
    if (len === 0) {
      this.x = length;
      this.y = 0;
      return;
    }
    this.x = this.x * length / len;
    this.y = this.y * length / len;
  }

  // PointExtender.norm: 复制后再归一化，不修改自身
  norm(length = 1): Pt {
    const p = this.clone();
    p.normalize(length);
    return p;
  }

  dot(q: Pt): number {
    return this.x * q.x + this.y * q.y;
  }

  rotate90(): Pt {
    return new Pt(-this.y, this.x);
  }

  atan(): number {
    return Math.atan2(this.y, this.x);
  }

  static distance(a: Pt, b: Pt): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

/** 与 Haxe 版一致的求交：返回参数空间坐标 (t1 在第一条线上, t2 在第二条线上)，平行返回 null */
export function intersectLines(
  x1: number, y1: number, dx1: number, dy1: number,
  x2: number, y2: number, dx2: number, dy2: number
): Pt | null {
  const d = dx1 * dy2 - dy1 * dx2;
  if (d === 0) return null;

  const t2 = (dy1 * (x2 - x1) - dx1 * (y2 - y1)) / d;
  const t1 = dx1 !== 0 ? (x2 - x1 + dx2 * t2) / dx1 : (y2 - y1 + dy2 * t2) / dy1;

  return new Pt(t1, t2);
}

export function interpolate(p1: Pt, p2: Pt, ratio = 0.5): Pt {
  const d = p2.subtract(p1);
  return new Pt(p1.x + d.x * ratio, p1.y + d.y * ratio);
}

export function scalar(x1: number, y1: number, x2: number, y2: number): number {
  return x1 * x2 + y1 * y2;
}

export function cross(x1: number, y1: number, x2: number, y2: number): number {
  return x1 * y2 - y1 * x2;
}

export function distance2line(
  x1: number, y1: number, dx1: number, dy1: number, x0: number, y0: number
): number {
  return (dx1 * y0 - dy1 * x0 + (y1 + dy1) * x1 - (x1 + dx1) * y1) / Math.sqrt(dx1 * dx1 + dy1 * dy1);
}

export function sign(value: number): number {
  return value === 0 ? 0 : value < 0 ? -1 : 1;
}

export function gate(value: number, min: number, max: number): number {
  return value < min ? min : value < max ? value : max;
}

/** 点到线段的最短距离（原项目没有，禁建区交互需要） */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Pt.distance(p, a);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}
