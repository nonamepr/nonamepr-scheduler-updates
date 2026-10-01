// ⚠️ 자동 생성 파일 — 직접 고치지 마세요. (원본: src/cloud-store.js, 만들기: npm run web)
// PC 앱 v2.3.0 과 같은 서버 연결 코드를 휴대폰 웹앱에서 쓰려고 브라우저용으로 감싼 것입니다.
export function defineCloudStore(deps) {
  const global = globalThis;
  const module = { exports: {} };
  const exports = module.exports;
  const require = (name) => {
    if (name in deps) return deps[name];
    throw new Error('웹앱에서 쓸 수 없는 모듈: ' + name);
  };
'use strict';

/**
 * 클라우드 데이터 계층 (Supabase).
 *
 * 로컬 store.js 와 같은 메서드를 제공하므로 서로 바꿔 끼울 수 있다.
 *
 * ★ 중요: 권한 판단을 여기서 하지 않는다.
 *   조회 범위·수정 가능 여부는 모두 데이터베이스의 RLS 정책이 강제한다(cloud/schema.sql).
 *   따라서 이 코드를 우회하거나 조작해도 남의 일정은 조회되지 않는다.
 */

const { createClient } = require('@supabase/supabase-js');

// Electron의 내부 Node(20.x)에는 전역 WebSocket이 없어서
// Supabase 실시간 클라이언트가 초기화에 실패한다(Node 22+ 부터 내장).
// ws 구현을 직접 넣어준다.
const WebSocketImpl = global.WebSocket || require('ws');

// DB(snake_case) ↔ 앱(camelCase) 변환
function rowToTask(r) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    coOwnerIds: Array.isArray(r.co_owner_ids) ? r.co_owner_ids : [],
    title: r.title,
    notes: r.notes || '',
    tag: r.tag || '',
    date: r.date,
    dueTime: r.due_time || '',
    priority: r.priority,
    status: r.status,
    assignedBy: r.assigned_by || null,
    recurringId: r.recurring_id || null,
    sourceKey: r.source_key || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 목록 화면에 필요한 칸만 받는다 (v2.1.1 — 전송량 절감).
// 메모 본문(notes)은 길 수 있어 목록에서는 빼고, 업무 상세를 열 때 getTask 가 따로 받는다.
const TASK_LIST_COLS =
  'id,owner_id,co_owner_ids,title,tag,date,due_time,priority,status,assigned_by,recurring_id,source_key,created_at,updated_at';

// '이 사람의 업무' = 대표 담당자이거나 함께 담당 (v2.2.0)
const ownerOr = (id) => `owner_id.eq.${id},co_owner_ids.cs.{${id}}`;
const cleanIds = (ids, ownerId) => [...new Set((ids || []).filter((x) => x && x !== ownerId))];

function rowToReview(r) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    media: r.media || '',
    reviewNo: r.review_no || '',
    startOn: r.start_on || null,
    expiresOn: r.expires_on,
    noticeDays: r.notice_days,
    ownerId: r.owner_id || null,
    coOwnerIds: Array.isArray(r.co_owner_ids) ? r.co_owner_ids : [],
    active: r.active,
    notes: r.notes || '',
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const LANDING_DAYS = 180; // 서버 트리거와 같은 값 (종료일은 서버가 최종 계산)
const AHEAD_DAYS = 7;     // 반복·점검 업무를 며칠 앞까지 미리 만들어 둘지 (store.js 와 같게 유지)

// ---------- 매체 점검 ----------
const INSP_MAP = {
  media: 'media', name: 'name', clinic: 'clinic', managers: 'managers', checkWeekday: 'check_weekday',
  checkOwner: 'check_owner', checkCoOwners: 'check_co_owners', budget: 'budget', renewOn: 'renew_on', reviewEndOn: 'review_end_on',
  agencyLink: 'agency_link', reportLink: 'report_link', keyNotes: 'key_notes', csNotes: 'cs_notes',
  scheduleNotes: 'schedule_notes', body: 'body', active: 'active', notionId: 'notion_id',
};
const INSP_BUCKET = 'inspection-files';
function rowToInspection(r) {
  const o = { id: r.id, recurringId: r.recurring_id || null, createdBy: r.created_by || null, createdAt: r.created_at, updatedAt: r.updated_at };
  for (const [k, col] of Object.entries(INSP_MAP)) o[k] = r[col];
  for (const k of ['media', 'clinic', 'managers', 'budget', 'agencyLink', 'reportLink', 'keyNotes', 'csNotes', 'scheduleNotes', 'body']) o[k] = o[k] || '';
  if (!Array.isArray(o.checkCoOwners)) o.checkCoOwners = [];
  return o;
}
function rowToInspChange(r) {
  return {
    id: r.id, inspectionId: r.inspection_id, title: r.title || '', changedOn: r.changed_on || null,
    kept: r.kept, participant: r.participant || '', body: r.body || '', notionId: r.notion_id || null,
    createdBy: r.created_by || null, createdAt: r.created_at,
  };
}
function rowToInspFile(r) {
  return {
    id: r.id, inspectionId: r.inspection_id, changeId: r.change_id || null, name: r.name,
    storagePath: r.storage_path, size: Number(r.size) || 0, mime: r.mime || '', createdBy: r.created_by || null, createdAt: r.created_at,
  };
}

const MEET_MAP = {
  section: 'section', ownerId: 'owner_id', body: 'body', note: 'note', status: 'status',
  carriedFrom: 'carried_from', carryCount: 'carry_count', taskId: 'task_id', dueOn: 'due_on', sort: 'sort',
};
function rowToMeetItem(r) {
  const o = { id: r.id, ruleId: r.rule_id, meetDate: r.meet_date, createdBy: r.created_by || null, createdAt: r.created_at, updatedAt: r.updated_at };
  for (const [k, col] of Object.entries(MEET_MAP)) o[k] = r[col];
  o.body = o.body || ''; o.note = o.note || ''; o.carryCount = Number(o.carryCount) || 0; o.sort = Number(o.sort) || 0;
  return o;
}
function meetItemRow(d) {
  const row = {};
  for (const [k, col] of Object.entries(MEET_MAP)) {
    if (!(k in d) || d[k] === undefined) continue;
    let v = d[k];
    if ((k === 'ownerId' || k === 'carriedFrom' || k === 'taskId' || k === 'dueOn') && v === '') v = null;
    row[col] = v;
  }
  return row;
}

function rowToComment(r) {
  return {
    id: r.id, inspectionId: r.inspection_id, authorId: r.author_id || null, body: r.body || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
    reactions: (r.inspection_comment_reactions || []).map((x) => ({ userId: x.user_id, emoji: x.emoji })),
  };
}
function rowToNotif(r) {
  return {
    id: r.id, userId: r.user_id, actorId: r.actor_id || null, kind: r.kind,
    inspectionId: r.inspection_id || null, commentId: r.comment_id || null,
    title: r.title || '', body: r.body || '', readAt: r.read_at || null, createdAt: r.created_at,
  };
}

function rowToRule(r) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    notes: r.notes || '',
    tag: r.tag || '',
    priority: r.priority,
    ruleType: r.rule_type,
    weekday: r.weekday,
    weekdays: Array.isArray(r.weekdays) && r.weekdays.length ? r.weekdays : (r.weekday != null ? [r.weekday] : []),
    monthday: r.monthday,
    skipWeekend: r.skip_weekend !== false,
    dueTime: r.due_time || '',
    kind: r.kind || 'task',
    coOwnerIds: Array.isArray(r.co_owner_ids) ? r.co_owner_ids : [],
    viewerIds: Array.isArray(r.viewer_ids) ? r.viewer_ids : [],   // 회의 '보기 전용' (v2.2.1)
    canWrite: r.can_write !== false,                               // meeting_rules() 가 알려 준다
    active: r.active,
    generatedThrough: r.generated_through,
  };
}

