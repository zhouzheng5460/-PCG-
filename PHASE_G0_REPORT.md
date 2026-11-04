# PHASE G0 · 统一采样与归属判定 —— **PASS**

> 场景：`seed 682063530` / `nPatches 15` / 城内 44 块 / 61.38 ha / 步长 0.5 单位（3.5 m）/ 85,446 点。
> 本轮**没有修改任何生成逻辑**（道路、地块、建筑、停车、铺装、绿地），只做诊断底座。

---

## 1. 提取的函数与调用关系

```
src/diagnostics/sampling.ts        ← 新增：唯一一份"某点归谁"的实现
  SurfaceSampler
    ├─ covers(surface, x, y)        外环 && 不在任何洞内
    ├─ sample(x, y): SampleFact     事实：inCity / block / inBuilding / hits / top / ground
    │                               / cover / plateOnly / onRoad
    ├─ walk()                       遍历采样网格
    └─ cellM2

src/diagnostics/b-labels.ts        ← 新增：只解释"为什么是 B"，不改几何
  junctionHulls(net)               用 arm 的 origin/dir/pad/curb+sw+vg 算**凸包**（不是半径）
  patchEdges(model, net)           patch 每条边 + 它在 Road Graph 里有没有对应边
  labelBPoint(fact, hulls, edges)  互斥标签 + 全部证据

src/diagnostics/geometry-audit.ts  ← 改：内部改为调用 SurfaceSampler
  auditCoverage(model, net)
    ├─ sampler.sample()  取事实
    ├─ 聚合 A/B/C/O（规则一行没改）
    └─ B 点上再跑 labelBPoint()，输出 gLabels
```

**没有第二份 `pointInRing`**，也没有第二份顶层选择。`src/diagnostics/` 仍然不被任何生成路径 import。

---

## 2. 提取前后逐点对比（等价性）

| 项 | 提取前 | 提取后 | |
|---|---|---|---|
| 采样点 | 85,446 | 85,446 | ✓ |
| A 道路 | 28.4648% | 28.4648% | ✓ |
| A 建筑 | 12.9910% | 12.9910% | ✓ |
| A 已规划面 | 50.0140% | 50.0140% | ✓ |
| **B 仅底板** | **8.5303%** | **8.5303%** | ✓ |
| C 真缺口 | 0.0000% | 0.0000% | ✓ |
| `bReason` 七个桶 | 46305 / 625 / 172 / 0 / 0 / 5255 / 0（m²） | 完全相同 | ✓ |
| 每块面积 | — | 逐块差 < 1e-6 | ✓ |

**逐点分类完全一致**（不是"比例接近"，是每个桶的 m² 数相同）。
运行时间 13.49 s → 13.35 s（同时建场景，取样器复用审计的 scene，没有多跑一遍）。

---

## 3. B 类原因分布（互斥标签，几何依据）

| 标签 | 面积 | 占 B | 涉及块 | 典型位置 / 证据 |
|---|---|---|---|---|
| `adjacent-edge-has-road` | 4.469 ha | **85.4%** | 39 | (-66.8,-10.7) block -61:-2 — 最近 patch 边有路，距该边 10.2 m |
| `adjacent-edge-no-road` | 0.388 ha | 7.4% | 10 | (-68.3,-11.2) block -61:-2 — 最近 patch 边**没有** Road Graph 边（城市边界侧），距 2.6 m |
| `in-corner-wedge` | 0.379 ha | 7.2% | 37 | (-59.3,8.8) — 在路口 (-59.9,11.3) 的**臂凸包**内且无任何路面覆盖 |
| `outside-city` | 0 | 0% | 0 | B 类按构造不含城外点 |
| `unknown` | 0 | 0% | 0 | — |
| **合计** | **5.236 ha** | 100% | — | 与 B 类总量一致（误差 < 1%） |

优先级：`outside-city > in-corner-wedge > adjacent-edge-no-road > adjacent-edge-has-road > unknown`。
命中多个时 `labelBPoint` 返回 `all[]` 保留全部证据。

---

## 4. 对 G1/G2/G3 优先级的**重新判断**（与上一轮相反）

上一轮我按"距路口 12 m / 距路面 14 m"分类，得出 `junction-wedge` 只有 1.2%，据此建议先做 G1。
**新口径把结论推翻了**：

- **`in-corner-wedge` 只有 7.2%**（0.379 ha），不是大头。上一轮那 88% 的 `road-side` 里，
  真正属于路口楔形的只有这一块。
- **85.4% 是 `adjacent-edge-has-road`**：最近的 patch 边**明明有路**，
  但点仍然没被任何功能面认领，且在 10 m 量级。这说明**问题不在路口，也不在无边一侧**，
  而在"沿路那一整条带子根本没被铺满"。
- `adjacent-edge-no-road` 7.4% —— G1 的目标，收益上限就这一档。

**修正后的优先级**：

| 顺序 | 目标 | 占比 | 改动位置 |
|---|---|---|---|
| **G2'** | 沿路侧带没铺满（新发现，原 G3 升为第一） | 85.4% | 道路条带 / 地块边界的**同一来源**（不是全局扩边） |
| G1 | 无路边一侧 | 7.4% | 纯语义 + `reserved` 面，不碰几何 |
| G2 | 路口楔形填角 | 7.2% | 路口多边形补角 |

也就是说：**用户原本排的 G2（路口楔形）收益最小**，真正的大头是"沿路侧带"。
这个结论只有在有统一口径之后才成立（旧口径把它算成了 88% 的 `road-side` 且无法区分）。

---

## 5. 典型异常区域（可复现）

`block -61:-2`（legacy，10 个 B 点里有 3 个标签都出现了）：

```
(-66.8,-10.7)  has-road，距最近 patch 边 10.2 m  ← 沿路一条 10 m 宽的带子没被认领
(-68.3,-11.2)  no-road，距边 2.6 m              ← 城市边界侧
(-59.3, 8.8)   corner-wedge，在路口 (-59.9,11.3) 的臂凸包内
```

这一块同时命中三类，说明**单块也不能只修一种**。

---

## 6. 性能与回归

| | 提取前 | 提取后 |
|---|---|---|
| 采样审计 | 13.49 s | 13.35 s |
| 内存 | 未测（无 Node heap 采样） | 未测 —— **这条我没做** |
| 精确重叠 | 0 处 / 0 m² | 0 处 / 0 m² |

`diagnostics` 13 → **16 条**（新增：标签穷尽覆盖 B 类、每条有证据、unknown ≤10%）。
`planning-frontend 175 / realize 44 / green 174 / snapshot 43 / layers 10` 全绿。

---

## 7. 遗留问题

1. **内存没测**（用户要求"运行时与内存变化"，我只报了时间）。要么补 `process.memoryUsage()` 采样，
   要么明确接受"未测"。
2. `adjacent-edge-has-road` 占 85% 是**新结论**，但还没有最小复现多边形。
   下一步应该取 `(-66.8,-10.7)` 附近，把"路面边界 / 地块边界 / 底板"三条边叠在一张图上看，
   确定那 10 m 是"路面没铺到"还是"地块多让了"。
3. `outside-city` 恒为 0 是因为 `sample()` 对城外点直接返回 `inCity=false` 且审计跳过 ——
   这个标签目前只是**防御性**的，没有实际样本。
