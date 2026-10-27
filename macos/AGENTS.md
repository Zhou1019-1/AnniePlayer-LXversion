# 安妮播放器 · macOS 版协作规范（macos/AGENTS.md）

> 本文档面向 numb 及其 AI 编码助手。**读完本文件再动手**。进本目录工作的 agent 默认已读仓库根的 `AGENTS.md`（Windows 主线规范），本文件只管 macOS 线的差异与专属规则；两者冲突时，以本文件为准。
>
> 项目：章鱼科技 · 安妮播放器 macOS 版（开发者：numb）。仓库：Zhou1019-1/AnniePlayer-LXversion。

## 一、你在仓库里的位置与边界（硬规则）

- **你的全部工作都在 `macos/` 目录内**。未经允许不得修改：`annie/`、`engine/`、`src/`、`scripts/`、`docs/`、根目录文档（`AGENTS.md`、`CODEBASE-NOTES.md`、`更新日志.md`、`README.md`、说明书 docx 等）。
- **绝对禁止改动 `.github/workflows/release.yml`**——那是 Windows 主线的发版命根子。macOS 线只有自己的 `release-mac.yml`。
- 与主线共享的通用约定（提交风格、验证习惯等）继承根 `AGENTS.md`，下面第三节有摘要。

## 二、发版流程（macOS 线，tag 触发云端构建）

### 触发方式

```bash
git tag mac-vX.Y.Z        # 注意前缀 mac-，与 Windows 主线的 vX.Y.Z 完全隔离
git push origin mac-vX.Y.Z
```

推送 `mac-v*` 标签 → 触发 `.github/workflows/release-mac.yml` → macos-latest runner 云端构建 → 自动发布 GitHub Release（标题「安妮播放器 macOS 版 VX.Y.Z」）。

### 版本号与 tag 规则

- 版本号语义跟随主版本（主版本 4.6.0 时代，mac 版第一版建议从 `mac-v1.0.0` 起步，由维护者与 numb 商定后锁定；锁定后只递增不回头）。
- mac 线可以有自己的迭代节奏，**不要求与 Windows 版同步发**。
- tag 只打 `mac-vX.Y.Z` 这一种形态，别用 `vX.Y.Z-mac`、`macV…` 等其他写法（workflow 的触发 glob 是 `mac-v*`）。

### ⚠️ 血泪教训（Windows 线刚踩过）：Release 的 latest 指针

GitHub 的 `releases/latest` 永远指向**最新创建的正式 Release**。Windows 版的应用内自动更新（electron-updater）靠它找 `latest.yml`——**任何新发的正式 Release 都会抢走这个指针**（本仓库的 wrapper-lite 资产 Release 就曾抢走它，导致全体 Windows 用户更新检查报「Cannot find latest.yml」）。

因此 macOS 线的 Release 必须遵守：

1. **在「mac 版自动更新通道」方案落地之前，mac 的 Release 一律标记为 prerelease**（`release-mac.yml` 里已内置 `prerelease: true`，不要改掉）。prerelease 不影响用户从 Releases 页手动下载，但不会抢 latest 指针。
2. mac 版应用内的自动更新功能**一期先关闭或改为手动检查**，不要让 mac 版去查本仓库的 `releases/latest`（那里是 Windows 的产物）。
3. 后续要开自动更新，先与维护者商定通道隔离方案（如独立发布仓库 / 自建更新源），再动 prerelease 标记。

### 发布材料（每次发版前写）

- `macos/更新日志-mac.md`：仿根目录《更新日志.md》格式，`## VX.Y.Z（日期）` 段落置顶；workflow 会自动提取该段作为 Release notes。
- mac 版应用内的「本版新变化」数据源（如有）自行维护在 `macos/` 内，别往主线 `package.json` 的 changelog 里写。

## 三、继承自主线的硬性工作习惯（根 AGENTS.md 摘要）

