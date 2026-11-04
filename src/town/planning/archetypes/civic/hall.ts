// Archetype · Civic（公共服务设施用地）
//
// ## 语法：建筑是锚点，广场是主语
//
// 公共建筑（政务中心 / 文化馆 / 社区卫生中心 / 学校主楼）和前三种用地都不一样：
// 它不是"把地卖出去盖满"，而是**一栋正经的房子 + 一个正经的广场**。
// 人在街上先看到广场，再看到房子的主入口 —— 这个序列就是 civic 的全部。
//
// 所以顺序是：
//   ① 建筑：一栋体量明确的"厅"，正面朝主临街面，退一个广场进深；
//   ② 主入口广场：建筑正面和街道之间那块硬地，宽度跟建筑走；
//   ③ 步行：从街上穿过广场到建筑入口，一条直的；
//   ④ 服务/后勤：建筑背面一条窄带 + 一个侧口，不和人的流线打架；
//   ⑤ 停车：小规模，放在侧面或背面（公共建筑不靠停车当门面）；
//   ⑥ 绿：剩下的地给草坪，不切碎。
//
// ## 三个变体
//
//   civic-front-plaza   建筑居中、广场在建筑正前方          —— 最常见
//   civic-corner-plaza  建筑偏一侧、广场占住街角            —— 转角地块
//   civic-compact       小地块：浅退线、小广场、不设地面停车

import { Pt } from '../../../../core/geom';
import { surfaceArea, type PlanSurface } from '../../core/surface';
import type { SiteContext } from '../../core/types';
import type { ParkingRequest, PlannedAccess, PlannedBuilding, PlannedRegion, SitePlanCandidate } from '../../core/candidate';
import { siteFrame, ribbon, clipTo, minusAll, type SiteFrame } from '../shared/frame';
import { buildingEnvelope, serviceEnvelope } from '../shared/anchors';
import { areaBudgetOf, formatBudget } from '../shared/budget';
import { evaluateLayout, weightsFor } from '../../core/evaluator';
import { civicDiagnostics } from '../../typologies/civic';

const U = (m: number) => m / 7;

type Variant = 'civic-front-plaza' | 'civic-corner-plaza' | 'civic-compact';

interface Spec {
  id: Variant;
  /** 建筑面宽占场地宽度的比例 */
  hallWRatio: number;
  /** 建筑在 u 方向的偏移（-0.5 靠左，0 居中，0.5 靠右） */
  shift: number;
  /** 广场进深占场地进深的比例 */
  plazaRatio: number;
  /** 是否设地面停车 */
  parking: boolean;
}

const VARIANTS: Spec[] = [
  { id: 'civic-front-plaza', hallWRatio: 0.62, shift: 0, plazaRatio: 0.2, parking: true },
  { id: 'civic-corner-plaza', hallWRatio: 0.55, shift: 0.28, plazaRatio: 0.24, parking: true },
  { id: 'civic-compact', hallWRatio: 0.72, shift: 0, plazaRatio: 0.14, parking: false },
];

const COMPACT_ONLY_M2 = 5000;

