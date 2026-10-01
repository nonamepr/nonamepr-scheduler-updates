// 무명기획 스케줄러 — 휴대폰 웹앱 (v3.0)
// PC 앱과 같은 서버 연결 코드(cloud-store.js = src/cloud-store.js 를 감싼 것)를 쓴다.
// 화면: 오늘 · 달력 · 점검 · 회의 · 더보기  (+ 업무 상세, 알림, 반복 업무, 심의 관리 …)

import {
  APP_VERSION, WD, state, api, actor, $, $$, esc, fmt, todayStr, parseDate, addDays, dateLabel, cleanErr,
  PRIO, STAT, isLeave, userById, canManage, coOf, ownerIdsOf, ownerNames, canEditTask, assignerOf,
  toast, confirmSheet, inputSheet, openPage, closeAllPages, ownerPicker, ownerOptions, nav, debounce,
} from './core.js';
import './insp.js';
import './meet.js';
import './more.js';

const SUPABASE_URL = 'https://zqtzyckacbogwicrjshi.supabase.co';
// 공개를 전제로 한 키입니다. 실제 접근 통제는 데이터베이스 권한 규칙(RLS)이 합니다.
const SUPABASE_KEY = 'sb_publishable_5-Y_5LNhF2uSlwiM8twyfg_Vv6ojDgO';
const TOKEN_KEY = 'nm.refresh';
const OLD_SESSION_KEY = 'sb-zqtzyckacbogwicrjshi-auth-token'; // v2.x 웹앱이 쓰던 로그인 저장 자리

// ---------- 서버 연결 ----------
async function connect() {
  // 시험용: 하네스가 가짜 저장소를 넣어 주면 그것을 쓴다
  if (window.__testBackend) {
    api.b = new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : (...a) => window.__testBackend.call(String(name), ...a)) });
    api.test = true;
    window.__appState = state;   // 시험에서 상태 확인용
    return;
  }
  const [{ createClient }, { defineCloudStore }] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'),
    import('./cloud-store.js'),
  ]);
  const CloudStore = defineCloudStore({
    '@supabase/supabase-js': { createClient },
    ws: globalThis.WebSocket,
    crypto: { randomUUID: () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) },
    path: { extname: (n) => { const m = String(n || '').match(/\.[^./\\]+$/); return m ? m[0] : ''; } },
  });
  api.b = new CloudStore(SUPABASE_URL, SUPABASE_KEY);
  api.url = SUPABASE_URL;
  // 서버가 로그인 열쇠를 바꿀 때마다 저장해 둔다 (안 하면 며칠 뒤 로그인이 풀린다)
  api.b.onTokenChange((t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} });
}

function savedToken() {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
    const old = JSON.parse(localStorage.getItem(OLD_SESSION_KEY) || 'null'); // 예전 웹앱 로그인 그대로 이어받기
    return old && old.refresh_token ? old.refresh_token : null;
  } catch { return null; }
}

// ---------- 로그인 ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const pw = $('#login-pw').value;
  const err = $('#login-error');
  if (!email || !pw) { err.textContent = '이메일과 비밀번호를 입력하세요.'; err.classList.remove('hidden'); return; }
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = '로그인 중…';
  try {
    const user = await api.b.login(email, pw);
    $('#login-pw').value = '';
    err.classList.add('hidden');
    try { const t = await api.b.getRefreshToken(); if (t) localStorage.setItem(TOKEN_KEY, t); } catch {}
    await onLoggedIn(user);
  } catch (e2) {
    err.textContent = cleanErr(e2);
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = '로그인';
  }
});

export async function logout() {
  try { await nav.pushOff?.(true); } catch {}
  try { await api.b.logout(); } catch {}
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(OLD_SESSION_KEY); } catch {}
  state.me = null;
  closeAllPages();
  showLogin();
}
nav.logout = logout;

