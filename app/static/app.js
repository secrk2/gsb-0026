/* ============ 织云系统 前端 ============ */
"use strict";

const state = {
  token: localStorage.getItem("zy_token") || "",
  user: null,
  meta: null,
  businessLines: [],
  users: [],
  filters: { business_line_id: "", owner_id: "", environment: "", status: "", q: "" },
};

/* ---------------- 工具 ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toast(msg, type) {
  const el = document.createElement("div");
  el.className = "toast" + (type ? " " + type : "");
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  return fmtTime(ts).slice(0, 10);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { "X-Token": state.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const message = (data && data.detail) || `请求失败（HTTP ${res.status}）`;
    if (res.status === 401) { logout(false); }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
}

function statusBadge(app) {
  return `<span class="badge ${esc(app.status)}">${esc(app.status_label)}</span>`;
}

function envTag(app) {
  return `<span class="env-tag ${esc(app.environment)}">${esc(app.environment_label)}</span>`;
}

function redDotsHtml(app) {
  if (!app.red_dots || !app.red_dots.length) return "";
  return app.red_dots.map((d) => `<span class="red-dot">${esc(d.label)}</span>`).join(" ");
}

/* ---------------- 登录 ---------------- */
async function showLogin() {
  $("#topnav").hidden = true;
  $("#user-chip").hidden = true;
  $("#view").innerHTML = "";
  const overlay = $("#login-overlay");
  overlay.hidden = false;
  const box = $("#login-users");
  box.innerHTML = `<div class="empty-tip">加载账号中…</div>`;
  try {
    const users = await api("/api/public/users");
    box.innerHTML = users.map((u) => `
      <div class="login-user" data-username="${esc(u.username)}">
        <div class="u-name">${esc(u.name)}</div>
        <div class="u-meta">${esc(u.business_line_name || "平台")}</div>
        <span class="u-role ${u.role === "admin" ? "admin" : ""}">${u.role === "admin" ? "管理员" : "业务成员"}</span>
      </div>`).join("");
    $$(".login-user", box).forEach((el) => {
      el.onclick = () => doLogin(el.dataset.username);
    });
  } catch (e) {
    box.innerHTML = `<div class="empty-tip">账号加载失败：${esc(e.message)}</div>`;
  }
}

