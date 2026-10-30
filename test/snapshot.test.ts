// 场景快照回归。
//
// 这一层的价值全在"同一个链接必须还是同一座城"：编码/解码本身不会错，
// 错的是**漏字段** —— 少存了 guideStrength、少存了 zone.purpose、少存了某个
// 参数滑杆，链接打开后城市还在，但街网走向变了。人眼对不出这种差别，
// 只会像上次那样绕一大圈去猜"你的版本和我的不一样"。
//
// 所以这里不只测往返，还真的从还原后的状态重跑一遍生成，和原始状态逐项比。

import { Pt } from '../src/core/geom';
import { Model } from '../src/town/model';
import { makeZone, area } from '../src/town/zones';
import { makeGuide } from '../src/town/guide';
import { defaultParams, resolveParams } from '../src/town/params';
import {
  type SceneState,
  SNAPSHOT_VERSION,
  applySnapshot,
  decodeSnapshot,
  encodeSnapshot,
  snapshotOf,
} from '../src/ui/snapshot';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

/** 一份"用过的"状态：非默认参数 + 两条方向线 + 一个矩形禁区 + 一个多边形禁区 */
function usedState(): SceneState {
  return {
    nPatches: 15,
    seed: 682063530,
    plaza: true,
    style: { mainStreetWidth: 4, regularStreetWidth: 2.9, alleyWidth: 1.5 },
    zones: [
      makeZone('z1', '矩形禁区 1', { kind: 'rect', a: new Pt(-52, -18), b: new Pt(-14, 26) }),
      makeZone('z2', '多边形禁区 2', {
        kind: 'poly',
        pts: [new Pt(20, -40), new Pt(46, -30), new Pt(40, -2), new Pt(12, -10)],
      }, 'park'),
    ],
    guides: [
      makeGuide('g1', '方向线 1', [new Pt(-66, -34), new Pt(-20, 6), new Pt(4, 40)]),
      makeGuide('g2', '方向线 2', [new Pt(30, -46), new Pt(58, 6)], 0.55),
    ],
    guideStrength: 0.8,
    layout: 'tensor',
    parkingLevel: 'normal',
    params: resolveParams({ block: { parcelPitchM: 26, spacingK: 1.5 } }),
    // 改过两块地：一块改成商业 + 拔高，一块只改切分
    patchEdits: new Map([
      ['12:-7', { use: 'commercial' as const, heightK: 1.6 }],
      ['-30:4', { parcelTargetA: 3.2 }],
    ]),
  };
}

/** 一份干净的默认状态（模拟"另一台机器打开链接"） */
function freshState(): SceneState {
  return {
    nPatches: 6,
    seed: 1,
    plaza: false,
    style: { mainStreetWidth: 2, regularStreetWidth: 1.4, alleyWidth: 0.7 },
    zones: [],
    guides: [],
    guideStrength: 0.5,
    layout: 'grid',
    parkingLevel: 'low',
    params: defaultParams(),
    patchEdits: new Map(),
  };
}

// ---------------------------------------------------------------- ① 往返
{
  const a = usedState();
  const code = encodeSnapshot(a);
  ok(/^[A-Za-z0-9_-]+$/.test(code), '编码只含 base64url 字符（复制到任何地方都不会被转义）');
  ok(code.length < 2000, `链接片段长度 ${code.length} 字符（< 2000，任何浏览器地址栏都放得下）`);
  ok(!/[+/=]/.test(code), '不残留 + / = 三个会破坏 URL 的字符');

  const b = freshState();
  const sn = decodeSnapshot(code);
  ok(sn !== null, '解码成功');
  ok(!!sn && applySnapshot(b, sn), '写回状态成功');

  // 逐项比对：漏掉任何一项，链接就不是"同一座城"
  ok(b.seed === a.seed, `种子 ${b.seed}`);
  ok(b.nPatches === a.nPatches, `街区数 ${b.nPatches}`);
  ok(b.plaza === a.plaza, '中心广场');
  ok(b.layout === a.layout, `布局 ${b.layout}`);
  ok(b.parkingLevel === a.parkingLevel, `停车配比 ${b.parkingLevel}`);
  ok(b.guideStrength === a.guideStrength, `方向线强度 ${b.guideStrength}`);
  ok(
    b.style.mainStreetWidth === a.style.mainStreetWidth &&
      b.style.regularStreetWidth === a.style.regularStreetWidth &&
      b.style.alleyWidth === a.style.alleyWidth,
    '三档红线宽'
  );
  ok(b.guides.length === 2, `方向线 2 条（得到 ${b.guides.length}）`);
  ok(b.guides[0].pts.length === 3, '方向线 1 的三个点都还在（折线不能压成直线）');
  ok(Math.abs(b.guides[1].strength - 0.55) < 1e-9, `单条方向线强度 ${b.guides[1].strength}`);
  ok(b.zones.length === 2, `禁区 2 个（得到 ${b.zones.length}）`);
  ok(
    b.zones[1].shape.kind === 'poly' && b.zones[1].shape.pts.length === 4,
    '多边形禁区 4 个顶点都还在'
  );
  ok(b.zones[1].purpose === 'park', `禁区用途 ${b.zones[1].purpose}`);
  ok(b.params.block.parcelPitchM === 26, `参数 parcelPitchM ${b.params.block.parcelPitchM}`);
  ok(b.params.block.spacingK === 1.5, `参数 spacingK ${b.params.block.spacingK}`);
  ok(JSON.stringify(b.params) === JSON.stringify(a.params), '参数对象整体一致');

  // 单块地块覆盖也要跟着链接走，否则"同一座城"里少了两块手动调过的地
  ok(b.patchEdits.size === 2, `地块覆盖 2 条（得到 ${b.patchEdits.size}）`);
  const e1 = b.patchEdits.get('12:-7');
  ok(!!e1 && e1.use === 'commercial', `地块 12:-7 用途 ${e1?.use}`);
  ok(!!e1 && Math.abs((e1.heightK ?? 0) - 1.6) < 1e-9, `地块 12:-7 高度倍率 ${e1?.heightK}`);
  const e2 = b.patchEdits.get('-30:4');
  ok(!!e2 && e2.use === undefined, '只改切分的地块不会被凭空塞一个用途');
  ok(!!e2 && Math.abs((e2.parcelTargetA ?? 0) - 3.2) < 1e-9, `地块 -30:4 切分目标 ${e2?.parcelTargetA}`);
}

