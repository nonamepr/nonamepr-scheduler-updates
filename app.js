import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// 데스크탑 앱과 동일한 서버·키를 사용한다.
// 이 키는 공개를 전제로 설계된 것이며, 실제 접근 통제는 데이터베이스(RLS)가 한다.
const SUPABASE_URL = 'https://zqtzyckacbogwicrjshi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_5-Y_5LNhF2uSlwiM8twyfg_Vv6ojDgO';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }, // 로그인 유지
});

const $ = (s) => document.querySelector(s);
const WD = ['일', '월', '화', '수', '목', '금', '토'];

const state = { me: null, date: today(), tasks: [], detailId: null };

// ---------- 날짜 (로컬 기준) ----------
function today() {
  const d = new Date();
  return fmt(d.getFullYear(), d.getMonth(), d.getDate());
}
function fmt(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}
function show(id) {
  for (const s of ['#login', '#main']) $(s).classList.toggle('hidden', s !== id);
}
function msgOf(e) {
  const m = String(e && e.message ? e.message : e);
  if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (/Email not confirmed/i.test(m)) return '이메일 인증이 안 된 계정입니다. 관리자에게 문의하세요.';
  if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인해 주세요.';
  return m;
}

// ---------- 로그인 ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const pw = $('#login-pw').value;
  const err = $('#login-error');
  if (!email || !pw) {
    err.textContent = '이메일과 비밀번호를 입력하세요.';
    return err.classList.remove('hidden');
  }
  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = '로그인 중…';
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) throw error;
    $('#login-pw').value = '';
    err.classList.add('hidden');
    await start();
  } catch (e2) {
    err.textContent = msgOf(e2);
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
});

async function start() {
  const { data } = await sb.auth.getUser();
  if (!data || !data.user) return show('#login');

  const { data: prof } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
  state.me = { id: data.user.id, name: (prof && prof.name) || data.user.email, email: data.user.email };
  $('#me-name').textContent = `${state.me.name} (${state.me.email})`;

  show('#main');
  await load();
}

// ---------- 조회 ----------
async function load() {
  renderDate();
  // 휴대폰에서는 "내 할 일"만 본다 (확인·체크 용도)
  const { data, error } = await sb
    .from('tasks').select('*')
    .eq('owner_id', state.me.id)
    .eq('date', state.date);

  if (error) return toast(msgOf(error), true);

  const prio = { high: 0, normal: 1, low: 2 };
  state.tasks = (data || []).sort((a, b) => {
    if (prio[a.priority] !== prio[b.priority]) return prio[a.priority] - prio[b.priority];
    return (a.created_at || '').localeCompare(b.created_at || '');
  });
  render();
}

function renderDate() {
  const d = parse(state.date);
  const isToday = state.date === today();
  $('#date-big').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  $('#date-sub').textContent =
    `${d.getFullYear()}년 ${WD[d.getDay()]}요일` + (isToday ? ' · 오늘' : '');
}

const PRIO = { high: '높음', normal: '보통', low: '낮음' };
const STAT = { todo: '할 일', doing: '진행중', done: '완료' };

// 휴가 항목은 '완료' 대상이 아니므로 체크박스 없이 빨간색으로 표시한다.
// 정확히 이 단어만 인식한다 ("연차 정산 보고서" 같은 일반 업무는 제외)
const LEAVE_WORDS = ['연차', '오전반차', '오후반차'];
const isLeave = (title) => LEAVE_WORDS.includes(String(title || '').trim());


function render() {
  const list = $('#list');
  list.innerHTML = '';
  $('#empty').classList.toggle('hidden', state.tasks.length > 0);

  // 진행률은 휴가를 뺀 실제 업무만으로 계산한다
  const work = state.tasks.filter((t) => !isLeave(t.title));
  const done = work.filter((t) => t.status === 'done').length;
  const pct = work.length ? Math.round((done / work.length) * 100) : 0;
  $('#bar-fill').style.width = pct + '%';
  $('#progress-text').textContent = work.length ? `${done}/${work.length}` : '—';

  for (const t of state.tasks) {
    const leave = isLeave(t.title);
    const li = document.createElement('li');
    li.className = `item prio-${t.priority}${t.status === 'done' ? ' done' : ''}${leave ? ' leave' : ''}`;

    // 휴가는 완료 개념이 없으므로 체크박스를 만들지 않는다
    let chk = null;
    if (!leave) {
      chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'chk';
      chk.checked = t.status === 'done';
    }

    const body = document.createElement('div');
    body.className = 'item-body';
    const meta = leave
      ? [t.notes ? '📝' : ''].filter(Boolean)
      : [
          t.due_time ? '⏱ ' + t.due_time : '',
          PRIO[t.priority],
          STAT[t.status],
          t.notes ? '📝' : '',
        ].filter(Boolean);
    body.innerHTML = `<div class="item-title"></div><div class="item-meta">${
      meta.map((m) => `<span>${m}</span>`).join('')
    }</div>`;
    body.querySelector('.item-title').textContent = t.title;

    body.addEventListener('click', () => openDetail(t));

    if (chk) {
      chk.addEventListener('change', () =>
        update(t.id, { status: chk.checked ? 'done' : 'todo' }));
      li.append(chk, body);
    } else {
      li.append(body);
    }
    list.appendChild(li);
  }
}

