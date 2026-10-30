// 覆盖率统计回归。
//
// 这一层守的是**数字的可信度**。HUD 的作用是回答"这版规则完善了没有"，
// 所以指标一旦失真，比没有指标更糟 —— 之前用「多边形面积求和」算绿地率，
// 得到 190.3%，原因很简单：街区先铺一整块草地底，地块内又各铺一遍草，
// 两者大面积重叠，加起来自然超过 100%。
//
// 断言分三类：
//   ① 恒等式：各类格数之和 == urban 总数（格子只有一个归属）
//   ② 边界：每个占比都在 [0,1]，且 绿 + 铺装 + 道路 + 建筑 ≤ 1 + 容差
//   ③ 单调性：把建筑全删掉，建筑密度必然下降、绿地率必然上升

import { Model } from '../src/town/model';
import { buildScene } from '../src/scene/build';
import { Cover, measureCover } from '../src/scene/cover';
import { ROAD_SPECS, u } from '../src/road/spec';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

const model = new Model({
  nPatches: 12,
  seed: 991337,
  plaza: true,
  style: {
    mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
    regularStreetWidth: u(ROAD_SPECS.collector.redLine),
    alleyWidth: u(ROAD_SPECS.local.redLine),
  },
});
model.generate();
const scene = buildScene(model);
const c = measureCover(scene);

const classes = [Cover.Green, Cover.Water, Cover.Soil, Cover.Hard, Cover.Road, Cover.Walk, Cover.Building];
const sum = classes.reduce((a, k) => a + (c.cells[k] ?? 0), 0);
ok(c.urban > 0, `栅格确实刷到了东西（${c.gw}×${c.gh}，urban=${c.urban} 格）`);
ok(sum === c.urban, `各类格数之和等于 urban（${sum} vs ${c.urban}）`);

const ratio = (k: Cover) => (c.cells[k] ?? 0) / c.urban;
for (const k of classes) {
  const r = ratio(k);
  ok(r >= 0 && r <= 1, `占比在 [0,1] 内（类 ${k} = ${(r * 100).toFixed(1)}%）`);
}

const green = ratio(Cover.Green);
const hard = ratio(Cover.Hard) + ratio(Cover.Soil);
const road = ratio(Cover.Road) + ratio(Cover.Walk);
const bld = ratio(Cover.Building);

// 这是最关键的一条：老算法就是在这里出 190% 的
ok(green <= 0.75, `绿地率不超过 75%（实测 ${(green * 100).toFixed(1)}%）`);
ok(green + hard + road + bld <= 1.001, `四类占比合计不超过 100%（${((green + hard + road + bld) * 100).toFixed(1)}%）`);
ok(green > 0.05, `绿地率不至于趋零（${(green * 100).toFixed(1)}%）`);
ok(road > 0.02, `道路面积率不至于趋零（${(road * 100).toFixed(1)}%）`);

// ---------------------------------------------------------------- ③ 守恒
//
// 去掉建筑体块后，原来被"建筑基底"占掉的格子应该**原样还给地面**：
// 可能是草、可能是铺装，取决于楼底下铺的是什么。
// 所以不能断言"绿地率必然上升"（实测就不上升 —— 楼都压在自己的铺装场地上），
// 只能断言**总量守恒**：绿 + 铺装 + 土 的增量，正好等于建筑基底消失的格数。
const noBuildings = { ...scene, solids: [] };
const c2 = measureCover(noBuildings);
const bld0 = c.cells[Cover.Building] ?? 0;
const bld2 = (c2.cells[Cover.Building] ?? 0) / c2.urban;
const groundKeys = [Cover.Green, Cover.Hard, Cover.Soil];
const ground0 = groundKeys.reduce((a, k) => a + (c.cells[k] ?? 0), 0);
const ground2 = groundKeys.reduce((a, k) => a + (c2.cells[k] ?? 0), 0);
const green2 = (c2.cells[Cover.Green] ?? 0) / c2.urban;
ok(bld2 === 0, `去掉建筑体块后建筑密度为 0（${(bld2 * 100).toFixed(1)}%）`);
ok(bld0 > 0, `原场景确实有建筑基底（${bld0} 格）`);
ok(
  Math.abs(ground2 - ground0 - bld0) <= c.urban * 0.01,
  `建筑基底原样还给地面（地面 ${ground0} → ${ground2}，建筑 ${bld0} 格）`
);
ok(green2 >= green - 1e-9, `去掉建筑后绿地率只增不减（${(green * 100).toFixed(1)}% → ${(green2 * 100).toFixed(1)}%）`);

// 决定性：同一个场景跑两遍必须得到同一组数字（栅格法不许有随机性）
const c3 = measureCover(buildScene(model));
ok(c3.urban === c.urban, `同场景两次测量 urban 一致（${c3.urban}）`);
ok(c3.cells[Cover.Green] === c.cells[Cover.Green], `同场景两次测量绿地格数一致`);

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
