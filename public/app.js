'use strict';
/* 图文店前端：订单/校样/操作台/费用/取件 */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  setTimeout(() => t.classList.remove('show'), 3200);
}
const run = (p, ok) => p.then((r) => { if (ok) toast(ok); return refresh(); }).catch((e) => toast(e.message, true));

const STATUS_LABEL = {
  received: '已接单', prechecked: '已预检', proof_ready: '待确认校样', confirmed: '已确认',
  queued: '排队中', printing: '打印中', printed: '待取件', delivered: '已交付',
};
const PAPER = ['A0', 'A1', 'A2', 'A3', 'A4'];
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMoney = (n) => `<span class="money${n < 0 ? ' neg' : ''}">${n < 0 ? '' : ''}${n.toFixed(2)}</span>`;

let state = { orders: [], devices: [], operators: [] };
let samples = [];
let tab = 'orders';
let selOrderId = null;        // 校样/费用页当前订单
let detail = null;            // 当前订单详情
let selProofId = null;
let cmpA = null, cmpB = null; // 并排比较的版本号
let operator = '张伟';

async function refresh() {
  state = await api('/api/state');
  if (selOrderId) detail = await api(`/api/orders/${selOrderId}`).catch(() => null);
  render();
}

/* ---------------- 订单与上传 ---------------- */
function renderOrders() {
  const el = $('#tab-orders');
  el.innerHTML = `
  <div class="panel">
    <h2>新建订单</h2>
    <div class="row">
      <label>客户 <input id="o-customer" placeholder="客户名称"></label>
      <label>纸张规格 <select id="o-paper">${PAPER.map((p) => `<option ${p === 'A1' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label>色彩 <select id="o-color"><option value="bw">黑白</option><option value="color">彩色</option></select></label>
      <label>单双面 <select id="o-sides"><option value="single">单面</option><option value="double">双面</option></select></label>
      <label>装订 <select id="o-binding"><option value="none">不装订</option><option value="staple">骑马钉</option><option value="ring">圈装</option><option value="glue">胶装</option></select></label>
      <label>份数 <input id="o-copies" type="number" value="1" min="1" style="width:70px"></label>
      <button class="act" id="o-create">开单</button>
    </div>
  </div>
  <div class="panel">
    <h2>订单列表</h2>
    <table><thead><tr>
      <th>订单号</th><th>客户</th><th>规格</th><th>份数</th><th>状态</th><th>预计完成</th><th>费用合计</th><th>操作</th>
    </tr></thead><tbody>
    ${state.orders.map((o) => `<tr>
      <td>${esc(o.order_no)} ${o.rush ? '<span class="badge rush">急</span>' : ''}</td>
      <td>${esc(o.customer)}</td>
      <td>${o.paper_size} · ${o.color === 'bw' ? '黑白' : '彩色'} · ${o.sides === 'single' ? '单面' : '双面'}</td>
      <td>${o.copies}</td>
      <td><span class="badge st-${o.status}">${STATUS_LABEL[o.status]}</span></td>
      <td>${fmtTime(o.estimated_ready_at)}</td>
      <td>${fmtMoney(o.charge_total)}</td>
      <td class="row">
        <button class="ghost" data-upload="${o.id}">上传图纸</button>
        ${['prechecked', 'proof_ready'].includes(o.status) ? `<button class="ghost" data-proof="${o.id}">出校样</button>` : ''}
        ${['queued', 'confirmed'].includes(o.status) && !o.rush ? `<button class="ghost warn" data-rush="${o.id}">急单插队</button>` : ''}
      </td>
    </tr>`).join('')}
    </tbody></table>
  </div>
  <div class="panel" id="upload-panel" hidden>
    <h2>上传图纸并预检 <span class="muted" id="up-for"></span></h2>
    <div class="row">
      <label>选择本地样本 <select id="up-sample"><option value="">—</option>${samples.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label>或选择文件 <input type="file" id="up-file" accept=".json"></label>
      <button class="act" id="up-go" disabled>上传并预检</button>
    </div>
    <div id="up-result"></div>
  </div>`;

  $('#o-create').onclick = () => run(api('/api/orders', 'POST', {
    customer: $('#o-customer').value.trim(),
    paper_size: $('#o-paper').value, color: $('#o-color').value,
    sides: $('#o-sides').value, binding: $('#o-binding').value,
    copies: Number($('#o-copies').value),
  }), '订单已创建');

  el.querySelectorAll('[data-rush]').forEach((b) => (b.onclick = () =>
    run(api(`/api/orders/${b.dataset.rush}/rush`, 'POST'), '已插队，预计完成时间已重算')));
  el.querySelectorAll('[data-proof]').forEach((b) => (b.onclick = () =>
    run(api(`/api/orders/${b.dataset.proof}/proof`, 'POST'), '校样已生成，请到「校样查看」确认')));

  let uploadOrder = null, uploadContent = null, uploadName = null;
  const upGo = $('#up-go');
  const checkReady = () => { upGo.disabled = !(uploadOrder && uploadContent); };
  el.querySelectorAll('[data-upload]').forEach((b) => (b.onclick = () => {
    uploadOrder = b.dataset.upload;
    $('#upload-panel').hidden = false;
    $('#up-for').textContent = `（订单 #${uploadOrder}）`;
    checkReady();
  }));
  $('#up-sample').onchange = async (e) => {
    const name = e.target.value;
    if (!name) { uploadContent = null; return checkReady(); }
    const drawing = await api(`/api/samples/${encodeURIComponent(name)}`);
    uploadContent = JSON.stringify(drawing); uploadName = name; checkReady();
  };
  $('#up-file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { uploadContent = rd.result; uploadName = f.name; checkReady(); };
    rd.readAsText(f);
  };
  upGo.onclick = () => run(
    api(`/api/orders/${uploadOrder}/files`, 'POST', { filename: uploadName, content: uploadContent })
      .then((r) => { $('#up-result').innerHTML = reportHtml(r.report); }),
    '预检完成');
}

