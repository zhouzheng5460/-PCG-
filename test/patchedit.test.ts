// 单块地块编辑回归：走「选中一块地 → 改用途 / 高度 / 切分」这条链路。
//
// 这条链路的关键在于**它是加法**：自动分档（planLandUse）照常跑完整座城，
// 覆盖只在那之后把某几块的结果换掉。于是有三条不变量必须成立：
//   ① 改一块 = 只影响这一块，别的地块一栋楼都不能动；
//   ② 清掉覆盖 = 回到原样（否则用户"手滑改了又撤销"永远回不去）；
//   ③ 三个旋钮各自真的管事：用途换 ward、高度翻倍、切分块数变多。
// 第 ③ 条最容易出现"面板能点、模型不理"的假接线，所以必须逐项验量。

import { Model } from '../src/town/model';
import { patchKey, type PatchEdit } from '../src/town/patch';
import type { LandUse } from '../src/scene/types';
import { ROAD_SPECS, u } from '../src/road/spec';
import type { Pt } from '../src/core/geom';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

const STYLE = {
  mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
  regularStreetWidth: u(ROAD_SPECS.collector.redLine),
  alleyWidth: u(ROAD_SPECS.local.redLine),
};

/** 一块地上实际盖出来的东西（从 ward 的 lot 读，渲染和导出都读同一个） */
interface Built {
  use: LandUse;
  count: number;
  /** 所有体量的高度总和：只改高度倍率时，这个数应该整体等比放大 */
  hSum: number;
  /** 每栋的高度，用来比对"一栋都没多一栋都没少" */
  hs: number[];
}

type WardLike = { use: LandUse; lot: { solids: { ring: Pt[]; h: number }[] } | null };

function builtOf(m: Model, key: string): Built | null {
  const p = m.patches.find((q) => patchKey(q) === key);
  if (!p) return null;
  const w = p.ward as unknown as WardLike | null;
  if (!w) return null;
  const solids = w.lot?.solids ?? [];
  return {
    use: w.use,
    count: solids.length,
    hSum: solids.reduce((a, s) => a + s.h, 0),
    hs: solids.map((s) => s.h),
  };
}

function run(edits: Map<string, PatchEdit>, seed = 682063530): Model {
  const m = new Model({ nPatches: 15, seed, plaza: true, style: STYLE, patchEdits: edits });
  m.generate();
  return m;
}

const base = run(new Map());
ok(base.patches.length > 10, `基准城有 ${base.patches.length} 块地`);

// 挑一块"真的盖了楼、又不是禁建区"的地当探针。挑最大的一栋，量最清楚。
let probeKey = '';
let probeMax = 0;
for (const p of base.patches) {
  if (p.blocked) continue;
  const b = builtOf(base, patchKey(p));
  if (!b || b.count === 0) continue;
  if (b.hSum > probeMax) {
    probeMax = b.hSum;
    probeKey = patchKey(p);
  }
}
ok(probeKey !== '', `找到探针地块 ${probeKey}（总高 ${probeMax.toFixed(2)}u）`);

const b0 = builtOf(base, probeKey)!;
console.log(
  `  探针基线：用途 ${b0.use} / ${b0.count} 栋 / 总高 ${b0.hSum.toFixed(2)}u / 单栋 ${b0.hs
    .map((h) => h.toFixed(1))
    .join(',')}`
);

/** 除探针之外所有地块的建筑指纹：任何一项变了就说明"改一块动了全城" */
function othersFingerprint(m: Model): string {
  const parts: string[] = [];
  for (const p of m.patches) {
    const k = patchKey(p);
    if (k === probeKey) continue;
    const b = builtOf(m, k);
    parts.push(`${k}|${b ? `${b.use}|${b.count}|${b.hSum.toFixed(3)}` : 'none'}`);
  }
  return parts.join(';');
}
const others0 = othersFingerprint(base);

// ---------------------------------------------------------------- ① 改用途
{
  const m = run(new Map([[probeKey, { use: 'commercial' }]]));
  const b = builtOf(m, probeKey)!;
  ok(b.use === 'commercial', `用途改成 commercial（得到 ${b.use}）`);
  ok(b.use !== b0.use, `用途确实变了（${b0.use} → ${b.use}）`);
  ok(b.count > 0, `改用途后仍然盖得出楼（${b.count} 栋）`);
  ok(othersFingerprint(m) === others0, '别的 60 多块地一栋都没动');
  const p = m.patches.find((q) => patchKey(q) === probeKey)!;
  ok(p.override?.use === 'commercial', 'patch.override 上留了痕（面板据此回显）');
}

