// 회의록 (휴대폰) — PC 의 회의 창(src/meetings.js)과 같은 규칙
// 사람별 이번 주 업무(진행 중→완료→보류) · 지난 회의에서 이어 가져오기 · 결정·지시(→ 업무로 보내기) · 회의 메모
// 보기 전용(참석자 아님)은 보기만 하고 회의 메모만 쓴다 (서버도 같은 규칙으로 막는다)

import {
  WD, state, api, actor, $, $$, esc, todayStr, parseDate, fmt, dateLabel, shortDate, cleanErr,
  toast, confirmSheet, canManage, nav,
} from './core.js';

const ST = { doing: '진행 중', done: '완료', hold: '보류' };
const NEXT = { doing: 'done', done: 'hold', hold: 'doing' };

const meet = { pending: null, rules: [], rule: null, date: null, items: [], dates: [], prevDate: null, prevItems: [], timers: new Map(), memoTimer: null, busy: false };

// ---------- 날짜 (반복 규칙과 같은 계산) ----------
function matches(rule, ds) {
  const wd = parseDate(ds).getDay();
  if (rule.ruleType === 'daily') return !(rule.skipWeekend !== false && (wd === 0 || wd === 6));
  if (rule.ruleType === 'weekly') return (rule.weekdays && rule.weekdays.length ? rule.weekdays : [rule.weekday]).map(Number).includes(wd);
  if (rule.ruleType === 'monthly') return parseDate(ds).getDate() === Number(rule.monthday);
  return false;
}
function step(rule, from, dir) {
  const d = parseDate(from);
  for (let i = 0; i < 400; i++) {
    d.setDate(d.getDate() + dir);
    const s = fmt(d.getFullYear(), d.getMonth(), d.getDate());
    if (matches(rule, s)) return s;
  }
  return null;
}
function defaultDate(rule) {
  const t = todayStr();
  if (matches(rule, t)) return t;
  return step(rule, t, -1) || step(rule, t, 1) || t;
}
function neighbor(dir) {
  const cur = meet.date;
  const sched = meet.rule ? step(meet.rule, cur, dir) : null;
  const other = meet.dates.filter((d) => (dir < 0 ? d < cur : d > cur)).sort();
  const near = dir < 0 ? other[other.length - 1] : other[0];
  const c = [sched, near].filter(Boolean).sort();
  if (!c.length) return null;
  return dir < 0 ? c[c.length - 1] : c[0];
}
const canWrite = () => !!(meet.rule && meet.rule.canWrite !== false);

// ---------- 열기 ----------
nav.meetTab = async () => {
  await loadRules();
  const p = meet.pending;
  meet.pending = null;
  if (p) return openMeeting(p.ruleId, p.date);
  if (!meet.rule || !meet.rules.some((r) => r.id === meet.rule.id)) await openMeeting(null, null);
  else { await flush(); await reload(); }
};

async function loadRules() {
  try { meet.rules = await api.b.listMeetingRules(actor()); }
  catch (err) { meet.rules = []; toast(cleanErr(err), true); }
  $('#m-rule').innerHTML = meet.rules.map((r) => `<option value="${r.id}">${esc(r.title)}${r.active ? '' : ' (쉬는 중)'}</option>`).join('');
}

// 다른 화면(업무·알림)에서 특정 회의로 들어올 때
export async function openMeeting(ruleId, date) {
  if (!meet.rules.length) await loadRules();
  await flush();
  const rule = meet.rules.find((r) => r.id === ruleId) || (ruleId ? null : meet.rules.find((r) => r.active) || meet.rules[0]) || null;
  if (ruleId && !rule) toast('이 회의를 볼 수 있는 사람이 아닙니다', true);
  meet.rule = rule || meet.rules.find((r) => r.active) || meet.rules[0] || null;
  const has = !!meet.rule;
  $('#m-empty').classList.toggle('hidden', has);
  $('#m-main').classList.toggle('hidden', !has);
  if (!has) return;
  $('#m-rule').value = meet.rule.id;
  meet.date = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : defaultDate(meet.rule);
  await reload();
  $('#views').scrollTop = 0;
}
nav.openMeeting = async (ruleId, date) => {
  if (state.tab !== 'meet') { meet.pending = { ruleId, date }; return nav.goTab('meet'); }
  return openMeeting(ruleId, date);
};