function reportHtml(r) {
  const lines = [];
  lines.push(`<div>图幅 <b>${r.sheet_size}</b>（${r.sheet_w}×${r.sheet_h} mm），共 <b>${r.page_count}</b> 页；
    纸张匹配：${r.paper_match ? '<span class="ok-line">与订单一致</span>' : `<span class="bad-line">订单为 ${r.requested_paper}，不符</span>`}</div>`);
  lines.push(r.missing_fonts.length
    ? `<div class="bad-line">缺失字体：${r.missing_fonts.map(esc).join('、')}</div>`
    : '<div class="ok-line">字体齐全</div>');
  lines.push(r.unprinted_layers.length
    ? `<div class="bad-line">未打印图层：${r.unprinted_layers.map(esc).join('、')}</div>`
    : '<div class="ok-line">图层均可打印</div>');
  if (r.scale_ok) {
    lines.push(`<div class="ok-line">比例 ${esc(r.page_scales[0]?.declared || '')} 正常</div>`);
  } else {
    const p = r.scale_problem;
    lines.push(`<div>第 ${p.page} 页比例异常：
      <span class="scale-err">实际比例 ${esc(p.actual)}</span>
      ${p.declared ? `（图面声明 ${esc(p.declared)}）` : ''}
      ${p.distorted ? ' · 横纵比例不一致，图形变形' : ''}
      ${!p.standard ? ' · 非标准比例' : ''}</div>`);
  }
  return `<div class="report panel">${lines.join('')}</div>`;
}

