// Core Freeze 的**机器校验**（docs/PLANNING_CORE_FREEZE.md 的执行版）
//
// 冻结如果只写在文档里，下一轮就会被"这个字段先加上，回头再整理"慢慢侵蚀。
// 这个测试把契约变成断言：
//   · SiteContext / Candidate 的键集合不许变；
//   · Diagnostics 不许出现清单外的字段；
//   · Ground Program 必须在枚举里；
//   · planning/ 目录不许 import three / DOM / scene / renderer（Pure Data 约束）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Pt } from '../src/core/geom';
import { surface } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateIndustrialRearLoadCandidates } from '../src/town/planning/archetypes/industrial/rear-load';
import { generateMultiFamilyCourtyardCandidates } from '../src/town/planning/archetypes/multifamily/courtyard';
import type { SiteRoadEdge } from '../src/town/planning/core/types';

let fail = 0;
let n = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  n++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const edge = (k: string, a: Pt, b: Pt, c: SiteRoadEdge['cls']): SiteRoadEdge => ({
  key: k,
  a,
  b,
  len: Pt.distance(a, b),
  cls: c,
  carriageSide: 1.0,
  sidewalk: 0.3,
  median: 0,
});

const parcel = surface([new Pt(0, 0), new Pt(22, 0), new Pt(22, 20), new Pt(0, 20)]);
const ctx = buildSiteContext({
  parcelId: 'freeze',
  parcel,
  use: 'industrial',
  edges: [edge('s', new Pt(0, 0), new Pt(22, 0), 'arterial'), edge('e', new Pt(22, 0), new Pt(22, 20), 'local')],
});

// ---------------------------------------------------------------- ① SiteContext 字段冻结
const CONTEXT_KEYS = [
  'parcelId', 'typology', 'parcel', 'use',
  'roadEdges', 'primaryFrontage', 'secondaryFrontage', 'serviceFrontage', 'orientation',
  'buildableArea',
  'pedestrianAccessCandidates', 'vehicleAccessCandidates', 'serviceAccessCandidates', 'truckAccessCandidates',
  'neighbors', 'notes',
];
{
  const keys = Object.keys(ctx).sort();
  ok('SiteContext 字段与冻结清单一致', JSON.stringify(keys) === JSON.stringify(CONTEXT_KEYS.slice().sort()), keys.join(','));
  // 禁止 typology 私有字段
  const forbidden = ['courtyard', 'truckCourt', 'hotelDropoff', 'driveThru', 'dataHall', 'pool', 'retailPlaza', 'plaza'];
  const leaked = keys.filter((k) => forbidden.includes(k));
  ok('SiteContext 没有 typology 私有字段', leaked.length === 0, leaked.join(','));
  ok('SiteContext 可 JSON 序列化', JSON.stringify(ctx).length > 100);
}

// ---------------------------------------------------------------- ② Candidate 字段冻结
const CANDIDATE_KEYS = ['id', 'typology', 'archetype', 'buildings', 'ground', 'access', 'parkingRequests', 'circulation', 'notes'];
const CAND_OPTIONAL = ['score', 'diagnostics'];
{
  const ind = generateIndustrialRearLoadCandidates(ctx)[0];
  const mf = generateMultiFamilyCourtyardCandidates(ctx)[0];
  ok('工业 Candidate 字段冻结', !!ind && sameKeys(ind, CANDIDATE_KEYS, CAND_OPTIONAL), ind ? Object.keys(ind).join(',') : 'none');
  ok('住宅 Candidate 字段冻结', !!mf && sameKeys(mf, CANDIDATE_KEYS, CAND_OPTIONAL), mf ? Object.keys(mf).join(',') : 'none');
  ok('子结构字段冻结（Building）', sameKeys(ind!.buildings[0], ['role', 'footprint', 'height'], ['frontSide', 'loadingSide', 'notes']));
  ok('子结构字段冻结（Region）', sameKeys(ind!.ground[0], ['program', 'surface', 'area'], ['notes']));
  ok('子结构字段冻结（Access）', sameKeys(ind!.access[0], ['kind', 'at', 'normal', 'role', 'frontage'], ['notes']));
  ok('子结构字段冻结（ParkingRequest）', sameKeys(ind!.parkingRequests[0], ['role', 'region', 'targetDensity'], ['preferredEntry', 'notes']));
  ok('Candidate 可 JSON 序列化', JSON.stringify(ind).length > 200);
  ok('Candidate 无函数字段', !hasFunction(ind));
}