async function reload() {
  if (!meet.rule) return;
  try {
    const [items, dates] = await Promise.all([
      api.b.listMeetingItems(actor(), meet.rule.id, meet.date),
      api.b.listMeetingDates(actor(), meet.rule.id),
    ]);
    meet.items = items;
    meet.dates = dates;
    meet.prevDate = dates.filter((d) => d < meet.date).sort().pop() || null;
    meet.prevItems = meet.prevDate ? await api.b.listMeetingItems(actor(), meet.rule.id, meet.prevDate) : [];
  } catch (err) { toast(cleanErr(err), true); meet.items = []; meet.prevItems = []; }
  render();
}

$('#m-rule').addEventListener('change', (e) => openMeeting(e.target.value, null));
$('#m-prev').addEventListener('click', async () => { const d = neighbor(-1); if (d) { await flush(); meet.date = d; await reload(); } });
$('#m-next').addEventListener('click', async () => { const d = neighbor(1); if (d) { await flush(); meet.date = d; await reload(); } });
$('#m-now').addEventListener('click', async () => { await flush(); meet.date = defaultDate(meet.rule); await reload(); });
$('#m-reload').addEventListener('click', async () => { await flush(); await reload(); toast('새로 불러왔습니다'); });

// ---------- 그리기 ----------
function attendees() {
  const r = meet.rule;
  const ids = [r.ownerId, ...(r.coOwnerIds || [])].filter(Boolean);
  for (const it of meet.items) if (it.section === 'item' && it.ownerId && !ids.includes(it.ownerId)) ids.push(it.ownerId);
  if (meet.items.some((it) => it.section === 'item' && !it.ownerId)) ids.push(null);
  return ids;
}
function carryCands(ownerId) {
  const taken = new Set(meet.items.map((it) => it.carriedFrom).filter(Boolean));
  return meet.prevItems.filter((p) => p.section === 'item' && p.status !== 'done'
    && (p.ownerId || null) === (ownerId || null) && !taken.has(p.id) && (p.body.trim() || p.note.trim()));
}

function render() {
  const r = meet.rule;
  const rw = canWrite();
  const today = todayStr();
  const tag = meet.date === today ? '<span class="badge now">오늘</span>' : meet.date < today ? '<span class="badge past">지난 회의</span>' : '<span class="badge next">예정</span>';
  $('#m-date').innerHTML = `${esc(dateLabel(meet.date))}${r.dueTime ? ' ' + esc(r.dueTime) : ''} ${tag}`;
  $('#m-readonly').classList.toggle('hidden', rw);
  $('#m-prev').disabled = !neighbor(-1);
  $('#m-next').disabled = !neighbor(1);
  const items = meet.items.filter((it) => it.section === 'item');
  const cnt = (s) => items.filter((it) => it.status === s).length;
  const carried = items.filter((it) => it.carriedFrom).length;
  $('#m-summary').innerHTML = items.length
    ? `업무 <b>${items.length}</b> · 진행 중 ${cnt('doing')} · <span class="ok">완료 ${cnt('done')}</span> · 보류 ${cnt('hold')}${carried ? ` · 이어온 것 ${carried}` : ''}`
    : '아직 적힌 업무가 없습니다. 각자 이번 주 주요 업무를 적어 주세요.';

  const ub = Object.fromEntries(state.users.map((u) => [u.id, u]));
  const box = $('#m-people');
  box.innerHTML = '';
  let anyCarry = 0;
  for (const oid of attendees()) {
    const mine = items.filter((it) => (it.ownerId || null) === oid);
    const u = oid ? ub[oid] : null;
    const cands = carryCands(oid);
    anyCarry += cands.length;
    const card = document.createElement('div');
    card.className = 'person';
    const done = mine.filter((it) => it.status === 'done').length;
    card.innerHTML = `<div class="person-head"><span class="avatar">${esc((u ? u.name : '?').slice(0, 1))}</span><b>${esc(u ? u.name : '담당 없음')}</b>
        <span class="muted">${mine.length ? `${mine.length}건 · 완료 ${done}` : '아직 없음'}</span></div>
      <div class="mi-list"></div>
      ${rw ? `<div class="person-acts"><button class="mini m-add">+ 업무 추가</button>
        ${cands.length ? `<button class="mini m-carry">↪ 지난 회의(${shortDate(meet.prevDate)})에서 이어 가져오기 ${cands.length}</button>` : ''}</div>` : ''}`;
    const list = card.querySelector('.mi-list');
    for (const it of mine) list.appendChild(itemRow(it, rw));
    if (!mine.length && !rw) list.innerHTML = '<p class="empty small">적힌 업무가 없습니다.</p>';
    const add = card.querySelector('.m-add');
    if (add) add.addEventListener('click', () => addItem(oid));
    const cb = card.querySelector('.m-carry');
    if (cb) cb.addEventListener('click', () => carry([oid]));
    box.appendChild(card);
  }
  const all = $('#m-carry-all');
  all.classList.toggle('hidden', !anyCarry || !rw);
  all.textContent = `↪ 지난 회의(${meet.prevDate ? shortDate(meet.prevDate) : ''})에서 안 끝난 것 모두 가져오기 ${anyCarry}`;
  renderDecisions(rw);
  const memo = meet.items.find((it) => it.section === 'memo');
  if (document.activeElement !== $('#m-memo')) $('#m-memo').value = memo ? memo.body : '';
  autoGrow($('#m-memo'));
  $('#m-memo-saved').textContent = '';
}

