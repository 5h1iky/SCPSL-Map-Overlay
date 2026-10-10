# NOTICE · 第三方组件与出处

本程序包含以下第三方代码 / 数据，均以"原样"方式 vendored 进本仓库，未做修改。

---

## 1. `@scpsl-tools/map-seed`（离线地图生成器）

| 项 | 值 |
|---|---|
| 来源 | https://github.com/kldhsh123/scpsl-map-seed |
| 获取方式 | `git clone --depth 1`（commit `eacf183acbb907967075ba90b37be439ba093fc1`，分支 `main`） |
| 获取日期 | 2026-10-05 |
| 版本 | package.json `version: 1.0.0` |
| 位置 | `data/vendor/map-seed/`（含原始 `README.md` 与 `LICENSE`） |
| 包含内容 | `src/`（生成器与 DotNetRandom 复刻）、`data/mapgen-compiled-14.2.7.json`、`data/mapgen-raw-14.2.7.json`、`data/manifest.json` |
| 用途 | 由种子离线推算设施布局（房间、连接器、分区） |

### ⚠️ 许可证不一致（需要澄清后才能公开发布）

| 位置 | 声明 |
|---|---|
| `package.json` | `"license": "MIT"` |
| `README.md` | `Licensed under the Apache-2.0 License` |
| `README.md` 结尾 | `Copyright (c) kldhsh123. All rights reserved.` |
| GitHub API 识别的许可证 | Apache-2.0 |

三处不一致。**自用或内部使用不受影响**；若要公开发布、再分发或商用，
请先与原作者澄清，并保留本目录下的原始 `LICENSE` 与 `README.md`。

---

## 2. 模板数据的上游来源

`data/vendor/map-seed/data/mapgen-raw-14.2.7.json` 由
[`SCPSL_Template_export`](https://github.com/kldhsh123/SCPSL_Template_export)
（LabAPI 服务器插件，发布版 v1.0.0）在真实服务器上导出，再经该仓库的
`scripts/compile-template.mjs` 编译为运行时模板。本程序不包含该插件本身。

---

## 3. 房间图标（`assets/room-icons/`、`data/room-icons.json`）

本目录下有**两族**图标，都是同样的授权与来源，画布都等于 1 格（15 世界单位）：

| 族 | 张数 | 画布 | 用途 | 来源 |
|---|---|---|---|---|
| 形状族（`4RW`、`CDx`、`Cxx`、`ERx`、`SRxx`、`TRx`） | 19 | 1024×1024 | 通用走廊形状（按"开口方向"选图，与朝向无关） | SCP:SL 官方 wiki · https://hub.scpslgame.com/ （`Special:ListFiles&aiprefix=Room`） |
| 房间族（`LCZ_*`、`HCZ_*`、`EZ_*`） | 46 | 256×256 | 每个具体房间的身份贴图（含无名走廊的分区形状图，如 `LCZ_Straight`/`HCZ_Curve`/`EZ_Crossing`） | 官方 wiki 同批图形；文件名与逐房间对应关系取自社区地图工具的 `assets/room-icons/` |

| 项 | 值 |
|---|---|
| 名称 | SCP: Secret Laboratory 房间图标（游戏内 SCP-079 / SCP-106 地图所用的图形） |
| 作者 | **Northwood Studios** |
| 获取日期 | 2026-10-06 |
| 许可 | **CC BY-SA 3.0**（站点授权 `rightsinfo: CC BY-SA 3.0`，见 https://hub.scpslgame.com/index.php?title=Wiki:Licensing） |
| 位置 | 程序使用 `assets/room-icons/*.png` + `data/room-icons.json`（清单、逐房间映射、分类配色） |

### 本程序对该素材所做的修改（CC BY-SA 3.0 要求声明）

1. **裁切/缩放**：原图图形带原始偏移；本程序保持画布比例不变，绘制时整体缩放到一个格子。
2. **转为纯白蒙版**：去除原图的黑白配色，输出为不透明白色蒙版。
3. **运行时重新着色**：渲染时按房间分类（scp / core / security / …）用
   `globalCompositeOperation = 'source-in'` 着色。
4. **缩放**：绘制时按格子尺寸（15 世界单位）缩放，并做 2× 超采样以抗锯齿。
5. **旋转**：按房间的 `rotY`（核心区再加 180°）旋转贴图，使其开口与真实门口对齐。
6. 几何形状与命名**未做任何改动**。

### ShareAlike 说明

CC BY-SA 3.0 具有**传染性（ShareAlike）**。本程序的处理方式是把**图标文件及其衍生**
（`assets/room-icons/*.png`、`data/room-icons.json`）单独按 **CC BY-SA 3.0** 提供，
程序其余部分维持原授权，并在本节写明修改内容与出处。

> ⚠️ 若计划公开发布：请在 README 显著位置保留以下署名与许可链接：
>
> Room icons © Northwood Studios, licensed under CC BY-SA 3.0.
> Changes: masked to solid white and recolored per zone at runtime.
> https://hub.scpslgame.com/index.php?title=Wiki:Licensing

---

## 4. Electron 及运行时依赖

| 组件 | 版本 | 许可 |
|---|---|---|
| Electron | 38.8.6 | MIT |
| electron-builder（仅构建期） | 26.x | MIT |

---

## 5. 本程序自身

`src/`、`data/poi-map-14.2.7.json`、`tools/`、`test/` 为本项目代码。
POI 语义表是根据 14.2.7 模板里 42 个 `room.name` 枚举后人工标注的。

除第 3 节列出的房间图标（CC BY-SA 3.0）外，
本程序**不包含任何其它游戏资源文件**（不含贴图、模型、音频、文本资源）。

---

## 6. 商标

SCP: Secret Laboratory 及其相关名称、标识归 Northwood Studios 所有。
本程序不是官方工具，与 Northwood Studios 无任何关联，不使用其 logo。
