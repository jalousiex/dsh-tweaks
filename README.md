# dsh-tweaks（增强补丁）

> **增强补丁** —— 一组可单独开关的增强：隐藏内置供应商。开关在 **DSH 设置窗口的「增强补丁」分区**里改，
> 切换即时生效、界面不跳转，每条都带依据说明。

一组**可单独开关**的增强补丁，为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 服务。

## 架构：入口 / 开关 / 补丁三分

| 层 | 位置 | 职责 |
| --- | --- | --- |
| **入口**（插件 ↔ dsh 的交互） | `cordis.patch.yml` 的 `- id: dsh-tweaks` + `index.js` 的 `apply()` | 只负责把插件加载进 dsh、注册路由、兑现 tweak。**不含任何具体开关的接线** |
| **开关**（具体配置） | 设置窗口一级分区「增强补丁」（`settings.section`）+ 状态文件 `.cache/dsh-tweaks/state.json` | 卡片可交互；切换写状态文件并**就地重跑**，不碰 Config/patch |
| **补丁**（打向谁） | `TWEAKS` 注册表里的 `subject` / `owner` | 打 **dsh 自身**的 Loader 条目（把目标条目的 `disabled` 置真） |

### 两个设置入口的分工（重要）

| 入口 | slot | 内容 | 为什么 |
| --- | --- | --- | --- |
| 设置窗口 › **增强补丁**（一级分区） | `settings.section` | **具体补丁开关**（可交互 checkbox，按归属分组） | 这里是权威入口 |
| 设置 › 插件 › **dsh-tweaks**（详情） | `plugins.bundle.config` | **只读说明**（指路 + 启用计数） | 不放开关 |

> **为什么开关既不在插件详情页、也不在 Config 里**：
> 开关一改就要写配置 → 插件条目热重载 → 客户端 slot 销毁重建 →
> 界面跳回/闪断（用户明确反馈的痛点）。
> 现在开关存在插件自己的状态文件里，切换只做「写文件 + 进程内 reconcile」，
> 完全不碰条目生命周期；`settings.section` 分区因此始终稳定。
> （对照：插件市场 dshmarket 也把自己的面板注册成 `settings.section` 一级分区。）

## 为什么单独做一个插件

需求是"隐藏内置供应商那一组"这类**小**改动。
如果每个都手改 `cordis.patch.yml`，会带来三个问题：

1. **无法开关**：想临时恢复默认，得记住原来那段长什么样。
2. **无法跨机**：改在哪一层、改了几处，换台机器就丢。
3. **无法追溯**：半年后看到一条 `disabled: true`，不知道是谁为什么加的。

所以这里把每个改动登记成一条带 `why` 的记录（`TWEAKS` 是唯一登记处），
开关统一存状态文件、由设置窗口的分区直接编辑。
加新开关 = `index.js` 里加一条（状态文件与卡片自动跟着生成）。

## 设计约束（对齐 dsh 架构）

| 约束 | 做法 |
| --- | --- |
| 配置是数据不是代码 | 每个 tweak 只有 `enabled` 加少量参数；`index.js` 的 `TWEAKS` 是唯一登记处 |
| 入口与开关解耦 | `cordis.patch.yml` 只加载插件；开关存 `.cache/dsh-tweaks/state.json`，设置窗口分区里改 |
| 切换不打扰界面 | 写状态文件 + 进程内 reconcile，**不触发条目热重载**（Config/patch 层全程不动） |
| 参数不写死在代码里 | 凡是可能因部署而异的值（对账上限、刷新间隔）都是 `Config` 字段 + 默认值，见 `Config` schema |
| 只走官方扩展点 | ① profile 条目列表（就是 `cordis.patch.yml` 的用途）② 自己前缀下的 loopback 路由 ③ 官方 `settings` 服务。**不碰其它包的内部** |
| 事件驱动优于轮询 | 条目类改动在启动与 `app-boot/config-reload` / `plugin-manager/changed` 时对账，**不做定时轮询**；确需兜底可用 `fallbackReconcileMs` |
| 幂等且可逆 | `ctx.effect` 注册副作用，卸载时自动回滚；重复应用不会叠加 |
| 绝不阻塞启动 | 单个 tweak 失败只记录到 `/dsh-tweaks/status`，应用照常启动 |
| 如实汇报 | 状态路由同时给出 `enabled`（想开吗）与 `applied`（真的生效了吗），避免"开了但没反应"无从排查 |

## 现有开关

| id | 默认 | 作用 | 生效对象 |
| --- | --- | --- | --- |
| `hideBuiltinDeepseek` | 关 | 隐藏内置供应商（模型列表只留「DeepSeek 账号」） | Loader 条目 `llm-deepseek` |

