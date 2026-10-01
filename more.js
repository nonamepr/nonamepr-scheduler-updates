// 더보기 (휴대폰) — 알림 · 휴대폰 알림 켜기 · 반복 업무 · 심의 관리 · 팀 휴가 · 검색 · 지난 미완료 · 비밀번호 · 로그아웃

import {
  APP_VERSION, WD, state, api, actor, $, $$, esc, todayStr, parseDate, addDays, fmt, dateLabel, cleanErr, timeAgo, debounce,
  toast, confirmSheet, inputSheet, sheet, openPage, closeAllPages, ownerPicker, ownerOptions, canManage, coOf, ownerIdsOf, ownerNames, nav,
} from './core.js';

// ---------- 더보기 탭 ----------
nav.moreTab = async () => {
  const me = state.me;
  const role = me.isSuper ? '슈퍼 관리자' : me.isAdmin ? '관리자' : '담당자';
  $('#mo-me').innerHTML = `<span class="avatar big">${esc(me.name.slice(0, 1))}</span>
    <div><b>${esc(me.name)}</b><div class="muted">${esc(me.loginId || '')} · ${role}</div></div>`;
  let unread = 0;
  try { unread = (await api.b.listNotifications(actor(), { onlyUnread: true, limit: 100 })).length; } catch {}
  $('#mo-notif-n').textContent = unread ? String(unread) : '';
  $('#mo-notif-n').classList.toggle('hidden', !unread);
  await pushRender();
};

const MENU = {
  notif: () => openNotifs(), recur: () => openRecur(), reviews: () => openReviews(), leaves: () => openLeaves(),
  search: () => openSearch(), overdue: () => openOverdue(), pw: () => changePw(),
  reload: async () => {
    try { const r = await navigator.serviceWorker?.getRegistration(); if (r) await r.update(); } catch {}
    location.reload();
  },
  logout: async () => { if (await confirmSheet('로그아웃할까요?\n이 휴대폰으로 오던 알림도 멈춥니다.', { ok: '로그아웃' })) nav.logout(); },
};
for (const b of $$('[data-menu]')) b.addEventListener('click', () => MENU[b.dataset.menu]());
$('#mo-version').textContent = `휴대폰 웹앱 v${APP_VERSION}`;

// ---------- 🔔 알림 ----------
export async function openNotifs() {
  openPage({
    title: '알림',
    right: [{ label: '모두 읽음', onClick: () => readAll() }],
    build: (body, page) => {
      page.onClose = () => { nav.refreshBadge(); if (state.tab === 'more') nav.moreTab(); };
      draw(body);
      async function readAll() {
        try {
          const n = await api.b.markNotificationsRead(actor(), null);
          toast(n ? `알림 ${n}건을 확인 처리했습니다` : '읽지 않은 알림이 없습니다');
          draw(body); nav.refreshBadge();
        } catch (err) { toast(cleanErr(err), true); }
      }
    },
  });
  async function draw(body) {
    let list = [];
    try { list = await api.b.listNotifications(actor(), { limit: 100 }); } catch (err) { toast(cleanErr(err), true); }
    const ub = Object.fromEntries(state.users.map((u) => [u.id, u]));
    body.innerHTML = list.length ? '' : '<p class="empty">알림이 없습니다. 점검 댓글에서 @이름 으로 불리면 여기에 쌓입니다.</p>';
    for (const n of list) {
      const who = ub[n.actorId];
      const row = document.createElement('button');
      row.className = 'notif' + (n.readAt ? ' read' : '');
      row.innerHTML = `<span class="avatar">${esc((who ? who.name : '?').slice(0, 1))}</span>
        <span class="notif-main"><span class="notif-top"><b>${esc(who ? who.name : '누군가')}</b> 님이 회원님을 불렀습니다 <span class="muted">${timeAgo(n.createdAt)}</span></span>
        <span class="notif-card">${esc(n.title)}</span><span class="notif-body">${esc(n.body)}</span></span>
        ${n.readAt ? '' : '<span class="dot"></span>'}`;
      row.addEventListener('click', async () => {
        try { await api.b.markNotificationsRead(actor(), [n.id]); } catch {}
        nav.refreshBadge();
        if (n.inspectionId) nav.openInspCard(n.inspectionId, { focus: 'comments' });
      });
      body.appendChild(row);
    }
  }
}
nav.openNotifs = openNotifs;