async function onLoggedIn(user) {
  state.me = user;
  state.users = await api.b.listUsers();
  const meRow = state.users.find((u) => u.id === user.id);
  if (meRow) Object.assign(state.me, { name: meRow.name, isAdmin: meRow.isAdmin, isSuper: meRow.isSuper });
  state.visible = await visibleUsers();
  state.owner = actor();
  state.date = todayStr();
  const t = new Date();
  state.calY = t.getFullYear(); state.calM = t.getMonth(); state.calSel = todayStr();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // 반복·점검 업무 미리 만들기 (서버가 한 번만 만든다)
  api.b.generateRecurring(actor()).catch(() => 0);
  await goTab('today');
  refreshBadge();
  if (nav.pushSync) nav.pushSync();
  openFromHash();
}

// 내가 볼 수 있는 사람 (PC 와 같은 규칙: 슈퍼=전원 / 관리자=본인+담당자+보기권한 / 담당자=본인+보기권한)
async function visibleUsers() {
  if (state.me.isSuper) return state.users;
  let grants = [];
  try { grants = await api.b.listGrantsFor(actor()); } catch {}
  const ids = new Set([actor(), ...grants.map((g) => g.ownerId)]);
  if (state.me.isAdmin) for (const u of state.users) if (!u.isAdmin && !u.isSuper) ids.add(u.id);
  return state.users.filter((u) => ids.has(u.id));
}

// ---------- 탭 ----------
const TAB_TITLE = { today: '오늘', cal: '달력', insp: '매체 점검', meet: '회의', more: '더보기' };
export async function goTab(tab) {
  state.tab = tab;
  for (const b of $$('.tab')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const v of $$('.view')) v.classList.toggle('hidden', v.id !== 'v-' + tab);
  $('#ab-title').textContent = TAB_TITLE[tab];
  $('#views').scrollTop = 0;
  if (tab === 'today') await renderToday();
  else if (tab === 'cal') await renderCal();
  else if (tab === 'insp') await nav.inspTab();
  else if (tab === 'meet') await nav.meetTab();
  else if (tab === 'more') await nav.moreTab();
}
nav.goTab = goTab;
for (const b of $$('.tab')) b.addEventListener('click', () => { closeAllPages(); goTab(b.dataset.tab); });
$('#ab-bell').addEventListener('click', () => nav.openNotifs());

// 지금 보이는 화면을 새로 그린다 (다른 화면에서 고친 뒤)
export async function refreshView() {
  if (!state.me) return;
  if (state.tab === 'today') await renderToday();
  else if (state.tab === 'cal') await renderCal();
}
nav.refreshView = refreshView;

// ---------- 알림 배지 ----------
export async function refreshBadge() {
  if (!state.me) return;
  try {
    const list = await api.b.listNotifications(actor(), { onlyUnread: true, limit: 100 });
    const n = list.length;
    const el = $('#ab-badge');
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n <= 0);
    if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch { /* 서버 준비 전이면 조용히 */ }
}
nav.refreshBadge = refreshBadge;
// 화면을 보고 있을 때만 1분마다 확인 (안 읽은 것만 받는다)
setInterval(() => { if (!document.hidden && state.me) refreshBadge(); }, 60000);

// ---------- 오늘 ----------
const listEl = $('#t-list');

$('#t-prev').addEventListener('click', () => { state.date = addDays(state.date, -1); renderToday(); });
$('#t-next').addEventListener('click', () => { state.date = addDays(state.date, 1); renderToday(); });
$('#t-today').addEventListener('click', () => { state.date = todayStr(); renderToday(); });
$('#t-date').addEventListener('click', () => { const i = $('#t-pick'); i.value = state.date; i.showPicker ? i.showPicker() : i.click(); });
$('#t-pick').addEventListener('change', (e) => { if (e.target.value) { state.date = e.target.value; renderToday(); } });
for (const sel of ['#t-owner', '#c-owner']) {
  $(sel).addEventListener('change', (e) => { state.owner = e.target.value; refreshView(); });
}