// ---------------------------------------------------------------- ② 端到端：同链接 → 同城
{
  const run = (st: SceneState) => {
    const m = new Model({
      nPatches: st.nPatches,
      seed: st.seed,
      plaza: st.plaza,
      zones: st.zones,
      guides: st.guides,
      style: st.style,
      layout: st.layout,
      parkingLevel: st.parkingLevel,
      params: st.params,
      patchEdits: st.patchEdits,
    });
    m.generate();
    const s = m.stats();
    // 地块面积总和 + 顶点坐标哈希 = 对街网走向极其敏感的指纹：
    // 方向线少一条、强度差 0.05，街区面积分配就会整体挪位。
    let areaSum = 0;
    let hash = 0;
    for (const p of m.patches) {
      const ring = Array.from(p.shape);
      areaSum += Math.abs(area(ring));
      for (const v of ring) hash = (hash * 31 + Math.round(v.x * 100) + Math.round(v.y * 100) * 7919) | 0;
    }
    return { patches: s.patches, buildings: s.buildings, blocked: s.blocked, areaSum, hash };
  };

  const a = usedState();
  const b = freshState();
  applySnapshot(b, decodeSnapshot(encodeSnapshot(a))!);

  const ra = run(a);
  const rb = run(b);
  ok(ra.patches === rb.patches, `地块数一致（${ra.patches} vs ${rb.patches}）`);
  ok(ra.buildings === rb.buildings, `建筑数一致（${ra.buildings} vs ${rb.buildings}）`);
  ok(ra.blocked === rb.blocked, `禁建地块数一致（${ra.blocked} vs ${rb.blocked}）`);
  ok(ra.areaSum.toFixed(3) === rb.areaSum.toFixed(3), `地块面积总和一致（${ra.areaSum.toFixed(2)}）`);
  ok(ra.hash === rb.hash, '街区顶点哈希一致（街网逐点重合，不是"看起来差不多"）');
  ok(ra.patches > 0, '确实生成出了城市（不是空跑）');
  console.log(
    `  同链接重建     地块 ${ra.patches} / 建筑 ${ra.buildings} / 禁建 ${ra.blocked} / 地块总面积 ${ra.areaSum.toFixed(2)}`
  );
}

// ---------------------------------------------------------------- ③ 坏链接不许炸
{
  ok(decodeSnapshot('这不是base64') === null, '乱码返回 null 不抛错');

  const bad = Buffer.from(JSON.stringify({ v: 999, n: 3 }), 'utf8').toString('base64url');
  ok(decodeSnapshot(bad) === null, '版本不匹配返回 null（不解析出半座城）');

  const empty = Buffer.from(JSON.stringify({ v: SNAPSHOT_VERSION }), 'utf8').toString('base64url');
  const st = freshState();
  const before = st.seed;
  ok(applySnapshot(st, decodeSnapshot(empty)!) === true, '只有版本号的快照也能写回');
  ok(st.seed === before, '缺字段时保留原值，不把种子清成 0');
  ok(st.guides.length === 0 && st.zones.length === 0, '缺字段时不会凭空造出方向线 / 禁区');
}

// ---------------------------------------------------------------- ④ 状态摘要是给人看的
{
  const sn = snapshotOf(usedState());
  ok(sn.v === SNAPSHOT_VERSION, `快照版本 ${sn.v}`);
  ok(sn.g.length === 2 && sn.z.length === 2, '摘要里带 2 条方向线 / 2 个禁区');
  ok(sn.gs > 0 && sn.gs <= 1, `方向线强度在 (0,1]（${sn.gs}）`);
  ok(!!sn.pe && Object.keys(sn.pe).length === 2, '摘要里带 2 条地块覆盖');

  // 没改过任何地块时，链接里连 pe 这个键都不该出现（省字符）
  const clean = freshState();
  ok(!('pe' in snapshotOf(clean)), '没改地块时不写 pe 字段');
  // "点过但什么都没改"的空覆盖也不该占字符
  clean.patchEdits.set('0:0', {});
  ok(!('pe' in snapshotOf(clean)), '空覆盖（三个字段都没填）不写进链接');
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
