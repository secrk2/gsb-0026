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
  else if (parts[0] === "configs") renderConfigs(parts[1] || "");
  else if (parts[0] === "audit") renderAudit();
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
        <button class="btn" id="btn-config">配置档案</button>
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
  $("#btn-config").onclick = () => { location.hash = `#/configs/${app.id}`; };
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

/* ---------------- 配置档案 ---------------- */
const cfgState = { apps: [], appId: null, env: "prod", data: null, diffL: "dev", diffR: "prod" };

function typeLabel(v) { return (state.meta.config_types.find((t) => t.value === v) || {}).label || v; }
function scopeLabel(v) { return (state.meta.config_scopes.find((t) => t.value === v) || {}).label || v; }

async function cfgLoadApps() {
  cfgState.apps = await api("/api/apps");   // 不缓存：新建应用后立即可见
  return cfgState.apps;
}

async function renderConfigs(appId) {
  const view = $("#view");
  view.innerHTML = `<div class="empty-tip">加载中…</div>`;
  let apps;
  try { apps = await cfgLoadApps(); }
  catch (e) { view.innerHTML = errorStateHtml("加载失败", e.message); return; }
  if (!apps.length) { view.innerHTML = `<div class="panel panel-pad empty-tip">暂无可管理的应用</div>`; return; }

  if (!appId) appId = String(apps[0].id);
  cfgState.appId = apps.some((a) => String(a.id) === String(appId)) ? Number(appId) : apps[0].id;
  const app = apps.find((a) => a.id === cfgState.appId);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>配置档案</h2>
        <div class="sub">按「应用 + 环境」管理配置项 · 密文默认脱敏，查看明文需填写理由并留痕</div>
      </div>
    </div>
    <div class="panel filter-bar">
      <select id="cfg-bl">
        <option value="">全部业务线</option>
        ${state.businessLines.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
      </select>
      <select id="cfg-app" class="grow"></select>
      <button class="btn" id="cfg-goto-detail">查看应用台账</button>
    </div>
    <div id="cfg-body"><div class="empty-tip">加载中…</div></div>`;

  const blSel = $("#cfg-bl");
  const appSel = $("#cfg-app");
  if (state.user.role !== "admin") blSel.disabled = true;
  function fillApps() {
    const bl = blSel.value;
    const list = apps.filter((a) => !bl || String(a.business_line_id) === bl);
    appSel.innerHTML = list.map((a) =>
      `<option value="${a.id}" ${a.id === cfgState.appId ? "selected" : ""}>${esc(a.name)}（${esc(a.business_line_name)}）</option>`).join("");
    if (!list.some((a) => a.id === cfgState.appId) && list.length) cfgState.appId = list[0].id;
  }
  blSel.value = state.user.role === "admin" ? (app.business_line_id || "") : "";
  fillApps();
  blSel.onchange = () => { fillApps(); location.hash = `#/configs/${appSel.value}`; };
  appSel.onchange = () => { location.hash = `#/configs/${appSel.value}`; };
  $("#cfg-goto-detail").onclick = () => { location.hash = `#/apps/${cfgState.appId}`; };

  await cfgRenderBody();
}

async function cfgRenderBody() {
  const box = $("#cfg-body");
  let summary;
  try {
    summary = await api(`/api/apps/${cfgState.appId}/config/envs`);
  } catch (e) {
    box.innerHTML = errorStateHtml(e.status === 403 ? "403 无权访问" : "加载失败", e.message);
    return;
  }
  const envMap = Object.fromEntries(summary.envs.map((e) => [e.environment, e]));
  if (!envMap[cfgState.env]) cfgState.env = "prod";
  box.innerHTML = `
    <div class="panel cfg-envbar">
      <div class="cfg-tabs" id="cfg-tabs">
        ${summary.envs.map((e) => `
          <button class="cfg-tab ${e.environment === cfgState.env ? "active" : ""}" data-env="${e.environment}">
            ${esc(e.environment_label)}
            <span class="cfg-tab-meta">${e.version ? `v${e.version} · ` : "未配置 · "}${e.item_count} 项</span>
          </button>`).join("")}
      </div>
      <div class="cfg-env-actions">
        <button class="btn" id="cfg-diff-btn">环境对比</button>
        <button class="btn" id="cfg-version-btn">版本历史 / 回滚</button>
      </div>
    </div>
    <div id="cfg-items"></div>
    <div id="cfg-diff" style="display:none;margin-top:16px"></div>`;
  $$(".cfg-tab", box).forEach((b) => {
    b.onclick = () => { cfgState.env = b.dataset.env; $("#cfg-diff").style.display = "none"; cfgRenderBody(); };
  });
  $("#cfg-diff-btn").onclick = cfgToggleDiff;
  $("#cfg-version-btn").onclick = cfgOpenVersions;
  await cfgLoadItems();
}

async function cfgLoadItems() {
  const box = $("#cfg-items");
  let d;
  try {
    d = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}`);
  } catch (e) {
    box.innerHTML = `<div class="panel panel-pad" style="margin-top:16px">${errorStateHtml("加载失败", e.message)}</div>`;
    return;
  }
  cfgState.data = d;
  const v = d.current_version;
  box.innerHTML = `
    <div class="panel panel-pad" style="margin-top:14px">
      <div class="cfg-head">
        <h3 style="margin:0">${esc(d.app_name)} · ${esc(d.environment_label)}环境
          <span style="color:var(--ink-3);font-weight:400;font-size:12px">
            ${v ? `当前版本 v${v.version}（${v.change_type === "rollback" ? "回滚自 v" + v.base_version : "常规更新"}）` : "尚未配置"}
          </span>
        </h3>
        ${d.read_only
          ? '<span class="badge offline">应用已下线 · 配置只读</span>'
          : '<button class="btn primary small" id="cfg-edit-btn">编辑配置（生成新版本）</button>'}
      </div>
      ${d.items.length ? `
      <div class="table-wrap" style="margin-top:12px">
        <table class="cfg-table">
          <thead><tr><th>配置键</th><th style="min-width:200px">值</th><th>类型</th><th>生效范围</th><th>密文</th><th>更新时间</th><th style="width:110px">操作</th></tr></thead>
          <tbody>
            ${d.items.map((it) => `
              <tr>
                <td class="mono">${esc(it.key)}</td>
                <td class="mono cfg-val ${it.is_secret ? "secret" : ""}">${it.is_secret ? "••••••••" : esc(it.value)}</td>
                <td>${esc(typeLabel(it.value_type))}</td>
                <td>${esc(scopeLabel(it.scope))}</td>
                <td>${it.is_secret ? '<span class="secret-tag">密文</span>' : "否"}</td>
                <td class="cfg-time">${it.updated_at ? fmtTime(it.updated_at) : "—"}</td>
                <td>${it.is_secret ? `<button class="btn small" data-reveal="${esc(it.key)}">查看明文</button>` : "—"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>` : `<div class="empty-tip">该环境还没有配置项，点击右上角「编辑配置」开始录入</div>`}
    </div>`;
  const editBtn = $("#cfg-edit-btn");
  if (editBtn) editBtn.onclick = () => cfgOpenEditor(d);
  $$("[data-reveal]", box).forEach((btn) => {
    btn.onclick = () => cfgReveal(d, btn.dataset.reveal);
  });
}

/* ---- 明文查看：服务端强制理由 ---- */
function cfgReveal(d, key) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-mask"><div class="modal" style="width:480px">
      <h3>查看密文明文</h3>
      <p class="cfg-reveal-note">配置键 <b class="mono">${esc(key)}</b>（${esc(d.environment_label)}环境）为密文。<br>
        按安全要求，必须填写查看理由，<b>由服务端校验并写入变更留痕</b>。</p>
      <label class="cfg-label">查看理由 *</label>
      <textarea id="rv-reason" rows="3" placeholder="如：生产故障排查 / 值班核对，需说明具体事项"></textarea>
      <div class="form-error" id="rv-error"></div>
      <div id="rv-result" style="display:none;margin-top:14px">
        <label class="cfg-label">明文（仅本次展示，已留痕）</label>
        <div class="cfg-plain mono" id="rv-plain"></div>
      </div>
      <div class="form-actions">
        <button class="btn" id="rv-cancel">关闭</button>
        <button class="btn primary" id="rv-submit">确认查看并留痕</button>
      </div>
    </div></div>`;
  const close = () => { root.innerHTML = ""; };
  $("#rv-cancel").onclick = close;
  $(".modal-mask", root).onclick = (e) => { if (e.target.classList.contains("modal-mask")) close(); };
  $("#rv-submit").onclick = async () => {
    const errBox = $("#rv-error");
    errBox.classList.remove("show");
    const reason = $("#rv-reason").value.trim();
    if (reason.length < 2) {
      errBox.textContent = "请填写不少于 2 个字的查看理由（服务端强制校验）";
      errBox.classList.add("show");
      return;
    }
    try {
      const r = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}/reveal`, {
        method: "POST", body: { key, reason },
      });
      $("#rv-plain").textContent = r.value;
      $("#rv-result").style.display = "block";
      $("#rv-submit").disabled = true;
      $("#rv-reason").disabled = true;
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.add("show");
    }
  };
}

