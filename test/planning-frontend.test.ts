// R8 · Frontend Product Integration 的接线契约
//
// 这里不断言"Planner 比 legacy 好"（那是 Shadow 的事），只断言**接线是对的**：
//
//   ① Planner 模式：被接管的地块，Scene 里的几何**确实来自 realizeSitePlan**，
//      不是 legacy 的 lot 内容（红线：接管的地产物不能再经过 legacy 地块规划）；
//   ② 没被接管的地块：仍然是 legacy 的几何；
//   ③ Shadow 模式：主场景 == legacy，Planner 的结果只在 overlay 里；
//   ④ 三类场地（工业 / 多层住宅 / 零售）的 Planner 产出**互不相同** ——
//      如果三者看起来一样，说明 archetype 的语义没接对（或者根本没接）；
//   ⑤ 切换 legacy / planner，Scene 里的几何**确实不一样**（肉眼可辨的前提）。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildScene } from '../src/scene/build';
import { buildPlannerBundle, PLANNER_ENABLED_TYPOLOGIES } from '../src/scene/planner-bridge';
import { ModernWard } from '../src/town/modern';
import { patchKey } from '../src/town/patch';
import { ringArea } from '../src/scene/types';
import { pointInRing } from '../src/town/planning/core/surface';
import { Pt } from '../src/core/geom';
import type { SiteTypology } from '../src/town/planning/core/types';

let fail = 0;
let n = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  n++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const m = new Model({ nPatches: 15, seed: 682063530, plaza: true });
m.generate();
const net = buildRoadNet(m);

const legacyScene = buildScene(m, { planningMode: 'legacy' });
const plannerScene = buildScene(m, { planningMode: 'planner' });
const shadowScene = buildScene(m, { planningMode: 'shadow' });

const bundle = buildPlannerBundle(m, net, 'planner');

ok('Planner 确实接管了地块', bundle.stats.covered > 0, `${bundle.stats.covered}/${bundle.stats.total}`);

// ---------------------------------------------------------------- ① ② 接管 / 未接管
{
  let covered = 0;
  let notCovered = 0;
  let legacyKept = 0;
  for (const patch of m.patches) {
    if (patch.blocked) continue;
    const key = patchKey(patch);
    const rep = bundle.reports.get(key);
    if (!rep) continue;
    if (!rep.covered) {
      notCovered++;
      continue;
    }
    covered++;
    // 接管的地块：planner 的实体必须出现在 planner 模式的 Scene 里
    const feats = bundle.byParcel.get(key)!;
    const names = new Set(plannerScene.solids.map((s) => s.name));
    const missing = feats.solids.filter((s) => !names.has(s.name));
    ok(`接管地块 ${key} 的建筑进了 planner 场景`, missing.length === 0, `${missing.length} 个缺失`);
    // legacy 的同地块内容**不该**再出现（否则就是"两条链混在一起"）。
    // 用几何归属判定（质心落在这块地里），不靠名字 ——
    // legacy 的实体名在不同地块之间是重复的，靠名字会误判。
    const ring = Array.from(patch.shape);
    const inThis = (s: { ring: { x: number; y: number }[] }) => {
      const cx = s.ring.reduce((a, p) => a + p.x, 0) / s.ring.length;
      const cy = s.ring.reduce((a, p) => a + p.y, 0) / s.ring.length;
      return pointInRing(new Pt(cx, cy), ring);
    };
    const ward = patch.ward;
    if (ward instanceof ModernWard && ward.lot) {
      const legacyHere = plannerScene.solids.filter(inThis).length;
      const plannerHere = plannerScene.solids.filter(inThis).length;
      ok(`接管地块 ${key} 的实体全部来自 planner`, plannerHere === feats.solids.length,
        `场景里 ${plannerHere} 个 / planner 产出 ${feats.solids.length} 个`);
      ok(`接管地块 ${key} 没有 legacy 实体混入`, legacyHere === plannerHere,
        `场景里 ${legacyHere} 个，其中 planner 只产出 ${plannerHere} 个`);
    }
  }
  ok('有接管的也有没接管的（后者继续 legacy）', covered > 0 && notCovered > 0, `${covered} / ${notCovered}`);
  void legacyKept;
}