1. **编辑落盘验证**：关键文件（版本号/更新日志/workflow/构建配置）编辑后必须用独立手段验证（`git status` 看到该文件、或读回关键串）。AI 编辑工具可能「假成功」（主线 V4.4.5 事故），同一文件编辑失败两次后改用脚本写盘。
2. **改完代码必跑语法检查**（Electron/JS 项目的话）：`node scripts/check-syntax.js`（该脚本扫全仓，macos/ 下的 JS 也会被扫到，保持 0 失败）。若 mac 版不是 JS 技术栈，在你的工程里建立等效检查并在本节登记。
3. **提交风格**：标题仿主线 `V4.6.0 功能点1 + 功能点2`（mac 线用 `mac-vX.Y.Z 功能点`）；只 `git add` 自己本次相关的文件，**禁止 `git add -A`/`git add .`**；杂物（临时脚本、测试产出、截图）不进仓库。
4. **大二进制不进 git**：安装包、签名证书、p12/provision、任何 >50MB 的二进制一律不进仓库——分发走 GitHub Release 资产，参考主线 `scripts/setup-wrapper.js` 的「下载 + SHA256 强校验 + 失败即红」模式。
5. ** secrets 绝不入库**：Apple 开发者证书/密码/notarization 凭据走 GitHub Secrets（联系维护者配置），代码里出现密钥字符串一律打回。

## 四、macOS 构建的专属注意

- **签名与公证**：一期无 Apple 开发者证书时，electron-builder 产物为未签名 dmg——用户首次打开需「右键 → 打开」。请在 Release notes 与应用内引导里写明，别让普通用户对着 Gatekeeper 报错发懵。二期配证书后走 secrets：`CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。
- **架构**：默认打 universal 或 arm64+x64 双包（看设备面决定，写进更新日志）。
- **引擎**：主线的 AnnieEngine 是 C# Windows 专用（WASAPI/ASIO）。mac 版的音频后端方案（移植/自研/AVFoundation）由 numb 侧自定，但**必须在 `macos/README-ENGINE.md`（自建）里写清架构与构建方法**，让别人能复现构建。
- **构建可复现**：`release-mac.yml` 里的每一步必须能在 numb 本机等价执行（本地脚本与 CI 同一命令，仿主线 `predist:setup` 的做法），不允许「只能在我电脑上打出包」。

## 五、协作流程

- **默认走 PR**：从 `main` 切 `mac-*` 分支开发，提 PR 回 `main`，维护者评审后合并（参照社区协作者秋野奈的 PR 模式：功能集清晰、说明写全、可逐条验证）。
- PR 描述里写清：本版功能点、自测过哪些路径、是否动了共享文件（默认不该动）。
- 发现主线 bug 或需要主线配合的改动：在 PR/群里提出，由维护者改主线，**不要顺手代改**。

## 六、知识库义务

- 仓库根 `CODEBASE-NOTES.md` 是主线的代码事实库。mac 线的事实**不要写进去**，在 `macos/CODEBASE-NOTES-MAC.md`（自建）按同样规矩沉淀：每条带来源 `文件:行号` + ✅已验证/🔍待验证 标记，阅览/修改代码时顺手更新。
- 踩坑教训（尤其是「文档里没写、不踩不知道」的那种）必须当日写回，下一位 agent 全靠它避雷。

## 七、开工清单（numb 的 agent 第一步做什么）

1. 把现有 macOS 工程整体放入 `macos/`（保持其原有目录结构，不要拆散混进主线目录）。
2. 在 `macos/README.md` 写：项目简介、技术栈、本地开发环境要求、构建命令。
3. 检查 `.github/workflows/release-mac.yml` 的构建步骤与你工程的实际结构是否吻合，不适配就改它（只许改这一个 workflow 文件），并用 `mac-v0.0.0-test` 之类的测试 tag 真打一次验证链路（验证完把测试 Release 删掉或保持 prerelease）。
4. 建 `macos/更新日志-mac.md` 写第一段。
5. 全部就绪后告知维护者，在主线 README 的下载区加 macOS 入口。
