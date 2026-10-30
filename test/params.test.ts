// 参数层回归：钳制 / 交换 / 参数扫描。
//
// 参数化最怕的不是"某个值不好看"，而是"面板上填了个边值，整城生成崩掉或穿模"。
// 所以这里做两件事：
//   ① 边界值必须被钳住（不抛错、不产出零高度楼）；
//   ② 每个参数取 min / 默认 / max 三档，全城真跑一遍生成，断言不崩、比例不离谱。

import { area } from '../src/town/zones';
import { Model } from '../src/town/model';
import { resolveParams, defaultParams } from '../src/town/params';
import { buildScene } from '../src/scene/build';
import { makeZone } from '../src/town/zones';
import { Pt } from '../src/core/geom';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

// ---------------------------------------------------------------- ① 钳制与交换
{
  const p = resolveParams({ block: { cellM: 1, gapM: 999, setbackK: -2 } });
  ok(p.block.cellM === 10, `cellM 钳到下限（得到 ${p.block.cellM}）`);
  ok(p.block.gapM === 6, `gapM 钳到上限（得到 ${p.block.gapM}）`);
  ok(p.block.setbackK === 0, `setbackK 钳到 0（得到 ${p.block.setbackK}）`);

  const q = resolveParams({ building: { towerHMin: 40, towerHMaxCore: 3, slabHMin: 9, slabHMax: 2 } });
  ok(q.building.towerHMin === 3 && q.building.towerHMaxCore === 40, '塔楼高度区间颠倒时自动交换');
  ok(q.building.slabHMin === 2 && q.building.slabHMax === 9, '板楼高度区间颠倒时自动交换');

  const r = resolveParams({ block: { internalRoads: 'nonsense' as never } });
  ok(r.block.internalRoads === 'tensor', '非法的内部路网类型回落到 tensor');

  const d = resolveParams();
  ok(JSON.stringify(d) === JSON.stringify(defaultParams()), '空输入 = 默认参数');
}

// ---------------------------------------------------------------- ② 参数扫描
// 参数主要作用于封闭地块（CBD）内容，所以扫描时必须带一个禁绘区，
// 否则整城走的是普通用途规划，参数一条都不生效（第一版就是这样，19 组全是 341 栋）。
const zone = makeZone('keep', '禁绘区', { kind: 'rect', a: new Pt(-34, -26), b: new Pt(-6, 4) });

// 这一整个文件测的是**封闭街区（旧管线）**的参数响应，所以显式关掉 zonePad：
// zonePad 打开时禁建区只剩一块硬地，cellM / parcelTargetA / towerChance 这些
// 参数一条都落不到地上（它们管的是禁建区内部的排楼）。pad 模式另在 ④ 里测。
const scene = (params: Parameters<typeof resolveParams>[0], pad = false) => {
  const base = (params ?? {}) as { block?: Record<string, unknown> };
  const merged = { ...base, block: { zonePad: pad, ...(base.block ?? {}) } };
  const m = new Model({ nPatches: 15, seed: 8, plaza: true, zones: [zone], params: merged });
  m.generate();
  const sc = buildScene(m);
  return { m, sc };
};

const cases: { label: string; params: Parameters<typeof resolveParams>[0] }[] = [];
for (const v of [10, 20, 48]) cases.push({ label: `cellM=${v}`, params: { block: { cellM: v } } });
for (const v of [0.3, 1, 6]) cases.push({ label: `gapM=${v}`, params: { block: { gapM: v } } });
for (const v of [20, 60, 160]) cases.push({ label: `parcelTargetA=${v}`, params: { block: { parcelTargetA: v } } });
for (const v of [0, 0.3, 1]) cases.push({ label: `towerChance=${v}`, params: { building: { towerChance: v, towerChanceCore: v } } });
for (const v of [0, 0.22, 0.6]) cases.push({ label: `mergeChance=${v}`, params: { building: { mergeChance: v } } });
for (const v of [2, 34, 120]) cases.push({ label: `treeDensity=${v}`, params: { green: { treeDensity: v } } });

for (const c of cases) {
  let built = 0;
  let surf = 0;
  let fails = 0;
  try {
    const { m, sc } = scene(c.params);
    built = sc.solids.length;
    surf = sc.surfaces.length;
    fails = m.patches.length === 0 ? 1 : 0;
    ok(sc.solids.length > 0, `${c.label}：没有产出任何建筑`);
    ok(sc.surfaces.length > 0, `${c.label}：没有产出任何铺装`);
  } catch (e) {
    ok(false, `${c.label}：生成抛错 ${(e as Error).message}`);
  }
  console.log(`  ${c.label.padEnd(24)} 建筑 ${String(built).padStart(5)} 栋${fails ? '  ← 地块为空' : ''}`);
}

