// GropWave Webview Chat Script
(function () {
	const vscode = acquireVsCodeApi();

	const sendBtn = document.getElementById("sendBtn");
	const chatInput = document.getElementById("chatInput");
	const chatArea = document.getElementById("chatArea");

	let currentAssistantDiv = null;
	let isProcessing = false;

	if (sendBtn) {
		sendBtn.addEventListener("click", sendPrompt);
	}
	if (chatInput) {
		chatInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendPrompt();
			}
		});
	}

	const modelSelect = document.getElementById("modelSelect");
	if (modelSelect) {
		modelSelect.addEventListener("change", (e) => {
			vscode.postMessage({ type: "selectModel", modelId: e.target.value });
		});
	}

	function sendPrompt() {
		const value = chatInput.value.trim();
		if (!value || isProcessing) return;

		if (value.startsWith("/")) {
			vscode.postMessage({ type: "command", command: value });
		} else {
			vscode.postMessage({ type: "prompt", content: value });
		}
		chatInput.value = "";
	}

	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "models":
				populateModels(msg.models);
				break;
			case "quotaStatus":
				updateQuotaStatus(msg.statuses);
				break;
			case "activeContext":
				updateActiveContext(msg.display);
				break;
			case "response":
				addMessage(msg.message);
				break;
			case "streamChunk":
				appendStreamChunk(msg.content);
				break;
			case "streamDone":
				finalizeStream(msg.message);
				break;
			case "error":
				addMessage({ role: "assistant", content: "\u26a0 Error: " + msg.error, timestamp: Date.now() });
				setProcessing(false);
				break;
		}
	});

	function populateModels(models) {
		const select = document.getElementById("modelSelect");
		if (!select) return;
		select.innerHTML = '<option value="auto">Auto (Smart Routing)</option>';
		const tiers = { fast: [], balanced: [], heavy: [] };
		models.filter((m) => !m.disabled).forEach((m) => {
			if (tiers[m.tier]) tiers[m.tier].push(m);
		});
		for (const [tier, list] of Object.entries(tiers)) {
			if (list.length === 0) continue;
			const group = document.createElement("optgroup");
			group.label = tier.charAt(0).toUpperCase() + tier.slice(1);
			list.forEach((m) => {
				const opt = document.createElement("option");
				opt.value = m.id;
				opt.textContent = m.id;
				group.appendChild(opt);
			});
			select.appendChild(group);
		}
	}

	function updateQuotaStatus(statuses) {
		const el = document.getElementById("quotaStatus");
		const select = document.getElementById("modelSelect");
		if (!el || !select) return;
		const selected = select.value;

		if (selected === "auto") {
			el.textContent = "Auto";
			el.className = "quota-badge";
			return;
		}

		let status = null;
		for (const [id, s] of statuses) {
			if (id === selected) { status = s; break; }
		}
		if (!status) {
			el.textContent = "\u2014";
			el.className = "quota-badge";
			return;
		}
		if (status.health === "exhausted") {
			el.textContent = "Quota Exceeded";
			el.className = "quota-badge exhausted";
		} else if (status.health === "warning") {
			el.textContent = status.mostConstrained.key.toUpperCase() + " near limit";
			el.className = "quota-badge warning";
		} else {
			el.textContent = "Healthy";
			el.className = "quota-badge";
		}
	}

	function updateActiveContext(display) {
		const el = document.getElementById("activeContextDisplay");
		const bar = document.getElementById("activeBar");
		if (!el || !bar) return;
		if (!display) {
			el.textContent = "No file open";
			bar.style.display = "none";
		} else {
			el.textContent = "\u{1F4DD} " + display;
			bar.style.display = "flex";
		}
	}

	function addMessage(msg) {
		removePlaceholder();
		const div = document.createElement("div");
		div.className = "message " + msg.role;
		const label = msg.role === "user" ? "You" : "AI";
		let html = '<div class="label">' + label + '</div>';
		html += '<div class="content">' + renderMarkdown(msg.content) + '</div>';
		if (msg.modelId) {
			html += '<div class="model-tag">via ' + msg.modelId + '</div>';
		}
		div.innerHTML = html;
		chatArea.appendChild(div);
		scrollToBottom();
	}

	function restoreHistory(messages) {
		removePlaceholder();
		for (const msg of messages) {
			const div = document.createElement("div");
			div.className = "message " + msg.role;
			const label = msg.role === "user" ? "You" : "AI";
			div.innerHTML = '<div class="label">' + label + '</div>' +
				'<div class="content">' + renderMarkdown(msg.content) + '</div>';
			chatArea.appendChild(div);
		}
		scrollToBottom();
	}

	function appendStreamChunk(chunk) {
		if (!currentAssistantDiv) {
			removePlaceholder();
			currentAssistantDiv = document.createElement("div");
			currentAssistantDiv.className = "message assistant";
			currentAssistantDiv.innerHTML =
				'<div class="label">AI</div><div class="content"></div>';
			chatArea.appendChild(currentAssistantDiv);
		}
		const contentEl = currentAssistantDiv.querySelector(".content");
		contentEl.textContent += chunk;
		scrollToBottom();
	}

	function finalizeStream(msg) {
		if (currentAssistantDiv) {
			const contentEl = currentAssistantDiv.querySelector(".content");
			contentEl.innerHTML = renderMarkdown(msg.content);
			if (msg.modelId) {
				const tag = document.createElement("div");
				tag.className = "model-tag";
				tag.textContent = "via " + msg.modelId;
				currentAssistantDiv.appendChild(tag);
			}
			currentAssistantDiv = null;
		}
		setProcessing(false);
	}

	function setProcessing(processing) {
		isProcessing = processing;
		if (sendBtn) sendBtn.disabled = processing;
		if (chatInput) chatInput.disabled = processing;
	}

	function removePlaceholder() {
		const ph = chatArea.querySelector(".placeholder");
		if (ph) ph.remove();
	}

	function scrollToBottom() {
		chatArea.scrollTop = chatArea.scrollHeight;
	}

	// ─── Markdown renderer ────────────────────────────────────────────

	function renderMarkdown(text) {
		const BT = String.fromCharCode(96); // backtick
		let html = text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");

		// Code blocks
		const codeBlockRe = new RegExp(BT + BT + BT + '(\\w*)\\n([\\s\\S]*?)' + BT + BT + BT, 'g');
		html = html.replace(codeBlockRe, '<pre><code class="lang-$1">$2</code></pre>');

		// Inline code
		const inlineCodeRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
		html = html.replace(inlineCodeRe, "<code>$1</code>");

		// Images
		html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;border-radius:4px;" />');

		// Links
		html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

		// Headers
		html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
		html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
		html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

		// Bold + Italic
		html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
		// Bold
		html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		// Italic
		html = html.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<em>$1</em>");
		html = html.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<em>$1</em>");

		// Blockquotes
		html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

		// Horizontal rule
		html = html.replace(/^(?:---|\*\*\*)$/gm, "<hr/>");

		// Ordered lists: mark with placeholder to distinguish from unordered
		html = html.replace(/^(\d+)\. (.+)$/gm, "\u0000<li>$2</li>\u0001");

		// Unordered lists
		html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
		html = html.replace(/((?:<li>.*<\/li><br\/>?)+)/g, (match) => {
			const items = match.replace(/<br\/?>/g, "");
			return "<ul>" + items + "</ul>";
		});

		// Ordered lists: wrap in <ol>
		html = html.replace(/((?:\u0000<li>.*<\/li>\u0001<br\/>?)+)/g, (match) => {
			const items = match.replace(/<br\/?>/g, "").replace(/\u0000/g, "").replace(/\u0001/g, "");
			return "<ol>" + items + "</ol>";
		});

		// Tables
		html = html.replace(/^\|(.+)\|$/gm, (line) => {
			const cells = line.slice(1, -1).split("|").map((c) => c.trim());
			if (cells.every((c) => /^[-:]+$/.test(c))) return "";
			return "<tr>" + cells.map((c) => "<td>" + c + "</td>").join("") + "</tr>";
		});
		html = html.replace(/((?:<tr>.*<\/tr><br\/>?)+)/g, (match) => {
			const rows = match.replace(/<br\/?>/g, "");
			return "<table>" + rows + "</table>";
		});

		// Line breaks
		html = html.replace(/\n/g, "<br/>");

		// Clean up extra <br/> after block elements
		html = html.replace(/(<\/(?:h[2-4]|ul|ol|pre|blockquote|table|hr)>)<br\/?>/g, "$1");

		return html;
	}
})();