// ---------- 📲 휴대폰 알림 (웹 푸시) ----------
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function rpc(name, args) {
  if (api.test) return window.__testBackend.call('rpc', name, args || {});
  const { data, error } = await api.b.sb.rpc(name, args || {});
  if (error) throw new Error(/push_|function|schema cache/i.test(error.message) ? '서버에 휴대폰 알림 준비가 안 됐습니다. 관리자에게 문의하세요.' : error.message);
  return data;
}
async function publicKey() {
  let key = await rpc('push_public_key');
  if (!key && !api.test) {
    // 서버 열쇠가 아직 없으면 발송 함수를 한 번 불러 만들게 한다
    const res = await fetch(`${api.url}/functions/v1/send-push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await res.json().catch(() => ({}));
    key = j.publicKey || (await rpc('push_public_key'));
  }
  if (!key) throw new Error('서버에 휴대폰 알림 준비가 안 됐습니다. 관리자에게 문의하세요.');
  return key;
}
function keyBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function saveSub(sub) {
  const j = sub.toJSON();
  await rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent.slice(0, 300) });
}

async function pushOn() {
  if (!pushSupported()) throw new Error(isIOS && !standalone() ? '홈 화면에 추가한 아이콘으로 열어야 켤 수 있습니다.' : '이 휴대폰(브라우저)은 알림을 지원하지 않습니다.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림이 차단되어 있습니다. 휴대폰 설정에서 이 앱의 알림을 허용해 주세요.');
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('앱 준비가 덜 됐습니다. 앱을 닫았다가 다시 열고 시도해 주세요.')), 8000)),
  ]);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const key = keyBytes(await publicKey());
    try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); }
    catch (e) { throw new Error('이 휴대폰에서 알림 등록에 실패했습니다. 크롬(안드로이드) 또는 홈 화면 앱(아이폰)에서 다시 해 주세요. (' + (e && e.name || '오류') + ')'); }
  }
  await saveSub(sub);
}
async function pushOff(quiet) {
  const sub = await currentSub();
  if (!sub) return;
  try { await rpc('push_unsubscribe', { p_endpoint: sub.endpoint }); } catch (e) { if (!quiet) throw e; }
  await sub.unsubscribe().catch(() => {});
}
nav.pushOff = pushOff;
// 로그인할 때: 이미 켜 둔 휴대폰이면 '지금 로그인한 사람' 것으로 다시 등록 (같은 휴대폰을 다른 사람이 쓰는 경우)
nav.pushSync = async () => {
  try { if (pushSupported() && Notification.permission === 'granted') { const s = await currentSub(); if (s) await saveSub(s); } } catch {}
};

async function pushRender() {
  const box = $('#mo-push');
  const sub = await currentSub().catch(() => null);
  const on = !!sub && pushSupported() && Notification.permission === 'granted';
  let help = '';
  if (!pushSupported()) {
    help = isIOS && !standalone()
      ? '아이폰은 <b>공유 버튼 → 홈 화면에 추가</b> 한 뒤, 그 아이콘으로 열어야 알림을 켤 수 있습니다. (iOS 16.4 이상)'
      : '이 브라우저는 알림을 지원하지 않습니다. 크롬(안드로이드) 또는 홈 화면에 추가한 앱(아이폰)에서 열어 주세요.';
  } else if (Notification.permission === 'denied') {
    help = '알림이 차단되어 있습니다. 휴대폰 <b>설정 → 알림</b>에서 이 앱(또는 크롬)의 알림을 허용한 뒤 다시 눌러 주세요.';
  }
  box.innerHTML = `<div class="menu-row static"><span>📲 휴대폰 알림</span><span class="state ${on ? 'on' : ''}">${on ? '켜짐' : '꺼짐'}</span></div>
    <p class="hint">점검 댓글에서 @이름 으로 불렸을 때, 남이 나에게 업무를 줬을 때 휴대폰으로 알려 줍니다.</p>
    ${help ? `<p class="note warn">${help}</p>` : ''}
    <div class="btn-row">${on ? '<button class="btn ghost" id="mo-push-test">테스트 알림 보내기</button><button class="btn ghost" id="mo-push-off">끄기</button>'
      : `<button class="btn primary" id="mo-push-on" ${pushSupported() && Notification.permission !== 'denied' ? '' : 'disabled'}>휴대폰 알림 켜기</button>`}</div>`;
  const onBtn = $('#mo-push-on', box);
  if (onBtn) onBtn.addEventListener('click', async () => {
    onBtn.disabled = true; onBtn.textContent = '켜는 중…';
    try { await pushOn(); toast('휴대폰 알림을 켰습니다'); await rpc('push_test').catch(() => {}); }
    catch (err) { toast(cleanErr(err), true); }
    pushRender();
  });
  const off = $('#mo-push-off', box);
  if (off) off.addEventListener('click', async () => {
    try { await pushOff(false); toast('휴대폰 알림을 껐습니다'); } catch (err) { toast(cleanErr(err), true); }
    pushRender();
  });
  const test = $('#mo-push-test', box);
  if (test) test.addEventListener('click', async () => {
    try { await saveSub(sub); await rpc('push_test'); toast('보냈습니다. 몇 초 안에 알림이 와야 합니다'); }
    catch (err) { toast(cleanErr(err), true); }
  });
}

// ---------- 🔁 반복 업무 ----------
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
function whenText(r) {
  if (r.ruleType === 'daily') return r.skipWeekend === false ? '매일' : '매일(평일)';
  if (r.ruleType === 'monthly') return `매월 ${r.monthday}일`;
  const days = (r.weekdays && r.weekdays.length ? r.weekdays : [r.weekday]).map(Number);
  const sorted = WD_ORDER.filter((d) => days.includes(d));
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d))) return '매주 월~금';
  return `매주 ${sorted.map((d) => WD[d]).join('·')}${sorted.length === 1 ? '요일' : ''}`;
}

export function openRecur() {
  let who = actor();
  openPage({
    title: '반복 업무',
    right: [{ label: '+ 등록', onClick: () => recurForm(null, draw) }],
    build: (body) => {
      body.innerHTML = `${state.visible.length > 1 ? `<label class="owner-row">보는 사람 <select class="input" id="rc-who">${ownerOptions(who)}</select></label>` : ''}
        <p class="hint">정해 둔 주기마다 스케줄에 업무가 자동으로 들어갑니다. '회의'로 등록하면 회의록이 생깁니다.</p>
        <div id="rc-list"></div>`;
      const sel = $('#rc-who', body);
      if (sel) sel.addEventListener('change', () => { who = sel.value; draw(); });
      draw();
    },
  });
  async function draw() {
    const box = $('#rc-list');
    if (!box) return;
    let rules = [];
    try { rules = await api.b.listRecurring(actor(), who); } catch (err) { toast(cleanErr(err), true); }
    box.innerHTML = rules.length ? '' : '<p class="empty">등록된 반복 업무가 없습니다.</p>';
    for (const r of rules) {
      const ids = ownerIdsOf(r);
      const row = document.createElement('div');
      row.className = 'rrow' + (r.active ? '' : ' off');
      row.innerHTML = `<button class="rrow-main"><span class="row-title">${r.kind === 'meeting' ? '<span class="kind">🗒 회의</span> ' : ''}${esc(r.title)}</span>
          <span class="row-meta">${esc(whenText(r) + (r.dueTime ? ' ' + r.dueTime : ''))}${ids.length > 1 || who === 'all' ? ' · ' + esc(ownerNames(ids, true)) : ''}</span></button>
        ${r.kind === 'meeting' ? '<button class="mini rr-min">회의록</button>' : ''}
        <label class="switch"><input type="checkbox" ${r.active ? 'checked' : ''} /><span></span></label>`;
      row.querySelector('.rrow-main').addEventListener('click', () => recurForm(r, draw));
      const mn = row.querySelector('.rr-min');
      if (mn) mn.addEventListener('click', () => { closeAllPages(); nav.openMeeting(r.id, null); });
      row.querySelector('input').addEventListener('change', async (e) => {
        try { await api.b.updateRecurring(actor(), r.id, { active: e.target.checked }); row.classList.toggle('off', !e.target.checked); }
        catch (err) { e.target.checked = !e.target.checked; toast(cleanErr(err), true); }
      });
      box.appendChild(row);
    }
  }
}
nav.openRecur = openRecur;

function recurForm(rule, after) {
  const isAdmin = state.me.isAdmin;
  const days0 = rule ? (rule.weekdays && rule.weekdays.length ? rule.weekdays : [rule.weekday]).map(Number) : [1];
  const s = sheet({
    title: rule ? '반복 업무 수정' : '반복 업무 등록',
    wide: true,
    html: `<div class="seg" id="rf-kind"><button data-k="task">업무</button><button data-k="meeting">🗒 회의</button></div>
      <label class="fld"><span id="rf-title-l">업무 제목</span><input class="input" id="rf-title" value="${esc(rule ? rule.title : '')}" /></label>
      <p class="hint hidden" id="rf-meet-help">참석자 스케줄에 '회의_이름' 업무가 들어가고, 누르면 회의록이 열립니다.</p>
      <div class="fld-grid"><label class="fld">주기<select class="input" id="rf-type"><option value="daily">매일</option><option value="weekly">매주</option><option value="monthly">매월</option></select></label>
        <label class="fld">시간<input class="input" type="time" id="rf-time" value="${esc(rule ? rule.dueTime || '' : '')}" /></label></div>
      <div class="fld" id="rf-days-w">요일<div class="days" id="rf-days">${WD_ORDER.map((d) => `<button type="button" data-d="${d}" class="${days0.includes(d) ? 'on' : ''}">${WD[d]}</button>`).join('')}</div></div>
      <label class="check-line" id="rf-skip-w"><input type="checkbox" id="rf-skip" ${!rule || rule.skipWeekend !== false ? 'checked' : ''} /> 주말 빼기</label>
      <label class="fld" id="rf-month-w">날짜<select class="input" id="rf-month">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}일</option>`).join('')}</select></label>
      <label class="fld">우선순위<select class="input" id="rf-prio"><option value="high">높음</option><option value="normal">보통</option><option value="low">낮음</option></select></label>
      ${isAdmin ? `<div class="fld"><span id="rf-owner-l">담당자</span><div class="op-box" id="rf-owners"></div><p class="hint">★ 대표 · 길게 누르면 대표로</p></div>
        <div class="fld hidden" id="rf-viewers-w">보기만 (작성칸 없이 회의록 보기 · 메모만 쓰기)<div class="op-box" id="rf-viewers"></div></div>` : ''}
      <p class="err hidden" id="rf-err"></p>
      <div class="sheet-btns">${rule ? '<button class="btn danger-ghost" data-a="del">삭제</button>' : ''}<button class="btn ghost" data-a="no">취소</button><button class="btn primary" data-a="ok">${rule ? '저장' : '등록'}</button></div>`,
  });
  const E = s.el;
  let kind = rule && rule.kind === 'meeting' ? 'meeting' : 'task';
  $('#rf-type', E).value = rule ? rule.ruleType : 'weekly';
  $('#rf-month', E).value = String(rule && rule.monthday ? rule.monthday : 1);
  $('#rf-prio', E).value = rule ? rule.priority : 'normal';
  for (const b of $$('#rf-days button', E)) b.addEventListener('click', () => b.classList.toggle('on'));
  let owners = null; let viewers = null;
  if (isAdmin) {
    const ids = rule ? ownerIdsOf(rule) : [actor()];
    owners = ownerPicker($('#rf-owners', E), {
      users: state.users.filter((u) => canManage(u.id) || ids.includes(u.id)),
      selected: ids,
      onChange: (next) => { if (viewers) viewers.set(viewers.get().filter((x) => !next.includes(x))); },
    });
    viewers = ownerPicker($('#rf-viewers', E), {
      users: state.users, selected: rule ? rule.viewerIds || [] : [], allowEmpty: true, noLead: true,
      onChange: (next) => {
        const o = owners.get();
        const keep = o.filter((x, i) => i === 0 || !next.includes(x));
        if (keep.length !== o.length) owners.set(keep);
        if (next.includes(o[0])) viewers.set(next.filter((x) => x !== o[0]));
      },
    });
  }
  const apply = () => {
    for (const b of $$('#rf-kind button', E)) b.classList.toggle('on', b.dataset.k === kind);
    const t = $('#rf-type', E).value;
    $('#rf-days-w', E).classList.toggle('hidden', t !== 'weekly');
    $('#rf-skip-w', E).classList.toggle('hidden', t !== 'daily');
    $('#rf-month-w', E).classList.toggle('hidden', t !== 'monthly');
    const m = kind === 'meeting';
    $('#rf-meet-help', E).classList.toggle('hidden', !m);
    $('#rf-title-l', E).textContent = m ? '회의 이름' : '업무 제목';
    $('#rf-title', E).placeholder = m ? '예: 팀장 주간 회의' : '예: 첫주보고_봄솔_플광';
    if (isAdmin) { $('#rf-owner-l', E).textContent = m ? '참석자' : '담당자'; $('#rf-viewers-w', E).classList.toggle('hidden', !m); }
  };
  for (const b of $$('#rf-kind button', E)) {
    b.addEventListener('click', () => {
      kind = b.dataset.k;
      if (kind === 'meeting' && !rule) {   // 회의 기본값: 매주 월요일 11:00
        if (!$('#rf-time', E).value) $('#rf-time', E).value = '11:00';
        if ($('#rf-type', E).value === 'daily') $('#rf-type', E).value = 'weekly';
      }
      apply();
    });
  }
  $('#rf-type', E).addEventListener('change', apply);
  apply();
  const err = (m) => { $('#rf-err', E).textContent = m; $('#rf-err', E).classList.remove('hidden'); };
  E.querySelector('[data-a="no"]').onclick = () => s.close();
  E.querySelector('[data-a="ok"]').onclick = async () => {
    const data = {
      title: $('#rf-title', E).value.trim(), kind, ruleType: $('#rf-type', E).value,
      weekdays: $$('#rf-days button.on', E).map((b) => Number(b.dataset.d)), skipWeekend: $('#rf-skip', E).checked,
      monthday: Number($('#rf-month', E).value), dueTime: $('#rf-time', E).value, priority: $('#rf-prio', E).value,
    };
    if (!data.title) return err(kind === 'meeting' ? '회의 이름을 입력하세요.' : '업무 제목을 입력하세요.');
    if (data.ruleType === 'weekly' && !data.weekdays.length) return err('요일을 하나 이상 고르세요.');
    if (owners) {
      const ids = owners.get();
      data.ownerId = ids[0]; data.coOwnerIds = ids.slice(1);
      data.viewerIds = kind === 'meeting' && viewers ? viewers.get().filter((x) => !ids.includes(x)) : [];
    }
    try {
      if (rule) await api.b.updateRecurring(actor(), rule.id, data);
      else await api.b.createRecurring(actor(), data);
      s.close();
      toast(rule ? '수정했습니다' : '등록했습니다');
      await api.b.generateRecurring(actor()).catch(() => 0);
      after(); nav.refreshView();
    } catch (e) { err(cleanErr(e)); }
  };
  const del = E.querySelector('[data-a="del"]');
  if (del) del.onclick = async () => {
    s.close();
    const warn = rule.kind === 'meeting'
      ? `"${rule.title}" 회의를 삭제할까요?\n이 회의의 회의록도 모두 지워집니다. 잠시 쉬려면 삭제 대신 '사용'을 끄세요.`
      : `"${rule.title}" 반복 등록을 삭제할까요?`;
    if (!(await confirmSheet(warn, { ok: '삭제', danger: true }))) return;
    try { await api.b.removeRecurring(actor(), rule.id); toast('삭제했습니다'); after(); nav.refreshView(); }
    catch (e) { toast(cleanErr(e), true); }
  };
}

