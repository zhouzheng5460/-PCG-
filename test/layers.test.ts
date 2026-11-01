// 图层显隐回归。
//
// 这一层只守一件事：**每一个场景要素都必然属于一个登记过的图层**。
// 之前"关掉行道树，地块里的树还在"就是因为地块里的树走 lot.props，
// 而显隐开关只管 streetFurniture —— 有要素在开关之外，用户就会觉得"不受控"。
//
// 所以断言分成三类：
//   ① 无孤儿：四类要素的 layerOf* 结果全部能在清单里找到；
//   ② 无漏项：清单里的每一项都真的能被过滤（false 时确实被剔除）；
//   ③ 三维一致：buildTownMeshes 的图层过滤和 2D 用的是同一个函数。

import { Pt } from '../src/core/geom';
import { Model } from '../src/town/model';
import { makeZone } from '../src/town/zones';
import { resolveParams } from '../src/town/params';
import { buildScene } from '../src/scene/build';
import { buildTownMeshes } from '../src/export/build3d';
import {
  LAYER_GROUPS,
  OVERLAY_GROUPS,
  defaultVisibility,
  layerOfPath,
  layerOfProp,
  layerOfSolid,
  layerOfSurface,
  makeFilter,
  sceneLayerSig,
} from '../src/scene/layers';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

const zone = makeZone('z', '禁区', {
  kind: 'rect',
  a: new Pt(-40, -14),
  b: new Pt(-8, 20),
});
const model = new Model({
  nPatches: 24,
  seed: 424242,
  plaza: true,
  zones: [zone],
  params: resolveParams({ block: { parcelize: true } }),
});
model.generate();
const scene = buildScene(model);

// ---------------------------------------------------------------- ① 无孤儿
const known = new Set<string>();
for (const g of [...LAYER_GROUPS, ...OVERLAY_GROUPS]) for (const it of g.items) known.add(it.id);

const orphans = new Map<string, number>();
const bump = (id: string) => {
  if (known.has(id)) return;
  orphans.set(id, (orphans.get(id) ?? 0) + 1);
};
for (const s of scene.surfaces) bump(layerOfSurface(s));
for (const s of scene.solids) bump(layerOfSolid(s));
for (const p of scene.props) bump(layerOfProp(p));
for (const p of scene.paths) bump(layerOfPath(p));

ok(
  orphans.size === 0,
  `没有孤儿要素（未登记图层：${[...orphans].map(([k, v]) => `${k}×${v}`).join(', ') || '无'}）`
);
console.log(
  `  要素：面 ${scene.surfaces.length} / 体 ${scene.solids.length} / 道具 ${scene.props.length} / 线 ${scene.paths.length}`
);

// ---------------------------------------------------------------- ② 无漏项
const vis = defaultVisibility();
ok(Object.keys(vis).length === known.size, `默认显隐覆盖全部 ${known.size} 个图层`);

// 逐个图层关掉，确认它名下的要素真的被过滤掉
const byLayer = new Map<string, number>();
for (const s of scene.surfaces) byLayer.set(layerOfSurface(s), (byLayer.get(layerOfSurface(s)) ?? 0) + 1);
for (const s of scene.solids) byLayer.set(layerOfSolid(s), (byLayer.get(layerOfSolid(s)) ?? 0) + 1);
for (const p of scene.props) byLayer.set(layerOfProp(p), (byLayer.get(layerOfProp(p)) ?? 0) + 1);
for (const p of scene.paths) byLayer.set(layerOfPath(p), (byLayer.get(layerOfPath(p)) ?? 0) + 1);

let leak = 0;
for (const [id, cnt] of byLayer) {
  const off = { ...vis, [id]: false };
  const f = makeFilter(off);
  let left = 0;
  for (const s of scene.surfaces) if (layerOfSurface(s) === id && f(layerOfSurface(s))) left++;
  for (const s of scene.solids) if (layerOfSolid(s) === id && f(layerOfSolid(s))) left++;
  for (const p of scene.props) if (layerOfProp(p) === id && f(layerOfProp(p))) left++;
  for (const p of scene.paths) if (layerOfPath(p) === id && f(layerOfPath(p))) left++;
  if (left > 0) {
    leak++;
    console.log(`  FAIL 图层 ${id} 关掉后仍剩 ${left}/${cnt} 个要素`);
  }
}
ok(leak === 0, `每个图层关掉后都真的清空（漏项 ${leak} 个）`);

// ---------------------------------------------------------------- ③ 树：地块内 + 街道两侧都要受控
const treeKinds = new Set(['prop:tree', 'prop:treeSmall', 'prop:conifer']);
let lotTrees = 0;
let streetTrees = 0;
for (const p of scene.props) {
  if (!treeKinds.has(layerOfProp(p))) continue;
  if (p.group.startsWith('lot/')) lotTrees++;
  else streetTrees++;
}
ok(lotTrees > 0, `地块里确实有树（${lotTrees} 棵）—— 这是当初"不受控"的那一批`);
ok(streetTrees > 0, `街道两侧也有树（${streetTrees} 棵）`);

const noPlants = makeFilter({ ...vis, 'prop:tree': false, 'prop:treeSmall': false, 'prop:conifer': false, 'prop:hedge': false });
ok(
  scene.props.filter((p) => treeKinds.has(layerOfProp(p)) && noPlants(layerOfProp(p))).length === 0,
  '关掉植物类之后一棵树都不剩（地块内 + 街道两侧）'
);

// ---------------------------------------------------------------- ④ 三维与导出一致
const triFull = buildTownMeshes(model).reduce((a, p) => a + p.indices.length / 3, 0);
const triNoPlants = buildTownMeshes(model, { layers: noPlants }).reduce((a, p) => a + p.indices.length / 3, 0);
ok(triNoPlants < triFull, `三维网格确实剔掉了植物（${triFull} → ${triNoPlants} 三角形）`);

const allOff = makeFilter(Object.fromEntries([...known].map((k) => [k, false])));
const triEmpty = buildTownMeshes(model, { layers: allOff }).reduce((a, p) => a + p.indices.length / 3, 0);
ok(triEmpty === 0, `全部关掉后导出为空（${triEmpty} 三角形）`);

// ---------------------------------------------------------------- ⑤ 显隐签名
const sigA = sceneLayerSig(vis);
const sigB = sceneLayerSig({ ...vis, 'prop:lamp': false });
ok(sigA !== sigB, '显隐签名能反映变化（三维据此判断要不要重建）');
ok(sceneLayerSig({ ...vis }) === sigA, '显隐签名稳定（同样的显隐 → 同样的签名）');

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
