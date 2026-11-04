# TownForge 开发说明（交接给下一次 AI 对话）

> 这份文档是给"另一个对话里的 AI"看的。读它可以快速接上上下文，知道**哪些能改、哪些别动、现在卡在哪**。
> 最后更新：2026-11-04 · commit `ef96fd2`

---

## 0. 一句话现状

城市生成管线已经完整可用（Road → Block → Planner → Scene/GLB），
**Planner 覆盖 47/52 块，非法重叠 0 m²，真几何缺口 0%**。
正在做 **R1（建筑驱动的内部交通）**：多源 Dijkstra 已跑通，**共享率还是 0%、`svc` 连通未过**。
Phase M（城市形态场）**完全没开始**。

---

## 1. 技术栈与运行

- TypeScript + Vite，纯前端，无后端。Canvas 2D 编辑器 + three.js 3D 预览 + GLB 导出。
- **1 世界单位 = 7 m**。代码里到处是 `const U = (m: number) => m / 7;`，看到 `U(12)` 就是 12 m。
- 坐标系：Y 轴向上，2D 画布是 Y 翻转的（`y_canvas = (y1 - y) * S`）。

```bash
cd townforge
npx vite --port 5190            # 必须用后台托管启动，`(npx vite &)` 会被回收
npx tsc --noEmit                # 类型检查（改完必跑）
npx tsx test/<name>.test.ts     # 单跑一个测试
```

固定场景（**所有报告里的数字都属于这一个场景，不要跨种子混用**）：

```
seed 682063530 · nPatches 15 · plaza on
patch 52（其中 44 块 withinCity）· Planner 覆盖 47
```

---

## 2. 目录分层（从上到下，依赖只能向下）

```
src/core/geom.ts            Pt / 向量工具
src/town/model.ts           城市生成：张量场 → patch → 分配 use
src/town/landuse.ts         用地分配（半径分位数 + 临街等级）
src/road/system.ts          路网：边 / 路口 / 条带 / 圆角 / 标线 / edgeFootprint
src/town/patch.ts           patch 与稳定 ID（patchKey）
src/town/planning/          ★ 规划核心（见 §3）
src/town/realize/           落地：Candidate → SceneIR
src/scene/                  SceneIR 类型 / buildScene / palette
src/render/svg.ts, src/ui/  2D 渲染、编辑器
src/diagnostics/            ★ 只读审计（不进网页热路径）
test/*.test.ts              25 个测试脚本（tsx 直接跑，无框架）
tmp/*.ts                    我的临时探针（不要当成 API，很多是一次性的）
```

### `src/town/planning/` 内部分层

```
core/        冻结契约：types.ts(SiteContext) / candidate.ts / surface.ts(PlanSurface+布尔)
             evaluator.ts(评分) / context.ts(buildSiteContext, typologyOfUse)
adapters/    model.ts: 从 Model 造 SiteContext（parcelOf 在这里）
generators.ts 唯一出口：generateCandidates(ctx) → 矩形化 → 补量 → 残地 → 评分
archetypes/  各 typology 的"语法"（见 §4）
typologies/  各 typology 的权重 / 地面白名单 / diagnostics
circulation/ ★ R1 内部交通求解器（实验，未接入生产）
```

### `src/town/realize/`（顺序固定，不要打乱）

```
realizeSitePlan(candidate, ctx):
  realizeRoads → realizeGround(含 ownership 切割 + 退线带 + 绿地分块)
  → realizeBuildings → realizeAccess(空) → realizeParkingRequests → realizeParking
  → realizeCirculation → realizeScenery
```

---

## 3. 冻结 / 不要动的东西

| 东西 | 原因 |
|---|---|
| `planning/core/types.ts` 的 `SiteContext` | 所有 archetype 都吃它，改一处全崩 |
| `planning/core/candidate.ts` 的 `SitePlanCandidate` | 同上；**可以加可选字段**，不能改已有字段语义 |
| `PlanSurface`（外环 + holes）与 `surface*` 布尔函数 | 整个几何层的地基 |
| `ground-ownership.ts` 的优先级表 | 决定"同一块地谁归谁"，动它会全局错位 |
| `road/system.ts` 的路网拓扑（边/路口/中心线） | 用户明确禁止重写 |
| `parking.ts` 的 `solveParking` | 用户明确禁止改 |

