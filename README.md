# dsh-tweaks

一组**可单独开关**的小改动，为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 服务。

把「我开了哪几个小开关」收敛成一块 YAML 配置，让它随 profile 跨机器同步，
而不是散落在十来个文件里靠记忆维持。

## 为什么单独做一个插件

需求是"去掉设置里的模型清单页""加个一键重启"这类**小**改动。
如果每个都手改 `cordis.patch.yml`，会带来三个问题：

1. **无法开关**：想临时恢复默认，得记住原来那段长什么样。
2. **无法跨机**：改在哪一层、改了几处，换台机器就丢。
3. **无法追溯**：半年后看到一条 `disabled: true`，不知道是谁为什么加的。

所以这里把每个改动登记成一条带 `why` 的记录，开关统一成
`config.tweaks.<id>.enabled`。加新开关 = `index.js` 里加一行 + 配置里加一行。

## 设计约束（对齐 dsh 架构）

| 约束 | 做法 |
| --- | --- |
| 配置是数据不是代码 | 每个 tweak 只有 `enabled` 加少量参数；`index.js` 的 `TWEAKS` 是唯一登记处 |
| 只走官方扩展点 | ① profile 条目列表（就是 `cordis.patch.yml` 的用途）② 自己前缀下的 loopback 路由。**不碰其它包的内部** |
| 幂等且可逆 | `ctx.effect` 注册副作用，卸载时自动回滚；重复应用不会叠加 |
| 绝不阻塞启动 | 单个 tweak 失败只记录到 `/dsh-tweaks/status`，应用照常启动 |
| 如实汇报 | 状态路由同时给出 `enabled`（想开吗）与 `applied`（真的生效了吗），避免"开了但没反应"无从排查 |

## 现有开关

| id | 默认 | 作用 |
| --- | --- | --- |
| `hideSettingsModels` | 关 | 隐藏设置里的「模型清单」页，只留「账号与余额」 |
| `restartButton` | 关 | 菜单里加一个「重启 DeepSeek Harness」入口 |

### `hideSettingsModels` 的依据

设置里那一页由 `@deepseek-ai/dsh-client-ui-settings-models` 提供，
注册点在 `dsh-web-app/cordis.patch.yml` 第 294 行（`id: ui-settings-models`）。

按 dsh 的 patch 语义（「一条 patch 按 id 定位某个条目并替换其整个 config」），
把该条目 `disabled: true` 即可 —— 不是改别人的文件，是走它自己的扩展点。
`disabled` 也不是本插件发明的字段：bundle 层自己就在用（同文件第 448 行起有 6 处）。

**范围说明**：模型清单本身是 dsh-tap 网关返回的上游目录。关掉这一页
**不影响** `/model` 下拉和模型选择，只少一个只读展示页。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-tweaks/status` | 每个 tweak 的 `enabled` / `applied` / `error` |
| `POST` | `/dsh-tweaks/restart` | 真重启宿主。**需显式 `allowRestart: true`**，默认关（会中断会话） |
| `POST` | `/dsh-tweaks/diag` | 浏览器半诊断，落 `~/.dsh/.cache/dsh-tweaks-client.json` |

## 配置

```yaml
- insert:
    - id: dsh-tweaks
      name: 'dsh-tweaks'
      config:
        statusRoute: true      # 只读状态路由
        allowRestart: false    # 允许 POST /dsh-tweaks/restart
        tweaks:
          hideSettingsModels:
            enabled: true
          restartButton:
            enabled: false
```

## 加一个开关

```js
// index.js
{
  id: 'myTweak',
  title: '一句话说明它改什么',
  why: '为什么要改、依据是什么、范围边界在哪里 —— 写给半年后的自己看',
  apply(ctx, tweak, config) { /* 走官方扩展点；失败请抛错，会被记录 */ },
}
```

再在 `cordis.patch.yml` 的 `tweaks` 下加 `myTweak: { enabled: false }`。

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs      # 26 assertions：注册表 / 开关解析 / 状态汇报 / DOM 纪律
```

## License

MIT
