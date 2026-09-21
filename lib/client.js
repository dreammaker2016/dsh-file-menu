window.__ModuleLoader__.load({
	id: "dsh-file-menu",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * dsh-file-menu 客户端半端：对话/文件区域的右键菜单。
		 *
		 * 设计要点（都是踩过的坑）：
		 *  1. 菜单项激活走 window 捕获阶段的 pointerdown + 坐标命中，不依赖 click 冒泡——
		 *     上游任何在捕获阶段 stopPropagation 的手柄都拦不住早期监听。
		 *     激活后吞掉随之而来的 mouseup/click，避免误触下层界面。
		 *  2. 某些元素在 mousedown 里 preventDefault 会让 Chromium 不派发 contextmenu，
		 *     因此用 pointerdown/pointerup 记录右键手势，180ms 内没等到 contextmenu 就自己弹。
		 *  3. 复制优先走宿主 /file-menu/clipboard（Electron 主进程剪贴板 / PowerShell），
		 *     不受渲染进程剪贴板权限与焦点限制。
		 *  4. 关键行为（右键目标、识别路径、菜单矩形、顶层元素、点击项、异常）都回报宿主，
		 *     通过 GET /file-menu/status 就能远程诊断。
		 *  5. DSH 对**工作区内**的文件引用显示的是相对路径（`dsh-plugins/x/README.md`），
		 *     工具行的 fileLink 按钮更是既无 title 也无 data-path，路径只在文本里。
		 *     因此不能只认绝对路径：候选串原样上报，工作区根从客户端 `sessions` 服务取
		 *     （`list.getSnapshot()` 的 `current` → `byId[id].cwd`），由宿主端统一解析。
		 */
		var MENU_ID = "dsh-file-menu-root";
		var TOAST_ID = "dsh-file-menu-toast";
		var STYLE_ID = "dsh-file-menu-style";
		var ITEM_CLASS = "dsh-fm-item";
		/** 客户端 ctx：只用于可选地读取 `sessions`（拿当前会话工作区根），拿不到不影响其它功能。 */
		var pluginCtx = null;
		/** 监听表与代际号都放在 window 上：HMR 重新实例化后仍能拆掉上一代监听。 */
		var LISTENERS_KEY = "__dshFileMenuListeners";
		var GENERATION_KEY = "__dshFileMenuGeneration";
		var GENERATION = 0;
		/** 只有最新一代实例的监听器才生效（老实例残留的监听器自我禁用）。 */
		function activeGeneration() {
			try {
				return GENERATION !== 0 && window[GENERATION_KEY] === GENERATION;
			} catch (error) {
				return true;
			}
		}
		/** 客户端半端版本；加载成功会 POST /file-menu/hello 上报。 */
		var CLIENT_VERSION = "0.8.0";
		var FONT =
			'13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
		var CSS = [
			"#" + MENU_ID + "{position:fixed;z-index:2147483000;min-width:200px;max-width:340px;padding:4px;",
			"border:1px solid var(--dsw-alias-border-l2,#3a3a3d);border-radius:10px;",
			"background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#26262a));",
			"box-shadow:0 10px 30px rgba(0,0,0,.38);font:" + FONT + ";",
			"color:var(--dsw-alias-label-primary,#e8e8ea);user-select:none}",
			"#" + MENU_ID + " ." + ITEM_CLASS + "{display:flex;align-items:center;gap:12px;width:100%;padding:7px 10px;",
			"border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
			"#" + MENU_ID + " ." + ITEM_CLASS + ":hover,#" + MENU_ID + " ." + ITEM_CLASS + ":focus-visible{",
			"background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));outline:none}",
			"#" + MENU_ID + " .dsh-fm-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			"#" + MENU_ID + " .dsh-fm-hint{flex:none;color:var(--dsw-alias-label-tertiary,#8b8b93);font-size:11px}",
			"#" + MENU_ID + " .dsh-fm-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,rgba(255,255,255,.09))}",
			"#" + TOAST_ID + "{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;",
			"padding:8px 14px;border-radius:9px;background:var(--dsw-alias-bg-layer-3,#333);",
			"color:var(--dsw-alias-label-primary,#eee);font:" + FONT + ";box-shadow:0 8px 24px rgba(0,0,0,.4);",
			"opacity:0;transition:opacity .18s ease;pointer-events:none;max-width:70vw}",
			"#" + TOAST_ID + ".dsh-fm-show{opacity:1}",
			"#" + TOAST_ID + ".dsh-fm-error{background:#7f1d1d;color:#fff}",
		].join("");

		var installed = false;
		var toastTimer = null;
		var rightGesture = null;
		/** 当前菜单项（激活时按 data-index 取回）。 */
		var menuItems = [];
		/** 菜单矩形与抑制窗口：激活后吞掉随之而来的 mouseup/click。 */
		var menuRect = null;
		var suppressUntil = 0;
		var suppressRect = null;

		/** 注入样式表（只注入一次）。 */
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.dataset.plugin = "dsh-file-menu";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/** 底部提示条。 */
		function toast(message, isError) {
			try {
				var node = document.getElementById(TOAST_ID);
				if (node === null) {
					node = document.createElement("div");
					node.id = TOAST_ID;
					document.body.appendChild(node);
				}
				node.textContent = message;
				node.className = "dsh-fm-show" + (isError === true ? " dsh-fm-error" : "");
				if (toastTimer !== null) clearTimeout(toastTimer);
				toastTimer = setTimeout(
					function () {
						node.className = "";
						toastTimer = null;
					},
					isError === true ? 3600 : 1800,
				);
			} catch (error) {
				console.warn("[dsh-file-menu] toast failed:", error);
			}
		}

		/** POST JSON 并归一化结果。 */
		function postJson(url, payload) {
			return fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			}).then(
				function (response) {
					return response
						.json()
						.catch(function () {
							return {};
						})
						.then(function (body) {
							return {
								status: response.status,
								ok: response.ok && body !== null && body.ok !== false,
								error: body === null ? undefined : body.error,
							};
						});
				},
				function (error) {
					return { status: 0, ok: false, error: error.message };
				},
			);
		}

		/** 行为上报：宿主 GET /file-menu/status 可读（无浏览器控制台时的诊断通道）。 */
		function report(record) {
			try {
				postJson("/file-menu/diag", record);
			} catch (error) {
				/* 上报失败不影响功能 */
			}
		}

		/** 关闭菜单（清掉所有同 ID 节点，避免重复注册留下的孤儿菜单）。 */
		function closeMenu() {
			var nodes = document.querySelectorAll("#" + MENU_ID);
			for (var index = 0; index < nodes.length; index += 1) {
				var node = nodes[index];
				if (node.parentNode !== null) node.parentNode.removeChild(node);
			}
			menuItems = [];
			menuRect = null;
		}

		/** 执行一个菜单项。 */
		function activateItem(item) {
			if (item === undefined || item === null) return;
			report({ phase: "activate", label: item.label, hasRun: typeof item.run === "function" });
			closeMenu();
			try {
				item.run();
				report({ phase: "ran", label: item.label });
			} catch (error) {
				report({
					phase: "run-error",
					label: item.label,
					error: String(
						error !== null && error !== undefined && (error.stack || error.message)
							? error.stack || error.message
							: error,
					),
				});
				console.warn("[dsh-file-menu] action failed:", error);
				toast("操作失败：" + (error !== null && error !== undefined ? error.message : "未知错误"), true);
			}
		}

		/** 本地复制：execCommand 优先，再退回 Clipboard API。 */
		function localCopy(value) {
			var ok = false;
			try {
				var area = document.createElement("textarea");
				area.value = value;
				area.setAttribute("readonly", "readonly");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.focus();
				area.select();
				ok = document.execCommand("copy");
				if (area.parentNode !== null) area.parentNode.removeChild(area);
			} catch (error) {
				ok = false;
			}
			if (ok) {
				toast("已复制");
				return;
			}
			try {
				if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(value).then(
						function () {
							toast("已复制");
						},
						function () {
							toast("复制失败：剪贴板被拒绝", true);
							report({ phase: "copy-local-denied" });
						},
					);
					return;
				}
			} catch (error) {
				/* 落到失败提示 */
			}
			toast("复制失败：剪贴板不可用", true);
			report({ phase: "copy-local-unavailable" });
		}

		/** 复制文本：先请宿主写系统剪贴板，失败再退回本地复制。 */
		function copyText(text) {
			// 入口即上报：区分「函数没被调用」与「被调用但文本为空」。
			report({ phase: "copy-call", type: typeof text, length: typeof text === "string" ? text.length : -1 });
			var value = String(text == null ? "" : text);
			if (value === "") {
				toast("没有可复制的内容", true);
				return;
			}
			report({ phase: "copy-request", length: value.length });
			postJson("/file-menu/clipboard", { text: value }).then(function (result) {
				if (result.ok) {
					toast("已复制");
					return;
				}
				report({ phase: "copy-host-failed", error: result.error, status: result.status });
				localCopy(value);
			});
		}

		/** 判断字符串是否是绝对路径（Windows 盘符/UNC 或 POSIX）。 */
		function looksAbsolutePath(value) {
			if (typeof value !== "string") return false;
			var text = value.trim();
			if (text === "" || text.length > 512 || text.indexOf("\n") !== -1) return false;
			if (/^[A-Za-z]:[\\/]/.test(text)) return true;
			if (/^\\\\[^\\]/.test(text)) return true;
			if (text.charAt(0) === "/" && text.charAt(1) !== "/") return true;
			return false;
		}

		/**
		 * 清洗一个候选路径串，返回可用的候选（绝对 / `~` 家目录 / 相对），不可用返回空串。
		 * @param value 原始串（属性值或元素文本）。
		 * @param fromText 是否来自元素文本：来自文本时判据更严，避免把整句话或
		 *   「复制/粘贴」这种带斜杠的词当成路径（要求末段带扩展名）。
		 */
		function pathCandidate(value, fromText) {
			if (typeof value !== "string") return "";
			var text = value.trim();
			if (text === "" || text.length > 512 || /[\r\n]/.test(text)) return "";
			// 剥掉 markdown 反引号与成对引号，以及 @ 引用芯片前缀。
			text = text.replace(/^[`'"“”]+/, "").replace(/[`'"“”]+$/, "").trim();
			if (text.charAt(0) === "@") text = text.slice(1).trim();
			if (text === "" || text.length > 512) return "";
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return "";
			if (looksAbsolutePath(text)) return text;
			if (text === "~" || /^~[\\/]/.test(text)) return text;
			// 相对路径：必须带分隔符、不带空白、不带中文标点，且不是裸斜杠开头。
			if (/\s/.test(text)) return "";
			if (/[，。；：！？、（）【】《》“”]/.test(text)) return "";
			if (text.indexOf("/") === -1 && text.indexOf("\\") === -1) return "";
			if (/^[\\/]/.test(text)) return "";
			if (fromText === true && !/\.[A-Za-z0-9]{1,10}$/.test(text)) return "";
			return text;
		}

		/**
		 * 从点击目标向上找文件路径：data-* / title / aria-label / dataset / 文本。
		 * 返回的是**候选**串：可能是绝对路径，也可能是相对工作区的路径（DSH 对工作区内
		 * 文件就是这么显示的），解析交给 displayPathOf / 宿主端。
		 */
		function pathFromTarget(target) {
			var node = target;
			var depth = 0;
			while (node !== null && node !== undefined && node.nodeType === 1 && depth < 24) {
				depth += 1;
				var attrs = ["data-path", "data-file-path", "data-filepath", "data-file", "title", "aria-label"];
				for (var index = 0; index < attrs.length; index += 1) {
					if (node.getAttribute === undefined) break;
					var found = pathCandidate(node.getAttribute(attrs[index]), false);
					if (found !== "") return found;
				}
				if (node.dataset !== undefined && node.dataset !== null) {
					for (var key in node.dataset) {
						if (Object.prototype.hasOwnProperty.call(node.dataset, key) && /path/i.test(key)) {
							var fromData = pathCandidate(node.dataset[key], false);
							if (fromData !== "") return fromData;
						}
					}
				}
				var tag = node.tagName;
				if (tag === "CODE" || tag === "SPAN" || tag === "A" || tag === "BUTTON") {
					var fromText = pathCandidate(String(node.textContent == null ? "" : node.textContent), true);
					if (fromText !== "") return fromText;
				}
				node = node.parentElement;
			}
			return "";
		}

		/**
		 * 当前会话的工作区根目录（绝对路径）。取自客户端 `sessions` 服务的列表快照：
		 * `list.getSnapshot().current` → `byId[id].cwd`。拿不到就返回空串（相对路径
		 * 会因此不显示文件操作，但绝不误报）。
		 */
		function workspaceBase() {
			try {
				if (pluginCtx === null || typeof pluginCtx.get !== "function") return "";
				var sessions = pluginCtx.get("sessions");
				if (sessions === undefined || sessions === null) return "";
				var list = sessions.list;
				if (list === undefined || list === null || typeof list.getSnapshot !== "function") return "";
				var snapshot = list.getSnapshot();
				if (snapshot === undefined || snapshot === null) return "";
				var id = snapshot.current;
				var byId = snapshot.byId;
				if (id === undefined || byId === undefined || byId === null) return "";
				var record = byId[id];
				if (record === undefined || record === null) return "";
				return typeof record.cwd === "string" ? record.cwd : "";
			} catch (error) {
				return "";
			}
		}

		/** 把相对候选拼到工作区根后面（只用于展示与复制；宿主端会再权威解析一次）。 */
		function joinPath(base, relative) {
			if (base === "" || relative === "") return relative;
			var separator = base.indexOf("\\") !== -1 ? "\\" : "/";
			var rest = relative.replace(/^\.?[\\/]+/, "");
			// 统一分隔符，避免拼出 `D:\a\b/c/d` 这种混合串。
			rest = separator === "\\" ? rest.replace(/\//g, "\\") : rest.replace(/\\/g, "/");
			return base.replace(/[\\/]+$/, "") + separator + rest;
		}

		/** 候选串 → 可展示/可复制的路径；解析不出来返回空串（此时不显示文件操作行）。 */
		function displayPathOf(raw, base) {
			if (raw === "") return "";
			if (looksAbsolutePath(raw)) return raw;
			if (raw === "~" || /^~[\\/]/.test(raw)) return raw;
			if (base === "") return "";
			return joinPath(base, raw);
		}

		/** 生成元素诊断串。 */
		function describeTarget(target) {
			try {
				var node = target;
				if (node !== null && node.nodeType === 3) node = node.parentElement;
				if (node === null || node === undefined) return "no target";
				if (node.getAttribute === undefined) return String(node.nodeName);
				var parts = [String(node.tagName)];
				if (typeof node.className === "string" && node.className !== "") {
					parts.push("." + node.className.split(/\s+/).slice(0, 3).join("."));
				}
				var title = node.getAttribute("title");
				if (title !== null && title !== "") parts.push('title="' + title.slice(0, 140) + '"');
				var dataPath = node.getAttribute("data-path");
				if (dataPath !== null) parts.push('data-path="' + dataPath.slice(0, 140) + '"');
				var detected = pathFromTarget(target);
				parts.push("path=" + (detected === "" ? "(none)" : detected));
				return parts.join(" ");
			} catch (error) {
				return "describe failed: " + error.message;
			}
		}

		/** 找到最近的可编辑元素。 */
		function editableOf(target) {
			var node = target;
			var depth = 0;
			while (node !== null && node !== undefined && node.nodeType === 1 && depth < 10) {
				depth += 1;
				var tag = node.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA") {
					var type = String(node.getAttribute("type") || "text").toLowerCase();
					if (type !== "checkbox" && type !== "radio" && type !== "button") return node;
				}
				if (node.isContentEditable === true) return node;
				node = node.parentElement;
			}
			return null;
		}

		/** 找到最近的链接地址。 */
		function linkOf(target) {
			var node = target;
			var depth = 0;
			while (node !== null && node !== undefined && node.nodeType === 1 && depth < 10) {
				depth += 1;
				if (node.tagName === "A") {
					var href = node.getAttribute("href");
					if (typeof href === "string" && href.trim() !== "") {
						try {
							return new URL(href, window.location.href).href;
						} catch (error) {
							return href;
						}
					}
				}
				node = node.parentElement;
			}
			return null;
		}

		/** 取点击位置所在段落的文本，供「复制此段文字」使用。 */
		function textBlockOf(target) {
			var node = target;
			if (node !== null && node.nodeType === 3) node = node.parentElement;
			if (node === null || node === undefined) return "";
			var block =
				typeof node.closest === "function"
					? node.closest("p,li,pre,blockquote,td,th,h1,h2,h3,h4,h5,h6,code,div")
					: null;
			if (block === null) block = node;
			var text = String(block.innerText == null ? block.textContent : block.innerText).trim();
			if (text === "") return "";
			return text.length > 20000 ? text.slice(0, 20000) : text;
		}

		/** 把剪贴板文本插入可编辑元素。 */
		function pasteInto(editable) {
			var insert = function (text) {
				try {
					if (editable.tagName === "INPUT" || editable.tagName === "TEXTAREA") {
						var start = editable.selectionStart == null ? editable.value.length : editable.selectionStart;
						var end = editable.selectionEnd == null ? editable.value.length : editable.selectionEnd;
						if (typeof editable.setRangeText === "function") editable.setRangeText(text, start, end, "end");
						else editable.value = editable.value.slice(0, start) + text + editable.value.slice(end);
						editable.dispatchEvent(new Event("input", { bubbles: true }));
					} else {
						editable.focus();
						document.execCommand("insertText", false, text);
					}
					toast("已粘贴");
				} catch (error) {
					toast("粘贴失败：" + error.message, true);
				}
			};
			try {
				if (navigator.clipboard !== undefined && typeof navigator.clipboard.readText === "function") {
					navigator.clipboard.readText().then(insert, function () {
						toast("无法读取剪贴板，请用 Ctrl+V", true);
					});
					return;
				}
			} catch (error) {
				/* 落到提示 */
			}
			toast("无法读取剪贴板，请用 Ctrl+V", true);
		}

		/** 取父目录（用于退回系统路由时打开所在文件夹）。 */
		function parentDirectory(path) {
			var text = String(path).replace(/[\\/]+$/, "");
			var index = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
			return index > 0 ? text.slice(0, index) : text;
		}

		/**
		 * 调用宿主半端的原生文件操作（失败时退回系统 open-in-app 路由）。
		 * 能拼出绝对路径就发绝对路径（旧宿主只认绝对路径，这样客户端单独更新即可生效）；
		 * 同时附上工作区根，让宿主端也能对相对路径做权威解析。
		 */
		function callFileAction(action, raw, base) {
			var resolved = displayPathOf(raw, base);
			var sendPath = resolved === "" ? raw : resolved;
			report({ phase: "file-action", action: action, path: sendPath, base: base });
			postJson("/file-menu/" + action, { path: sendPath, base: base }).then(function (result) {
				if (result.ok) {
					toast(action === "reveal" ? "已在文件管理器中定位" : "已用默认应用打开");
					return;
				}
				if (action === "reveal" && result.status === 404) {
					postJson("/open-in-app/open", { app: "explorer", path: parentDirectory(sendPath) }).then(function (fallback) {
						if (fallback.ok) toast("已打开所在文件夹");
						else toast("操作失败：" + (fallback.error || "未知错误"), true);
					});
					return;
				}
				toast("操作失败：" + (result.error || "未知错误"), true);
			});
		}

		/** 按当前上下文生成菜单项。 */
		function buildItems(target, event) {
			var items = [];
			var editable = editableOf(target);
			var link = linkOf(target);
			var rawPath = pathFromTarget(target);
			/** 当前会话工作区根；相对路径靠它解析，拿不到时只对绝对路径显示文件操作。 */
			var base = workspaceBase();
			var selection = "";
			try {
				selection = String(window.getSelection === undefined ? "" : window.getSelection().toString()).trim();
			} catch (error) {
				selection = "";
			}

			if (editable !== null) {
				if (selection !== "") {
					items.push({
						label: "复制",
						hint: "Ctrl+C",
						run: function () {
							copyText(selection);
						},
					});
				}
				items.push({
					label: "剪切",
					hint: "Ctrl+X",
					run: function () {
						try {
							document.execCommand("cut");
						} catch (error) {
							toast("剪切失败", true);
						}
					},
				});
				items.push({
					label: "粘贴",
					hint: "Ctrl+V",
					run: function () {
						pasteInto(editable);
					},
				});
				items.push({
					label: "全选",
					hint: "Ctrl+A",
					run: function () {
						try {
							if (typeof editable.select === "function") editable.select();
							else document.execCommand("selectAll");
						} catch (error) {
							toast("全选失败", true);
						}
					},
				});
			} else if (selection !== "") {
				items.push({
					label: "复制",
					hint: "Ctrl+C",
					run: function () {
						copyText(selection);
					},
				});
			}

			if (rawPath === "" && looksAbsolutePath(selection)) rawPath = selection;
			/** 可展示/可复制的路径（相对候选 + 工作区根）。空串表示解析不出来，不显示文件操作。 */
			var path = displayPathOf(rawPath, base);

			if (path !== "") {
				if (items.length > 0) items.push({ separator: true });
				items.push({
					label: "复制路径",
					run: function () {
						copyText(path);
					},
				});
				items.push({
					label: "打开文件位置",
					run: function () {
						callFileAction("reveal", rawPath, base);
					},
				});
				items.push({
					label: "用默认应用打开",
					run: function () {
						callFileAction("open", rawPath, base);
					},
				});
			}

			if (link !== null) {
				if (items.length > 0) items.push({ separator: true });
				items.push({
					label: "复制链接地址",
					run: function () {
						copyText(link);
					},
				});
				items.push({
					label: "在浏览器中打开",
					run: function () {
						try {
							window.open(link, "_blank", "noopener,noreferrer");
						} catch (error) {
							toast("打开链接失败", true);
						}
					},
				});
			}

			if (items.length === 0 && selection === "") {
				var blockText = textBlockOf(target);
				if (blockText !== "") {
					items.push({
						label: "复制此段文字",
						run: function () {
							copyText(blockText);
						},
					});
				}
			}

			if (event !== undefined && event !== null && event.altKey === true) {
				var described = describeTarget(target);
				if (items.length > 0) items.push({ separator: true });
				items.push({
					label: "诊断：复制元素信息",
					run: function () {
						copyText(described);
					},
				});
			}

			return items;
		}

		/** 渲染并定位菜单。 */
		function showMenu(items, x, y) {
			closeMenu();
			var root = document.createElement("div");
			root.id = MENU_ID;
			root.setAttribute("role", "menu");
			menuItems = items;
			for (var index = 0; index < items.length; index += 1) {
				var item = items[index];
				if (item.separator === true) {
					var separator = document.createElement("div");
					separator.className = "dsh-fm-sep";
					root.appendChild(separator);
					continue;
				}
				var button = document.createElement("button");
				button.type = "button";
				button.className = ITEM_CLASS;
				button.setAttribute("role", "menuitem");
				button.setAttribute("data-index", String(index));
				var label = document.createElement("span");
				label.className = "dsh-fm-label";
				label.textContent = item.label;
				button.appendChild(label);
				if (item.hint !== undefined) {
					var hint = document.createElement("span");
					hint.className = "dsh-fm-hint";
					hint.textContent = item.hint;
					button.appendChild(hint);
				}
				// click 只作为兜底：正常路径由 window 捕获阶段的 pointerdown 激活。
				(function (menuItem) {
					button.addEventListener("click", function (clickEvent) {
						clickEvent.preventDefault();
						clickEvent.stopPropagation();
						activateItem(menuItem);
					});
				})(item);
				root.appendChild(button);
			}
			if (root.childNodes.length === 0) return;
			document.body.appendChild(root);
			var rect = root.getBoundingClientRect();
			var left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
			var top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
			root.style.left = left + "px";
			root.style.top = top + "px";
			menuRect = root.getBoundingClientRect();
			// 不调用 focus()：抢焦点会触发应用侧的 blur 逻辑，也可能让选区消失。
			// 可见性探针：菜单中心点上真正最顶层的元素是谁（判断菜单是否被遮挡/点不到）。
			try {
				var midX = menuRect.left + menuRect.width / 2;
				var midY = menuRect.top + menuRect.height / 2;
				var topEl = document.elementFromPoint(midX, midY);
				report({
					phase: "menu-shown",
					rect: {
						left: Math.round(menuRect.left),
						top: Math.round(menuRect.top),
						width: Math.round(menuRect.width),
						height: Math.round(menuRect.height),
					},
					topAtCenter: topEl === null ? "null" : describeTarget(topEl),
					viewport: [window.innerWidth, window.innerHeight],
				});
			} catch (error) {
				report({ phase: "menu-shown-probe-error", error: String(error && error.message) });
			}
		}

		/** 按目标生成并弹出菜单；返回是否弹出。 */
		function openMenuFor(target, x, y, event) {
			var items = buildItems(target, event);
			if (items.length === 0) return false;
			showMenu(items, x, y);
			try {
				var labels = [];
				for (var index = 0; index < items.length; index += 1) {
					if (items[index].separator !== true) labels.push(items[index].label);
				}
				postJson("/file-menu/menu", { labels: labels, path: pathFromTarget(target) });
			} catch (error) {
				/* 上报失败不影响菜单 */
			}
			return true;
		}

		/** 点是否落在菜单矩形内。 */
		function insideRect(rect, x, y) {
			return rect !== null && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
		}

		/** 捕获阶段的右键处理。 */
		function onContextMenu(event) {
			try {
				if (!activeGeneration()) return;
				if (event.__dshFmSeen === true) return;
				event.__dshFmSeen = true;
				if (rightGesture !== null) rightGesture.handled = true;
				var target = event.target;
				if (target !== null && target.closest !== undefined && target.closest("#" + MENU_ID) !== null) return;
				var selection = "";
				try {
					selection = String(window.getSelection === undefined ? "" : window.getSelection().toString()).trim();
				} catch (error) {
					selection = "";
				}
				var shown = openMenuFor(target, event.clientX, event.clientY, event);
				report({
					phase: "contextmenu",
					source: event.__dshFmWindow === true ? "window" : "document",
					target: describeTarget(target),
					base: workspaceBase(),
					selectionLength: selection.length,
					shown: shown,
				});
				if (shown === true) {
					event.preventDefault();
					event.stopPropagation();
				}
			} catch (error) {
				console.warn("[dsh-file-menu] context menu failed:", error);
				report({ phase: "contextmenu-error", error: String(error && error.message) });
			}
		}

		/** window/document 共用的捕获入口（去重后再处理）。 */
		function onContextMenuWindow(event) {
			event.__dshFmWindow = true;
			onContextMenu(event);
		}

		/** window 捕获阶段的 pointerdown：右键记手势；左键命中菜单项则直接激活。 */
		function onPointerDown(event) {
			try {
				if (!activeGeneration()) return;
				// window 与 document 都挂了同一处理器，用标记保证一次事件只处理一遍。
				if (event.__dshFmPd === true) return;
				event.__dshFmPd = true;
				if (event.button === 0) {
					if (insideRect(menuRect, event.clientX, event.clientY)) {
						// 菜单项激活：不再依赖 click 冒泡，避免被上游捕获手柄吞掉。
						event.preventDefault();
						event.stopPropagation();
						var hit = null;
						try {
							hit = document.elementFromPoint(event.clientX, event.clientY);
						} catch (error) {
							hit = null;
						}
						var itemEl = hit !== null && hit.closest !== undefined ? hit.closest("." + ITEM_CLASS) : null;
						var index = itemEl === null ? -1 : Number(itemEl.getAttribute("data-index"));
						var chosen = index >= 0 ? menuItems[index] : undefined;
						suppressUntil = Date.now() + 600;
						suppressRect = menuRect;
						if (chosen !== undefined && chosen.separator !== true) {
							activateItem(chosen);
						} else {
							report({
								phase: "miss",
								hit: hit === null ? "null" : describeTarget(hit),
								index: index,
								items: menuItems.length,
							});
							closeMenu();
						}
						return;
					}
					if (document.getElementById(MENU_ID) !== null) closeMenu();
					return;
				}
				if (event.button !== 2) return;
				rightGesture = {
					target: event.target,
					x: event.clientX,
					y: event.clientY,
					at: Date.now(),
					handled: false,
				};
			} catch (error) {
				console.warn("[dsh-file-menu] pointerdown failed:", error);
				report({ phase: "pointerdown-error", error: String(error && error.message) });
			}
		}

		/** 右键抬起后若没等到 contextmenu，自己补一个菜单。 */
		function onPointerUp(event) {
			if (!activeGeneration()) return;
			if (event.__dshFmPu === true) return;
			event.__dshFmPu = true;
			if (event.button !== 2 || rightGesture === null) return;
			var gesture = rightGesture;
			setTimeout(function () {
				try {
					if (gesture.handled || Date.now() - gesture.at > 2500) return;
					// 已经有菜单在显示时不要再补一个（否则会叠出孤儿菜单，点击命中错位）。
					if (document.getElementById(MENU_ID) !== null) return;
					var hit = null;
					try {
						hit = document.elementFromPoint(gesture.x, gesture.y);
					} catch (error) {
						hit = null;
					}
					var fallbackTarget = hit === null ? gesture.target : hit;
					var shown = openMenuFor(fallbackTarget, gesture.x, gesture.y, undefined);
					report({
						phase: "fallback",
						target: describeTarget(fallbackTarget),
						shown: shown,
						reason: "no contextmenu event after right-button pointerup",
					});
				} catch (error) {
					console.warn("[dsh-file-menu] fallback menu failed:", error);
				}
			}, 180);
		}

		/** 激活后的抑制窗口：吞掉紧随其后的 mouseup/click，避免误触下层界面。 */
		function swallowAfterActivation(event) {
			if (!activeGeneration()) return;
			if (Date.now() > suppressUntil || !insideRect(suppressRect, event.clientX, event.clientY)) return;
			try {
				event.preventDefault();
				event.stopPropagation();
			} catch (error) {
				/* 忽略 */
			}
		}

		function onKeyDown(event) {
			if (!activeGeneration()) return;
			if (event.key === "Escape") closeMenu();
		}

		/** 只有窗口自身失焦才关闭菜单（元素失焦也会冒泡到 window 捕获）。 */
		function onWindowBlur(event) {
			if (!activeGeneration()) return;
			if (event.target === window) closeMenu();
		}

		/** 安装右键菜单。
		 * HMR 会重新实例化整个模块，因此安装必须跨实例幂等：
		 *  1) 上一代的监听表存在 window 上，这里先按引用移除；
		 *  2) 再递增代际号，任何残留的旧监听器都会因代际不符而自我禁用。
		 * @param ctx 客户端 cordis ctx（可选）。只用来 `ctx.get("sessions")` 取当前会话
		 *   工作区根，供相对路径解析；DSH 的动态插件门面对 `get` 是可选查找，未在 inject
		 *   里声明也能读，读不到只是一条能力降级。
		 */
		function apply(ctx) {
			try {
				if (typeof document === "undefined") return;
				pluginCtx = ctx === undefined ? null : ctx;
				// 自检：把能不能取到当前会话工作区根上报宿主（GET /file-menu/status 可读），
				// 这样「相对路径解析」是否可用无需打开浏览器控制台就能确认。
				report({ phase: "workspace-base", base: workspaceBase() });
				var previousListeners = window[LISTENERS_KEY];
				if (previousListeners !== undefined && previousListeners !== null) {
					for (var index = 0; index < previousListeners.length; index += 1) {
						var entry = previousListeners[index];
						try {
							entry[0].removeEventListener(entry[1], entry[2], entry[3]);
						} catch (error) {
							/* 忽略单个移除失败 */
						}
					}
				}
				window[GENERATION_KEY] = (typeof window[GENERATION_KEY] === "number" ? window[GENERATION_KEY] : 0) + 1;
				GENERATION = window[GENERATION_KEY];
				ensureStyle();
				var listeners = [
					[window, "contextmenu", onContextMenuWindow, true],
					[document, "contextmenu", onContextMenu, true],
					[window, "pointerdown", onPointerDown, true],
					[document, "pointerdown", onPointerDown, true],
					[window, "pointerup", onPointerUp, true],
					[document, "pointerup", onPointerUp, true],
					[window, "mouseup", swallowAfterActivation, true],
					[window, "click", swallowAfterActivation, true],
					[document, "keydown", onKeyDown, true],
					[document, "scroll", closeMenu, true],
					[window, "blur", onWindowBlur, true],
					[window, "resize", closeMenu, true],
				];
				for (var installIndex = 0; installIndex < listeners.length; installIndex += 1) {
					listeners[installIndex][0].addEventListener(
						listeners[installIndex][1],
						listeners[installIndex][2],
						listeners[installIndex][3],
					);
				}
				window[LISTENERS_KEY] = listeners;
				closeMenu();
				postJson("/file-menu/hello", {
					version: CLIENT_VERSION,
					href: String(window.location.href),
					frames: window === window.top ? "top" : "iframe",
					generation: GENERATION,
					replaced: previousListeners === undefined || previousListeners === null ? 0 : previousListeners.length,
				});
			} catch (error) {
				console.warn("[dsh-file-menu] install failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
