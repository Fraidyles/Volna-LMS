(function(){
"use strict";

var API = "/api";
var ROLE_LABELS = { super_admin:"Главный администратор", admin:"Администратор", curator:"Куратор обучения", student:"Врач" };
function roleLabel(r){ return ROLE_LABELS[r] || r || "—"; }
function isStaffRole(r){ return r==="curator" || r==="admin" || r==="super_admin"; }
function canAssignRole(actingRole, targetRole){
  if(actingRole === "super_admin") return targetRole==="admin" || targetRole==="curator";
  if(actingRole === "admin") return targetRole==="curator";
  return false;
}
function assignableRoleOptions(actingRole){
  if(actingRole === "super_admin") return ["admin","curator"];
  if(actingRole === "admin") return ["curator"];
  return [];
}

/* ============================= СОСТОЯНИЕ ============================= */
var me = null;                 // текущий пользователь {id,email,name,role,...}
var view = "loading";
var course = null;             // {course, lessons, quiz, progress} — для врача
var studentState = { tab:"course", lessonIndex:0, quizMode:false, quizSubmitted:false, messagesSubTab:"curator" };
var staffState = { mainTab:"students", students:[], staff:[], invites:[], search:"", selectedStudentId:null, selectedStudent:null, drawerTab:"progress", selectedIds:[], materials:[], quizAdmin:[], auditLog:[], inviteMode:"single", certSelectedIds:[], notes:[], noteDraft:"" };
var profileEditor = { open:false };
var calendarState = { monthDate:new Date(), streams:[], events:[], showStreamForm:false, eventModalMode:null, eventModalDate:null, eventModalId:null, recurring:false };
var materialsPicker = { open:false, targetId:null, targetTitle:"", search:"", selectedIds:[] };
var streamChat = { open:false, streamId:null, streamName:"" };
var courseVisibility = {}; // {lessonId|"quiz": [uid,...]} — для вкладки «Материалы» у персонала
var directory = []; // все сотрудники (admin+curator+super_admin) — для фильтра/назначения куратора
var dashboardState = { periodFrom:"", periodTo:"", specializations:[], streams:[], stages:[], products:[], certStatuses:[], paymentStatuses:[], demoStatuses:[], accessStatuses:[], curatorIds:[], openFilterMenu:null };

var PRODUCTS = { longevity:"Медицина Долголетия", peptide:"Пептидная терапия", personal_brand:"Личный бренд" };
var PAYMENT_LABELS = { unpaid:"Не оплачено", partial:"Частично оплачено", paid:"Оплачено" };
var STAGE_LABELS = { new:"Новый", in_progress:"В процессе", demo_done:"Демо завершено", certified:"Сертифицирован" };
function studentStage(s){
  if(!s) return "new";
  if(s.certificate_status === "issued") return "certified";
  if(s.completed) return "demo_done";
  if((s.completed_lessons||[]).length > 0) return "in_progress";
  return "new";
}
function accessStatusOf(s){
  if(s.access_blocked) return "blocked";
  if(s.access_expires_at){
    var exp = String(s.access_expires_at).slice(0,10);
    if(exp < isoDate(new Date())) return "expired";
  }
  return "active";
}
var msgPollTimer = null;
var toastTimer = null;
var changePasswordOpen = false;
var previewMode = false;
var previewReturnTab = "students";
var tempPasswordResult = null; // {name, tempPassword} — показать один раз после сброса пароля
var lessonEditor = { open:false, isNew:false, id:null, title:"", duration:"", html:"", dripDays:null, hasDraft:false, publishedTitle:"", publishedDuration:"", publishedHtml:"", history:[], showHistory:false, showPreview:false };
var quizEditor = { open:false, isNew:false, id:null, question:"", options:[], correct:0 };

function pad2(n){ return (n<10?"0":"")+n; }
function isoDate(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function monthLabel(d){ return d.toLocaleDateString("ru-RU",{month:"long",year:"numeric"}); }
function icsEscape(s){
  // RFC 5545: экранировать \, ; и , в текстовых полях — иначе запятая в теме
  // эфира ("...пептидная терапия, часть 2") ломает разбор SUMMARY в части календарей.
  return String(s).replace(/\r?\n/g," ").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,");
}
function generateICS(ev){
  var start = new Date(ev.event_date+"T"+(ev.event_time||"00:00")+":00");
  var end = new Date(start.getTime() + (ev.duration_min||60)*60000);
  function fmt(d){ return d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate())+"T"+pad2(d.getHours())+pad2(d.getMinutes())+"00"; }
  var lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Dolgoletie LMS//RU","BEGIN:VEVENT","UID:"+ev.id+"@dolgoletie-lms","DTSTART:"+fmt(start),"DTEND:"+fmt(end),"SUMMARY:"+icsEscape(ev.title||"Эфир")];
  if(ev.description) lines.push("DESCRIPTION:"+icsEscape(ev.description));
  if(ev.join_url) lines.push("LOCATION:"+icsEscape(ev.join_url));
  lines.push("END:VEVENT","END:VCALENDAR");
  return lines.join("\r\n");
}
function downloadICS(ev){
  var blob = new Blob([generateICS(ev)], {type:"text/calendar"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = (ev.title||"event").replace(/[^\wа-яёА-ЯЁ\- ]/g,"").trim()+".ics";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}
function buildStreamOptions(selectedId, emptyLabel){
  var opts = '<option value=""'+(!selectedId?' selected':'')+'>'+emptyLabel+'</option>';
  calendarState.streams.forEach(function(s){ opts += '<option value="'+s.id+'"'+(selectedId===s.id?' selected':'')+'>'+escapeHtml(s.name)+'</option>'; });
  return opts;
}

function $(sel, root){ return (root||document).querySelector(sel); }
function el(html){ var d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstChild; }
function escapeHtml(s){ return (s==null?"":String(s)).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function initials(name){ var p=(name||"?").trim().split(/\s+/); return ((p[0]||"?")[0]+(p[1]?p[1][0]:"")).toUpperCase(); }

/* ============================= ИКОНКИ (авторский SVG-набор) ============================= */
var ICONS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M4.5 12.5l4.5 4.5L19.5 7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  star: '<path d="M12 3.5l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6-4.4-4.2 6-.8Z"/>',
  repeat: '<path d="M4 7.5h12.5a3.5 3.5 0 0 1 3.5 3.5v1M20 16.5H7.5A3.5 3.5 0 0 1 4 13v-1"/><path d="M7.5 4 4 7.5 7.5 11M16.5 20l3.5-3.5-3.5-3.5"/>',
  clipboard: '<rect x="5.5" y="4.5" width="13" height="16" rx="1.5"/><path d="M9 4.5V3.8A1.8 1.8 0 0 1 10.8 2h2.4A1.8 1.8 0 0 1 15 3.8v.7"/><path d="M8.5 11h7M8.5 15h7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M19.5 19.5l-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  badge: '<circle cx="12" cy="9.5" r="5.5"/><path d="M9 14l-2 7 5-2.5L17 21l-2-7"/>',
  doctor: '<path d="M7 3.5v5a5 5 0 0 0 10 0v-5"/><path d="M17 8v2a5 5 0 0 1-10 0"/><circle cx="19" cy="5" r="2"/><path d="M12 15.5v3.5"/><circle cx="12" cy="20.5" r="1.3"/>',
  chevron: '<path d="M6 9.5l6 6 6-6"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M7 7l1 12.5A1.5 1.5 0 0 0 9.5 21h5a1.5 1.5 0 0 0 1.5-1.5L17 7"/>'
};
function icon(name, cls){ return '<svg class="ic'+(cls?' '+cls:'')+'" viewBox="0 0 24 24">'+(ICONS[name]||'')+'</svg>'; }
function brandMark(style){ return '<span class="mark"'+(style?' style="'+style+'"':'')+'>'+icon("doctor")+'</span>'; }

/* ============================= МАГНИТ (единственный язык статуса) ============================= */
function magnet(kind, label){
  return '<span class="magnet '+kind+'"><span class="magnet-dot"></span><span class="magnet-label">'+escapeHtml(label)+'</span></span>';
}
function fmtDate(iso){ if(!iso) return "—"; try{ return new Date(iso).toLocaleDateString("ru-RU",{day:"numeric",month:"short",year:"numeric"}); }catch(e){ return "—"; } }
function fmtTime(iso){ if(!iso) return ""; try{ return new Date(iso).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}); }catch(e){ return ""; } }
function showToast(text){
  var old = document.getElementById("toast"); if(old) old.remove();
  var node = el('<div class="toast" id="toast">'+escapeHtml(text)+'</div>');
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ node.remove(); }, 2800);
}

async function api(path, opts){
  opts = opts || {};
  var res = await fetch(API + path, Object.assign({
    credentials: "include",
    headers: opts.body ? { "Content-Type":"application/json" } : {}
  }, opts));
  var data = null;
  try{ data = await res.json(); }catch(e){ data = null; }
  if(!res.ok){
    var err = new Error((data && data.message) || "Ошибка запроса");
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/* ============================= ИНИЦИАЛИЗАЦИЯ ============================= */
async function init(){
  var refParam = new URLSearchParams(window.location.search).get("ref");
  if(refParam) sessionStorage.setItem("lms-ref-code", refParam);
  try{
    var data = await api("/auth/me");
    me = data.user;
    await routeAfterLogin();
  }catch(e){
    view = "login";
    render();
  }
}

async function routeAfterLogin(){
  if(me.role === "student"){
    view = "student";
    await loadCourse();
    await loadCalendarData();
  } else {
    view = "staff";
    await loadStaffData();
    await loadCalendarData();
  }
  render();
}

async function loadCourse(){
  try{
    course = await api("/course");
  }catch(e){
    showToast(e.message);
  }
}

async function loadCalendarData(){
  try{ var s = await api("/streams"); calendarState.streams = s.streams; }catch(e){}
  try{ var ev = await api("/events"); calendarState.events = ev.events; }catch(e){}
}

async function loadStaffData(){
  try{
    var s = await api("/staff/students");
    staffState.students = s.students;
  }catch(e){ showToast(e.message); }
  try{
    var inv = await api("/invites");
    staffState.invites = inv.invites;
  }catch(e){ /* куратор не видит приглашения других ролей — не страшно */ }
  if(me.role==="admin" || me.role==="super_admin"){
    try{
      var t = await api("/staff/team");
      staffState.staff = t.staff;
    }catch(e){}
  }
  try{
    var mat = await api("/course/materials");
    staffState.materials = mat.lessons;
  }catch(e){}
  try{
    var vis = await api("/course/visibility");
    courseVisibility = vis.hiddenFor || {};
  }catch(e){}
  try{
    var dir = await api("/staff/directory");
    directory = dir.staff;
  }catch(e){}
  if(me.role==="admin" || me.role==="super_admin"){
    try{
      var qa = await api("/course/quiz-admin");
      staffState.quizAdmin = qa.quiz;
    }catch(e){}
    try{
      var log = await api("/staff/audit-log");
      staffState.auditLog = log.log;
    }catch(e){}
  }
}

async function refreshSelectedStudent(){
  if(!staffState.selectedStudentId) return;
  try{
    var d = await api("/staff/students/"+staffState.selectedStudentId);
    staffState.selectedStudent = d.student;
    var idx = staffState.students.findIndex(function(x){ return x.id===d.student.id; });
    if(idx!==-1) staffState.students[idx] = Object.assign({}, staffState.students[idx], d.student);
  }catch(e){ showToast(e.message); }
}

/* ============================= РЕНДЕР: ROOT ============================= */
// Фоновое свечение (см. --glow-a/b/c в styles.css) — три степени насыщенности,
// распределённые по разделам, а не один вариант на весь сайт.
function applyGlow(){
  var g = "a";
  if(view === "login" || view === "register") g = "c";
  else if(view === "student"){
    if(studentState.tab === "schedule") g = "b";
    else if(studentState.tab === "messages" || studentState.tab === "lesson") g = "a";
    else g = "c"; // главная — курс, сертификат
  } else if(view === "staff"){
    if(staffState.mainTab === "calendar") g = "b";
    else if(staffState.mainTab === "dashboard") g = "c";
    else g = "a"; // ученики / материалы / команда / журнал — плотные таблицы
  }
  document.documentElement.setAttribute("data-glow", g);
}

function render(){
  var app = document.getElementById("app");
  var node;
  applyGlow();
  if(view === "loading") node = el('<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:#8A968F;">Загрузка…</div>');
  else if(view === "login") node = renderAuthScreen("login");
  else if(view === "register") node = renderAuthScreen("register");
  else if(view === "student") node = renderStudentShell();
  else if(view === "staff") node = renderStaffShell();
  app.innerHTML = "";
  app.appendChild(node);
  if(changePasswordOpen && (view==="student"||view==="staff")){
    app.appendChild(renderChangePasswordModal());
  }
  if(profileEditor.open && (view==="student"||view==="staff")){
    app.appendChild(renderProfileModal());
  }
  if(tempPasswordResult && view==="staff"){
    app.appendChild(renderTempPasswordModal());
  }
  if(lessonEditor.open && view==="staff"){
    app.appendChild(renderLessonEditorModal());
  }
  if(quizEditor.open && view==="staff"){
    app.appendChild(renderQuizEditorModal());
  }
  wireEvents(app);
}

function renderLessonEditorModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+(lessonEditor.isNew?"Новый урок":"Редактирование урока")+'</b><button class="btn btn-ghost btn-sm" data-action="close-lesson-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body">';
  if(!lessonEditor.isNew && lessonEditor.id===null && !lessonEditor.title && !lessonEditor.html){
    body += '<div class="empty-state" style="padding:30px 10px;">Загрузка…</div>';
  } else {
    if(lessonEditor.hasDraft){
      body += '<div class="card" style="padding:12px 14px;margin-bottom:16px;background:var(--accent-tint);border-color:transparent;">' +
        '<b style="font-size:13px;">Есть несохранённый черновик</b> — врачи всё ещё видят опубликованную версию.</div>';
    }
    if(!lessonEditor.isNew){
      body += '<div class="tabs" style="margin-bottom:14px;">' +
        '<button type="button" class="tab'+(!lessonEditor.showHistory && !lessonEditor.showPreview?' active':'')+'" data-action="lesson-editor-mode" data-mode="edit">Редактирование</button>' +
        '<button type="button" class="tab'+(lessonEditor.showPreview?' active':'')+'" data-action="lesson-editor-mode" data-mode="preview">Предпросмотр</button>' +
        '<button type="button" class="tab'+(lessonEditor.showHistory?' active':'')+'" data-action="lesson-editor-mode" data-mode="history">История версий</button>' +
      '</div>';
    }

    if(lessonEditor.showHistory){
      if(!lessonEditor.history.length){
        body += '<div class="empty-state" style="padding:24px 10px;">Правок ещё не было.</div>';
      } else {
        lessonEditor.history.forEach(function(h){
          body += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
            '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+escapeHtml(h.title)+'</b><span style="font-size:11.5px;color:var(--muted);">до '+fmtDate(h.edited_at)+' '+fmtTime(h.edited_at)+' · '+escapeHtml(h.edited_by||"")+'</span></div>' +
            '<button class="btn btn-sm btn-ghost" data-action="restore-lesson-history" data-history-id="'+h.id+'">Восстановить</button></div>';
        });
      }
    } else if(lessonEditor.showPreview){
      body += '<div class="lesson-body" style="padding:0;"><div class="prose">'+lessonEditor.html+'</div></div>';
    } else {
      body += '<form id="lessonEditorForm">' +
        '<div class="field"><label>Заголовок урока</label><input class="input" name="title" required value="'+escapeHtml(lessonEditor.title)+'"></div>' +
        '<div class="field"><label>Длительность</label><input class="input" name="duration" value="'+escapeHtml(lessonEditor.duration)+'" placeholder="Например, 5 мин"></div>' +
        (!lessonEditor.isNew ? '<div class="field"><label>Открыть через дней после регистрации врача <span style="font-weight:400;color:var(--muted-2);">(пусто — сразу)</span></label><input class="input" type="number" min="0" id="lessonDripInput" value="'+(lessonEditor.dripDays===null||lessonEditor.dripDays===undefined?"":lessonEditor.dripDays)+'" style="max-width:120px;" placeholder="0"></div>' : '') +
        '<div class="field"><label>Содержимое (HTML)</label><textarea class="input" name="html" required style="height:260px;font-family:monospace;font-size:12.5px;">'+escapeHtml(lessonEditor.html)+'</textarea>' +
        '<p class="hint">Тот же формат, что и в исходном контенте: &lt;p&gt;, &lt;h4&gt;, &lt;ul&gt;&lt;li&gt;, а также видео через &lt;div class="video-wrap"&gt;&lt;iframe...&gt;. Опасные теги (script и т.п.) вырезаются автоматически.</p></div>' +
        '<div class="err-text" id="lessonEditorError" style="display:none;"></div>' +
        '<div style="display:flex;gap:10px;">' +
          (lessonEditor.isNew
            ? '<button class="btn btn-primary" type="submit" data-submit-mode="create">Добавить урок</button>'
            : '<button class="btn btn-ghost" type="submit" data-submit-mode="draft">Сохранить черновик</button>' +
              '<button class="btn btn-primary" type="submit" data-submit-mode="publish">Сохранить и опубликовать</button>') +
        '</div>' +
      '</form>';
    }
  }
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-lesson-editor"><div class="drawer" data-stop="1" style="width:min(600px,100%);">'+body+'</div></div>');
}

function renderQuizEditorModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+(quizEditor.isNew?"Новый вопрос":"Редактирование вопроса")+'</b><button class="btn btn-ghost btn-sm" data-action="close-quiz-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><form id="quizEditorForm">' +
      '<div class="field"><label>Текст вопроса</label><textarea class="input" name="question" required style="height:60px;">'+escapeHtml(quizEditor.question)+'</textarea></div>' +
      '<label>Варианты ответа — отметьте правильный</label>';
  quizEditor.options.forEach(function(opt,i){
    body += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
      '<input type="radio" name="correct" value="'+i+'"'+(quizEditor.correct===i?' checked':'')+' style="accent-color:var(--primary);">' +
      '<input class="input" name="opt'+i+'" value="'+escapeHtml(opt)+'" required>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="remove-quiz-option" data-idx="'+i+'" title="Убрать вариант">✕</button></div>';
  });
  body += '<button type="button" class="btn btn-sm btn-ghost" data-action="add-quiz-option" style="margin-bottom:10px;">+ Добавить вариант</button>' +
      '<div class="err-text" id="quizEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" style="margin-top:10px;">'+(quizEditor.isNew?"Добавить вопрос":"Сохранить вопрос")+'</button>' +
    '</form></div>';
  return el('<div class="overlay" data-action="overlay-close-quiz-editor"><div class="drawer" data-stop="1" style="width:min(520px,100%);">'+body+'</div></div>');
}

function renderTempPasswordModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Новый пароль создан</b><button class="btn btn-ghost btn-sm" data-action="close-temp-password">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<p style="font-size:13.5px;color:var(--muted);margin:0 0 14px;">Сообщите этот пароль <b style="color:var(--ink);">'+escapeHtml(tempPasswordResult.name)+'</b> лично или через чат — он больше нигде не отобразится.</p>' +
      '<div class="card" style="padding:16px;text-align:center;background:var(--primary-tint);border-color:transparent;margin-bottom:16px;">' +
        '<code style="font-size:20px;font-weight:700;letter-spacing:1px;color:var(--primary-dark);">'+escapeHtml(tempPasswordResult.tempPassword)+'</code>' +
      '</div>' +
      '<button class="btn btn-primary btn-block" data-action="close-temp-password">Понятно</button>' +
    '</div>';
  return el('<div class="overlay" data-action="close-temp-password"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

function renderChangePasswordModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Сменить пароль</b><button class="btn btn-ghost btn-sm" data-action="close-change-password">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><form id="changePasswordForm">' +
      '<div class="field"><label>Текущий пароль</label><input class="input" type="password" name="currentPassword" required></div>' +
      '<div class="field"><label>Новый пароль <span style="font-weight:400;color:var(--muted-2);">(от 6 символов)</span></label><input class="input" type="password" name="newPassword" required minlength="6"></div>' +
      '<div class="err-text" id="changePasswordError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Сохранить новый пароль</button>' +
    '</form>' +
    '<button class="btn btn-ghost btn-block" style="margin-top:10px;" data-action="logout-everywhere">Выйти со всех устройств</button>' +
    '</div>';
  return el('<div class="overlay" data-action="overlay-close-password"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

function renderProfileModal(){
  var isStudent = me.role === "student";
  var body = '<div class="drawer-head"><b style="font-size:16px;">Профиль</b><button class="btn btn-ghost btn-sm" data-action="close-profile-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><form id="profileEditorForm">' +
      '<div class="field"><label>Имя и фамилия</label><input class="input" name="name" required value="'+escapeHtml(me.name||"")+'"></div>' +
      (isStudent ? '<div class="field"><label>Специализация</label><input class="input" name="specialization" value="'+escapeHtml(me.specialization||"")+'"></div>' : '') +
      '<div class="field"><label>Телефон</label><input class="input" type="tel" name="phone" value="'+escapeHtml(me.phone||"")+'"></div>' +
      (isStudent ? '<div class="field"><label>Место работы</label><input class="input" name="workplace" value="'+escapeHtml(me.workplace||"")+'"></div>' : '') +
      '<div class="field"><label>Email</label><div class="input" style="background:var(--line-2);color:var(--muted);">'+escapeHtml(me.email||"")+'</div><p class="hint">Email нельзя изменить самостоятельно — обратитесь к куратору.</p></div>' +
      '<div class="err-text" id="profileEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Сохранить</button>' +
    '</form></div>';
  return el('<div class="overlay" data-action="overlay-close-profile-editor"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

/* ============================= РЕНДЕР: АВТОРИЗАЦИЯ ============================= */
function renderAuthScreen(mode){
  var isLogin = mode === "login";
  var left =
    '<div class="onb-left">' +
      '<div><div class="brand" style="color:#fff;">'+brandMark("background:rgba(255,255,255,.18);")+'Медицина Долголетия</div>' +
      '<h1 style="margin-top:56px;">'+(isLogin ? "С возвращением" : "Регистрация на демо-курс")+'</h1>' +
      '<p>'+(isLogin ? "Войдите, чтобы продолжить обучение или открыть панель куратора." : "Пара полей — и вы сразу в первом уроке.")+'</p></div>' +
    '</div>';

  var right;
  if(isLogin){
    right =
      '<div class="onb-right"><div class="onb-box">' +
        '<div class="brand" style="margin-bottom:28px;">'+brandMark()+'Медицина Долголетия</div>' +
        '<h2 style="font-size:19px;margin:0 0 20px;">Вход</h2>' +
        '<form id="loginForm">' +
          '<div class="field"><label>Email</label><input class="input" type="email" name="email" required></div>' +
          '<div class="field"><label>Пароль</label><input class="input" type="password" name="password" required></div>' +
          '<div class="err-text" id="authError" style="display:none;"></div>' +
          '<button class="btn btn-primary btn-block" type="submit">Войти</button>' +
        '</form>' +
        '<button class="back-link" style="margin-top:16px;" data-action="go-register">Ещё нет аккаунта? Зарегистрироваться →</button>' +
      '</div></div>';
  } else {
    right =
      '<div class="onb-right"><div class="onb-box">' +
        '<button class="back-link" data-action="go-login">← Уже есть аккаунт? Войти</button>' +
        '<div class="brand" style="margin-bottom:20px;">'+brandMark()+'Медицина Долголетия</div>' +
        '<h2 style="font-size:19px;margin:0 0 20px;">Расскажите о себе</h2>' +
        '<form id="registerForm">' +
          '<div class="field"><label>Имя и фамилия</label><input class="input" name="name" required placeholder="Например, Анна Ковалёва"></div>' +
          '<div class="field"><label>Специализация</label><input class="input" name="specialization" required placeholder="Например, терапевт, эндокринолог"></div>' +
          '<div class="field"><label>Email</label><input class="input" type="email" name="email" required></div>' +
          '<div class="field"><label>Телефон <span style="font-weight:400;color:var(--muted-2);">(необязательно)</span></label><input class="input" type="tel" name="phone"></div>' +
          '<div class="field"><label>Место работы <span style="font-weight:400;color:var(--muted-2);">(необязательно)</span></label><input class="input" name="workplace"></div>' +
          '<div class="field"><label>Пароль <span style="font-weight:400;color:var(--muted-2);">(от 6 символов)</span></label><input class="input" type="password" name="password" required minlength="6"></div>' +
          '<div class="err-text" id="authError" style="display:none;"></div>' +
          '<button class="btn btn-primary btn-block" type="submit">Начать курс</button>' +
        '</form>' +
        '<p class="hint">Если вам уже выдали доступ куратора или администратора на этот email — роль назначится автоматически вместо регистрации на курс.</p>' +
      '</div></div>';
  }
  return el('<div class="onb-shell">'+left+right+'</div>');
}

/* ============================= РЕНДЕР: TOPBAR ============================= */
function renderTopbar(){
  var roleText = previewMode ? "Просмотр" : (view === "staff" ? roleLabel(me.role) : "Демо-курс");
  var isDark = getTheme()==="dark";
  var themeBtn = '<button class="btn btn-sm btn-ghost" data-action="toggle-theme" title="Переключить тему">'+icon(isDark?"sun":"moon")+'</button>';
  var rightControls = previewMode
    ? themeBtn + '<button class="btn btn-sm btn-ghost" data-action="exit-preview">Вернуться в панель</button>'
    : themeBtn + '<button class="btn btn-sm btn-ghost" data-action="open-profile-editor">Профиль</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-change-password">Сменить пароль</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="logout">Выйти</button>';
  return el(
    '<div class="topbar"><div class="wrap topbar-inner">' +
      '<div class="brand">'+brandMark()+'Медицина Долголетия</div>' +
      '<div class="who"><span class="role-label">'+escapeHtml(roleText)+'</span><span class="name">'+escapeHtml(me.name||"")+'</span>' +
      rightControls + '</div>' +
    '</div></div>'
  );
}

// Тёмная тема — дефолт продукта (не только системная), можно переключить вручную.
function getTheme(){ return localStorage.getItem("lms-theme") || "dark"; }
function applyTheme(){ document.documentElement.setAttribute("data-theme", getTheme()); }
function toggleTheme(){
  localStorage.setItem("lms-theme", getTheme()==="dark" ? "light" : "dark");
  applyTheme();
}

/* ============================= РЕНДЕР: СТУДЕНТ ============================= */
function renderStudentShell(){
  var wrap = el('<div></div>');
  if(previewMode){
    wrap.appendChild(el('<div style="background:var(--accent);color:#1B1A14;text-align:center;padding:10px 16px;font-size:13.5px;font-weight:600;position:sticky;top:0;z-index:40;display:flex;align-items:center;justify-content:center;gap:8px;">'+icon("eye")+' Режим просмотра «глазами врача» — изменения не сохраняются &nbsp; <button class="btn btn-sm" style="background:rgba(27,26,20,.14);border-color:transparent;color:#1B1A14;" data-action="exit-preview">Вернуться в панель</button></div>'));
  }
  wrap.appendChild(renderTopbar());
  var shell = el('<div class="shell"><div class="wrap" id="studentContent"></div></div>');
  wrap.appendChild(shell);
  var content = shell.querySelector("#studentContent");

  if(!course){
    content.appendChild(el('<div class="empty-state">Не удалось загрузить курс.</div>'));
    return wrap;
  }

  if(studentState.tab === "lesson"){
    content.appendChild(renderCoursePlayer());
  } else {
    var tabs = previewMode ? ["course","schedule"] : ["course","schedule","messages"];
    content.appendChild(renderTabsRow(tabs, studentState.tab, "student-tab", { messages: course.unreadMessages||0 }));
    if(studentState.tab === "messages" && !previewMode) content.appendChild(renderStudentMessages());
    else if(studentState.tab === "schedule") content.appendChild(renderStudentSchedule());
    else content.appendChild(renderStudentHome());
  }
  return wrap;
}

function renderTabsRow(tabs, active, actionName, badges){
  var labels = { course:"Курс", messages:"Сообщения", progress:"Прогресс", chat:"Чат", profile:"Профиль", schedule:"Эфиры" };
  var html = '<div class="tabs" style="margin-top:24px;">';
  tabs.forEach(function(t){
    var count = badges && badges[t];
    html += '<button class="tab'+(t===active?' active':'')+'" data-action="'+actionName+'" data-tab="'+t+'">'+labels[t]+
      (count?'<span class="tab-badge">'+(count>9?"9+":count)+'</span>':'')+'</button>';
  });
  html += '</div>';
  return el(html);
}

function renderStudentSchedule(){
  var mySid = me.stream_id || "";
  var relevant = calendarState.events.filter(function(ev){ return !ev.stream_id || ev.stream_id===mySid; });

  function eventEnd(ev){
    var start = new Date(ev.event_date+"T"+(ev.event_time||"00:00")+":00");
    return new Date(start.getTime() + (ev.duration_min||60)*60000);
  }
  function isLiveNow(ev){
    var start = new Date(ev.event_date+"T"+(ev.event_time||"00:00")+":00");
    var now = new Date();
    return start<=now && now<=eventEnd(ev);
  }
  // «Прошедший» — это уже закончившийся эфир (учитывая длительность), а не просто наступившее время начала:
  // иначе идущий сейчас эфир мгновенно попадал бы в прошедшие в момент старта.
  var now = new Date();
  var upcoming = relevant.filter(function(ev){ return eventEnd(ev) >= now; });
  var past = relevant.filter(function(ev){ return eventEnd(ev) < now; });

  function row(ev, isUpcoming){
    var live = isUpcoming && isLiveNow(ev);
    return '<div class="card" style="padding:14px 16px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
      '<div>'+(live?magnet("live","В эфире")+'<br>':'')+'<b style="font-size:14px;display:block;margin-top:'+(live?'6px':'0')+';">'+escapeHtml(ev.title)+'</b>' +
      '<span style="font-family:var(--mono);font-size:12px;color:var(--muted);">'+fmtDate(ev.event_date)+' в '+escapeHtml(ev.event_time||"—")+(ev.speaker?(' · '+escapeHtml(ev.speaker)):'')+'</span></div>' +
      (isUpcoming ? '<div style="display:flex;gap:8px;">' +
        (ev.join_url?'<a class="btn btn-sm '+(live?'btn-primary':'btn-ghost')+'" href="'+escapeHtml(ev.join_url)+'" target="_blank" rel="noopener">Подключиться</a>':'') +
        '<button class="btn btn-sm btn-ghost" data-action="download-ics" data-id="'+ev.id+'">В календарь</button></div>' : '') +
    '</div>';
  }

  var html = '<div style="margin-top:6px;max-width:640px;"><b style="font-size:14.5px;display:block;margin-bottom:12px;">Ближайшие эфиры</b>';
  if(!upcoming.length) html += '<div class="card empty-state" style="padding:30px 20px;">Пока эфиры не запланированы.</div>';
  else upcoming.forEach(function(ev){ html += row(ev, true); });
  if(past.length){
    html += '<b style="font-size:14.5px;display:block;margin:22px 0 12px;">Прошедшие</b>';
    past.slice(-5).reverse().forEach(function(ev){ html += row(ev, false); });
  }
  html += '</div>';
  return el(html);
}

function renderStudentHome(){
  var pr = course.progress || {};
  var total = course.lessons.length;
  var doneIds = pr.completed_lessons||[];
  var done = doneIds.length;
  var lock = course.locked || {locked:false};

  var html = '<div style="margin-top:10px;">';
  if(lock.locked){
    html += '<div class="card course-hero" style="background:var(--status-blocked-tint);">' +
      magnet("blocked", "Доступ ограничен") +
      '<h2 style="margin-top:14px;">'+escapeHtml(course.course.title)+'</h2>' +
      '<p>'+(lock.reason==="blocked" ? 'Куратор временно ограничил ваш доступ к демо-курсу.' : 'Срок доступа к демо-курсу истёк.')+' Чтобы продолжить обучение, напишите куратору — он может продлить или снять ограничение.</p>' +
      '<button class="btn btn-primary" data-action="student-tab" data-tab="messages">Написать куратору</button></div>';
  } else {
    // Статус-трек: один слот на урок + слот теста. Это «Моя строка» — сигнатурный элемент направления.
    var slots = '<div class="status-track">';
    course.lessons.forEach(function(l,i){
      var isDone = doneIds.indexOf(l.id)!==-1;
      var isCurrent = !isDone && doneIds.length===i;
      slots += '<div class="slot'+(isDone?' done':(isCurrent?' current':''))+'" title="'+escapeHtml(l.title)+'"></div>';
    });
    var quizDone = !!pr.completed;
    var quizCurrent = !quizDone && done===total;
    slots += '<div class="slot'+(quizDone?' done':(quizCurrent?' current':''))+'" title="Итоговый тест"></div>';
    slots += '</div>';

    html += '<div class="card course-hero">' +
      '<h2>'+escapeHtml(course.course.title)+'</h2>' +
      '<p>5 коротких уроков и итоговый тест. По завершении — сертификат и возможность оставить заявку на полную программу обучения.</p>' +
      slots +
      '<div class="progress-label">'+done+' / '+total+' уроков'+(pr.completed?' · тест '+pr.quiz_score+'%':'')+'</div>' +
      '<button class="btn btn-primary" data-action="open-course">'+(done>0?'Продолжить курс':'Начать курс')+'</button>' +
      '</div>';
  }

  // Строка доски: ближайший эфир / сертификат / сообщения — три разных по форме плитки, не одинаковые icon+heading карточки.
  var mySid = me.stream_id || "";
  var relevantEvents = calendarState.events.filter(function(ev){ return !ev.stream_id || ev.stream_id===mySid; });
  var nextEvent = null, liveNow = false;
  relevantEvents.forEach(function(ev){
    var startKey = ev.event_date+"T"+(ev.event_time||"00:00");
    var start = new Date(startKey);
    var end = new Date(start.getTime() + (ev.duration_min||60)*60000);
    var now = new Date();
    if(!nextEvent && end >= now){ nextEvent = ev; liveNow = (start<=now && now<=end); }
  });

  html += '<div class="board-strip">';

  html += '<div class="card" style="padding:18px;">';
  if(nextEvent){
    html += (liveNow ? magnet("live","Идёт сейчас") : magnet("attention","Ближайший эфир")) +
      '<b style="font-size:14px;display:block;margin:10px 0 2px;">'+escapeHtml(nextEvent.title)+'</b>' +
      '<span style="font-family:var(--mono);font-size:12px;color:var(--muted);">'+fmtDate(nextEvent.event_date)+' · '+escapeHtml(nextEvent.event_time||"")+'</span>' +
      (liveNow && nextEvent.join_url ? '<a class="btn btn-sm btn-primary" style="margin-top:12px;" href="'+escapeHtml(nextEvent.join_url)+'" target="_blank" rel="noopener">Подключиться</a>' :
        '<button class="btn btn-sm btn-ghost" style="margin-top:12px;" data-action="student-tab" data-tab="schedule">Все эфиры →</button>');
  } else {
    html += magnet("neutral","Эфиры") + '<p style="font-size:12.5px;color:var(--muted);margin:10px 0 0;">Пока не запланированы.</p>';
  }
  html += '</div>';

  html += '<div class="card" style="padding:18px;">';
  if(pr.completed){
    var issued = pr.certificate_status==="issued";
    html += magnet(issued?"done":"attention", issued?"Сертификат выдан":"На проверке") +
      '<div style="font-family:var(--display);font-weight:800;font-size:26px;margin:10px 0 2px;letter-spacing:-.02em;">'+pr.quiz_score+'%</div>' +
      '<span style="font-size:12px;color:var(--muted);">результат теста</span>';
    if(!issued && !pr.requested_full_access){
      html += '<button class="btn btn-sm btn-primary btn-block" style="margin-top:12px;" data-action="request-full">Заявка на полную программу</button>';
    } else if(pr.requested_full_access){
      html += '<div style="margin-top:12px;">'+magnet("done","Заявка отправлена")+'</div>';
    }
  } else {
    html += magnet("neutral","Сертификат") + '<p style="font-size:12.5px;color:var(--muted);margin:10px 0 0;">Появится после теста.</p>';
  }
  html += '</div>';

  html += '<div class="card" style="padding:18px;">' +
    magnet("neutral","Куратор") +
    '<p style="font-size:13px;color:var(--muted);margin:10px 0 12px;line-height:1.4;">Вопрос по курсу или доступу — куратор ответит в чате.</p>' +
    '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="messages">Открыть чат →</button>' +
  '</div>';

  html += '</div>';

  if(me.referral_code){
    var refLink = window.location.origin + "/?ref=" + me.referral_code;
    html += '<div class="card" style="padding:18px;margin-top:14px;max-width:520px;">' +
      '<b style="font-size:14px;display:block;margin-bottom:4px;">Пригласите коллегу</b>' +
      '<p style="font-size:12.5px;color:var(--muted);margin:0 0 12px;">Поделитесь ссылкой — когда коллега зарегистрируется по ней, мы это увидим.</p>' +
      '<div style="display:flex;gap:6px;">' +
        '<input class="input" readonly value="'+escapeHtml(refLink)+'" style="font-size:12px;" id="refLinkInput">' +
        '<button class="btn btn-sm btn-ghost" data-action="copy-ref-link">Скопировать</button>' +
      '</div></div>';
  }
  html += '</div>';
  return el(html);
}

function renderCoursePlayer(){
  if(studentState.quizMode) return renderQuizOrCert();
  var idx = studentState.lessonIndex;
  var lesson = course.lessons[idx];
  var doneIds = (course.progress && course.progress.completed_lessons) || [];

  var nav = '<div class="lesson-nav">';
  course.lessons.forEach(function(l,i){
    var isDone = doneIds.indexOf(l.id)!==-1;
    var isLocked = l.hiddenForMe || l.dripLockedForMe;
    var lockLabel = l.hiddenForMe ? 'Временно недоступен' : (l.dripLockedForMe ? 'Откроется '+fmtDate(l.availableAt) : escapeHtml(l.duration||""));
    nav += '<div class="lesson-item'+(i===idx?' active':'')+(isDone?' done':'')+'" data-action="goto-lesson" data-idx="'+i+'"'+(isLocked?' style="opacity:.45;cursor:not-allowed;"':'')+'>' +
      '<span class="lesson-num">'+(isLocked?icon("lock","ic-sm"):(isDone?icon("check","ic-sm"):(i+1)))+'</span><div><b>'+escapeHtml(l.title)+'</b><span>'+lockLabel+'</span></div></div>';
  });
  nav += '<div class="lesson-item'+(studentState.quizMode?' active':'')+'" data-action="goto-quiz"'+(course.quizHiddenForMe?' style="opacity:.45;cursor:not-allowed;"':'')+'>' +
    '<span class="lesson-num">'+(course.quizHiddenForMe?icon("lock","ic-sm"):(course.progress && course.progress.completed?icon("check","ic-sm"):icon("star","ic-sm")))+'</span><div><b>Итоговый тест</b><span>'+(course.quizHiddenForMe?'Временно недоступен':course.quiz.length+' вопросов')+'</span></div></div>';
  nav += '</div>';

  if(lesson.hiddenForMe || lesson.dripLockedForMe){
    var lockedText = lesson.hiddenForMe ? 'Этот урок временно недоступен.<br>Куратор откроет его позже.' : 'Этот урок ещё не открылся.<br>Станет доступен '+fmtDate(lesson.availableAt)+'.';
    var lockedBody = '<div class="lesson-body"><button class="back-link" data-action="close-course">← К курсу</button>' +
      '<div class="empty-state" style="padding:60px 10px;"><div class="big">'+icon("lock","ic-lg")+'</div>'+lockedText+'</div></div>';
    return el('<div class="player" style="margin-top:6px;">'+nav+lockedBody+'</div>');
  }

  var isLast = idx === course.lessons.length-1;
  var noteVal = (course.progress && course.progress.lesson_notes && course.progress.lesson_notes[lesson.id]) || "";
  var body = '<div class="lesson-body">' +
    '<button class="back-link" data-action="close-course">← К курсу</button>' +
    '<h3>'+escapeHtml(lesson.title)+'</h3>' +
    '<div class="meta">Урок '+(idx+1)+' из '+course.lessons.length+' · '+escapeHtml(lesson.duration||"")+'</div>' +
    '<div class="prose">'+lesson.html+'</div>' +
    '<div class="lesson-note">' +
      '<label>Ваша заметка к уроку <span style="font-weight:400;color:var(--muted-2);">(видна только вам)</span></label>' +
      '<textarea class="input" id="lessonNoteInput" style="height:64px;font-size:13.5px;" placeholder="Например: спросить куратора про дозировки">'+escapeHtml(noteVal)+'</textarea>' +
      '<button class="btn btn-sm btn-ghost" style="margin-top:8px;" data-action="save-lesson-note" data-id="'+lesson.id+'">Сохранить заметку</button>' +
    '</div>' +
    '<div class="lesson-footer">' +
      '<button class="btn btn-ghost" data-action="prev-lesson"'+(idx===0?' disabled':'')+'>← Предыдущий</button>' +
      '<button class="btn btn-primary" data-action="next-lesson">'+(isLast?"Перейти к тесту":"Урок пройден, далее →")+'</button>' +
    '</div></div>';

  return el('<div class="player" style="margin-top:6px;">'+nav+body+'</div>');
}

function renderQuizOrCert(){
  var pr = course.progress || {};
  if(pr.completed && !studentState.quizSubmitted) return renderCertificate();
  if(course.quizHiddenForMe){
    return el('<div class="player" style="margin-top:6px;grid-template-columns:1fr;"><div class="lesson-body">' +
      '<button class="back-link" data-action="close-course">← К курсу</button>' +
      '<div class="empty-state" style="padding:60px 10px;"><div class="big">'+icon("lock","ic-lg")+'</div>Итоговый тест временно недоступен.<br>Куратор откроет его позже.</div></div></div>');
  }

  var html = '<div class="player" style="margin-top:6px;grid-template-columns:1fr;"><div class="lesson-body">' +
    '<button class="back-link" data-action="close-course">← К курсу</button>' +
    '<h3>Итоговый тест</h3><div class="meta">'+course.quiz.length+' вопросов · нужно набрать от 60%</div><form id="quizForm">';
  course.quiz.forEach(function(q,qi){
    html += '<div class="quiz-q"><p class="qtext">'+(qi+1)+'. '+escapeHtml(q.question)+'</p>';
    q.options.forEach(function(opt,oi){
      html += '<label class="opt"><input type="radio" name="'+q.id+'" value="'+oi+'" required> '+escapeHtml(opt)+'</label>';
    });
    html += '</div>';
  });
  html += '<button class="btn btn-primary btn-block" type="submit">Завершить тест</button></form></div></div>';
  return el(html);
}

function renderCertificate(){
  var pr = course.progress || {};
  var issued = pr.certificate_status === "issued";
  var html = '<div class="player" style="margin-top:6px;grid-template-columns:1fr;"><div class="cert">' +
    '<div class="seal'+(issued?'':' pending')+'">'+icon(issued?"badge":"clock","ic-lg")+'</div>' +
    '<h2>'+(issued?'Сертификат выдан':'Тест сдан — сертификат на проверке')+'</h2>' +
    '<p style="color:var(--muted);font-size:14px;">'+escapeHtml(me.name)+', «'+escapeHtml(course.course.title)+'»</p>' +
    '<div class="score">'+pr.quiz_score+'%</div>' +
    '<p style="color:var(--muted);font-size:13px;margin-bottom:24px;">правильных ответов в итоговом тесте</p>';
  if(!issued){
    html += '<p style="font-size:13.5px;color:var(--muted);max-width:360px;margin:0 auto 24px;">Куратор проверит результат и выдаст сертификат — он появится здесь автоматически.</p>';
  } else {
    html += '<p style="font-size:12.5px;color:var(--muted);margin:0 0 24px;">Выдан '+fmtDate(pr.certificate_issued_at)+(pr.certificate_issued_by?(' · '+escapeHtml(pr.certificate_issued_by)):'')+'</p>';
  }
  html += '<button class="btn btn-primary" data-action="close-course">Вернуться к курсу</button></div></div>';
  return el(html);
}

// Два отдельных канала общения врача: личный чат с куратором (как раньше) и
// общая беседа его потока (когорты) — сознательно разведены на под-вкладки,
// а не смешаны в одну ленту, чтобы не терять приватность 1:1-переписки.
function renderStudentMessages(){
  var sub = studentState.messagesSubTab;
  var mySid = me.stream_id || "";
  var html = '<div class="card msg-panel" style="margin-top:6px;max-width:640px;">' +
    '<div style="padding:14px 20px 0;display:flex;gap:6px;">' +
      '<button class="tab'+(sub==="curator"?' active':'')+'" data-action="student-messages-subtab" data-sub="curator">Куратор</button>' +
      '<button class="tab'+(sub==="stream"?' active':'')+'" data-action="student-messages-subtab" data-sub="stream">Поток</button>' +
    '</div>';
  if(sub==="stream"){
    if(!mySid){
      html += '<div class="empty-state" style="padding:30px 20px;">Вы пока не привязаны ни к одному потоку — куратор добавит вас, когда сформируется поток, и здесь появится общая беседа.</div>';
    } else {
      html += '<div style="padding:16px 20px;border-bottom:1px solid var(--line);">' +
          '<b style="font-size:14.5px;">Беседа потока</b>' +
          '<p style="font-size:12px;color:var(--muted);margin:2px 0 0;">Видят и пишут все врачи вашего потока и куратор.</p>' +
        '</div>' +
        '<div class="msg-list" id="msgListStream"><div class="msg-empty">Загрузка…</div></div>' +
        '<div class="msg-input-row"><textarea class="input" id="msgInputStream" placeholder="Написать в общий чат потока…"></textarea>' +
        '<button class="btn btn-primary" data-action="send-student-stream-msg">Отправить</button></div>';
    }
  } else {
    html += '<div style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<b style="font-size:14.5px;">Чат с куратором</b>' +
        '<button class="btn btn-sm btn-ghost" data-action="mark-messages-unread" title="Показать бейдж снова, чтобы вернуться к чату позже">Пометить непрочитанным</button>' +
      '</div>' +
      '<div class="msg-list" id="msgList"><div class="msg-empty">Загрузка…</div></div>' +
      '<div class="msg-input-row"><textarea class="input" id="msgInput" placeholder="Напишите сообщение…"></textarea>' +
      '<button class="btn btn-primary" data-action="send-student-msg">Отправить</button></div>';
  }
  html += '</div>';
  return el(html);
}

/* ============================= РЕНДЕР: ПЕРСОНАЛ ============================= */
function renderStaffShell(){
  var wrap = el('<div></div>');
  wrap.appendChild(renderTopbar());
  var shell = el('<div class="shell"><div class="wrap" id="staffContent"></div></div>');
  wrap.appendChild(shell);
  var content = shell.querySelector("#staffContent");
  content.appendChild(el('<h1 class="section-title">'+escapeHtml(roleLabel(me.role))+'</h1><p class="section-sub" style="margin-top:-2px;">Демо-курс «Медицина Долголетия»</p>'));
  content.appendChild(renderStaffTabs());

  if(staffState.mainTab === "team" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderTeamTab());
  } else if(staffState.mainTab === "calendar"){
    content.appendChild(renderCalendarTab());
  } else if(staffState.mainTab === "materials"){
    content.appendChild(renderMaterialsTab());
  } else if(staffState.mainTab === "dashboard"){
    content.appendChild(renderDashboardTab());
  } else if(staffState.mainTab === "audit" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderAuditLogTab());
  } else {
    content.appendChild(renderStaffStats());
    content.appendChild(renderCertificateQueue());
    content.appendChild(renderRoster());
  }

  if(staffState.selectedStudentId){
    wrap.appendChild(renderStudentDrawer());
  }
  if(calendarState.eventModalMode){
    wrap.appendChild(renderEventModal());
  }
  if(materialsPicker.open){
    wrap.appendChild(renderMaterialsPickerModal());
  }
  if(streamChat.open){
    wrap.appendChild(renderStreamChatModal());
  }
  return wrap;
}

function renderStaffTabs(){
  var html = '<div class="tabs" style="margin-top:4px;">' +
    '<button class="tab'+(staffState.mainTab==="students"?' active':'')+'" data-action="staff-main-tab" data-tab="students">Ученики</button>' +
    '<button class="tab'+(staffState.mainTab==="calendar"?' active':'')+'" data-action="staff-main-tab" data-tab="calendar">Эфиры</button>' +
    '<button class="tab'+(staffState.mainTab==="materials"?' active':'')+'" data-action="staff-main-tab" data-tab="materials">Материалы</button>' +
    '<button class="tab'+(staffState.mainTab==="dashboard"?' active':'')+'" data-action="staff-main-tab" data-tab="dashboard">Dashboard</button>';
  if(me.role==="admin"||me.role==="super_admin"){
    html += '<button class="tab'+(staffState.mainTab==="team"?' active':'')+'" data-action="staff-main-tab" data-tab="team">Команда</button>';
    html += '<button class="tab'+(staffState.mainTab==="audit"?' active':'')+'" data-action="staff-main-tab" data-tab="audit">Журнал</button>';
  }
  html += '</div>';
  return el(html);
}

function renderCalendarTab(){
  return el('<div style="margin-top:6px;">' + renderStreamsPanel() + renderMonthCalendar() + '</div>');
}

function renderStreamsPanel(){
  var streams = calendarState.streams;
  var countsByStream = {};
  staffState.students.forEach(function(s){ var sid=s.stream_id||""; countsByStream[sid]=(countsByStream[sid]||0)+1; });

  var html = '<div class="card" style="padding:18px 20px;margin-bottom:20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:14.5px;">Потоки обучения</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="toggle-stream-form">'+(calendarState.showStreamForm?'Скрыть':'+ Новый поток')+'</button>' +
    '</div>';
  if(calendarState.showStreamForm){
    html += '<form id="streamForm" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px;">' +
      '<div class="field" style="margin-bottom:0;min-width:220px;flex:1;"><label>Название потока</label><input class="input" name="name" required placeholder="Например, Поток «Октябрь 2026»"></div>' +
      '<div class="field" style="margin-bottom:0;"><label>Дата старта</label><input class="input" type="date" name="startDate"></div>' +
      '<button class="btn btn-primary" type="submit">Создать</button></form>';
  }
  if(!streams.length){
    html += '<p style="font-size:13px;color:var(--muted);margin:0;">Пока нет ни одного потока.</p>';
  } else {
    html += '<div style="display:flex;flex-wrap:wrap;gap:10px;">';
    streams.forEach(function(s){
      html += '<div class="stream-card"><b style="font-size:13.5px;display:block;">'+escapeHtml(s.name)+'</b>' +
        '<span style="font-size:12px;color:var(--muted);">старт: '+(s.start_date?fmtDate(s.start_date):"—")+' · '+(countsByStream[s.id]||0)+' врачей</span><br>' +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
          '<button class="btn btn-sm btn-ghost" data-action="open-stream-chat" data-id="'+s.id+'" data-name="'+escapeHtml(s.name)+'">Чат потока</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="delete-stream" data-id="'+s.id+'">Удалить поток</button>' +
        '</div></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderStreamChatModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Чат: '+escapeHtml(streamChat.streamName)+'</b><button class="btn btn-ghost btn-sm" data-action="close-stream-chat">Закрыть ✕</button></div>' +
    '<div class="drawer-body" style="display:flex;flex-direction:column;height:100%;">' +
      '<div class="msg-list" id="streamChatList" style="flex:1;"><div class="msg-empty">Загрузка…</div></div>' +
      '<div class="msg-input-row"><textarea class="input" id="streamChatInput" placeholder="Написать в чат потока…"></textarea>' +
      '<button class="btn btn-primary" data-action="send-stream-chat-msg">Отправить</button></div>' +
    '</div>';
  return el('<div class="overlay" data-action="overlay-close-stream-chat"><div class="drawer" data-stop="1" style="width:min(480px,100%);">'+body+'</div></div>');
}

function renderMonthCalendar(){
  var md = calendarState.monthDate;
  var year = md.getFullYear(), month = md.getMonth();
  var firstDay = new Date(year, month, 1);
  var startOffset = (firstDay.getDay()+6)%7;
  var daysInMonth = new Date(year, month+1, 0).getDate();
  var todayIso = isoDate(new Date());

  var eventsByDate = {};
  calendarState.events.forEach(function(ev){ (eventsByDate[ev.event_date]=eventsByDate[ev.event_date]||[]).push(ev); });

  var html = '<div class="card" style="padding:18px 20px;"><div class="cal-header">' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
      '<button class="btn btn-sm btn-ghost" data-action="cal-prev">←</button>' +
      '<b style="font-size:16px;text-transform:capitalize;">'+monthLabel(md)+'</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="cal-next">→</button></div>' +
    '<button class="btn btn-sm btn-primary" data-action="open-event-form" data-date="'+isoDate(new Date())+'">+ Добавить эфир</button></div>' +
    '<div class="cal-grid cal-grid-head">';
  ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].forEach(function(d){ html += '<div class="cal-dayname">'+d+'</div>'; });
  html += '</div><div class="cal-grid">';
  for(var i=0;i<startOffset;i++){ html += '<div class="cal-cell cal-cell-empty"></div>'; }
  for(var day=1; day<=daysInMonth; day++){
    var dateIso = isoDate(new Date(year,month,day));
    var dayEvents = eventsByDate[dateIso] || [];
    html += '<div class="cal-cell'+(dateIso===todayIso?' cal-today':'')+'" data-action="open-event-form" data-date="'+dateIso+'"><span class="cal-daynum">'+day+'</span>';
    dayEvents.slice(0,2).forEach(function(ev){
      var start = new Date(ev.event_date+"T"+(ev.event_time||"00:00")+":00");
      var end = new Date(start.getTime() + (ev.duration_min||60)*60000);
      var now = new Date();
      var live = start<=now && now<=end;
      html += '<div class="cal-chip'+(live?' live':'')+'" data-action="open-event-details" data-id="'+ev.id+'">'+(ev.event_time?escapeHtml(ev.event_time)+' ':'')+escapeHtml(ev.title)+'</div>';
    });
    if(dayEvents.length>2) html += '<div class="cal-more">+'+(dayEvents.length-2)+' ещё</div>';
    html += '</div>';
  }
  var totalCells = startOffset + daysInMonth;
  var trailing = (7 - (totalCells % 7)) % 7;
  for(var j=0;j<trailing;j++){ html += '<div class="cal-cell cal-cell-empty"></div>'; }
  html += '</div></div>';
  return html;
}

function renderEventModal(){
  if(calendarState.eventModalMode === "create"){
    var body = '<div class="drawer-head"><b style="font-size:16px;">Новый прямой эфир</b><button class="btn btn-ghost btn-sm" data-action="close-event-modal">Закрыть ✕</button></div>' +
      '<div class="drawer-body"><form id="eventForm">' +
        '<div class="field"><label>Тема эфира</label><input class="input" name="title" required></div>' +
        '<div style="display:flex;gap:10px;">' +
          '<div class="field" style="flex:1;"><label>Дата</label><input class="input" type="date" name="date" required value="'+escapeHtml(calendarState.eventModalDate||"")+'"></div>' +
          '<div class="field" style="flex:1;"><label>Время</label><input class="input" type="time" name="time" required value="18:00"></div></div>' +
        '<div class="field"><label>Длительность, мин</label><input class="input" type="number" name="duration" value="60" min="10" step="5"></div>' +
        '<div class="field"><label>Спикер</label><input class="input" name="speaker"></div>' +
        '<div class="field"><label>Поток</label><select class="input" name="streamId">'+buildStreamOptions("", "Все потоки")+'</select></div>' +
        '<div class="field"><label>Ссылка на подключение</label><input class="input" name="joinUrl" placeholder="Zoom / YouTube"></div>' +
        '<div class="field"><label>Описание</label><textarea class="input" name="description" style="height:70px;"></textarea></div>' +
        '<label style="display:flex;align-items:center;gap:8px;margin-bottom:'+(calendarState.recurring?'10px':'20px')+';cursor:pointer;">' +
          '<input type="checkbox" name="recurring" data-action="toggle-recurring"'+(calendarState.recurring?' checked':'')+' style="accent-color:var(--primary);">' +
          '<span style="font-size:13.5px;">Повторять еженедельно</span></label>' +
        (calendarState.recurring ? '<div class="field"><label>Повторять до</label><input class="input" type="date" name="recurrenceUntil" required></div>' : '') +
        '<button class="btn btn-primary btn-block" type="submit">Добавить в расписание</button></form></div>';
    return el('<div class="overlay" data-action="overlay-close-event"><div class="drawer" data-stop="1" style="width:min(480px,100%);">'+body+'</div></div>');
  }
  var ev = calendarState.events.filter(function(x){ return x.id===calendarState.eventModalId; })[0];
  if(!ev) return el('<div></div>');
  var stream = calendarState.streams.filter(function(s){ return s.id===ev.stream_id; })[0];
  var body2 = '<div class="drawer-head"><b style="font-size:16px;">'+escapeHtml(ev.title)+'</b><button class="btn btn-ghost btn-sm" data-action="close-event-modal">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><p style="font-size:13.5px;color:var(--muted);margin:0 0 4px;">'+fmtDate(ev.event_date)+' в '+escapeHtml(ev.event_time||"—")+' · '+(ev.duration_min||60)+' мин</p>' +
    (ev.speaker?'<p style="font-size:13.5px;margin:0 0 4px;">Спикер: '+escapeHtml(ev.speaker)+'</p>':'') +
    '<p style="font-size:13.5px;margin:0 0 4px;">Поток: '+(stream?escapeHtml(stream.name):'Все потоки')+'</p>' +
    (ev.recurrence_group_id ? '<p style="font-size:12.5px;color:var(--accent);margin:0 0 4px;display:flex;align-items:center;gap:5px;">'+icon("repeat","ic-sm")+' Часть серии повторов</p>' : '') +
    (ev.join_url?'<p style="font-size:13.5px;margin:0 0 12px;"><a href="'+escapeHtml(ev.join_url)+'" target="_blank" rel="noopener" style="color:var(--primary-dark);">Ссылка на подключение →</a></p>':'') +
    (ev.description?'<p style="font-size:13.5px;color:var(--muted);margin:0 0 16px;">'+escapeHtml(ev.description)+'</p>':'') +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      '<button class="btn btn-ghost" data-action="delete-event" data-id="'+ev.id+'">Удалить эфир</button>' +
      (ev.recurrence_group_id ? '<button class="btn btn-ghost" data-action="delete-event-series" data-id="'+ev.id+'">Удалить всю серию</button>' : '') +
    '</div></div>';
  return el('<div class="overlay" data-action="overlay-close-event"><div class="drawer" data-stop="1" style="width:min(480px,100%);">'+body2+'</div></div>');
}

var AUDIT_ACTION_LABELS = {
  "auth.register": "Регистрация",
  "auth.change_password": "Смена пароля",
  "auth.logout_everywhere": "Выход со всех устройств",
  "invite.create": "Приглашение по email",
  "invite.bulk_create": "Массовое приглашение",
  "invite.cancel": "Отмена приглашения",
  "staff.remove": "Отзыв доступа сотруднику",
  "staff.role_change": "Изменена роль сотрудника",
  "student.profile_update": "Изменены данные врача",
  "password.reset_by_staff": "Сброс пароля (персоналом)",
  "access.set_expiry": "Установлен срок доступа",
  "access.extend": "Доступ продлён",
  "access.block": "Доступ заблокирован",
  "access.unblock": "Доступ разблокирован",
  "certificate.issue": "Выдан сертификат",
  "content.visibility_change": "Изменена видимость материала",
  "content.lesson_draft_saved": "Сохранён черновик урока",
  "content.lesson_published": "Опубликован урок",
  "content.lesson_restored": "Восстановлена версия урока",
  "content.lesson_created": "Добавлен урок",
  "content.lesson_deleted": "Удалён урок",
  "content.lessons_reordered": "Изменён порядок уроков",
  "content.quiz_edited": "Отредактирован вопрос теста",
  "content.quiz_created": "Добавлен вопрос теста",
  "content.quiz_deleted": "Удалён вопрос теста",
  "content.quiz_reordered": "Изменён порядок вопросов теста",
  "stream.create": "Создан поток",
  "stream.delete": "Удалён поток",
  "event.create": "Создан эфир",
  "event.delete": "Удалён эфир",
  "event.delete_series": "Удалена серия эфиров",
  "audit.revert": "Откат действия"
};
function auditActionLabel(a){ return AUDIT_ACTION_LABELS[a] || a; }
function auditActionKind(a){
  if(!a) return "neutral";
  if(a.indexOf("access.block")===0 || a==="staff.remove" || a==="invite.cancel") return "blocked";
  if(a.indexOf("access.")===0 || a.indexOf("password.")===0) return "attention";
  if(a==="certificate.issue" || a.indexOf("content.lesson_published")===0) return "done";
  if(a==="audit.revert") return "live";
  return "active";
}

function renderAuditLogTab(){
  var html = '<div class="card" style="padding:18px 20px;margin-top:6px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Журнал действий персонала</b>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:0 0 16px;">Последние 100 действий. '+(me.role==="super_admin"?'Обратимые действия можно откатить — это вернёт состояние к тому, что было до изменения.':'')+'</p>';

  if(!staffState.auditLog.length){
    html += '<div class="empty-state"><div class="big">'+icon("clipboard","ic-lg")+'</div>Пока пусто.</div>';
  } else {
    html += '<div style="overflow-x:auto;"><table class="roster"><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Кого/чего касается</th><th></th></tr></thead><tbody>';
    staffState.auditLog.forEach(function(l){
      var canRevert = me.role==="super_admin" && l.revertible && !l.reverted_at;
      var statusNote = l.reverted_at ? '<span style="font-size:11px;color:var(--muted-2);display:block;">откачено '+fmtDate(l.reverted_at)+(l.reverted_by?(' · '+escapeHtml(l.reverted_by)):'')+'</span>' : '';
      html += '<tr>' +
        '<td class="audit-when">'+fmtDate(l.created_at)+' '+fmtTime(l.created_at)+'</td>' +
        '<td>'+escapeHtml(l.actor_name)+(l.actor_role?(' <span style="color:var(--muted);font-size:11.5px;">('+roleLabel(l.actor_role)+')</span>'):'')+'</td>' +
        '<td>'+magnet(auditActionKind(l.action), auditActionLabel(l.action))+statusNote+'</td>' +
        '<td style="color:var(--muted);">'+escapeHtml(l.target_name||l.target_id||"—")+'</td>' +
        '<td style="text-align:right;">'+(canRevert ? '<button class="btn btn-sm btn-ghost" data-action="revert-log" data-id="'+l.id+'" data-label="'+escapeHtml(auditActionLabel(l.action))+'">Откатить</button>' : '')+'</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  return el(html);
}

function renderMaterialsTab(){
  var canEdit = me.role==="admin" || me.role==="super_admin";
  var html = '<div>' +
    '<div class="card" style="padding:18px 20px;margin-top:6px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:14.5px;">Доступность материалов демо-курса</b>' +
      (canEdit ? '<button class="btn btn-sm btn-primary" data-action="open-lesson-creator">+ Добавить урок</button>' : '') +
    '</div>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:0 0 16px;">Скройте урок или тест от конкретных врачей или от всех сразу. Прогресс, который врачи уже прошли, сохранится.</p>';
  staffState.materials.forEach(function(l,i){
    var hiddenCount = (courseVisibility[l.id]||[]).length;
    var isFirst = i===0, isLast = i===staffState.materials.length-1;
    html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
      (canEdit ? '<div style="display:flex;flex-direction:column;gap:2px;">' +
        '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-lesson" data-id="'+l.id+'" data-dir="up"'+(isFirst?' disabled':'')+' title="Выше">↑</button>' +
        '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-lesson" data-id="'+l.id+'" data-dir="down"'+(isLast?' disabled':'')+' title="Ниже">↓</button></div>' : '') +
      '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+(i+1)+'. '+escapeHtml(l.title)+(l.has_draft?' '+magnet("attention","черновик"):'')+'</b><span style="font-size:12px;color:var(--muted);">'+(hiddenCount?'Скрыт от '+hiddenCount+' врачей':'Виден всем')+(l.drip_days?' · открывается через '+l.drip_days+' дн. после регистрации':'')+'</span></div>' +
      (canEdit ? '<button class="btn btn-sm btn-ghost" data-action="open-lesson-editor" data-id="'+l.id+'">Редактировать</button>' : '') +
      '<button class="btn btn-sm '+(hiddenCount?'btn-primary':'btn-ghost')+'" data-action="open-materials-picker" data-id="'+l.id+'" data-title="'+escapeHtml(l.title)+'">Настроить видимость</button>' +
      (canEdit ? '<button class="btn btn-sm btn-ghost" data-action="delete-lesson" data-id="'+l.id+'" data-title="'+escapeHtml(l.title)+'" title="Удалить урок">'+icon("trash","ic-sm")+'</button>' : '') +
    '</div>';
  });
  var quizHiddenCount = (courseVisibility.quiz||[]).length;
  html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;">' +
    '<div style="flex:1;"><b style="font-size:13.5px;display:block;">Итоговый тест</b><span style="font-size:12px;color:var(--muted);">'+(quizHiddenCount?'Скрыт от '+quizHiddenCount+' врачей':'Виден всем')+'</span></div>' +
    '<button class="btn btn-sm '+(quizHiddenCount?'btn-primary':'btn-ghost')+'" data-action="open-materials-picker" data-id="quiz" data-title="Итоговый тест">Настроить видимость</button></div>';
  html += '</div>';

  if(canEdit){
    html += '<div class="card" style="padding:18px 20px;margin-top:16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:10px;">' +
        '<b style="font-size:14.5px;">Вопросы итогового теста</b>' +
        '<button class="btn btn-sm btn-primary" data-action="open-quiz-creator">+ Добавить вопрос</button>' +
      '</div>' +
      '<p style="font-size:12.5px;color:var(--muted);margin:0 0 16px;">Изменение текста, вариантов ответа или правильного варианта.</p>';
    staffState.quizAdmin.forEach(function(q,i){
      var qIsFirst = i===0, qIsLast = i===staffState.quizAdmin.length-1;
      html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-quiz-question" data-id="'+q.id+'" data-dir="up"'+(qIsFirst?' disabled':'')+' title="Выше">↑</button>' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-quiz-question" data-id="'+q.id+'" data-dir="down"'+(qIsLast?' disabled':'')+' title="Ниже">↓</button></div>' +
        '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+(i+1)+'. '+escapeHtml(q.question)+'</b><span style="font-size:12px;color:var(--muted);">'+q.options.length+' варианта, правильный: «'+escapeHtml(q.options[q.correct]||"")+'»</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-action="open-quiz-editor" data-id="'+q.id+'">Редактировать</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="delete-quiz-question" data-id="'+q.id+'" title="Удалить вопрос">'+icon("trash","ic-sm")+'</button></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return el(html);
}

function renderMaterialsPickerModal(){
  var q = materialsPicker.search.toLowerCase();
  var students = staffState.students.filter(function(s){
    if(!q) return true;
    return (s.name||"").toLowerCase().indexOf(q)!==-1 || (s.email||"").toLowerCase().indexOf(q)!==-1 || (s.phone||"").toLowerCase().indexOf(q)!==-1;
  });
  var allIds = staffState.students.map(function(s){ return s.id; });
  var allSelected = allIds.length>0 && allIds.every(function(id){ return materialsPicker.selectedIds.indexOf(id)!==-1; });

  var body = '<div class="drawer-head"><b style="font-size:16px;">Скрыть «'+escapeHtml(materialsPicker.targetTitle)+'» от</b><button class="btn btn-ghost btn-sm" data-action="close-materials-picker">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-s);margin-bottom:14px;cursor:pointer;background:var(--primary-tint);">' +
        '<input type="checkbox" data-action="toggle-picker-all"'+(allSelected?' checked':'')+'>' +
        '<span style="font-size:13.5px;font-weight:600;">Скрыть от всех врачей</span></label>' +
      '<input class="input" id="materialsPickerSearch" placeholder="Поиск по имени, email или телефону" value="'+escapeHtml(materialsPicker.search)+'" style="margin-bottom:12px;">' +
      '<div style="max-height:320px;overflow-y:auto;">';
  if(!students.length){
    body += '<div class="empty-state" style="padding:24px 10px;">Никого не нашлось.</div>';
  } else {
    students.forEach(function(s){
      var checked = materialsPicker.selectedIds.indexOf(s.id)!==-1;
      body += '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--line-2);cursor:pointer;">' +
        '<input type="checkbox" data-action="toggle-picker-student" data-id="'+s.id+'"'+(checked?' checked':'')+'>' +
        '<div class="avatar" style="width:26px;height:26px;font-size:11px;">'+initials(s.name)+'</div>' +
        '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:11.5px;color:var(--muted);">'+escapeHtml(s.email||s.phone||"—")+'</span></div></label>';
    });
  }
  body += '</div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">' +
    '<span style="font-size:12.5px;color:var(--muted);">Выбрано: '+materialsPicker.selectedIds.length+'</span>' +
    '<button class="btn btn-primary" data-action="apply-materials-picker">Сохранить</button></div></div>';

  return el('<div class="overlay" data-action="overlay-close-materials"><div class="drawer" data-stop="1" style="width:min(440px,100%);">'+body+'</div></div>');
}

/* ============================= РЕНДЕР: DASHBOARD (срезы по параметрам) ============================= */
// Компактное поле-дропдаун с чекбоксами внутри (мульти-выбор), а не строка
// крупных pill-кнопок — плотная сетка мелких полей, как в референсных
// аналитических дашбордах (amoCRM-подобные отчёты), при тех же данных и той
// же логике мульти-выбора, что и раньше.
function renderChipGroup(title, options, selectedArr, groupName){
  var isOpen = dashboardState.openFilterMenu === groupName;
  var summary = "Все";
  if(selectedArr.length){
    if(selectedArr.length <= 2){
      summary = selectedArr.map(function(v){
        var opt = options.filter(function(o){ return o.value===v; })[0];
        return opt ? opt.label : v;
      }).join(", ");
    } else {
      summary = selectedArr.length+" выбрано";
    }
  }
  var html = '<div class="dash-field" data-stop="1">' +
    '<label>'+escapeHtml(title)+'</label>' +
    '<button type="button" class="dash-select'+(selectedArr.length?' has-value':'')+'" data-action="toggle-dash-filter-menu" data-group="'+groupName+'">' +
      '<span class="dash-select-value">'+escapeHtml(summary)+'</span>' + icon("chevron","ic-sm") +
    '</button>';
  if(isOpen){
    html += '<div class="dash-menu">';
    if(!options.length){
      html += '<div class="dash-menu-empty">нет данных</div>';
    } else {
      options.forEach(function(opt){
        var checked = selectedArr.indexOf(opt.value)!==-1;
        html += '<label class="dash-menu-item"><input type="checkbox" data-action="toggle-dash-filter" data-group="'+groupName+'" data-value="'+escapeHtml(opt.value)+'"'+(checked?' checked':'')+'>'+escapeHtml(opt.label)+'</label>';
      });
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function distinctSpecializations(){
  var set = {};
  staffState.students.forEach(function(s){ var v=(s.specialization||"").trim(); if(v) set[v]=true; });
  return Object.keys(set).sort();
}

function computeFilteredStudents(){
  return staffState.students.filter(function(s){
    var regDate = (s.created_at||"").slice(0,10);
    if(dashboardState.periodFrom && regDate && regDate < dashboardState.periodFrom) return false;
    if(dashboardState.periodTo && regDate && regDate > dashboardState.periodTo) return false;
    if(dashboardState.specializations.length && dashboardState.specializations.indexOf(s.specialization||"")===-1) return false;
    if(dashboardState.streams.length && dashboardState.streams.indexOf(s.stream_id||"")===-1) return false;
    if(dashboardState.stages.length && dashboardState.stages.indexOf(studentStage(s))===-1) return false;
    if(dashboardState.products.length && dashboardState.products.indexOf(s.product||"longevity")===-1) return false;
    if(dashboardState.certStatuses.length && dashboardState.certStatuses.indexOf(s.certificate_status==="issued"?"issued":"not_issued")===-1) return false;
    if(dashboardState.paymentStatuses.length && dashboardState.paymentStatuses.indexOf(s.payment_status||"unpaid")===-1) return false;
    if(dashboardState.demoStatuses.length && dashboardState.demoStatuses.indexOf(s.completed?"yes":"no")===-1) return false;
    if(dashboardState.accessStatuses.length && dashboardState.accessStatuses.indexOf(accessStatusOf(s))===-1) return false;
    if(dashboardState.curatorIds.length && dashboardState.curatorIds.indexOf(s.assigned_curator_id||"")===-1) return false;
    return true;
  });
}

function exportDashboardCSV(list){
  var rows = [["Имя","Специализация","Email","Телефон","Поток","Продукт","Этап","Тест %","Сертификат","Оплата","Доступ","Куратор","Дата регистрации"]];
  list.forEach(function(s){
    var streamName = (calendarState.streams.filter(function(x){ return x.id===s.stream_id; })[0]||{}).name || "";
    var curatorName = (directory.filter(function(c){ return c.id===s.assigned_curator_id; })[0]||{}).name || "";
    var accessSt = accessStatusOf(s);
    rows.push([
      s.name||"", s.specialization||"", s.email||"", s.phone||"",
      streamName, PRODUCTS[s.product||"longevity"], STAGE_LABELS[studentStage(s)],
      (typeof s.quiz_score==="number"?s.quiz_score:""), (s.certificate_status==="issued"?"Выдан":"Нет"),
      PAYMENT_LABELS[s.payment_status||"unpaid"], (accessSt==="active"?"Активен":(accessSt==="blocked"?"Заблокирован":"Истёк")),
      curatorName, (s.created_at||"").slice(0,10)
    ]);
  });
  var csv = rows.map(function(r){ return r.map(function(v){ var str=String(v).replace(/"/g,'""'); return /[",\n]/.test(str)?'"'+str+'"':str; }).join(","); }).join("\r\n");
  var blob = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href=url; a.download="врачи_"+isoDate(new Date())+".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}

function renderDashboardTab(){
  var specs = distinctSpecializations().map(function(s){ return {value:s,label:s}; });
  var streamOpts = calendarState.streams.map(function(s){ return {value:s.id,label:s.name}; });
  streamOpts.unshift({value:"",label:"Без потока"});
  var stageOpts = Object.keys(STAGE_LABELS).map(function(k){ return {value:k,label:STAGE_LABELS[k]}; });
  var productOpts = Object.keys(PRODUCTS).map(function(k){ return {value:k,label:PRODUCTS[k]}; });
  var curatorOpts = directory.map(function(c){ return {value:c.id,label:c.name}; });

  var filtered = computeFilteredStudents();

  var html = '<div style="margin-top:6px;"><div class="card" style="padding:18px 20px;margin-bottom:20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
      '<b style="font-size:14.5px;">Фильтры</b><button class="btn btn-sm btn-ghost" data-action="reset-dash-filters">Сбросить всё</button></div>';

  html += '<div class="dash-filters-grid">';

  html += '<div class="dash-field dash-field-period" data-stop="1"><label>Период регистрации</label>' +
    '<div class="dash-period-inputs">' +
      '<input class="input" type="date" id="dashPeriodFrom" value="'+escapeHtml(dashboardState.periodFrom)+'">' +
      '<span>—</span>' +
      '<input class="input" type="date" id="dashPeriodTo" value="'+escapeHtml(dashboardState.periodTo)+'">' +
    '</div></div>';

  html += renderChipGroup("Специальность", specs, dashboardState.specializations, "specializations");
  html += renderChipGroup("Поток", streamOpts, dashboardState.streams, "streams");
  html += renderChipGroup("Продукт", productOpts, dashboardState.products, "products");
  html += renderChipGroup("Этап обучения", stageOpts, dashboardState.stages, "stages");
  html += renderChipGroup("Демо-курс пройден", [{value:"yes",label:"Да"},{value:"no",label:"Нет"}], dashboardState.demoStatuses, "demoStatuses");
  html += renderChipGroup("Сертификат", [{value:"issued",label:"Выдан"},{value:"not_issued",label:"Не выдан"}], dashboardState.certStatuses, "certStatuses");
  html += renderChipGroup("Оплата", [{value:"unpaid",label:"Не оплачено"},{value:"partial",label:"Частично"},{value:"paid",label:"Оплачено"}], dashboardState.paymentStatuses, "paymentStatuses");
  html += renderChipGroup("Статус доступа", [{value:"active",label:"Активен"},{value:"blocked",label:"Заблокирован"},{value:"expired",label:"Истёк"}], dashboardState.accessStatuses, "accessStatuses");
  html += renderChipGroup("Ответственный куратор", curatorOpts, dashboardState.curatorIds, "curatorIds");
  html += '</div>';

  html += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:14.5px;">Найдено: '+filtered.length+' из '+staffState.students.length+'</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="export-dash-csv"'+(!filtered.length?' disabled':'')+'>Экспорт в CSV</button></div>';

  if(!filtered.length){
    html += '<div class="empty-state"><div class="big">'+icon("search","ic-lg")+'</div>Никого не нашлось по этим фильтрам.</div>';
  } else {
    html += '<div style="overflow-x:auto;"><table class="roster"><thead><tr><th>Врач</th><th>Специальность</th><th>Поток</th><th>Продукт</th><th>Этап</th><th>Тест</th><th>Сертификат</th><th>Оплата</th><th>Доступ</th><th>Куратор</th><th>Регистрация</th><th></th></tr></thead><tbody>';
    filtered.forEach(function(s){
      var streamName = (calendarState.streams.filter(function(x){ return x.id===s.stream_id; })[0]||{}).name || "—";
      var curatorName = (directory.filter(function(c){ return c.id===s.assigned_curator_id; })[0]||{}).name || "—";
      var accessSt = accessStatusOf(s);
      var accessMagnet = accessSt==="active"?magnet("active","Активен"):(accessSt==="blocked"?magnet("blocked","Заблокирован"):magnet("attention","Истёк"));
      var stage = studentStage(s);
      var stageMagnet = magnet(stage==="certified"?"done":(stage==="demo_done"?"attention":(stage==="in_progress"?"active":"neutral")), STAGE_LABELS[stage]);
      html += '<tr>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;"><div class="who-cell"><div class="avatar">'+initials(s.name)+'</div><div><b>'+escapeHtml(s.name)+'</b></div></div></td>' +
        '<td>'+escapeHtml(s.specialization||"—")+'</td>' +
        '<td>'+escapeHtml(streamName)+'</td>' +
        '<td>'+escapeHtml(PRODUCTS[s.product||"longevity"])+'</td>' +
        '<td>'+stageMagnet+'</td>' +
        '<td>'+(typeof s.quiz_score==="number"?s.quiz_score+'%':'—')+'</td>' +
        '<td>'+(s.certificate_status==="issued"?"Выдан":"—")+'</td>' +
        '<td>'+PAYMENT_LABELS[s.payment_status||"unpaid"]+'</td>' +
        '<td>'+accessMagnet+'</td>' +
        '<td>'+escapeHtml(curatorName)+'</td>' +
        '<td style="color:var(--muted);">'+fmtDate(s.created_at)+'</td>' +
        '<td style="text-align:right;"><button class="btn btn-sm btn-ghost" data-action="open-student" data-id="'+s.id+'">Открыть →</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div></div>';
  return el(html);
}

function renderStaffStats(){
  var students = staffState.students;
  var total = students.length, completed=0, inProgress=0, scoreSum=0, scoreCount=0;
  students.forEach(function(s){
    if(s.completed) completed++;
    else if((s.completed_lessons||[]).length>0) inProgress++;
    if(typeof s.quiz_score==="number"){ scoreSum+=s.quiz_score; scoreCount++; }
  });
  var avg = scoreCount ? Math.round(scoreSum/scoreCount) : null;
  return el(
    '<div class="stat-row">' +
      '<div class="card stat"><div class="num">'+total+'</div><div class="lbl">Врачей зарегистрировано</div></div>' +
      '<div class="card stat"><div class="num">'+inProgress+'</div><div class="lbl">Проходят курс сейчас</div></div>' +
      '<div class="card stat"><div class="num">'+completed+'</div><div class="lbl">Завершили демо-курс</div></div>' +
      '<div class="card stat"><div class="num">'+(avg===null?'—':avg+'%')+'</div><div class="lbl">Средний балл теста</div></div>' +
    '</div>'
  );
}

function renderCertificateQueue(){
  var pending = staffState.students.filter(function(s){ return s.completed && s.certificate_status!=="issued"; });
  if(!pending.length) return el('<div></div>');
  var pendingIds = pending.map(function(s){ return s.id; });
  var selected = staffState.certSelectedIds.filter(function(id){ return pendingIds.indexOf(id)!==-1; });
  var allSelected = selected.length>0 && selected.length===pending.length;
  var html = '<div class="card" style="padding:18px 20px;margin-bottom:20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14.5px;font-weight:600;cursor:pointer;">' +
        '<input type="checkbox" data-action="toggle-cert-select-all"'+(allSelected?' checked':'')+' style="accent-color:var(--primary);">Очередь сертификатов</label>' +
      (selected.length ? '<button class="btn btn-sm btn-primary" data-action="bulk-issue-certificates">Выдать выбранным ('+selected.length+')</button>' : '') +
    '</div>';
  pending.forEach(function(s){
    var checked = selected.indexOf(s.id)!==-1;
    html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-2);">' +
      '<input type="checkbox" data-action="toggle-cert-select" data-id="'+s.id+'"'+(checked?' checked':'')+' style="accent-color:var(--primary);">' +
      '<div class="avatar">'+initials(s.name)+'</div>' +
      '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:12px;color:var(--muted);">тест: '+s.quiz_score+'%</span></div>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-student" data-id="'+s.id+'">Открыть</button>' +
      '<button class="btn btn-sm btn-primary" data-action="issue-certificate" data-id="'+s.id+'">Выдать</button>' +
    '</div>';
  });
  html += '</div>';
  return el(html);
}

function renderRoster(){
  var q = staffState.search.toLowerCase();
  var students = staffState.students.filter(function(s){
    if(!q) return true;
    return (s.name||"").toLowerCase().indexOf(q)!==-1 || (s.specialization||"").toLowerCase().indexOf(q)!==-1 ||
      (s.email||"").toLowerCase().indexOf(q)!==-1 || (s.phone||"").toLowerCase().indexOf(q)!==-1;
  });
  var visibleIds = students.map(function(s){ return s.id; });
  var selected = staffState.selectedIds.filter(function(id){ return visibleIds.indexOf(id)!==-1; });
  var allSelected = students.length>0 && selected.length===students.length;

  var html = '<div class="card" style="padding:18px 18px 6px;">' +
    '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;"><input class="input" id="rosterSearch" placeholder="Поиск по имени, специализации, email или телефону" value="'+escapeHtml(staffState.search)+'" style="max-width:320px;">' +
    '<button class="btn btn-sm btn-ghost" data-action="toggle-invite-student">'+(staffState.showInviteStudent?'Скрыть':'+ Пригласить врача')+'</button>' +
    '<button class="btn btn-sm btn-ghost" data-action="open-course-preview">'+icon("eye","ic-sm")+' Просмотреть как врач</button></div>';

  if(staffState.showInviteStudent){
    html += '<div class="tabs" style="margin-bottom:14px;">' +
      '<button type="button" class="tab'+(staffState.inviteMode!=="bulk"?' active':'')+'" data-action="invite-mode" data-mode="single">Один email</button>' +
      '<button type="button" class="tab'+(staffState.inviteMode==="bulk"?' active':'')+'" data-action="invite-mode" data-mode="bulk">Список / CSV</button>' +
    '</div>';
    if(staffState.inviteMode==="bulk"){
      html += '<form id="inviteBulkForm" style="margin-bottom:16px;">' +
        '<div class="field"><label>Список email (по одному в строке, или вставьте из Excel/CSV)</label>' +
        '<textarea class="input" name="emails" required style="height:110px;font-family:monospace;font-size:12.5px;" placeholder="doctor1@clinic.ru&#10;doctor2@clinic.ru&#10;doctor3@clinic.ru"></textarea></div>' +
        '<div class="field"><label>Или загрузить .csv файл</label><input class="input" type="file" id="bulkCsvFile" accept=".csv,.txt"></div>' +
        '<div class="err-text" id="inviteBulkError" style="display:none;"></div>' +
        '<button class="btn btn-primary" type="submit">Пригласить всех</button>' +
      '</form>';
    } else {
      html += '<form id="inviteStudentForm" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="field" style="flex:1;min-width:220px;margin-bottom:0;"><label>Email врача</label><input class="input" type="email" name="email" required></div>' +
        '<button class="btn btn-primary" type="submit">Выдать доступ</button></form>';
    }
  }

  if(selected.length>0){
    var bulkProductOpts = Object.keys(PRODUCTS).map(function(k){ return '<option value="'+k+'">'+escapeHtml(PRODUCTS[k])+'</option>'; }).join("");
    var bulkPaymentOpts = Object.keys(PAYMENT_LABELS).map(function(k){ return '<option value="'+k+'">'+escapeHtml(PAYMENT_LABELS[k])+'</option>'; }).join("");
    html += '<div class="card" style="padding:10px 14px;margin-bottom:14px;background:var(--primary-tint);border-color:transparent;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<b style="font-size:13.5px;color:var(--primary-dark);">Выбрано: '+selected.length+'</b>' +
      '<select class="input" id="bulkStreamSelect" style="width:auto;font-size:13px;padding:6px 10px;">'+buildStreamOptions("", "Без потока")+'</select>' +
      '<button class="btn btn-sm btn-primary" data-action="apply-bulk-stream">В поток</button>' +
      '<select class="input" id="bulkProductSelect" style="width:auto;font-size:13px;padding:6px 10px;">'+bulkProductOpts+'</select>' +
      '<button class="btn btn-sm btn-primary" data-action="apply-bulk-product">В продукт</button>' +
      '<select class="input" id="bulkPaymentSelect" style="width:auto;font-size:13px;padding:6px 10px;">'+bulkPaymentOpts+'</select>' +
      '<button class="btn btn-sm btn-primary" data-action="apply-bulk-payment">Проставить оплату</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="clear-selection">Снять выбор</button></div>';
  }

  if(!students.length){
    html += '<div class="empty-state"><div class="big">'+icon("doctor","ic-lg")+'</div>Пока никто не зарегистрировался.</div>';
  } else {
    html += '<div style="overflow-x:auto;"><table class="roster"><thead><tr><th style="width:32px;"><input type="checkbox" data-action="select-all-students"'+(allSelected?' checked':'')+'></th><th>Врач</th><th>Прогресс</th><th>Тест</th><th>Статус</th><th>Поток</th><th>Регистрация</th><th></th></tr></thead><tbody>';
    students.forEach(function(s){
      var done = (s.completed_lessons||[]).length;
      var isChecked = staffState.selectedIds.indexOf(s.id)!==-1;
      var status = s.completed ? magnet("done","Завершил") : (done>0 ? magnet("active","В процессе") : magnet("neutral","Новый"));
      html += '<tr>' +
        '<td><input type="checkbox" data-action="select-student" data-id="'+s.id+'"'+(isChecked?' checked':'')+'></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;"><div class="who-cell"><div class="avatar">'+initials(s.name)+'</div><div><b>'+escapeHtml(s.name)+'</b><span>'+escapeHtml(s.specialization||"—")+'</span></div></div></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+done+'/5</td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+(typeof s.quiz_score==="number"?s.quiz_score+'%':'—')+'</td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+status+'</td>' +
        '<td><select class="input" style="font-size:12.5px;padding:5px 8px;" data-stream-select data-id="'+s.id+'">'+buildStreamOptions(s.stream_id||"", "Без потока")+'</select></td>' +
        '<td style="color:var(--muted);">'+fmtDate(s.created_at)+'</td>' +
        '<td style="text-align:right;"><button class="btn btn-sm btn-ghost" data-action="open-student" data-id="'+s.id+'">Открыть →</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  return el(html);
}

function renderTeamTab(){
  var myOptions = assignableRoleOptions(me.role);
  var html = '<div class="grid-2" style="align-items:flex-start;">';

  html += '<div class="card" style="padding:18px 20px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Администраторы и кураторы</b>';
  if(!staffState.staff.length){
    html += '<div class="empty-state" style="padding:30px 10px;">Пока только вы.</div>';
  } else {
    var myOptionsForChange = assignableRoleOptions(me.role);
    staffState.staff.forEach(function(c){
      var isMe = c.id===me.id;
      var canManage = !isMe && canAssignRole(me.role, c.role);
      // Смена роли имеет смысл только тогда, когда есть больше одного варианта на выбор —
      // у администратора он один («куратор»), т.е. фактически no-op; показываем только главному администратору.
      var canChangeRole = canManage && myOptionsForChange.length>1;
      html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);flex-wrap:wrap;">' +
        '<div class="avatar">'+initials(c.name)+'</div>' +
        '<div style="flex:1;min-width:140px;"><b style="font-size:13.8px;display:block;">'+escapeHtml(c.name)+(isMe?' <span style="color:var(--muted);font-weight:400;">(вы)</span>':'')+'</b>' +
        '<span style="font-size:12px;color:var(--muted);">'+roleLabel(c.role)+' · с '+fmtDate(c.created_at)+'</span></div>' +
        (canChangeRole ? '<select class="input btn-sm" style="width:auto;" data-role-select data-id="'+c.id+'">' +
          myOptionsForChange.map(function(r){ return '<option value="'+r+'"'+(c.role===r?' selected':'')+'>'+roleLabel(r)+'</option>'; }).join("") + '</select>' : '') +
        (canManage ? '<button class="btn btn-sm btn-ghost" data-action="reset-staff-password" data-id="'+c.id+'" data-name="'+escapeHtml(c.name)+'">Сбросить пароль</button>' : '') +
        (canManage ? '<button class="btn btn-sm btn-ghost" data-action="remove-staff" data-id="'+c.id+'">Убрать</button>' : '') +
      '</div>';
    });
  }
  html += '</div>';

  html += '<div class="card" style="padding:18px 20px;">';
  if(myOptions.length){
    html += '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Пригласить по email</b>' +
      '<form id="inviteStaffForm">' +
        '<div class="field"><label>Email</label><input class="input" type="email" name="email" required></div>' +
        '<div class="field"><label>Роль</label><select class="input" name="role">' + myOptions.map(function(r){ return '<option value="'+r+'">'+roleLabel(r)+'</option>'; }).join("") + '</select></div>' +
        '<button class="btn btn-primary btn-block" type="submit">Отправить приглашение</button>' +
      '</form>';
  } else {
    html += '<p style="font-size:13px;color:var(--muted);margin:0;">Назначать роли может главный администратор или администратор.</p>';
  }
  html += '</div></div>';
  return el(html);
}

/* ============================= РЕНДЕР: КАРТОЧКА ВРАЧА ============================= */
function renderStudentDrawer(){
  var s = staffState.selectedStudent;
  if(!s) return el('<div class="overlay"><div class="drawer" data-stop="1"><div class="drawer-body">Загрузка…</div></div></div>');
  var done = (s.completed_lessons||[]).length;

  var head = '<div class="drawer-head">' +
    '<div style="display:flex;gap:12px;align-items:center;"><div class="avatar" style="width:42px;height:42px;font-size:15px;">'+initials(s.name)+'</div>' +
    '<div><b style="font-size:16px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:13px;color:var(--muted);">'+escapeHtml(s.specialization||"—")+'</span></div></div>' +
    '<button class="btn btn-ghost btn-sm" data-action="close-drawer">Закрыть ✕</button></div>';

  var body = '<div class="drawer-body">' +
    '<div class="tabs"><button class="tab'+(staffState.drawerTab==="progress"?' active':'')+'" data-action="drawer-tab" data-tab="progress">Прогресс</button>' +
    '<button class="tab'+(staffState.drawerTab==="access"?' active':'')+'" data-action="drawer-tab" data-tab="access">Доступ</button>' +
    '<button class="tab'+(staffState.drawerTab==="chat"?' active':'')+'" data-action="drawer-tab" data-tab="chat">Чат</button>' +
    '<button class="tab'+(staffState.drawerTab==="profile"?' active':'')+'" data-action="drawer-tab" data-tab="profile">Профиль</button>' +
    '<button class="tab'+(staffState.drawerTab==="notes"?' active':'')+'" data-action="drawer-tab" data-tab="notes">Заметки</button></div>';

  if(staffState.drawerTab === "progress"){
    body += '<div class="progress-label">'+done+' из 5 уроков'+(typeof s.quiz_score==="number"?' · тест: '+s.quiz_score+'%':'')+'</div>';
    if(s.completed){
      body += '<div class="card" style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<b style="font-size:13.5px;">Сертификат: '+(s.certificate_status==="issued"?"выдан":"ожидает выдачи")+'</b>' +
        (s.certificate_status!=="issued" ? '<button class="btn btn-sm btn-primary" data-action="issue-certificate" data-id="'+s.id+'">Выдать сертификат</button>' : '') +
      '</div>';
    }
    if(s.requested_full_access){
      body += '<div class="card" style="padding:14px 16px;margin-top:12px;background:var(--accent-tint);border-color:transparent;"><b style="font-size:13.5px;">Оставил(а) заявку на полную программу</b></div>';
    }
  } else if(staffState.drawerTab === "access"){
    var expiresAtRaw = s.access_expires_at ? String(s.access_expires_at).slice(0,10) : "";
    var isBlocked = !!s.access_blocked;
    var todayIso = isoDate(new Date());
    var isExpired = expiresAtRaw && expiresAtRaw < todayIso;
    var statusText = isBlocked ? "Доступ заблокирован" : (isExpired ? "Доступ истёк "+fmtDate(expiresAtRaw) : (expiresAtRaw ? "Доступ активен до "+fmtDate(expiresAtRaw) : "Доступ бессрочный"));

    body += '<div class="card" style="padding:14px 16px;margin-bottom:16px;'+((isBlocked||isExpired)?'background:var(--danger-tint);':'background:var(--primary-tint);')+'border-color:transparent;"><b style="font-size:13.5px;">'+statusText+'</b></div>' +
      '<div class="field"><label>Срок доступа к демо-курсу</label><div style="display:flex;gap:8px;">' +
        '<input class="input" type="date" id="accessExpiryInput" value="'+escapeHtml(expiresAtRaw)+'">' +
        '<button class="btn btn-sm btn-ghost" data-action="save-access-expiry" data-id="'+s.id+'">Сохранить</button></div></div>' +
      '<div style="display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;">' +
        '<button class="btn btn-sm btn-ghost" data-action="extend-access" data-id="'+s.id+'" data-days="7">+7 дней</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="extend-access" data-id="'+s.id+'" data-days="30">+30 дней</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="clear-access-expiry" data-id="'+s.id+'">Сделать бессрочным</button></div>' +
      '<div class="field" style="margin-top:18px;"><label>Немедленное ограничение</label>' +
        (isBlocked ?
          '<button class="btn btn-primary" data-action="toggle-access-block" data-id="'+s.id+'" data-blocked="false">Снять блокировку</button>' :
          '<button class="btn btn-ghost" data-action="toggle-access-block" data-id="'+s.id+'" data-blocked="true">Заблокировать доступ к курсу</button>') +
      '</div>';
  } else if(staffState.drawerTab === "chat"){
    body += '<div class="msg-panel" style="height:420px;border:1px solid var(--line);border-radius:var(--radius-m);overflow:hidden;">' +
      '<div class="msg-list" id="msgListCurator"><div class="msg-empty">Загрузка…</div></div>' +
      '<div class="msg-input-row"><textarea class="input" id="curatorMsgInput" placeholder="Ответить врачу…"></textarea>' +
      '<button class="btn btn-primary" data-action="send-curator-msg" data-id="'+s.id+'">Отправить</button></div></div>';
  } else if(staffState.drawerTab === "notes"){
    body += '<p class="hint" style="margin-top:0;">Видно только персоналу — врач эти записи не видит.</p>' +
      '<div class="field"><textarea class="input" id="studentNoteInput" style="height:64px;" placeholder="Например: пропускает эфиры, стоит позвонить"></textarea></div>' +
      '<button class="btn btn-sm btn-primary" data-action="add-student-note" data-id="'+s.id+'">Добавить заметку</button>' +
      '<div style="margin-top:18px;">';
    if(!staffState.notes.length){
      body += '<p class="hint">Заметок пока нет.</p>';
    } else {
      staffState.notes.forEach(function(n){
        body += '<div style="padding:10px 0;border-bottom:1px solid var(--line-2);"><p style="font-size:13.5px;margin:0 0 4px;">'+escapeHtml(n.body)+'</p>' +
          '<span style="font-size:11.5px;color:var(--muted-2);">'+escapeHtml(n.author_name||"")+' · '+fmtDate(n.created_at)+' '+fmtTime(n.created_at)+'</span></div>';
      });
    }
    body += '</div>';
  } else {
    var curatorSelectOpts = '<option value=""'+(!s.assigned_curator_id?' selected':'')+'>Не назначен</option>' +
      directory.map(function(c){ return '<option value="'+c.id+'"'+(s.assigned_curator_id===c.id?' selected':'')+'>'+escapeHtml(c.name)+'</option>'; }).join("");
    var productSelectOpts = Object.keys(PRODUCTS).map(function(k){ return '<option value="'+k+'"'+((s.product||"longevity")===k?' selected':'')+'>'+escapeHtml(PRODUCTS[k])+'</option>'; }).join("");
    var paymentSelectOpts = Object.keys(PAYMENT_LABELS).map(function(k){ return '<option value="'+k+'"'+((s.payment_status||"unpaid")===k?' selected':'')+'>'+escapeHtml(PAYMENT_LABELS[k])+'</option>'; }).join("");
    body += '<div class="field"><label>Имя и фамилия</label><input class="input" id="studentProfileName" value="'+escapeHtml(s.name||"")+'"></div>' +
      '<div class="field"><label>Специализация</label><input class="input" id="studentProfileSpecialization" value="'+escapeHtml(s.specialization||"")+'"></div>' +
      '<div class="field"><label>Email</label><div class="input" style="background:var(--line-2);">'+escapeHtml(s.email||"—")+'</div></div>' +
      '<div class="field"><label>Телефон</label><input class="input" id="studentProfilePhone" value="'+escapeHtml(s.phone||"")+'"></div>' +
      '<div class="field"><label>Место работы</label><input class="input" id="studentProfileWorkplace" value="'+escapeHtml(s.workplace||"")+'"></div>' +
      '<button class="btn btn-sm btn-ghost" data-action="save-student-profile" data-id="'+s.id+'">Сохранить данные</button>' +
      '<div class="field" style="margin-top:18px;"><label>Дата регистрации</label><div class="input" style="background:var(--line-2);">'+fmtDate(s.created_at)+'</div></div>' +
      '<div class="field"><label>Продукт</label><select class="input" data-field-select="product" data-id="'+s.id+'">'+productSelectOpts+'</select></div>' +
      '<div class="field"><label>Оплата</label><select class="input" data-field-select="payment" data-id="'+s.id+'">'+paymentSelectOpts+'</select></div>' +
      '<div class="field"><label>Ответственный куратор</label><select class="input" data-field-select="curator" data-id="'+s.id+'">'+curatorSelectOpts+'</select></div>' +
      '<button class="btn btn-ghost" style="margin-top:6px;" data-action="reset-student-password" data-id="'+s.id+'" data-name="'+escapeHtml(s.name)+'">Сбросить пароль</button>';
  }
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close"><div class="drawer" data-stop="1">'+head+body+'</div></div>');
}

/* ============================= СООБЩЕНИЯ (поллинг раз в 4 сек, пока чат открыт) ============================= */
async function loadMessages(studentId, containerId){
  try{
    var data = await api("/messages/"+studentId);
    renderMessages(containerId, data.messages, studentId);
  }catch(e){}
}
function renderMessages(containerId, msgs, studentId){
  var container = document.getElementById(containerId);
  if(!container) return;
  if(!msgs.length){ container.innerHTML = '<div class="msg-empty">Сообщений пока нет.</div>'; return; }
  var mine = view==="student" ? "student" : "curator";
  var html = "";
  msgs.forEach(function(m){
    var isMe = m.from_role===mine;
    html += '<div class="msg-row'+(isMe?' me':'')+'"><div class="bubble">'+escapeHtml(m.body)+'<span class="t">'+(isMe?"":escapeHtml(m.author_name||(m.from_role==="curator"?"Куратор":"Врач"))+" · ")+fmtTime(m.created_at)+'</span></div></div>';
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}
function startMessagePolling(studentId, containerId){
  stopMessagePolling();
  loadMessages(studentId, containerId);
  msgPollTimer = setInterval(function(){ loadMessages(studentId, containerId); }, 4000);
}
function stopMessagePolling(){ if(msgPollTimer){ clearInterval(msgPollTimer); msgPollTimer=null; } }

// Беседа потока — отдельный канал от 1:1-чата с куратором выше: разные эндпоинты,
// разный контейнер, свой таймер поллинга, но тот же ритм в 4 сек.
var streamMsgPollTimer = null;
async function loadStreamMessages(streamId, containerId){
  try{
    var data = await api("/stream-messages/"+streamId);
    renderStreamMessages(containerId, data.messages);
  }catch(e){}
}
function renderStreamMessages(containerId, msgs){
  var container = document.getElementById(containerId);
  if(!container) return;
  if(!msgs.length){ container.innerHTML = '<div class="msg-empty">Сообщений пока нет — начните разговор первым.</div>'; return; }
  var html = "";
  msgs.forEach(function(m){
    var isMe = m.author_id===me.id;
    var roleLabel = m.author_role==="curator" ? "Куратор" : (m.author_role==="admin"||m.author_role==="super_admin" ? "Администратор" : "");
    html += '<div class="msg-row'+(isMe?' me':'')+'"><div class="bubble">'+escapeHtml(m.body)+'<span class="t">'+(isMe?"":escapeHtml(m.author_name)+(roleLabel?" · "+roleLabel:"")+" · ")+fmtTime(m.created_at)+'</span></div></div>';
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}
function startStreamMessagePolling(streamId, containerId){
  stopStreamMessagePolling();
  loadStreamMessages(streamId, containerId);
  streamMsgPollTimer = setInterval(function(){ loadStreamMessages(streamId, containerId); }, 4000);
}
function stopStreamMessagePolling(){ if(streamMsgPollTimer){ clearInterval(streamMsgPollTimer); streamMsgPollTimer=null; } }

/* ============================= СОБЫТИЯ ============================= */
function wireEvents(root){
  // render() calls wireEvents(app) on every re-render; app (the #app container) is never
  // replaced, only its innerHTML is cleared, so without this guard every listener below
  // would be re-attached on top of the previous ones and a single click/input would fire
  // once per render that has happened so far (theme toggle flips twice, forms submit twice…).
  if(root.__wired) return;
  root.__wired = true;
  root.addEventListener("click", async function(e){
    // Клик вне открытого поповера дашборд-фильтра закрывает его — не return,
    // чтобы клик по чему-то ещё (например, кнопке в таблице ниже) всё равно сработал.
    if(dashboardState.openFilterMenu && !e.target.closest(".dash-field")){
      dashboardState.openFilterMenu = null; render();
    }
    var t = e.target.closest("[data-action]");
    if(!t) return;
    var action = t.getAttribute("data-action");

    if(action==="go-register"){ view="register"; render(); return; }
    if(action==="go-login"){ view="login"; render(); return; }
    if(action==="logout"){ await api("/auth/logout", { method:"POST" }); me=null; course=null; view="login"; render(); return; }
    if(action==="toggle-theme"){ toggleTheme(); render(); return; }
    if(action==="revert-log"){
      if(!confirm('Откатить действие «'+t.getAttribute("data-label")+'»? Это вернёт состояние к тому, что было до этого изменения.')) return;
      t.disabled=true; t.textContent="Откатываем…";
      try{
        await api("/staff/audit-log/"+t.getAttribute("data-id")+"/revert", { method:"POST" });
        showToast("Действие откачено");
        var log = await api("/staff/audit-log"); staffState.auditLog=log.log;
        await loadStaffData();
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="logout-everywhere"){
      if(!confirm("Выйти со всех устройств? Понадобится войти заново здесь тоже.")) return;
      try{ await api("/auth/logout-everywhere", { method:"POST" }); }catch(err){}
      me=null; course=null; view="login"; changePasswordOpen=false; render(); return;
    }
    if(action==="open-change-password"){ changePasswordOpen=true; render(); return; }
    if(action==="close-change-password"){ changePasswordOpen=false; render(); return; }
    if(action==="overlay-close-password" && !e.target.closest("[data-stop]")){ changePasswordOpen=false; render(); return; }
    if(action==="open-profile-editor"){ profileEditor.open=true; render(); return; }
    if(action==="close-profile-editor"){ profileEditor.open=false; render(); return; }
    if(action==="overlay-close-profile-editor" && !e.target.closest("[data-stop]")){ profileEditor.open=false; render(); return; }

    if(action==="student-tab"){
      studentState.tab=t.getAttribute("data-tab");
      if(studentState.tab!=="messages"){ stopMessagePolling(); stopStreamMessagePolling(); }
      else if(studentState.messagesSubTab==="curator"){
        if(course) course.unreadMessages=0;
        api("/messages/"+me.id+"/mark-read", { method:"POST" }).catch(function(){});
      }
      render();
      if(studentState.tab==="messages"){
        if(studentState.messagesSubTab==="stream" && me.stream_id) startStreamMessagePolling(me.stream_id,"msgListStream");
        else startMessagePolling(me.id,"msgList");
      }
      return;
    }
    if(action==="student-messages-subtab"){
      var newSub=t.getAttribute("data-sub");
      if(newSub===studentState.messagesSubTab) return;
      stopMessagePolling(); stopStreamMessagePolling();
      studentState.messagesSubTab=newSub;
      render();
      if(newSub==="stream"){ if(me.stream_id) startStreamMessagePolling(me.stream_id,"msgListStream"); }
      else{
        if(course) course.unreadMessages=0;
        api("/messages/"+me.id+"/mark-read", { method:"POST" }).catch(function(){});
        startMessagePolling(me.id,"msgList");
      }
      return;
    }
    if(action==="open-course"){
      if(course.locked && course.locked.locked){ showToast("Доступ к курсу ограничен — напишите куратору в чате"); return; }
      studentState.tab="lesson"; studentState.lessonIndex=Math.min((course.progress&&course.progress.completed_lessons||[]).length, course.lessons.length-1); studentState.quizMode=false; studentState.quizSubmitted=false; render(); return;
    }
    if(action==="close-course"){ studentState.tab="course"; studentState.quizMode=false; render(); return; }
    if(action==="goto-lesson"){
      var goIdx=parseInt(t.getAttribute("data-idx"),10);
      var goLesson=course.lessons[goIdx];
      if(goLesson.hiddenForMe){ showToast("Этот урок временно недоступен"); return; }
      if(goLesson.dripLockedForMe){ showToast("Этот урок откроется "+fmtDate(goLesson.availableAt)); return; }
      studentState.lessonIndex=goIdx; studentState.quizMode=false; render(); return;
    }
    if(action==="save-lesson-note"){
      var noteLessonId=t.getAttribute("data-id");
      var noteVal2=document.getElementById("lessonNoteInput").value;
      try{
        await api("/course/lessons/"+noteLessonId+"/note", { method:"PUT", body: JSON.stringify({ note:noteVal2 }) });
        if(!course.progress.lesson_notes) course.progress.lesson_notes={};
        if(noteVal2.trim()) course.progress.lesson_notes[noteLessonId]=noteVal2.trim();
        else delete course.progress.lesson_notes[noteLessonId];
        showToast("Заметка сохранена");
      }catch(err){ showToast(err.message); }
      return;
    }
    if(action==="goto-quiz"){
      if(course.quizHiddenForMe){ showToast("Тест временно недоступен"); return; }
      studentState.quizMode=true; studentState.quizSubmitted=false; render(); return;
    }
    if(action==="prev-lesson"){ if(studentState.lessonIndex>0) studentState.lessonIndex--; render(); return; }
    if(action==="next-lesson"){
      var lid = course.lessons[studentState.lessonIndex].id;
      if(!previewMode){
        try{ var r = await api("/course/lesson-done", { method:"POST", body: JSON.stringify({lessonId:lid}) }); course.progress.completed_lessons = r.completedLessons; }catch(err){ showToast(err.message); }
      } else {
        course.progress.completed_lessons.push(lid);
      }
      var nextIdx = -1;
      for(var i=studentState.lessonIndex+1; i<course.lessons.length; i++){ if(!course.lessons[i].hiddenForMe && !course.lessons[i].dripLockedForMe){ nextIdx=i; break; } }
      if(nextIdx!==-1){ studentState.lessonIndex=nextIdx; }
      else if(!course.quizHiddenForMe){ studentState.quizMode=true; studentState.quizSubmitted=false; }
      else { showToast("Пока больше нечего проходить — куратор скоро откроет остальные материалы"); studentState.tab="course"; studentState.quizMode=false; }
      render(); return;
    }
    if(action==="request-full"){
      if(previewMode){ showToast("Режим просмотра — заявки не отправляются"); return; }
      t.disabled=true;
      try{ await api("/course/request-full-access", { method:"POST" }); course.progress.requested_full_access=true; showToast("Заявка отправлена куратору"); }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="send-student-msg"){
      var inp=document.getElementById("msgInput"); var val=inp?inp.value:"";
      if(val.trim()){ if(inp) inp.value=""; try{ await api("/messages", { method:"POST", body: JSON.stringify({studentId:me.id, text:val}) }); loadMessages(me.id,"msgList"); }catch(err){ showToast(err.message); } }
      return;
    }
    if(action==="send-student-stream-msg"){
      var sinp=document.getElementById("msgInputStream"); var sval=sinp?sinp.value:"";
      if(sval.trim() && me.stream_id){ if(sinp) sinp.value=""; try{ await api("/stream-messages/"+me.stream_id, { method:"POST", body: JSON.stringify({text:sval}) }); loadStreamMessages(me.stream_id,"msgListStream"); }catch(err){ showToast(err.message); } }
      return;
    }
    if(action==="mark-messages-unread"){
      try{
        await api("/messages/"+me.id+"/mark-unread", { method:"POST" });
        var mu=await api("/course"); course.unreadMessages=mu.unreadMessages;
        showToast("Чат помечен непрочитанным");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="download-ics"){
      var evObj = calendarState.events.filter(function(x){ return x.id===t.getAttribute("data-id"); })[0];
      if(evObj) downloadICS(evObj);
      return;
    }

    if(action==="staff-main-tab"){ staffState.mainTab=t.getAttribute("data-tab"); render(); return; }
    if(action==="toggle-invite-student"){ staffState.showInviteStudent=!staffState.showInviteStudent; render(); return; }
    if(action==="invite-mode"){ staffState.inviteMode=t.getAttribute("data-mode"); render(); return; }
    if(action==="open-course-preview"){
      previewMode = true; previewReturnTab = staffState.mainTab;
      try{ course = await api("/staff/course-preview"); }
      catch(err){ showToast(err.message); previewMode=false; return; }
      studentState = { tab:"course", lessonIndex:0, quizMode:false, quizSubmitted:false };
      view = "student";
      render(); return;
    }
    if(action==="exit-preview"){
      previewMode = false; course = null; view = "staff"; staffState.mainTab = previewReturnTab || "students";
      render(); return;
    }
    if(action==="open-student"){
      staffState.selectedStudentId=t.getAttribute("data-id"); staffState.drawerTab="progress"; staffState.selectedStudent=null; staffState.notes=[]; render();
      try{ var d=await api("/staff/students/"+staffState.selectedStudentId); staffState.selectedStudent=d.student; render(); }catch(err){ showToast(err.message); }
      return;
    }
    if(action==="close-drawer" || (action==="overlay-close" && !e.target.closest("[data-stop]"))){ staffState.selectedStudentId=null; stopMessagePolling(); render(); return; }
    if(action==="drawer-tab"){
      staffState.drawerTab=t.getAttribute("data-tab"); render();
      if(staffState.drawerTab==="chat") startMessagePolling(staffState.selectedStudentId,"msgListCurator");
      else stopMessagePolling();
      if(staffState.drawerTab==="notes"){
        try{ var dn=await api("/staff/students/"+staffState.selectedStudentId+"/notes"); staffState.notes=dn.notes; render(); }catch(err){ showToast(err.message); }
      }
      return;
    }
    if(action==="save-student-profile"){
      var spId=t.getAttribute("data-id");
      var spPayload={
        name: document.getElementById("studentProfileName").value,
        specialization: document.getElementById("studentProfileSpecialization").value,
        phone: document.getElementById("studentProfilePhone").value,
        workplace: document.getElementById("studentProfileWorkplace").value
      };
      t.disabled=true; t.textContent="Сохраняем…";
      try{
        await api("/staff/students/"+spId+"/profile", { method:"PATCH", body: JSON.stringify(spPayload) });
        staffState.selectedStudent=Object.assign({}, staffState.selectedStudent, spPayload);
        var spIdx=staffState.students.findIndex(function(x){ return x.id===spId; });
        if(spIdx!==-1) staffState.students[spIdx]=Object.assign({}, staffState.students[spIdx], spPayload);
        showToast("Данные сохранены");
      }catch(err){ showToast(err.message); }
      t.disabled=false; t.textContent="Сохранить данные"; render(); return;
    }
    if(action==="add-student-note"){
      var anId=t.getAttribute("data-id"); var anInput=document.getElementById("studentNoteInput"); var anVal=anInput?anInput.value:"";
      if(!anVal || !anVal.trim()) return;
      t.disabled=true;
      try{
        await api("/staff/students/"+anId+"/notes", { method:"POST", body: JSON.stringify({ body:anVal }) });
        var dn2=await api("/staff/students/"+anId+"/notes"); staffState.notes=dn2.notes;
      }catch(err){ showToast(err.message); }
      t.disabled=false; render(); return;
    }
    if(action==="send-curator-msg"){
      var sid=t.getAttribute("data-id"); var cinp=document.getElementById("curatorMsgInput"); var cval=cinp?cinp.value:"";
      if(cval.trim()){ if(cinp) cinp.value=""; try{ await api("/messages", { method:"POST", body: JSON.stringify({studentId:sid, text:cval}) }); loadMessages(sid,"msgListCurator"); }catch(err){ showToast(err.message); } }
      return;
    }
    if(action==="issue-certificate"){
      t.disabled=true; t.textContent="Выдаём…";
      try{ await api("/course/certificate/"+t.getAttribute("data-id")+"/issue", { method:"POST" }); showToast("Сертификат выдан"); await loadStaffData(); if(staffState.selectedStudentId){ var dd=await api("/staff/students/"+staffState.selectedStudentId); staffState.selectedStudent=dd.student; } }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="save-access-expiry"){
      var sid3=t.getAttribute("data-id"); var inp3=document.getElementById("accessExpiryInput");
      try{ await api("/staff/students/"+sid3+"/access", { method:"PATCH", body: JSON.stringify({ expiresAt: inp3?inp3.value:"" }) }); await refreshSelectedStudent(); showToast("Срок доступа обновлён"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="clear-access-expiry"){
      try{ await api("/staff/students/"+t.getAttribute("data-id")+"/access", { method:"PATCH", body: JSON.stringify({ expiresAt:null }) }); await refreshSelectedStudent(); showToast("Доступ теперь бессрочный"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="extend-access"){
      try{ await api("/staff/students/"+t.getAttribute("data-id")+"/access/extend", { method:"POST", body: JSON.stringify({ days: parseInt(t.getAttribute("data-days"),10) }) }); await refreshSelectedStudent(); showToast("Доступ продлён"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="toggle-access-block"){
      var blocked=t.getAttribute("data-blocked")==="true";
      try{ await api("/staff/students/"+t.getAttribute("data-id")+"/access/block", { method:"PATCH", body: JSON.stringify({ blocked:blocked }) }); await refreshSelectedStudent(); showToast(blocked?"Доступ заблокирован":"Доступ разблокирован"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="remove-staff"){
      if(!confirm("Отозвать доступ у этого человека?")) return;
      try{ await api("/staff/team/"+t.getAttribute("data-id"), { method:"DELETE" }); await loadStaffData(); showToast("Доступ отозван"); }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="reset-student-password"){
      if(!confirm("Создать новый пароль для этого врача? Старый перестанет работать.")) return;
      try{ var r1=await api("/staff/students/"+t.getAttribute("data-id")+"/reset-password", { method:"POST" }); tempPasswordResult={ name:t.getAttribute("data-name"), tempPassword:r1.tempPassword }; }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="reset-staff-password"){
      if(!confirm("Создать новый пароль для этого сотрудника? Старый перестанет работать.")) return;
      try{ var r2=await api("/staff/team/"+t.getAttribute("data-id")+"/reset-password", { method:"POST" }); tempPasswordResult={ name:t.getAttribute("data-name"), tempPassword:r2.tempPassword }; }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="close-temp-password"){ tempPasswordResult=null; render(); return; }

    if(action==="open-lesson-editor"){
      lessonEditor = { open:true, isNew:false, id:t.getAttribute("data-id"), title:"", duration:"", html:"", dripDays:null, hasDraft:false, publishedTitle:"", publishedDuration:"", publishedHtml:"", history:[], showHistory:false, showPreview:false };
      render();
      try{
        var le=await api("/course/lessons/"+lessonEditor.id);
        var l=le.lesson;
        lessonEditor.publishedTitle=l.title; lessonEditor.publishedDuration=l.duration||""; lessonEditor.publishedHtml=l.html;
        lessonEditor.hasDraft=!!l.has_draft;
        lessonEditor.title = l.has_draft ? l.draft_title : l.title;
        lessonEditor.duration = l.has_draft ? (l.draft_duration||"") : (l.duration||"");
        lessonEditor.html = l.has_draft ? l.draft_html : l.html;
        lessonEditor.dripDays = (typeof l.drip_days==="number") ? l.drip_days : null;
      }catch(err){ showToast(err.message); lessonEditor.open=false; }
      render(); return;
    }
    if(action==="open-lesson-creator"){
      lessonEditor = { open:true, isNew:true, id:null, title:"", duration:"", html:"<p></p>", dripDays:null, hasDraft:false, publishedTitle:"", publishedDuration:"", publishedHtml:"", history:[], showHistory:false, showPreview:false };
      render(); return;
    }
    if(action==="close-lesson-editor"){ lessonEditor.open=false; render(); return; }
    if(action==="overlay-close-lesson-editor" && !e.target.closest("[data-stop]")){ lessonEditor.open=false; render(); return; }
    if(action==="delete-lesson"){
      if(!confirm('Удалить урок «'+t.getAttribute("data-title")+'»? Действие можно откатить в журнале.')) return;
      try{ await api("/course/lessons/"+t.getAttribute("data-id"), { method:"DELETE" }); showToast("Урок удалён"); await loadStaffData(); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="move-lesson"){
      var mlId=t.getAttribute("data-id"); var mlDir=t.getAttribute("data-dir");
      var mlIds=staffState.materials.map(function(x){ return x.id; });
      var mlIdx=mlIds.indexOf(mlId);
      var mlSwap = mlDir==="up" ? mlIdx-1 : mlIdx+1;
      if(mlIdx===-1 || mlSwap<0 || mlSwap>=mlIds.length) return;
      var tmp=mlIds[mlIdx]; mlIds[mlIdx]=mlIds[mlSwap]; mlIds[mlSwap]=tmp;
      try{ await api("/course/lessons/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: mlIds }) }); await loadStaffData(); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="lesson-editor-mode"){
      var frm = document.getElementById("lessonEditorForm");
      if(frm){
        lessonEditor.title = frm.title.value;
        lessonEditor.duration = frm.duration.value;
        lessonEditor.html = frm.html.value;
      }
      var mode = t.getAttribute("data-mode");
      lessonEditor.showPreview = mode==="preview";
      lessonEditor.showHistory = mode==="history";
      if(mode==="history" && !lessonEditor.history.length){
        try{ var hist=await api("/course/lessons/"+lessonEditor.id+"/history"); lessonEditor.history=hist.history; }catch(err){}
      }
      render(); return;
    }
    if(action==="restore-lesson-history"){
      if(!confirm("Восстановить эту версию урока? Текущая опубликованная версия перед этим тоже сохранится в историю.")) return;
      try{
        await api("/course/lessons/"+lessonEditor.id+"/restore/"+t.getAttribute("data-history-id"), { method:"POST" });
        showToast("Версия восстановлена");
        lessonEditor.open=false;
        await loadStaffData();
      }catch(err){ showToast(err.message); }
      render(); return;
    }

    if(action==="open-quiz-editor"){
      var q=staffState.quizAdmin.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!q) return;
      quizEditor = { open:true, isNew:false, id:q.id, question:q.question, options:q.options.slice(), correct:q.correct };
      render(); return;
    }
    if(action==="open-quiz-creator"){
      quizEditor = { open:true, isNew:true, id:null, question:"", options:["",""], correct:0 };
      render(); return;
    }
    if(action==="close-quiz-editor"){ quizEditor.open=false; render(); return; }
    if(action==="overlay-close-quiz-editor" && !e.target.closest("[data-stop]")){ quizEditor.open=false; render(); return; }
    if(action==="delete-quiz-question"){
      if(!confirm("Удалить этот вопрос теста? Действие можно откатить в журнале.")) return;
      try{ await api("/course/quiz-admin/"+t.getAttribute("data-id"), { method:"DELETE" }); showToast("Вопрос удалён"); await loadStaffData(); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="move-quiz-question"){
      var mqId=t.getAttribute("data-id"); var mqDir=t.getAttribute("data-dir");
      var mqIds=staffState.quizAdmin.map(function(x){ return x.id; });
      var mqIdx=mqIds.indexOf(mqId);
      var mqSwap = mqDir==="up" ? mqIdx-1 : mqIdx+1;
      if(mqIdx===-1 || mqSwap<0 || mqSwap>=mqIds.length) return;
      var tmpq=mqIds[mqIdx]; mqIds[mqIdx]=mqIds[mqSwap]; mqIds[mqSwap]=tmpq;
      try{ await api("/course/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: mqIds }) }); await loadStaffData(); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="add-quiz-option" || action==="remove-quiz-option"){
      var qFrm=document.getElementById("quizEditorForm");
      if(qFrm){
        quizEditor.question=qFrm.question.value;
        quizEditor.options=quizEditor.options.map(function(_,i){ var f=qFrm["opt"+i]; return f?f.value:""; });
        var checkedRadio=qFrm.querySelector('input[name="correct"]:checked');
        if(checkedRadio) quizEditor.correct=parseInt(checkedRadio.value,10);
      }
      if(action==="add-quiz-option"){
        quizEditor.options.push("");
      } else {
        var roIdx=parseInt(t.getAttribute("data-idx"),10);
        if(quizEditor.options.length<=2){ showToast("Минимум 2 варианта ответа"); return; }
        quizEditor.options.splice(roIdx,1);
        if(quizEditor.correct===roIdx) quizEditor.correct=0;
        else if(quizEditor.correct>roIdx) quizEditor.correct--;
      }
      render(); return;
    }

    if(action==="toggle-stream-form"){ calendarState.showStreamForm=!calendarState.showStreamForm; render(); return; }
    if(action==="delete-stream"){
      try{ await api("/streams/"+t.getAttribute("data-id"), { method:"DELETE" }); await loadCalendarData(); showToast("Поток удалён"); }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="cal-prev"){ var d1=calendarState.monthDate; calendarState.monthDate=new Date(d1.getFullYear(),d1.getMonth()-1,1); render(); return; }
    if(action==="cal-next"){ var d2=calendarState.monthDate; calendarState.monthDate=new Date(d2.getFullYear(),d2.getMonth()+1,1); render(); return; }
    if(action==="open-event-form"){ calendarState.eventModalMode="create"; calendarState.eventModalDate=t.getAttribute("data-date"); calendarState.recurring=false; render(); return; }
    if(action==="open-event-details"){ calendarState.eventModalMode="view"; calendarState.eventModalId=t.getAttribute("data-id"); render(); return; }
    if(action==="close-event-modal"){ calendarState.eventModalMode=null; render(); return; }
    if(action==="overlay-close-event" && !e.target.closest("[data-stop]")){ calendarState.eventModalMode=null; render(); return; }
    if(action==="toggle-recurring"){ calendarState.recurring=t.checked; render(); return; }
    if(action==="delete-event"){
      try{ await api("/events/"+t.getAttribute("data-id"), { method:"DELETE" }); await loadCalendarData(); showToast("Эфир удалён"); }catch(err){ showToast(err.message); }
      calendarState.eventModalMode=null; render(); return;
    }
    if(action==="delete-event-series"){
      if(!confirm("Удалить все эфиры этой серии повторов?")) return;
      try{ await api("/events/"+t.getAttribute("data-id")+"?series=true", { method:"DELETE" }); await loadCalendarData(); showToast("Серия удалена"); }catch(err){ showToast(err.message); }
      calendarState.eventModalMode=null; render(); return;
    }

    if(action==="select-student"){
      var pid=t.getAttribute("data-id"); var pidx=staffState.selectedIds.indexOf(pid);
      if(t.checked && pidx===-1) staffState.selectedIds.push(pid);
      if(!t.checked && pidx!==-1) staffState.selectedIds.splice(pidx,1);
      render(); return;
    }
    if(action==="select-all-students"){
      var q0=staffState.search.toLowerCase();
      var visible=staffState.students.filter(function(s){
        if(!q0) return true;
        return (s.name||"").toLowerCase().indexOf(q0)!==-1 || (s.specialization||"").toLowerCase().indexOf(q0)!==-1 ||
          (s.email||"").toLowerCase().indexOf(q0)!==-1 || (s.phone||"").toLowerCase().indexOf(q0)!==-1;
      }).map(function(s){ return s.id; });
      staffState.selectedIds = t.checked ? visible : [];
      render(); return;
    }
    if(action==="clear-selection"){ staffState.selectedIds=[]; render(); return; }
    if(action==="toggle-cert-select"){
      var cpid=t.getAttribute("data-id"); var cpidx=staffState.certSelectedIds.indexOf(cpid);
      if(t.checked && cpidx===-1) staffState.certSelectedIds.push(cpid);
      if(!t.checked && cpidx!==-1) staffState.certSelectedIds.splice(cpidx,1);
      render(); return;
    }
    if(action==="toggle-cert-select-all"){
      var pending0=staffState.students.filter(function(s){ return s.completed && s.certificate_status!=="issued"; }).map(function(s){ return s.id; });
      staffState.certSelectedIds = t.checked ? pending0 : [];
      render(); return;
    }
    if(action==="bulk-issue-certificates"){
      var certIds=staffState.certSelectedIds.slice();
      if(!certIds.length) return;
      t.disabled=true; t.textContent="Выдаём…";
      try{
        await api("/course/certificate/bulk-issue", { method:"POST", body: JSON.stringify({ studentIds: certIds }) });
        showToast("Сертификаты выданы: "+certIds.length);
        staffState.certSelectedIds=[];
        await loadStaffData();
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="apply-bulk-stream"){
      var sel=document.getElementById("bulkStreamSelect"); var streamId=sel?sel.value:"";
      var ids=staffState.selectedIds.slice();
      t.disabled=true; t.textContent="Применяем…";
      try{ await api("/staff/students/bulk-stream", { method:"POST", body: JSON.stringify({ids:ids, streamId:streamId}) }); await loadStaffData(); showToast("Поток обновлён у врачей: "+ids.length); }
      catch(err){ showToast(err.message); }
      staffState.selectedIds=[]; render(); return;
    }
    if(action==="apply-bulk-product"){
      var selP=document.getElementById("bulkProductSelect"); var ids2=staffState.selectedIds.slice();
      t.disabled=true; t.textContent="Применяем…";
      try{ await api("/staff/students/bulk-field", { method:"POST", body: JSON.stringify({ids:ids2, field:"product", value: selP?selP.value:"longevity"}) }); await loadStaffData(); showToast("Продукт обновлён у врачей: "+ids2.length); }
      catch(err){ showToast(err.message); }
      staffState.selectedIds=[]; render(); return;
    }
    if(action==="apply-bulk-payment"){
      var selPay=document.getElementById("bulkPaymentSelect"); var ids3=staffState.selectedIds.slice();
      t.disabled=true; t.textContent="Применяем…";
      try{ await api("/staff/students/bulk-field", { method:"POST", body: JSON.stringify({ids:ids3, field:"payment_status", value: selPay?selPay.value:"unpaid"}) }); await loadStaffData(); showToast("Оплата обновлена у врачей: "+ids3.length); }
      catch(err){ showToast(err.message); }
      staffState.selectedIds=[]; render(); return;
    }

    if(action==="open-materials-picker"){
      var targetId2=t.getAttribute("data-id");
      materialsPicker.open=true; materialsPicker.targetId=targetId2; materialsPicker.targetTitle=t.getAttribute("data-title");
      materialsPicker.search=""; materialsPicker.selectedIds=(courseVisibility[targetId2]||[]).slice();
      render(); return;
    }
    if(action==="close-materials-picker"){ materialsPicker.open=false; render(); return; }
    if(action==="overlay-close-materials" && !e.target.closest("[data-stop]")){ materialsPicker.open=false; render(); return; }

    if(action==="open-stream-chat"){
      streamChat.open=true; streamChat.streamId=t.getAttribute("data-id"); streamChat.streamName=t.getAttribute("data-name");
      render(); startStreamMessagePolling(streamChat.streamId,"streamChatList"); return;
    }
    if(action==="close-stream-chat"){ streamChat.open=false; stopStreamMessagePolling(); render(); return; }
    if(action==="overlay-close-stream-chat" && !e.target.closest("[data-stop]")){ streamChat.open=false; stopStreamMessagePolling(); render(); return; }
    if(action==="send-stream-chat-msg"){
      var scinp=document.getElementById("streamChatInput"); var scval=scinp?scinp.value:"";
      if(scval.trim()){ if(scinp) scinp.value=""; try{ await api("/stream-messages/"+streamChat.streamId, { method:"POST", body: JSON.stringify({text:scval}) }); loadStreamMessages(streamChat.streamId,"streamChatList"); }catch(err){ showToast(err.message); } }
      return;
    }
    if(action==="toggle-picker-student"){
      var pid=t.getAttribute("data-id"); var pidx=materialsPicker.selectedIds.indexOf(pid);
      if(t.checked && pidx===-1) materialsPicker.selectedIds.push(pid);
      if(!t.checked && pidx!==-1) materialsPicker.selectedIds.splice(pidx,1);
      render(); return;
    }
    if(action==="toggle-picker-all"){
      var allIds2=staffState.students.map(function(s){ return s.id; });
      materialsPicker.selectedIds = t.checked ? allIds2 : [];
      render(); return;
    }
    if(action==="apply-materials-picker"){
      t.disabled=true; t.textContent="Сохраняем…";
      try{
        await api("/course/visibility/"+materialsPicker.targetId, { method:"PUT", body: JSON.stringify({ ids: materialsPicker.selectedIds }) });
        courseVisibility[materialsPicker.targetId] = materialsPicker.selectedIds.slice();
        materialsPicker.open=false;
        showToast(materialsPicker.selectedIds.length ? "Видимость обновлена — скрыто от "+materialsPicker.selectedIds.length : "Материал снова виден всем");
      }catch(err){ showToast(err.message); }
      render(); return;
    }

    if(action==="toggle-dash-filter-menu"){
      var mGroup=t.getAttribute("data-group");
      dashboardState.openFilterMenu = (dashboardState.openFilterMenu===mGroup) ? null : mGroup;
      render(); return;
    }
    if(action==="toggle-dash-filter"){
      var group=t.getAttribute("data-group"); var val=t.getAttribute("data-value");
      var arr=dashboardState[group]; var vIdx=arr.indexOf(val);
      if(vIdx===-1) arr.push(val); else arr.splice(vIdx,1);
      render(); return;
    }
    if(action==="reset-dash-filters"){
      dashboardState = { periodFrom:"", periodTo:"", specializations:[], streams:[], stages:[], products:[], certStatuses:[], paymentStatuses:[], demoStatuses:[], accessStatuses:[], curatorIds:[], openFilterMenu:null };
      render(); return;
    }
    if(action==="export-dash-csv"){ exportDashboardCSV(computeFilteredStudents()); return; }
  });

  root.addEventListener("submit", async function(e){
    if(e.target.id==="loginForm"){
      e.preventDefault();
      var fd=new FormData(e.target);
      var errBox=document.getElementById("authError"); errBox.style.display="none";
      var btn=e.target.querySelector("button[type=submit]"); btn.disabled=true; btn.textContent="Входим…";
      try{
        var d=await api("/auth/login", { method:"POST", body: JSON.stringify({ email:fd.get("email"), password:fd.get("password") }) });
        me=d.user; await routeAfterLogin();
      }catch(err){ errBox.textContent=err.message; errBox.style.display="block"; btn.disabled=false; btn.textContent="Войти"; }
      return;
    }
    if(e.target.id==="registerForm"){
      e.preventDefault();
      var fd2=new FormData(e.target);
      var errBox2=document.getElementById("authError"); errBox2.style.display="none";
      var btn2=e.target.querySelector("button[type=submit]"); btn2.disabled=true; btn2.textContent="Регистрируем…";
      try{
        var d2=await api("/auth/register", { method:"POST", body: JSON.stringify({
          name:fd2.get("name"), specialization:fd2.get("specialization"), email:fd2.get("email"),
          phone:fd2.get("phone"), workplace:fd2.get("workplace"), password:fd2.get("password")
        }) });
        me=d2.user; await routeAfterLogin();
      }catch(err){ errBox2.textContent=err.message; errBox2.style.display="block"; btn2.disabled=false; btn2.textContent="Начать курс"; }
      return;
    }
    if(e.target.id==="lessonEditorForm"){
      e.preventDefault();
      var fdle=new FormData(e.target);
      var errLe=document.getElementById("lessonEditorError"); errLe.style.display="none";
      var submitMode = (e.submitter && e.submitter.getAttribute("data-submit-mode")) || "draft";
      var btnsLe = e.target.querySelectorAll("button[type=submit]"); btnsLe.forEach(function(b){ b.disabled=true; });
      var payload = { title:fdle.get("title"), duration:fdle.get("duration"), html:fdle.get("html") };
      try{
        if(submitMode==="create"){
          await api("/course/lessons", { method:"POST", body: JSON.stringify(payload) });
          lessonEditor.open=false;
          showToast("Урок добавлен");
        } else {
          var dripInput=document.getElementById("lessonDripInput");
          if(dripInput){
            var dripVal = dripInput.value==="" ? null : parseInt(dripInput.value,10);
            await api("/course/lessons/"+lessonEditor.id+"/drip", { method:"PUT", body: JSON.stringify({ dripDays: dripVal }) });
          }
          await api("/course/lessons/"+lessonEditor.id+"/draft", { method:"PUT", body: JSON.stringify(payload) });
          if(submitMode==="publish"){
            await api("/course/lessons/"+lessonEditor.id+"/publish", { method:"POST" });
            var m=staffState.materials.find(function(x){return x.id===lessonEditor.id;}); if(m){ m.title=payload.title; m.has_draft=false; }
            lessonEditor.open=false;
            showToast("Урок опубликован");
          } else {
            var m2=staffState.materials.find(function(x){return x.id===lessonEditor.id;}); if(m2) m2.has_draft=true;
            lessonEditor.open=false;
            showToast("Черновик сохранён — врачи пока видят прежнюю версию");
          }
        }
        await loadStaffData();
      }catch(err){
        errLe.textContent=err.message; errLe.style.display="block";
        btnsLe.forEach(function(b){ b.disabled=false; });
      }
      render(); return;
    }
    if(e.target.id==="quizEditorForm"){
      e.preventDefault();
      var fdqe=new FormData(e.target);
      var errQe=document.getElementById("quizEditorError"); errQe.style.display="none";
      var btnQe=e.target.querySelector("button[type=submit]"); btnQe.disabled=true; btnQe.textContent="Сохраняем…";
      var opts=quizEditor.options.map(function(_,i){ return fdqe.get("opt"+i); });
      var correctVal=parseInt(fdqe.get("correct"),10);
      try{
        if(quizEditor.isNew){
          await api("/course/quiz-admin", { method:"POST", body: JSON.stringify({ question:fdqe.get("question"), options:opts, correct:correctVal }) });
          quizEditor.open=false; showToast("Вопрос добавлен");
        } else {
          await api("/course/quiz-admin/"+quizEditor.id, { method:"PUT", body: JSON.stringify({ question:fdqe.get("question"), options:opts, correct:correctVal }) });
          var qi=staffState.quizAdmin.find(function(x){return x.id===quizEditor.id;});
          if(qi){ qi.question=fdqe.get("question"); qi.options=opts; qi.correct=correctVal; }
          quizEditor.open=false; showToast("Вопрос сохранён");
        }
        await loadStaffData();
      }catch(err){ errQe.textContent=err.message; errQe.style.display="block"; btnQe.disabled=false; btnQe.textContent="Сохранить вопрос"; }
      render(); return;
    }
    if(e.target.id==="changePasswordForm"){
      e.preventDefault();
      var fdcp=new FormData(e.target);
      var errBoxCp=document.getElementById("changePasswordError"); errBoxCp.style.display="none";
      var btnCp=e.target.querySelector("button[type=submit]"); btnCp.disabled=true; btnCp.textContent="Сохраняем…";
      try{
        await api("/auth/change-password", { method:"POST", body: JSON.stringify({ currentPassword:fdcp.get("currentPassword"), newPassword:fdcp.get("newPassword") }) });
        changePasswordOpen=false; showToast("Пароль изменён");
      }catch(err){ errBoxCp.textContent=err.message; errBoxCp.style.display="block"; btnCp.disabled=false; btnCp.textContent="Сохранить новый пароль"; }
      render(); return;
    }
    if(e.target.id==="profileEditorForm"){
      e.preventDefault();
      var fdpe=new FormData(e.target);
      var errPe=document.getElementById("profileEditorError"); errPe.style.display="none";
      var btnPe=e.target.querySelector("button[type=submit]"); btnPe.disabled=true; btnPe.textContent="Сохраняем…";
      var payloadPe={ name:fdpe.get("name"), phone:fdpe.get("phone")||"" };
      if(me.role==="student"){ payloadPe.specialization=fdpe.get("specialization")||""; payloadPe.workplace=fdpe.get("workplace")||""; }
      try{
        var rPe=await api("/auth/me", { method:"PATCH", body: JSON.stringify(payloadPe) });
        me = rPe.user;
        profileEditor.open=false; showToast("Профиль обновлён");
      }catch(err){ errPe.textContent=err.message; errPe.style.display="block"; btnPe.disabled=false; btnPe.textContent="Сохранить"; }
      render(); return;
    }
    if(e.target.id==="quizForm"){
      e.preventDefault();
      var fd3=new FormData(e.target); var answers={};
      course.quiz.forEach(function(q){ answers[q.id]=parseInt(fd3.get(q.id),10); });
      var btn3=e.target.querySelector("button[type=submit]"); btn3.disabled=true; btn3.textContent="Считаем результат…";
      if(previewMode){
        course.progress.quiz_score=100; course.progress.completed=true; course.progress.certificate_status="pending";
        studentState.quizSubmitted=true;
        render(); return;
      }
      try{
        var r3=await api("/course/quiz-submit", { method:"POST", body: JSON.stringify({answers:answers}) });
        course.progress.quiz_score=r3.score; course.progress.completed=r3.completed; course.progress.certificate_status=r3.certificateStatus;
        studentState.quizSubmitted=true;
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(e.target.id==="inviteStudentForm"){
      e.preventDefault();
      var fd4=new FormData(e.target); var btn4=e.target.querySelector("button[type=submit]"); btn4.disabled=true; btn4.textContent="Выдаём…";
      try{ await api("/invites", { method:"POST", body: JSON.stringify({ email:fd4.get("email"), role:"student" }) }); showToast("Доступ выдан"); staffState.showInviteStudent=false; }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(e.target.id==="inviteBulkForm"){
      e.preventDefault();
      var fd8=new FormData(e.target);
      var raw = fd8.get("emails") || "";
      var errBulk=document.getElementById("inviteBulkError"); errBulk.style.display="none";
      // Разбираем и обычный список по строкам, и CSV — берём любой токен, похожий на email
      var emails = (raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []);
      emails = Array.from(new Set(emails.map(function(x){ return x.toLowerCase(); })));
      if(!emails.length){ errBulk.textContent="Не нашли ни одного email в тексте"; errBulk.style.display="block"; return; }
      var btn8=e.target.querySelector("button[type=submit]"); btn8.disabled=true; btn8.textContent="Приглашаем…";
      try{
        var r8 = await api("/invites/bulk", { method:"POST", body: JSON.stringify({ emails: emails }) });
        showToast("Приглашено: "+r8.created.length+(r8.skipped.length?(", пропущено: "+r8.skipped.length):""));
        staffState.showInviteStudent=false;
        await loadStaffData();
      }catch(err){ errBulk.textContent=err.message; errBulk.style.display="block"; btn8.disabled=false; btn8.textContent="Пригласить всех"; }
      render(); return;
    }
    if(e.target.id==="inviteStaffForm"){
      e.preventDefault();
      var fd5=new FormData(e.target); var btn5=e.target.querySelector("button[type=submit]"); btn5.disabled=true; btn5.textContent="Отправляем…";
      try{ await api("/invites", { method:"POST", body: JSON.stringify({ email:fd5.get("email"), role:fd5.get("role") }) }); showToast("Приглашение отправлено"); e.target.reset(); }
      catch(err){ showToast(err.message); btn5.disabled=false; btn5.textContent="Отправить приглашение"; }
      return;
    }
    if(e.target.id==="streamForm"){
      e.preventDefault();
      var fd6=new FormData(e.target); var btn6=e.target.querySelector("button[type=submit]"); btn6.disabled=true; btn6.textContent="Создаём…";
      try{ await api("/streams", { method:"POST", body: JSON.stringify({ name:fd6.get("name"), startDate:fd6.get("startDate") }) }); await loadCalendarData(); calendarState.showStreamForm=false; showToast("Поток создан"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(e.target.id==="eventForm"){
      e.preventDefault();
      var fd7=new FormData(e.target); var btn7=e.target.querySelector("button[type=submit]"); btn7.disabled=true; btn7.textContent="Добавляем…";
      try{
        var payload7 = {
          title:fd7.get("title"), date:fd7.get("date"), time:fd7.get("time"), duration:fd7.get("duration"),
          speaker:fd7.get("speaker"), streamId:fd7.get("streamId"), joinUrl:fd7.get("joinUrl"), description:fd7.get("description")
        };
        if(fd7.get("recurring")){ payload7.recurrence="weekly"; payload7.recurrenceUntil=fd7.get("recurrenceUntil"); }
        var r7 = await api("/events", { method:"POST", body: JSON.stringify(payload7) });
        await loadCalendarData(); calendarState.eventModalMode=null; calendarState.recurring=false;
        showToast(r7.created>1 ? "Добавлено эфиров: "+r7.created : "Эфир добавлен в расписание");
      }catch(err){ showToast(err.message); btn7.disabled=false; btn7.textContent="Добавить в расписание"; }
      render(); return;
    }
  });

  root.addEventListener("change", async function(e){
    if(e.target.hasAttribute("data-stream-select")){
      try{ await api("/staff/students/"+e.target.getAttribute("data-id")+"/stream", { method:"PATCH", body: JSON.stringify({ streamId: e.target.value }) }); var s=staffState.students.find(function(x){return x.id===e.target.getAttribute("data-id");}); if(s) s.stream_id=e.target.value; showToast("Поток обновлён"); }
      catch(err){ showToast(err.message); }
      return;
    }
    if(e.target.hasAttribute("data-role-select")){
      var rsId=e.target.getAttribute("data-id"); var rsVal=e.target.value;
      try{
        await api("/staff/team/"+rsId+"/role", { method:"PATCH", body: JSON.stringify({ role: rsVal }) });
        var rsStaff=staffState.staff.find(function(x){ return x.id===rsId; });
        if(rsStaff) rsStaff.role=rsVal;
        showToast("Роль обновлена");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(e.target.hasAttribute("data-field-select")){
      var field=e.target.getAttribute("data-field-select"); var id=e.target.getAttribute("data-id"); var val=e.target.value;
      try{
        if(field==="product"){ await api("/staff/students/"+id+"/product", { method:"PATCH", body: JSON.stringify({ product: val }) }); }
        else if(field==="payment"){ await api("/staff/students/"+id+"/payment", { method:"PATCH", body: JSON.stringify({ paymentStatus: val }) }); }
        else if(field==="curator"){ await api("/staff/students/"+id+"/curator", { method:"PATCH", body: JSON.stringify({ curatorId: val||null }) }); }
        var s2=staffState.students.find(function(x){return x.id===id;});
        if(s2){ if(field==="product") s2.product=val; if(field==="payment") s2.payment_status=val; if(field==="curator") s2.assigned_curator_id=val||null; }
        showToast("Сохранено");
      }catch(err){ showToast(err.message); }
      return;
    }
    if(e.target.id==="bulkCsvFile"){
      var file = e.target.files && e.target.files[0];
      if(!file) return;
      var reader = new FileReader();
      reader.onload = function(){
        var textarea = document.querySelector('#inviteBulkForm textarea[name="emails"]');
        if(textarea) textarea.value = String(reader.result);
      };
      reader.readAsText(file);
    }
  });

  root.addEventListener("input", function(e){
    if(e.target.id==="rosterSearch"){
      staffState.search=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("rosterSearch"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
      return;
    }
    if(e.target.id==="materialsPickerSearch"){
      materialsPicker.search=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("materialsPickerSearch"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
    }
    if(e.target.id==="dashPeriodFrom"){ dashboardState.periodFrom=e.target.value; render(); }
    if(e.target.id==="dashPeriodTo"){ dashboardState.periodTo=e.target.value; render(); }
  });

  root.addEventListener("keydown", function(e){
    var sendActionById = { msgInput:"send-student-msg", curatorMsgInput:"send-curator-msg", msgInputStream:"send-student-stream-msg", streamChatInput:"send-stream-chat-msg" };
    var sendAction = sendActionById[e.target.id];
    if(sendAction && e.key==="Enter" && !e.shiftKey){
      e.preventDefault();
      var btn = root.querySelector('[data-action="'+sendAction+'"]');
      if(btn) btn.click();
    }
  });
}

applyTheme();
init();
})();
