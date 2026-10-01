// 매체 점검 (휴대폰) — 카드 목록 · 카드 상세(기본 정보 · 댓글 · 점검 기록 · 변경 이력 · 첨부)
// 규칙은 PC(src/inspections.js)와 같다. 본문 마크다운 읽기·쓰기 함수도 PC 것을 그대로 옮겼다.

import {
  WD, state, api, actor, $, $$, esc, todayStr, cleanErr, timeAgo, debounce,
  toast, confirmSheet, inputSheet, pickSheet, sheet, openPage, ownerPicker, nav,
} from './core.js';

const MEDIA_ORDER = ['파워링크', '파워컨텐츠', '카카오', '플레이스 광고', '유튜브', '구글광고', '블로그', '당근마켓', 'sns광고'];
const EMOJIS = ['👍', '✅', '👀', '🙏', '❤️', '😂'];
const CMT_FIRST = 3;   // 처음엔 최근 3개
const CMT_MORE = 5;    // '더 보기' 한 번에 5개씩
const MAX_FILE = 50 * 1024 * 1024;

const ui = { search: '', media: 'all', day: 'all', status: 'active' };

// ---------- 목록 ----------
export async function loadInsp(force = false) {
  if (state.inspItems && !force) return state.inspItems;
  try { state.inspItems = await api.b.listInspections(actor()); }
  catch (err) { state.inspItems = state.inspItems || []; toast(cleanErr(err), true); }
  return state.inspItems;
}
function mediaList() {
  const set = new Set((state.inspItems || []).map((c) => c.media).filter(Boolean));
  return [...MEDIA_ORDER.filter((m) => set.has(m)), ...[...set].filter((m) => !MEDIA_ORDER.includes(m)).sort()];
}

nav.inspTab = async () => {
  await loadInsp(true);
  const sel = $('#i-media');
  sel.innerHTML = '<option value="all">전체 매체</option>' + mediaList().map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  sel.value = mediaList().includes(ui.media) ? ui.media : 'all';
  renderList();
};

$('#i-search').addEventListener('input', debounce((e) => { ui.search = e.target.value.trim().toLowerCase(); renderList(); }, 150));
for (const [sel, key] of [['#i-media', 'media'], ['#i-day', 'day'], ['#i-status', 'status']]) {
  $(sel).addEventListener('change', (e) => { ui[key] = e.target.value; renderList(); });
}

function renderList() {
  const items = state.inspItems || [];
  const wd = new Date().getDay();
  const active = items.filter((c) => c.active);
  const todayN = active.filter((c) => c.checkWeekday === wd).length;
  $('#i-summary').innerHTML = `진행 ${active.length} · 오늘(${WD[wd]}) 점검 <b class="${todayN ? 'warn' : ''}">${todayN}</b> · 종료 ${items.length - active.length}`;
  const list = items.filter((c) => {
    if (ui.media !== 'all' && c.media !== ui.media) return false;
    if (ui.status === 'active' && !c.active) return false;
    if (ui.status === 'ended' && c.active) return false;
    if (ui.day === 'today' && c.checkWeekday !== wd) return false;
    if (ui.day === 'none' && c.checkWeekday !== null && c.checkWeekday !== undefined) return false;
    if (/^\d$/.test(ui.day) && c.checkWeekday !== Number(ui.day)) return false;
    if (ui.search) {
      const hay = `${c.name} ${c.clinic} ${c.media} ${c.managers} ${c.keyNotes} ${c.csNotes} ${c.body}`.toLowerCase();
      if (!hay.includes(ui.search)) return false;
    }
    return true;
  });
  const box = $('#i-list');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<p class="empty">해당하는 점검 카드가 없습니다.</p>'; return; }
  const order = mediaList();
  const groups = {};
  for (const c of list) (groups[c.media || '(매체 없음)'] = groups[c.media || '(매체 없음)'] || []).push(c);
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  for (const k of keys) {
    const g = document.createElement('div');
    g.className = 'group';
    g.innerHTML = `<div class="group-head">${esc(k)} <span class="muted">${groups[k].length}</span></div>`;
    for (const c of groups[k].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
      const none = c.checkWeekday === null || c.checkWeekday === undefined;
      const row = document.createElement('button');
      row.className = 'row' + (c.active ? '' : ' off') + (c.active && c.checkWeekday === wd ? ' today' : '');
      row.dataset.id = c.id;
      const meta = [c.managers && `담당 ${c.managers}`, c.budget && `월 ${c.budget}`].filter(Boolean).join(' · ');
      row.innerHTML = `<span class="row-main"><span class="row-title">${esc(c.name)}</span><span class="row-meta">${esc(meta)}</span></span>
        <span class="pill ${none ? 'none' : ''}">${none ? '요일 없음' : '매주 ' + WD[c.checkWeekday]}</span>`;
      row.addEventListener('click', () => openCard(c.id));
      g.appendChild(row);
    }
    box.appendChild(g);
  }
}

$('#i-add').addEventListener('click', async () => {
  const name = await inputSheet({ title: '점검 카드 추가', placeholder: '카드 이름 (예: 튼튼 · 파워링크)', ok: '만들기' });
  if (!name || !name.trim()) return;
  try {
    const card = await api.b.createInspection(actor(), { name: name.trim(), media: ui.media !== 'all' ? ui.media : '', checkOwner: actor() });
    await loadInsp(true);
    renderList();
    openCard(card.id);
  } catch (err) { toast(cleanErr(err), true); }
});