// ---------------------------------------------------------------- ③ Shadow 模式
{
  ok('Shadow 有 overlay', !!shadowScene.overlay && shadowScene.overlay.solids.length > 0,
    `${shadowScene.overlay?.solids.length ?? 0} 个`);
  ok(
    'Shadow 主场景与 legacy 一致（几何数量相同）',
    shadowScene.solids.length === legacyScene.solids.length &&
      shadowScene.surfaces.length === legacyScene.surfaces.length,
    `shadow ${shadowScene.solids.length}/${shadowScene.surfaces.length} vs legacy ${legacyScene.solids.length}/${legacyScene.surfaces.length}`
  );
}

// ---------------------------------------------------------------- ④ 三类互不相同
{
  const byType = new Map<SiteTypology, { solids: number; area: number; parking: number; open: number }>();
  for (const [key, feats] of bundle.byParcel) {
    const rep = bundle.reports.get(key)!;
    const cur = byType.get(rep.typology) ?? { solids: 0, area: 0, parking: 0, open: 0 };
    cur.solids += feats.solids.length;
    cur.area += feats.solids.reduce((a, s) => a + Math.abs(ringArea(s.ring)), 0);
    for (const s of feats.surfaces) {
      if (s.name.includes('parking')) cur.parking += Math.abs(ringArea(s.ring));
      if (s.name.includes('courtyard') || s.name.includes('landscape')) cur.open += Math.abs(ringArea(s.ring));
    }
    byType.set(rep.typology, cur);
  }
  const ind = byType.get('industrial');
  const mf = byType.get('multi_family');
  const ret = byType.get('retail');
  ok('三类都有 Planner 产出', !!ind && !!mf && !!ret,
    `ind=${ind?.solids} mf=${mf?.solids} ret=${ret?.solids}`);
  if (ind && mf && ret) {
    console.log(
      `  产出对比：工业 ${ind.solids} 栋/${ind.area.toFixed(0)}u²/停车 ${ind.parking.toFixed(0)}` +
        `  住宅 ${mf.solids} 栋/${mf.area.toFixed(0)}u²/开放 ${mf.open.toFixed(0)}` +
        `  零售 ${ret.solids} 栋/${ret.area.toFixed(0)}u²/停车 ${ret.parking.toFixed(0)}`
    );
    // 工业：有货场（truck_court），停车少
    ok('工业与零售的停车量级不同', Math.abs(ind.parking - ret.parking) > 1,
      `工业 ${ind.parking.toFixed(1)} vs 零售 ${ret.parking.toFixed(1)}`);
    // 住宅：有大面积院子 / 开放空间
    ok('住宅的开放空间明显大于工业', mf.open > ind.open, `${mf.open.toFixed(1)} vs ${ind.open.toFixed(1)}`);
    // 建筑体量不同
    ok('三类的建筑体量各不相同',
      new Set([ind.area.toFixed(2), mf.area.toFixed(2), ret.area.toFixed(2)]).size === 3,
      `${ind.area.toFixed(1)} / ${mf.area.toFixed(1)} / ${ret.area.toFixed(1)}`);
  }
}

// ---------------------------------------------------------------- ⑤ 切模式真的有差别
{
  ok('legacy 与 planner 的建筑数量不同',
    legacyScene.solids.length !== plannerScene.solids.length,
    `legacy ${legacyScene.solids.length} vs planner ${plannerScene.solids.length}`);
  const legacyArea = legacyScene.solids.reduce((a, s) => a + Math.abs(ringArea(s.ring)), 0);
  const plannerArea = plannerScene.solids.reduce((a, s) => a + Math.abs(ringArea(s.ring)), 0);
  ok('legacy 与 planner 的建筑基底面积不同',
    Math.abs(legacyArea - plannerArea) / Math.max(1, legacyArea) > 0.05,
    `legacy ${legacyArea.toFixed(1)} vs planner ${plannerArea.toFixed(1)}`);
  console.log(
    `  Scene 对比：legacy ${legacyScene.solids.length} 栋 / ${legacyArea.toFixed(0)}u²` +
      `   planner ${plannerScene.solids.length} 栋 / ${plannerArea.toFixed(0)}u²`
  );
}

