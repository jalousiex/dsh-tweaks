/**
 * dsh-tweaks —— 浏览器半。
 *
 * 贡献两处 UI，全部读 `GET /dsh-tweaks/status`、写 `POST /dsh-tweaks/toggle`：
 *
 *  1. **设置 › 插件 › dsh-tweaks 页内的开关列表**（官方 slot
 *     `plugins.bundle.config`，keyed by 包名）——这是开关的权威入口，
 *     每行 title + why（title 悬浮说明）。
 *  2. **dsh-tap 设置卡的「快速过滤」行**：在「模型」分区标题下插一行
 *     「剔除不可路由的死模型」勾选框，绑定 hideUnroutableModels 这个 tweak。
 *     只在新增子树里找锚点（DOM 纪律），WeakMap 幂等，绝不整页扫描。
 *
 * 加载器契约（dsh 硬规则）：本文件**必须**是
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * 旧的 `{ id, exports: fn }` 形态会让宿主抛
 * `registered.factory is not a function`，直接崩掉整个 web boot。
 *
 * DOM 纪律（这条是 UI 卡死的根因）：
 *   · 绝不 observe `class`；只用 `childList + subtree` 加窄 attributeFilter；
 *   · 绝不在 mutation 回调里整页扫描 —— 只看新增子树；
 *   · 最多一次 rAF 合帧，按节点用 WeakMap 幂等；
 *   · 宿主 DOM 对不上我们的选择器时就什么都不做（绝不抛错）。
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
		var MARK = "data-dsh-tweaks";
		var REFRESH_MS = 600000;
		var BUNDLE_KEY = "dsh-tweaks";
		var HIDE_UNROUTABLE_ID = "hideUnroutableModels";

		var CSS_TEXT = [
			'.dtw-pageitem{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-stroke-subtle,rgba(128,128,128,.2))}',
			'.dtw-pageitem:last-child{border-bottom:0}',
			'.dtw-pagecheck{flex:0 0 auto;margin-top:2px}',
			'.dtw-pagelabel{flex:1;min-width:0;cursor:pointer}',
			'.dtw-pagetitle{display:block;font-weight:600}',
			'.dtw-pagewhy{display:block;opacity:.65;font-size:12px;margin-top:2px;white-space:normal}',
			'.dtw-pagenote{display:block;opacity:.55;font-size:12px;margin-top:2px}',
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
		var state = { rows: [], loaded: false, hideUnroutable: false };
		var listeners = [];
		var decorated = new WeakMap();
		var diag = { sweeps: 0, inserts: 0, toggles: 0 };

		function readTweaks(doc) {
			var list = doc && Array.isArray(doc.tweaks) ? doc.tweaks : [];
			var rows = [];
			var hideUnroutable = false;
			for (var i = 0; i < list.length; i++) {
				var t = list[i];
				if (!t || typeof t.id !== "string") continue;
				// 这个开关的浏览器半效果（隐藏死条目行）与它有没有菜单行无关。
				if (t.id === HIDE_UNROUTABLE_ID) hideUnroutable = t.enabled === true;
				if (!(t.menu === true || t.target)) continue;
				rows.push({
					id: t.id,
					title: t.title || t.id,
					why: typeof t.why === "string" ? t.why : "",
					note: typeof t.note === "string" ? t.note : "",
					error: typeof t.error === "string" ? t.error : "",
					enabled: t.enabled === true,
				});
			}
			return { rows: rows, loaded: true, hideUnroutable: hideUnroutable };
		}

		function notify() {
			for (var i = 0; i < listeners.length; i++) {
				try { listeners[i](); } catch (e) {}
			}
		}

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
						notify();
						return state;
					});
				})
				.catch(function () {
					state = { rows: [], loaded: true, hideUnroutable: false };
					notify();
					return state;
				});
		}

		function toggle(id, next) {
			diag.toggles++;
			return fetch(TOGGLE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, enabled: next }),
			}).then(function () {
				// 宿主写盘后由 hmr 重新应用，稍等一下再取状态。
				return new Promise(function (resolve) { setTimeout(resolve, 600); });
			}).then(fetchStatus);
		}

		function report(extra) {
			if (typeof fetch !== "function") return;
			var payload = {
				plugin: "dsh-tweaks",
				at: Date.now(),
				state: { rows: state.rows.length, loaded: state.loaded, hideUnroutable: state.hideUnroutable },
				stats: { sweeps: diag.sweeps, inserts: diag.inserts, toggles: diag.toggles },
			};
			for (var k in extra || {}) payload[k] = extra[k];
			try {
				fetch("/dsh-tweaks/diag", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					keepalive: true,
				}).catch(function () {});
			} catch (e) {}
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

		function TweakRow(props) {
			var row = props.row;
			var hint = [row.why, row.error ? "错误：" + row.error : row.note].filter(Boolean).join("\n");
			return React.createElement("label", { className: "dtw-pageitem", title: hint || undefined },
				React.createElement("input", {
					type: "checkbox",
					className: "dtw-pagecheck",
					checked: row.enabled === true,
					onChange: function (e) { toggle(row.id, e.target.checked); },
				}),
				React.createElement("span", { className: "dtw-pagelabel" },
					React.createElement("span", { className: "dtw-pagetitle" }, row.title),
					row.why ? React.createElement("span", { className: "dtw-pagewhy" }, row.why) : null,
					row.error
						? React.createElement("span", { className: "dtw-pagenote" }, "错误：" + row.error)
						: (row.note ? React.createElement("span", { className: "dtw-pagenote" }, row.note) : null)));
		}

		function TweaksPage() {
			var s = useTweaks();
			return React.createElement("div", null,
				React.createElement("p", { style: { margin: "0 0 4px", opacity: 0.65, fontSize: 12 } },
					"开关写在 ③ cordis.patch.yml 的 dsh-tweaks 段，随 profile 跨机同步；详情见 GET /dsh-tweaks/status。"),
				s.rows.length
					? s.rows.map(function (row) { return React.createElement(TweakRow, { key: row.id, row: row }); })
					: React.createElement("p", { style: { opacity: 0.6 } }, "状态路由还没有返回开关列表。"));
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
					diag.inserts++;
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
			fetchStatus();
			report({ event: "install" });

			var raf = 0;
			var timer = null;
			var observer = null;

			function schedule() {
				if (raf) return;
				var run = function () {
					raf = 0;
					if (typeof document !== "undefined" && document.hidden) return;
					if (observer) observer.disconnect();
					try {
						diag.sweeps++;
					} finally {
						if (observer) observe();
					}
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
					for (var j = 0; j < rec.addedNodes.length; j++) collect(rec.addedNodes[j]);
					if (rec.addedNodes.length) touched = true;
				}
				if (touched) schedule();
			}

			timer = setInterval(function () {
				if (typeof document !== "undefined" && document.hidden) return;
				fetchStatus();
			}, REFRESH_MS);

			observer = new MutationObserver(onMutations);
			observe();

			return function dispose() {
				if (timer) clearInterval(timer);
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

		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function () {
				return install();
			}, "dsh-tweaks: status polling and styles");
			// 设置 › 插件 › dsh-tweaks 页内的开关列表（keyed by 包名）。
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE_KEY,
				}, TweaksPage);
			});
		}

		exports.STATUS = STATUS;
		exports.TOGGLE = TOGGLE;
		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			readTweaks: readTweaks,
			decorateTapSection: decorateTapSection,
			styleText: styleText,
			HIDE_UNROUTABLE_CSS: HIDE_UNROUTABLE_CSS,
		};
		return module.exports;
	},
});