/* ---- 编辑配置（整表保存 -> 新版本） ---- */
function cfgOpenEditor(d) {
  const root = $("#modal-root");
  const rows = d.items.map((it) => ({
    key: it.key,
    value: it.is_secret ? "" : it.value,
    valueType: it.value_type,
    scope: it.scope,
    secret: it.is_secret,
    kept: it.is_secret,   // 已有密文默认"保持不变"
  }));
  if (!rows.length) rows.push({ key: "", value: "", valueType: "string", scope: "global", secret: false, kept: false });

  root.innerHTML = `
    <div class="modal-mask"><div class="modal" style="width:820px">
      <h3>编辑配置 · ${esc(d.app_name)} · ${esc(d.environment_label)}环境</h3>
      <p class="cfg-reveal-note">保存后会生成一个新版本并逐键写入变更留痕；密文请留空保持不变，需修改时先「取明文」或直接填新值。</p>
      <div class="table-wrap">
        <table class="cfg-edit-table">
          <thead><tr><th style="width:22%">键</th><th style="width:30%">值</th><th style="width:13%">类型</th><th style="width:13%">范围</th><th style="width:90px">密文</th><th style="width:50px"></th></tr></thead>
          <tbody id="cfg-edit-tbody"></tbody>
        </table>
      </div>
      <button class="btn small" id="cfg-row-add" style="margin-top:10px">+ 添加一行</button>
      <label class="cfg-label" style="margin-top:12px">变更说明</label>
      <input id="cfg-comment" maxlength="200" placeholder="本次变更说明，会写入留痕（建议填写）">
      <div class="form-error" id="cfg-edit-error"></div>
      <div class="form-actions">
        <button class="btn" id="cfg-edit-cancel">取消</button>
        <button class="btn primary" id="cfg-edit-save">保存为新版本</button>
      </div>
    </div></div>`;

  const tbody = $("#cfg-edit-tbody");
  function paint() {
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td><input data-i="${i}" data-f="key" value="${esc(r.key)}" placeholder="如 DB_HOST"></td>
        <td>
          <input data-i="${i}" data-f="value" value="${esc(r.secret && r.kept ? "" : r.value)}"
            placeholder="${r.secret && r.kept ? "密文未改动，留空保持不变" : "值"}"
            ${r.secret && r.kept ? "" : ""}>
          ${r.secret && r.kept ? `<button type="button" class="btn small cfg-fetch" data-fetch="${i}">取明文</button>` : ""}
        </td>
        <td><select data-i="${i}" data-f="valueType">
          ${state.meta.config_types.map((t) => `<option value="${t.value}" ${r.valueType === t.value ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
        </select></td>
        <td><select data-i="${i}" data-f="scope">
          ${state.meta.config_scopes.map((t) => `<option value="${t.value}" ${r.scope === t.value ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
        </select></td>
        <td style="text-align:center"><input type="checkbox" data-i="${i}" data-f="secret" ${r.secret ? "checked" : ""} style="width:auto"></td>
        <td><button class="btn small danger" data-del="${i}">删</button></td>
      </tr>`).join("");
    $$("input,select", tbody).forEach((el) => {
      el.oninput = el.onchange = () => {
        const i = +el.dataset.i, f = el.dataset.f;
        if (f === "secret") {
          rows[i].secret = el.checked;
          rows[i].kept = false;   // 一旦改动密文标记，即视为要设置新值
          paint(); return;
        }
        rows[i][f] = el.value;
        if (f === "value" && rows[i].kept && el.value) rows[i].kept = false;
      };
    });
    $$("[data-del]", tbody).forEach((b) => {
      b.onclick = () => { rows.splice(+b.dataset.del, 1); if (!rows.length) rows.push({ key: "", value: "", valueType: "string", scope: "global", secret: false, kept: false }); paint(); };
    });
    $$("[data-fetch]", tbody).forEach((b) => {
      b.onclick = () => cfgFetchForEdit(rows[+b.dataset.fetch], b, d);
    });
  }
  paint();
  cfgState._repaint = paint;
  $("#cfg-row-add").onclick = () => { rows.push({ key: "", value: "", valueType: "string", scope: "global", secret: false, kept: false }); paint(); };
  const close = () => { root.innerHTML = ""; cfgState._repaint = null; };
  $("#cfg-edit-cancel").onclick = close;
  $(".modal-mask", root).onclick = (e) => { if (e.target.classList.contains("modal-mask")) close(); };

  $("#cfg-edit-save").onclick = async () => {
    const errBox = $("#cfg-edit-error");
    errBox.classList.remove("show");
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      const key = r.key.trim();
      if (!key) continue;
      if (seen.has(key)) { errBox.textContent = `配置键重复：${key}`; errBox.classList.add("show"); return; }
      seen.add(key);
      if (r.secret && r.kept) {
        items.push({ key, value: "", value_type: r.valueType, scope: r.scope, is_secret: true, secret_kept: true });
        continue;
      }
      if (r.secret && !r.value) { errBox.textContent = `密文「${key}」需要填写新值`; errBox.classList.add("show"); return; }
      if (r.valueType === "number" && isNaN(Number(r.value.trim()))) { errBox.textContent = `「${key}」不是合法数值`; errBox.classList.add("show"); return; }
      if (r.valueType === "boolean" && !["true", "false"].includes(r.value.trim().toLowerCase())) { errBox.textContent = `「${key}」布尔值只能是 true/false`; errBox.classList.add("show"); return; }
      if (r.valueType === "json") { try { JSON.parse(r.value); } catch (e) { errBox.textContent = `「${key}」不是合法 JSON`; errBox.classList.add("show"); return; } }
      items.push({ key, value: r.value, value_type: r.valueType, scope: r.scope, is_secret: r.secret, secret_kept: false });
    }
    if (!items.length) { errBox.textContent = "至少保留一个配置键，或使用删除后保存"; errBox.classList.add("show"); return; }
    try {
      const r = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}`, {
        method: "PUT", body: { items, comment: $("#cfg-comment").value.trim() },
      });
      toast(`已生成新版本 v${r.current_version.version}，变更已留痕`, "success");
      close();
      cfgRenderBody();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.add("show");
    }
  };
}

/* 编辑时取明文：同样走服务端理由校验，取回后该行变为"新值"模式 */
function cfgFetchForEdit(row, btn, d) {
  const root = $("#modal-root");
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `
    <div class="modal" style="width:440px">
      <h3>取回密文明文</h3>
      <p class="cfg-reveal-note">配置键 <b class="mono">${esc(row.key)}</b>，取回后可编辑并作为新值保存，查看动作会留痕。</p>
      <label class="cfg-label">查看理由 *</label>
      <textarea id="fe-reason" rows="3"></textarea>
      <div class="form-error" id="fe-error"></div>
      <div class="form-actions">
        <button class="btn" id="fe-cancel">取消</button>
        <button class="btn primary" id="fe-ok">确认查看</button>
      </div>
    </div>`;
  root.appendChild(mask);
  const done = () => mask.remove();
  $("#fe-cancel", mask).onclick = done;
  mask.onclick = (e) => { if (e.target === mask) done(); };
  $("#fe-ok", mask).onclick = async () => {
    const reason = $("#fe-reason", mask).value.trim();
    if (reason.length < 2) {
      const eb = $("#fe-error", mask);
      eb.textContent = "请填写不少于 2 个字的理由（服务端强制校验）";
      eb.classList.add("show");
      return;
    }
    try {
      const r = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}/reveal`, {
        method: "POST", body: { key: row.key, reason },
      });
      row.value = r.value;
      row.kept = false;
      done();
      toast("已取回明文，该行将作为新值保存", "success");
      if (typeof cfgState._repaint === "function") cfgState._repaint();
    } catch (e) {
      const eb = $("#fe-error", mask);
      eb.textContent = e.message;
      eb.classList.add("show");
    }
  };
}

/* ---- 环境对比 ---- */
async function cfgToggleDiff() {
  const box = $("#cfg-diff");
  if (box.style.display !== "none") { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  const opts = state.meta.environments;
  box.innerHTML = `
    <div class="panel panel-pad">
      <div class="cfg-diff-bar">
        <h3 style="margin:0">环境差异对比</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="diff-l">${opts.map((e) => `<option value="${e.value}" ${e.value === cfgState.diffL ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select>
          <span style="color:var(--ink-3)">⇄</span>
          <select id="diff-r">${opts.map((e) => `<option value="${e.value}" ${e.value === cfgState.diffR ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select>
          <button class="btn small primary" id="diff-run">开始对比</button>
        </div>
      </div>
      <div id="diff-result"></div>
    </div>`;
  $("#diff-run").onclick = () => {
    const l = $("#diff-l").value, r = $("#diff-r").value;
    if (l === r) { toast("请选择两个不同的环境", "error"); return; }
    cfgState.diffL = l; cfgState.diffR = r;
    cfgRunDiff(l, r);
  };
  cfgRunDiff(cfgState.diffL, cfgState.diffR);
}

async function cfgRunDiff(l, r) {
  const box = $("#diff-result");
  box.innerHTML = `<div class="empty-tip">对比加载中…</div>`;
  let d;
  try {
    d = await api(`/api/apps/${cfgState.appId}/config-diff/${l}/${r}`);
  } catch (e) { box.innerHTML = `<div class="form-error show">${esc(e.message)}</div>`; return; }
  const t = d.totals;
  const valHtml = (side) => side
    ? `<span class="mono ${side.is_secret ? "cfg-secret-mask" : ""}">${side.is_secret ? "••••••••" : esc(side.value)}</span>`
    : '<span class="cfg-none">∅</span>';
  const rowCls = { diff: "row-diff", only_left: "row-left", only_right: "row-right", same: "" };
  const tag = {
    diff: '<span class="diff-tag changed">值不同</span>',
    only_left: `<span class="diff-tag only-l">仅${esc(d.left_label)}</span>`,
    only_right: `<span class="diff-tag only-r">仅${esc(d.right_label)}</span>`,
    same: '<span class="diff-tag same">一致</span>',
  };
  box.innerHTML = `
    <div class="diff-summary">
      <b>${esc(d.left_label)}</b> ⇄ <b>${esc(d.right_label)}</b>：
      共 ${t.keys} 个键 · <span class="d-changed">值不同 ${t.changed}</span> ·
      <span class="d-left">仅${esc(d.left_label)} ${t.only_left}</span> ·
      <span class="d-right">仅${esc(d.right_label)} ${t.only_right}</span>
    </div>
    <div class="table-wrap">
      <table class="cfg-table diff-table">
        <thead><tr><th style="width:26%">配置键</th><th>${esc(d.left_label)}</th><th>${esc(d.right_label)}</th><th style="width:110px">结论</th></tr></thead>
        <tbody>
          ${d.items.map((it) => `
            <tr class="${rowCls[it.status]}">
              <td class="mono">${esc(it.key)}</td>
              <td>${valHtml(it.left)}</td>
              <td>${valHtml(it.right)}</td>
              <td>${tag[it.status]}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

/* ---- 版本历史 / 回滚 ---- */
async function cfgOpenVersions() {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-mask"><div class="modal" style="width:760px"><div class="empty-tip">加载中…</div></div></div>`;
  const close = () => { root.innerHTML = ""; };
  let versions;
  try {
    versions = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}/versions`);
  } catch (e) {
    root.innerHTML = `<div class="modal-mask"><div class="modal" style="width:520px">
      <div class="form-error show">${esc(e.message)}</div>
      <div class="form-actions"><button class="btn" id="v-close">关闭</button></div></div></div>`;
    $("#v-close").onclick = close;
    return;
  }
  const cur = versions[0];
  const envLabel = state.meta.environments.find((e) => e.value === cfgState.env).label;
  root.innerHTML = `
    <div class="modal-mask"><div class="modal" style="width:780px">
      <h3>版本历史 · ${esc(envLabel)}环境</h3>
      <p class="cfg-reveal-note">回滚会把选中版本的内容<b>追加为一个新版本</b>，本版与历史的留痕都不会被覆盖。</p>
      ${versions.length ? `
      <div class="table-wrap">
        <table class="cfg-table">
          <thead><tr><th>版本</th><th>类型</th><th>配置项</th><th>操作人</th><th>说明</th><th>时间</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            ${versions.map((v) => `
              <tr>
                <td><b>v${v.version}</b>${cur && v.version === cur.version ? ' <span class="diff-tag same">当前</span>' : ""}</td>
                <td>${v.change_type === "rollback" ? `<span class="diff-tag only-l">回滚</span> 自 v${v.base_version}` : "常规更新"}</td>
                <td>${v.item_count} 项</td>
                <td>${esc(v.user_name || "系统")}</td>
                <td class="cfg-comment">${esc(v.comment || "—")}</td>
                <td>${fmtTime(v.created_at)}</td>
                <td>
                  <button class="btn small" data-view="${v.version}">查看</button>
                  ${cur && v.version !== cur.version ? `<button class="btn small danger" data-rb="${v.version}">回滚到此版</button>` : ""}
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>` : `<div class="empty-tip">该环境尚无历史版本</div>`}
      <div class="form-actions"><button class="btn" id="v-close">关闭</button></div>
    </div></div>`;
  $("#v-close").onclick = close;
  $(".modal-mask", root).onclick = (e) => { if (e.target.classList.contains("modal-mask")) close(); };
  $$("[data-view]", root).forEach((b) => { b.onclick = () => cfgViewVersion(b.dataset.view); });
  $$("[data-rb]", root).forEach((b) => { b.onclick = () => cfgRollback(b.dataset.rb, close); });
}

async function cfgViewVersion(version) {
  let d;
  try {
    d = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}/versions/${version}`);
  } catch (e) { toast(e.message, "error"); return; }
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-mask"><div class="modal" style="width:720px">
      <h3>v${d.version} 版本快照
        ${d.change_type === "rollback" ? `<span class="diff-tag only-l">回滚自 v${d.base_version}</span>` : '<span class="diff-tag same">常规更新</span>'}</h3>
      <p class="cfg-reveal-note">${esc(d.user_name || "系统")} · ${fmtTime(d.created_at)} · ${esc(d.comment || "无说明")}</p>
      <div class="table-wrap">
        <table class="cfg-table">
          <thead><tr><th>键</th><th>值</th><th>类型</th><th>范围</th><th>密文</th></tr></thead>
          <tbody>
            ${d.items.map((it) => `
              <tr>
                <td class="mono">${esc(it.key)}</td>
                <td class="mono ${it.is_secret ? "cfg-secret-mask" : ""}">${it.is_secret ? "••••••••（需在列表页申请明文）" : esc(it.value)}</td>
                <td>${esc(typeLabel(it.value_type))}</td>
                <td>${esc(scopeLabel(it.scope))}</td>
                <td>${it.is_secret ? '<span class="secret-tag">密文</span>' : "否"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="form-actions"><button class="btn primary" id="vv-back">返回版本列表</button></div>
    </div></div>`;
  $("#vv-back").onclick = () => cfgOpenVersions();
}

async function cfgRollback(version, close) {
  const reason = prompt(`确认把当前环境回滚到 v${version}？\n将生成一个新版本，历史留痕保留。\n可填写回滚说明（留空使用默认说明）：`, "");
  if (reason === null) return;
  try {
    const r = await api(`/api/apps/${cfgState.appId}/config/${cfgState.env}/rollback`, {
      method: "POST", body: { version: Number(version), comment: reason.trim() },
    });
    toast(`已回滚到 v${version}，生成新版本 v${r.current_version.version}，留痕未覆盖`, "success");
    close();
    cfgRenderBody();
  } catch (e) { toast(e.message, "error"); }
}

/* ---------------- 变更留痕 ---------------- */
const auditState = { business_line_id: "", app_id: "", environment: "", action: "", start: "", end: "" };

async function renderAudit() {
  const view = $("#view");
  const isAdmin = state.user.role === "admin";
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>变更留痕</h2>
        <div class="sub">配置改动流水 · 可按应用与时间窗查询谁改的、改前改后是什么，并导出差异清单</div>
      </div>
    </div>
    <div class="panel filter-bar">
      <select id="au-bl" ${isAdmin ? "" : "disabled"}>
        <option value="">${isAdmin ? "全部业务线" : esc(state.user.business_line_name || "本业务线")}</option>
        ${state.businessLines.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
      </select>
      <select id="au-app"><option value="">全部应用</option></select>
      <select id="au-env">
        <option value="">全部环境</option>
        ${state.meta.environments.map((e) => `<option value="${e.value}">${esc(e.label)}</option>`).join("")}
      </select>
      <select id="au-action">
        <option value="">全部动作</option>
        <option>配置更新</option><option>配置回滚</option><option>明文查看</option>
      </select>
      <input type="date" id="au-start">
      <span style="color:var(--ink-3)">至</span>
      <input type="date" id="au-end">
      <button class="btn primary" id="au-query">查询</button>
      <button class="btn" id="au-reset">重置</button>
      <button class="btn" id="au-export">导出差异清单 (CSV)</button>
    </div>
    <div id="au-result"><div class="empty-tip">设置条件后点击「查询」</div></div>`;

  const blSel = $("#au-bl"), appSel = $("#au-app");
  async function fillApps() {
    const p = new URLSearchParams();
    if (isAdmin && blSel.value) p.set("business_line_id", blSel.value);
    const apps = await api(`/api/apps?${p}`);
    const cur = appSel.value;
    appSel.innerHTML = `<option value="">全部应用</option>` +
      apps.map((a) => `<option value="${a.id}" ${String(a.id) === cur ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  }
  blSel.value = auditState.business_line_id;
  $("#au-app").value = auditState.app_id;
  $("#au-env").value = auditState.environment;
  $("#au-action").value = auditState.action;
  $("#au-start").value = auditState.start;
  $("#au-end").value = auditState.end;
  await fillApps();
  blSel.onchange = async () => { await fillApps(); };
  $("#au-query").onclick = auditLoad;
  $("#au-reset").onclick = () => {
    Object.assign(auditState, { business_line_id: "", app_id: "", environment: "", action: "", start: "", end: "" });
    renderAudit();
  };
  $("#au-export").onclick = auditExport;
  await auditLoad();
}

function auditParams() {
  const p = new URLSearchParams();
  auditState.business_line_id = $("#au-bl").value;
  auditState.app_id = $("#au-app").value;
  auditState.environment = $("#au-env").value;
  auditState.action = $("#au-action").value;
  auditState.start = $("#au-start").value;
  auditState.end = $("#au-end").value;
  if (state.user.role === "admin" && auditState.business_line_id) p.set("business_line_id", auditState.business_line_id);
  if (auditState.app_id) p.set("app_id", auditState.app_id);
  if (auditState.environment) p.set("environment", auditState.environment);
  if (auditState.action) p.set("action", auditState.action);
  if (auditState.start) p.set("start", auditState.start);
  if (auditState.end) p.set("end", auditState.end);
  return p;
}

async function auditLoad() {
  const box = $("#au-result");
  box.innerHTML = `<div class="empty-tip">加载中…</div>`;
  let d;
  try {
    d = await api(`/api/audit/configs?${auditParams().toString()}`);
  } catch (e) {
    box.innerHTML = errorStateHtml(e.status === 403 ? "403 无权访问" : "查询失败", e.message);
    return;
  }
  if (!d.items.length) {
    box.innerHTML = `<div class="panel panel-pad empty-tip">该时间窗 / 条件下没有配置变更流水</div>`;
    return;
  }
  box.innerHTML = `
    <div class="panel table-wrap">
      <table class="audit-table">
        <thead><tr>
          <th>时间</th><th>应用</th><th>环境</th><th>版本</th><th>操作人</th><th>动作</th>
          <th>配置键</th><th>改前值</th><th>改后值</th><th>类型/范围</th><th>理由</th>
        </tr></thead>
        <tbody>
          ${d.items.map((a) => `
            <tr class="au-${a.action === "明文查看" ? "reveal" : a.action === "配置回滚" ? "rollback" : "update"}">
              <td class="au-time">${fmtTime(a.created_at)}</td>
              <td>${esc(a.app_name)}<div class="app-desc">${esc(a.business_line_name)}</div></td>
              <td>${esc(a.environment_label)}</td>
              <td>${a.config_version ? `v${a.config_version}` : "—"}</td>
              <td>${esc(a.user_name || "系统")}</td>
              <td>${auditActionTag(a.action)}</td>
              <td class="mono">${esc(a.config_key) || "—"}</td>
              <td class="mono au-val">${a.old_value === "" ? '<span class="cfg-none">（空）</span>' : esc(a.old_value)}</td>
              <td class="mono au-val">${a.new_value === "" ? '<span class="cfg-none">（空/删除）</span>' : esc(a.new_value)}</td>
              <td class="au-mini">${esc(typeLabel(a.value_type))}<br><span style="color:var(--ink-3)">${esc(scopeLabel(a.scope))}</span>${a.is_secret ? ' <span class="secret-tag">密</span>' : ""}</td>
              <td class="au-reason" title="${esc(a.reason)}">${esc(a.reason) || "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="au-count">共 ${d.total} 条（最多展示 1000 条，可缩小时间窗或导出 CSV）</div>`;
}

function auditActionTag(action) {
  if (action === "配置回滚") return '<span class="diff-tag only-l">配置回滚</span>';
  if (action === "明文查看") return '<span class="secret-tag">明文查看</span>';
  return '<span class="diff-tag changed">配置更新</span>';
}

function auditExport() {
  const p = auditParams();
  // 携带令牌下载：用 fetch 取 blob 再触发保存（CSV 接口同样要求 X-Token）
  fetch(`/api/audit/configs/export.csv?${p.toString()}`, { headers: { "X-Token": state.token } })
    .then(async (res) => {
      if (!res.ok) {
        let msg = `导出失败（HTTP ${res.status}）`;
        try { msg = (await res.json()).detail || msg; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `配置变更差异清单_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("差异清单已导出", "success");
    })
    .catch((e) => toast(e.message, "error"));
}

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
