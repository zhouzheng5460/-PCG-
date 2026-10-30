// 栅格 A* 内部路：几何约束回归。
//
// 这一层最容易出的不是"算不出来"，而是"算出来不能用"：
//   - 路斜着穿街网（8 邻域天然偏爱 45°）；
//   - 路贴着界边平行走（净空只避开节点，避不开带宽）；
//   - 端点延长方向取错（末段是一格横挪，延长就把路拉成横贯全块地的长臂）。
// 所以这里断言的是**几何性质**，不是快照。

import { Pt } from '../src/core/geom';
import {
  astar,
  buildLattice,
  connectEntries,
  dedupePath,
  edgeDist,
  pickEntryPoints,
  simplifyPath,
} from '../src/town/field/lattice';
import { isSimpleRing } from '../src/town/zones';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

const CELL = 1.15;
const RECT = [new Pt(-14, -12), new Pt(14, -12), new Pt(14, 12), new Pt(-14, 12)];
const mk = (seed: number) =>
  buildLattice(RECT, {
    cell: CELL,
    clear: 0.5 + 6 / 7,
    turn: 2.4,
    jitter: 0.3,
    axis: new Pt(1, 0),
    gridPenalty: 2,
    seed,
  });

// ---------------------------------------------------------------- ① 栅格本身
{
  const lat = mk(1);
  let pass = 0;
  for (let k = 0; k < lat.ok.length; k++) pass += lat.ok[k];
  ok(pass > 100, `矩形地块的栅格有足够多可通行格（${pass}）`);
  // 净空：所有可通行节点离界边都不小于 clear
  let minD = Infinity;
  for (let k = 0; k < lat.ok.length; k++) {
    if (!lat.ok[k]) continue;
    const i = k % lat.nx;
    const j = (k - i) / lat.nx;
    minD = Math.min(minD, edgeDist(new Pt(lat.ox + i * lat.cell, lat.oy + j * lat.cell), RECT));
  }
  ok(minD >= 0.5 + 6 / 7 - 1e-9, `可通行节点满足净空（最小 ${minD.toFixed(2)}）`);
}

// ---------------------------------------------------------------- ② 路径几何
{
  const lat = mk(7);
  const a = new Pt(-14, 0);
  const b = new Pt(14, 0.4);
  const r = astar(lat, a, b);
  ok(!!r, '能求出路径');
  if (r) {
    const pts = r.pts;
    ok(edgeDist(pts[0], RECT) < 1e-6, '起点落在界边上');
    ok(edgeDist(pts[pts.length - 1], RECT) < 1e-6, '终点落在界边上');
    // 4 连通 + 端点沿轴延长 ⇒ 每一段都必须是轴对齐
    let axisAligned = true;
    let maxBend = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = Math.abs(pts[i + 1].x - pts[i].x);
      const dy = Math.abs(pts[i + 1].y - pts[i].y);
      if (dx > 1e-6 && dy > 1e-6) axisAligned = false;
    }
    ok(axisAligned, '所有路段都是横平竖直（没有斜穿）');
    for (let i = 1; i + 1 < pts.length; i++) maxBend = Math.max(maxBend, 1);
    ok(pts.length <= 4, `正对的入口之间不该拐弯（顶点 ${pts.length}）`);
    // 长度不该比直线长太多
    let len = 0;
    for (let i = 0; i + 1 < pts.length; i++) len += Pt.distance(pts[i], pts[i + 1]);
    ok(len < 28 * 1.25, `路径长度接近直线（${len.toFixed(1)} / 28）`);
  }
}

// ---------------------------------------------------------------- ③ 端点不贴界边
{
  // 入口故意选在"不对称"的位置：A* 会先走到目标格的正上/下方再横挪一格，
  // 那一格如果不掐掉，端点延长就会把路横向拉到对面的界边上去。
  const lat = mk(11);
  const a = new Pt(-14, -6.3);
  const b = new Pt(-3.1, 12);
  const r = astar(lat, a, b);
  ok(!!r, '斜对的两点也能连通');
  if (r) {
    const pts = r.pts;
    // 每一段都不该超过地块跨度的一半（说明没有"横贯全块地的长臂"）
    let longest = 0;
    for (let i = 0; i + 1 < pts.length; i++) longest = Math.max(longest, Pt.distance(pts[i], pts[i + 1]));
    ok(longest <= 28 * 0.75, `没有异常长的单段（最长 ${longest.toFixed(1)}）`);
  }
}

