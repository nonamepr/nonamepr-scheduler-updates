// 휴대폰 웹앱 공용 부품 — 상태 · 날짜 · 화면 도구(알림창·확인창·입력창·페이지) · 담당자 고르기
// 서버 조회·저장은 PC 와 같은 코드(cloud-store.js)를 api 로 쓴다.

export const APP_VERSION = '3.0.0';
export const WD = ['일', '월', '화', '수', '목', '금', '토'];

export const state = {
  me: null,          // 로그인한 사람 (id, name, isAdmin, isSuper, loginId)
  users: [],         // 직원 전체
  visible: [],       // 내가 일정을 볼 수 있는 사람
  owner: null,       // 오늘·달력에서 보는 사람 (사람 id 또는 'all')
  date: null,        // 오늘 탭에서 보는 날짜
  calY: 0, calM: 0,  // 달력 탭의 연·월
  calSel: null,      // 달력에서 고른 날짜
  tab: 'today',
  inspItems: null,   // 점검 카드 목록 (한 번 받아 두고 씀)
};

export const api = { b: null };   // api.b = PC 와 같은 CloudStore (시험 때는 가짜 저장소)
export const actor = () => (state.me ? state.me.id : null);

// ---------- 글자·날짜 ----------
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function fmt(y, m, d) { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
// 날짜는 항상 휴대폰 시각(한국) 기준으로 만든다 — toISOString() 은 UTC 라 새벽에 전날로 밀린다
export function todayStr() { const d = new Date(); return fmt(d.getFullYear(), d.getMonth(), d.getDate()); }
export function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return fmt(d.getFullYear(), d.getMonth(), d.getDate()); }
export function dateLabel(s) { const d = parseDate(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`; }
export const shortDate = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
export function timeAgo(iso) {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}시간 전`;
  const days = Math.floor(mins / (60 * 24));
  if (days < 7) return `${days}일 전`;
  return fmt(d.getFullYear(), d.getMonth(), d.getDate());
}
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function cleanErr(e) {
  const m = String((e && e.message) || e || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '인터넷 연결을 확인해 주세요.';
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || '문제가 생겼습니다.';
}
export const PRIO = { high: '높음', normal: '보통', low: '낮음' };
export const STAT = { todo: '할 일', doing: '진행중', done: '완료' };
// 휴가: 정확히 이 단어일 때만 (예: "연차 정산 보고서" 는 일반 업무)
const LEAVE = ['연차', '오전반차', '오후반차'];
export const isLeave = (t) => LEAVE.includes(String(t || '').trim());

// ---------- 권한 (화면 표시용 — 실제 차단은 서버가 한다) ----------
export const userById = () => Object.fromEntries(state.users.map((u) => [u.id, u]));
export function canManage(ownerId) {
  const me = state.me;
  if (!me) return false;
  if (ownerId === me.id || me.isSuper) return true;
  if (me.isAdmin) { const o = state.users.find((u) => u.id === ownerId); return !!o && !o.isAdmin && !o.isSuper; }
  return false;
}
export const coOf = (x) => (Array.isArray(x && x.coOwnerIds) ? x.coOwnerIds : []);
export const ownerIdsOf = (t) => [t.ownerId, ...coOf(t).filter((id) => id !== t.ownerId)].filter(Boolean);
export function ownerNames(ids, short) {
  const ub = userById();
  const names = ids.map((id) => ub[id]).filter(Boolean).map((u) => u.name);
  if (short && names.length > 2) return `${names[0]} 외 ${names.length - 1}`;
  return names.join('·');
}
export function canEditTask(t) { return canManage(t.ownerId) || coOf(t).includes(actor()); }
// '요청한 사람' — 대표 본인이 함께 담당만 붙인 경우는 요청이 아니다
export function assignerOf(t) {
  if (!t.assignedBy) return null;
  if (t.assignedBy === t.ownerId && t.ownerId === actor()) return null;
  return userById()[t.assignedBy] || null;
}

// ---------- 알림창(토스트) ----------
export function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), err ? 3200 : 2200);
}

