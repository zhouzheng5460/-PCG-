// 禁绘区 / 方向线的几何变换：平移、绕点旋转、绕点缩放、改单点。
//
// 单独成模块，是因为 2D 浮动工具条要对两类对象做同一套操作，
// 而 Zone 有四种形态（矩形 / 圆 / 多边形），变换后**能不能保持原形态**必须分别判断：
//   矩形绕非 90° 旋转之后就不再轴对齐了，只能降级成多边形；
//   圆做平移 / 等比缩放 / 旋转变换后还是圆（旋转只挪圆心，半径不变）；
//   多边形随便怎么变都还是多边形。
// 这些判断散在交互代码里最容易出错，集中在这里，一次写完。

import { Pt } from '../core/geom';
import { Zone, ccw } from '../town/zones';
import type { FieldGuide } from '../town/guide';

export type PointMap = (p: Pt) => Pt;

export function rotateAbout(p: Pt, o: Pt, ang: number): Pt {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  return new Pt(o.x + dx * c - dy * s, o.y + dx * s + dy * c);
}

export function scaleAbout(p: Pt, o: Pt, k: number): Pt {
  return new Pt(o.x + (p.x - o.x) * k, o.y + (p.y - o.y) * k);
}

export const translateMap =
  (dx: number, dy: number): PointMap =>
  (p) =>
    new Pt(p.x + dx, p.y + dy);

export const rotateMap =
  (o: Pt, ang: number): PointMap =>
  (p) =>
    rotateAbout(p, o, ang);

export const scaleMap =
  (o: Pt, k: number): PointMap =>
  (p) =>
    scaleAbout(p, o, k);

/** 平均中心。折线（2 点）也适用，所以不用面积质心 */
export function centerOf(pts: Pt[]): Pt {
  if (pts.length === 0) return new Pt();
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / pts.length, y / pts.length);
}

function rectCorners(a: Pt, b: Pt): Pt[] {
  return [new Pt(a.x, a.y), new Pt(b.x, a.y), new Pt(b.x, b.y), new Pt(a.x, b.y)];
}

/** 变换后的四边形是否仍然轴对齐（矩形能不能保住） */
function axisAligned(quad: Pt[]): boolean {
  let span = 0;
  for (const p of quad) span = Math.max(span, Math.abs(p.x), Math.abs(p.y));
  const eps = Math.max(1e-6, span * 1e-6);
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    if (Math.abs(a.x - b.x) > eps && Math.abs(a.y - b.y) > eps) return false;
  }
  return true;
}

/**
 * 对禁绘区做点变换。
 * 矩形保持矩形（除非被转歪），圆保持圆（半径按参考点位移算），多边形逐点变换。
 */
export function mapZone(z: Zone, f: PointMap): Zone {
  const s = z.shape;
  if (s.kind === 'circle') {
    const c = f(s.c);
    // 半径取"圆周上一点被映射后到新圆心的距离"：
    // 平移/旋转保持距离，等比缩放正好放大 k 倍，都不需要额外区分
    const ref = f(new Pt(s.c.x + s.r, s.c.y));
    return { ...z, shape: { kind: 'circle', c, r: Math.max(0.5, Pt.distance(c, ref)) } };
  }
  if (s.kind === 'rect') {
    const quad = rectCorners(s.a, s.b).map(f);
    if (axisAligned(quad)) {
      const xs = quad.map((p) => p.x);
      const ys = quad.map((p) => p.y);
      return {
        ...z,
        shape: {
          kind: 'rect',
          a: new Pt(Math.min(...xs), Math.min(...ys)),
          b: new Pt(Math.max(...xs), Math.max(...ys)),
        },
      };
    }
    return { ...z, shape: { kind: 'poly', pts: ccw(quad) } };
  }
  return { ...z, shape: { kind: 'poly', pts: s.pts.map(f) } };
}

export function mapGuide(g: FieldGuide, f: PointMap): FieldGuide {
  return { ...g, pts: g.pts.map(f) };
}

/**
 * 改单个顶点（"改形状"工具）。
 *
 * 矩形拖角：对角固定，构成新矩形；拖到对角另一侧会翻面，用 min/max 兜住。
 * 圆：任何一个顶点都当成"半径把手"，只改半径。
 * 多边形 / 折线：直接改那一个点。
 */
export function setZoneVertex(z: Zone, index: number, p: Pt): Zone {
  const s = z.shape;
  if (s.kind === 'circle') {
    return { ...z, shape: { kind: 'circle', c: s.c, r: Math.max(0.5, Pt.distance(s.c, p)) } };
  }
  if (s.kind === 'rect') {
    const quad = rectCorners(s.a, s.b);
    if (index < 0 || index >= 4) return z;
    const opp = quad[(index + 2) % 4];
    const xs = [opp.x, p.x];
    const ys = [opp.y, p.y];
    return {
      ...z,
      shape: {
        kind: 'rect',
        a: new Pt(Math.min(...xs), Math.min(...ys)),
        b: new Pt(Math.max(...xs), Math.max(...ys)),
      },
    };
  }
  const pts = s.pts.map((q, i) => (i === index ? new Pt(p.x, p.y) : q));
  return { ...z, shape: { kind: 'poly', pts } };
}

export function setGuideVertex(g: FieldGuide, index: number, p: Pt): FieldGuide {
  return { ...g, pts: g.pts.map((q, i) => (i === index ? new Pt(p.x, p.y) : q)) };
}