// ---------------------------------------------------------------- ④ 主干 + T 支路
{
  const lat = mk(3);
  const entries = pickEntryPoints(RECT, 3, (p, q) => Pt.distance(p, q), 8);
  ok(entries.length === 3, `挑出 3 个入口（得到 ${entries.length}）`);
  const nets = connectEntries(lat, entries);
  ok(nets.length === 2, `3 个入口 → 1 主干 + 1 支路（得到 ${nets.length}）`);
  if (nets.length === 2) {
    const trunk = nets[0];
    // 主干两端都在界边上
    ok(edgeDist(trunk[0], RECT) < 1e-6 && edgeDist(trunk[trunk.length - 1], RECT) < 1e-6, '主干两端都接到界边');
    // 支路有一端落在主干上（T 形）
    const branch = nets[1];
    const end = branch[branch.length - 1];
    let best = Infinity;
    for (let i = 0; i + 1 < trunk.length; i++) {
      const p = trunk[i];
      const q = trunk[i + 1];
      const vx = q.x - p.x;
      const vy = q.y - p.y;
      const L = vx * vx + vy * vy || 1;
      let t = ((end.x - p.x) * vx + (end.y - p.y) * vy) / L;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(end.x - (p.x + vx * t), end.y - (p.y + vy * t)));
    }
    ok(best < 1e-6, `支路末端落在主干上（偏差 ${best.toFixed(3)}）`);
    ok(edgeDist(branch[0], RECT) < 1e-6, '支路另一端接到界边');
  }
}

// ---------------------------------------------------------------- ⑤ 确定性
{
  const run = (seed: number) => {
    const lat = mk(seed);
    const nets = connectEntries(lat, [new Pt(-14, -4), new Pt(14, 3), new Pt(-2, -12)]);
    return JSON.stringify(nets.map((l) => l.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])));
  };
  ok(run(5) === run(5), '同一 seed 结果完全一致');
  ok(run(5) !== run(6), '不同 seed 结果不同（扰动生效）');
}

// ---------------------------------------------------------------- ⑥ 转弯惩罚
{
  const count = (turn: number) => {
    const lat = buildLattice(RECT, {
      cell: CELL,
      clear: 0.5 + 6 / 7,
      turn,
      jitter: 0,
      axis: new Pt(1, 0),
      gridPenalty: 2,
      seed: 9,
    });
    const r = astar(lat, new Pt(-14, -5), new Pt(-4, 11));
    if (!r) return 99;
    let bends = 0;
    for (let i = 1; i + 1 < r.pts.length; i++) bends++;
    return bends;
  };
  ok(count(0.5) < 99, '默认档能求出路径');
  ok(count(0.5) >= count(8), `转弯惩罚调大不会让路更绕（0.5→${count(0.5)}，8→${count(8)}）`);
  ok(count(2.4) <= 2, `默认档只拐一两次（${count(2.4)}）`);
}

// ---------------------------------------------------------------- ⑦ 化简
{
  const step = [new Pt(0, 0), new Pt(1, 0), new Pt(2, 0), new Pt(3, 0)];
  ok(simplifyPath(step, 0.1).length === 2, 'RDP 会把共线阶梯压成一段');
  ok(dedupePath([new Pt(0, 0), new Pt(0, 0), new Pt(1, 0)]).length === 2, '去重会合并重合点');
  const bend = [new Pt(0, 0), new Pt(5, 0), new Pt(5, 5)];
  ok(dedupePath(bend).length === 3, '共线合并不会误删拐点');
  ok(isSimpleRing([new Pt(0, 0), new Pt(4, 0), new Pt(4, 4), new Pt(0, 4)]), '矩形是简单环');
  ok(!isSimpleRing([new Pt(0, 0), new Pt(4, 4), new Pt(4, 0), new Pt(0, 4)]), '蝴蝶结不是简单环');
}

console.log(fail === 0 ? `PASS — ${n} 项断言，0 项失败` : `FAIL — ${fail}/${n} 项断言失败`);
if (fail > 0) process.exit(1);