// ---------- 🛡 심의 관리 ----------
const RV_LANDING_DAYS = 180;
const RV_NOTICE = { review: 60, landing: 30 };
const daysLeft = (s) => Math.round((parseDate(s) - parseDate(todayStr())) / 86400000);
const ddayText = (d) => (d > 0 ? `D-${d}` : d === 0 ? '오늘 종료' : `${-d}일 지남`);
const workdayBefore = (s) => { const w = parseDate(s).getDay(); return w === 6 ? addDays(s, -1) : w === 0 ? addDays(s, -2) : s; };
const withWd = (s) => `${s}(${WD[parseDate(s).getDay()]})`;

export function openReviews() {
  const f = { kind: 'all', status: 'active', q: '' };
  let items = [];
  openPage({
    title: '심의 관리',
    right: [{ label: '+ 등록', onClick: () => reviewForm(null) }],
    build: (body) => {
      body.innerHTML = `<input class="input" id="rv-q" placeholder="광고명·구분·심의번호 검색" />
        <div class="filters"><select class="input" id="rv-kind"><option value="all">전체</option><option value="review">심의</option><option value="landing">파컨 랜딩</option></select>
          <select class="input" id="rv-status"><option value="active">진행 중</option><option value="ended">종료</option><option value="all">전체</option></select></div>
        <p class="summary" id="rv-sum"></p><div id="rv-list"></div>`;
      $('#rv-q', body).addEventListener('input', debounce((e) => { f.q = e.target.value.trim().toLowerCase(); draw(); }, 150));
      $('#rv-kind', body).addEventListener('change', (e) => { f.kind = e.target.value; draw(); });
      $('#rv-status', body).addEventListener('change', (e) => { f.status = e.target.value; draw(); });
      load();
    },
  });
  async function load() {
    try { items = await api.b.listReviews(actor()); } catch (err) { items = []; toast(cleanErr(err), true); }
    draw();
  }
  function draw() {
    const active = items.filter((r) => r.active);
    const w90 = active.filter((r) => { const d = daysLeft(r.expiresOn); return d >= 0 && d <= 90; }).length;
    const exp = active.filter((r) => daysLeft(r.expiresOn) < 0).length;
    $('#rv-sum').innerHTML = `진행 ${active.length}건 · 90일 이내 <b class="${w90 ? 'warn' : ''}">${w90}</b> · 종료일 지남 <b class="${exp ? 'bad' : ''}">${exp}</b>`;
    const noCount = {};
    for (const r of items) if (r.active && r.reviewNo) noCount[r.reviewNo] = (noCount[r.reviewNo] || 0) + 1;
    const list = items.filter((r) => {
      if (f.kind !== 'all' && r.kind !== f.kind) return false;
      if (f.status === 'active' && !r.active) return false;
      if (f.status === 'ended' && r.active) return false;
      if (f.q && !`${r.name} ${r.media} ${r.reviewNo} ${r.notes}`.toLowerCase().includes(f.q)) return false;
      return true;
    });
    const box = $('#rv-list');
    box.innerHTML = list.length ? '' : '<p class="empty">해당하는 항목이 없습니다.</p>';
    for (const r of list) {
      const d = daysLeft(r.expiresOn);
      const lv = !r.active ? 'off' : d < 0 ? 'lv-exp' : d <= 30 ? 'lv-red' : d <= 90 ? 'lv-org' : '';
      const ids = [r.ownerId || r.createdBy, ...coOf(r)].filter(Boolean);
      const meta = [r.media, r.kind === 'review' ? (r.reviewNo || '번호 없음') : `등록 ${r.startOn}`, ids.length ? `담당 ${ownerNames(ids, true)}` : ''].filter(Boolean).join(' · ');
      const row = document.createElement('button');
      row.className = `rv ${lv}`;
      row.innerHTML = `<span class="row-main"><span class="row-title"><span class="tag ${r.kind}">${r.kind === 'landing' ? '랜딩' : '심의'}</span> ${esc(r.name)}
          ${r.active && r.reviewNo && noCount[r.reviewNo] > 1 ? '<span class="dup">번호 중복</span>' : ''}</span><span class="row-meta">${esc(meta)}</span></span>
        <span class="rv-right"><b>${r.active ? ddayText(d) : '종료'}</b><span class="muted">${esc(r.expiresOn)}</span></span>`;
      row.addEventListener('click', () => reviewForm(r));
      box.appendChild(row);
    }
  }
  function reviewForm(r) {
    let touched = !!r;
    const s = sheet({
      title: r ? '심의 수정' : '심의 등록',
      wide: true,
      html: `<div class="seg" id="vf-kind"><button data-k="review">심의</button><button data-k="landing">파컨 랜딩</button></div>
        <label class="fld">광고명<input class="input" id="vf-name" value="${esc(r ? r.name : '')}" /></label>
        <label class="fld">구분<input class="input" id="vf-media" list="vf-medias" value="${esc(r ? r.media : '')}" placeholder="예: 파워컨텐츠" /></label>
        <datalist id="vf-medias">${[...new Set(items.map((x) => x.media).filter(Boolean))].sort().map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
        <label class="fld" id="vf-no-w">심의번호<input class="input" id="vf-no" value="${esc(r ? r.reviewNo : '')}" /></label>
        <label class="fld" id="vf-exp-w">심의 종료일<input class="input" type="date" id="vf-exp" value="${esc(r && r.kind === 'review' ? r.expiresOn : '')}" /></label>
        <label class="fld hidden" id="vf-start-w">랜딩 등록일 <span class="muted">(+${RV_LANDING_DAYS}일이 종료일)</span><input class="input" type="date" id="vf-start" value="${esc(r && r.startOn ? r.startOn : '')}" /></label>
        <label class="fld">며칠 전 확인<input class="input" type="number" inputmode="numeric" id="vf-notice" value="${r ? r.noticeDays : RV_NOTICE.review}" /></label>
        <div class="fld">담당자<div class="op-box" id="vf-owners"></div></div>
        <label class="fld">메모<textarea class="input" id="vf-notes" rows="2">${esc(r ? r.notes : '')}</textarea></label>
        ${r ? `<label class="check-line"><input type="checkbox" id="vf-active" ${r.active ? 'checked' : ''} /> 진행 중 <span class="muted">(해제하면 종료 — 자동 업무를 만들지 않음)</span></label>` : ''}
        <p class="preview" id="vf-preview"></p><p class="err hidden" id="vf-err"></p>
        <div class="sheet-btns">${r ? '<button class="btn danger-ghost" data-a="del">삭제</button>' : ''}<button class="btn ghost" data-a="no">취소</button><button class="btn primary" data-a="ok">${r ? '저장' : '등록'}</button></div>`,
    });
    const E = s.el;
    let kind = r ? r.kind : 'review';
    const owners = ownerPicker($('#vf-owners', E), { users: state.users, selected: r ? [r.ownerId || r.createdBy || actor(), ...coOf(r)] : [actor()] });
    const preview = () => {
      const landing = kind === 'landing';
      const name = $('#vf-name', E).value.trim() || '광고명';
      const start = $('#vf-start', E).value;
      const exp = landing ? (start ? addDays(start, RV_LANDING_DAYS) : '') : $('#vf-exp', E).value;
      const notice = Number($('#vf-notice', E).value);
      const el = $('#vf-preview', E);
      if (!exp) { el.innerHTML = ''; return; }
      const lines = [];
      if (landing) lines.push(`종료일(등록 +${RV_LANDING_DAYS}일): <b>${withWd(exp)}</b>`);
      const act = $('#vf-active', E);
      if (act && !act.checked) lines.push('종료 처리됨 — 자동 업무를 만들지 않습니다.');
      else if (daysLeft(exp) < 0) lines.push('종료일이 지나 자동 업무를 만들지 않습니다.');
      else {
        const today = todayStr();
        const max = (a, b) => (a > b ? a : b);
        const dEnd = max(workdayBefore(exp), today);
        const dNotice = Number.isInteger(notice) && notice > 0 ? max(workdayBefore(addDays(exp, -notice)), today) : null;
        lines.push('자동으로 들어갈 업무:');
        if (dNotice && dNotice < dEnd) lines.push(`· ${withWd(dNotice)} <b>${esc((landing ? '랜딩갱신준비_' : '심의연장확인_') + name)}</b>`);
        lines.push(`· ${withWd(dEnd)} <b>${esc((landing ? '랜딩갱신_' : '심의종료_') + name)}</b>`);
      }
      el.innerHTML = lines.join('<br>');
    };
    const apply = () => {
      for (const b of $$('#vf-kind button', E)) b.classList.toggle('on', b.dataset.k === kind);
      const landing = kind === 'landing';
      $('#vf-no-w', E).classList.toggle('hidden', landing);
      $('#vf-exp-w', E).classList.toggle('hidden', landing);
      $('#vf-start-w', E).classList.toggle('hidden', !landing);
      if (!touched) $('#vf-notice', E).value = RV_NOTICE[kind];
      preview();
    };
    for (const b of $$('#vf-kind button', E)) b.addEventListener('click', () => { kind = b.dataset.k; apply(); });
    for (const id of ['#vf-name', '#vf-start', '#vf-exp', '#vf-active']) { const el = $(id, E); if (el) { el.addEventListener('input', preview); el.addEventListener('change', preview); } }
    $('#vf-notice', E).addEventListener('input', () => { touched = true; preview(); });
    apply();
    const err = (m) => { $('#vf-err', E).textContent = m; $('#vf-err', E).classList.remove('hidden'); };
    E.querySelector('[data-a="no"]').onclick = () => s.close();
    E.querySelector('[data-a="ok"]').onclick = async () => {
      const landing = kind === 'landing';
      const data = {
        kind, name: $('#vf-name', E).value.trim(), media: $('#vf-media', E).value.trim(),
        reviewNo: landing ? '' : $('#vf-no', E).value.trim(), startOn: landing ? $('#vf-start', E).value : null,
        noticeDays: Number($('#vf-notice', E).value), ownerId: owners.get()[0], coOwnerIds: owners.get().slice(1), notes: $('#vf-notes', E).value,
      };
      if (!landing) data.expiresOn = $('#vf-exp', E).value;
      if (r) data.active = $('#vf-active', E).checked;
      if (!data.name) return err('광고명을 입력하세요.');
      if (landing && !data.startOn) return err('랜딩 등록일을 입력하세요.');
      if (!landing && !data.expiresOn) return err('심의 종료일을 입력하세요.');
      if (!Number.isInteger(data.noticeDays) || data.noticeDays < 0 || data.noticeDays > 365) return err('며칠 전 확인은 0~365 사이 숫자로 입력하세요.');
      try {
        if (r) await api.b.updateReview(actor(), r.id, data); else await api.b.createReview(actor(), data);
        s.close(); await load(); nav.refreshView();
        toast(r ? '수정했습니다' : '등록했습니다 — 스케줄에 자동 업무가 들어갔습니다');
      } catch (e) { err(cleanErr(e)); }
    };
    const del = E.querySelector('[data-a="del"]');
    if (del) del.onclick = async () => {
      s.close();
      if (!(await confirmSheet(`"${r.name}" 을(를) 삭제할까요?\n아직 완료하지 않은 자동 업무도 함께 지워집니다. (완료한 업무는 남습니다)\n기록만 남기려면 삭제 대신 '진행 중'을 해제하세요.`, { ok: '삭제', danger: true }))) return;
      try { await api.b.removeReview(actor(), r.id); await load(); nav.refreshView(); toast('삭제했습니다'); }
      catch (e) { toast(cleanErr(e), true); }
    };
  }
}
nav.openReviews = openReviews;