**可以加**：新 archetype、新 typology、新 GroundProgram、可选字段、diagnostics。
加 GroundProgram 要同步四处：`candidate.ts` 的联合类型、`realize/contract.ts` 的
`GROUND_MATERIAL` + `GROUND_LIFT`、`ground-ownership.ts` 的优先级、`realize/scenery.ts` 的 `PLANTABLE`。

---

## 4. 已完成的能力（可以放心复用）

### 4.1 九套 archetype

| typology | 文件 | 要点 |
|---|---|---|
| industrial | `archetypes/industrial/rear-load.ts` | 前办公 + 后仓库 + 货场，客货分离 |
| retail | `archetypes/retail/strip.ts` | 店铺带 + 停车 + 塔楼（高度只看面积，待 M1 改） |
| multi_family | `archetypes/multifamily/{courtyard,principal-axis,principal-court}.ts` | 围合庭院；临街门洞 6 m |
| hotel / data_center / single_family | 各自 | |
| green | `archetypes/green/meadow.ts` | 按尺度选变体：无临街→reserve、≥4ha→grove、其余 meadow |
| park | `archetypes/park/paths.ts` | 入口→环路→节点→中心；**十字/环形两种** |
| civic | `archetypes/civic/hall.ts` | 建筑锚点 + 前场（进深按入口界面宽度反推） |

### 4.2 共享工具（**别再造第二份**）

```ts
siteFrame(ctx)            // 局部坐标系（u=沿街, v=向内）；探针距离必须 > 退线
ribbon(a, b, w)           // 任意方向路带
clipTo(area, [rings])     // 裁到某个面
minusAll(base, cutters)   // 从 base 挖掉若干块（**在 archetype 内先挖，别留给 ownership**）
streetBuffer(ctx,f,b,d)   // 沿街绿化缓冲
buildingEnvelope(b, n, p) // 建筑主入口 = 朝街那条外边中点（**不是质心**）
serviceEnvelope(b, main)  // 服务口 = 离主入口最远、朝外的外边
areaBudgetOf(ctx, ground, buildings) // 七科目面积预算 + 守恒检查
```

### 4.3 几何质量（已修，别回退）

- 街角人行道：`cornerPaving` 用 `offsetPolyline`（沿路缘折线偏移），不是两直线求交。
  172 个转角平均 25.7 顶点。**早期版本的"宽路口退成折线"已解决。**
- 道路端头：车行道两端各往路口里压 0.2 单位消除接缝。
- 绿地分块：横带减竖带（消除交叉口重复占用）；倒角只许变小（凹角会撑大）。
- `SurfaceFeature.role: 'ground' | 'overlay' | 'road'` —— **审计靠 role，不靠名字前缀**。

---

## 5. 诊断体系（`src/diagnostics/`，只读）

```
sampling.ts         SurfaceSampler：唯一一份"某点归谁"（covers 含 holes / 顶层选择 / withinCity）
b-labels.ts         B 类原因标签（in-corner-wedge / adjacent-edge-no-road / ...）
geometry-audit.ts   auditCoverage(model, net) 采样审计；auditOverlap(model, net) 精确求交
```

**当前审计数字**（`npx tsx tmp/audit.ts` / `tmp/precise-overlap.ts`）：

```
A 道路 28.5% | A 建筑 13.0% | A 已规划 50.0% | A 合计 91.5%
B 仅底板 8.5% | C 真缺口 0.00% | O 精确重叠 0 处 0 m²
B 归因：adjacent-edge-has-road 85% · legacy-plate 10% · in-corner-wedge 7.2%
```

**两条铁律**（踩过）：
1. **Candidate 的 `id` 是方案名不是场地名**（`ret-strip-rear-park` 全城重复十几次）。
   分组必须走 `buildPlannerBundle().byParcel`，按名字配对会得出 10 万 m² 的假重叠。
