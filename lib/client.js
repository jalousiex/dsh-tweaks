/**
 * dsh-tweaks —— 浏览器半。
 *
 * 贡献两处 UI，全部读 `GET /dsh-tweaks/status`、写 `POST /dsh-tweaks/toggle`：
 *
 *  1. **设置 › 插件 › dsh-tweaks 页内的开关卡片**（官方 slot
 *     `plugins.bundle.config`，keyed by 包名）——开关的权威入口，
 *      重启不在这里：已迁到独立插件 dsh-restart（/restart 命令 + restart_harness 工具）。
 *  2. **dsh-tap 设置卡的「快速过滤」行**：在「模型」分区标题下插一行
 *     「剔除不可路由的死模型」勾选框，绑定 hideUnroutableModels 这个 tweak。
 *     只在新增子树里找锚点（DOM 纪律），WeakMap 幂等，绝不整页扫描。
 *
 * 重启入口为什么只在插件页：侧边栏底部（`sidebar.footer.action`）试过又撤掉——
 * 那一行与 dsh-tap-quota 的余额卡片共用，按钮挤在「设置」旁位置不对；而头像菜单
 * （`AccountMenu`，`settings.launcher` 的 single 占用者）没有任何菜单项 slot
 * 可扩展（88 个 slot 里没有「头像菜单项」这种槽）。
 *
 * 加载器契约（dsh 硬规则）：本文件**必须**是
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * 旧的 `{ id, exports: fn }` 形态会让宿主抛
 * `registered.factory is not a function`，直接崩掉整个 web boot。
 *
 * DOM 纪律（这条是 UI 卡死的根因）：
 *   · 绝不 observe `class`；只用 `childList + subtree` 加窄 attributeFilter；
 *   · 绝不在 mutation 回调里整页扫描 —— 只看新增子树，rAF 合帧；
 *   · 按节点用 WeakMap 幂等；
 *   · 宿主 DOM 对不上我们的选择器时就什么都不做（绝不抛错）。
 *
 * ⚠ **知情例外：就地行（decorateTapSection / HIDE_UNROUTABLE_CSS）**
 *   官方纪律要求功能插件只用 slot 贡献 UI、**绝不读他人 DOM / 样式**
 *   （见 slots.zh.md、ui-plugin.md 的 "Do not read another plugin's DOM"）。
 *   本插件在 dsh-tap 设置卡的「模型」分区里就地插一行开关、并用 `.cbc-*`
 *   私有类名隐藏死模型行，属于**已知违反**——保留它是产品决定（用户要求就地
 *   操作），代价是：dsh-tap 改类名或结构时这段会失效（锚点对不上就什么都不做，
 *   不会崩）。其余纪律（不 observe class、只看新增子树、rAF 合帧、WeakMap 幂等）
 *   仍然全部守住。
 */