/* ---------------- 校样查看 ---------------- */
function renderProof() {
  const el = $('#tab-proof');
  const orders = state.orders.filter((o) => o.version_count > 0);
  if (!selOrderId && orders.length) selOrderId = orders[0].id;
  const head = `
    <div class="panel"><div class="row">
      <label>订单 <select id="p-order">${orders.map((o) =>
        `<option value="${o.id}" ${o.id === selOrderId ? 'selected' : ''}>${esc(o.order_no)} · ${esc(o.customer)}</option>`).join('')}</select></label>
      <span class="muted">点击图面可添加批注；两个窗格可分别切换版本并排对比</span>
    </div></div>`;
  el.innerHTML = head + '<div id="proof-body"></div>';
  $('#p-order').onchange = async (e) => {
    selOrderId = Number(e.target.value); selProofId = null; cmpA = cmpB = null;
    detail = await api(`/api/orders/${selOrderId}`);
    renderProof();
  };
  if (!detail || detail.order.id !== selOrderId) return;

  const { proofs, versions } = detail;
  if (selProofId == null && proofs.length) selProofId = proofs[proofs.length - 1].id;
  const proof = proofs.find((p) => p.id === selProofId);
  if (cmpA == null && versions.length) cmpA = versions[versions.length - 1].version_no;
  if (cmpB == null && versions.length) cmpB = versions.length > 1 ? versions[versions.length - 2].version_no : cmpA;

  const body = $('#proof-body');
  body.innerHTML = `
    <div class="panel">
      <h2>校样</h2>
      <div class="row">
        ${proofs.map((p) => `<button class="ghost ${p.id === selProofId ? 'act' : ''}" data-pid="${p.id}">
          #${p.id} · v${versions.find((v) => v.id === p.version_id)?.version_no ?? '?'} · ${proofStatus(p)}</button>`).join('')}
        ${proof && proof.status === 'pending' ? `
          <button class="act" id="p-confirm">客户确认校样</button>
          <button class="ghost warn" id="p-reject">驳回</button>` : ''}
        ${proof && proof.status === 'confirmed' ? '<span class="badge locked">已确认锁定 · 补传文件不会覆盖本校样</span>' : ''}
      </div>
    </div>
    <div class="viewer-wrap">
      ${paneHtml('A', cmpA, versions, proof)}
      ${paneHtml('B', cmpB, versions, proof)}
    </div>`;

  body.querySelectorAll('[data-pid]').forEach((b) => (b.onclick = () => { selProofId = Number(b.dataset.pid); renderProof(); }));
  body.querySelectorAll('[data-pane]').forEach((sel) => (sel.onchange = () => {
    if (sel.dataset.pane === 'A') cmpA = Number(sel.value); else cmpB = Number(sel.value);
    renderProof();
  }));
  if ($('#p-confirm')) $('#p-confirm').onclick = () => run(api(`/api/proofs/${selProofId}/confirm`, 'POST'), '校样已确认锁定，进入打印队列');
  if ($('#p-reject')) $('#p-reject').onclick = () => {
    const note = prompt('驳回原因') || '';
    run(api(`/api/proofs/${selProofId}/reject`, 'POST', { note }), '已驳回，等待重新上传');
  };
  // 点击图面添加批注
  body.querySelectorAll('svg[data-annotate]').forEach((svg) => {
    svg.addEventListener('click', (ev) => {
      if (!proof || proof.locked) return;
      const rect = svg.getBoundingClientRect();
      const mmX = (ev.clientX - rect.left - 46) / Number(svg.dataset.px);
      const mmY = (ev.clientY - rect.top - 30) / Number(svg.dataset.px);
      if (mmX < 0 || mmY < 0) return;
      const text = prompt(`在 (${mmX.toFixed(0)}, ${mmY.toFixed(0)}) mm 处批注：`);
      if (text) run(api(`/api/proofs/${selProofId}/annotations`, 'POST', { x: mmX, y: mmY, text, author: '客户' }), '批注已添加');
    });
  });
}

const proofStatus = (p) => ({ pending: '待确认', confirmed: '已确认', rejected: '已驳回', superseded: '被替代' }[p.status]);

function paneHtml(tag, versionNo, versions, proof) {
  const v = versions.find((x) => x.version_no === versionNo) || versions[versions.length - 1];
  if (!v) return '<div class="pane panel">暂无版本</div>';
  const anns = proof && proof.version_id === v.id ? proof.annotations : [];
  return `<div class="pane">
    <div class="pane-head">
      <b>窗格 ${tag}</b>
      <select data-pane="${tag}">${versions.map((x) =>
        `<option value="${x.version_no}" ${x.version_no === v.version_no ? 'selected' : ''}>v${x.version_no} · ${esc(x.filename)}</option>`).join('')}</select>
    </div>
    <div class="sheet-box">${sheetSvg(v, anns, tag)}</div>
    <div class="sheet-meta">
      <span>图幅 <b>${v.sheet_size}</b> · ${v.sheet_w}×${v.sheet_h} mm</span>
      ${scaleBadge(v.issues)}
    </div>
    ${anns.length ? `<ol class="ann-list">${anns.map((a) =>
      `<li>[${a.x.toFixed(0)}, ${a.y.toFixed(0)}mm] ${esc(a.text)} <span class="muted">${esc(a.author)}</span></li>`).join('')}</ol>` : ''}
  </div>`;
}

// 比例标注：错误时用可读数字醒目显示
function scaleBadge(issues) {
  if (!issues.page_scales || !issues.page_scales.length) return '<span class="muted">无比例信息</span>';
  if (issues.scale_ok) return `<span>比例 <b>${esc(issues.page_scales[0].declared)}</b></span>`;
  const p = issues.scale_problem;
  return `<span class="scale-err">第${p.page}页 实际比例 ${esc(p.actual)}</span>
    <span class="muted">声明 ${esc(p.declared || '—')} · ${p.standard ? '' : '非标准比例'}${p.distorted ? ' · 变形' : ''}</span>`;
}

// 带实际图幅标尺（mm）的图面
function sheetSvg(v, annotations, tag) {
  const w = v.sheet_w, h = v.sheet_h;
  const ML = 46, MT = 30;
  const px = Math.min(430 / w, 330 / h); // mm → px
  const sw = w * px, sh = h * px;
  const W = sw + ML + 12, H = sh + MT + 12;
  let ticks = '';
  const step = w > 700 ? 100 : 50;
  for (let mm = 0; mm <= w; mm += step) {
    const x = ML + mm * px;
    ticks += `<line x1="${x}" y1="${MT - 6}" x2="${x}" y2="${MT}" stroke="#94a3b8" stroke-width="1"/>
      <text x="${x}" y="${MT - 9}" font-size="9" fill="#64748b" text-anchor="middle">${mm}</text>`;
  }
  for (let mm = 0; mm <= h; mm += step) {
    const y = MT + mm * px;
    ticks += `<line x1="${ML - 6}" y1="${y}" x2="${ML}" y2="${y}" stroke="#94a3b8" stroke-width="1"/>
      <text x="${ML - 9}" y="${y + 3}" font-size="9" fill="#64748b" text-anchor="end">${mm}</text>`;
  }
  const dots = annotations.map((a, i) => {
    const cx = ML + a.x * px, cy = MT + a.y * px;
    return `<circle cx="${cx}" cy="${cy}" r="8" fill="#3b6ea5" opacity="0.9"/>
      <text x="${cx}" y="${cy + 3}" font-size="9" fill="#fff" text-anchor="middle">${i + 1}</text>`;
  }).join('');
  return `<svg data-annotate="${tag}" data-px="${px}" width="${W}" height="${H}" style="cursor:crosshair">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#f8fafc"/>
    ${ticks}
    <rect x="${ML}" y="${MT}" width="${sw}" height="${sh}" fill="#fff" stroke="#475569" stroke-width="1.5"/>
    <text x="${ML + 6}" y="${MT + 16}" font-size="11" fill="#94a3b8">${esc(v.filename)} · v${v.version_no}</text>
    <text x="${ML + sw - 6}" y="${MT + sh - 8}" font-size="10" fill="#64748b" text-anchor="end">${w} × ${h} mm</text>
    ${dots}
  </svg>`;
}

/* ---------------- 操作台 ---------------- */
function renderConsole() {
  const el = $('#tab-console');
  el.innerHTML = `
    <div class="panel"><div class="row">
      <label>操作员 <select id="c-op">${state.operators.map((o) =>
        `<option ${o === operator ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      <span class="muted">同一任务两名操作员只有一人能开机；卡纸会自动登记免费重印</span>
    </div></div>
    <div class="devices">
    ${state.devices.map((d) => {
      const printing = d.tasks.filter((t) => t.status === 'printing');
      const standby = d.tasks.filter((t) => t.status === 'standby');
      return `<div class="device">
        <div class="device-head">
          <span class="name">${esc(d.name)}</span>
          <span class="badge st-${d.status === 'printing' ? 'printing' : d.status === 'jammed' ? 'proof_ready' : 'delivered'}">
            ${{ idle: '待机', printing: '打印中', jammed: '卡纸' }[d.status]}</span>
        </div>
        <div class="device-body">
          <div class="queue-title">正在打印</div>
          ${printing.length ? printing.map((t) => taskLine(t, true)).join('') : '<div class="muted">—</div>'}
          <div class="queue-title">待机队列（${standby.length}）</div>
          ${standby.length ? standby.map((t) => taskLine(t, false)).join('') : '<div class="muted">—</div>'}
          <div class="row" style="margin-top:8px">
            ${d.status === 'printing' ? `<button class="ghost warn" data-jam="${d.id}">模拟卡纸</button>` : ''}
            ${d.status === 'jammed' ? `<button class="act" data-clear="${d.id}">排除卡纸</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('')}
    </div>`;
  $('#c-op').onchange = (e) => { operator = e.target.value; };
  el.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = () =>
    run(api(`/api/tasks/${b.dataset.claim}/claim`, 'POST', { operator }), `${operator} 已开机`)));
  el.querySelectorAll('[data-finish]').forEach((b) => (b.onclick = () =>
    run(api(`/api/tasks/${b.dataset.finish}/finish`, 'POST', { operator }), '任务完成')));
  el.querySelectorAll('[data-jam]').forEach((b) => (b.onclick = () =>
    run(api(`/api/devices/${b.dataset.jam}/jam`, 'POST'), '已登记卡纸与免费重印')));
  el.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = () =>
    run(api(`/api/devices/${b.dataset.clear}/clear`, 'POST'), '设备恢复待机')));

  function taskLine(t, isPrinting) {
    return `<div class="task-line${isPrinting ? ' printing' : ''}">
      <span>#${t.order_id} ${esc(t.order_no)} · ${esc(t.customer)} · ${t.paper_size}×${t.copies}份
        ${t.kind === 'reprint' ? '<span class="badge rush">重印</span>' : ''}
        ${t.rush ? '<span class="badge rush">急</span>' : ''}
        ${isPrinting ? `<span class="muted">${esc(t.operator || '')}</span>` : ''}
      </span>
      ${isPrinting
        ? `<button class="ghost" data-finish="${t.id}">完成</button>`
        : `<button class="act" data-claim="${t.id}">开机</button>`}
    </div>`;
  }
}