async function doLogin(username) {
  try {
    const data = await api("/api/login", { method: "POST", body: { username } });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("zy_token", data.token);
    $("#login-overlay").hidden = true;
    await bootstrap();
    toast(`欢迎，${data.user.name}`, "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

function logout(showTip = true) {
  state.token = "";
  state.user = null;
  localStorage.removeItem("zy_token");
  if (showTip) toast("已退出登录");
  showLogin();
}

/* ---------------- 启动 ---------------- */
async function bootstrap() {
  try {
    if (!state.user) state.user = await api("/api/me");
    [state.meta, state.businessLines, state.users] = await Promise.all([
      api("/api/meta"), api("/api/business-lines"), api("/api/users"),
    ]);
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
    return;
  }
  $("#topnav").hidden = false;
  const chip = $("#user-chip");
  chip.hidden = false;
  chip.innerHTML = `
    <span>${esc(state.user.name)} · ${esc(state.user.business_line_name || "平台")}${state.user.role === "admin" ? "（管理员）" : ""}</span>
    <button class="logout" id="btn-logout">退出</button>`;
  $("#btn-logout").onclick = () => logout();
  route();
}

function route() {
  if (!state.user) return;
  const hash = location.hash || "#/console";
  const parts = hash.replace(/^#\//, "").split("/");
  $$("#topnav a").forEach((a) => a.classList.toggle("active", a.dataset.route === parts[0]));
  if (parts[0] === "apps" && parts[1]) renderAppDetail(parts[1]);
  else if (parts[0] === "apps") renderApps();
  else renderConsole();
}

window.addEventListener("hashchange", () => { if (state.user) route(); });

/* ---------------- 资产控制台 ---------------- */
async function renderConsole() {
  const view = $("#view");
  view.innerHTML = `<div class="empty-tip">加载中…</div>`;
  let data;
  try {
    data = await api("/api/console/summary");
  } catch (e) {
    view.innerHTML = errorStateHtml("加载失败", e.message);
    return;
  }
  const t = data.totals;
  const maxTotal = Math.max(1, ...data.by_business_line.map((b) => b.total));

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>资产控制台</h2>
        <div class="sub">${state.user.role === "admin" ? "全部业务线" : "本业务线"}应用资产概览</div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="panel stat-card"><div class="num">${t.apps}</div><div class="label">应用总数</div></div>
      <div class="panel stat-card"><div class="num">${t.business_lines}</div><div class="label">业务线</div></div>
      <div class="panel stat-card"><div class="num">${t.recent_changed}</div><div class="label">近 7 天有变更</div></div>
      <div class="panel stat-card"><div class="num ${t.red_dot_apps ? "red" : ""}">${t.red_dot_apps}</div><div class="label">红点待处理应用</div></div>
    </div>

    <div class="dash-grid">
      <div class="panel panel-pad">
        <h3>各业务线应用数分布</h3>
        ${data.by_business_line.map((b) => `
          <div class="bl-row">
            <span class="bl-name" title="${esc(b.name)}">${esc(b.name)}</span>
            <div class="bl-bar-track">
              ${["developing", "online", "maintenance", "offline"].map((s) =>
                b[s] ? `<div class="bl-bar-seg ${s}" style="width:${(b[s] / maxTotal) * 100}%" title="${s}: ${b[s]}"></div>` : "").join("")}
            </div>
            <span class="bl-count">${b.total} 个应用</span>
          </div>`).join("")}
        <div class="legend">
          <span><i style="background:#6a9bff"></i>在研</span>
          <span><i style="background:#34c77b"></i>上线</span>
          <span><i style="background:#f0b429"></i>维保</span>
          <span><i style="background:#c3cad6"></i>下线</span>
        </div>
      </div>

      <div class="panel panel-pad">
        <h3>近 7 天有变更的应用</h3>
        <div class="mini-list">
          ${data.recent_changed_apps.length ? data.recent_changed_apps.map((a) => `
            <div class="mini-item" data-app-id="${a.id}">
              <span class="mini-title">${esc(a.name)}</span>
              <span class="badge ${esc(a.status)}">${esc({ developing: "在研", online: "上线", maintenance: "维保", offline: "下线" }[a.status])}</span>
              <span class="mini-meta">${esc(a.business_line_name)} · ${a.change_count} 次变更 · ${fmtAgo(a.last_changed_at)}</span>
            </div>`).join("") : `<div class="empty-tip">近 7 天暂无变更</div>`}
        </div>
      </div>

      <div class="panel panel-pad span-full">
        <h3>红点提醒（环境变量缺失 / 缺失负责人）</h3>
        <div class="red-groups">
          <div>
            <p><span class="red-dot">缺失负责人（${data.red_dots.missing_owner.length}）</span></p>
            <div class="chip-list">
              ${data.red_dots.missing_owner.length
                ? data.red_dots.missing_owner.map((a) => `<span class="app-chip" data-app-id="${a.id}">${esc(a.name)} · ${esc(a.business_line_name)}</span>`).join("")
                : `<span class="empty-tip">无</span>`}
            </div>
          </div>
          <div>
            <p><span class="red-dot">环境变量缺失（${data.red_dots.missing_env.length}）</span></p>
            <div class="chip-list">
              ${data.red_dots.missing_env.length
                ? data.red_dots.missing_env.map((a) => `<span class="app-chip" data-app-id="${a.id}">${esc(a.name)} · ${esc(a.business_line_name)}</span>`).join("")
                : `<span class="empty-tip">无</span>`}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  $$("[data-app-id]", view).forEach((el) => {
    el.onclick = () => { location.hash = `#/apps/${el.dataset.appId}`; };
  });
}

/* ---------------- 应用台账 ---------------- */
async function renderApps() {
  const view = $("#view");
  const f = state.filters;
  const isAdmin = state.user.role === "admin";

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>应用台账</h2>
        <div class="sub">${isAdmin ? "全部业务线" : esc(state.user.business_line_name || "")} · 支持业务线 / 负责人 / 环境 / 状态组合筛选</div>
      </div>
      <button class="btn primary" id="btn-new-app">+ 新建应用</button>
    </div>
    <div class="panel filter-bar">
      <select id="f-bl" ${isAdmin ? "" : "disabled"}>
        <option value="">全部业务线</option>
        ${state.businessLines.map((b) => `<option value="${b.id}" ${String(b.id) === String(f.business_line_id) ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
      </select>
      <select id="f-owner">
        <option value="">全部负责人</option>
        ${state.users.map((u) => `<option value="${u.id}" ${String(u.id) === String(f.owner_id) ? "selected" : ""}>${esc(u.name)}（${esc(u.business_line_name || "平台")}）</option>`).join("")}
      </select>
      <select id="f-env">
        <option value="">全部环境</option>
        ${state.meta.environments.map((e) => `<option value="${e.value}" ${f.environment === e.value ? "selected" : ""}>${esc(e.label)}</option>`).join("")}
      </select>
      <select id="f-status">
        <option value="">全部状态</option>
        ${state.meta.statuses.map((s) => `<option value="${s.value}" ${f.status === s.value ? "selected" : ""}>${esc(s.label)}</option>`).join("")}
      </select>
      <input id="f-q" class="grow" placeholder="搜索应用名…" value="${esc(f.q)}">
      <button class="btn" id="btn-reset">重置</button>
    </div>
    <div id="apps-result"><div class="empty-tip">加载中…</div></div>`;

  $("#btn-new-app").onclick = () => openAppModal();
  $("#btn-reset").onclick = () => {
    state.filters = { business_line_id: "", owner_id: "", environment: "", status: "", q: "" };
    renderApps();
  };
  const reload = () => {
    state.filters = {
      business_line_id: $("#f-bl").value,
      owner_id: $("#f-owner").value,
      environment: $("#f-env").value,
      status: $("#f-status").value,
      q: $("#f-q").value.trim(),
    };
    loadAppList();
  };
  ["#f-bl", "#f-owner", "#f-env", "#f-status"].forEach((sel) => { $(sel).onchange = reload; });
  let timer = null;
  $("#f-q").oninput = () => { clearTimeout(timer); timer = setTimeout(reload, 300); };
  $("#f-q").onkeydown = (e) => { if (e.key === "Enter") reload(); };

  await loadAppList();
}

async function loadAppList() {
  const box = $("#apps-result");
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.business_line_id) p.set("business_line_id", f.business_line_id);
  if (f.owner_id) p.set("owner_id", f.owner_id);
  if (f.environment) p.set("environment", f.environment);
  if (f.status) p.set("status", f.status);
  if (f.q) p.set("q", f.q);
  let apps;
  try {
    apps = await api(`/api/apps?${p.toString()}`);
  } catch (e) {
    box.innerHTML = errorStateHtml(e.status === 403 ? "403 无权访问" : "加载失败", e.message);
    return;
  }
  if (!apps.length) {
    box.innerHTML = `<div class="panel panel-pad empty-tip">没有符合条件的应用</div>`;
    return;
  }

  box.innerHTML = `
    <div class="panel table-wrap">
      <table class="app-table">
        <thead><tr>
          <th>应用</th><th>业务线</th><th>负责人</th><th>集群</th><th>环境</th><th>状态</th><th>风险提示</th><th>更新时间</th>
        </tr></thead>
        <tbody>
          ${apps.map((a) => `
            <tr data-app-id="${a.id}">
              <td class="app-name-cell">${esc(a.name)}<div class="app-desc">${esc(a.description || "")}</div></td>
              <td>${esc(a.business_line_name)}</td>
              <td>${a.owner_name ? esc(a.owner_name) : '<span class="red-dot">未设置</span>'}</td>
              <td>${esc(a.cluster)}</td>
              <td>${envTag(a)}</td>
              <td>${statusBadge(a)}</td>
              <td>${redDotsHtml(a) || '<span style="color:var(--ink-3)">—</span>'}</td>
              <td title="${fmtTime(a.updated_at)}">${fmtAgo(a.updated_at)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="card-list">
      ${apps.map((a) => `
        <div class="panel app-card" data-app-id="${a.id}">
          <div class="card-head">
            <span class="name">${esc(a.name)}</span>
            ${envTag(a)}
            ${statusBadge(a)}
          </div>
          <div class="card-fields">
            <div class="cf"><span class="k">业务线</span>${esc(a.business_line_name)}</div>
            <div class="cf"><span class="k">负责人</span>${a.owner_name ? esc(a.owner_name) : "未设置"}</div>
            <div class="cf"><span class="k">集群</span>${esc(a.cluster)}</div>
            <div class="cf"><span class="k">更新</span>${fmtAgo(a.updated_at)}</div>
          </div>
          ${a.red_dots.length ? `<div class="card-red">${redDotsHtml(a)}</div>` : ""}
        </div>`).join("")}
    </div>`;

  $$("[data-app-id]", box).forEach((el) => {
    el.onclick = () => { location.hash = `#/apps/${el.dataset.appId}`; };
  });
}

/* ---------------- 应用详情 ---------------- */
const STATUS_FLOW = ["developing", "online", "maintenance", "offline"];

async function renderAppDetail(appId) {
  const view = $("#view");
  view.innerHTML = `<div class="empty-tip">加载中…</div>`;
  let app;
  try {
    app = await api(`/api/apps/${appId}`);
  } catch (e) {
    // 越权 / 不存在：明确错误态，而不是空白页
    view.innerHTML = errorStateHtml(
      e.status === 403 ? "403 无权访问" : e.status === 404 ? "404 应用不存在" : "加载失败",
      e.message
    );
    return;
  }
  const isOffline = app.status === "offline";
  const curIdx = STATUS_FLOW.indexOf(app.status);
  const nextStatuses = STATUS_FLOW.slice(curIdx + 1);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${esc(app.name)} ${statusBadge(app)}</h2>
        <div class="sub">${esc(app.business_line_name)} · ${esc(app.cluster)} · ${esc(app.environment_label)}环境</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="btn-back">← 返回台账</button>
        ${isOffline ? "" : '<button class="btn" id="btn-edit">编辑信息</button>'}
      </div>
    </div>

    ${app.red_dots.length ? `<div class="panel panel-pad" style="margin-bottom:16px">
      <span style="margin-right:10px;color:var(--ink-2)">风险提示：</span>${redDotsHtml(app)}
    </div>` : ""}

    <div class="detail-grid">
      <div>
        <div class="panel panel-pad" style="margin-bottom:16px">
          <h3>生命周期</h3>
          <div class="lifecycle">
            ${STATUS_FLOW.map((s, i) => `
              ${i > 0 ? `<div class="lc-line ${i <= curIdx ? "done" : ""}"></div>` : ""}
              <div class="lc-step ${i < curIdx ? "done" : ""} ${i === curIdx ? "current" : ""}">
                <span class="lc-dot">${i + 1}</span>
                <span class="lc-label">${esc(state.meta.statuses[i].label)}</span>
              </div>`).join("")}
          </div>
          ${isOffline
            ? `<p style="color:var(--ink-3);font-size:13px">应用已下线（终态），所有信息只读，不能再变更。</p>`
            : `<div class="status-actions">
                <span style="color:var(--ink-2);font-size:13px;align-self:center">流转到：</span>
                ${nextStatuses.map((s) => {
                  const label = state.meta.statuses.find((x) => x.value === s).label;
                  return `<button class="btn small ${s === "offline" ? "danger" : "primary"}" data-to-status="${s}">${esc(label)}</button>`;
                }).join("")}
              </div>`}
        </div>

        <div class="panel panel-pad" style="margin-bottom:16px">
          <h3>基本信息</h3>
          <div class="kv-grid">
            <div class="kv"><div class="k">应用 ID</div><div class="v">#${app.id}</div></div>
            <div class="kv"><div class="k">所属业务线</div><div class="v">${esc(app.business_line_name)}</div></div>
            <div class="kv"><div class="k">负责人</div><div class="v">${app.owner_name ? esc(app.owner_name) : '<span class="red-dot">缺失负责人</span>'}</div></div>
            <div class="kv"><div class="k">所属集群</div><div class="v">${esc(app.cluster)}</div></div>
            <div class="kv"><div class="k">环境</div><div class="v">${envTag(app)}</div></div>
            <div class="kv"><div class="k">创建时间</div><div class="v">${fmtTime(app.created_at)}</div></div>
            <div class="kv" style="grid-column:1/-1"><div class="k">描述</div><div class="v">${esc(app.description || "—")}</div></div>
          </div>
        </div>

        <div class="panel panel-pad">
          <h3>环境变量 ${app.env_vars.length === 0 ? '<span class="red-dot">环境变量缺失</span>' : `<span style="color:var(--ink-3);font-weight:400;font-size:12px">（${app.env_vars.length} 项）</span>`}</h3>
          <div id="env-editor"></div>
        </div>
      </div>

      <div class="panel panel-pad">
        <h3>变更记录</h3>
        <div class="log-list">
          ${app.change_logs.length ? app.change_logs.map((l) => `
            <div class="log-item">
              <div><b>${esc(l.action)}</b> · ${esc(l.detail)}</div>
              <div class="log-meta">${esc(l.user_name || "系统")} · ${fmtTime(l.created_at)}</div>
            </div>`).join("") : `<div class="empty-tip">暂无变更记录</div>`}
        </div>
      </div>
    </div>`;

  $("#btn-back").onclick = () => { location.hash = "#/apps"; };
  const editBtn = $("#btn-edit");
  if (editBtn) editBtn.onclick = () => openAppModal(app);
  $$("[data-to-status]", view).forEach((btn) => {
    btn.onclick = () => transitionStatus(app.id, btn.dataset.toStatus);
  });
  renderEnvEditor(app);
}

function renderEnvEditor(app) {
  const box = $("#env-editor");
  const readOnly = app.status === "offline";
  const rows = app.env_vars.map((v) => ({ ...v }));
  if (!rows.length) rows.push({ key: "", value: "" });

  box.innerHTML = `
    <table class="env-table">
      <thead><tr><th style="width:38%">KEY</th><th>VALUE</th>${readOnly ? "" : '<th style="width:52px"></th>'}</tr></thead>
      <tbody id="env-tbody"></tbody>
    </table>
    ${readOnly
      ? `<p style="color:var(--ink-3);font-size:13px">应用已下线（终态），环境变量只读。</p>`
      : `<div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn small" id="env-add">+ 添加一行</button>
          <button class="btn primary small" id="env-save">保存环境变量</button>
        </div>`}`;

  const tbody = $("#env-tbody", box);
  function paint() {
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td><input data-i="${i}" data-f="key" placeholder="如 DB_HOST" value="${esc(r.key)}" ${readOnly ? "disabled" : ""}></td>
        <td><input data-i="${i}" data-f="value" placeholder="值" value="${esc(r.value)}" ${readOnly ? "disabled" : ""}></td>
        ${readOnly ? "" : `<td><button class="btn small danger" data-del="${i}">删</button></td>`}
      </tr>`).join("");
    $$("input", tbody).forEach((inp) => {
      inp.oninput = () => { rows[+inp.dataset.i][inp.dataset.f] = inp.value; };
    });
    $$("[data-del]", tbody).forEach((btn) => {
      btn.onclick = () => { rows.splice(+btn.dataset.del, 1); if (!rows.length) rows.push({ key: "", value: "" }); paint(); };
    });
  }
  paint();

  if (!readOnly) {
    $("#env-add", box).onclick = () => { rows.push({ key: "", value: "" }); paint(); };
    $("#env-save", box).onclick = async () => {
      const vars = rows.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value }));
      try {
        await api(`/api/apps/${app.id}/env-vars`, { method: "PUT", body: { vars } });
        toast("环境变量已保存", "success");
        renderAppDetail(app.id);
      } catch (e) { toast(e.message, "error"); }
    };
  }
}