// ---------- 아래에서 올라오는 창(시트) ----------
// 확인·입력·폼을 모두 이것으로 띄운다 (window.confirm/prompt 는 쓰지 않는다)
export function sheet({ title = '', html = '', onMount, wide = false } = {}) {
  const root = document.createElement('div');
  root.className = 'sheet-back';
  root.innerHTML = `<div class="sheet${wide ? ' wide' : ''}" role="dialog">
      ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
      <div class="sheet-body">${html}</div>
    </div>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('on'));
  let closed = false;
  const api2 = {
    el: root.querySelector('.sheet'),
    close() {
      if (closed) return;
      closed = true;
      root.classList.remove('on');
      setTimeout(() => root.remove(), 180);
      if (api2.onClose) api2.onClose();
    },
    onClose: null,
  };
  root.addEventListener('click', (e) => { if (e.target === root) api2.close(); });
  if (onMount) onMount(api2.el, api2);
  return api2;
}

export function confirmSheet(text, { ok = '확인', danger = false, cancel = '취소' } = {}) {
  return new Promise((resolve) => {
    const s = sheet({
      html: `<p class="sheet-text">${esc(text).replace(/\n/g, '<br>')}</p>
        <div class="sheet-btns"><button class="btn ghost" data-a="no">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(ok)}</button></div>`,
    });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.close(); resolve(v); };
    s.onClose = () => fin(false);
    s.el.querySelector('[data-a="no"]').onclick = () => fin(false);
    s.el.querySelector('[data-a="yes"]').onclick = () => fin(true);
  });
}

// 글 입력 (취소하면 null). extra: [{label, value, danger}] 추가 버튼 → 그 value 를 돌려준다
export function inputSheet({ title, value = '', placeholder = '', multiline = false, type = 'text', ok = '저장', extra = [] }) {
  return new Promise((resolve) => {
    const field = multiline
      ? `<textarea class="input sheet-input" rows="5" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input sheet-input" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" enterkeyhint="done" />`;
    const s = sheet({
      title,
      html: `${field}
        <div class="sheet-btns">
          ${extra.map((x, i) => `<button class="btn ${x.danger ? 'danger-ghost' : 'ghost'}" data-x="${i}">${esc(x.label)}</button>`).join('')}
          <button class="btn ghost" data-a="no">취소</button>
          <button class="btn primary" data-a="yes">${esc(ok)}</button></div>`,
    });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.close(); resolve(v); };
    s.onClose = () => fin(null);
    const inp = s.el.querySelector('.sheet-input');
    s.el.querySelector('[data-a="no"]').onclick = () => fin(null);
    s.el.querySelector('[data-a="yes"]').onclick = () => fin(inp.value);
    for (const b of s.el.querySelectorAll('[data-x]')) b.onclick = () => fin(extra[Number(b.dataset.x)].value);
    if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fin(inp.value); } });
    setTimeout(() => { inp.focus(); if (!multiline && inp.select && type === 'text') inp.select(); }, 60);
  });
}

// 고르기 (목록 중 하나)
export function pickSheet(title, options) {
  return new Promise((resolve) => {
    const s = sheet({
      title,
      html: `<div class="pick-list">${options.map((o, i) => `<button class="pick-item${o.danger ? ' danger' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}</div>
        <div class="sheet-btns"><button class="btn ghost" data-a="no">닫기</button></div>`,
    });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.close(); resolve(v); };
    s.onClose = () => fin(null);
    s.el.querySelector('[data-a="no"]').onclick = () => fin(null);
    for (const b of s.el.querySelectorAll('[data-i]')) b.onclick = () => fin(options[Number(b.dataset.i)].value);
  });
}

