// 禁建区避障回归。
//
// 这一层要守住的是"路和禁区的关系"，不是某个像素好不好看。四条：
//   ① 路面不许压进禁区（禁区里一块沥青都不该有）；
//   ② 禁区轮廓本身不再是道路（避障模式下那一圈换成绿化隔离带）；
//   ③ 贴着禁区的路面要显著变少 —— 这是"避开"和"硬怼上去"的区别；
//   ④ 断头不能暴涨（绕行 / 收口不能把路网切碎）。

import { Pt } from '../src/core/geom';
import { Model } from '../src/town/model';
import { makeZone, pointInPolygon } from '../src/town/zones';
import { resolveParams } from '../src/town/params';
import { buildRoadNet } from '../src/road/system';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

/** 和用户截图里那块差不多大小、斜放的矩形禁区 */
function rectZone(): Pt[] {
  const cx = -6;
  const cy = 6;
  const hw = 13;
  const hh = 6.4;
  const th = 0.38;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => new Pt(cx + x * cs - y * sn, cy + x * sn + y * cs));
}

const ZONE = rectZone();
const PAD_U = 12 / 7; // 12 m 让距

function build(avoid: boolean, seed: number): Model {
  const m = new Model({
    nPatches: 30,
    seed,
    plaza: false,
    zones: [makeZone('pad', '自建场地', { kind: 'poly', pts: ZONE })],
    params: resolveParams({ block: { zoneAvoid: avoid } }),
  });
  m.generate();
  return m;
}

function distRing(x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < ZONE.length; i++) {
    const a = ZONE[i];
    const b = ZONE[(i + 1) % ZONE.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L < 1e-12 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}

interface Stat {
  edges: number;
  /** 车行道压进禁区的边数 */
  inZone: number;
  /** 车行道边缘离禁区 < 2 m 的边数（"贴边"） */
  hugging: number;
  /** 禁区轮廓上的边数（两侧有一侧是 blocked 地块） */
  onRim: number;
  /** 度为 1 的顶点数（断头） */
  deadEnds: number;
  minGap: number;
}

function statOf(m: Model): Stat {
  const net = buildRoadNet(m);
  let inZone = 0;
  let hugging = 0;
  let onRim = 0;
  let minGap = Infinity;
  for (const e of net.edges) {
    if (e.patchL?.blocked || e.patchR?.blocked) onRim++;
    const mx = (e.a.x + e.b.x) / 2;
    const my = (e.a.y + e.b.y) / 2;
    const d = distRing(mx, my) - e.carriage / 2;
    if (pointInPolygon(new Pt(mx, my), ZONE) || d < 0) inZone++;
    if (d < 2 / 7) hugging++;
    if (d < minGap) minGap = d;
  }
  const deg = new Map<Pt, number>();
  for (const e of net.edges) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  let deadEnds = 0;
  for (const [, d] of deg) if (d === 1) deadEnds++;
  return { edges: net.edges.length, inZone, hugging, onRim, deadEnds, minGap };
}

// ---------------------------------------------------------------- ① 三个种子对照
{
  const rows: string[] = [];
  for (const seed of [8, 21, 44]) {
    const off = statOf(build(false, seed));
    const on = statOf(build(true, seed));
    rows.push(
      `  seed ${String(seed).padStart(2)}  ` +
        `关: 路压禁区 ${String(off.inZone).padStart(2)} / 贴边 ${String(off.hugging).padStart(2)} / 轮廓上路 ${String(off.onRim).padStart(3)} / 断头 ${String(off.deadEnds).padStart(3)}   →   ` +
        `开: ${String(on.inZone).padStart(2)} / ${String(on.hugging).padStart(2)} / ${String(on.onRim).padStart(3)} / ${String(on.deadEnds).padStart(3)}`
    );

    ok(on.inZone === 0, `seed ${seed}：避障开时没有车行道压进禁区（${on.inZone} 条）`);
    ok(on.onRim === 0, `seed ${seed}：禁区轮廓上不再铺路（${on.onRim} 条）`);
    ok(
      on.hugging < off.hugging,
      `seed ${seed}：贴边路面变少（关 ${off.hugging} → 开 ${on.hugging}）`
    );
    ok(
      on.deadEnds <= off.deadEnds * 1.4 + 3,
      `seed ${seed}：断头没有暴涨（关 ${off.deadEnds} → 开 ${on.deadEnds}）`
    );
    // 路网还在：不能因为避障把城市切成两半
    ok(on.edges > off.edges * 0.85, `seed ${seed}：路网规模没塌（关 ${off.edges} → 开 ${on.edges}）`);
  }
  console.log(rows.join('\n'));
}

// ---------------------------------------------------------------- ② 让距可调
{
  const m = new Model({
    nPatches: 30,
    seed: 8,
    plaza: false,
    zones: [makeZone('pad', '自建场地', { kind: 'poly', pts: ZONE })],
    params: resolveParams({ block: { zoneAvoid: true, zoneAvoidPadM: 26 } }),
  });
  m.generate();
  const wide = statOf(m);
  const narrow = statOf(build(true, 8));
  ok(
    wide.hugging <= narrow.hugging,
    `让距调大（26 m）后贴边路面不增加（12 m ${narrow.hugging} → 26 m ${wide.hugging}）`
  );
  ok(wide.inZone === 0, '让距 26 m 时仍然没有路压进禁区');
  console.log(`  让距 26 m    贴边 ${wide.hugging} / 最近路缘 ${(wide.minGap * 7).toFixed(1)} m`);
}

// ---------------------------------------------------------------- ③ 没禁区时必须完全不变
{
  // 必须显式给 plaza：不给的话 Model 构造函数会用 Rng.bool() 抽一次
  // "要不要中心广场"，两次构建抽到的值不同，楼栋数自然差 5 栋 ——
  // 那是测试自己的不确定性，不是避障开关的影响。
  const noZone = (avoid: boolean) => {
    const m = new Model({
      nPatches: 20,
      seed: 7,
      plaza: false,
      params: resolveParams({ block: { zoneAvoid: avoid } }),
    });
    m.generate();
    return m.stats();
  };
  const a = noZone(true);
  const b = noZone(false);
  ok(
    a.patches === b.patches && a.buildings === b.buildings,
    `没有禁区时避障开关不影响任何东西（${a.patches}/${a.buildings} vs ${b.patches}/${b.buildings}）`
  );
}

// ---------------------------------------------------------------- ④ 弧线绕障（实验开关）也不能把路放进禁区
{
  const bent = new Model({
    nPatches: 30,
    seed: 8,
    plaza: false,
    zones: [makeZone('pad', '自建场地', { kind: 'poly', pts: ZONE })],
    params: resolveParams({ block: { zoneAvoid: true, zoneAvoidBend: true } }),
  });
  bent.generate();
  const st = statOf(bent);
  ok(st.inZone === 0, `弧线绕障（实验开）时也没有车行道压进禁区（${st.inZone} 条）`);
  ok(st.onRim === 0, `弧线绕障时禁区轮廓上不铺路（${st.onRim} 条）`);
  console.log(`  弧线绕障      贴边 ${st.hugging} / 断头 ${st.deadEnds} / 边 ${st.edges}`);
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