2. 点位判定必须**减 holes**，否则环状绿化带把整片内部算成自己（重叠虚报 37%）。

---

## 6. 当前在做的：R1 内部交通（`planning/circulation/solver.ts`）

### 已跑通
- `Portal{id,kind,at,dir,clearM,snap}`：入口是**语义节点 + 接入方向**，不产几何。
- 栅格 1.5 m，8 邻域，斜走不切角；**导航域 = parcel（不是 buildableArea）**。
- 障碍来源位掩码 `BLOCK_BUILDING / OUTSIDE_PARCEL / HARD` + `blockSourceName()`。
- 距离场一次算、三种交通复用；包围盒前置剪枝。
- **多源 Dijkstra**：从网络同分量格子同时出发，返回"目标 → 最近网络节点"。
- 三种交通各自一张网（步行 / 车行 / 服务），种子 = 街区出口。

### Golden 现状（分母 = 全部必要 OD）

| 街区 | OD | 连通 | 总长 | 共享率 | 耗时 |
|---|---|---|---|---|---|
| MF `-469:284` | 3 | **2/3 ✗** | 222.6 m | 0% | 92.6 ms |
| retail `176:176` | 3 | **2/3 ✗** | 58.1 m | 0% | 28.7 ms |
| industrial `252:-578` | 2 | 2/2 ✓ | 22.4 m | 0% | 10 ms |

### 三个已知卡点

1. **共享率 0%**：网络里只有"街口"三个种子，每个入口都就近接街，天然不重叠。
   → 必须引入**主干**：先按需求铺一条主通道，其余入口多源接入主干。
2. **`svc` 连不上**：service 净空 2.2 m，后勤口所在窄缝被夹断
   （"目标分量 0，网络规模 3，扩展到 1 格"）。这是**几何**问题，不是搜索问题。
3. **`initNetwork` 未实现**：没有把"已有合法内部道路"并入初始网络，复用长度恒为 0。

### 停车场
R1 只连到停车区边界的 Portal，**"Portal → 车位排"是否可达未验证**，不能标 PASS。

---

## 7. Phase M（城市形态场）：完全没开始，先读这个

Phase 0 审计已定位 **7 处硬编码**（报告 `PHASE_0_AUDIT.md`）：

| # | 现象 | 位置 |
|---|---|---|
| 1 | 住宅高度只有 21/18/15 三个值，永远"临街高后侧矮" | `multifamily/courtyard.ts:325` |
| 2 | 塔楼高度只看地块面积，与区位无关 | `retail/strip.ts:201` |
| 3 | 工业厂房固定 9 m | `industrial/rear-load.ts:257` |
| 4 | 补量高度按 typology 固定 | `generators.ts::INFILL_H` |
| 5 | 用地只看"到原点半径分位数" | `landuse.ts:62-90` |
| 6 | 外围 18% 工业否则绿地 | `landuse.ts:72` |
| 7 | 大地块只调一次单组团生成器 | `generators.ts` |

**基线数据（改前必须记）**：

```
高度分布：0~12m 47.9% | 12~24m 50.4% | 24~36m 0% | 36~60m 1.8% | 60m+ 0%
FAR：内环 0.55 | 中环 0.48 | 外环 0.90   ← 梯度是反的
体块 280 个 / 有建筑的 block 39 个
```

---

## 8. 测试（25 个脚本，全绿；`gen` 有 1 条历史失败）

```bash
npx tsx test/planning-frontend.test.ts   # 175 条，最重要
npx tsx test/planning-green.test.ts      # 174 条，green/park/civic + D0 回归
npx tsx test/diagnostics.test.ts         # 16 条，13 s，审计回归
npx tsx test/planning-{mf,retail,industrial,hotel,dc,sf,realize,freeze}.test.ts
npx tsx test/{layers,snapshot,cover,surface,glb}.test.ts
```

`test/gen.test.ts` 有一条**历史失败**：`radial-10 城内路网连通 187/196`。
**不是你引入的**，别去"修"它。

---

## 9. 性能基线（同机、同场景）