// 업무(점검_…)에 연결된 카드 찾기
nav.findInspByRule = async (ruleId) => {
  if (!ruleId) return null;
  let hit = (state.inspItems || []).find((c) => c.recurringId === ruleId);
  if (hit) return hit;
  await loadInsp(true);
  hit = state.inspItems.find((c) => c.recurringId === ruleId);
  return hit || null;
};

// ---------- 마크다운 (PC 와 같은 형식) ----------
function mdSplitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/<br\s*\/?>/gi, '\n'));
}

export function bodyParse(md) {
  const blocks = [];
  let table = null;
  const flushTable = () => { if (table && table.rows.length) blocks.push(table); table = null; };
  for (const raw of String(md || '').split('\n')) {
    if (/^\s*\|/.test(raw)) {
      if (!table) table = { type: 'table', rows: [] };
      if (!/^\s*\|\s*:?-{3,}/.test(raw)) table.rows.push(mdSplitRow(raw));
      continue;
    }
    flushTable();
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = Math.min(4, Math.floor(line.match(/^\s*/)[0].replace(/\t/g, '    ').length / 4));
    const t = line.trim();
    let m;
    if ((m = t.match(/^(#{1,3})(?: (.*))?$/))) blocks.push({ type: 'h', level: m[1].length, text: m[2] || '' });
    else if (/^-{3,}$/.test(t)) blocks.push({ type: 'hr' });
    else if ((m = t.match(/^[-*] \[( |x|X)\] (.*)$/))) blocks.push({ type: 'check', checked: m[1].trim() !== '', text: m[2], indent });
    else if ((m = t.match(/^[-*] (.*)$/))) blocks.push({ type: 'li', text: m[1], indent });
    else if ((m = t.match(/^(\d+)\. (.*)$/))) blocks.push({ type: 'ol', num: Number(m[1]), text: m[2], indent });
    else if ((m = t.match(/^> ?(.*)$/))) blocks.push({ type: 'quote', text: m[1] });
    else blocks.push({ type: 'p', text: t, indent });
  }
  flushTable();
  for (const b of blocks) {
    if (b.type !== 'table') continue;
    const w = Math.max(1, ...b.rows.map((r) => r.length));
    b.rows = b.rows.map((r) => [...r, ...Array(w - r.length).fill('')]);
  }
  return blocks;
}

export function bodySerialize(blocks) {
  const pad = (b) => ' '.repeat((b.indent || 0) * 4);
  const out = [];
  let prev = null;
  for (const b of blocks) {
    const listish = b.type === 'li' || b.type === 'check' || b.type === 'ol';
    if (out.length && !(listish && prev && (prev.type === 'li' || prev.type === 'check' || prev.type === 'ol'))) out.push('');
    if (b.type === 'h') out.push('#'.repeat(b.level) + ' ' + b.text);
    else if (b.type === 'hr') out.push('---');
    else if (b.type === 'check') out.push(`${pad(b)}- [${b.checked ? 'x' : ' '}] ${b.text}`);
    else if (b.type === 'li') out.push(`${pad(b)}- ${b.text}`);
    else if (b.type === 'ol') out.push(`${pad(b)}${b.num || 1}. ${b.text}`);
    else if (b.type === 'quote') out.push('> ' + b.text);
    else if (b.type === 'table') {
      b.rows.forEach((r, i) => {
        out.push('| ' + r.map((c) => String(c || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')).join(' | ') + ' |');
        if (i === 0) out.push('| ' + r.map(() => '---').join(' | ') + ' |');
      });
    } else out.push(pad(b) + b.text);
    prev = b;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mdInline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t || u}</a>`);
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return h;
}
// 변경 이력 내용처럼 보기만 하는 마크다운
function mdView(md) {
  return bodyParse(md).map((b) => {
    if (b.type === 'table') {
      return `<div class="tbl-scroll"><table class="tbl">${b.rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${mdInline(c).replace(/\n/g, '<br>')}</th>` : `<td>${mdInline(c).replace(/\n/g, '<br>')}</td>`)).join('')}</tr>`).join('')}</table></div>`;
    }
    if (b.type === 'hr') return '<hr>';
    const pad = b.indent ? ` style="margin-left:${b.indent * 14}px"` : '';
    const mark = b.type === 'li' ? '• ' : b.type === 'ol' ? `${b.num}. ` : b.type === 'check' ? (b.checked ? '☑ ' : '☐ ') : '';
    return `<div class="md-${b.type}${b.type === 'h' ? ' h' + b.level : ''}"${pad}>${mark}${mdInline(b.text)}</div>`;
  }).join('');
}
const todayLabel = () => { const t = todayStr(); return `${t.slice(5, 7)}/${t.slice(8, 10)}`; };
// 날짜 칸 추가: 오른쪽 끝에 빈 열이 있으면 그 자리에, 없으면 새 열 (PC 와 같음)
function addColumn(tb, label) {
  const w = tb.rows[0].length;
  let target = -1;
  for (let c = 1; c < w; c++) if (tb.rows.every((r) => !String(r[c] || '').trim())) { target = c; break; }
  if (target === -1) { tb.rows.forEach((r) => r.push('')); target = w; }
  tb.rows[0][target] = label;
  return target;
}
function fmtSize(n) { return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }

// ---------- 카드 상세 ----------
export async function openCard(id, opts = {}) {
  let data;
  try { data = await api.b.getInspection(actor(), id); }
  catch (err) { return toast(cleanErr(err), true); }
  const cur = { ...data, blocks: bodyParse(data.card.body), comments: [], shown: CMT_FIRST };
  const page = openPage({
    title: data.card.name,
    cls: 'insp-page',
    right: [{ label: '⋯', onClick: () => cardMenu() }],
    onClose: async () => { if (state.tab === 'insp') { await loadInsp(true); renderList(); } },
  });
  const B = page.body;
  B.innerHTML = `
        <div class="chips" id="ic-chips"></div>
        ${opts.taskId ? '<button class="link-row" id="ic-task">이 업무 상세 보기 ›</button>' : ''}
        <details class="sec" id="ic-props-sec"><summary>기본 정보 <span class="muted" id="ic-props-sum"></span></summary>
          <div class="props" id="ic-props"></div><p class="saved" id="ic-saved"></p></details>
        <section class="sec"><h3>댓글 <span class="muted" id="ic-cmt-count"></span><span class="sec-hint">@이름 으로 부르면 알림이 갑니다</span></h3>
          <div id="ic-cmts" class="cmts"></div>
          <div class="cmt-new">
            <div id="ic-mention" class="mention hidden"></div>
            <textarea id="ic-cmt-input" class="input" rows="1" placeholder="댓글 추가… (@이름 으로 부르기)"></textarea>
            <button id="ic-cmt-send" class="btn primary">등록</button>
          </div></section>
        <section class="sec"><h3>점검 기록 · 메모 <span class="sec-hint">누르면 고칠 수 있습니다 · 바로 저장</span></h3>
          <div id="ic-body" class="body-edit"></div></section>
        <section class="sec"><h3>세팅 변경 이력 <span class="muted" id="ic-ch-count"></span><button class="mini" id="ic-ch-add">+ 추가</button></h3>
          <div id="ic-changes"></div></section>
        <section class="sec"><h3>첨부파일 <span class="muted" id="ic-file-count"></span>
          <label class="mini">+ 파일<input type="file" id="ic-file-input" multiple hidden /></label></h3>
          <div id="ic-files"></div></section>`;

  function renderChips() {
    const c = cur.card;
    const none = c.checkWeekday === null || c.checkWeekday === undefined;
    $('#ic-chips', B).innerHTML = [
      c.media && `<span class="chip">${esc(c.media)}</span>`,
      none ? '<span class="chip none">점검 요일 없음</span>' : `<span class="chip day">매주 ${WD[c.checkWeekday]}요일 점검</span>`,
      c.active ? '' : '<span class="chip off">종료</span>',
    ].filter(Boolean).join('');
    $('#ic-props-sum', B).textContent = [c.managers && `담당 ${c.managers}`, c.budget && `월 ${c.budget}`].filter(Boolean).join(' · ');
    page.setTitle(c.name);
  }

  // ----- 기본 정보 (바꾸면 바로 저장) -----
  function renderProps() {
    const c = cur.card;
    const F = [
      ['name', '🏷 카드 이름', 'text'], ['media', '📡 매체', 'text'], ['clinic', '🏥 병원명', 'text'], ['managers', '👤 담당자', 'text'],
      ['checkWeekday', '🔁 점검 요일', 'weekday'], ['owners', '🙋 점검 담당', 'owners'], ['budget', '💰 월 예산', 'text'],
      ['renewOn', '📆 재계약일', 'date'], ['reviewEndOn', '🛡 심의종료일', 'date'], ['agencyLink', '🔌 대행사 연동', 'text'],
      ['reportLink', '🔗 보고링크', 'link'], ['keyNotes', '⚠️ 주요 특이사항', 'area'], ['csNotes', '📌 CS 주의사항', 'area'],
      ['scheduleNotes', '🗒 일정 내용', 'area'], ['active', '🚦 진행 중', 'check'],
    ];
    const box = $('#ic-props', B);
    box.innerHTML = F.map(([f, label, type]) => {
      const v = c[f];
      let input;
      if (type === 'weekday') {
        input = `<select class="input" data-f="${f}"><option value="">점검 요일 없음</option>${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}" ${v === d ? 'selected' : ''}>매주 ${WD[d]}요일</option>`).join('')}</select>`;
      } else if (type === 'owners') input = '<div class="op-box" id="ic-owners"></div>';
      else if (type === 'date') input = `<input class="input" type="date" data-f="${f}" value="${esc(v || '')}" />`;
      else if (type === 'area') input = `<textarea class="input" rows="2" data-f="${f}" placeholder="비어 있음">${esc(v || '')}</textarea>`;
      else if (type === 'check') input = `<label class="check-line"><input type="checkbox" data-f="${f}" ${v ? 'checked' : ''} /> 진행 중 <span class="muted">(해제하면 종료)</span></label>`;
      else if (type === 'link') input = `<div class="link-line"><input class="input" data-f="${f}" value="${esc(v || '')}" placeholder="비어 있음" />${/^https?:\/\//i.test(v || '') ? `<a class="mini" href="${esc(v)}" target="_blank" rel="noopener">열기</a>` : ''}</div>`;
      else input = `<input class="input" data-f="${f}" value="${esc(v || '')}" placeholder="비어 있음" />`;
      return `<div class="prop"><span class="prop-key">${label}</span>${input}</div>`;
    }).join('');
    ownerPicker($('#ic-owners', box), {
      users: state.users,
      selected: [c.checkOwner, ...(c.checkCoOwners || [])].filter(Boolean),
      allowEmpty: true,
      onChange: (ids) => saveProp({ checkOwner: ids[0] || null, checkCoOwners: ids.slice(1) }),
    });
    for (const el of $$('[data-f]', box)) {
      const go = () => {
        const f = el.dataset.f;
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (f === 'checkWeekday') v = v === '' ? null : Number(v);
        if (f === 'renewOn' || f === 'reviewEndOn') v = v || null;
        if (f === 'name' && !String(v).trim()) { el.value = cur.card.name; return toast('카드 이름은 비울 수 없습니다', true); }
        if ((cur.card[f] ?? '') === (v ?? '')) return;
        saveProp({ [f]: v });
      };
      if (el.tagName === 'TEXTAREA') el.addEventListener('input', debounce(go, 700));
      el.addEventListener('change', go);
    }
  }
  async function saveProp(patch) {
    try {
      cur.card = await api.b.updateInspection(actor(), cur.card.id, patch);
      $('#ic-saved', B).textContent = '저장됨 ✓';
      setTimeout(() => { const s = $('#ic-saved', B); if (s) s.textContent = ''; }, 1500);
      renderChips();
      if ('checkWeekday' in patch || 'active' in patch || 'checkOwner' in patch) {
        await api.b.generateRecurring(actor()).catch(() => 0);
        if ('checkWeekday' in patch && patch.checkWeekday !== null) toast(`매주 ${WD[patch.checkWeekday]}요일에 '점검_${cur.card.name}' 업무가 들어갑니다`);
      }
    } catch (err) { toast(cleanErr(err), true); }
  }

  async function cardMenu() {
    const a = await pickSheet(cur.card.name, [{ label: '카드 삭제', value: 'del', danger: true }]);
    if (a !== 'del') return;
    const ok = await confirmSheet(`"${cur.card.name}" 카드를 삭제할까요?\n변경 이력 ${cur.changes.length}건, 첨부 ${cur.files.length}개도 함께 지워지고 되돌릴 수 없습니다.\n기록을 남기려면 삭제 대신 '진행 중'을 해제하세요.`, { ok: '삭제', danger: true });
    if (!ok) return;
    try { await api.b.removeInspection(actor(), cur.card.id); await page.close(); toast('삭제했습니다'); }
    catch (err) { toast(cleanErr(err), true); }
  }

  // ----- 댓글 -----
  async function loadComments() {
    try { cur.comments = await api.b.listInspComments(actor(), cur.card.id); }
    catch (err) { cur.comments = []; toast(cleanErr(err), true); }
    renderComments();
  }
  function renderComments() {
    const box = $('#ic-cmts', B);
    if (!box) return;
    const list = cur.comments;
    $('#ic-cmt-count', B).textContent = list.length ? `${list.length}개` : '';
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="empty">아직 댓글이 없습니다. 이번 주 점검 내용을 남겨보세요.</p>'; return; }
    const ub = Object.fromEntries(state.users.map((u) => [u.id, u]));
    const hidden = Math.max(0, list.length - cur.shown);
    if (hidden) {
      const more = document.createElement('button');
      more.className = 'cmt-more';
      more.textContent = `이전 댓글 ${hidden}개 — ${Math.min(CMT_MORE, hidden)}개 더 보기`;
      more.addEventListener('click', () => { cur.shown += CMT_MORE; renderComments(); });
      box.appendChild(more);
    }
    for (const c of list.slice(hidden)) {
      const who = ub[c.authorId];
      const mine = c.authorId === actor() || state.me.isSuper;
      const groups = new Map();
      for (const r of c.reactions || []) {
        if (!groups.has(r.emoji)) groups.set(r.emoji, []);
        if (!groups.get(r.emoji).includes(r.userId)) groups.get(r.emoji).push(r.userId);
      }
      const order = (e) => { const i = EMOJIS.indexOf(e); return i < 0 ? 99 : i; };
      const chips = [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([e, ids]) => {
        const names = ids.map((id) => (ub[id] ? ub[id].name : '알 수 없음')).join(', ');
        return `<button class="react${ids.includes(actor()) ? ' on' : ''}" data-emoji="${esc(e)}" data-who="${esc(names)}">${esc(e)}<b>${ids.length}</b></button>`;
      }).join('');
      let bodyHtml = esc(c.body);
      for (const u of state.users) bodyHtml = bodyHtml.split('@' + esc(u.name)).join(`<span class="at">@${esc(u.name)}</span>`);
      const row = document.createElement('div');
      row.className = 'cmt';
      row.dataset.id = c.id;
      row.innerHTML = `<span class="avatar">${esc((who ? who.name : '?').slice(0, 1))}</span>
        <div class="cmt-main">
          <div class="cmt-head"><b>${esc(who ? who.name : '알 수 없음')}</b><span class="muted">${timeAgo(c.createdAt)}</span>
            <span class="cmt-acts"><button class="icon-mini emo-toggle" aria-label="감정표현">☺︎</button>${mine ? '<button class="icon-mini cmt-menu" aria-label="수정·삭제">⋯</button>' : ''}</span></div>
          <div class="cmt-body">${bodyHtml.replace(/\n/g, '<br>')}</div>
          <div class="emo-bar hidden">${EMOJIS.map((e) => `<button class="emo" data-emoji="${esc(e)}">${esc(e)}</button>`).join('')}</div>
          <div class="reacts">${chips}</div>
        </div>`;
      row.querySelector('.emo-toggle').addEventListener('click', () => row.querySelector('.emo-bar').classList.toggle('hidden'));
      for (const b of row.querySelectorAll('[data-emoji]')) {
        let timer = null; let long = false;
        // 감정표현 칩을 길게 누르면 누가 남겼는지
        if (b.classList.contains('react')) {
          b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; toast(`${b.dataset.emoji} ${b.dataset.who}`); }, 450); });
          for (const ev of ['pointerup', 'pointerleave']) b.addEventListener(ev, () => clearTimeout(timer));
          b.addEventListener('contextmenu', (e) => e.preventDefault());
          b.title = b.dataset.who;
        }
        b.addEventListener('click', () => { if (long) { long = false; return; } react(c, b.dataset.emoji); });
      }
      const menu = row.querySelector('.cmt-menu');
      if (menu) menu.addEventListener('click', () => commentMenu(c));
      box.appendChild(row);
    }
  }
  async function react(c, emoji) {
    try {
      const res = await api.b.toggleInspReaction(actor(), c.id, emoji);
      c.reactions = (c.reactions || []).filter((r) => !(r.userId === actor() && r.emoji === emoji));
      if (res && res.on) c.reactions.push({ userId: actor(), emoji });
      renderComments();
    } catch (err) { toast(cleanErr(err), true); }
  }
  async function commentMenu(c) {
    const a = await pickSheet('댓글', [{ label: '수정', value: 'edit' }, { label: '삭제', value: 'del', danger: true }]);
    if (a === 'edit') {
      const text = await inputSheet({ title: '댓글 수정', value: c.body, multiline: true });
      if (text === null || !text.trim() || text.trim() === c.body) return;
      try { await api.b.updateInspComment(actor(), c.id, text.trim()); await loadComments(); toast('수정했습니다'); }
      catch (err) { toast(cleanErr(err), true); }
    } else if (a === 'del') {
      if (!(await confirmSheet('이 댓글을 삭제할까요?', { ok: '삭제', danger: true }))) return;
      try { await api.b.removeInspComment(actor(), c.id); await loadComments(); toast('삭제했습니다'); }
      catch (err) { toast(cleanErr(err), true); }
    }
  }
  function wireComments() {
    const inp = $('#ic-cmt-input', B);
    const box = $('#ic-mention', B);
    const grow = () => { inp.style.height = 'auto'; inp.style.height = Math.min(140, inp.scrollHeight) + 'px'; };
    let mention = null;
    const showMentions = () => {
      const upto = inp.value.slice(0, inp.selectionStart);
      const m = upto.match(/@([^\s@]*)$/);
      if (!m) { box.classList.add('hidden'); mention = null; return; }
      const items = state.users.filter((u) => u.id !== actor() && u.name.includes(m[1])).slice(0, 6);
      if (!items.length) { box.classList.add('hidden'); mention = null; return; }
      mention = { start: upto.length - m[0].length, len: m[0].length };
      box.innerHTML = items.map((u) => `<button type="button" data-name="${esc(u.name)}">@${esc(u.name)}</button>`).join('');
      box.classList.remove('hidden');
      for (const b of box.querySelectorAll('button')) {
        b.addEventListener('pointerdown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          const v = inp.value;
          inp.value = v.slice(0, mention.start) + '@' + b.dataset.name + ' ' + v.slice(mention.start + mention.len);
          const pos = mention.start + b.dataset.name.length + 2;
          box.classList.add('hidden');
          inp.focus();
          inp.setSelectionRange(pos, pos);
          grow();
        });
      }
    };
    inp.addEventListener('input', () => { grow(); showMentions(); });
    $('#ic-cmt-send', B).addEventListener('click', async () => {
      const text = inp.value.trim();
      if (!text) return;
      try {
        await api.b.createInspComment(actor(), cur.card.id, text);
        inp.value = ''; grow();
        box.classList.add('hidden');
        cur.shown += 1;   // 새 댓글을 써도 보던 댓글이 다시 접히지 않게
        await loadComments();
        const tagged = state.users.filter((u) => u.id !== actor() && text.includes('@' + u.name)).map((u) => u.name);
        toast(tagged.length ? `댓글을 남기고 ${tagged.join(', ')} 님에게 알렸습니다` : '댓글을 남겼습니다');
      } catch (err) { toast(cleanErr(err), true); }
    });
  }

  // ----- 점검 기록 · 메모 (본문) -----
  async function saveBody() {
    const body = bodySerialize(cur.blocks);
    if (body === cur.card.body) return;
    try { cur.card = await api.b.updateInspection(actor(), cur.card.id, { body }); }
    catch (err) { toast(cleanErr(err), true); }
  }
  const PH = { h: '구역 이름', p: '내용', li: '항목', check: '할 일', ol: '항목', quote: '메모' };
  function renderBody() {
    const box = $('#ic-body', B);
    box.innerHTML = '';
    if (!cur.blocks.length) box.innerHTML = '<p class="empty">아직 기록이 없습니다. 아래 버튼으로 추가하세요.</p>';
    cur.blocks.forEach((b, i) => {
      if (b.type === 'table') { box.appendChild(tableEl(b, i)); return; }
      const row = document.createElement('div');
      row.className = `bl bl-${b.type}${b.type === 'h' ? ' h' + b.level : ''}`;
      if (b.indent) row.style.marginLeft = b.indent * 14 + 'px';
      if (b.type === 'hr') row.innerHTML = '<hr>';
      else {
        const mark = b.type === 'li' ? '<span class="bl-mark">•</span>' : b.type === 'ol' ? `<span class="bl-mark">${b.num || 1}.</span>`
          : b.type === 'check' ? `<input type="checkbox" class="bl-box" ${b.checked ? 'checked' : ''} />` : '';
        row.innerHTML = `${mark}<span class="bl-text">${b.text ? mdInline(b.text) : `<span class="ph">${PH[b.type] || ''}</span>`}</span>`;
        const chk = row.querySelector('.bl-box');
        if (chk) chk.addEventListener('change', () => { b.checked = chk.checked; saveBody(); });
      }
      row.addEventListener('click', (e) => { if (e.target.closest('a') || e.target.closest('.bl-box')) return; editLine(i); });
      box.appendChild(row);
    });
    const add = document.createElement('div');
    add.className = 'add-row';
    add.innerHTML = '<button class="mini" data-add="h">+ 구역</button><button class="mini" data-add="p">+ 글</button><button class="mini" data-add="check">+ 체크</button><button class="mini" data-add="table">+ 표</button>';
    add.addEventListener('click', async (e) => {
      const t = e.target.dataset.add;
      if (!t) return;
      if (t === 'table') {
        cur.blocks.push({ type: 'table', rows: [['체크리스트', todayLabel()], ['노출수', ''], ['클릭수', ''], ['CPC', ''], ['비용', '']] });
        await saveBody(); renderBody(); return;
      }
      const text = await inputSheet({ title: { h: '구역(제목) 추가', p: '글 추가', check: '체크항목 추가' }[t], multiline: t === 'p', ok: '추가' });
      if (text === null || !text.trim()) return;
      cur.blocks.push(t === 'h' ? { type: 'h', level: 1, text: text.trim() } : { type: t, text: text.trim(), checked: false, indent: 0 });
      await saveBody(); renderBody();
    });
    box.appendChild(add);
  }
  async function editLine(i) {
    const b = cur.blocks[i];
    if (!b) return;
    if (b.type === 'hr') {
      if (await confirmSheet('구분선을 지울까요?', { ok: '지우기', danger: true })) { cur.blocks.splice(i, 1); await saveBody(); renderBody(); }
      return;
    }
    const extra = [{ label: '줄 삭제', value: '__del', danger: true }];
    if (b.type === 'h') extra.unshift({ label: '구역 삭제', value: '__delsec', danger: true });
    const v = await inputSheet({ title: { h: '구역 이름', check: '체크항목', li: '항목', ol: '항목', quote: '메모' }[b.type] || '내용', value: b.text, multiline: b.type === 'p', extra });
    if (v === null) return;
    if (v === '__del') cur.blocks.splice(i, 1);
    else if (v === '__delsec') {
      let end = i + 1;
      while (end < cur.blocks.length && cur.blocks[end].type !== 'h') end++;
      if (!(await confirmSheet(`"${b.text || '이 구역'}" 구역을 삭제할까요?\n아래 내용 ${end - i - 1}줄도 함께 지워집니다.`, { ok: '삭제', danger: true }))) return;
      cur.blocks.splice(i, end - i);
    } else {
      // 글에 줄바꿈을 넣으면 줄마다 나눠 같은 종류로 (마크다운 한 줄 = 한 줄)
      const lines = v.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) cur.blocks.splice(i, 1);
      else { b.text = lines[0]; cur.blocks.splice(i + 1, 0, ...lines.slice(1).map((t) => ({ ...b, text: t }))); }
    }
    await saveBody();
    renderBody();
  }
  function tableEl(tb, i) {
    const wrap = document.createElement('div');
    wrap.className = 'tbl-wrap';
    wrap.innerHTML = `<div class="tbl-tools"><button class="mini primary" data-act="today">+ 오늘 날짜 열</button><button class="mini" data-act="row">+ 행</button><button class="mini" data-act="more">⋯</button></div>
      <div class="tbl-scroll"><table class="tbl edit">${tb.rows.map((r, ri) => `<tr>${r.map((c, ci) => {
        const tag = ri === 0 ? 'th' : 'td';
        return `<${tag} data-r="${ri}" data-c="${ci}" class="${ci === 0 ? 'first' : ''}">${c ? mdInline(c).replace(/\n/g, '<br>') : '&nbsp;'}</${tag}>`;
      }).join('')}</tr>`).join('')}</table></div>`;
    for (const cell of wrap.querySelectorAll('[data-r]')) cell.addEventListener('click', (e) => { if (!e.target.closest('a')) editCell(i, Number(cell.dataset.r), Number(cell.dataset.c)); });
    wrap.querySelector('.tbl-tools').addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      if (act === 'today') {
        const col = addColumn(tb, todayLabel());
        await saveBody(); renderBody();
        scrollTableRight(i);
        if (tb.rows.length > 1) editCell(i, 1, col);
      } else if (act === 'row') {
        tb.rows.push(Array(tb.rows[0].length).fill(''));
        await saveBody(); renderBody();
        editCell(i, tb.rows.length - 1, 0);
      } else if (act === 'more') {
        const a = await pickSheet('표', [
          { label: '+ 빈 열 추가', value: 'col' }, { label: '− 마지막 열 지우기', value: 'delcol' },
          { label: '− 마지막 행 지우기', value: 'delrow' }, { label: '표 삭제', value: 'deltable', danger: true }]);
        if (!a) return;
        if (a === 'col') addColumn(tb, '');
        else if (a === 'delcol') { if (tb.rows[0].length > 1) tb.rows.forEach((r) => r.pop()); }
        else if (a === 'delrow') { if (tb.rows.length > 1) tb.rows.pop(); }
        else if (a === 'deltable') { if (!(await confirmSheet('이 표를 삭제할까요?', { ok: '삭제', danger: true }))) return; cur.blocks.splice(i, 1); }
        await saveBody(); renderBody();
      }
    });
    return wrap;
  }
  function scrollTableRight(i) {
    const w = $$('.tbl-wrap', B)[cur.blocks.slice(0, i + 1).filter((b) => b.type === 'table').length - 1];
    const sc = w && w.querySelector('.tbl-scroll');
    if (sc) sc.scrollLeft = sc.scrollWidth;
  }
  // 표 칸 고치기 — '다음 칸 ↓' 으로 같은 열 아래 칸으로 이어서 입력 (점검 수치 넣기 편하게)
  function editCell(i, r, c) {
    const tb = cur.blocks[i];
    if (!tb || !tb.rows[r]) return;
    const rowName = String(tb.rows[r][0] || '').trim() || `${r + 1}행`;
    const colName = String(tb.rows[0][c] || '').trim() || `${c + 1}열`;
    const hasNext = r + 1 < tb.rows.length;
    const s = sheet({
      title: r === 0 ? `머리칸 · ${colName}` : `${rowName} · ${colName}`,
      html: `<textarea class="input sheet-input" rows="2">${esc(tb.rows[r][c] || '')}</textarea>
        <div class="sheet-btns"><button class="btn ghost" data-a="no">취소</button>
        ${hasNext ? '<button class="btn ghost" data-a="next">다음 칸 ↓</button>' : ''}
        <button class="btn primary" data-a="ok">저장</button></div>`,
    });
    const inp = s.el.querySelector('textarea');
    setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 60);
    const commit = async () => { tb.rows[r][c] = inp.value.replace(/\s+$/, ''); await saveBody(); renderBody(); };
    s.el.querySelector('[data-a="no"]').onclick = () => s.close();
    s.el.querySelector('[data-a="ok"]').onclick = async () => { s.close(); await commit(); };
    const nx = s.el.querySelector('[data-a="next"]');
    if (nx) nx.onclick = async () => { s.close(); await commit(); editCell(i, r + 1, c); };
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault(); s.close(); await commit();
        if (hasNext) editCell(i, r + 1, c);
      }
    });
  }

  // ----- 세팅 변경 이력 -----
  function renderChanges() {
    const { changes, files } = cur;
    $('#ic-ch-count', B).textContent = changes.length ? `${changes.length}건` : '';
    const box = $('#ic-changes', B);
    if (!changes.length) { box.innerHTML = '<p class="empty">변경 이력이 없습니다.</p>'; return; }
    box.innerHTML = '';
    for (const ch of changes) {
      const n = files.filter((f) => f.changeId === ch.id).length;
      const row = document.createElement('div');
      row.className = 'change';
      row.innerHTML = `<div class="change-top">
          <span class="change-date">${esc(ch.changedOn || '날짜 없음')}</span>
          <span class="change-title">${esc(ch.title || '(제목 없음)')}</span>
          ${ch.kept === true ? '<span class="kept yes">유지</span>' : ch.kept === false ? '<span class="kept no">유지 안 함</span>' : ''}
        </div>
        <div class="change-sub muted">${esc(ch.participant || '')}${n ? ` · 📎${n}` : ''}${ch.body ? ' · 내용 보기 ▾' : ''}<button class="mini change-edit">수정</button></div>
        <div class="change-body hidden md">${ch.body ? mdView(ch.body) : ''}</div>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.change-edit')) return changeForm(ch);
        if (e.target.closest('a')) return;
        if (ch.body) row.querySelector('.change-body').classList.toggle('hidden');
      });
      box.appendChild(row);
    }
  }
  function changeForm(ch) {
    const s = sheet({
      title: ch ? '세팅 변경 이력 수정' : '세팅 변경 이력 추가',
      wide: true,
      html: `<label class="fld">제목<input class="input" id="cf-title" value="${esc(ch ? ch.title : '')}" /></label>
        <div class="fld-grid"><label class="fld">변경일<input class="input" type="date" id="cf-date" value="${esc(ch ? ch.changedOn || '' : todayStr())}" /></label>
        <label class="fld">유지 여부<select class="input" id="cf-kept"><option value="yes">유지</option><option value="no">유지 안 함</option><option value="">미정</option></select></label></div>
        <label class="fld">참여자<input class="input" id="cf-part" value="${esc(ch ? ch.participant : state.me.name)}" /></label>
        <label class="fld">내용<textarea class="input" id="cf-body" rows="6">${esc(ch ? ch.body : '')}</textarea></label>
        <p class="err hidden" id="cf-err"></p>
        <div class="sheet-btns">${ch ? '<button class="btn danger-ghost" data-a="del">삭제</button>' : ''}<button class="btn ghost" data-a="no">취소</button><button class="btn primary" data-a="ok">저장</button></div>`,
    });
    const E = s.el;
    $('#cf-kept', E).value = ch ? (ch.kept === true ? 'yes' : ch.kept === false ? 'no' : '') : 'yes';
    E.querySelector('[data-a="no"]').onclick = () => s.close();
    E.querySelector('[data-a="ok"]').onclick = async () => {
      const kept = $('#cf-kept', E).value;
      const data = { title: $('#cf-title', E).value.trim(), changedOn: $('#cf-date', E).value || null,
        kept: kept === 'yes' ? true : kept === 'no' ? false : null, participant: $('#cf-part', E).value.trim(), body: $('#cf-body', E).value };
      if (!data.title) { $('#cf-err', E).textContent = '제목을 입력하세요.'; $('#cf-err', E).classList.remove('hidden'); return; }
      try {
        if (ch) await api.b.updateInspChange(actor(), ch.id, data);
        else await api.b.createInspChange(actor(), cur.card.id, data);
        s.close(); await reloadParts(); toast('저장했습니다');
      } catch (err) { $('#cf-err', E).textContent = cleanErr(err); $('#cf-err', E).classList.remove('hidden'); }
    };
    const del = E.querySelector('[data-a="del"]');
    if (del) del.onclick = async () => {
      s.close();
      if (!(await confirmSheet('이 변경 이력을 삭제할까요?', { ok: '삭제', danger: true }))) return;
      try { await api.b.removeInspChange(actor(), ch.id); await reloadParts(); toast('삭제했습니다'); }
      catch (err) { toast(cleanErr(err), true); }
    };
  }
  async function reloadParts() {
    const d = await api.b.getInspection(actor(), cur.card.id);
    cur.changes = d.changes; cur.files = d.files;
    renderChanges(); renderFiles();
  }

  // ----- 첨부파일 -----
  function renderFiles() {
    const { files, changes } = cur;
    $('#ic-file-count', B).textContent = files.length ? `${files.length}개` : '';
    const box = $('#ic-files', B);
    if (!files.length) { box.innerHTML = '<p class="empty">첨부파일이 없습니다.</p>'; return; }
    box.innerHTML = '';
    for (const f of files) {
      const ch = f.changeId ? changes.find((c) => c.id === f.changeId) : null;
      const row = document.createElement('div');
      row.className = 'file';
      row.innerHTML = `<button class="file-open"><span class="file-name">📎 ${esc(f.name)}</span>
          <span class="muted">${fmtSize(f.size)}${ch ? ' · ' + esc(ch.title) : ''}</span></button>
        <button class="icon-mini file-del" aria-label="삭제">✕</button>`;
      row.querySelector('.file-open').addEventListener('click', () => openFile(f));
      row.querySelector('.file-del').addEventListener('click', async () => {
        if (!(await confirmSheet(`"${f.name}" 파일을 삭제할까요? 되돌릴 수 없습니다.`, { ok: '삭제', danger: true }))) return;
        try { await api.b.removeInspFile(actor(), f.id); await reloadParts(); toast('삭제했습니다'); }
        catch (err) { toast(cleanErr(err), true); }
      });
      box.appendChild(row);
    }
  }
  async function openFile(f) {
    // 새 창을 먼저 열어 두어야 휴대폰이 '팝업 차단'을 하지 않는다
    const w = window.open('', '_blank');
    try {
      let url;
      if (api.b.sb) {
        const { data, error } = await api.b.sb.storage.from('inspection-files').createSignedUrl(f.storagePath, 600, { download: false });
        if (error) throw error;
        url = data.signedUrl;
      } else {
        const r = await api.b.readInspFile(actor(), f.id);
        url = URL.createObjectURL(new Blob([new Uint8Array(r.buffer.data || r.buffer)], { type: f.mime || 'application/octet-stream' }));
      }
      if (w) w.location.href = url; else location.href = url;
    } catch (err) { if (w) w.close(); toast(cleanErr(err), true); }
  }
  async function uploadFiles(input) {
    const picked = [...(input.files || [])];
    input.value = '';
    if (!picked.length) return;
    let added = 0;
    const skipped = [];
    toast('올리는 중…');
    for (const file of picked) {
      if (file.size > MAX_FILE) { skipped.push(`${file.name} (50MB 초과)`); continue; }
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await api.b.addInspFile(actor(), cur.card.id, { name: file.name, buffer, mime: file.type || '' });
        added++;
      } catch (err) { skipped.push(`${file.name} (${cleanErr(err)})`); }
    }
    await reloadParts();
    toast(`파일 ${added}개를 올렸습니다` + (skipped.length ? ` · 제외: ${skipped.join(', ')}` : ''), !!skipped.length);
  }
  renderChips();
  renderProps();
  renderBody();
  renderChanges();
  renderFiles();
  wireComments();
  loadComments().then(() => {
    if (opts.focus === 'comments') { const el = $('#ic-cmts', B); if (el) el.scrollIntoView({ block: 'start' }); }
  });
  const tb = $('#ic-task', B);
  if (tb) tb.addEventListener('click', async () => { await page.close(); nav.openTask(opts.taskId, true); });
  $('#ic-ch-add', B).addEventListener('click', () => changeForm(null));
  $('#ic-file-input', B).addEventListener('change', (e) => uploadFiles(e.target));
  return page;
}
nav.openInspCard = openCard;