function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.max(el.scrollHeight, 40) + 'px'; }

// 업무 한 줄: [상태] 내용 / 세부 내용 [n주째] [≡] [✕]
function itemRow(it, rw) {
  const row = document.createElement('div');
  row.className = `mi st-${it.status}`;
  row.dataset.id = it.id;
  row.innerHTML = `<button class="mi-st" ${rw ? '' : 'disabled'}>${ST[it.status]}</button>
    <div class="mi-main">
      <textarea class="mi-body" rows="1" placeholder="업무 내용" ${rw ? '' : 'readonly'}></textarea>
      <textarea class="mi-note ${it.note ? '' : 'hidden'}" rows="1" placeholder="세부 내용 (진행 상황·메모)" ${rw ? '' : 'readonly'}></textarea>
      ${it.carryCount > 0 ? `<span class="mi-carry">${it.carryCount + 1}주째</span>` : ''}
    </div>
    ${rw ? '<div class="mi-btns"><button class="icon-mini mi-note-btn" aria-label="세부 내용">≡</button><button class="icon-mini mi-del" aria-label="지우기">✕</button></div>' : ''}`;
  const body = row.querySelector('.mi-body');
  const note = row.querySelector('.mi-note');
  body.value = it.body;
  note.value = it.note;
  setTimeout(() => { autoGrow(body); if (it.note) autoGrow(note); }, 0);
  if (!rw) return row;
  row.querySelector('.mi-st').addEventListener('click', () => save(it, { status: NEXT[it.status] }, true));
  body.addEventListener('input', () => { autoGrow(body); saveSoon(it, { body: body.value.replace(/\n/g, ' ') }); });
  note.addEventListener('input', () => { autoGrow(note); saveSoon(it, { note: note.value }); });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addItem(it.ownerId || null, it); }
  });
  for (const el of [body, note]) el.addEventListener('blur', () => onBlur(it, row));
  row.querySelector('.mi-note-btn').addEventListener('click', () => { note.classList.remove('hidden'); note.focus(); });
  row.querySelector('.mi-del').addEventListener('click', () => remove(it, false));
  return row;
}