```
模型生成        3045~3835 ms
路网             15~28 ms
全城规划(Planner) 1213~1418 ms   ← Phase D 收口时的数字，作为基线
Scene(planner)  1590~1837 ms
R1 求解（单块）  MF 92.6 / retail 28.7 / industrial 10 ms
```

性能结论必须**同机交替多跑几次**：单次差异可达 ±20%（有一次 +43% 全是噪声）。

---

## 10. 踩过的坑（按主题，省你几天）

### 几何 / 布尔
- `surfaceInset` 对**带洞的面返回 0 片**；对凹多边形会外翻。用之前先判断。
- `surfaceSubtract` 失败时**原样返回被减数**（返回整个面）。必须防护：
  返回块面积 ≥ 95% 原面就整体放弃。否则会出现"认领退线带 = 认领整块地"。
- `chamferCorners` 在**凹角**会撑大面积（切点算到另一侧）。倒角后要比面积。
- 多边形共边时，落在边上的采样点会被**两边同时判内** —— 采样审计必须留 2 cm 容差。

### Planning
- `topUpBuildings` 按覆盖率补量，`INFILL_H` 决定补多高 —— 这是"固定三栋"之外的第二个来源。
- 诊断分**不是跨版本可比的**：改了 diagnostics 的公式，分数变化不代表方案变好/变差。
  要比就"用同一版 Evaluator 重评两个 Candidate"。
- `lawn` 铺整块再让广场叠上去，诊断会读到"绿地 114%" → 区间打爆归零。
  **在 archetype 里用 `minusAll` 先挖**。
- 面积预算里 `bReason` 之类数组存的**已经是 m²**，别再乘 49。

### 编辑器 / 渲染
- 调试渲染器要用 `scene/palette` 的 `MAT`，**不要自己手写颜色表**（我手写过一版，全偏亮，
  据此判断"停车场糊成一片"全是错的）。
- `buildScene` 里 `legacy` 与 `planner` 是**二选一**，不会重复生成；但 2D/3D 各跑一遍。

---

## 11. 下一步建议（按优先级）

1. **R1.2-C**：引入主干 —— 先连"需求最多的入口对"铺主通道，其余入口多源接入主干；
   同时把 `initNetwork`（并入已有道路）做掉，共享率才可能 >0。
2. **`svc` 连通**：service 2.2 m 净空 + 后勤口窄缝 = 几何阻塞。要么调 archetype 的后勤口位置，
   要么明确报告"该街区的后勤口不可车行"。
3. **停车场内部验证**：拿到 `solveParking` 的 aisle 数据，验证 Portal → 车位排可达。
4. **M1**：形态场 + 让 CBD/MF 读目标高度，替换 §7 那 7 处硬编码。

---

## 12. 文档索引（都在仓库根）

```
PHASE_0_AUDIT.md          Phase 0 代码审计 + 基线数据（7 处硬编码）
PHASE_D_FINAL_REPORT.md   D 阶段收口（PASS_WITH_ISSUES）
PHASE_G0_REPORT.md        统一采样底座（PASS）
PHASE_G_TRACE_REPORT.md   道路/地块边界溯源（结论已被下一份部分撤回）
PHASE_G1R0_REPORT.md      两个假设被否 + 测量有污染
PHASE_R1_REPORT.md        R1 原型
PHASE_R1_1_REPORT.md      Portal 抽象
PHASE_R1_1A_REPORT.md     导航域改 parcel
PHASE_R1_1A2_REPORT.md    MF 停车真实阻塞
PHASE_R1_1B_REPORT.md     MF 门洞修复 + OD 去重（三 Golden 全连通）
PHASE_R1_2_REPORT.md      共享折扣 + 三联图（未通过）
PHASE_R1_2B_REPORT.md     多源 Dijkstra（性能达成，共享 0%）
```

**读文档有个坑**：`PHASE_G_TRACE_REPORT.md` 里"短边过度内缩 78%"的结论已被
`PHASE_G1R0_REPORT.md` 撤回（相关系数 r=−0.17）。以**新的为准**。