async function renderToday() {
  const d = parseDate(state.date);
  const isToday = state.date === todayStr();
  $('#t-big').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  $('#t-sub').textContent = `${d.getFullYear()}년 ${WD[d.getDay()]}요일${isToday ? ' · 오늘' : ''}`;
  $('#t-today').classList.toggle('hidden', isToday);
  $('#t-owner-row').classList.toggle('hidden', state.visible.length <= 1);
  $('#t-owner').innerHTML = ownerOptions(state.owner);
  let tasks = [];
  try { tasks = await api.b.listTasks({ actorId: actor(), ownerId: state.owner, from: state.date, to: state.date }); }
  catch (err) { toast(cleanErr(err), true); }
  const day = tasks.filter((t) => t.date === state.date);
  const work = day.filter((t) => !isLeave(t.title));
  const done = work.filter((t) => t.status === 'done').length;
  $('#t-fill').style.width = (work.length ? Math.round((done / work.length) * 100) : 0) + '%';
  $('#t-prog').textContent = work.length ? `${done}/${work.length} 완료` : '—';
  renderTaskList(listEl, day, { emptyText: '할 일이 없습니다.' });
  refreshOverdue();
}

// 업무 목록 그리기 (오늘 탭 · 달력 아래 목록 · 검색 결과에서 같이 씀)
export function renderTaskList(box, tasks, { emptyText = '', showDate = false, onChange } = {}) {
  box.innerHTML = '';
  if (!tasks.length) { box.innerHTML = `<li class="empty">${esc(emptyText)}</li>`; return; }
  const showOwner = state.owner === 'all' || state.owner !== actor();
  for (const t of tasks) {
    const leave = isLeave(t.title);
    const li = document.createElement('li');
    li.className = `item prio-${t.priority}${t.status === 'done' ? ' done' : ''}${leave ? ' leave' : ''}`;
    li.dataset.id = t.id;
    const ids = ownerIdsOf(t);
    const asg = assignerOf(t);
    const meta = [
      showDate ? `<span>${esc(dateLabel(t.date))}</span>` : '',
      (showOwner || ids.length > 1) ? `<span class="owner${ids.length > 1 ? ' multi' : ''}">${ids.length > 1 ? '👥 ' : ''}${esc(ownerNames(ids, true))}</span>` : '',
      t.dueTime ? `<span>⏱ ${esc(t.dueTime)}</span>` : '',
      leave ? '' : `<span>${PRIO[t.priority] || ''}</span>`,
      leave || t.status === 'todo' ? '' : `<span>${STAT[t.status]}</span>`,
      asg ? `<span class="asg">요청: ${esc(asg.name)}</span>` : '',
    ].filter(Boolean).join('');
    li.innerHTML = `${leave ? '' : `<input type="checkbox" class="chk" ${t.status === 'done' ? 'checked' : ''} ${canEditTask(t) ? '' : 'disabled'} aria-label="완료" />`}
      <div class="item-body"><div class="item-title">${esc(t.title)}</div><div class="item-meta">${meta}</div></div>`;
    const chk = li.querySelector('.chk');
    if (chk) {
      chk.addEventListener('change', async () => {
        try {
          await api.b.updateTask(t.id, { actorId: actor(), status: chk.checked ? 'done' : 'todo' });
          t.status = chk.checked ? 'done' : 'todo';
          li.classList.toggle('done', chk.checked);
          if (onChange) onChange(); else refreshView();
        } catch (err) { chk.checked = !chk.checked; toast(cleanErr(err), true); }
      });
    }
    li.querySelector('.item-body').addEventListener('click', () => openTask(t.id));
    box.appendChild(li);
  }
}

// 추가 — 보고 있는 사람에게 (관리자가 남의 일정을 보고 있으면 그 사람에게, 아니면 나에게)
$('#t-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#t-add-input');
  const title = inp.value.trim();
  if (!title) return;
  inp.value = '';
  await addTask(state.date, title);
  await renderToday();
});

export async function addTask(date, title) {
  const owner = state.owner && state.owner !== 'all' && state.me.isAdmin && canManage(state.owner) ? state.owner : actor();
  try {
    await api.b.createTask({ actorId: actor(), ownerId: owner, title, date, priority: 'normal', status: 'todo' });
    if (owner !== actor()) toast(`${ownerNames([owner])} 님 일정에 넣었습니다`);
    return true;
  } catch (err) { toast(cleanErr(err), true); return false; }
}

