// 全城几何审计的轻量回归
//
// 只跑固定 one seed（15 patch / 52 block），断言**总量级**而不是精确值 ——
// 精确值会随生成器微调漂移，但"有没有大面积缺口 / 有没有成片重叠"必须稳定。
//
// 阈值是**上界**，不是目标：
//   · C（真几何缺口）必须接近 0 —— 城内不该有"什么都没铺"的地方；
//   · B（只有底板）是已知的残余（道路边缘与红线之间的窄条），给 12% 上限；
//   · 精确重叠是 0.0X% 量级的毛刺，给 40 m² 上限（当前 20 m²）。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { auditCoverage, auditOverlap } from '../src/diagnostics/geometry-audit';
import { greenSubdivStats } from '../src/town/greenspace';

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

// ---------------------------------------------------------------- D1 覆盖
{
  const cov = auditCoverage(m, net);
  const A = cov.share['A-road'] + cov.share['A-building'] + cov.share['A-planned'];
  console.log(
    `D1 覆盖（${cov.blocks.length} 块 ${(cov.totalM2 / 10000).toFixed(1)}ha）：` +
    `A ${(A * 100).toFixed(1)}%（路 ${(cov.share['A-road'] * 100).toFixed(1)} ` +
    `建 ${(cov.share['A-building'] * 100).toFixed(1)} 划 ${(cov.share['A-planned'] * 100).toFixed(1)}）` +
    ` B ${(cov.share['B-plate'] * 100).toFixed(1)}% C ${(cov.share['C-hole'] * 100).toFixed(1)}%`
  );
  ok('D1 A 类占比 ≥88%', A >= 0.88, `${(A * 100).toFixed(1)}%`);
  ok('D1 C 真缺口 ≤1%', cov.share['C-hole'] <= 0.01, `${(cov.share['C-hole'] * 100).toFixed(2)}%`);
  ok('D1 B 仅底板 ≤12%', cov.share['B-plate'] <= 0.12, `${(cov.share['B-plate'] * 100).toFixed(1)}%`);
  ok('D1 无非法环', cov.invalidRings.length === 0, cov.invalidRings.slice(0, 3).join(','));
  ok('D1 每块都有面积归属', cov.blocks.every((b) => b.totalM2 > 0));

  // D3：B 类必须有成因归类，且"说不清"的那一类要足够小
  const br = cov.bReason;
  const bTotal = Object.values(br).reduce((a, v) => a + v, 0);
  const unclassified = br.unclassified / Math.max(bTotal, 1);
  console.log(
    `D3 B 类成因：` +
    Object.entries(br).map(([k, v]) => `${k} ${((v / Math.max(bTotal, 1)) * 100).toFixed(0)}%`).join(' · ') +
    `（B 合计 ${(bTotal / 10000).toFixed(2)} ha）`
  );
  ok('D3 B 类全部有成因归类', unclassified <= 0.25, `${(unclassified * 100).toFixed(0)}% 未归类`);
  // G0：原因标签必须把 B 类**全部**划分掉（互斥且穷尽），且每条都有几何证据
  const gl = cov.gLabels;
  const labelSum = Object.values(gl).reduce((a, v) => a + v.m2, 0);
  const bSum = Object.values(br).reduce((a, v) => a + v, 0); // bReason 已是 m²
  console.log('G0 原因标签：' + Object.entries(gl).sort((a, b) => b[1].m2 - a[1].m2)
    .map(([k, v]) => `${k} ${(v.share * 100).toFixed(0)}%`).join(' · '));
  ok('G0 标签穷尽覆盖 B 类', Math.abs(labelSum - bSum) / Math.max(bSum, 1) < 0.01, `${labelSum} vs ${bSum}`);
  ok('G0 每条标签都有几何证据', Object.values(gl).every((v) => !!v.sample?.evidence), JSON.stringify(Object.keys(gl)));
  ok('G0 unknown 占比 ≤10%', (gl.unknown?.share ?? 0) <= 0.1, `${((gl.unknown?.share ?? 0) * 100).toFixed(1)}%`);
  ok('D3 场景自述完整', cov.scenario.cityBlocks > 0 && cov.scenario.seed === 682063530, JSON.stringify(cov.scenario));
}

// ---------------------------------------------------------------- D2 精确重叠
{
  const ov = auditOverlap(m, net);
  console.log(
    `D2 精确重叠：${ov.blocks} 块 / ${ov.surfaces} 面，候选对 ${ov.pairsTested}，` +
    `冲突 ${ov.conflicts.length} 处 ${ov.totalM2} m²；绿地静默空切 ${greenSubdivStats.residualOverlap} 块`
  );
  ok('D2 无非法环', ov.invalidRings.length === 0, ov.invalidRings.slice(0, 3).join(','));
  // 阶段 D 之后精确重叠应该是 **0**。留 5 m² 余量只是给"多边形退化出的小三角"，
  // 不是给"还没修完的成片重叠"。
  ok('D2 精确重叠 ≤5m²', ov.totalM2 <= 5, `${ov.totalM2}m²`);
  ok('D2 冲突处数 ≤1', ov.conflicts.length <= 1, `${ov.conflicts.length}`);
  // 阶段 D 修掉的第一类根因：横竖两组绿化带子在交叉口互相重叠。
  // 修完不该再出现 path × path。
  const pathPath = ov.conflicts.filter((c) => /_path_\d+$/.test(c.a) && /_path_\d+$/.test(c.b));
  ok('D2 无 path × path 自重叠', pathPath.length === 0, pathPath.map((c) => c.block).join(','));
  // 静默空切必须被计数（可以为 0，但不能"没有这个信号"）
  ok('D2 静默空切有计数出口', typeof greenSubdivStats.residualOverlap === 'number');
  ok('D2 静默空切 0 块', greenSubdivStats.residualOverlap === 0, `${greenSubdivStats.residualOverlap}`);
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