/* ---------------- 费用明细 ---------------- */
const REASONS = {
  font_missing: '字体缺失 —— 店方承担，免费重印',
  layer_unprinted: '图层未打印 —— 店方承担，免费重印',
  scale_mismatch: '尺寸比例不符 —— 客户已确认校样，半价重印',
  paper_jam: '机器卡纸 —— 店方承担，免费重印',
};
function renderBilling() {
  const el = $('#tab-billing');
  const orders = state.orders;
  if (!selOrderId && orders.length) selOrderId = orders[0].id;
  el.innerHTML = `
    <div class="panel"><div class="row">
      <label>订单 <select id="b-order">${orders.map((o) =>
        `<option value="${o.id}" ${o.id === selOrderId ? 'selected' : ''}>${esc(o.order_no)} · ${esc(o.customer)} · ${STATUS_LABEL[o.status]}</option>`).join('')}</select></label>
    </div></div>
    <div id="b-body"></div>`;
  $('#b-order').onchange = async (e) => {
    selOrderId = Number(e.target.value);
    detail = await api(`/api/orders/${selOrderId}`);
    renderBilling();
  };
  if (!detail || detail.order.id !== selOrderId) return;
  const { charges, reprints, order } = detail;
  const total = charges.reduce((s, c) => s + c.amount, 0);
  $('#b-body').innerHTML = `
    <div class="grid2">
      <div class="panel">
        <h2>费用明细（合计 ${fmtMoney(total)}）</h2>
        <table><thead><tr><th>类型</th><th>说明</th><th>金额</th><th>时间</th></tr></thead><tbody>
        ${charges.map((c) => `<tr>
          <td>${{ base: '打印费', reprint: '重印', refund: '退款', adjustment: '调整' }[c.kind] || c.kind}</td>
          <td>${esc(c.label)}</td><td>${fmtMoney(c.amount)}</td><td class="muted">${fmtTime(c.created_at)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">暂无费用</td></tr>'}
        </tbody></table>
      </div>
      <div class="panel">
        <h2>重印登记</h2>
        <div class="row">
          <label>原因 <select id="r-reason">${Object.entries(REASONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label>页数 <input id="r-pages" type="number" min="1" placeholder="默认全部" style="width:80px"></label>
          <label>份数 <input id="r-copies" type="number" min="1" placeholder="默认全部" style="width:80px"></label>
          <button class="act" id="r-go" ${order.status === 'delivered' ? 'disabled' : ''}>登记重印</button>
        </div>
        <table style="margin-top:10px"><thead><tr><th>原因</th><th>范围</th><th>费用处理</th><th>金额</th></tr></thead><tbody>
        ${reprints.map((r) => `<tr><td>${esc(REASONS[r.reason]?.split(' —— ')[0] || r.reason)}</td>
          <td>${r.pages}页×${r.copies}份</td><td>${esc(r.handling)}</td><td>${fmtMoney(r.amount)}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">暂无重印</td></tr>'}
        </tbody></table>
        <h2>客户临时减量</h2>
        <div class="row">
          <label>减至份数 <input id="d-copies" type="number" min="1" max="${order.copies - 1}" placeholder="当前 ${order.copies}" style="width:90px"></label>
          <button class="ghost" id="d-go" ${['confirmed', 'queued', 'printing'].includes(order.status) ? '' : 'disabled'}>减量并退款 90%</button>
        </div>
        ${order.status === 'delivered' ? '<div class="muted" style="margin-top:8px">订单已交付，不能再次收费</div>' : ''}
      </div>
    </div>`;
  $('#r-go').onclick = () => run(api(`/api/orders/${selOrderId}/reprints`, 'POST', {
    reason: $('#r-reason').value,
    pages: $('#r-pages').value ? Number($('#r-pages').value) : undefined,
    copies: $('#r-copies').value ? Number($('#r-copies').value) : undefined,
  }), '重印已登记并入队');
  const dgo = $('#d-go');
  if (dgo) dgo.onclick = () => run(api(`/api/orders/${selOrderId}/reduce`, 'POST', { copies: Number($('#d-copies').value) }), '已减量并退款');
}

/* ---------------- 取件核验 ---------------- */
function renderPickup() {
  const el = $('#tab-pickup');
  const candidates = state.orders.filter((o) => ['printed', 'delivered'].includes(o.status));
  el.innerHTML = `
    <div class="panel">
      <h2>取件核验</h2>
      <div class="row">
        <label>订单 <select id="k-order">${candidates.map((o) =>
          `<option value="${o.id}">${esc(o.order_no)} · ${esc(o.customer)} · ${STATUS_LABEL[o.status]}</option>`).join('')}</select></label>
        <label>取件码 <input id="k-code" inputmode="numeric" maxlength="6" placeholder="6 位取件码"></label>
        <button class="act" id="k-go">核验取件</button>
      </div>
      <div class="muted" style="margin-top:6px">提示：取件码打印在取件单上；已交付订单不能再次取件、不能再次收费。</div>
      <div id="k-result" style="margin-top:10px"></div>
    </div>
    <div class="panel">
      <h2>待取件 / 已交付</h2>
      <table><thead><tr><th>订单号</th><th>客户</th><th>状态</th><th>取件码（门店）</th><th>交付时间</th></tr></thead><tbody>
      ${candidates.map((o) => `<tr><td>${esc(o.order_no)}</td><td>${esc(o.customer)}</td>
        <td><span class="badge st-${o.status}">${STATUS_LABEL[o.status]}</span></td>
        <td class="money">${o.pickup_code}</td><td>${o.delivered_at ? new Date(o.delivered_at).toLocaleString('zh-CN') : '—'}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  $('#k-go').onclick = () => {
    const id = $('#k-order').value;
    api(`/api/orders/${id}/pickup`, 'POST', { code: $('#k-code').value.trim() })
      .then((o) => { $('#k-result').innerHTML = `<span class="badge st-printed">核验通过，${esc(o.order_no)} 已交付</span>`; refresh(); })
      .catch((e) => { $('#k-result').innerHTML = `<span class="scale-err">${esc(e.message)}</span>`; });
  };
}

/* ---------------- 框架 ---------------- */
function render() {
  ({ orders: renderOrders, proof: renderProof, console: renderConsole, billing: renderBilling, pickup: renderPickup })[tab]();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('main section').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  render();
}));

(async function init() {
  samples = await api('/api/samples');
  await refresh();
  setInterval(() => { if (tab === 'console') refresh(); }, 4000); // 操作台自动刷新
})();