> 历史开关（已迁出 / 移除）：
> - 重启入口已迁到独立插件 `dsh-restart`（`/restart` 命令 + `restart_harness` 工具 + 同源端点）。原先的 `restartButton` / `POST /dsh-tweaks/restart` 与 `allowRestart` 配置已移除。
> - `hideUnroutableModels`（过滤不可路由模型）、`fixTapWebPin`（修复 dsh-tap 假告警）、`sidebarBalance`（侧边栏 DSH 余额）已剥离——它们不属于 dsh 自身的补丁，不适合留在本插件。

## 开关卡片上有什么

每条开关在插件页是一张卡片。**只留核心信息**，其余全部收进悬浮提示：

| 卡片上 | 悬浮提示里 |
| --- | --- |
| 勾选框（启用状态） | 当前启用状态 |
| 短标题 | — |
| 一句白话描述（`what`） | 完整作用 |
| 生效对象 chip | 生效对象全名 |
| 对象状态 chip（就绪 / 已禁用 / 对象缺失…） | 对象状态详情 |
| 出错或本次动作结果（仅在有内容时出现） | 生效方式（`effect`）、生效条件（`appliesWhen`）、依据（`why`） |

`subjectStatus` 取值（只看此刻的事实，不猜）：

| status | 含义 |
| --- | --- |
| `idle` | 开关没开 |
| `disabled` | 条目在位且已被本开关禁用（条目类改动的稳态） |
| `pending` | 条目在位，但尚未禁用（刚启动/还没对账） |
| `missing` | 条目不在 Loader 树里 |
| `mismatch` | 条目在，但状态异常 |

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-tweaks/status` | 每个 tweak 的 `enabled` / `applied` / `present` / `effective` / `subject*` / `note` / `error`，外加一段 `config`（下发给浏览器半的 `statusRefreshMs`） |
| `POST` | `/dsh-tweaks/toggle` | **就地切换**：写 `~/.dsh/.cache/dsh-tweaks/state.json`，然后进程内 `reconcileAll()` 重跑 apply/restore。**不写 Config、不写 profile patch**，所以**不触发条目热重载** |

状态路由由 `config.statusRoute` 把关（默认开，只读且在 loopback 上）。

## 开关存哪（为什么不在 Config 里）

开关值存在插件**自己的状态文件**：

```
~/.dsh/.cache/dsh-tweaks/state.json     # { "<tweakId>": boolean, ... }
```

切换流程：`POST /toggle` → 原子写该文件 → 更新内存活值 → `reconcileAll()`（撤销旧副作用、按新值重建）。

**为什么不能放 Config**（这是"点一下开关整个界面就消失"的根因）：

> profile 是 `patchReload: live`。任何 `settings.update` 写入都会让**本插件条目热重载**；
> 条目一重载，客户端注册的 slot（设置窗口的「增强补丁」分区）就随之销毁重建 ——
> 界面表现为"点一下开关，右边内容整个消失/闪一下"。
>
> 把开关移出 Config、写自己的状态文件后，切换过程完全不碰条目生命周期，
> 分区和滚动位置都稳定。

| 层 | 内容 |
| --- | --- |
| ① 包内 `cordis.patch.yml` | **只加载插件** + 基础设施参数（对账/刷新间隔）默认值，**不含开关** |
| 状态文件 `.cache/dsh-tweaks/state.json` | **开关的实际落点**（本机，不进同步盘） |
| ② `profiles/desktop/cordis.patch.yml` | 只留 `statusRoute` 等基础设施，**不写开关** |
| ③ `~/.dsh/cordis.patch.yml` | **不写 dsh-tweaks 的开关**（开关已与配置层无关） |

- 设置窗口「增强补丁」分区（`settings.section`）是**可交互开关**：勾选框 + 状态 chip + 悬浮依据；
  插件详情页（`plugins.bundle.config` slot）只放**只读说明**（指路 + 启用计数）。
- 切换是**乐观更新**：勾选框立刻响应，请求失败则回滚并显示错误。
- 改 `index.js` 的 `Config` 结构后**必须重启 DSH**（Node 缓存模块，hmr 不重 import 已加载插件）。
- 跨机同步：开关值在 `.cache`（不同步）。要跨机迁移就把 `state.json` 复制过去。

## 配置

```yaml
- insert:
    - id: dsh-tweaks
      name: 'dsh-tweaks'
      config:
        statusRoute: true          # 只读状态路由
        reassertLimit: 10          # 对账被反复弹回的重试上限
        fallbackReconcileMs: 0     # >0 才额外开兜底定时对账（默认纯事件驱动）
        statusRefreshMs: 600000    # 浏览器半状态兜底刷新间隔
