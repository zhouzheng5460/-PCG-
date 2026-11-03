// P0 验收：面契约（外环 + 洞）必须真的贯通到三角化
//
// 验收方式不看截图、只算数：
//   外环 40×40（1600 m² 等价单位²），中间挖 10×10 的洞（100）→ 三角化后的
//   三角形总面积必须等于 1500，且洞心必须落在"没有三角形覆盖"的位置。
// 另外验 surfaceInset / surfaceUnion / surfaceSubtract 是否保留洞。

import { Pt } from '../src/core/geom';
import {
  surface,
  surfaceArea,
  surfaceUnion,
  surfaceSubtract,
  surfaceInset,
  surfaceAnchor,
  insideSurface,
  type PlanSurface,
} from '../src/town/planning/core/surface';
import { triangulate } from '../src/export/mesh';

let fail = 0;
let n = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  n++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  new Pt(x0, y0),
  new Pt(x1, y0),
  new Pt(x1, y1),
  new Pt(x0, y1),
];

/** 三角形面积和 */
function triArea(ring: Pt[], holes: Pt[][], idx: number[]): number {
  const all = [...ring, ...holes.flat()];
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const p0 = all[idx[i]];
    const p1 = all[idx[i + 1]];
    const p2 = all[idx[i + 2]];
    a += Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) / 2;
  }
  return a;
}

// ① 带洞面：三角化面积 = 外环 − 洞
{
  const outer = rect(0, 0, 40, 40);
  const hole = rect(15, 15, 25, 25);
  const s = surface(outer, [hole]);
  ok('面面积 = 外环 − 洞', Math.abs(surfaceArea(s) - 1500) < 1e-6, `${surfaceArea(s)}`);

  const idx = triangulate(outer, [hole]);
  ok('带洞三角化有输出', idx.length > 0);
  const a = triArea(outer, [hole], idx);
  ok('三角化面积 = 1500', Math.abs(a - 1500) < 1, `${a.toFixed(2)}`);

  // 洞心必须有三角形覆盖（说明 earcut 没有把洞填上）
  const all = [...outer, ...hole];
  let covers = false;
  const cx = 20;
  const cy = 20;
  for (let i = 0; i < idx.length; i += 3) {
    const p0 = all[idx[i]];
    const p1 = all[idx[i + 1]];
    const p2 = all[idx[i + 2]];
    const d1 = (p1.x - p0.x) * (cy - p0.y) - (p1.y - p0.y) * (cx - p0.x);
    const d2 = (p2.x - p1.x) * (cy - p1.y) - (p2.y - p1.y) * (cx - p1.x);
    const d3 = (p0.x - p2.x) * (cy - p2.y) - (p0.y - p2.y) * (cx - p2.x);
    if (d1 >= 0 && d2 >= 0 && d3 >= 0) covers = true;
    if (d1 <= 0 && d2 <= 0 && d3 <= 0) covers = true;
  }
  ok('洞心没有被三角形盖住', !covers);
  console.log(`  带洞面：面积 ${a.toFixed(1)} / 洞心覆盖 ${covers}`);
}

// ② 布尔运算保留洞
{
  const big = surface(rect(0, 0, 40, 40));
  const cut = surface(rect(10, 10, 30, 30));
  const diff = surfaceSubtract([big], [cut]);
  ok('difference 得到 1 块', diff.length === 1, `${diff.length}`);
  if (diff.length === 1) {
    ok('difference 保留洞', diff[0].holes.length === 1, `${diff[0].holes.length}`);
    ok('difference 面积 = 1200', Math.abs(surfaceArea(diff[0]) - 1200) < 1e-6, `${surfaceArea(diff[0])}`);
  }

  const u = surfaceUnion([surface(rect(0, 0, 20, 40)), surface(rect(20, 0, 40, 40))]);
  ok('union 合并成 1 块', u.length === 1, `${u.length}`);
  ok('union 面积 = 1600', u.length === 1 && Math.abs(surfaceArea(u[0]) - 1600) < 1e-6, u.length ? `${surfaceArea(u[0])}` : '');
}

// ③ 内缩：洞要变大（净面积减少）
{
  const s = surface(rect(0, 0, 40, 40), [rect(15, 15, 25, 25)]);
  const inset = surfaceInset(s, 2);
  ok('inset 有输出', inset.length >= 1, `${inset.length}`);
  if (inset.length >= 1) {
    const a = surfaceArea(inset[0]);
    ok('inset 后面积变小', a < 1500 && a > 1000, `${a.toFixed(1)}`);
    ok('inset 后洞还在', inset[0].holes.length === 1, `${inset[0].holes.length}`);
  }
}

// ④ 核心点与点在面内
{
  const s = surface(rect(0, 0, 40, 40), [rect(15, 15, 25, 25)]);
  const a = surfaceAnchor(s, 40);
  ok('核心点在面内', insideSurface(a, s), `${a.x.toFixed(1)},${a.y.toFixed(1)}`);
  ok('核心点不在洞里', !(a.x > 15 && a.x < 25 && a.y > 15 && a.y < 25), `${a.x.toFixed(1)},${a.y.toFixed(1)}`);
  ok('洞内点判为面外', !insideSurface(new Pt(20, 20), s));
  ok('环内点判为面内', insideSurface(new Pt(5, 5), s));
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