// ---------------------------------------------------------------- ③ 两种内部路网都得能长出楼
//
// A* 版把地块切得更碎（路可能拐弯、可能贴着界边平行一段），
// 布尔运算在这种碎形状上更容易吐出折返的环，而折返的环会让
// `insetRing` 退线自交 —— 于是"这一整块地每一格建筑都被拒"，一片地白着。
// 这个断言就是盯住那种"安静地空一片"的失败。
for (const mode of ['tensor', 'path'] as const) {
  (globalThis as any).__zoneDbg = [];
  const { sc } = scene({ block: { internalRoads: mode } });
  const rows = (((globalThis as any).__zoneDbg ?? []) as any[]).filter((d) => /^\d+$/.test(String(d.key)));
  const barren = rows.filter((d) => d.cells >= 6 && d.built === 0);
  ok(sc.solids.length > 20, `${mode}：封闭地块有楼（${sc.solids.length} 栋）`);
  ok(rows.length >= 4, `${mode}：地块被切碎（${rows.length} 块）`);
  ok(barren.length === 0, `${mode}：没有"切了格子却一栋楼都没有"的地块（${barren.length} 块）`);
  ok(rows.reduce((s, d) => s + d.built, 0) >= 20, `${mode}：地块内建筑合计 ${rows.reduce((s, d) => s + d.built, 0)} 栋`);
  console.log(`  internalRoads=${mode.padEnd(6)} 地块 ${String(rows.length).padStart(2)} 块 / 楼 ${rows.reduce((s, d) => s + d.built, 0)} 栋 / 空地块 ${barren.length}`);
}

// ---------------------------------------------------------------- ④ zonePad：禁建区只铺硬地
//
// 用户要在禁建区里放自己的模型，所以这块地上不能有任何"内容"：
// 没有建筑、没有内部路、没有地块分割。只剩沥青地面 + 一圈路缘 + 围栏。
{
  const { m, sc } = scene({}, true);
  const zonePatch = m.patches.find((q) => q.blocked);
  const lot = (zonePatch?.ward as any)?.lot;
  const surf = (lot?.surfaces ?? []) as { name: string; mat: string }[];
  const names = surf.map((q) => q.name);
  ok(!!lot, 'pad：禁建区有地块');
  ok((lot?.solids ?? []).length === 0, `pad：禁建区里没有建筑（${(lot?.solids ?? []).length} 栋）`);
  ok(!names.includes('zone_road'), 'pad：禁建区里没有内部车行道');
  ok(!names.includes('loop_road'), 'pad：禁建区里没有服务环路');
  ok(names.includes('zone_pad'), 'pad：禁建区铺了硬地');
  ok(
    surf.find((q) => q.name === 'zone_pad')?.mat === 'asphalt',
    'pad：硬地材质是沥青'
  );
  const fences = (lot?.paths ?? []).filter((q: any) => q.mat === 'fence');
  // 曾经这里断言"围栏绕整圈（≥4 段）"。用户后来明确要求移除禁建区围栏：
  // 一块自建场地的边界由路缘石高差 + 铺装材质变化已经交代清楚，再加一圈
  // 1.35 m 的栏杆，从空中看就是大空地上一条多余的墙。所以断言反过来钉住"没有"。
  ok(fences.length === 0, `pad：禁建区不再有围栏（${fences.length} 段）`);
  ok(sc.solids.length > 20, `pad：城其余部分照常出楼（${sc.solids.length} 栋）`);
  console.log(`  zonePad=true     禁建区楼 0 栋 / 铺装 ${names.join(',')} / 围栏 ${fences.length} 段`);
}

// ---------------------------------------------------------------- ⑤ parcelize：街区切成小地块
//
// 这一层的存在意义只有一个：**一个街区不再只有一栋楼**。
// 关掉它整城就退回"一大块硬质 + 一栋大楼"，绿地占比从 30% 掉回 6% ——
// 所以断言直接盯两个数：每街区楼数、绿地面积占比。
{
  const count = (pad: boolean, extra: Record<string, unknown> = {}) => {
    const { m, sc } = scene({ block: { parcelize: true, ...extra } }, pad);
    let blockA = 0;
    for (const p of m.patches) blockA += Math.abs(area(Array.from(p.shape)));
    const greenA = sc.surfaces
      .filter((s) => s.mat === 'grass' || s.mat === 'grassDark')
      .reduce((a, s) => a + Math.abs(area(s.ring)), 0);
    return { solids: sc.solids.length, blocks: m.patches.filter((p) => p.withinCity).length, green: greenA / Math.max(blockA, 1) };
  };

  const fine = count(true, { parcelPitchM: 22 });
  const coarse = count(true, { parcelPitchM: 60 });
  ok(fine.solids > coarse.solids * 1.15, `parcel：地块越小楼越多（22 m ${fine.solids} 栋 vs 60 m ${coarse.solids} 栋）`);

  const off = count(true, { parcelize: false });
  // 关掉切分不是"楼变少"，是**绿地没了**：旧管线一个街区一栋楼，
  // 基底是 stonePave / paver 的整片硬质。所以断言盯绿地，不盯楼数。
  ok(fine.green > off.green * 1.35, `parcel：关掉切分绿地骤减（开 ${fine.green.toFixed(2)} vs 关 ${off.green.toFixed(2)}）`);
  ok(fine.solids / fine.blocks >= 2, `parcel：每个街区平均 ${(fine.solids / fine.blocks).toFixed(1)} 栋楼（关 ${(off.solids / off.blocks).toFixed(1)} 栋）`);
  console.log(
    `  parcelize        22 m → 楼 ${fine.solids} / 草面×地块 ${fine.green.toFixed(2)}   关 → 楼 ${off.solids} / 草面×地块 ${off.green.toFixed(2)}（>1 是铺装层互相重叠，只看相对值）`
  );
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);