// ---------- 🌴 팀 휴가 현황 ----------
function openLeaves() {
  const t = new Date();
  const v = { y: t.getFullYear(), m: t.getMonth() + 1 };
  openPage({
    title: '팀 휴가 현황',
    build: (body) => {
      body.innerHTML = `<div class="month-nav"><button class="icon-btn" id="lv-prev">‹</button><b id="lv-month"></b><button class="icon-btn" id="lv-next">›</button></div><div id="lv-list"></div>`;
      $('#lv-prev', body).addEventListener('click', () => { v.m--; if (v.m < 1) { v.m = 12; v.y--; } draw(); });
      $('#lv-next', body).addEventListener('click', () => { v.m++; if (v.m > 12) { v.m = 1; v.y++; } draw(); });
      draw();
    },
  });
  async function draw() {
    $('#lv-month').textContent = `${v.y}년 ${v.m}월`;
    let rows = [];
    try { rows = await api.b.listLeaves(actor(), v.y, v.m); } catch (err) { toast(cleanErr(err), true); }
    const ub = Object.fromEntries(state.users.map((u) => [u.id, u]));
    $('#lv-list').innerHTML = rows.length ? rows.map((t) => {
      const d = parseDate(t.date);
      return `<div class="leave"><span class="leave-date">${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})</span><span class="leave-kind">${esc(t.title)}</span><span>${esc((ub[t.ownerId] || {}).name || '')}</span></div>`;
    }).join('') : '<p class="empty">이 달에는 휴가가 없습니다.</p>';
  }
}