// 반복 규칙 날짜 계산 (로컬 기준)
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = toDate(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function localToday() {
  return ymd(new Date());
}
// 서버 함수 recurring_matches 와 같은 규칙 (store.js 와도 같게 유지)
function matchesRule(rule, dateStr) {
  const d = toDate(dateStr);
  const wd = d.getDay();
  if (rule.ruleType === 'daily') return !(rule.skipWeekend !== false && (wd === 0 || wd === 6));
  if (rule.ruleType === 'weekly') {
    const days = rule.weekdays && rule.weekdays.length ? rule.weekdays : [rule.weekday];
    return days.map(Number).includes(wd);
  }
  if (rule.ruleType === 'monthly') return d.getDate() === Number(rule.monthday);
  return false;
}
function ruleTaskTitle(rule) {
  return rule.kind === 'meeting' ? '회의_' + rule.title : rule.title;
}
// 반복 규칙 입력값 정리 (등록·수정 공통)
function ruleFields(d) {
  const out = {};
  if ('ruleType' in d) {
    out.rule_type = ['daily', 'weekly', 'monthly'].includes(d.ruleType) ? d.ruleType : 'weekly';
  }
  if ('weekdays' in d || 'weekday' in d) {
    const days = [...new Set((d.weekdays && d.weekdays.length ? d.weekdays : [d.weekday])
      .map(Number).filter((x) => x >= 0 && x <= 6))].sort((a, b) => a - b);
    out.weekdays = days;
    out.weekday = days.length ? days[0] : null;
  }
  if ('monthday' in d) out.monthday = d.monthday == null ? null : Number(d.monthday);
  if ('skipWeekend' in d) out.skip_weekend = d.skipWeekend !== false;
  if ('dueTime' in d) out.due_time = String(d.dueTime || '').trim();
  if ('kind' in d) out.kind = d.kind === 'meeting' ? 'meeting' : 'task';
  return out;
}

const LEAVE_TITLES = ['연차', '오전반차', '오후반차'];
const isLeaveTitle = (t) => LEAVE_TITLES.includes(String(t || '').trim());
function rowToUser(r) {
  return {
    id: r.id,
    loginId: r.email || '',
    name: r.name,
    isAdmin: !!(r.is_admin || r.is_super),
    isSuper: !!r.is_super,
  };
}

// Supabase 오류 메시지를 사람이 읽을 수 있게
function toMessage(error, fallback) {
  if (!error) return fallback;
  const m = String(error.message || '');
  if (/Invalid login credentials/i.test(m)) return '아이디 또는 비밀번호가 올바르지 않습니다.';
  if (/Email not confirmed/i.test(m)) return '이메일 인증이 완료되지 않은 계정입니다. 관리자에게 문의하세요.';
  if (/violates row-level security|new row violates/i.test(m)) return '이 작업을 할 권한이 없습니다.';
  if (/duplicate key/i.test(m) && /recurring_date/i.test(m)) {
    return '그 날짜에 같은 반복(점검) 업무가 이미 있습니다. 기존 업무를 쓰거나 지운 뒤 옮겨 주세요.';
  }
  if (/Failed to fetch|fetch failed|ENOTFOUND|network/i.test(m)) return '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
  if (/inspection_comment_reactions/.test(m) && /schema cache|does not exist|Could not find/i.test(m)) {
    return '서버에 댓글 감정표현 준비가 안 됐습니다. 관리자에게 문의하세요. (migration-reactions-20260930.sql)';
  }
  if (/(notifications|inspection_comments)/.test(m) && /schema cache|does not exist|Could not find/i.test(m)) {
    return '서버에 댓글·알림 준비가 안 됐습니다. 관리자에게 문의하세요. (migration-comments.sql)';
  }
  if (/inspection/.test(m) && /schema cache|does not exist|Could not find/i.test(m)) {
    return '서버에 매체 점검 준비가 안 됐습니다. 관리자에게 문의하세요. (migration-inspections.sql)';
  }
  if (/ad_reviews/.test(m) && /schema cache|does not exist|Could not find/i.test(m)) {
    return '서버에 심의 관리 준비가 안 됐습니다. 관리자에게 문의하세요. (migration-reviews.sql)';
  }
  return m || fallback;
}
function check(error, fallback) {
  if (error) throw new Error(toMessage(error, fallback));
}

class CloudStore {
  constructor(url, key) {
    this.url = url;
    this.key = key;
    this.sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: true },
      realtime: { transport: WebSocketImpl },
    });
    this.user = null; // 로그인한 사용자 프로필
    this._onToken = null;

    // Supabase 는 보안상 세션 토큰을 주기적으로 교체한다.
    // 교체될 때마다 알려주지 않으면 저장해 둔 토큰이 만료되어
    // 다음 실행 때 로그인이 풀린다.
    this.sb.auth.onAuthStateChange((event, session) => {
      if (!this._onToken) return;
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
        if (session && session.refresh_token) this._onToken(session.refresh_token);
      }
    });
  }

  // 토큰이 바뀔 때 호출될 콜백 등록
  onTokenChange(fn) {
    this._onToken = fn;
  }

  isCloud() {
    return true;
  }

  // 화면 표시용 판단(읽기전용 여부 등). 실제 차단은 DB의 RLS가 한다.
  _canManage(ownerId) {
    const me = this.user;
    if (!me) return false;
    if (ownerId === me.id || me.isSuper) return true;
    if (me.isAdmin) {
      const owner = this._userCache && this._userCache[ownerId];
      // 상대가 관리자급이면 관리 불가 (정보가 없으면 보수적으로 불가)
      return owner ? !owner.isAdmin : false;
    }
    return false;
  }

  // ---------- 연결 확인 ----------
  // supabase-js는 인증 실패 시 빈 오류를 주는 경우가 있어,
  // 원인을 정확히 알려주려고 HTTP 상태 코드를 직접 확인한다.
  async testConnection() {
    let res;
    try {
      res = await fetch(`${this.url}/rest/v1/profiles?select=id&limit=1`, {
        headers: { apikey: this.key, Authorization: `Bearer ${this.key}` },
      });
    } catch (e) {
      throw new Error('서버에 연결할 수 없습니다. Project URL과 인터넷 연결을 확인하세요.');
    }

    if (res.ok) return true;

    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('API 키가 올바르지 않습니다. Publishable key(sb_publishable_...)를 다시 복사해 주세요.');
    }
    if (res.status === 404 || /does not exist|schema cache|PGRST205/i.test(body)) {
      throw new Error('데이터베이스 준비가 안 됐습니다. SETUP 2단계(schema.sql 실행)를 완료했는지 확인하세요.');
    }
    throw new Error(`연결에 실패했습니다. (오류 ${res.status})`);
  }

  // ---------- 로그인 ----------
  async login(email, password) {
    const { data, error } = await this.sb.auth.signInWithPassword({
      email: String(email || '').trim(),
      password,
    });
    check(error, '로그인에 실패했습니다.');

    const profile = await this._loadProfile(data.user.id, data.user.email);
    this.user = profile;
    return profile;
  }

  async _loadProfile(id, email) {
    const { data, error } = await this.sb.from('profiles').select('*').eq('id', id).single();
    check(error, '사용자 정보를 불러오지 못했습니다.');
    return { ...rowToUser(data), loginId: email || data.email || '' };
  }

  async restoreSession(refreshToken) {
    if (!refreshToken) return null;
    const { data, error } = await this.sb.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.user) return null;
    this.user = await this._loadProfile(data.user.id, data.user.email);
    return this.user;
  }

  async getRefreshToken() {
    const { data } = await this.sb.auth.getSession();
    return data.session ? data.session.refresh_token : null;
  }

  async logout() {
    await this.sb.auth.signOut();
    this.user = null;
    return true;
  }

  async changePassword(_oldPw, newPw) {
    if (!newPw || String(newPw).length < 6) {
      throw new Error('새 비밀번호는 6자 이상이어야 합니다.');
    }
    const { error } = await this.sb.auth.updateUser({ password: newPw });
    check(error, '비밀번호 변경에 실패했습니다.');
    return true;
  }

  // ---------- 사용자 ----------
  async listUsers() {
    const { data, error } = await this.sb.from('profiles').select('*').order('name');
    check(error, '사용자 목록을 불러오지 못했습니다.');
    const users = data.map(rowToUser);
    // 읽기전용 판단에 쓰려고 캐시해둔다
    this._userCache = Object.fromEntries(users.map((u) => [u.id, u]));
    return users;
  }

  // 권한 등급 변경 ('super' | 'admin' | 'staff') — DB 트리거가 슈퍼 관리자만 허용하도록 강제한다
  async setUserRole(_actorId, targetId, role) {
    const patch = {
      is_super: role === 'super',
      is_admin: role === 'admin' || role === 'super',
    };
    const { data, error } = await this.sb
      .from('profiles').update(patch).eq('id', targetId).select();
    check(error, '권한 등급 변경에 실패했습니다.');
    if (!data || !data.length) throw new Error('권한 등급을 변경할 권한이 없습니다.');
    return true;
  }

  // 표시 이름 변경
  async setUserName(_actorId, targetId, name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('이름을 입력하세요.');
    if (n.length > 20) throw new Error('이름은 20자 이내로 입력하세요.');
    const { data, error } = await this.sb
      .from('profiles').update({ name: n }).eq('id', targetId).select();
    check(error, '이름 변경에 실패했습니다.');
    if (!data || !data.length) throw new Error('이 사용자의 이름을 변경할 권한이 없습니다.');
    if (this.user && this.user.id === targetId) this.user.name = n;
    return true;
  }

  // ---------- 보기 권한 ----------
  async listGrantsFor(granteeId) {
    const { data, error } = await this.sb.from('grants').select('*').eq('grantee_id', granteeId);
    check(error, '보기 권한을 불러오지 못했습니다.');
    return data.map((g) => ({ granteeId: g.grantee_id, ownerId: g.owner_id }));
  }

  async setGrant(_actorId, granteeId, ownerId, value) {
    if (granteeId === ownerId) throw new Error('본인 일정은 항상 볼 수 있습니다.');
    if (value) {
      const { error } = await this.sb
        .from('grants')
        .upsert({ grantee_id: granteeId, owner_id: ownerId });
      check(error, '보기 권한 부여에 실패했습니다. (관리자만 가능)');
    } else {
      const { error } = await this.sb
        .from('grants')
        .delete()
        .eq('grantee_id', granteeId)
        .eq('owner_id', ownerId);
      check(error, '보기 권한 회수에 실패했습니다. (관리자만 가능)');
    }
    return true;
  }

  // ---------- 변경 기록 ----------
  // 기록은 DB 트리거가 자동으로 남기고, 조회 범위는 RLS 가 통제한다.
  async listLogs(opts = {}) {
    let q = this.sb.from('task_logs').select('*');
    if (opts.ownerId && opts.ownerId !== 'all') q = q.eq('owner_id', opts.ownerId);
    if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);

    const { data, error } = await q.order('created_at', { ascending: false })
      .limit(opts.limit || 300);
    check(error, '변경 기록을 불러오지 못했습니다.');
    return data.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      taskTitle: r.task_title,
      ownerId: r.owner_id,
      actorId: r.actor_id,
      action: r.action,
      detail: r.detail,
      at: r.created_at,
      hasSnapshot: !!r.snapshot,
    }));
  }

  /**
   * 변경 기록에서 삭제된 업무를 되살린다.
   * snapshot(삭제 당시 전체 내용)이 있으면 그대로, 없으면 기록에 남은 정보만으로 복구한다.
   * 되살릴 수 있는 대상인지는 RLS 가 판단한다 — 권한이 없으면 insert 가 거부된다.
   */
  async restoreFromLogs(_actorId, logIds) {
    if (!this.user) throw new Error('로그인이 필요합니다.');
    if (!logIds || !logIds.length) return { restored: 0, skipped: 0, failed: 0 };

    const { data: logs, error } = await this.sb
      .from('task_logs').select('*').in('id', logIds).eq('action', 'delete');
    check(error, '복구할 기록을 불러오지 못했습니다.');

    const rows = [];
    let failed = 0;
    for (const l of logs || []) {
      const s = l.snapshot || {};
      const date = s.date || (String(l.detail || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0];
      if (!date) { failed++; continue; }
      rows.push({
        owner_id: l.owner_id,
        title: l.task_title,
        notes: s.notes || '',
        tag: s.tag || '',
        date,
        due_time: s.due_time || '',
        priority: s.priority || 'normal',
        // 삭제 당시 완료 상태였으면 완료 그대로 되살린다
        status: s.status || (/완료 상태였음/.test(l.detail || '') ? 'done' : 'todo'),
        assigned_by: s.assigned_by || null,
      });
    }
    failed += logIds.length - (logs || []).length;
    if (!rows.length) return { restored: 0, skipped: 0, failed };

    // 이미 같은 업무가 있으면 건너뛴다 (중복 복구 방지)
    const dates = [...new Set(rows.map((r) => r.date))];
    const { data: exist } = await this.sb.from('tasks')
      .select('owner_id,title,date').in('date', dates);
    const seen = new Set((exist || []).map((t) => `${t.owner_id}|${t.title}|${t.date}`));

    const fresh = [];
    let skipped = 0;
    for (const r of rows) {
      const key = `${r.owner_id}|${r.title}|${r.date}`;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      fresh.push(r);
    }
    if (!fresh.length) return { restored: 0, skipped, failed };

    const { data: made, error: e2 } = await this.sb.from('tasks').insert(fresh).select('id');
    if (e2) {
      // 권한이 없거나 일부가 막힌 경우 — 통째로 실패한다
      return { restored: 0, skipped, failed: failed + fresh.length, error: e2.message };
    }
    return { restored: (made || []).length, skipped, failed };
  }

  // ---------- 심의 관리 ----------
  // 자동 업무 생성·정리는 서버 트리거(ad_reviews_sync_tasks)가 한다.
  async listReviews(_actorId) {
    const { data, error } = await this.sb.from('ad_reviews').select('*')
      .order('active', { ascending: false }).order('expires_on').order('created_at').order('id');
    check(error, '심의 목록을 불러오지 못했습니다.');
    return data.map(rowToReview);
  }

  _reviewRow(d) {
    const row = {};
    const map = {
      kind: 'kind', name: 'name', media: 'media', reviewNo: 'review_no', startOn: 'start_on',
      expiresOn: 'expires_on', noticeDays: 'notice_days', ownerId: 'owner_id', active: 'active', notes: 'notes',
      coOwnerIds: 'co_owner_ids',
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in d && d[k] !== undefined) row[col] = d[k] === '' && (k === 'ownerId' || k === 'startOn') ? null : d[k];
    }
    if (row.kind === 'landing' && row.start_on) {
      const [y, m, day] = String(row.start_on).split('-').map(Number);
      row.expires_on = ymd(new Date(y, m - 1, day + LANDING_DAYS));
    }
    return row;
  }

  async createReview(_actorId, d) {
    if (!this.user) throw new Error('로그인이 필요합니다.');
    if (!String(d.name || '').trim()) throw new Error('광고명을 입력하세요.');
    const row = this._reviewRow({ ...d, ownerId: d.ownerId || this.user.id });
    row.created_by = this.user.id;
    const { data, error } = await this.sb.from('ad_reviews').insert(row).select().single();
    check(error, '심의 등록에 실패했습니다.');
    return rowToReview(data);
  }

  async updateReview(_actorId, id, patch) {
    const { data, error } = await this.sb.from('ad_reviews').update(this._reviewRow(patch)).eq('id', id).select();
    check(error, '심의 수정에 실패했습니다.');
    if (!data || !data.length) throw new Error('심의를 찾을 수 없습니다.');
    return rowToReview(data[0]);
  }

  async removeReview(_actorId, id) {
    const { data, error } = await this.sb.from('ad_reviews').delete().eq('id', id).select();
    check(error, '심의 삭제에 실패했습니다.');
    if (!data || !data.length) throw new Error('심의를 찾을 수 없습니다.');
    return true;
  }

  // ---------- 매체 점검 ----------
  // 점검 요일 ↔ 반복 업무 연결은 서버 트리거(inspections_before_save)가 한다.
  async listInspections(_actorId) {
    const { data, error } = await this.sb.from('inspections').select('*')
      .order('media').order('name').order('created_at').order('id');
    check(error, '점검 카드를 불러오지 못했습니다.');
    return data.map(rowToInspection);
  }

  async getInspection(_actorId, id) {
    const [c, ch, f] = await Promise.all([
      this.sb.from('inspections').select('*').eq('id', id).single(),
      this.sb.from('inspection_changes').select('*').eq('inspection_id', id)
        .order('changed_on', { ascending: false, nullsFirst: false }).order('created_at').order('id'),
      this.sb.from('inspection_files').select('*').eq('inspection_id', id).order('created_at').order('id'),
    ]);
    check(c.error, '점검 카드를 찾을 수 없습니다.');
    check(ch.error, '변경 이력을 불러오지 못했습니다.');
    check(f.error, '첨부파일 목록을 불러오지 못했습니다.');
    return { card: rowToInspection(c.data), changes: ch.data.map(rowToInspChange), files: f.data.map(rowToInspFile) };
  }

  _inspRow(d) {
    const row = {};
    for (const [k, col] of Object.entries(INSP_MAP)) {
      if (!(k in d) || d[k] === undefined) continue;
      let v = d[k];
      if ((k === 'checkWeekday' || k === 'checkOwner' || k === 'renewOn' || k === 'reviewEndOn' || k === 'notionId') && v === '') v = null;
      row[col] = v;
    }
    return row;
  }

  async createInspection(_actorId, d) {
    if (!this.user) throw new Error('로그인이 필요합니다.');
    if (!String(d.name || '').trim()) throw new Error('카드 이름을 입력하세요.');
    const row = this._inspRow(d);
    row.created_by = this.user.id;
    const { data, error } = await this.sb.from('inspections').insert(row).select().single();
    if (error && /duplicate key|notion_id/i.test(error.message || '')) throw new Error('이미 가져온 노션 페이지입니다.');
    check(error, '점검 카드 등록에 실패했습니다.');
    return rowToInspection(data);
  }

  async updateInspection(_actorId, id, patch) {
    const row = this._inspRow(patch);
    delete row.notion_id;
    const { data, error } = await this.sb.from('inspections').update(row).eq('id', id).select();
    check(error, '점검 카드 수정에 실패했습니다.');
    if (!data || !data.length) throw new Error('점검 카드를 찾을 수 없습니다.');
    return rowToInspection(data[0]);
  }

  async removeInspection(_actorId, id) {
    // 저장소의 실제 파일부터 지운다 (표는 카드 삭제 시 함께 지워짐)
    const { data: files } = await this.sb.from('inspection_files').select('storage_path').eq('inspection_id', id);
    if (files && files.length) await this.sb.storage.from(INSP_BUCKET).remove(files.map((f) => f.storage_path));
    const { data, error } = await this.sb.from('inspections').delete().eq('id', id).select('id');
    check(error, '점검 카드 삭제에 실패했습니다.');
    if (!data || !data.length) throw new Error('점검 카드를 찾을 수 없습니다.');
    return true;
  }

  async createInspChange(_actorId, inspectionId, d) {
    const row = {
      inspection_id: inspectionId, title: String(d.title || '').trim(),
      changed_on: d.changedOn || null, kept: d.kept === true ? true : d.kept === false ? false : null,
      participant: d.participant || '', body: d.body || '', notion_id: d.notionId || null,
      created_by: this.user ? this.user.id : null,
    };
    const { data, error } = await this.sb.from('inspection_changes').insert(row).select().single();
    check(error, '변경 이력 등록에 실패했습니다.');
    return rowToInspChange(data);
  }

  async updateInspChange(_actorId, id, patch) {
    const row = {};
    if ('title' in patch) row.title = String(patch.title || '').trim();
    if ('changedOn' in patch) row.changed_on = patch.changedOn || null;
    if ('kept' in patch) row.kept = patch.kept === true ? true : patch.kept === false ? false : null;
    if ('participant' in patch) row.participant = patch.participant || '';
    if ('body' in patch) row.body = patch.body || '';
    const { data, error } = await this.sb.from('inspection_changes').update(row).eq('id', id).select();
    check(error, '변경 이력 수정에 실패했습니다.');
    if (!data || !data.length) throw new Error('변경 이력을 찾을 수 없습니다.');
    return rowToInspChange(data[0]);
  }

  async removeInspChange(_actorId, id) {
    const { error } = await this.sb.from('inspection_changes').delete().eq('id', id);
    check(error, '변경 이력 삭제에 실패했습니다.');
    return true;
  }

  async addInspFile(_actorId, inspectionId, { name, buffer, mime, changeId }) {
    const crypto = require('crypto');
    const ext = (require('path').extname(name || '').toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
    const key = `${inspectionId}/${crypto.randomUUID()}${ext}`; // 한글 파일명은 저장소가 거부할 수 있어 원래 이름은 표에만 둔다
    const up = await this.sb.storage.from(INSP_BUCKET).upload(key, buffer, { contentType: mime || 'application/octet-stream', upsert: false });
    check(up.error, '파일 올리기에 실패했습니다.');
    const { data, error } = await this.sb.from('inspection_files').insert({
      inspection_id: inspectionId, change_id: changeId || null, name: String(name || '파일'),
      storage_path: key, size: buffer.length, mime: mime || '', created_by: this.user ? this.user.id : null,
    }).select().single();
    if (error) await this.sb.storage.from(INSP_BUCKET).remove([key]);
    check(error, '첨부파일 등록에 실패했습니다.');
    return rowToInspFile(data);
  }

  async readInspFile(_actorId, id) {
    const { data: f, error } = await this.sb.from('inspection_files').select('*').eq('id', id).single();
    check(error, '파일을 찾을 수 없습니다.');
    const dl = await this.sb.storage.from(INSP_BUCKET).download(f.storage_path);
    check(dl.error, '파일을 내려받지 못했습니다.');
    return { name: f.name, buffer: Buffer.from(await dl.data.arrayBuffer()) };
  }

  async removeInspFile(_actorId, id) {
    const { data: f, error } = await this.sb.from('inspection_files').select('storage_path').eq('id', id).single();
    check(error, '파일을 찾을 수 없습니다.');
    await this.sb.storage.from(INSP_BUCKET).remove([f.storage_path]);
    const del = await this.sb.from('inspection_files').delete().eq('id', id);
    check(del.error, '첨부파일 삭제에 실패했습니다.');
    return true;
  }

  // ---------- 점검 댓글 · 알림 ----------
  // '@이름' 을 찾아 알림을 만드는 일은 서버 트리거(inspection_comment_mentions)가 한다.
  async listInspComments(_actorId, inspectionId) {
    // 감정표현은 같은 요청에 묶어서 받는다 (요청 수·전송량 줄이기)
    const get = (cols) => this.sb.from('inspection_comments').select(cols)
      .eq('inspection_id', inspectionId).order('created_at').order('id');
    let { data, error } = await get('*, inspection_comment_reactions(user_id, emoji)');
    if (error && /inspection_comment_reactions/.test(String(error.message || ''))) {
      ({ data, error } = await get('*'));   // 아직 감정표현 표가 없는 서버
    }
    check(error, '댓글을 불러오지 못했습니다.');
    return data.map(rowToComment);
  }

  // 감정표현 남기기/지우기 (이미 같은 이모지를 남겼으면 취소)
  async toggleInspReaction(_actorId, commentId, emoji) {
    if (!this.user) throw new Error('로그인이 필요합니다.');
    const e = String(emoji || '').trim();
    if (!e) throw new Error('이모지를 고르세요.');
    const row = { comment_id: commentId, user_id: this.user.id, emoji: e };
    const del = await this.sb.from('inspection_comment_reactions').delete().match(row).select('emoji');
    check(del.error, '감정표현을 지우지 못했습니다.');
    if (del.data && del.data.length) return { emoji: e, on: false };
    const ins = await this.sb.from('inspection_comment_reactions').insert(row);
    check(ins.error, '감정표현을 남기지 못했습니다.');
    return { emoji: e, on: true };
  }

  async createInspComment(_actorId, inspectionId, body) {
    if (!this.user) throw new Error('로그인이 필요합니다.');
    const text = String(body || '').trim();
    if (!text) throw new Error('댓글 내용을 입력하세요.');
    const { data, error } = await this.sb.from('inspection_comments')
      .insert({ inspection_id: inspectionId, author_id: this.user.id, body: text }).select().single();
    check(error, '댓글 등록에 실패했습니다.');
    return rowToComment(data);
  }

  async updateInspComment(_actorId, id, body) {
    const text = String(body || '').trim();
    if (!text) throw new Error('댓글 내용을 입력하세요.');
    const { data, error } = await this.sb.from('inspection_comments')
      .update({ body: text, updated_at: new Date().toISOString() }).eq('id', id).select();
    check(error, '댓글 수정에 실패했습니다.');
    if (!data || !data.length) throw new Error('내가 쓴 댓글만 고칠 수 있습니다.');
    return rowToComment(data[0]);
  }

  async removeInspComment(_actorId, id) {
    const { data, error } = await this.sb.from('inspection_comments').delete().eq('id', id).select('id');
    check(error, '댓글 삭제에 실패했습니다.');
    if (!data || !data.length) throw new Error('내가 쓴 댓글만 지울 수 있습니다.');
    return true;
  }

  async listNotifications(_actorId, opts = {}) {
    let q = this.sb.from('notifications').select('*');
    if (opts.onlyUnread) q = q.is('read_at', null);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(opts.limit || 100);
    check(error, '알림을 불러오지 못했습니다.');
    return data.map(rowToNotif);
  }

  async markNotificationsRead(_actorId, ids) {
    let q = this.sb.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
    if (ids && ids.length) q = q.in('id', ids);
    const { data, error } = await q.select('id');
    check(error, '알림 확인 처리에 실패했습니다.');
    return (data || []).length;
  }

  // ---------- 반복 업무 ----------
  async listRecurring(_actorId, ownerId) {
    let q = this.sb.from('recurring_tasks').select('*');
    if (ownerId && ownerId !== 'all') q = q.or(ownerOr(ownerId));
    const { data, error } = await q.order('title');
    check(error, '반복 규칙을 불러오지 못했습니다.');
    return data.map(rowToRule);
  }

  async createRecurring(_actorId, d) {
    const me = this.user;
    if (!me) throw new Error('로그인이 필요합니다.');
    const title = String(d.title || '').trim();
    if (!title) throw new Error('업무 제목을 입력하세요.');
    const f = ruleFields({ ruleType: d.ruleType, weekdays: d.weekdays, weekday: d.weekday, monthday: d.monthday,
      skipWeekend: d.skipWeekend, dueTime: d.dueTime, kind: d.kind });
    if (f.rule_type === 'weekly' && !f.weekdays.length) throw new Error('요일을 하나 이상 고르세요.');
    if (f.rule_type === 'monthly' && !(f.monthday >= 1 && f.monthday <= 31)) throw new Error('날짜(1~31)를 입력하세요.');
    const ownerId = me.isAdmin && d.ownerId ? d.ownerId : me.id;

    const row = {
      owner_id: ownerId,
      co_owner_ids: me.isAdmin ? cleanIds(d.coOwnerIds, ownerId) : [],
      viewer_ids: d.kind === 'meeting' ? cleanIds(d.viewerIds, ownerId).filter((x) => !(d.coOwnerIds || []).includes(x)) : [],
      title,
      notes: d.notes || '',
      tag: String(d.tag || '').trim(),
      priority: d.priority || 'normal',
      ...f,
      weekdays: f.rule_type === 'weekly' ? f.weekdays : [],
      weekday: f.rule_type === 'weekly' ? f.weekday : null,
      monthday: f.rule_type === 'monthly' ? f.monthday : null,
      active: true,
      // 등록 이전 날짜는 만들지 않는다
      generated_through: addDays(localToday(), -1),
      created_by: me.id,
    };
    const { data, error } = await this.sb.from('recurring_tasks').insert(row).select().single();
    check(error, '반복 규칙 등록에 실패했습니다.');
    return rowToRule(data);
  }

  async updateRecurring(_actorId, id, patch) {
    const map = {
      title: 'title', notes: 'notes', tag: 'tag', priority: 'priority', active: 'active', ownerId: 'owner_id',
    };
    const row = {};
    for (const [k, col] of Object.entries(map)) {
      if (k in patch && patch[k] !== undefined) row[col] = patch[k];
    }
    const sched = {};
    for (const k of ['ruleType', 'weekdays', 'weekday', 'monthday', 'skipWeekend', 'dueTime', 'kind']) {
      if (k in patch && patch[k] !== undefined) sched[k] = patch[k];
    }
    Object.assign(row, ruleFields(sched));
    if (row.rule_type && row.rule_type !== 'weekly') { row.weekdays = []; row.weekday = null; }
    if (row.rule_type === 'weekly' && row.weekdays && !row.weekdays.length) throw new Error('요일을 하나 이상 고르세요.');
    if ('coOwnerIds' in patch) row.co_owner_ids = cleanIds(patch.coOwnerIds, patch.ownerId);
    if ('viewerIds' in patch) row.viewer_ids = cleanIds(patch.viewerIds, patch.ownerId).filter((x) => !(patch.coOwnerIds || []).includes(x));
    const { data, error } = await this.sb.from('recurring_tasks').update(row).eq('id', id).select();
    check(error, '반복 규칙 수정에 실패했습니다.');
    if (!data || !data.length) throw new Error('수정할 권한이 없습니다.');
    return rowToRule(data[0]);
  }

  async removeRecurring(_actorId, id) {
    const { data, error } = await this.sb.from('recurring_tasks').delete().eq('id', id).select();
    check(error, '반복 규칙 삭제에 실패했습니다.');
    if (!data || !data.length) throw new Error('삭제할 권한이 없습니다.');
    return true;
  }

  /**
   * 내 반복 규칙에 따라 '일주일 뒤'까지의 업무를 미리 만든다.
   * (이번 주·다음 주 점검 업무가 달력에 미리 보이도록)
   * 중복은 DB의 unique(recurring_id, date) 가 최종적으로 막는다.
   */
  async generateRecurring(actorId) {
    const me = this.user;
    if (!me) return 0;
    // v2.2.0: 서버 함수가 대표·함께 담당 규칙을 모두 만든다 (누가 먼저 켜든 한 번만)
    const { data: made, error: rpcErr } = await this.sb.rpc('generate_recurring_tasks');
    if (!rpcErr) return Number(made) || 0;
    // 서버에 아직 함수가 없으면(migration-v22.sql 적용 전) 예전처럼 앱이 만든다
    if (!/generate_recurring_tasks|PGRST202|42883|schema cache|does not exist/i.test(`${rpcErr.code} ${rpcErr.message}`)) {
      console.error('반복 업무 생성 실패:', rpcErr.message);
      return 0;
    }
    return this._generateRecurringLegacy(actorId);
  }

  async _generateRecurringLegacy(_actorId) {
    const me = this.user;
    if (!me) return 0;
    const today = localToday();
    const horizon = addDays(today, AHEAD_DAYS);

    const { data: rules, error } = await this.sb
      .from('recurring_tasks').select('*').eq('owner_id', me.id).eq('active', true);
    if (error) return 0;

    const rows = [];
    const touched = [];
    for (const raw of rules) {
      const r = rowToRule(raw);
      let cursor = addDays(r.generatedThrough || addDays(today, -1), 1);
      let guard = 0;
      while (cursor <= horizon && guard++ < 90) {
        if (matchesRule(r, cursor)) {
          rows.push({
            owner_id: r.ownerId, title: ruleTaskTitle(r), notes: r.notes, tag: r.tag,
            date: cursor, due_time: r.dueTime || '', priority: r.priority, status: 'todo',
            recurring_id: r.id,
          });
        }
        cursor = addDays(cursor, 1);
      }
      if (r.generatedThrough !== horizon) touched.push(r.id);
    }

    let made = 0;
    if (rows.length) {
      // 이미 있으면 조용히 건너뛴다 (동시 실행 대비)
      const { data, error: e2 } = await this.sb
        .from('tasks')
        .upsert(rows, { onConflict: 'recurring_id,date', ignoreDuplicates: true })
        .select();
      if (e2) {
        // 실패했는데 '생성 완료'로 기록하면 그 날짜는 영영 안 만들어진다 (2026-09-14에 겪은 문제)
        console.error('반복 업무 생성 실패:', e2.message);
        return 0;
      }
      if (data) made = data.length;
    }
    if (touched.length) {
      await this.sb.from('recurring_tasks')
        .update({ generated_through: horizon }).in('id', touched);
    }
    return made;
  }

  // ---------- 회의 (v2.2.0) ----------
  // 회의 = 반복 업무 중 종류가 '회의'인 규칙. 참석자가 아니어도 이름·일정은 볼 수 있다(meeting_rules).
  async listMeetingRules() {
    const { data, error } = await this.sb.rpc('meeting_rules');
    check(error, '회의 목록을 불러오지 못했습니다.');
    return (data || []).map(rowToRule);
  }

  async listMeetingItems(_actorId, ruleId, date) {
    const { data, error } = await this.sb.from('meeting_items').select('*')
      .eq('rule_id', ruleId).eq('meet_date', date).order('sort').order('created_at').order('id');
    check(error, '회의록을 불러오지 못했습니다.');
    return data.map(rowToMeetItem);
  }

  // 회의록이 적힌 날짜들 (최근 순)
  async listMeetingDates(_actorId, ruleId) {
    const { data, error } = await this.sb.from('meeting_items').select('meet_date')
      .eq('rule_id', ruleId).order('meet_date', { ascending: false }).limit(500);
    check(error, '회의 날짜를 불러오지 못했습니다.');
    return [...new Set(data.map((r) => r.meet_date))];
  }

  async createMeetingItem(_actorId, d) {
    const row = meetItemRow(d);
    row.rule_id = d.ruleId;
    row.meet_date = d.meetDate;
    row.created_by = this.user && this.user.id;
    const { data, error } = await this.sb.from('meeting_items').insert(row).select().single();
    check(error, '회의록 항목을 추가하지 못했습니다.');
    return rowToMeetItem(data);
  }

  async updateMeetingItem(_actorId, id, patch) {
    const row = meetItemRow(patch);
    row.updated_at = new Date().toISOString();
    const { data, error } = await this.sb.from('meeting_items').update(row).eq('id', id).select();
    check(error, '회의록을 저장하지 못했습니다.');
    if (!data || !data.length) throw new Error('회의록 항목을 찾을 수 없습니다.');
    return rowToMeetItem(data[0]);
  }

  async removeMeetingItem(_actorId, id) {
    const { error } = await this.sb.from('meeting_items').delete().eq('id', id);
    check(error, '회의록 항목을 지우지 못했습니다.');
    return true;
  }

  // ---------- 검색 ----------
  async searchTasks(_actorId, q, limit = 200) {
    const term = String(q || '').trim();
    if (!term) return [];
    const like = `%${term}%`;
    const { data, error } = await this.sb
      .from('tasks').select('*')
      .or(`title.ilike.${like},notes.ilike.${like},tag.ilike.${like}`)
      .order('date', { ascending: false })
      .limit(limit);
    check(error, '검색에 실패했습니다.');
    return data.map(rowToTask);
  }

  // ---------- 지연(미완료) 업무 ----------
  async listOverdue(_actorId, ownerId) {
    const today = localToday();
    let q = this.sb.from('tasks').select(TASK_LIST_COLS).lt('date', today).neq('status', 'done');
    if (ownerId && ownerId !== 'all') q = q.or(ownerOr(ownerId));
    const { data, error } = await q.order('date');
    check(error, '지연 업무를 불러오지 못했습니다.');
    return data.map(rowToTask).filter((t) => !isLeaveTitle(t.title));
  }

  async carryOverdue(_actorId, ids) {
    if (!ids || !ids.length) return 0;
    const { data, error } = await this.sb
      .from('tasks')
      .update({ date: localToday(), updated_at: new Date().toISOString() })
      .in('id', ids).select();
    check(error, '이월에 실패했습니다.');
    return data ? data.length : 0;
  }

  // ---------- 팀 휴가 현황 ----------
  async listLeaves(_actorId, year, month) {
    // 그 달의 실제 마지막 날을 구한다.
    // 무조건 31일로 하면 30일까지인 달·2월에서 DB가 날짜 오류를 낸다.
    const last = new Date(year, month, 0).getDate();
    const mm = String(month).padStart(2, '0');
    const from = `${year}-${mm}-01`;
    const to = `${year}-${mm}-${String(last).padStart(2, '0')}`;
    const { data, error } = await this.sb
      .from('tasks').select('*')
      .gte('date', from).lte('date', to)
      .in('title', LEAVE_TITLES)
      .order('date');
    check(error, '휴가 현황을 불러오지 못했습니다.');
    return data.map(rowToTask);
  }

  // ---------- 업체 태그 ----------
  async listTags() {
    const { data, error } = await this.sb.from('tasks').select('tag').neq('tag', '');
    if (error) return [];
    return [...new Set(data.map((r) => r.tag).filter(Boolean))].sort();
  }

  // ---------- 업무 ----------
  // RLS가 자동으로 "볼 수 있는 것"만 돌려주므로 여기서 필터링하지 않는다.
  async listTasks(args = {}) {
    let q = this.sb.from('tasks').select(TASK_LIST_COLS);
    if (args.ownerId && args.ownerId !== 'all') q = q.or(ownerOr(args.ownerId));
    if (args.date) q = q.eq('date', args.date);
    // 화면에 보이는 기간만 받는다 (예전엔 전체 업무를 매번 통째로 받았다)
    if (args.from) q = q.gte('date', args.from);
    if (args.to) q = q.lte('date', args.to);
    if (args.status && args.status !== 'all') q = q.eq('status', args.status);

    const { data, error } = await q.order('date').order('due_time');
    check(error, '업무를 불러오지 못했습니다.');

    // 정렬 기준이 같을 때 순서가 흔들리지 않도록 createdAt·id 까지 비교한다.
    // (수정하면 DB가 돌려주는 순서가 바뀌어 목록이 뒤섞이는 문제 방지)
    const prio = { high: 0, normal: 1, low: 2 };
    return data.map(rowToTask).sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (prio[a.priority] !== prio[b.priority]) return prio[a.priority] - prio[b.priority];
      if ((a.createdAt || '') !== (b.createdAt || '')) {
        return (a.createdAt || '').localeCompare(b.createdAt || '');
      }
      return a.id.localeCompare(b.id);
    });
  }

  // ---------- 1분마다 하는 '새 배정 업무' 확인 (v2.1.1) ----------
  // 예전엔 볼 수 있는 업무 전체(메모 포함)를 매분 받았다 → 전송량의 주범.
  // 이제 '남이 나에게 준 업무'의 id 칸만 받고, 새로 생긴 것만 내용을 받는다.
  async listAssignedToMeIds(userId) {
    const { data, error } = await this.sb
      .from('tasks').select('id')
      .or(ownerOr(userId))
      .not('assigned_by', 'is', null)
      .neq('assigned_by', userId);
    check(error, '배정 업무를 확인하지 못했습니다.');
    return data.map((r) => r.id);
  }

  async listTasksByIds(ids) {
    if (!ids || !ids.length) return [];
    const { data, error } = await this.sb
      .from('tasks').select('id,owner_id,co_owner_ids,title,date,due_time,assigned_by')
      .in('id', ids);
    check(error, '배정 업무를 불러오지 못했습니다.');
    return data.map((r) => ({
      id: r.id, ownerId: r.owner_id, coOwnerIds: r.co_owner_ids || [], title: r.title, date: r.date,
      dueTime: r.due_time || '', assignedBy: r.assigned_by || null,
    }));
  }

  async getTask(id) {
    const { data, error } = await this.sb.from('tasks').select('*').eq('id', id).single();
    if (error || !data) throw new Error('업무를 찾을 수 없거나 볼 권한이 없습니다.');
    const task = rowToTask(data);
    // 함께 담당이면 고칠 수 있다 (삭제·담당자 변경은 대표 담당자를 관리할 수 있는 사람만)
    task.canDelete = this._canManage(task.ownerId);
    task.readOnly = !(task.canDelete || task.coOwnerIds.includes(this.user && this.user.id));
    return task;
  }

  async createTask(task) {
    const me = this.user;
    if (!me) throw new Error('로그인이 필요합니다.');
    const title = (task.title || '').trim();
    if (!title) throw new Error('업무 제목을 입력하세요.');

    const ownerId = me.isAdmin && task.ownerId ? task.ownerId : me.id;
    const coOwnerIds = me.isAdmin ? cleanIds(task.coOwnerIds, ownerId) : [];
    const row = {
      owner_id: ownerId,
      co_owner_ids: coOwnerIds,
      title,
      notes: task.notes || '',
      tag: String(task.tag || '').trim(),
      date: task.date,
      due_time: task.dueTime || '',
      priority: task.priority || 'normal',
      status: task.status || 'todo',
      assigned_by: ownerId !== me.id || coOwnerIds.length ? me.id : null,
    };
    const { data, error } = await this.sb.from('tasks').insert(row).select().single();
    check(error, '업무 추가에 실패했습니다.');
    return rowToTask(data);
  }

  async updateTask(id, patch) {
    const map = {
      title: 'title', notes: 'notes', tag: 'tag', date: 'date', dueTime: 'due_time',
      priority: 'priority', status: 'status', ownerId: 'owner_id',
    };
    const row = { updated_at: new Date().toISOString() };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch && patch[k] !== undefined) row[col] = patch[k];
    }
    if ('coOwnerIds' in patch && patch.coOwnerIds !== undefined) {
      row.co_owner_ids = cleanIds(patch.coOwnerIds, patch.ownerId);
      // 담당자를 새로 붙이면 '요청한 사람'으로 남긴다 (배정 알림이 가도록)
      if (row.co_owner_ids.length && this.user) row.assigned_by = this.user.id;
    }
    const { data, error } = await this.sb.from('tasks').update(row).eq('id', id).select();
    check(error, '수정에 실패했습니다.');
    if (!data || !data.length) throw new Error('이 업무를 수정할 권한이 없습니다.');
    return rowToTask(data[0]);
  }

  async removeTask(id) {
    const { data, error } = await this.sb.from('tasks').delete().eq('id', id).select();
    check(error, '삭제에 실패했습니다.');
    if (!data || !data.length) throw new Error('이 업무를 삭제할 권한이 없습니다.');
    return true;
  }
}

module.exports = CloudStore;

  return module.exports;
}