async function transitionStatus(appId, toStatus) {
  const label = state.meta.statuses.find((s) => s.value === toStatus).label;
  if (toStatus === "offline" && !confirm(`确认将应用流转到「${label}」？下线为终态，不可再变更。`)) return;
  try {
    await api(`/api/apps/${appId}/status`, { method: "POST", body: { status: toStatus } });
    toast(`已流转到「${label}」`, "success");
  } catch (e) {
    // 非法状态回退等：展示后端给出的具体原因
    toast(e.message, "error");
  }
  renderAppDetail(appId);
}

/* ---------------- 新建 / 编辑弹窗 ---------------- */
function openAppModal(app) {
  const isEdit = !!app;
  const isAdmin = state.user.role === "admin";
  const root = $("#modal-root");
  const ownerOptions = (blId) => state.users
    .filter((u) => !blId || String(u.business_line_id) === String(blId))
    .map((u) => `<option value="${u.id}" ${app && app.owner_id === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("");

  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3>${isEdit ? `编辑应用 #${app.id}` : "新建应用"}</h3>
        <div class="form-grid">
          <div>
            <label>应用名称 *</label>
            <input id="m-name" maxlength="64" value="${isEdit ? esc(app.name) : ""}" placeholder="同一业务线下不可重名">
          </div>
          <div>
            <label>所属业务线 *</label>
            <select id="m-bl" ${isEdit || !isAdmin ? "disabled" : ""}>
              ${state.businessLines.map((b) => `<option value="${b.id}" ${isEdit && app.business_line_id === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>负责人</label>
            <select id="m-owner"><option value="">（暂不指定）</option>${ownerOptions(isEdit ? app.business_line_id : state.businessLines[0].id)}</select>
          </div>
          <div>
            <label>所属集群 *</label>
            <select id="m-cluster">
              ${state.meta.clusters.map((c) => `<option ${isEdit && app.cluster === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label>环境 *</label>
            <select id="m-env">
              ${state.meta.environments.map((e) => `<option value="${e.value}" ${isEdit && app.environment === e.value ? "selected" : ""}>${esc(e.label)}</option>`).join("")}
            </select>
          </div>
          <div class="full">
            <label>描述</label>
            <textarea id="m-desc" rows="2" placeholder="应用用途简述">${isEdit ? esc(app.description || "") : ""}</textarea>
          </div>
        </div>
        <div class="form-error" id="m-error"></div>
        <div class="form-actions">
          <button class="btn" id="m-cancel">取消</button>
          <button class="btn primary" id="m-submit">${isEdit ? "保存" : "创建"}</button>
        </div>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ""; };
  $("#m-cancel").onclick = close;
  $(".modal-mask", root).onclick = (e) => { if (e.target.classList.contains("modal-mask")) close(); };

  const blSel = $("#m-bl");
  if (!isEdit) {
    blSel.onchange = () => { $("#m-owner").innerHTML = `<option value="">（暂不指定）</option>` + ownerOptions(blSel.value); };
  }

  $("#m-submit").onclick = async () => {
    const errBox = $("#m-error");
    errBox.classList.remove("show");
    const name = $("#m-name").value.trim();
    if (!name) { errBox.textContent = "应用名称不能为空"; errBox.classList.add("show"); return; }
    try {
      if (isEdit) {
        await api(`/api/apps/${app.id}`, {
          method: "PATCH",
          body: {
            name,
            set_owner: true,
            owner_id: $("#m-owner").value ? +$("#m-owner").value : null,
            cluster: $("#m-cluster").value,
            environment: $("#m-env").value,
            description: $("#m-desc").value.trim(),
          },
        });
        toast("应用信息已更新", "success");
        close();
        renderAppDetail(app.id);
      } else {
        await api("/api/apps", {
          method: "POST",
          body: {
            name,
            business_line_id: +blSel.value,
            owner_id: $("#m-owner").value ? +$("#m-owner").value : null,
            cluster: $("#m-cluster").value,
            environment: $("#m-env").value,
            description: $("#m-desc").value.trim(),
          },
        });
        toast(`应用「${name}」创建成功（初始状态：在研）`, "success");
        close();
        renderApps();
      }
    } catch (e) {
      // 重名 409 / 校验失败等：表单内展示原因
      errBox.textContent = e.message;
      errBox.classList.add("show");
    }
  };
}

/* ---------------- 错误态 ---------------- */
function errorStateHtml(title, message) {
  return `
    <div class="panel error-state">
      <div class="code">${esc(title)}</div>
      <div class="msg">${esc(message)}</div>
      <button class="btn" onclick="location.hash='#/apps'">返回应用台账</button>
      <button class="btn" onclick="location.hash='#/console'" style="margin-left:8px">回到控制台</button>
    </div>`;
}

/* ---------------- 入口 ---------------- */
(async function init() {
  if (state.token) {
    try {
      state.user = await api("/api/me");
      await bootstrap();
      return;
    } catch (e) { /* token 失效，走登录 */ }
  }
  showLogin();
})();