// 지연(지난 미완료) 업무
let overdue = [];
async function refreshOverdue() {
  try { overdue = await api.b.listOverdue(actor(), state.owner); } catch { overdue = []; }
  $('#t-overdue').classList.toggle('hidden', !overdue.length);
  $('#t-overdue-text').textContent = `지난 미완료 업무 ${overdue.length}건`;
}
$('#t-overdue-show').addEventListener('click', () => nav.openOverdue && nav.openOverdue());
$('#t-overdue-carry').addEventListener('click', async () => {
  const mine = overdue.filter((t) => canManage(t.ownerId) || coOf(t).includes(actor()));
  if (!mine.length) return toast('옮길 수 있는 업무가 없습니다', true);
  if (!(await confirmSheet(`지난 미완료 ${mine.length}건을 오늘로 옮길까요?`, { ok: '오늘로 옮기기' }))) return;
  try {
    const n = await api.b.carryOverdue(actor(), mine.map((t) => t.id));
    toast(`${n}건을 오늘로 옮겼습니다`);
    state.date = todayStr();
    await renderToday();
  } catch (err) { toast(cleanErr(err), true); }
});

// ---------- 달력 ----------
$('#c-prev').addEventListener('click', () => shiftMonth(-1));
$('#c-next').addEventListener('click', () => shiftMonth(1));
$('#c-today').addEventListener('click', () => {
  const t = new Date(); state.calY = t.getFullYear(); state.calM = t.getMonth(); state.calSel = todayStr(); renderCal();
});
function shiftMonth(n) {
  let m = state.calM + n, y = state.calY;
  if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
  state.calY = y; state.calM = m;
  state.calSel = fmt(y, m, 1);
  renderCal();
}
// 달력 화면에서도 좌우로 밀어서 달 넘기기
(() => {
  let x0 = null, y0 = null;
  const g = $('#c-grid');
  g.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  g.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
  });
})();