// ---------------------------------------------------------------- ③ Diagnostics 白名单
const DIAG_ALLOWED = [
  'accessClarity', 'frontageQuality', 'buildingRegularity', 'groundUsability', 'circulationQuality',
  'deadSpacePenalty', 'fragmentationPenalty', 'accessConflictPenalty',
  'typologyFit', 'parkingQuality', 'openSpaceQuality',
  'spatialCoreQuality', 'pedestrianClarity', 'enclosureRatio',
  'serviceSeparation', 'narrowResidualPenalty',
];
const DIAG_REQUIRED = [
  'accessClarity', 'frontageQuality', 'buildingRegularity', 'groundUsability', 'circulationQuality',
  'deadSpacePenalty', 'fragmentationPenalty', 'accessConflictPenalty',
];
{
  const ind = generateIndustrialRearLoadCandidates(ctx)[0]!;
  const mf = generateMultiFamilyCourtyardCandidates(ctx)[0]!;
  for (const [name, c] of [['工业', ind], ['住宅', mf]] as const) {
    const keys = Object.keys(c.diagnostics!);
    const extra = keys.filter((k) => !DIAG_ALLOWED.includes(k));
    ok(`${name} Diagnostics 没有清单外字段`, extra.length === 0, extra.join(','));
    const missing = DIAG_REQUIRED.filter((k) => !(k in c.diagnostics!));
    ok(`${name} Diagnostics 具备必填项`, missing.length === 0, missing.join(','));
  }
}

// ---------------------------------------------------------------- ④ Ground Program 白名单
const PROGRAM_ALLOWED = [
  'office_forecourt', 'employee_parking', 'landscape_buffer', 'loading_apron', 'truck_court', 'service_lane', 'utility_yard',
  'courtyard', 'amenity', 'entrance_forecourt', 'pedestrian', 'parking', 'landscape', 'service',
  // 酒店（Freeze 后新增 2 个）
  'arrival_court', 'dropoff',
  // 数据中心（Freeze 后新增 3 个）
  'mechanical_yard', 'electrical_yard', 'security_buffer',
  // 独栋住宅（Freeze 后新增 4 个）
  'front_yard', 'rear_yard', 'driveway', 'community_green',
  'residual',
];
{
  const all = [...generateIndustrialRearLoadCandidates(ctx), ...generateMultiFamilyCourtyardCandidates(ctx)];
  const extra = new Set<string>();
  for (const c of all) for (const g of c.ground) if (!PROGRAM_ALLOWED.includes(g.program)) extra.add(g.program);
  ok('Ground Program 都在冻结枚举内', extra.size === 0, [...extra].join(','));
}

// ---------------------------------------------------------------- ⑤ Pure Data：planning/ 不许碰渲染
{
  const root = 'src/town/planning';
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);
  const banned = [/from ['"]three['"]/, /\bdocument\./, /\bwindow\./, /from ['"].*\/scene\//, /from ['"].*\/export\//, /from ['"].*\/render\//];
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of banned) if (re.test(src)) hits.push(`${f} → ${re.source}`);
  }
  ok('planning/ 不依赖 three / DOM / scene / renderer', hits.length === 0, hits.slice(0, 3).join(' | '));
  ok('planning/ 有代码文件', files.length >= 8, `${files.length}`);
}

// ---------------------------------------------------------------- ⑥ 确定性
{
  const a = generateIndustrialRearLoadCandidates(ctx);
  const b = generateIndustrialRearLoadCandidates(ctx);
  const fa = a.map((c) => c.ground.map((g) => Math.round(g.area * 1000)).join(',')).join('|');
  const fb = b.map((c) => c.ground.map((g) => Math.round(g.area * 1000)).join(',')).join('|');
  ok('同一 SiteContext 连续生成结果一致（确定性）', fa === fb);
}

// ---------------------------------------------------------------- 工具
function sameKeys(obj: object, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(obj);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((k) => !allowed.has(k))) return false;
  return required.every((k) => k in obj);
}

function hasFunction(v: unknown): boolean {
  if (typeof v === 'function') return true;
  if (Array.isArray(v)) return v.some(hasFunction);
  if (v && typeof v === 'object') return Object.values(v as object).some(hasFunction);
  return false;
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