// ---------- 날짜 이동 ----------
$('#day-prev').addEventListener('click', () => shift(-1));
$('#day-next').addEventListener('click', () => shift(1));
$('#btn-today').addEventListener('click', () => { state.date = today(); load(); });
function shift(n) {
  const d = parse(state.date);
  d.setDate(d.getDate() + n);
  state.date = fmt(d.getFullYear(), d.getMonth(), d.getDate());
  load();
}

// ---------- 추가 ----------
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#add-input').value.trim();
  if (!title) return;
  $('#add-input').value = '';
  const { error } = await sb.from('tasks').insert({
    owner_id: state.me.id, title, date: state.date, priority: 'normal', status: 'todo',
  });
  if (error) return toast(msgOf(error), true);
  await load();
});

async function update(id, patch) {
  const { error } = await sb.from('tasks')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return toast(msgOf(error), true);
  await load();
}

// ---------- 상세 ----------
function openDetail(t) {
  state.detailId = t.id;
  $('#d-title').value = t.title;
  $('#d-date').value = t.date;
  $('#d-time').value = t.due_time || '';
  $('#d-priority').value = t.priority;
  $('#d-status').value = t.status;
  $('#d-notes').value = t.notes || '';
  $('#d-saved').textContent = '';
  $('#detail').classList.remove('hidden');
}
function closeDetail() {
  state.detailId = null;
  $('#detail').classList.add('hidden');
  load();
}
$('#detail-back').addEventListener('click', closeDetail);

async function saveDetail(patch) {
  if (!state.detailId) return;
  const { error } = await sb.from('tasks')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', state.detailId);
  if (error) return toast(msgOf(error), true);
  $('#d-saved').textContent = '저장됨 ✓';
  setTimeout(() => { $('#d-saved').textContent = ''; }, 1500);
}
$('#d-title').addEventListener('change', (e) => saveDetail({ title: e.target.value.trim() }));
$('#d-date').addEventListener('change', (e) => saveDetail({ date: e.target.value }));
$('#d-time').addEventListener('change', (e) => saveDetail({ due_time: e.target.value }));
$('#d-priority').addEventListener('change', (e) => saveDetail({ priority: e.target.value }));
$('#d-status').addEventListener('change', (e) => saveDetail({ status: e.target.value }));
let notesTimer = null;
$('#d-notes').addEventListener('input', (e) => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => saveDetail({ notes: e.target.value }), 600);
});

$('#detail-del').addEventListener('click', async () => {
  if (!state.detailId) return;
  if (!confirm('이 할 일을 삭제할까요?')) return;
  const { error } = await sb.from('tasks').delete().eq('id', state.detailId);
  if (error) return toast(msgOf(error), true);
  closeDetail();
  toast('삭제했습니다');
});

// ---------- 메뉴 ----------
$('#btn-menu').addEventListener('click', () => $('#menu').classList.remove('hidden'));
$('#menu-close').addEventListener('click', () => $('#menu').classList.add('hidden'));
$('#menu').addEventListener('click', (e) => {
  if (e.target.id === 'menu') $('#menu').classList.add('hidden');
});
$('#btn-reload').addEventListener('click', async () => {
  $('#menu').classList.add('hidden');
  await load();
  toast('새로고침 완료');
});
$('#btn-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  state.me = null;
  $('#menu').classList.add('hidden');
  show('#login');
});

// 앱으로 돌아왔을 때 최신으로
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.me) load();
});

// ---------- 시작 ----------
(async () => {
  const { data } = await sb.auth.getSession();
  if (data && data.session) await start();
  else show('#login');
})();

// 오프라인에서도 화면이 뜨도록
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
