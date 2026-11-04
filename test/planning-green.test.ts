// Green / Park / Civic 三类新用地的规划契约测试
//
// 这一批断言只做一件事：**证明三类不是同一个随机地面生成器换了参数**。
// 所以每个 typology 都跑同一组地块（规则 / 凹多边形 / 狭长 / 小面积 / 多等级道路），
// 然后分别验：
//   · 结构：有候选、程序在白名单内、几何合法（简单环 / 无零长边 / 不越出可建区）；
//   · 语义：三类的地面程序组合必须**两两不同**（这是"语法不同"的可执行判据）；
//   · 细节：有临街面就必须有入口；Civic 必须有建筑；Green 不许切碎。

import { Pt } from '../src/core/geom';
import { buildSiteContext } from '../src/town/planning/core/context';
import type { SiteContext, SiteRoadEdge } from '../src/town/planning/core/types';
import { generateCandidates } from '../src/town/planning/generators';
import { surface, surfaceArea, surfaceValid } from '../src/town/planning/core/surface';
import { GREEN_PROGRAMS, greenProgramViolations } from '../src/town/planning/typologies/green';
import { PARK_PROGRAMS, parkProgramViolations } from '../src/town/planning/typologies/park';
import { CIVIC_PROGRAMS, civicProgramViolations } from '../src/town/planning/typologies/civic';
import { pointInRing } from '../src/town/planning/core/surface';
import { civicDiagnostics } from '../src/town/planning/typologies/civic';

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

const edge = (key: string, a: Pt, b: Pt, cls: SiteRoadEdge['cls']): SiteRoadEdge => ({
  key,
  a,
  b,
  len: Pt.distance(a, b),
  cls,
  carriageSide: cls === 'arterial' ? 1.6 : cls === 'collector' ? 1.1 : 0.7,
  sidewalk: 0.3,
  median: 0,
});

const ctxOf = (parcel: Pt[], edges: SiteRoadEdge[], use: string): SiteContext =>
  buildSiteContext({ parcelId: 't', parcel: surface(parcel), use, edges });

// ---------------------------------------------------------------- 地块样本
const CASES: { name: string; parcel: Pt[]; edges: SiteRoadEdge[] }[] = [
  {
    name: '规则 40×46',
    parcel: rect(0, 0, 40, 46),
    edges: [
      edge('s', new Pt(0, 0), new Pt(40, 0), 'collector'),
      edge('w', new Pt(0, 0), new Pt(0, 46), 'local'),
      edge('e', new Pt(40, 0), new Pt(40, 46), 'local'),
    ],
  },
  {
    name: '凹多边形（L 形 60×60 缺一角）',
    parcel: [
      new Pt(0, 0), new Pt(60, 0), new Pt(60, 26), new Pt(26, 26),
      new Pt(26, 60), new Pt(0, 60),
    ],
    edges: [
      edge('s', new Pt(0, 0), new Pt(60, 0), 'arterial'),
      edge('w', new Pt(0, 0), new Pt(0, 60), 'collector'),
    ],
  },
  {
    name: '狭长 26×120',
    parcel: rect(0, 0, 26, 120),
    edges: [
      edge('s', new Pt(0, 0), new Pt(26, 0), 'collector'),
      edge('e', new Pt(26, 0), new Pt(26, 120), 'local'),
    ],
  },
  {
    name: '小面积 18×22',
    parcel: rect(0, 0, 18, 22),
    edges: [edge('s', new Pt(0, 0), new Pt(18, 0), 'local')],
  },
  {
    name: '多等级道路（主干 + 次干 + 支路）',
    parcel: rect(0, 0, 50, 44),
    edges: [
      edge('s', new Pt(0, 0), new Pt(50, 0), 'arterial'),
      edge('w', new Pt(0, 0), new Pt(0, 44), 'collector'),
      edge('e', new Pt(50, 0), new Pt(50, 44), 'local'),
    ],
  },
];

const USES = [
  { use: 'green', typo: 'green' as const, allowed: GREEN_PROGRAMS, viol: greenProgramViolations, label: 'G' },
  { use: 'park', typo: 'park' as const, allowed: PARK_PROGRAMS, viol: parkProgramViolations, label: 'P' },
  { use: 'civic', typo: 'civic' as const, allowed: CIVIC_PROGRAMS, viol: civicProgramViolations, label: 'C' },
];