// ---------- 페이지 (오른쪽에서 덮는 화면, 휴대폰 '뒤로' 버튼으로 닫힘) ----------
const pageStack = [];
export function openPage({ title, cls = '', right = null, build, onClose }) {
  const el = document.createElement('section');
  el.className = 'page ' + cls;
  el.innerHTML = `<header class="page-head">
      <button class="page-back" aria-label="뒤로">‹</button>
      <h2 class="page-title">${esc(title)}</h2>
      <div class="page-right"></div>
    </header>
    <div class="page-body"></div>`;
  document.body.appendChild(el);
  const page = {
    el,
    body: el.querySelector('.page-body'),
    setTitle(t) { el.querySelector('.page-title').textContent = t; },
    setRight(btns) {
      const box = el.querySelector('.page-right');
      box.innerHTML = '';
      for (const b of btns || []) {
        const x = document.createElement('button');
        x.className = 'page-act' + (b.danger ? ' danger' : '');
        x.textContent = b.label;
        x.onclick = b.onClick;
        box.appendChild(x);
      }
    },
    close: () => closePage(page),
    onClose,
    closed: false,
  };
  page.setRight(right);
  el.querySelector('.page-back').onclick = () => closePage(page);
  pageStack.push(page);
  history.pushState({ page: pageStack.length }, '');
  requestAnimationFrame(() => el.classList.add('on'));
  if (build) build(page.body, page);
  return page;
}

export async function closePage(page, fromHistory = false) {
  if (!page || page.closed) return;
  page.closed = true;
  const i = pageStack.indexOf(page);
  if (i >= 0) pageStack.splice(i, 1);
  if (page.onClose) { try { await page.onClose(); } catch (e) { console.error(e); } }
  page.el.classList.remove('on');
  setTimeout(() => page.el.remove(), 200);
  if (!fromHistory) { skipPop++; history.back(); }
}
export function closeAllPages() { while (pageStack.length) closePage(pageStack[pageStack.length - 1]); }
export const topPage = () => pageStack[pageStack.length - 1] || null;

let skipPop = 0;
window.addEventListener('popstate', () => {
  if (skipPop) { skipPop--; return; }
  // 열린 시트가 있으면 시트부터 닫는다
  const sh = document.querySelector('.sheet-back.on');
  if (sh) { sh.click(); history.pushState({}, ''); return; }
  const p = topPage();
  if (p) closePage(p, true);
});

// ---------- 담당자 고르기 칩 ----------
// 누르면 추가·빼기, 먼저 고른 사람이 ★대표. 고른 칩을 '길게' 누르면 대표로 올린다.
export function ownerPicker(box, o) {
  let sel = [...new Set((o.selected || []).filter(Boolean))];
  const draw = () => {
    box.innerHTML = '';
    for (const u of o.users) {
      const i = sel.indexOf(u.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'op-chip' + (i >= 0 ? ' on' : '') + (i === 0 && !o.noLead ? ' lead' : '');
      b.textContent = (i === 0 && !o.noLead ? '★ ' : '') + u.name + (u.id === actor() ? ' (나)' : '');
      b.dataset.id = u.id;
      b.disabled = !!o.disabled;
      let timer = null; let long = false;
      b.addEventListener('pointerdown', () => {
        long = false;
        if (o.noLead) return;
        timer = setTimeout(() => {
          if (!sel.includes(u.id) || sel[0] === u.id) return;
          long = true;
          sel = [u.id, ...sel.filter((x) => x !== u.id)];
          draw();
          toast(`${u.name} 님을 대표로 바꿨습니다`);
          if (o.onChange) o.onChange([...sel]);
        }, 550);
      });
      const cancel = () => clearTimeout(timer);
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointerleave', cancel);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (long) { long = false; return; }
        const at = sel.indexOf(u.id);
        if (at >= 0) {
          if (sel.length === 1 && !o.allowEmpty) return toast('담당자는 한 명 이상이어야 합니다', true);
          sel.splice(at, 1);
        } else sel.push(u.id);
        draw();
        if (o.onChange) o.onChange([...sel]);
      });
      box.appendChild(b);
    }
  };
  draw();
  return { get: () => [...sel], set: (ids) => { sel = [...new Set((ids || []).filter(Boolean))]; draw(); } };
}

// 사람 고르기 select 의 option 들 (나 / 전체 / 각자)
export function ownerOptions(selected) {
  const opts = [`<option value="${actor()}">나 (${esc(state.me.name)})</option>`];
  if (state.visible.length > 1) opts.push('<option value="all">전체 보기</option>');
  for (const u of state.visible) if (u.id !== actor()) opts.push(`<option value="${u.id}">${esc(u.name)}</option>`);
  return opts.join('').replace(`value="${selected}"`, `value="${selected}" selected`);
}

// 탭·화면끼리 서로 부르기 (순환 import 를 피하려고 이름으로 등록)
export const nav = {};