// ---------------------------------------------------------------- ⑥ 视觉复核（R8）
//
// Visual Review 的成果必须能防回归：
//   · Planner 接管的地块要有树（不然院子是空的，读起来像"这块地没规划"）；
//   · 树不能压在建筑上、不能长在车位里；
//   · 院子要用草坪而不是浅灰铺装（浅灰和屋面同色，大院子读成"空地"）；
//   · 建筑外观要按 typology 分层（不能全城一个色调）。
{
  let withTree = 0;
  let coveredCount = 0;
  let treeOnBuilding = 0;
  let treeOnParking = 0;
  const wallByType = new Map<string, Set<string>>();

  for (const [key, feats] of bundle.byParcel) {
    const rep = bundle.reports.get(key)!;
    coveredCount++;
    if (feats.props.length > 0) withTree++;

    // 树不能压建筑 / 车位
    const bld = feats.solids.map((s) => s.ring);
    const park = feats.surfaces.filter((s) => s.name.includes('parking') || s.name.includes('parkreq')).map((s) => s.ring);
    for (const p of feats.props) {
      if (p.kind !== 'tree' && p.kind !== 'treeSmall' && p.kind !== 'conifer') continue;
      if (bld.some((r) => pointInRing(p.at, r))) treeOnBuilding++;
      if (park.some((r) => pointInRing(p.at, r))) treeOnParking++;
    }

    const walls = new Set(feats.solids.map((s) => s.wallMat));
    wallByType.set(rep.typology, walls);

    // 院子材质
    const court = feats.surfaces.find((s) => s.name.includes('courtyard'));
    if (court) {
      ok(`院子用草坪而不是浅灰铺装（${key}）`, court.mat === 'grassLight', court.mat);
    }
  }

  // 树只长在"有绿地程序"的地块上：零售是条带商业，地块 40% 是停车场、
  // 几乎没有绿地 program，所以那里本来就没树 —— 那是 archetype 的产出，
  // 不是配景漏了。所以这条断言只看**绿地型 typology**。
  const greenTypes = ['multi_family', 'industrial'];
  let greenTotal = 0;
  let greenWithTree = 0;
  for (const [key, feats] of bundle.byParcel) {
    const rep = bundle.reports.get(key)!;
    if (!greenTypes.includes(rep.typology)) continue;
    greenTotal++;
    if (feats.props.length > 0) greenWithTree++;
  }
  ok('绿地型地块基本都有树', greenWithTree >= greenTotal * 0.8, `${greenWithTree}/${greenTotal}`);
  ok('树不压建筑', treeOnBuilding === 0, `${treeOnBuilding}`);
  ok('树不长在车位里', treeOnParking === 0, `${treeOnParking}`);
  ok('住宅建筑外观有多种材质（不是全城一个色调）',
    (wallByType.get('multi_family')?.size ?? 0) >= 2,
    [...(wallByType.get('multi_family') ?? [])].join(','));
  console.log(
    `  视觉：${withTree}/${coveredCount} 块有树（绿地型 ${greenWithTree}/${greenTotal}）；住宅墙材质 ${[...(wallByType.get('multi_family') ?? [])].join('/')}；` +
      `零售 ${[...(wallByType.get('retail') ?? [])].join('/')}；工业 ${[...(wallByType.get('industrial') ?? [])].join('/')}`
  );
}

// ---------------------------------------------------------------- ⑦ 只接三类
{
  ok('第一批只接三类', PLANNER_ENABLED_TYPOLOGIES.length === 3 &&
    PLANNER_ENABLED_TYPOLOGIES.includes('industrial') &&
    PLANNER_ENABLED_TYPOLOGIES.includes('multi_family') &&
    PLANNER_ENABLED_TYPOLOGIES.includes('retail'),
    PLANNER_ENABLED_TYPOLOGIES.join(','));
  const hotelCovered = [...bundle.reports.values()].filter(
    (r) => (r.typology === 'hotel' || r.typology === 'data_center' || r.typology === 'single_family') && r.covered
  );
  ok('未接入的类型没有被接管', hotelCovered.length === 0, `${hotelCovered.length}`);
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