// ---------------------------------------------------------------- ② 改高度倍率
{
  const m = run(new Map([[probeKey, { heightK: 2 }]]));
  const b = builtOf(m, probeKey)!;
  ok(b.count === b0.count, `栋数不变（${b.count} = ${b0.count}，只拔高不新增）`);
  const ratio = b0.hSum > 1e-6 ? b.hSum / b0.hSum : 0;
  ok(Math.abs(ratio - 2) < 1e-6, `总高精确翻倍（×${ratio.toFixed(3)}）`);
  ok(b.hs.every((h, i) => Math.abs(h - b0.hs[i] * 2) < 1e-6), '每一栋都翻倍，不是只拔高了最高的那栋');
  ok(othersFingerprint(m) === others0, '别的地块高度不受影响');
}

// ---------------------------------------------------------------- ③ 改切分块数
{
  // 探针地块切成 8 块：目标面积 = 自身面积 / 8。
  // 自动路径的切分深度封顶 2 刀（4 块），手动指定才放开到 3 刀（8 块）——
  // 所以这里必须用 8 来验，用 4 会和自动结果撞上，看不出接线通没通。
  const p = base.patches.find((q) => patchKey(q) === probeKey)!;
  let aSum = 0;
  const ring = Array.from(p.shape);
  for (let i = 0; i < ring.length; i++) {
    const q = ring[(i + 1) % ring.length];
    aSum += ring[i].x * q.y - q.x * ring[i].y;
  }
  const areaU = Math.abs(aSum) / 2;
  const target = areaU / 8;

  const m = run(new Map([[probeKey, { parcelTargetA: target }]]));
  const b = builtOf(m, probeKey)!;
  ok(b.count > b0.count, `切成 8 块后栋数变多（${b0.count} → ${b.count}）`);
  ok(othersFingerprint(m) === others0, '别的地块切分不受影响');

  // 目标面积给得越大 → 块数越少，直到 1 块
  const big = run(new Map([[probeKey, { parcelTargetA: areaU * 4 }]]));
  const bb = builtOf(big, probeKey)!;
  ok(bb.count <= b.count, `目标面积越大块数越少（${b.count} → ${bb.count}）`);
  ok(bb.count >= 1, `再大也至少留 1 栋（${bb.count}）`);
}

// ---------------------------------------------------------------- ④ 清掉覆盖 = 回原样
{
  const m = run(new Map());
  ok(builtOf(m, probeKey)!.hSum === b0.hSum, '同样的参数再跑一遍，结果逐位相同（可复现）');

  // 先改再删：删除等于"这张表里没有这一条"
  const edits = new Map<string, PatchEdit>([[probeKey, { use: 'commercial', heightK: 1.8 }]]);
  const changed = run(edits);
  ok(builtOf(changed, probeKey)!.use === 'commercial', '改过之后确实是商业');
  edits.delete(probeKey);
  const back = run(edits);
  ok(builtOf(back, probeKey)!.use === b0.use, `删掉覆盖后用途回到 ${b0.use}`);
  ok(Math.abs(builtOf(back, probeKey)!.hSum - b0.hSum) < 1e-9, '删掉覆盖后高度回到原样');
  ok(othersFingerprint(back) === others0, '删掉覆盖后全城回到原样');
}

// ---------------------------------------------------------------- ⑤ 禁建区地块不吃覆盖
{
  // 找一个被禁建区压住的地块（有禁区才有；没有就跳过，不算失败）
  const zone1 = run(new Map(), 991337);
  const blocked = zone1.patches.filter((q) => q.blocked);
  if (blocked.length > 0) {
    const k = patchKey(blocked[0]);
    const m = new Model({
      nPatches: 15,
      seed: 991337,
      plaza: true,
      style: STYLE,
      patchEdits: new Map([[k, { use: 'cbd', heightK: 2 }]]),
    });
    m.generate();
    const p = m.patches.find((q) => patchKey(q) === k)!;
    ok(p.blocked, '禁区内的地块重建后仍然是禁建态');
    ok(!p.ward, '禁建地块不排建筑 —— 覆盖也变不出楼来');
  } else {
    console.log('  （这个种子没有禁建地块，跳过 ⑤）');
  }
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