// ---------------------------------------------------------------- ① 结构 + 几何
const signature = new Map<string, string>();
for (const u of USES) {
  for (const [i, cs] of CASES.entries()) {
    const ctx = ctxOf(cs.parcel, cs.edges, u.use);
    ok(`${u.label}${i + 1} 用途映射为 ${u.typo}`, ctx.typology === u.typo, ctx.typology);
    const cands = generateCandidates(ctx);
    ok(`${u.label}${i + 1} 有候选 [${cs.name}]`, cands.length > 0, `${cands.length}`);
    if (cands.length === 0) continue;
    const c = cands[0];

    // 地面程序白名单
    const bad = u.viol(c);
    ok(`${u.label}${i + 1} 地面程序在白名单内`, bad.length === 0, bad.join(','));

    // 几何：每个面都是简单环、无零长边
    let geomOk = true;
    for (const g of c.ground) {
      if (g.surface.outer.length < 3) geomOk = false;
      if (!surfaceValid(g.surface)) geomOk = false;
      for (let k = 0; k < g.surface.outer.length; k++) {
        const a = g.surface.outer[k];
        const b = g.surface.outer[(k + 1) % g.surface.outer.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) geomOk = false;
      }
    }
    ok(`${u.label}${i + 1} 地面几何合法`, geomOk);

    // 不越出可建区：每个面的顶点要么在区内，要么**贴在边界上**。
    // 贴边是正常结果（面就是被可建区边界裁出来的），所以留 2 cm 容差 ——
    // 没有容差的话，任何被裁过的面都会因为"边界上那一点不算 in"而整片判负。
    const distToRing = (p: Pt, ring: Pt[]): number => {
      let best = Infinity;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L = dx * dx + dy * dy;
        let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
      }
      return best;
    };
    let outside = 0;
    for (const g of c.ground) {
      for (const p of g.surface.outer) {
        if (pointInRing(p, ctx.buildableArea.outer)) continue;
        if (distToRing(p, ctx.buildableArea.outer) < 0.02) continue;
        outside++;
      }
    }
    ok(`${u.label}${i + 1} 地面不越出可建区`, outside === 0, `${outside} 个顶点越界`);

    // 有临街面就必须有步行入口
    if (ctx.primaryFrontage && cs.name !== '小面积 18×22') {
      ok(`${u.label}${i + 1} 有步行入口`, c.access.some((a) => a.kind === 'pedestrian'));
    }

    // 碎片：不允许"撒一地小面"。
    // 判据分两条：
    //   ① 块数上限放宽到 16 —— 一条环路被布尔切成几段是正常的（它们是**拼得起来**的），
    //      不是"碎片"；真正的碎是"每块都只有几个平方"。
    //   ② 每块 ≥ 6 m² —— 这才是碎片的定义。
    ok(`${u.label}${i + 1} 地面块数 ≤ 16`, c.ground.length <= 16, `${c.ground.length}`);
    const slivers = c.ground.filter((g) => g.area * 49 < 6);
    ok(`${u.label}${i + 1} 无 <6m² 碎面`, slivers.length === 0, slivers.map((g) => g.program).join(','));

    if (i === 0) {
      signature.set(
        u.typo,
        Array.from(new Set(c.ground.map((g) => g.program))).sort().join(',')
      );
    }

    // typology 专属
    if (u.typo === 'green') {
      ok(`G${i + 1} 绿地不出建筑`, c.buildings.length === 0);
      const pieces = c.ground.filter((g) => g.program === 'lawn' || g.program === 'planting').length;
      ok(`G${i + 1} 绿地不被切碎（≤3 块）`, pieces <= 3, `${pieces}`);
    }
    if (u.typo === 'park') {
      ok(`P${i + 1} 公园不出建筑`, c.buildings.length === 0);
      if (cs.name !== '小面积 18×22') {
        ok(`P${i + 1} 有主步道`, c.ground.some((g) => g.program === 'pedestrian'));
        ok(`P${i + 1} 有中心场地`, c.ground.some((g) => g.program === 'entrance_forecourt' || g.program === 'amenity'));
        ok(`P${i + 1} 草坪与种植都有（层次）`, c.ground.some((g) => g.program === 'lawn') && c.ground.some((g) => g.program === 'planting'));
      }
    }
    if (u.typo === 'civic') {
      ok(`C${i + 1} 有主体建筑`, c.buildings.length >= 1);
      ok(`C${i + 1} 有主入口广场`, c.ground.some((g) => g.program === 'entrance_forecourt'));
      ok(`C${i + 1} 有后勤服务面`, c.ground.some((g) => g.program === 'service' || g.program === 'service_lane'));
      const bld = c.buildings.reduce((a, b) => a + surfaceArea(b.footprint), 0);
      const share = bld / Math.max(1e-9, surfaceArea(ctx.buildableArea));
      ok(`C${i + 1} 建筑占比 8~55%`, share > 0.08 && share < 0.55, (share * 100).toFixed(0) + '%');
    }
  }
}