// ---------- 🔍 업무 검색 ----------
function openSearch() {
  openPage({
    title: '업무 검색',
    build: (body) => {
      body.innerHTML = '<input class="input" id="sr-q" type="search" placeholder="제목·메모로 검색" enterkeyhint="search" /><p class="summary" id="sr-sum"></p><ul class="list" id="sr-list"></ul>';
      const q = $('#sr-q', body);
      const run = debounce(async () => {
        const term = q.value.trim();
        if (!term) { $('#sr-list', body).innerHTML = ''; $('#sr-sum', body).textContent = ''; return; }
        let rows = [];
        try { rows = await api.b.searchTasks(actor(), term); } catch (err) { toast(cleanErr(err), true); }
        $('#sr-sum', body).textContent = `${rows.length}건${rows.length >= 200 ? ' (최근 200건까지)' : ''}`;
        nav.renderTaskList($('#sr-list', body), rows, { emptyText: '찾는 업무가 없습니다.', showDate: true, onChange: () => run() });
      }, 300);
      q.addEventListener('input', run);
      setTimeout(() => q.focus(), 100);
    },
  });
}

// ---------- ⏰ 지난 미완료 업무 ----------
function openOverdue() {
  openPage({
    title: '지난 미완료 업무',
    build: (body, page) => {
      page.onClose = () => nav.refreshView();
      body.innerHTML = '<p class="hint">지난 날짜에 남아 있는 미완료 업무입니다. 체크하면 완료, 누르면 상세.</p><button class="btn primary block" id="od-carry">전부 오늘로 옮기기</button><ul class="list" id="od-list"></ul>';
      const draw = async () => {
        let rows = [];
        try { rows = await api.b.listOverdue(actor(), state.owner); } catch (err) { toast(cleanErr(err), true); }
        $('#od-carry', body).classList.toggle('hidden', !rows.length);
        nav.renderTaskList($('#od-list', body), rows, { emptyText: '지난 미완료 업무가 없습니다. 👍', showDate: true, onChange: () => draw() });
        $('#od-carry', body).onclick = async () => {
          const mine = rows.filter((t) => canManage(t.ownerId) || coOf(t).includes(actor()));
          if (!mine.length) return toast('옮길 수 있는 업무가 없습니다', true);
          if (!(await confirmSheet(`${mine.length}건을 오늘로 옮길까요?`, { ok: '옮기기' }))) return;
          try { const n = await api.b.carryOverdue(actor(), mine.map((t) => t.id)); toast(`${n}건을 오늘로 옮겼습니다`); draw(); }
          catch (err) { toast(cleanErr(err), true); }
        };
      };
      draw();
    },
  });
}
nav.openOverdue = openOverdue;

// ---------- 🔑 비밀번호 변경 ----------
async function changePw() {
  const pw1 = await inputSheet({ title: '새 비밀번호 (6자 이상)', type: 'password', ok: '다음' });
  if (pw1 === null) return;
  if (pw1.length < 6) return toast('새 비밀번호는 6자 이상이어야 합니다', true);
  const pw2 = await inputSheet({ title: '새 비밀번호 한 번 더', type: 'password', ok: '변경' });
  if (pw2 === null) return;
  if (pw1 !== pw2) return toast('두 비밀번호가 다릅니다', true);
  try { await api.b.changePassword(null, pw1); toast('비밀번호를 바꿨습니다. PC 앱도 새 비밀번호로 로그인합니다'); }
  catch (err) { toast(cleanErr(err), true); }
}