let calTasks = [];
async function renderCal() {
  $('#c-month').textContent = `${state.calY}년 ${state.calM + 1}월`;
  $('#c-owner-row').classList.toggle('hidden', state.visible.length <= 1);
  $('#c-owner').innerHTML = ownerOptions(state.owner);
  const first = new Date(state.calY, state.calM, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const from = fmt(start.getFullYear(), start.getMonth(), start.getDate());
  const to = addDays(from, 41);
  try { calTasks = await api.b.listTasks({ actorId: actor(), ownerId: state.owner, from, to }); }
  catch (err) { calTasks = []; toast(cleanErr(err), true); }
  const byDate = {};
  for (const t of calTasks) (byDate[t.date] = byDate[t.date] || []).push(t);
  const grid = $('#c-grid');
  grid.innerHTML = WD.map((w, i) => `<div class="c-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`).join('');
  const today = todayStr();
  if (!state.calSel || state.calSel < from || state.calSel > to) state.calSel = fmt(state.calY, state.calM, 1);
  for (let i = 0; i < 42; i++) {
    const ds = addDays(from, i);
    const d = parseDate(ds);
    const list = byDate[ds] || [];
    const cell = document.createElement('button');
    cell.className = 'c-cell' + (d.getMonth() !== state.calM ? ' other' : '') + (d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : '')
      + (ds === today ? ' today' : '') + (ds === state.calSel ? ' sel' : '');
    cell.dataset.date = ds;
    const shown = list.slice(0, 3);
    cell.innerHTML = `<span class="c-num">${d.getDate()}</span>
      ${shown.map((t) => `<span class="c-bar ${isLeave(t.title) ? 'leave' : 'p-' + t.priority}${t.status === 'done' ? ' done' : ''}">${esc(t.title)}</span>`).join('')}
      ${list.length > 3 ? `<span class="c-more">+${list.length - 3}</span>` : ''}`;
    cell.addEventListener('click', () => { state.calSel = ds; renderCalDay(); for (const c of $$('.c-cell')) c.classList.toggle('sel', c.dataset.date === ds); });
    grid.appendChild(cell);
  }
  renderCalDay();
}

function renderCalDay() {
  const ds = state.calSel;
  $('#c-day-title').textContent = dateLabel(ds) + (ds === todayStr() ? ' · 오늘' : '');
  const day = calTasks.filter((t) => t.date === ds);
  renderTaskList($('#c-day-list'), day, { emptyText: '이 날은 업무가 없습니다.', onChange: () => renderCal() });
}
$('#c-add').addEventListener('click', async () => {
  const title = await inputSheet({ title: `${dateLabel(state.calSel)}에 업무 추가`, placeholder: '할 일 입력', ok: '추가' });
  if (!title || !title.trim()) return;
  if (await addTask(state.calSel, title.trim())) renderCal();
});
$('#c-goday').addEventListener('click', () => { state.date = state.calSel; goTab('today'); });

// ---------- 업무 상세 ----------
export async function openTask(id, force = false) {
  let t;
  try { t = await api.b.getTask(id, actor()); }
  catch (err) { return toast(cleanErr(err), true); }
  // 회의 업무 → 회의록, 점검 업무 → 점검 카드 (PC 와 같음)
  const isMeet = !!t.recurringId && String(t.title || '').startsWith('회의_');
  if (!force && isMeet) return nav.openMeeting(t.recurringId, t.date);
  const card = t.recurringId && !isMeet ? await nav.findInspByRule(t.recurringId) : null;
  if (!force && card) return nav.openInspCard(card.id, { taskId: t.id });

  const ro = !!t.readOnly;
  const canDel = t.canDelete !== undefined ? !!t.canDelete : !ro;
  const asg = assignerOf(t);
  const ids = ownerIdsOf(t);
  const editOwners = state.me.isAdmin && canManage(t.ownerId);
  let delTask = null;   // 아래 build 안에서 채운다 (오른쪽 위 '삭제' 버튼이 부른다)
  openPage({
    title: '업무 상세',
    right: canDel ? [{ label: '삭제', danger: true, onClick: () => delTask && delTask() }] : [],
    build(body, page) {
      body.innerHTML = `
        ${ro ? '<p class="note warn">보기만 할 수 있는 업무입니다.</p>' : ''}
        ${asg ? `<p class="note">${esc(asg.name)} 님이 요청한 업무입니다.</p>` : ''}
        ${card ? '<button class="link-row" data-go="insp">🗂 점검 카드 열기 ›</button>' : ''}
        ${isMeet ? '<button class="link-row" data-go="meet">🗒 회의록 열기 ›</button>' : ''}
        ${String(t.sourceKey || '').startsWith('review:') ? '<button class="link-row" data-go="review">🛡 심의 관리에서 보기 ›</button>' : ''}
        <input class="title-input" id="d-title" value="${esc(t.title)}" placeholder="제목" ${ro ? 'disabled' : ''} />
        <div class="fld-grid">
          <label class="fld">날짜<input id="d-date" type="date" class="input" value="${esc(t.date)}" ${ro ? 'disabled' : ''} /></label>
          <label class="fld">시간·소요<input id="d-time" class="input" value="${esc(t.dueTime || '')}" placeholder="예: 14:00, 2시간" ${ro ? 'disabled' : ''} /></label>
          <label class="fld">우선순위<select id="d-prio" class="input" ${ro ? 'disabled' : ''}>
            ${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="fld">상태<select id="d-status" class="input" ${ro ? 'disabled' : ''}>
            ${Object.entries(STAT).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <div class="fld">담당자
          ${editOwners ? '<div id="d-owners" class="op-box"></div><p class="hint">누르면 추가·빼기 · ★ 대표 · 길게 누르면 대표로</p>'
            : `<div class="owner-text">${ids.length > 1 ? '👥 ' : ''}${esc(ownerNames(ids))}</div>`}
        </div>
        <label class="fld">특이사항<textarea id="d-notes" class="input notes" rows="7" placeholder="메모를 자유롭게 적으세요" ${ro ? 'disabled' : ''}>${esc(t.notes || '')}</textarea></label>
        <p id="d-saved" class="saved"></p>`;
      const saved = $('#d-saved', body);
      const save = async (patch) => {
        if (ro) return;
        try {
          await api.b.updateTask(t.id, { actorId: actor(), ...patch });
          Object.assign(t, patch);
          saved.textContent = '저장됨 ✓';
          setTimeout(() => { saved.textContent = ''; }, 1500);
        } catch (err) { toast(cleanErr(err), true); }
      };
      $('#d-title', body).addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) save({ title: v }); else e.target.value = t.title; });
      $('#d-date', body).addEventListener('change', (e) => { if (e.target.value) save({ date: e.target.value }); });
      $('#d-time', body).addEventListener('change', (e) => save({ dueTime: e.target.value.trim() }));
      $('#d-prio', body).addEventListener('change', (e) => save({ priority: e.target.value }));
      $('#d-status', body).addEventListener('change', (e) => save({ status: e.target.value }));
      const notes = $('#d-notes', body);
      const saveNotes = debounce(() => save({ notes: notes.value }), 700);
      notes.addEventListener('input', saveNotes);
      page.onClose = async () => { if (!ro && notes.value !== (t.notes || '')) await save({ notes: notes.value }); await refreshView(); };
      if (editOwners) {
        const pickable = state.users.filter((u) => canManage(u.id) || ids.includes(u.id));
        ownerPicker($('#d-owners', body), { users: pickable, selected: ids, onChange: (next) => save({ ownerId: next[0], coOwnerIds: next.slice(1) }) });
      }
      for (const b of $$('[data-go]', body)) {
        b.addEventListener('click', async () => {
          await page.close();
          if (b.dataset.go === 'insp') nav.openInspCard(card.id, { taskId: t.id });
          else if (b.dataset.go === 'meet') nav.openMeeting(t.recurringId, t.date);
          else nav.openReviews();
        });
      }
      delTask = async function () {
        if (!(await confirmSheet('이 업무를 삭제할까요?', { ok: '삭제', danger: true }))) return;
        try {
          await api.b.removeTask(t.id, actor());
          page.onClose = () => refreshView();
          await page.close();
          toast('삭제했습니다');
        } catch (err) { toast(cleanErr(err), true); }
      };
    },
  });
}
nav.openTask = openTask;
nav.renderTaskList = renderTaskList;