// ---------- 저장 ----------
function saveSoon(it, patch) {
  Object.assign(it, patch);
  clearTimeout(meet.timers.get(it.id));
  meet.timers.set(it.id, setTimeout(() => save(it, { body: it.body, note: it.note }, false), 700));
}
async function save(it, patch, rerender) {
  clearTimeout(meet.timers.get(it.id));
  meet.timers.delete(it.id);
  const send = { ...patch };
  if (send.body !== undefined) send.body = send.body.replace(/\s+$/, '');
  try {
    Object.assign(it, await api.b.updateMeetingItem(actor(), it.id, send));
    if (rerender) render();
  } catch (err) { toast(cleanErr(err), true); }
}
function onBlur(it, row) {
  setTimeout(async () => {
    if (row.contains(document.activeElement)) return;
    if (meet.timers.has(it.id)) await save(it, { body: it.body, note: it.note }, false);
    if (!it.body.trim() && !it.note.trim() && document.body.contains(row)) await remove(it, true);
    else if (!it.note.trim()) row.querySelector('.mi-note').classList.add('hidden');
  }, 0);
}
// 다른 회의로 옮기거나 앱을 내리기 전에 남은 저장을 마친다
async function flush() {
  for (const [id, t] of meet.timers) {
    clearTimeout(t);
    const it = meet.items.find((x) => x.id === id);
    if (it) await api.b.updateMeetingItem(actor(), id, { body: it.body, note: it.note }).catch(() => {});
  }
  meet.timers.clear();
  if (meet.memoTimer) { clearTimeout(meet.memoTimer); meet.memoTimer = null; await saveMemo(); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

async function addItem(ownerId, after) {
  if (!canWrite()) return;
  const mine = meet.items.filter((it) => it.section === 'item' && (it.ownerId || null) === (ownerId || null));
  let sort = mine.length ? Math.max(...mine.map((it) => it.sort)) + 1 : 1;
  if (after) {
    const next = mine.filter((it) => it.sort > after.sort).sort((a, b) => a.sort - b.sort)[0];
    sort = next ? (after.sort + next.sort) / 2 : after.sort + 1;
  }
  try {
    const it = await api.b.createMeetingItem(actor(), { ruleId: meet.rule.id, meetDate: meet.date, section: 'item', ownerId: ownerId || null, body: '', status: 'doing', sort });
    meet.items.push(it);
    meet.items.sort((a, b) => a.sort - b.sort || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
    render();
    const el = document.querySelector(`.mi[data-id="${it.id}"] .mi-body`);
    if (el) el.focus();
  } catch (err) { toast(cleanErr(err), true); }
}

async function remove(it, quiet) {
  if (!quiet && it.body.trim() && !(await confirmSheet(`"${it.body.trim().slice(0, 40)}" 을(를) 지울까요?`, { ok: '지우기', danger: true }))) return;
  clearTimeout(meet.timers.get(it.id));
  meet.timers.delete(it.id);
  try {
    await api.b.removeMeetingItem(actor(), it.id);
    meet.items = meet.items.filter((x) => x.id !== it.id);
    render();
  } catch (err) { toast(cleanErr(err), true); }
}

async function carry(ownerIds) {
  if (meet.busy || !canWrite()) return;
  meet.busy = true;
  let n = 0;
  try {
    for (const oid of ownerIds) {
      let sort = Math.max(0, ...meet.items.filter((it) => it.section === 'item' && (it.ownerId || null) === (oid || null)).map((it) => it.sort));
      for (const p of carryCands(oid)) {
        const it = await api.b.createMeetingItem(actor(), {
          ruleId: meet.rule.id, meetDate: meet.date, section: 'item', ownerId: p.ownerId || null,
          body: p.body, note: p.note, status: p.status, carriedFrom: p.id, carryCount: (p.carryCount || 0) + 1, sort: ++sort,
        });
        meet.items.push(it);
        n++;
      }
    }
    render();
    toast(n ? `지난 회의에서 ${n}건을 이어 가져왔습니다` : '가져올 업무가 없습니다');
  } catch (err) { toast(cleanErr(err), true); await reload(); }
  finally { meet.busy = false; }
}
$('#m-carry-all').addEventListener('click', () => carry(attendees()));

// ---------- 결정·지시 사항 ----------
function renderDecisions(rw) {
  const box = $('#m-decisions');
  box.innerHTML = '';
  $('#m-add-dec').classList.toggle('hidden', !rw);
  const list = meet.items.filter((it) => it.section === 'decision');
  if (!list.length) box.innerHTML = `<p class="empty small">${rw ? '회의에서 정한 일·지시 사항을 적어 두세요.' : '아직 정한 사항이 없습니다.'}</p>`;
  for (const it of list) {
    const row = document.createElement('div');
    row.className = `dec st-${it.status}`;
    row.dataset.id = it.id;
    row.innerHTML = `<div class="dec-top"><button class="mi-st" ${rw ? '' : 'disabled'}>${it.status === 'done' ? '완료' : '할 일'}</button>
        <textarea class="mi-body dec-body" rows="1" placeholder="정한 일·지시 사항" ${rw ? '' : 'readonly'}></textarea>
        ${rw ? '<button class="icon-mini mi-del" aria-label="지우기">✕</button>' : ''}</div>
      <div class="dec-bottom">
        <select class="input dec-owner" ${rw ? '' : 'disabled'}><option value="">담당자</option>${state.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
        <input type="date" class="input dec-due" ${rw ? '' : 'disabled'} />
        ${it.taskId ? '<span class="sent">✓ 업무 등록됨</span>' : rw ? '<button class="mini primary dec-send">업무로 보내기</button>' : ''}
      </div>`;
    const body = row.querySelector('.dec-body');
    body.value = it.body;
    setTimeout(() => autoGrow(body), 0);
    row.querySelector('.dec-owner').value = it.ownerId || '';
    row.querySelector('.dec-due').value = it.dueOn || '';
    if (rw) {
      row.querySelector('.mi-st').addEventListener('click', () => save(it, { status: it.status === 'done' ? 'doing' : 'done' }, true));
      body.addEventListener('input', () => { autoGrow(body); saveSoon(it, { body: body.value.replace(/\n/g, ' ') }); });
      body.addEventListener('blur', () => { if (meet.timers.has(it.id)) save(it, { body: it.body }, false); });
      row.querySelector('.dec-owner').addEventListener('change', (e) => save(it, { ownerId: e.target.value || null }, false));
      row.querySelector('.dec-due').addEventListener('change', (e) => save(it, { dueOn: e.target.value || null }, false));
      row.querySelector('.mi-del').addEventListener('click', () => remove(it, !it.body.trim()));
      const send = row.querySelector('.dec-send');
      if (send) send.addEventListener('click', () => sendTask(it, row));
    }
    box.appendChild(row);
  }
}
$('#m-add-dec').addEventListener('click', async () => {
  const list = meet.items.filter((it) => it.section === 'decision');
  try {
    const it = await api.b.createMeetingItem(actor(), { ruleId: meet.rule.id, meetDate: meet.date, section: 'decision', body: '', status: 'doing', sort: list.length ? Math.max(...list.map((x) => x.sort)) + 1 : 1 });
    meet.items.push(it);
    render();
    const el = document.querySelector(`.dec[data-id="${it.id}"] .dec-body`);
    if (el) el.focus();
  } catch (err) { toast(cleanErr(err), true); }
});

// 지시 사항 → 담당자 스케줄에 업무로
async function sendTask(it, row) {
  const title = row.querySelector('.dec-body').value.trim();
  const owner = row.querySelector('.dec-owner').value;
  const due = row.querySelector('.dec-due').value || todayStr();
  if (!title) return toast('내용을 먼저 적어 주세요', true);
  if (!owner) return toast('담당자를 먼저 고르세요', true);
  if (owner !== actor() && !canManage(owner)) return toast('다른 사람에게 업무를 보내려면 관리자 권한이 필요합니다', true);
  try {
    const task = await api.b.createTask({
      actorId: actor(), ownerId: owner, title, date: due, priority: 'normal', status: 'todo',
      notes: `${meet.rule.title} (${dateLabel(meet.date)}) 회의에서 정한 사항입니다.`,
    });
    await save(it, { body: title, ownerId: owner, dueOn: due, taskId: task.id }, true);
    const u = state.users.find((x) => x.id === owner);
    toast(`${u ? u.name : ''} 님 ${shortDate(due)} 스케줄에 넣었습니다`);
  } catch (err) { toast(cleanErr(err), true); }
}

// ---------- 회의 메모 (보기 전용도 쓸 수 있다) ----------
async function saveMemo() {
  const text = $('#m-memo').value;
  let memo = meet.items.find((it) => it.section === 'memo');
  try {
    if (memo) Object.assign(memo, await api.b.updateMeetingItem(actor(), memo.id, { body: text }));
    else if (text.trim()) {
      memo = await api.b.createMeetingItem(actor(), { ruleId: meet.rule.id, meetDate: meet.date, section: 'memo', body: text });
      meet.items.push(memo);
    }
    $('#m-memo-saved').textContent = '저장됨 ✓';
  } catch (err) { toast(cleanErr(err), true); }
}
$('#m-memo').addEventListener('input', () => {
  autoGrow($('#m-memo'));
  $('#m-memo-saved').textContent = '';
  clearTimeout(meet.memoTimer);
  meet.memoTimer = setTimeout(async () => { meet.memoTimer = null; await saveMemo(); }, 800);
});

// 다른 탭으로 갈 때도 남은 저장을 마친다
for (const b of $$('.tab')) b.addEventListener('click', () => { if (b.dataset.tab !== 'meet') flush(); });
nav.meetFlush = flush;