window.__ModuleLoader__.load({
	id: "dsh-tweaks",
	factory: function (require) {
		"use strict";
		var React = require("react");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var STATUS = "/dsh-tweaks/status";
		var TOGGLE = "/dsh-tweaks/toggle";
		var BALANCE = "/dsh-tweaks/balance";
		var MARK = "data-dsh-tweaks";
		// 兜底刷新间隔的兜底值（毫秒）：正常由宿主 GET /dsh-tweaks/status 的
		// config.statusRefreshMs 下发，这里只是它也拿不到时的最后默认值。
		var DEFAULT_REFRESH_MS = 600000;
		var BUNDLE_KEY = "dsh-tweaks";
		var HIDE_UNROUTABLE_ID = "hideUnroutableModels";

		// 开关列表：每条一个卡片，含「启用状态 / 描述 / 生效对象 / 对象状态 / 生效条件」。
		var CSS_TEXT = [
			'.dtw-card{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.2))}',
			'.dtw-card:last-child{border-bottom:0}',
			'.dtw-head{display:flex;align-items:flex-start;gap:10px}',
			'.dtw-headcheck{flex:0 0 auto;margin-top:2px}',
			'.dtw-headtext{flex:1;min-width:0}',
			'.dtw-title{display:block;font-weight:600}',
			'.dtw-what{display:block;opacity:.75;font-size:12px;margin-top:2px;white-space:normal}',
			'.dtw-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-left:24px}',
			'.dtw-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;padding:0 6px;border-radius:9px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.25));opacity:.85;white-space:normal}',
			'.dtw-chip-key{opacity:.6}',
			'.dtw-chip-ready{color:#3fb950;border-color:#3fb95055}',
			'.dtw-chip-disabled{color:#58a6ff;border-color:#58a6ff55}',
			'.dtw-chip-pending{color:#d29922;border-color:#d2992255}',
			'.dtw-chip-missing,.dtw-chip-mismatch{color:#f85149;border-color:#f8514955}',
			'.dtw-chip-idle{opacity:.55}',
			'.dtw-note{margin-left:24px;font-size:11px;opacity:.6;white-space:normal}',
			'.dtw-note-error{color:#f85149;opacity:.9}',
			'.dtw-actions{margin-left:24px;margin-top:6px;display:flex;align-items:center;gap:8px}',
			'.dtw-btn{font:inherit;font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer}',
			'.dtw-btn:hover:not(:disabled){border-color:var(--dsw-alias-stroke-strong,rgba(128,128,128,.6))}',
			'.dtw-btn:disabled{opacity:.45;cursor:not-allowed}',
			'.dtw-btn-danger{border-color:#f8514966;color:#f85149}',
			'.dtw-taprow{display:flex;align-items:center;gap:8px;margin:6px 0 2px;font-size:12px;opacity:.9}',
			'.dtw-taprow label{cursor:pointer}',
		].join("\n");

		// hideUnroutableModels 的浏览器半：dsh-tap 设置卡里 `cbc-unroutable` 的行
		// 整行隐去；如果某个分组小标题后面只剩死条目（典型是「未启用（4）」），
		// 连标题一起隐去，免得留下空分组和一个数不上的计数。
		// 只用 CSS —— 不动别人的 DOM 节点，不对 class 做 MutationObserver（DOM 纪律）。
		var HIDE_UNROUTABLE_CSS = [
			'.cbc-listrow.cbc-unroutable{display:none!important}',
			'.cbc-scrollbox>p.cbc-subtitle:not(:has(~.cbc-listrow:not(.cbc-unroutable))){display:none!important}',
		].join("\n");

		function styleText() {
			return state.hideUnroutable ? CSS_TEXT + "\n" + HIDE_UNROUTABLE_CSS : CSS_TEXT;
		}

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var wanted = styleText();
			var tag = 'style[data-plugin-css="dsh-tweaks"]';
			var existing = document.querySelector(tag);
			if (existing) {
				if (existing.textContent !== wanted) existing.textContent = wanted;
				return;
			}
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tweaks");
			el.setAttribute("data-plugin-css", "dsh-tweaks");
			el.textContent = wanted;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// State: rows = 参与开关列表的 tweak（menu 声明或带 target）。
		// ------------------------------------------------------------------
		var state = { rows: [], loaded: false, hideUnroutable: false, refreshMs: DEFAULT_REFRESH_MS };
		var listeners = [];
		var decorated = new WeakMap();

		function readTweaks(doc) {
			var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
			var rows = [];
			var hideUnroutable = false;
			for (var i = 0; i < list.length; i++) {
				var t = list[i];
				if (!t || typeof t.id !== "string") continue;
				// 这个开关的浏览器半效果（隐藏死条目行）与它有没有菜单行无关。
				if (t.id === HIDE_UNROUTABLE_ID) hideUnroutable = t.enabled === true;
				if (!(t.menu === true || t.target || t.action)) continue;
				rows.push({
					id: t.id,
					title: t.title || t.id,
					// 一句话「它改什么」——比 why 更适合放在卡片正文里。
					what: typeof t.what === "string" ? t.what : "",
					why: typeof t.why === "string" ? t.why : "",
					note: typeof t.note === "string" ? t.note : "",
					error: typeof t.error === "string" ? t.error : "",
					enabled: t.enabled === true,
					applied: t.applied === true,
					effective: t.effective === true,
					present: t.present === true,
					// 生效对象：{ kind, label }（kind ∈ entry / plugin / file / host）
					subjectKind: typeof t.subjectKind === "string" ? t.subjectKind : "",
					subjectLabel: typeof t.subjectLabel === "string" ? t.subjectLabel : "",
					// 对象状态：idle / ready / pending / disabled / missing / mismatch
					subjectStatus: typeof t.subjectStatus === "string" ? t.subjectStatus : "unknown",
					subjectStatusLabel: typeof t.subjectStatusLabel === "string" ? t.subjectStatusLabel : "",
					effect: typeof t.effect === "string" ? t.effect : "",
					appliesWhen: typeof t.appliesWhen === "string" ? t.appliesWhen : "",
					// 有 action 的条目带按钮（当前没有这类条目：重启已迁出）。
					action: typeof t.action === "string" ? t.action : null,
					actionReady: t.actionReady === true,
					actionBlockedBy: typeof t.actionBlockedBy === "string" ? t.actionBlockedBy : "",
				});
			}
			var refreshMs = DEFAULT_REFRESH_MS;
			var cfg = doc && doc.config;
			if (cfg && typeof cfg.statusRefreshMs === "number" && cfg.statusRefreshMs > 0) {
				refreshMs = cfg.statusRefreshMs;
			}
			return { rows: rows, loaded: true, hideUnroutable: hideUnroutable, refreshMs: refreshMs };
		}

		function notify() {
			for (var i = 0; i < listeners.length; i++) {
				try { listeners[i](); } catch (e) {}
			}
		}

		// 状态落地后的钩子（install 用它按新间隔重排兜底刷新定时器）。
		var statusSink = null;
		var stopQuickRef = null;

		function fetchStatus() {
			return fetch(STATUS, { headers: { accept: "application/json" } })
				.then(function (r) {
					return r.text().then(function (text) {
						var doc = null;
						try {
							doc = JSON.parse(text);
						} catch (e) {
							doc = null;
						}
						state = readTweaks(doc);
						ensureStyles();
						if (statusSink) { try { statusSink(state); } catch (e) {} }
						notify();
						return state;
					});
				})
				.catch(function () {
					state = { rows: [], loaded: true, hideUnroutable: false, refreshMs: DEFAULT_REFRESH_MS };
					if (statusSink) { try { statusSink(state); } catch (e) {} }
					notify();
					return state;
				});
		}

		function toggle(id, next) {
			return fetch(TOGGLE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, enabled: next }),
			}).then(function () {
				// 宿主写盘后由 hmr 重新应用，稍等一下再取状态。
				return new Promise(function (resolve) { setTimeout(resolve, 600); });
			}).then(fetchStatus);
		}


		// ------------------------------------------------------------------
		// React: 设置 › 插件 › dsh-tweaks 页的开关列表（plugins.bundle.config）。
		// ------------------------------------------------------------------
		function useTweaks() {
			var s = React.useState(function () { return state; });
			var set = s[1];
			React.useEffect(function () {
				listeners.push(set);
				return function () {
					var i = listeners.indexOf(set);
					if (i >= 0) listeners.splice(i, 1);
				};
			}, []);
			return s[0];
		}

		var SUBJECT_KIND_LABEL = {
			entry: "Loader 条目",
			plugin: "插件",
			file: "磁盘文件",
			host: "宿主进程",
		};

		var STATUS_LABEL = {
			idle: "未启用",
			ready: "就绪",
			pending: "待生效",
			disabled: "已禁用",
			missing: "对象缺失",
			mismatch: "形态不匹配",
			unknown: "未知",
		};

		function Chip(props) {
			return React.createElement("span", {
				className: "dtw-chip dtw-chip-" + props.kind,
				title: props.title || undefined,
			}, React.createElement("span", { className: "dtw-chip-key" }, props.label), props.value);
		}

		/**
		 * 一条 tweak = 一张卡片。**只留核心**：勾选框 + 短标题 + 一句描述 +
		 * 生效对象 chip + 对象状态 chip。详细依据（why / effect / appliesWhen）
		 * 全部收进悬浮 title，不再平铺——之前七块并排太吵、看不清重点。
		 */
		function TweakCard(props) {
			var row = props.row;
			var hint = [
				row.enabled ? "当前：已启用" : "当前：未启用",
				row.what ? "作用：" + row.what : "",
				row.subjectLabel ? "生效对象：" + row.subjectLabel : "",
				row.subjectStatusLabel ? "对象状态：" + row.subjectStatusLabel : "",
				row.effect ? "生效方式：" + row.effect : "",
				row.appliesWhen ? "生效条件：" + row.appliesWhen : "",
				row.why ? "依据：" + row.why : "",
			].filter(Boolean).join("\n");
			var subjectKindText = row.subjectKind
				? (SUBJECT_KIND_LABEL[row.subjectKind] || row.subjectKind)
				: "";
			return React.createElement("div", { className: "dtw-card", title: hint || undefined },
				React.createElement("div", { className: "dtw-head" },
					React.createElement("input", {
						type: "checkbox",
						className: "dtw-headcheck",
						checked: row.enabled === true,
						onChange: function (e) { toggle(row.id, e.target.checked); },
					}),
					React.createElement("div", { className: "dtw-headtext" },
						React.createElement("span", { className: "dtw-title" }, row.title),
						row.what ? React.createElement("span", { className: "dtw-what" }, row.what) : null)),
				// 只留两个 chip：作用在谁身上 + 它现在什么状况。
				React.createElement("div", { className: "dtw-meta" },
					row.subjectLabel
						? React.createElement(Chip, {
							kind: row.enabled ? "disabled" : "idle",
							label: (subjectKindText ? subjectKindText + "：" : ""),
							value: row.subjectLabel,
						})
						: null,
					React.createElement(Chip, {
						kind: row.subjectStatus,
						label: "",
						value: STATUS_LABEL[row.subjectStatus] || row.subjectStatus,
						title: row.subjectStatusLabel || undefined,
					})),
				// 只在真出问题时才占行（正常状态不刷屏）。
				row.error ? React.createElement("div", { className: "dtw-note dtw-note-error" }, "错误：" + row.error) : null,
				row.note ? React.createElement("div", { className: "dtw-note" }, row.note) : null);
		}

		function TweaksPage() {
			var s = useTweaks();
			var rows = s.rows || [];
			return React.createElement("div", null,
				React.createElement("p", { style: { margin: "0 0 4px", opacity: 0.65, fontSize: 12 } },
					"开关写在 ③ cordis.patch.yml 的 dsh-tweaks 段，随 profile 跨机同步。"),
				rows.length
					? rows.map(function (row) { return React.createElement(TweakCard, { key: row.id, row: row }); })
					: React.createElement("p", { style: { opacity: 0.6 } },
						s.loaded ? "宿主还没有登记任何开关。" : "正在读取开关状态……"));
		}

		// ------------------------------------------------------------------
		// dsh-tap 设置卡里的「快速过滤」行：hideUnroutableModels 的就地开关。
		// 锚点 = p.cbc-group-title 且文案为「模型」；只在新增子树里找（DOM 纪律）。
		// ------------------------------------------------------------------
		function makeTapRow() {
			var wrap = document.createElement("div");
			wrap.className = "dtw-taprow";
			wrap.setAttribute(MARK, "");
			var box = document.createElement("input");
			box.type = "checkbox";
			var label = document.createElement("label");
			label.textContent = "剔除不可路由的死模型";
			var sync = function () { box.checked = state.hideUnroutable === true; };
			sync();
			box.addEventListener("change", function () {
				box.disabled = true;
				toggle(HIDE_UNROUTABLE_ID, box.checked).then(function () {
					box.disabled = false;
					sync();
				}).catch(function () { box.disabled = false; });
			});
			listeners.push(function () { sync(); });
			wrap.appendChild(box);
			wrap.appendChild(label);
			return wrap;
		}

		function decorateTapSection(root) {
			var scope = root;
			if (!scope || !scope.querySelectorAll) return;
			var titles = scope.querySelectorAll("p.cbc-group-title");
			for (var i = 0; i < titles.length; i++) {
				var title = titles[i];
				if (!title.parentNode) continue;
				if (title.getAttribute(MARK + "-host")) continue;
				if ((title.textContent || "").trim() !== "模型") continue;
				try {
					var row = makeTapRow();
					title.parentNode.insertBefore(row, title.nextSibling);
					title.setAttribute(MARK + "-host", "");
					decorated.set(title, row);
				} catch (e) {}
			}
		}

		function collect(node) {
			if (!node || node.nodeType !== 1) return;
			try {
				if (node.matches && node.matches("p.cbc-group-title")) decorateTapSection(node.parentNode || node);
				else if (node.querySelectorAll) decorateTapSection(node);
			} catch (e) {}
		}

		function install() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var raf = 0;
			var timer = null;
			var observer = null;
			var pending = [];

			// rAF 合帧：把同一帧内的多条 mutation 合并成一次处理，避免重复走 DOM。
			function schedule(node) {
				if (node) pending.push(node);
				if (raf) return;
				var run = function () {
					raf = 0;
					if (typeof document !== "undefined" && document.hidden) { pending = []; return; }
					var nodes = pending;
					pending = [];
					for (var i = 0; i < nodes.length; i++) collect(nodes[i]);
				};
				raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 16);
			}

			function observe() {
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["aria-expanded", "aria-label"],
				});
			}

			function onMutations(records) {
				var touched = false;
				for (var i = 0; i < records.length; i++) {
					var rec = records[i];
					if (rec.type === "attributes") { touched = true; continue; }
					for (var j = 0; j < rec.addedNodes.length; j++) schedule(rec.addedNodes[j]);
					if (rec.addedNodes.length) touched = true;
				}
				if (touched && !pending.length) schedule(null);
			}

			// 兜底刷新：间隔由宿主 /dsh-tweaks/status 的 config.statusRefreshMs 下发
			// （不写死在浏览器半），这里按当前值重排定时器。
			function armRefresh() {
				if (timer) clearInterval(timer);
				var ms = state.refreshMs > 0 ? state.refreshMs : DEFAULT_REFRESH_MS;
				timer = setInterval(function () {
					if (typeof document !== "undefined" && document.hidden) return;
					fetchStatus();
				}, ms);
			}

			armRefresh();

			observer = new MutationObserver(onMutations);
			observe();

			// 每次状态落地（首帧 / 每次 toggle / 每次兜底刷新）都按服务端下发的
			// 间隔重排定时器，这样 statusRefreshMs 改一次就全局生效，不写死。
			statusSink = function () { armRefresh(); };
			fetchStatus();

			// 首帧没拿到内容时快速重试几次（宿主可能还没注册完路由 / 正忙）。
			// 只重试「真的空」，不重试「已经拿到但列表为空」——后者是宿主如实回答。
			var quick = 0;
			var quickTimer = setInterval(function () {
				if (quick++ >= 5) { clearInterval(quickTimer); return; }
				if (state.rows.length > 0) { clearInterval(quickTimer); return; }
				fetchStatus();
			}, 400);
			var stopQuick = function () {
				clearInterval(quickTimer);
				if (quickTimer) quickTimer = null;
			};
			stopQuickRef = stopQuick;

			return function dispose() {
				if (timer) clearInterval(timer);
				if (stopQuickRef) { stopQuickRef(); stopQuickRef = null; }
				statusSink = null;
				if (raf) {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
					else clearTimeout(raf);
				}
				if (observer) observer.disconnect();
				try {
					var mine = document.querySelectorAll("[" + MARK + "]");
					for (var i = 0; i < mine.length; i++) {
						if (mine[i].parentNode) mine[i].parentNode.removeChild(mine[i]);
					}
				} catch (e) {}
				decorated = new WeakMap();
				listeners = [];
			};
		}

		// ------------------------------------------------------------------
		// sidebarBalance：侧边栏的 DSH 内置余额卡片
		//
		// 数据来自宿主 GET /dsh-tweaks/balance（背后是 deepseekAccount.getBalance，
		// 与「设置 → 账号」同源）。**只渲染，不自己读上游**——浏览器半不碰任何供应商接口。
		//
		// 金额是十进制字符串，所以全程按字符串算：内置 formatBalance 用 Big 做
		// roundDown，先转 Number 会把 12.34 变成 12.339999，最后一位就漂了。
		// ------------------------------------------------------------------
		var BALANCE_MARK = "data-dsh-tweaks-balance";
		var BALANCE_POLL_MS = 60000;
		var BALANCE_CSS = [
			'.dtw-balance{display:flex;align-items:center;gap:6px;width:100%;min-width:0;box-sizing:border-box;margin:3px 0 1px;padding:2px 4px;font-size:11px;line-height:1.2}',
			'.dtw-balance-val{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-primary,inherit);min-width:0;overflow:hidden;text-overflow:ellipsis}',
			'.dtw-balance-btn{border:0;background:transparent;padding:0 2px;font:inherit;font-size:11px;line-height:1;cursor:pointer;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));opacity:.6;border-radius:3px;flex:0 0 auto;margin-left:auto}',
			'.dtw-balance-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
			'.dtw-balance-btn:focus-visible{outline:1px solid var(--dsw-alias-border-focus,var(--dsw-alias-state-business-primary,#1a66ff));outline-offset:1px}',
			'.dtw-balance-btn[disabled]{opacity:.35;cursor:default}',
		].join("\n");

		function fmtMoney(amount, symbol) {
			var s = amount == null ? "" : String(amount).trim();
			if (!s) return symbol + "0.00";
			var negative = s.charAt(0) === "-";
			var body = negative ? s.slice(1) : s;
			if (!/^\d*(?:\.\d*)?$/.test(body) || !/\d/.test(body)) {
				var n = Number(s);
				if (!isFinite(n)) return "—";
				negative = n < 0;
				body = Math.abs(n).toFixed(2);
			}
			var parts = body.split(".");
			var integer = parts[0] === "" ? "0" : parts[0];
			var fraction = (parts[1] || "").slice(0, 2);
			while (fraction.length < 2) fraction += "0";
			var raw = Number(body);
			if (!isFinite(raw)) raw = 0;
			if (negative) raw = -raw;
			if (raw === 0) return symbol + "0.00";
			var text = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + fraction;
			if (negative) return raw > -0.01 ? "-" + symbol + "0.01" : "-" + symbol + text;
			if (raw < 0.01) return "<" + symbol + "0.01";
			return symbol + text;
		}

		function symbolOf(currency) {
			return currency === "USD" ? "$" : "¥";
		}

		function positiveMoney(amount) {
			var n = Number(amount);
			return isFinite(n) && n > 0;
		}

		/** 余额 → 显示文本 + tooltip 行。充值与赠金分开、不相加。 */
		function balanceText(balance) {
			if (!balance) return null;
			if (balance.ok === true) {
				var wallets = Array.isArray(balance.wallets) ? balance.wallets : [];
				var bonus = (Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []).filter(function (w) {
					return w && positiveMoney(w.balance);
				});
				var money = function (w) { return fmtMoney(w.balance, symbolOf(w.currency)); };
				var text = wallets.length ? wallets.map(money).join(" / ") : "¥0.00";
				var lines = ["DSH 内置余额", "充值余额 " + (wallets.length ? wallets.map(money).join(" / ") : "¥0.00")];
				if (bonus.length) {
					text += " ·赠 " + bonus.map(money).join(" / ");
					lines.push("赠金 " + bonus.map(money).join(" / "));
				}
				return { value: text, title: lines.join("\n") };
			}
			if (balance.error === "signed-out") {
				return { value: "未登录", title: "DSH 账号未登录 —— 设置 → 账号" };
			}
			return { value: "—", title: "DSH 账号余额读取失败：" + (balance.error || "未知错误") };
		}

		function installBalanceWidget() {
			if (typeof document === "undefined") return function () {};
			var tag = 'style[data-plugin-css="dsh-tweaks-balance"]';
			var existing = document.querySelector(tag);
			if (!existing) {
				var el = document.createElement("style");
				el.setAttribute("data-plugin", "dsh-tweaks-balance");
				el.setAttribute("data-plugin-css", "dsh-tweaks-balance");
				el.textContent = BALANCE_CSS;
				document.head.appendChild(el);
			} else if (existing.textContent !== BALANCE_CSS) {
				existing.textContent = BALANCE_CSS;
			}

			var host = null;
			var timer = null;
			var disposed = false;
			var nextDelay = BALANCE_POLL_MS;

			// 与 dsh-tap-quota 同一套挂载逻辑：注入侧边栏底部区域之前。
			// 一次有界结构查询 + childList observer（不 observe class、不整页扫描）。
			function findFootArea() {
				var areas = document.querySelectorAll('[class*="_footArea"]');
				for (var i = 0; i < areas.length; i++) {
					var parent = areas[i].parentNode;
					if (parent && parent.querySelector('[class*="_regionArea"]')) return areas[i];
				}
				return areas.length ? areas[0] : null;
			}

			function buildWidget() {
				var wrap = document.createElement("div");
				wrap.className = "dtw-balance";
				wrap.setAttribute(BALANCE_MARK, "");
				wrap.setAttribute("role", "group");
				wrap.setAttribute("aria-label", "DSH 余额");
				var val = document.createElement("span");
				val.className = "dtw-balance-val";
				var btn = document.createElement("button");
				btn.type = "button";
				btn.className = "dtw-balance-btn";
				btn.textContent = "⟳";
				btn.title = "立即刷新";
				btn.setAttribute("aria-label", "刷新 DSH 余额");
				wrap.appendChild(val);
				wrap.appendChild(btn);
				return { wrap: wrap, val: val, btn: btn };
			}

			function render(snap) {
				if (!host) return;
				var shown = snap && snap.ok === true && snap.signedIn === true ? balanceText(snap.balance) : null;
				if (!shown) {
					host.wrap.style.display = "none";
					return;
				}
				host.wrap.style.display = "flex";
				host.val.textContent = shown.value;
				host.wrap.title = shown.title;
				host.btn.disabled = false;
			}

			function fetchData(force) {
				if (disposed) return;
				var opts = {};
				if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(8000);
				fetch(BALANCE + (force ? "?refresh=1" : ""), opts)
					.then(function (r) { return r.json(); })
					.then(function (snap) {
						render(snap);
						nextDelay = BALANCE_POLL_MS;
						timer = setTimeout(function () {
							if (typeof document !== "undefined" && document.hidden) {
								timer = setTimeout(function () { fetchData(false); }, BALANCE_POLL_MS);
								return;
							}
							fetchData(false);
						}, BALANCE_POLL_MS);
					})
					.catch(function () {
						// 失败翻倍退避，上限 5 分钟——绝不密集重试。
						nextDelay = Math.min(nextDelay * 2, 300000);
						timer = setTimeout(function () { fetchData(false); }, nextDelay);
					});
			}

			function mount() {
				if (disposed) return;
				var footArea = findFootArea();
				if (!footArea || !footArea.parentNode) {
					setTimeout(function () { if (!disposed) mount(); }, 2000);
					return;
				}
				var parent = footArea.parentNode;
				if (!host) {
					host = buildWidget();
					host.btn.addEventListener("click", function (e) {
						e.stopPropagation();
						host.btn.disabled = true;
						fetchData(true);
					});
				}
				if (host.wrap.parentNode !== parent || host.wrap.nextSibling !== footArea) {
					parent.insertBefore(host.wrap, footArea);
				}
				fetchData(false);
			}

			mount();

			return function dispose() {
				disposed = true;
				if (timer) clearTimeout(timer);
				if (host && host.wrap && host.wrap.parentNode) host.wrap.parentNode.removeChild(host.wrap);
				host = null;
			};
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () {
				return install();
			}, "dsh-tweaks: status polling and styles");
			// 侧边栏 DSH 余额卡片（sidebarBalance 开关的界面兑现）。
			// 宿主侧由 GET /dsh-tweaks/balance 供数，浏览器半不碰任何上游接口。
			ctx.effect(function () {
				return installBalanceWidget();
			}, "dsh-tweaks: sidebar balance card");
			// 设置 › 插件 › dsh-tweaks 页内的开关卡片（keyed by 包名）。
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE_KEY,
				}, TweaksPage);
			});
			// 重启入口只在插件页。侧边栏底部（sidebar.footer.action）试过又撤掉了：
			// 那一行是和 dsh-tap-quota 的余额卡片共用的 flex 行，按钮挤在「设置」旁边
			// 位置不对；而头像菜单（AccountMenu，settings.launcher 的 single 占用者）
			// 没有任何菜单项 slot 可扩展——88 个 slot 里没有「头像菜单项」这种槽。
		}

		exports.STATUS = STATUS;
		exports.TOGGLE = TOGGLE;
		exports.BALANCE = BALANCE;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			readTweaks: readTweaks,
			decorateTapSection: decorateTapSection,
			styleText: styleText,
			HIDE_UNROUTABLE_CSS: HIDE_UNROUTABLE_CSS,
			// 余额卡片：纯函数导出，测试夹具直接覆盖字符串截断与边界。
			fmtMoney: fmtMoney,
			symbolOf: symbolOf,
			balanceText: balanceText,
			BALANCE_CSS: BALANCE_CSS,
		};
		return module.exports;
	},
});