// ---------- 알림을 눌러 들어왔을 때 (#day=… / #insp=… / #meet=…) ----------
function openFromHash(hash = location.hash) {
  const m = String(hash || '').match(/^#(day|insp|meet)=([^&]+)(?:&date=(\d{4}-\d{2}-\d{2}))?/);
  if (!m || !state.me) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  closeAllPages();
  if (m[1] === 'day') { state.date = decodeURIComponent(m[2]); goTab('today'); }
  else if (m[1] === 'insp') nav.openInspCard(decodeURIComponent(m[2]), { focus: 'comments' });
  else if (m[1] === 'meet') nav.openMeeting(decodeURIComponent(m[2]), m[3] || null);
  refreshBadge();
}
window.addEventListener('hashchange', () => openFromHash());
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open') openFromHash(new URL(e.data.url).hash);
  });
}

// 앱으로 돌아오면 최신으로
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.me) return;
  if (!document.querySelector('.page.on')) refreshView();
  refreshBadge();
});

// ---------- 시작 ----------
$('#app-version').textContent = 'v' + APP_VERSION;
(async () => {
  try { await connect(); }
  catch (err) {
    showLogin();
    $('#login-error').textContent = '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 열어 주세요.';
    $('#login-error').classList.remove('hidden');
    return;
  }
  const token = savedToken();
  let user = null;
  if (token) { try { user = await api.b.restoreSession(token); } catch { user = null; } }
  if (user) {
    try { const t = await api.b.getRefreshToken(); if (t) localStorage.setItem(TOKEN_KEY, t); } catch {}
    try { localStorage.removeItem(OLD_SESSION_KEY); } catch {}
    await onLoggedIn(user);
  } else showLogin();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
