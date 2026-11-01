// 建筑形状回归：纸片楼与锐角楼必须归零。
//
// 这两类畸形不是"参数没调好"，是**缺少形状约束**：地块能切出来，不等于能盖楼。
// 张量切分会产出 20 m × 4 m 的窄条和 30° 的楔形，原来的管线照样给它们
// 3~7 个单位的高度，于是 3D 里就是一片立起来的刀。
//
// 断言分两类：
//   ① 不变量：任何非雨棚体量，进深 < 8 m 时高度必须 ≤ 1 层（1.0 单位 ≈ 7 m）；
//      "进深"取**最小外接矩形的短边**，不是内切半径 2A/P —— 后者对正方形
//      只有半边长，会把一栋 14×12 m 的正常房子算成"进深 6.5 m"。测量口径
//      改了之后，以前被误降级的 52% 住宅楼会回到正常体量，这条断言才有意义。
//   ② 不变量：任何非雨棚体量，最小内角 ≥ 62°（倒角闸保证），容差 1°。
// 这两条一旦破，说明有多少条生成路径绕过了 addSolid 上的那道闸。

import { Pt } from '../src/core/geom';
import { Model } from '../src/town/model';
import { buildScene } from '../src/scene/build';
import { area } from '../src/town/zones';
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

const MIN_DEPTH_M = 8;
const MIN_ANGLE = 62;

function fit(ring: Pt[]) {
  const k = ring.length;
  let per = 0;
  for (let i = 0; i < k; i++) per += Pt.distance(ring[i], ring[(i + 1) % k]);
  const A = Math.abs(area(ring));
  const inr = per > 1e-6 ? (2 * A) / per : 0;
  const sg = area(ring) > 0 ? 1 : -1;
  let minAng = 180;
  for (let i = 0; i < k; i++) {
    const p = ring[(i + k - 1) % k];
    const q = ring[i];
    const r = ring[(i + 1) % k];
    const ax = p.x - q.x;
    const ay = p.y - q.y;
    const bx = r.x - q.x;
    const by = r.y - q.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const dot = (ax * bx + ay * by) / (la * lb);
    const base = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    const cross = ax * by - ay * bx;
    const ang = cross * sg > 0 ? base : 360 - base;
    if (ang < minAng) minAng = ang;
  }
  return { inr, minAng };
}

/**
 * 进深（m）= 最小外接矩形的短边。
 *
 * 与 `src/town/modern.ts` 的 `shortSideM` 同一个口径（这里独立实现一遍，
 * 测试不该直接引用被测代码的判据，否则判据写错时两边一起错）。
 */
function shortSideM(ring: Pt[]): number {
  const k = ring.length;
  let bi = 0;
  let bl = 0;
  for (let i = 0; i < k; i++) {
    const L = Pt.distance(ring[i], ring[(i + 1) % k]);
    if (L > bl) {
      bl = L;
      bi = i;
    }
  }
  if (bl < 1e-9) return 0;
  const a = ring[bi];
  const b = ring[(bi + 1) % k];
  const ux = (b.x - a.x) / bl;
  const uy = (b.y - a.y) / bl;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of ring) {
    const dv = -(p.x - a.x) * uy + (p.y - a.y) * ux;
    if (dv < v0) v0 = dv;
    if (dv > v1) v1 = dv;
  }
  return Math.min(bl, v1 - v0) * 7;
}

let total = 0;
let paper = 0;
let acute = 0;
let lowRise = 0;
const kinds = new Set<string>();

for (const seed of [682063530, 991337, 4455661]) {
  const m = new Model({
    nPatches: 15,
    seed,
    plaza: true,
    style: {
      mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
      regularStreetWidth: u(ROAD_SPECS.collector.redLine),
      alleyWidth: u(ROAD_SPECS.local.redLine),
    },
  });
  m.generate();
  const scene = buildScene(m);
  for (const s of scene.solids) {
    if (s.kind === 'canopy') continue;
    const f = fit(s.ring);
    total++;
    kinds.add(s.kind);
    // ① 薄 + 高 = 纸片楼
    const dep = shortSideM(s.ring);
    if (dep < MIN_DEPTH_M && s.h > 1.0 + 1e-6) {
      paper++;
      if (paper <= 5) console.log(`  纸片：${s.name} 进深 ${dep.toFixed(1)}m 高 ${s.h.toFixed(2)}u`);
    }
    // ② 内角过尖 = 锐角楼
    if (f.minAng < MIN_ANGLE - 1) {
      acute++;
      if (acute <= 5) console.log(`  锐角：${s.name} 最小角 ${f.minAng.toFixed(1)}°`);
    }
    if (s.kind === 'retail' || s.kind === 'podium') lowRise++;
  }
}

console.log(
  `共 ${total} 栋：纸片 ${paper} · 锐角 ${acute} · 低层配套 ${lowRise}（${((lowRise / Math.max(1, total)) * 100).toFixed(1)}%）`
);
console.log(`类型：${[...kinds].join(' / ')}`);

ok(total > 100, `样本量够（${total} 栋）`);
ok(paper === 0, `没有纸片楼（进深<8m 却高过 1 层）`);
ok(acute === 0, `没有锐角楼（内角<62°）`);
// 降级通道得真的在用：一条都没降级，说明形状约束形同虚设
ok(lowRise > 0, `配套商业/裙房确实在承担畸形地块（${lowRise} 栋）`);
ok(total - lowRise > total * 0.4, `主流体量没被降级吃掉（${total - lowRise} 栋正常楼）`);

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