export function generateCivicCandidates(ctx: SiteContext): SitePlanCandidate[] {
  const f = siteFrame(ctx);
  if (!f) return [];
  const lotM2 = surfaceArea(ctx.parcel) * 49;
  if (lotM2 < 1200) return [];

  const specs = lotM2 < COMPACT_ONLY_M2 ? VARIANTS.slice(2) : VARIANTS;
  const out: SitePlanCandidate[] = [];
  for (const spec of specs) {
    const c = build(ctx, f, spec);
    if (c) out.push(c);
  }
  for (const c of out) {
    c.diagnostics = civicDiagnostics(ctx, c);
    c.score = evaluateLayout(c.diagnostics, { weights: weightsFor('civic') }).score;
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

function build(ctx: SiteContext, f: SiteFrame, spec: Spec): SitePlanCandidate | null {
  const buildable = ctx.buildableArea;
  const lotA = surfaceArea(buildable);
  if (lotA < U(20) * U(20)) return null;

  const ground: PlannedRegion[] = [];
  const access: PlannedAccess[] = [];
  const buildings: PlannedBuilding[] = [];
  const parkingRequests: ParkingRequest[] = [];
  const notes: string[] = [];
  const add = (program: PlannedRegion['program'], s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };

  const W = f.W;
  const D = f.D;

  // ---- ① 建筑：一栋"厅"
  //
  // 进深 = 场地进深的 38%，但夹在 [16 m, D − 广场 − 后勤] 之间；
  // 面宽按变体比例，居中或偏一侧。高度 4 层（公共建筑不会太高）。
  // 前场进深 = **建筑入口界面宽度 × 0.45**（集散进深的代理参数），
  // 夹在 [10 m, 26 m] 之间，并且不能超过场地进深的 40%。
  //
  // 为什么不用"场地进深的 20%"：那是按地块形状定，不是按需求定 ——
  // 一栋 70 m 宽的大厅配 20 m 深的前场（比例 0.28）是完全正常的，
  // 而一栋 20 m 宽的小楼配 23 m 深的前场就是一片没人用的空场。
  // 没有真实人流量数据，界面宽度是最诚实的代理：门口多宽，集散就多深。
  // 变体里的 plazaRatio 退化成"上限系数"，不再主导。
  const hallW0 = Math.max(U(14), Math.min(W * spec.hallWRatio, W - U(6)));
  // 再加一条"可用空间"上限：前场（含两侧各 2 m）不得超过可建区的 28%。
  // 小地块上"界面宽 × 0.45"会切出一块比建筑还大的空场 —— 那不是集散需求，
  // 是没地方放别的东西。
  const plazaW0 = Math.min(W - U(2), hallW0 + U(4));
  const byArea = (surfaceArea(buildable) * 0.28) / Math.max(plazaW0, U(6));
  const plazaD = Math.min(
    Math.max(hallW0 * 0.45, U(10), D * spec.plazaRatio * 0.6),
    U(26),
    D * 0.4,
    Math.max(U(8), byArea)
  );
  const rearD = Math.min(U(10), D * 0.12);
  const hallMaxD = D - plazaD - rearD - U(4);
  const hallD = Math.max(U(14), Math.min(D * 0.38, hallMaxD));
  const hallW = hallW0;
  if (hallD < U(12) || hallW < U(12)) return null;

  const uCenter = (f.u0 + f.u1) / 2 + spec.shift * (W - hallW) * 0.5;
  const hallU0 = uCenter - hallW / 2;
  const hallU1 = uCenter + hallW / 2;
  const hallV0 = f.v0 + plazaD;
  const hallV1 = hallV0 + hallD;

  const hall = f.cut(hallU0, hallU1, hallV0, hallV1);
  if (!hall) return null;
  buildings.push({
    role: 'hall',
    footprint: hall,
    height: U(15),
    frontSide: new Pt(-f.vDir.x, -f.vDir.y), // 正面朝街（v 的反向）
    notes: ['公共建筑主体（主入口朝主临街面）'],
  });
  const hallA = surfaceArea(hall);
  if (hallA / lotA < 0.12) return null;

  // ---- ② 建筑入口锚点（C1）：从**实际 footprint 的沿街那条外边**推，不用质心
  //
  // 质心永远在体量内部，从质心发出的入口会穿墙。这里取"朝向主临街面、且离街最近"
  // 的那条外边中点，法线朝街 —— 它就是"建筑入口界面"，前场的宽度也以它为准。
  const streetPoint = f.at(0, f.v0);
  const streetNormal = new Pt(-f.vDir.x, -f.vDir.y);
  const mainEnv = buildingEnvelope({ role: 'hall', footprint: hall, height: U(15), notes: [] }, streetNormal, streetPoint);
  const mainAt = mainEnv ? mainEnv.at : f.at(uCenter, hallV0);
  const mainN = mainEnv ? mainEnv.normal : streetNormal;
  const ifaceW = mainEnv ? mainEnv.width : hallW;
  notes.push(`建筑主入口界面 ${(ifaceW * 7).toFixed(0)} m（沿街外边中点）`);

  // ---- ③ 主入口广场：建筑正面到街之间
  //
  // 宽度跟着**入口界面**走（两侧各让 2 m），进深 = plazaD（上面按界面宽反推）。
  // 广场必须**贴着建筑**，中间不能夹绿地 —— 那道绿地会把"广场 → 主入口"的序列切断。
  const plazaPad = U(2);
  const plazaU0 = Math.max(f.u0 + U(1), hallU0 - plazaPad);
  const plazaU1 = Math.min(f.u1 - U(1), hallU1 + plazaPad);
  const plaza = f.cut(plazaU0, plazaU1, f.v0 + U(1), hallV0);
  if (plaza) add('entrance_forecourt', plaza, `主入口广场（宽 ${((plazaU1 - plazaU0) * 7).toFixed(0)} m × 深 ${(plazaD * 7).toFixed(0)} m）`);

  // ---- ④ 步行：街 → 广场 → **建筑入口**
  //
  // 原来这条带只画到广场进深减 1 m，离建筑还有 1 m 的缝 —— 序列就断在门口。
  // 现在终点直接取建筑入口锚点，等于"从人行道一路铺到门槛"。
  const entryAt = f.at((plazaU0 + plazaU1) / 2, f.v0 + U(1));
  {
    const start = new Pt(entryAt.x + f.vDir.x * U(0.5), entryAt.y + f.vDir.y * U(0.5));
    const r = ribbon(start, mainAt, U(6));
    const clipped = r ? clipTo(r, [buildable]) : null;
    if (clipped) add('pedestrian', clipped, '主入口步行带（街 → 建筑入口）');
    access.push({
      kind: 'pedestrian',
      at: entryAt,
      normal: f.vDir,
      role: 'pedestrian',
      frontage: 'primary',
      notes: ['公众主入口（街道侧）'],
    });
    // 建筑入口本身作为一个锚点登记：main_lobby 的语义是"到达序列的终点"，
    // 它不是街道开口，所以法线取**朝外**（从建筑指向广场）。
    access.push({
      kind: 'pedestrian',
      at: mainAt,
      normal: mainN,
      role: 'main_lobby',
      frontage: 'primary',
      notes: ['建筑主入口（由 footprint 沿街外边推导）'],
    });
  }

  // ---- ⑤ 服务：建筑背面一条窄带 + 侧口
  //
  // 服务口的位置由**建筑背面那条外边**决定（`serviceEnvelope` 选与主入口方向
  // 夹角最背、距离最远的一条），不是拍一个"右上角"。这样后勤面天然贴在
  // 主展示界面的反侧，垃圾车/货车不会从广场上穿过去。
  const svcV0 = hallV1;
  const svcV1 = Math.min(f.v1 - U(0.5), hallV1 + rearD);
  const svc = f.cut(f.u0 + U(1), f.u1 - U(1), svcV0, svcV1);
  const svcEnv = serviceEnvelope({ role: 'hall', footprint: hall, height: U(15), notes: [] }, { at: mainAt, normal: mainN });
  if (svc) {
    add('service', svc, '后勤/服务通道（建筑背面）');
    access.push({
      kind: 'service',
      at: svcEnv ? svcEnv.at : f.at(f.u1 - U(3), svcV1 - U(0.5)),
      normal: svcEnv ? svcEnv.normal : new Pt(-f.vDir.x, -f.vDir.y),
      role: 'service',
      frontage: 'service',
      notes: ['后勤口（建筑背面的外边中点）'],
    });
  }

  // ---- ⑤ 停车：小规模，放侧面或背面
  let parkRegion: PlanSurface | null = null;
  if (spec.parking) {
    const parkW = Math.min((W - hallW) * 0.5 - U(1), U(22));
    if (parkW > U(8)) {
      const left = hallU0 - U(1) - parkW;
      // 停车**从建筑正面那条线往后再起**：v0p >= hallV0 保证它和前场（v0+1 ~ hallV0）
      // 在进深上完全分开 —— "停车不能侵占主入口前场"这条由此成立，不靠事后检查。
      const v0p = Math.max(f.v0 + U(2), hallV0);
      const v1p = Math.min(f.v1 - U(1), hallV0 + Math.max(hallD, U(20)));
      parkRegion = left > f.u0 + U(1) ? f.cut(left, left + parkW, v0p, v1p) : f.cut(hallU1 + U(1), hallU1 + U(1) + parkW, v0p, v1p);
      if (parkRegion && surfaceArea(parkRegion) / lotA > 0.06) {
        add('parking', parkRegion, '访客停车（侧向，不做门面）');
        parkingRequests.push({
          role: 'visitor',
          region: parkRegion,
          targetDensity: 'low',
          notes: ['公共建筑访客停车'],
        });
      } else {
        parkRegion = null;
      }
    }
  }

  // ---- ⑥ 绿：剩下的地整块草坪
  //
  // 直接铺整块可建区，靠 ownership 优先级（lawn 36）被广场 / 步行 / 后勤 / 停车
  // 切出来 —— 不做布尔，少一次可能失败的裁剪，也不会漏掉边角。
  // 草坪 = 可建区 − 建筑 − 广场 − 步行 − 后勤 − 停车。
  //
  // 减法在这里做，不留给 ownership：诊断分是在 Candidate 上算的
  //（绿地率 / 铺装率都是），整块铺再让广场叠上去会读到 100% + 14% = 114%。
  const cutters = [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)];
  for (const rest of minusAll(buildable, cutters)) add('lawn', rest, '场地绿化（连续草坪）');

  if (ground.length === 0) return null;

  const budget = areaBudgetOf(ctx, ground, buildings);
  notes.push(formatBudget(budget));

  return {
    id: spec.id,
    typology: 'civic',
    archetype: spec.id,
    buildings,
    ground,
    access,
    parkingRequests,
    circulation: [],
    notes: [...notes, `广场进深 ${(plazaD * 7).toFixed(0)} m，建筑 ${(hallW * 7).toFixed(0)}×${(hallD * 7).toFixed(0)} m`],
  };
}