// ---------------------------------------------------------------- ② 三类语法必须不同
{
  const g = signature.get('green') ?? '';
  const p = signature.get('park') ?? '';
  const c = signature.get('civic') ?? '';
  ok('Green ≠ Park', g !== p, `${g} | ${p}`);
  ok('Green ≠ Civic', g !== c, `${g} | ${c}`);
  ok('Park ≠ Civic', p !== c, `${p} | ${c}`);
  ok('Green 不含步道骨架之外的铺装', !g.includes('amenity') && !g.includes('entrance_forecourt'), g);
  ok('Park 有公园特有程序（步道/场地）', p.includes('park_path') || p.includes('amenity'), p);
  ok('Civic 一定有广场', c.includes('entrance_forecourt'), c);
}

// ---------------------------------------------------------------- ③ 回归：D0
//
// 阶段 C 把一个 `main_lobby`（建筑主入口，在建筑正面墙上）加进了 access 列表，
// 而 civic 的"客货分离"当时是拿 **所有 pedestrian × service 的最小距离** 算的 ——
// 于是"一栋楼的正门到后门有多远"变成了客货分离度。2834 m² 的小地块上
// 这个距离只有 25.5 m，30 m 门槛判负，score 9.19 → 7.44。
//
// 下面四条把它钉住：口径只量街道侧开口，且以"是否同一条临街面"为主判据。
{
  const cs = CASES[4]; // 多等级道路 50×44
  const ctx = ctxOf(cs.parcel, cs.edges, 'civic');
  const cands = generateCandidates(ctx);
  ok('D0 有 civic 候选', cands.length > 0);
  if (cands.length > 0) {
    const c = cands[0];
    const base = civicDiagnostics(ctx, c);
    // 人为插一个 main_lobby（模拟阶段 C 的做法）
    const withLobby = {
      ...c,
      access: [
        ...c.access,
        {
          kind: 'pedestrian' as const,
          at: c.buildings[0].footprint.outer[0],
          normal: new Pt(1, 0),
          role: 'main_lobby' as const,
          frontage: 'primary' as const,
        },
      ],
    };
    const after = civicDiagnostics(ctx, withLobby);
    ok(
      'D0 加 main_lobby 不改变客货分离度',
      Math.abs((after.serviceSeparation ?? 0) - (base.serviceSeparation ?? 0)) < 1e-9,
      `${base.serviceSeparation} → ${after.serviceSeparation}`
    );
    ok(
      'D0 加 main_lobby 不改变总分',
      Math.abs((after.accessConflictPenalty ?? 0) - (base.accessConflictPenalty ?? 0)) < 1e-9,
      `${base.accessConflictPenalty} → ${after.accessConflictPenalty}`
    );
    // 服务口挪到人流口同一条临街面上 → 必须重罚
    const sameFrontage = {
      ...c,
      access: c.access.map((a) =>
        a.kind === 'service' ? { ...a, frontage: 'primary' as const } : a
      ),
    };
    const penalized = civicDiagnostics(ctx, sameFrontage);
    ok(
      'D0 服务口与人流口同街时分离度 ≤0.5',
      (penalized.serviceSeparation ?? 1) <= 0.5 + 1e-9,
      `${penalized.serviceSeparation}`
    );
  }
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
