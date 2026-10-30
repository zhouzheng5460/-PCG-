// 禁绘区 / 方向线变换的单元测试。
//
// 这些东西的最终效果只能在浏览器里看（拖拽逻辑挂在画布事件上），
// 但"变换本身"是纯函数，可以在这里按数学性质验：
//   · 旋转 4 次 90° 应该回到原处（矩形还能保住矩形）
//   · 转 30° 之后矩形必须降级成多边形，否则形状会被"轴对齐"地掰回去
//   · 缩放 2 倍再缩 0.5 倍应该回到原面积
//   · 拖矩形一个角，对角必须钉住不动

import { Pt } from '../src/core/geom';
import { Zone, makeZone, zoneToPolygon, area } from '../src/town/zones';
import { makeGuide } from '../src/town/guide';
import {
  centerOf,
  mapGuide,
  mapZone,
  rotateMap,
  scaleMap,
  setGuideVertex,
  setZoneVertex,
  translateMap,
} from '../src/ui/zoneedit';

let fail = 0;
let total = 0;

function ok(name: string, cond: boolean, extra = ''): void {
  total++;
  if (!cond) {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const RECT: Zone = makeZone('r', '矩形', { kind: 'rect', a: new Pt(-10, -6), b: new Pt(6, 8) });
const CIRC: Zone = makeZone('c', '圆', { kind: 'circle', c: new Pt(2, 3), r: 5 });
const POLY: Zone = makeZone('p', '多边形', {
  kind: 'poly',
  pts: [new Pt(-4, -4), new Pt(5, -3), new Pt(3, 6), new Pt(-5, 3)],
});

// ---- 平移：形状类型必须保持，面积不变
for (const z of [RECT, CIRC, POLY]) {
  const m = mapZone(z, translateMap(7, -3));
  ok(`${z.label} 平移后形态不变`, m.shape.kind === z.shape.kind, `${z.shape.kind} → ${m.shape.kind}`);
  ok(`${z.label} 平移后面积不变`, near(area(zoneToPolygon(m)), area(zoneToPolygon(z)), 1e-9));
  const c0 = centerOf(zoneToPolygon(z));
  const c1 = centerOf(zoneToPolygon(m));
  ok(`${z.label} 平移量正确`, near(c1.x - c0.x, 7, 1e-9) && near(c1.y - c0.y, -3, 1e-9));
}

// ---- 旋转 90° × 4：回到原位；矩形始终是矩形
{
  let z = RECT;
  const c = centerOf(zoneToPolygon(RECT));
  for (let i = 0; i < 4; i++) z = mapZone(z, rotateMap(c, Math.PI / 2));
  ok('矩形转 4×90° 仍是矩形', z.shape.kind === 'rect', z.shape.kind);
  if (z.shape.kind === 'rect') {
    ok(
      '矩形转 4×90° 回到原位',
      near(z.shape.a.x, -10, 1e-6) && near(z.shape.a.y, -6, 1e-6) && near(z.shape.b.x, 6, 1e-6) && near(z.shape.b.y, 8, 1e-6),
      JSON.stringify(z.shape)
    );
  }
}

// ---- 转 30°：矩形必须降级成多边形，且面积守恒
{
  const c = centerOf(zoneToPolygon(RECT));
  const m = mapZone(RECT, rotateMap(c, Math.PI / 6));
  ok('矩形转 30° 降级为多边形', m.shape.kind === 'poly', m.shape.kind);
  ok('矩形转 30° 面积守恒', near(area(zoneToPolygon(m)), area(zoneToPolygon(RECT)), 1e-6));
  ok('矩形转 30° 仍闭合 4 个点', zoneToPolygon(m).length === 4, String(zoneToPolygon(m).length));
}

// ---- 圆：旋转不改半径，缩放按 k 变半径
{
  const c = CIRC.shape.kind === 'circle' ? CIRC.shape.c : new Pt();
  const r0 = CIRC.shape.kind === 'circle' ? CIRC.shape.r : 0;
  const rot = mapZone(CIRC, rotateMap(new Pt(0, 0), Math.PI / 3));
  ok('圆旋转后还是圆', rot.shape.kind === 'circle', rot.shape.kind);
  if (rot.shape.kind === 'circle') ok('圆旋转半径不变', near(rot.shape.r, r0, 1e-9), `${rot.shape.r} vs ${r0}`);

  const sc = mapZone(CIRC, scaleMap(c, 2.5));
  if (sc.shape.kind === 'circle') ok('圆缩放 2.5× 半径', near(sc.shape.r, r0 * 2.5, 1e-9), `${sc.shape.r}`);
}

// ---- 缩放往返
{
  const c = centerOf(zoneToPolygon(POLY));
  const a0 = area(zoneToPolygon(POLY));
  let z = mapZone(POLY, scaleMap(c, 2));
  ok('多边形放大 2 倍面积 ×4', near(area(zoneToPolygon(z)), a0 * 4, 1e-6), `${area(zoneToPolygon(z))} vs ${a0 * 4}`);
  z = mapZone(z, scaleMap(c, 0.5));
  ok('多边形缩放往返回原面积', near(area(zoneToPolygon(z)), a0, 1e-6));
}

// ---- 改形状：拖矩形一个角，对角必须钉住
{
  const quad = zoneToPolygon(RECT); // [(-10,-6),(6,-6),(6,8),(-10,8)]
  const idx = quad.findIndex((p) => near(p.x, -10) && near(p.y, -6));
  ok('矩形角点索引可定位', idx >= 0, String(idx));
  const m = setZoneVertex(RECT, idx, new Pt(-14, -9));
  ok('拖角后仍是矩形', m.shape.kind === 'rect', m.shape.kind);
  if (m.shape.kind === 'rect') {
    const stillHas = [m.shape.a, m.shape.b].some((p) => near(p.x, 6) && near(p.y, 8));
    ok('拖角后对角 (6,8) 仍被包含', stillHas, JSON.stringify(m.shape));
  }
}

// ---- 改形状：圆只改半径
{
  const m = setZoneVertex(CIRC, 0, new Pt(12, 3));
  ok('圆改形状仍是圆', m.shape.kind === 'circle', m.shape.kind);
  if (m.shape.kind === 'circle' && CIRC.shape.kind === 'circle') {
    ok('圆把手拖到 (12,3) 半径变 10', near(m.shape.r, 10, 1e-9), String(m.shape.r));
  }
}

// ---- 方向线
{
  const g = makeGuide('g', '线', [new Pt(-5, 0), new Pt(5, 0), new Pt(10, 4)]);
  const c = centerOf(g.pts);
  const rot = mapGuide(g, rotateMap(c, Math.PI / 2));
  ok('方向线旋转后点数不变', rot.pts.length === 3);
  ok(
    '方向线旋转 90° 后长度不变',
    near(
      Math.hypot(rot.pts[1].x - rot.pts[0].x, rot.pts[1].y - rot.pts[0].y),
      10,
      1e-6
    ),
    String(Math.hypot(rot.pts[1].x - rot.pts[0].x, rot.pts[1].y - rot.pts[0].y))
  );
  const moved = mapGuide(g, translateMap(3, 3));
  ok('方向线平移逐点生效', near(moved.pts[2].x, 13) && near(moved.pts[2].y, 7));
  const one = setGuideVertex(g, 0, new Pt(-9, -9));
  ok('方向线改单点', near(one.pts[0].x, -9) && near(one.pts[1].x, 5));
  ok('方向线原对象未被就地修改', near(g.pts[0].x, -5), String(g.pts[0].x));
}

console.log(`# ${fail === 0 ? 'PASS' : 'FAIL'} — ${total} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