```

## 改动形态

当前所有改动都是 **Loader 条目类**：效果是把目标条目的 `disabled` 置真，声明方式是 `target: '<entry id>'`。

Loader 启动与配置热应用时（`app-boot/config-reload` / `plugin-manager/changed`）会 reconcile 重建条目，
所以不是"置真一次就完"：插件在这些时机**事件驱动地对账**，最多 `reassertLimit`（默认 10）次
（`reasserts` 如实上报；超限后仍翻回来就报 `target flips back after disable`）。默认**不做定时轮询**；
确需兜底可把 `fallbackReconcileMs` 设为 >0。

## 加一个开关

```js
// index.js —— Loader 条目类
{
  id: 'myTweak',
  title: '一句话说明它改什么',
  why: '为什么要改、依据是什么、范围边界在哪里 —— 写给半年后的自己看',
  target: 'ui-some-entry',   // 把这个条目的 disabled 置真
}
```

开关字段**不用手写**：设置窗口分区由 `TWEAKS` 注册表自动生成。
加一个 tweak 只有一步：在 `index.js` 的 `TWEAKS` 里加一条。

**每条开关都必须说清「生效对象」**：

```js
{
  id: 'myTweak',
  title: '一句话标题',
  what: '它改什么（一句话，会直接显示在卡片上）',
  why: '为什么要改、依据是什么、范围边界 —— 写给半年后的自己看',
  subject: { kind: 'entry', name: '<对象标识>', label: '<给人看的名字>' },
  effect: '它怎么生效（禁用条目）',
  appliesWhen: '什么前提下才生效（对象在位？）',
  target: 'ui-some-entry',
}
```

`subjectStatus` 由 `describeSubject()` 按 `subject.kind` 自动判定（entry 看 Loader 树），不用手写。

## 安装形态的坑（Junction 会让插件静默失活）

`plugin_manager install_bundle` 传**绝对路径**时，会把 profile 里的 spec 改写成
`file:C:/...`，pnpm 据此把本包装成 **Junction**（`LinkType='Junction'`）。
Junction 让 `index.js` 的依赖解析基准落到**源码目录**（在同步盘上、没有 `node_modules`），
于是 `import '@deepseek-ai/schemastery'` 找不到 → `apply` 抛错 → 条目 `fiberPhase: null`
→ `/dsh-tweaks/status` 返回 404，**而且重启也不会自愈**（Node 缓存了失败的模块解析，
失败的 fiber 不会自己重试）。

兄弟包（`dsh-model-info`）是真实目录（`LinkType=''`）所以不受影响。

排查与修复：

```powershell
# 1. 安装形态：LinkType 应为空
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tweaks" -Force | Select-Object LinkType

# 2. 条目是否真的活了：plugin_manager → list_plugins，看末尾几条
#    （其余插件都是 active；它是 null 就说明没起来）

# 3. 修：spec 改回相对形式 + 删掉 junction + 按 file: 重新解析安装
#    完整步骤见 3-pcsetting\.dsh\dsh-plugins\AGENTS.md「安装与依赖」

# 4. 必须重启 DSH 才生效
```

一句话判据：**源码包不能以链接形态装进 profile**，否则依赖解析会跑到同步盘上去。

## Dev

```bash
node test/run.mjs      # 注册表与生效对象元数据 / 对象状态判定 /
                       # Config 可调参数 / 事件驱动对账 / toggle 走状态文件 /
                       # 卡片只读（开关在设置窗口）
```

## 已知偏离官方架构之处（知情取舍 / 技术债）

官方文档（[插件开发](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)、
`docs/subsystems/{settings,slots}`、`ui-plugin.md`）给出的默认做法与本插件的取舍：

本插件贡献两处 UI：插件页状态卡片走官方 slot（`plugins.bundle.config`），
开关本身走官方 `settings` 服务（设置窗口 `settings.section` 一级分区）。

| # | 偏离 | 取舍理由 |
| --- | --- | --- |
| 1 | **未给 agent 暴露 Tool** | 官方要求"一个操作两个入口"（UI + Tool）共用同一实现；目前只有 UI + loopback 路由 |
| 2 | **缺 locale/icon** | 官方建议 bundle 导出 `locale/*.json` 的 `meta.title/description` 与图标；当前落回 `package.json` 的英文描述 |

> 保持不变的纪律：只用 `ctx.effect` 注册可逆副作用、失败不阻塞启动、如实上报状态、
> 只用官方 slot 贡献 UI，不读他人 DOM / 样式。

## License

MIT
