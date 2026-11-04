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
  const plazaD = Math.min(Math.max(D * spec.plazaRatio, U(12)), U(28), D * 0.4);
  const rearD = Math.min(U(10), D * 0.12);
  const hallMaxD = D - plazaD - rearD - U(4);
  const hallD = Math.max(U(14), Math.min(D * 0.38, hallMaxD));
  const hallW = Math.max(U(14), Math.min(W * spec.hallWRatio, W - U(6)));
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

  // ---- ② 主入口广场：建筑正面到街之间
  //
  // 宽度略大于建筑（两侧各让 2 m），进深 = plazaD。广场必须**贴着建筑**，
  // 中间不能夹绿地 —— 那道绿地会把"广场 → 主入口"的序列切断。
  const plazaPad = U(2);
  const plaza = f.cut(
    Math.max(f.u0 + U(1), hallU0 - plazaPad),
    Math.min(f.u1 - U(1), hallU1 + plazaPad),
    f.v0 + U(1),
    hallV0
  );
  if (plaza) add('entrance_forecourt', plaza, '主入口广场');

  // ---- ③ 步行：街 → 广场 → 主入口
  const entryAt = f.at(uCenter, f.v0 + U(1));
  {
    const start = new Pt(entryAt.x + f.vDir.x * U(0.5), entryAt.y + f.vDir.y * U(0.5));
    const end = new Pt(entryAt.x + f.vDir.x * Math.max(U(2), plazaD - U(1)), entryAt.y + f.vDir.y * Math.max(U(2), plazaD - U(1)));
    const r = ribbon(start, end, U(6));
    const clipped = r ? clipTo(r, [buildable]) : null;
    if (clipped) add('pedestrian', clipped, '主入口步行带');
    access.push({
      kind: 'pedestrian',
      at: entryAt,
      normal: f.vDir,
      role: 'pedestrian',
      frontage: 'primary',
      notes: ['公众主入口'],
    });
  }

  // ---- ④ 服务：建筑背面一条窄带 + 侧口
  const svcV0 = hallV1;
  const svcV1 = Math.min(f.v1 - U(0.5), hallV1 + rearD);
  const svc = f.cut(f.u0 + U(1), f.u1 - U(1), svcV0, svcV1);
  if (svc) {
    add('service', svc, '后勤/服务通道');
    access.push({
      kind: 'service',
      at: f.at(f.u1 - U(3), svcV1 - U(0.5)),
      normal: new Pt(-f.vDir.x, -f.vDir.y),
      role: 'service',
      frontage: 'service',
      notes: ['后勤侧口'],
    });
  }

  // ---- ⑤ 停车：小规模，放侧面或背面
  let parkRegion: PlanSurface | null = null;
  if (spec.parking) {
    const parkW = Math.min((W - hallW) * 0.5 - U(1), U(22));
    if (parkW > U(8)) {
      const left = hallU0 - U(1) - parkW;
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
