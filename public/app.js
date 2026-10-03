(function(){
"use strict";

// Относительный путь — резолвится от текущего URL страницы, а не от корня домена:
// работает и на отдельном (под)домене, и при монтировании платформы в подпапку
// (например /lms/, см. BASE_PATH в src/server.js). SPA никогда не меняет
// window.location (нет pushState/history) — база резолвинга не съезжает при переходах.
var API = "api";
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
var specializationsList = [];  // справочник специализаций — грузится один раз при старте (нужен и до входа, на форме регистрации)
var course = null;             // {course, lessons, quiz, progress} — для врача
// Врач может быть записан сразу на несколько курсов — enrollments — лёгкий список
// всех его записей, activeCourseId — какой из них сейчас открыт (переключатель
// показывается только когда записей больше одной — иначе интерфейс не меняется).
var studentEnrollments = [];
var activeCourseId = null;
var studentState = { tab:"course", navKey:"course", lessonIndex:0, quizMode:false, quizSubmitted:false, materialsSearch:"", materialsFilter:"all", materialsAutoFocus:false,
  lessonStage:"intro", videoEnded:false, lessonQuizResult:null, protocolsLoaded:false,
  // Гейт после последнего урока модуля: null | "quiz" | "feedback".
  moduleGateStage:null, moduleGateId:null, moduleQuizResult:null, moduleFeedbackRating:0, moduleFeedbackComment:"" };
var staffState = { mainTab:"home", navKey:"home", students:[], staff:[], invites:[], search:"", selectedStudentId:null, selectedStudent:null, selectedStudentEnrollments:[], drawerTab:"progress", selectedIds:[], materials:[], certificatesEnabled:false, quizAdmin:[], auditLog:[], inviteMode:"single", certSelectedIds:[], notes:[], noteDraft:"", inbox:{inactive:[],pendingCertificates:[]}, digest:null, inviteCode:null, editSpecializationIds:[], editName:"", editPhone:"", editWorkplace:"",
  coursesList:[], activeCourseId:null, courseEditorId:null, courseEditorTitle:"", courseEditorCertsEnabled:false, courseDeleteConfirmId:null, courseDeleteConfirmText:"", newCourseTitle:"", enrollCourseId:"",
  showImportStudents:false, importResult:null };
var profileEditor = { open:false, name:"", phone:"", workplace:"", specializationIds:[], interestIds:[] };
// Черновик специализаций для формы регистрации — до входа в систему нет ни
// me, ни staffState, поэтому отдельное состояние; сбрасывается заново при
// каждом переходе на экран регистрации (см. action "go-register").
// name/email/phone/password/staffInviteCode тоже здесь (не просто specializationIds/
// interestIds) — потому что клик по выпадающему списку специализаций вызывает
// render(), который иначе стирал бы уже введённый текст в соседних полях формы
// (без этого draft'а он бы каждый раз выводился заново из пустоты — value="").
var registerDraft = { name:"", email:"", phone:"", password:"", staffInviteCode:"", specializationIds:[], interestIds:[], asStaff:false };
// Какой из выпадающих списков специализаций сейчас открыт — один на всё
// приложение, т.к. одновременно виден только один такой список — и что
// набрано в его строке поиска.
var specPickerOpen = null;
var specPickerQuery = "";
var calendarState = { monthDate:new Date(), streams:[], events:[], showStreamForm:false, eventModalMode:null, eventModalDate:null, eventModalId:null, recurring:false };
var materialsPicker = { open:false, targetId:null, targetTitle:"", search:"", selectedIds:[] };
var scheduleModal = { open:false, lessonId:null, lessonTitle:"", search:"", selectedIds:[], applyToAll:true, unlockDate:"", schedule:[] };
var notifState = { items:[], unreadCount:0 };
var mySessionsList = [];
var mySessionsLoaded = false, mySessionsLoading = false;
var studentProtocols = { forYou:[], additional:[] };
var protocolExpanded = {}; // id протокола -> открыта ли карточка гайда
var protocolReader = { id:null, mine:false }; // окно чтения гайда на странице протоколов
var protocolGuideTab = {}; // id протокола -> id специализации выбранного гайда (переключатель "показать другие")
var notifPollTimer = null;
var courseVisibility = {}; // {lessonId|"quiz": [uid,...]} — для вкладки «Материалы» у персонала
var directory = []; // все сотрудники (admin+curator+super_admin) — для фильтра/назначения куратора
var auditFilters = { q:"", action:"", actorId:"", dateFrom:"", dateTo:"" };
var auditActionsList = [];
var auditSearchDebounceTimer = null;
var dashboardState = { periodFrom:"", periodTo:"", specializations:[], streams:[], stages:[], products:[], certStatuses:[], paymentStatuses:[], demoStatuses:[], accessStatuses:[], curatorIds:[], openFilterMenu:null };

// Ступени обмена очков на скидку — бизнес-правило, не техническое ограничение
// (см. также MAX_POINTS в src/routes/course.js, где сумма очков реально считается).
var POINT_TIERS = [ { points:500, discount:10 }, { points:750, discount:20 }, { points:1000, discount:25 } ];
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
var toastTimer = null;
var changePasswordOpen = false;
// Мобильный сайдбар (≤640px): раскрывается по тапу на кнопку-гамбургер, а не по
// :hover/:focus-within (на тач-устройстве hover не срабатывает никогда, а сам
// сайдбар — position:fixed без подложки, так что раскрытая ширина без этого
// стейта просто накладывалась на контент страницы, обрезая текст под собой).
var mobileNavOpen = false;
// Заменяет window.confirm() — тот не стилизуется (всегда системный вид, вне
// тёмной темы) и блокирует поток синхронно. {title, body, confirmLabel, danger, onConfirm}.
var confirmState = null;
function askConfirm(opts){
  confirmState = { title: opts.title||"Подтвердите действие", body: opts.body||"", confirmLabel: opts.confirmLabel||"Подтвердить", danger: opts.danger!==false, onConfirm: opts.onConfirm };
  render();
}
var previewMode = false;
var previewReturnTab = "students";
var tempPasswordResult = null; // {name, tempPassword} — показать один раз после сброса пароля
var lessonEditor = { open:false, isNew:false, id:null, title:"", duration:"", html:"", dripDays:null, hasDraft:false, publishedTitle:"", publishedDuration:"", publishedHtml:"", history:[], showHistory:false, showPreview:false };
var quizEditor = { open:false, isNew:false, id:null, question:"", options:[], correct:0, lessonId:null, moduleId:null };
// Видео с главами-таймкодами у конкретного урока (отдельно от WYSIWYG-содержимого урока).
var videoEditor = { open:false, lessonId:null, lessonTitle:"", videoUrl:"", timecodes:[], uploadProgress:null };
// Поурочный «развлекательный» тест — свой список вопросов на каждый урок,
// отдельно от staffState.quizAdmin (это только итоговый тест курса).
var lessonQuizManager = { open:false, lessonId:null, lessonTitle:"", questions:[] };
// Модули курса (admin/super_admin) — список + состав каждого модуля, отдельно
// от staffState.materials (все уроки курса, без группировки).
var moduleManagerState = { modules:[], allLessons:[] };
var moduleQuizManager = { open:false, moduleId:null, moduleTitle:"", questions:[] };
var moduleFeedbackViewer = { open:false, moduleId:null, moduleTitle:"", feedback:[], average:null, count:0 };
var adminProtocolsState = { list:[] };
var protocolEditor = { open:false, id:null, title:"", summary:"", guides:[], lessonIds:[] };
var specializationEditor = { open:false, id:null, name:"" }; // редактирование названия специализации (создание — отдельной мини-формой на странице)
// Разовая анимация «разблокировали функцию» поверх экрана — показывается один
// раз, в момент когда «Ваши протоколы» реально становится доступно (см.
// protocolsSectionAvailable), не при каждом заходе на дашборд.
var unlockCelebration = { open:false };

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
// Для полей, которые вводятся обычной textarea (не WYSIWYG) — гайды протоколов,
// сводка по главе видео — но потом выводятся как HTML: экранируем спецсимволы
// (чтобы случайный "<" в тексте не ломал вёрстку) и превращаем переносы строк
// в <br>, раз это именно ПЛОСКИЙ текст, а не размеченный.
// Каждая строка — свой абзац (а не просто <br> внутри одного блока): именно так
// куратор/админ обычно и печатает "Шаг 1: ...\nШаг 2: ..." — со своим отступом
// и межстрочным интервалом на каждый пункт, а не сплошной стеной текста.
function renderPlainToProse(s){
  var lines = String(s||"").split(/\n+/).map(function(l){ return l.trim(); }).filter(Boolean);
  if(!lines.length) return "";
  return lines.map(function(l){ return "<p>"+escapeHtml(l)+"</p>"; }).join("");
}
// Аватар пользователя: фото, если загружено (avatar_url), иначе инициалы на
// мягком тоне. cls/style — доп. класс и стиль кружка.
function userAvatar(u, cls, style){
  u = u || {};
  // Строки инбокса/дайджеста приходят без avatar_url — берём из списка врачей.
  if(!u.avatar_url && u.id && typeof staffState!=="undefined"){
    var full = (staffState.students||[]).find(function(x){ return x.id===u.id; }) || (staffState.staff||[]).find(function(x){ return x.id===u.id; });
    if(full && full.avatar_url) u = Object.assign({}, u, { avatar_url: full.avatar_url });
  }
  var inner = u.avatar_url ? '<img src="'+escapeHtml(u.avatar_url)+'" alt="" loading="lazy">' : initials(u.name);
  return '<div class="avatar'+(cls?' '+cls:'')+(u.avatar_url?' has-photo':'')+'" style="'+(u.avatar_url?'':avatarTone(u.name))+(style||'')+'">'+inner+'</div>';
}
function initials(name){ var p=(name||"?").trim().split(/\s+/); return ((p[0]||"?")[0]+(p[1]?p[1][0]:"")).toUpperCase(); }

/* ============================= ИКОНКИ (авторский SVG-набор) ============================= */
var ICONS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z"/>',
  sparkle: '<path d="M12 3.5c.7 4.3 2.2 5.8 6.5 6.5-4.3.7-5.8 2.2-6.5 6.5-.7-4.3-2.2-5.8-6.5-6.5 4.3-.7 5.8-2.2 6.5-6.5Z"/><path d="M18.5 15.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z"/>',
  play: '<rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="M10.5 9.5v5l4-2.5Z"/>',
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
  book: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v14H6.5A1.5 1.5 0 0 0 5 19.5v-14Z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H18v-3"/><path d="M9 8h5"/>',
  shield: '<path d="M12 3.5l7 2.8v5.4c0 4.2-3 7.4-7 8.8-4-1.4-7-4.6-7-8.8V6.3l7-2.8Z"/><path d="M9 12l2 2 4-4"/>',
  chevron: '<path d="M6 9.5l6 6 6-6"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"/><circle cx="12" cy="12.8" r="3.4"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M7 7l1 12.5A1.5 1.5 0 0 0 9.5 21h5a1.5 1.5 0 0 0 1.5-1.5L17 7"/>',
  bell: '<path d="M6 10.5a6 6 0 0 1 12 0v4l1.8 3H4.2L6 14.5v-4Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  flame: '<path d="M12 2.5s-5.5 5-5.5 10a5.5 5.5 0 0 0 11 0c0-1.6-.7-2.7-1.4-3.7.1 1.6-.6 2.6-1.4 2.6-1.1 0-1.2-1-1-2 .3-1.7-.2-3.6-1.7-4.9-.1 1.4-.6 2.5-1.5 3.4-1.1 1.1-1.5 2.4-1.5 3.6a3 3 0 0 0 3 3"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.5-4 4-5.5 7-5.5s5.5 1.5 7 5.5"/>',
  users: '<circle cx="8.5" cy="8" r="3"/><path d="M2.5 20c1.2-3.5 3.2-5 6-5s4.8 1.5 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.3 13c2 .2 3.4 1.6 4.2 3.8"/>',
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5h12V10"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5A1.5 1.5 0 0 1 3.5 17.5V7Z"/>',
  chartbar: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  message: '<path d="M4 5.5A2 2 0 0 1 6 3.5h12a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H9l-4.5 4V5.5Z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 4v2.4M12 17.6V20M4 12h2.4M17.6 12H20M6.3 6.3l1.7 1.7M16 16l1.7 1.7M17.7 6.3 16 8M8 16l-1.7 1.7"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 16l4-4-4-4M19 12H9"/>',
  task: '<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M8.5 12.2l2.3 2.3 4.7-4.9"/><path d="M8.5 7.5h7"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16.5" height="11.5" rx="2"/><path d="M16 13.8h1.5"/>',
  poll: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 16v-3.5M12 16V8M16 16v-5.5"/>',
  feed: '<path d="M5 5.5h14M5 10h9M5 14.5h14M5 19h9"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/>',
  download: '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M8 11l4 4 4-4"/><path d="M12 14.5V4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  go: '<path d="M8.5 5.8v12.4L18.5 12z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>'
};
function icon(name, cls){ return '<svg class="ic'+(cls?' '+cls:'')+'" viewBox="0 0 24 24">'+(ICONS[name]||'')+'</svg>'; }
function brandMark(style){ return '<span class="mark"'+(style?' style="'+style+'"':'')+'>'+icon("doctor")+'</span>'; }

/* ============================= МАГНИТ (единственный язык статуса) ============================= */
function magnet(kind, label){
  return '<span class="magnet '+kind+'"><span class="magnet-dot"></span><span class="magnet-label">'+escapeHtml(label)+'</span></span>';
}
// Шапка карточки: заголовок слева, кнопка перехода — справа на той же линии.
function cardHead(title, actionHtml){
  return '<div class="card-head"><b class="card-title">'+escapeHtml(title)+'</b>'+(actionHtml||'')+'</div>';
}
function fmtDate(iso){ if(!iso) return "—"; try{ return new Date(iso).toLocaleDateString("ru-RU",{day:"numeric",month:"short",year:"numeric"}); }catch(e){ return "—"; } }
// Короткая дата для таблиц: без года, если он текущий («26 сент.»).
function fmtDateShort(iso){ if(!iso) return "—"; try{ var d=new Date(iso), o={day:"numeric",month:"short"}; if(d.getFullYear()!==new Date().getFullYear()) o.year="numeric"; return d.toLocaleDateString("ru-RU",o); }catch(e){ return "—"; } }
function fmtTime(iso){ if(!iso) return ""; try{ return new Date(iso).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}); }catch(e){ return ""; } }
function fmtTimecode(sec){ sec=Math.max(0,Math.round(sec||0)); var m=Math.floor(sec/60), s=sec%60; return m+":"+(s<10?"0":"")+s; }
function ruPluralClient(n, one, few, many){
  var mod100 = n % 100, mod10 = n % 10;
  if(mod100>=11 && mod100<=14) return many;
  if(mod10===1) return one;
  if(mod10>=2 && mod10<=4) return few;
  return many;
}
var RU_MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
function isSameCalendarDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
// «Был(а) в сети» — формат как в VK/Telegram: минуты назад, пока это недавно,
// дальше "сегодня в 14:32" / "вчера в 20:15" / "3 сентября в 11:04" — привязка
// к календарным суткам, а не бесконечное "N часов назад".
function timeSince(iso){
  if(!iso) return "никогда";
  var d = new Date(iso);
  var now = new Date();
  var mins = Math.floor(Math.max(0, now.getTime()-d.getTime())/60000);
  if(mins < 1) return "только что";
  if(mins < 60) return mins+" "+ruPluralClient(mins,"минуту","минуты","минут")+" назад";
  if(isSameCalendarDay(d,now)) return "сегодня в "+fmtTime(iso);
  var yesterday = new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
  if(isSameCalendarDay(d,yesterday)) return "вчера в "+fmtTime(iso);
  var label = d.getDate()+" "+RU_MONTHS_GEN[d.getMonth()];
  if(d.getFullYear()!==now.getFullYear()) label += " "+d.getFullYear();
  return label+" в "+fmtTime(iso);
}
function showToast(text){
  var old = document.getElementById("toast"); if(old) old.remove();
  var node = el('<div class="toast" id="toast">'+escapeHtml(text)+'</div>');
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ node.remove(); }, 2800);
}

async function api(path, opts){
  opts = opts || {};
  // Сотрудник смотрит кабинет глазами врача — только просмотр. Сервер тоже это
  // запрещает, а здесь просто не шлём запрос и сразу объясняем, почему.
  var m = (opts.method||"GET").toUpperCase();
  if(me && me.impersonator && m!=="GET" && !/^\/auth\/(impersonate\/stop|logout)$/.test(path)){
    var ro = new Error("Это кабинет врача в режиме просмотра — изменения от его имени недоступны");
    ro.code = "read_only"; throw ro;
  }
  var res = await fetch(API + path, Object.assign({
    credentials: "include",
    headers: opts.body ? { "Content-Type":"application/json" } : {}
  }, opts));
  var data = null;
  try{ data = await res.json(); }catch(e){ data = null; }
  if(!res.ok){
    var err = new Error((data && data.message) || "Ошибка запроса");
    err.code = data && data.error;
    err.data = data;
    throw err;
  }
  return data;
}

// Отдельно от api(): загрузка файла — тело FormData, Content-Type со своей
// границей (boundary) браузер проставляет сам, вручную задавать нельзя.
async function apiUpload(path, formData){
  var res = await fetch(API + path, { method:"POST", credentials:"include", body: formData });
  var data = null;
  try{ data = await res.json(); }catch(e){ data = null; }
  if(!res.ok){
    var err = new Error((data && data.message) || "Не удалось загрузить файл");
    err.code = data && data.error;
    throw err;
  }
  return data;
}

// Видео весит десятки-сотни МБ, загрузка может идти минуты — обычный fetch не даёт
// узнать промежуточный прогресс, поэтому здесь XMLHttpRequest ради onprogress.
function apiUploadWithProgress(path, formData, onProgress){
  return new Promise(function(resolve, reject){
    var xhr = new XMLHttpRequest();
    xhr.open("POST", API + path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = function(e){
      if(onProgress && e.lengthComputable) onProgress(Math.round((e.loaded/e.total)*100));
    };
    xhr.onload = function(){
      var data = null;
      try{ data = JSON.parse(xhr.responseText); }catch(e){}
      if(xhr.status>=200 && xhr.status<300) resolve(data);
      else { var err=new Error((data && data.message) || "Не удалось загрузить файл"); err.code=data && data.error; reject(err); }
    };
    xhr.onerror = function(){ reject(new Error("Не удалось загрузить файл — проверьте соединение")); };
    xhr.send(formData);
  });
}

/* ============================= ИНИЦИАЛИЗАЦИЯ ============================= */
async function init(){
  var refParam = new URLSearchParams(window.location.search).get("ref");
  if(refParam) sessionStorage.setItem("lms-ref-code", refParam);
  try{ var specData = await api("/specializations"); specializationsList = specData.specializations; }catch(e){}
  try{
    var data = await api("/auth/me");
    me = data.user;
    await routeAfterLogin();
  }catch(e){
    view = "login";
    render();
  }
}

// Как в Telegram/VK: статус "в сети" должен пропадать сразу при закрытии вкладки,
// а не только когда истечёт тайм-аут хартбита. Обычный fetch на выгрузке страницы
// браузер может оборвать, не отправив — sendBeacon как раз для этого случая:
// гарантированно уходит даже когда страница уже закрывается.
function sendOfflineBeacon(){
  if(!me || me.role!=="student" || me.impersonator) return;
  try{ navigator.sendBeacon(API+"/course/offline"); }catch(e){}
}
window.addEventListener("pagehide", sendOfflineBeacon);

async function routeAfterLogin(){
  // Обновление страницы (F5) заново выполняет init()/routeAfterLogin — раньше это
  // всегда сбрасывало на главную/список врачей, потому что history.state (куда
  // popstate уже умеет записывать текущий раздел) читался только при переходах
  // по истории, а не при обычной перезагрузке той же записи. history.state
  // переживает reload — просто раньше сюда не заглядывали.
  var savedState = null;
  try{ var hs = history.state; if(hs && (hs.view==="student"||hs.view==="staff")) savedState = hs; }catch(e){}
  // Ссылка вида "?tab=…" (см. sidebarItem) — так открывается пункт меню в новой
  // вкладке по ПКМ/Ctrl+клику: сама SPA такой URL никогда не пишет (обычный клик
  // гасится через preventDefault), так что раз он тут — это осознанное открытие
  // по ссылке, а не потерянное состояние. Приоритетнее history.state (он тут
  // всё равно пуст — вкладка свежая), и сразу же убираем его из адресной строки,
  // чтобы дальше приложение продолжало работать без URL, как и везде в SPA:
  // дальше положение в истории ведёт syncNavHistory сам через history.state.
  var tabParam = null;
  try{
    tabParam = new URLSearchParams(location.search).get("tab");
    if(tabParam) history.replaceState(null, "", location.pathname + location.hash);
  }catch(e){}
  // Если сейчас переключимся на другую вкладку (по ссылке или из history.state),
  // фоновая догрузка протоколов ниже не должна рендерить «главную» сама —
  // studentState.tab к моменту её ответа ещё не сменился (смена — только ниже,
  // после нескольких await), и такой промежуточный рендер мелькал бы главной
  // перед тем, как чуть позже отрисуется нужная вкладка.
  var willLeaveHome = !!tabParam || !!(savedState && savedState.view==="student" && savedState.studentTab && savedState.studentTab!=="course");
  if(me.role === "student"){
    view = "student";
    await loadCourse();
    if(course && protocolsSectionAvailable()) loadProtocols().then(function(){ if(studentState.tab==="course" && !willLeaveHome) render(); });
    await loadCalendarData();
    await loadStudentTools();
    await loadNotifications();
    startNotificationPolling();
    if(!me.impersonator) startHeartbeat();
    if(tabParam) await navigateToTab(tabParam);
    else if(savedState && savedState.view==="student") applyNavState(savedState);
  } else {
    view = "staff";
    await loadStaffData();
    await loadCalendarData();
    await loadNotifications();
    startNotificationPolling();
    // Вернулись из кабинета врача — сразу открываем его карточку, откуда пришли.
    var impBack = null; try{ impBack = sessionStorage.getItem("lms-imp-return"); sessionStorage.removeItem("lms-imp-return"); }catch(e){}
    if(impBack){ staffState.mainTab = "students"; staffState.navKey = "students"; render(); openStudentPage(impBack); return; }
    if(tabParam) await navigateToTab(tabParam);
    else if(savedState && savedState.view==="staff") applyNavState(savedState);
  }
  render();
}

async function loadNotifications(){
  try{
    var data = await api("/notifications");
    notifState.items = data.notifications;
    notifState.unreadCount = data.unreadCount;
  }catch(e){}
}
// «Мой профиль» → «Текущие сеансы» — грузится лениво, только когда открыли эту
// страницу, а не при каждом входе (в отличие от чатов/уведомлений, это не бейдж).
// «Ваши протоколы» — грузится лениво при первом заходе на страницу, а не при
// каждом входе (в отличие от чатов/уведомлений, тут нет бейджа, который нужно
// держать актуальным постоянно).
async function loadProtocols(){
  try{ var d = await api("/course/protocols?courseId="+encodeURIComponent(activeCourseId)); studentProtocols = { forYou:d.forYou, additional:d.additional, upcoming:d.upcoming||[], totalInCourse:d.totalInCourse||0, nextLesson:d.nextLesson||null }; }
  catch(e){ studentProtocols = { forYou:[], additional:[] }; }
  studentState.protocolsLoaded = true;
}
async function loadMySessions(){
  try{ var d = await api("/auth/sessions"); mySessionsList = d.sessions; }
  catch(e){ mySessionsList = []; }
  mySessionsLoaded = true;
}

function startNotificationPolling(){
  stopNotificationPolling();
  notifPollTimer = setInterval(async function(){
    var before = (notifState.items||[]).map(function(n){ return n.id; });
    await loadNotifications();
    var fresh = (notifState.items||[]).filter(function(n){ return before.indexOf(n.id)===-1; });
    if(view==="staff") await loadAssignCounts();
    if(view==="student" && fresh.length){
      // Куратор проверил задание или открылся курс — подтягиваем уроки заново,
      // чтобы статус в уроке сменился без перезагрузки страницы.
      if(fresh.some(function(n){ return /^assignment_|^course_opened/.test(n.type); })) await loadCourse();
      if(fresh.some(function(n){ return n.type==="survey_new"; })) await loadStudentTools();
    }
    if(!isTypingNow()) render();
  }, 30000);
}

// «Онлайн сейчас» у куратора держится на этом пинге — раз в 45с, пока у врача
// открыта вкладка. GET /course при заходе уже само отмечает last_seen_at,
// это только продлевает статус, пока сессия остаётся открытой.
var heartbeatTimer = null;
function startHeartbeat(){
  stopHeartbeat();
  heartbeatTimer = setInterval(function(){ api("/course/heartbeat", { method:"PUT" }).catch(function(){}); }, 45000);
}
function stopHeartbeat(){ if(heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer=null; } }
function stopNotificationPolling(){ if(notifPollTimer){ clearInterval(notifPollTimer); notifPollTimer=null; } }

async function loadCourse(){
  try{
    var en = await api("/course/enrollments");
    studentEnrollments = en.enrollments;
    if(!activeCourseId || !studentEnrollments.some(function(x){ return x.courseId===activeCourseId; })){
      activeCourseId = studentEnrollments.length ? studentEnrollments[0].courseId : null;
    }
    course = activeCourseId ? await api("/course/content/"+activeCourseId) : null;
  }catch(e){
    showToast(e.message);
  }
}

async function loadCalendarData(){
  try{ var s = await api("/streams"); calendarState.streams = s.streams; }catch(e){}
  try{ var ev = await api("/events"); calendarState.events = ev.events; }catch(e){}
}

// Курсов может быть несколько — грузим список первым и определяем, какой из них
// сейчас "активный" (переключается вручную, см. renderStaffCourseSwitcher), прежде
// чем тянуть всё, что зависит от конкретного курса (ученики, инбокс, конструктор).
async function loadCoursesList(){
  try{
    var r = await api("/courses");
    staffState.coursesList = r.courses;
    if(!staffState.activeCourseId || !staffState.coursesList.some(function(c){ return c.id===staffState.activeCourseId; })){
      staffState.activeCourseId = staffState.coursesList.length ? staffState.coursesList[0].id : null;
    }
  }catch(e){}
}

async function loadStaffData(){
  await loadCoursesList();
  var cid = staffState.activeCourseId;
  var cq = cid ? "?courseId="+encodeURIComponent(cid) : "";
  try{
    var s = await api("/staff/students"+cq);
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
    try{
      staffState.inviteCode = await api("/staff/invite-code");
    }catch(e){}
  }
  try{
    var mat = await api("/course/materials"+cq);
    staffState.materials = mat.lessons;
    staffState.certificatesEnabled = !!mat.certificatesEnabled;
  }catch(e){}
  try{
    var vis = await api("/course/visibility"+cq);
    courseVisibility = vis.hiddenFor || {};
  }catch(e){}
  try{
    var dir = await api("/staff/directory");
    directory = dir.staff;
  }catch(e){}
  try{
    var ibx = await api("/staff/inbox"+cq);
    staffState.inbox = ibx;
  }catch(e){}
  try{
    staffState.digest = await api("/staff/daily-digest");
  }catch(e){}
  await loadAssignCounts();
  await loadOrders();
  try{
    var pr = await api("/protocols");
    adminProtocolsState.list = pr.protocols;
  }catch(e){}
  if(me.role==="admin" || me.role==="super_admin"){
    try{
      var qa = await api("/course/quiz-admin"+cq);
      staffState.quizAdmin = qa.quiz;
    }catch(e){}
    try{
      var mods = await api("/course/modules"+cq);
      moduleManagerState.modules = mods.modules;
      moduleManagerState.allLessons = mods.allLessons;
    }catch(e){}
    await loadAuditLog();
    try{
      var acts = await api("/staff/audit-log/actions");
      auditActionsList = acts.actions;
    }catch(e){}
  }
}

async function loadAuditLog(){
  var params = new URLSearchParams();
  if(auditFilters.q) params.set("q", auditFilters.q);
  if(auditFilters.action) params.set("action", auditFilters.action);
  if(auditFilters.actorId) params.set("actorId", auditFilters.actorId);
  if(auditFilters.dateFrom) params.set("dateFrom", auditFilters.dateFrom);
  if(auditFilters.dateTo) params.set("dateTo", auditFilters.dateTo);
  var qs = params.toString();
  try{
    var log = await api("/staff/audit-log"+(qs?"?"+qs:""));
    staffState.auditLog = log.log;
  }catch(e){}
}

async function refreshSelectedStudent(){
  if(!staffState.selectedStudentId) return;
  try{
    var cq = staffState.activeCourseId ? "?courseId="+encodeURIComponent(staffState.activeCourseId) : "";
    var d = await api("/staff/students/"+staffState.selectedStudentId+cq);
    staffState.selectedStudent = d.student;
    staffState.selectedStudentEnrollments = d.enrollments || [];
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
    else if(studentState.tab === "lesson") g = "a";
    else g = "c"; // главная — курс, сертификат
  } else if(view === "staff"){
    if(staffState.mainTab === "calendar") g = "b";
    else if(staffState.mainTab === "dashboard") g = "c";
    else g = "a"; // ученики / материалы / команда / журнал — плотные таблицы
  }
  document.documentElement.setAttribute("data-glow", g);
}

// Входные анимации (кольца прогресса заполняются, числа отсчитываются от нуля):
// играют один раз, когда экран открыли, а НЕ при каждой перерисовке (приложение
// перерисовывается целиком, в т.ч. каждые 30с по опросу уведомлений). Ключ —
// экран + порядковый номер элемента; при переходе на другой экран сбрасывается.
// Разметка уже содержит итоговое значение, так что без JS/при reduced-motion
// просто показывается результат.
var lastRenderScreen = null;

// Кнопка «Назад» в браузере: приложение — SPA без pushState (см. комментарий про
// API/BASE_PATH в начале файла — путь URL никогда не меняется, чтобы не съезжало
// резолвление относительных ссылок), поэтому у вкладки была ровно одна запись в
// истории — «Назад» сразу уводил с сайта. Ниже пушим новую запись при каждом
// переходе на другой «экран» (URL остаётся тем же, меняется только state), а
// «Назад»/«Вперёд» восстанавливают состояние из этой записи вместо ухода с сайта.
// Внутришаговые вещи уровня урока (материал/видео/тест) и модалки сознательно не
// отслеживаются — история покрывает переходы между разделами/уроками/карточками.
var navHistoryReady = false, lastNavState = null, applyingNavState = false;
function navSnapshot(){
  return {
    view: view,
    studentTab: view==="student" ? studentState.tab : null,
    studentNavKey: view==="student" ? studentState.navKey : null,
    lessonIndex: (view==="student" && studentState.tab==="lesson") ? studentState.lessonIndex : null,
    quizMode: (view==="student" && studentState.tab==="lesson") ? !!studentState.quizMode : null,
    staffMainTab: view==="staff" ? staffState.mainTab : null,
    selectedStudentId: view==="staff" ? staffState.selectedStudentId : null,
    drawerTab: (view==="staff" && staffState.selectedStudentId) ? staffState.drawerTab : null,
    lessonPageId: (view==="staff" && staffState.mainTab==="materials") ? (staffState.lessonPageId||null) : null,
    lessonPageTab: (view==="staff" && staffState.mainTab==="materials" && staffState.lessonPageId) ? staffState.lessonPageTab : null,
    protocolId: (view==="staff" && staffState.mainTab==="protocols" && protocolEditor.open) ? (protocolEditor.id||"new") : null,
    glossaryId: (view==="staff" && staffState.mainTab==="glossary" && glossaryAdmin.edit) ? (glossaryAdmin.edit.id||"new") : null
  };
}
function navStatesEqual(a, b){
  if(!a || !b) return false;
  return a.view===b.view && a.studentTab===b.studentTab && a.lessonIndex===b.lessonIndex &&
    a.quizMode===b.quizMode && a.staffMainTab===b.staffMainTab &&
    a.selectedStudentId===b.selectedStudentId && a.drawerTab===b.drawerTab &&
    // Вкладки страницы урока в историю не пишутся — «Назад» ведёт к списку уроков.
    (a.lessonPageId||null)===(b.lessonPageId||null) && (a.protocolId||null)===(b.protocolId||null) && (a.glossaryId||null)===(b.glossaryId||null);
}
// Вызывается в конце каждого render() — навигационные переходы (клик по вкладке,
// открытие урока/карточки врача) естественным образом проходят через render(), а
// фоновые перерисовки (поллинг уведомлений раз в 30с) не меняют снимок — лишних
// записей в истории от них не будет.
// «Дно» истории — запись ДО входа в приложение (пустая вкладка или та страница,
// с которой сюда пришли) — обычно живёт в ДРУГОМ документе (другой URL), а переход
// между разными документами браузер делает напрямую, минуя popstate: перехватить
// его из JS нечем (наш скрипт к тому моменту уже выгружен). Поэтому одиночная
// запись-пол не спасает — рано или поздно «назад» до неё дойдёт и реально уведёт.
// Вместо этого держим на дне ДВЕ одинаковые записи (helpers ниже, "__floor"): пока
// их минимум одна, соседняя (тоже наш документ) всегда успевает поймать popstate
// и тут же подложить новую — так что фактически дойти до чужого документа нельзя,
// «назад» на дне просто топчется между двумя своими записями.
function syncNavHistory(){
  if(applyingNavState) return; // это состояние уже пришло из popstate — не пушим его же обратно
  if(view!=="student" && view!=="staff") return; // логин/регистрация/загрузка — не «место», куда стоит возвращаться
  var snap = navSnapshot();
  if(!navHistoryReady){
    history.replaceState(snap, "");
    var floor = Object.assign({}, snap, { __floor:true });
    history.pushState(floor, "");
    navHistoryReady = true; lastNavState = floor;
    return;
  }
  if(!navStatesEqual(snap, lastNavState)){
    history.pushState(snap, "");
    lastNavState = snap;
  }
}
// Общее для popstate и для восстановления после обновления страницы (F5) —
// раньше это было только внутри popstate, поэтому назад/вперёд помнили, где
// был врач, а обновление страницы всегда сбрасывало на главную: она просто
// не читалась заново при обычной перезагрузке, только при переходе по истории.
function applyNavState(s){
  view = s.view;
  if(s.view==="student"){
    studentState.tab = s.studentTab || "home";
    studentState.navKey = s.studentNavKey || studentState.tab;
    if(s.lessonIndex!=null){ studentState.lessonIndex = s.lessonIndex; }
    studentState.quizMode = !!s.quizMode;
    if(studentState.tab==="lesson") resetLessonStageState();
  } else if(s.view==="staff"){
    staffState.mainTab = s.staffMainTab || "students";
    if(staffState.mainTab==="modules") staffState.mainTab = "materials";
    staffState.navKey = staffState.mainTab;
    // Страница урока / протокола — часть записи истории («Назад» возвращает к списку).
    var nsLesson = staffState.mainTab==="materials" ? (s.lessonPageId||null) : null;
    if(nsLesson!==(staffState.lessonPageId||null) || (nsLesson && s.lessonPageTab!==staffState.lessonPageTab)){ lpCloseEditors(); lpAuto = { pending:null, fails:{} }; }
    staffState.lessonPageId = nsLesson;
    if(nsLesson) staffState.lessonPageTab = s.lessonPageTab || staffState.lessonPageTab;
    staffState.lsMenu = null;
    if(staffState.mainTab==="protocols" && s.protocolId){
      if(!protocolEditor.open || (protocolEditor.id||"new")!==s.protocolId){
        var nsP = s.protocolId==="new" ? null : (adminProtocolsState.list||[]).find(function(x){ return x.id===s.protocolId; });
        if(s.protocolId==="new") protocolEditor = { open:true, id:null, title:"", summary:"", guides:[], lessonIds:[] };
        else if(nsP) protocolEditor = { open:true, id:nsP.id, title:nsP.title, summary:nsP.summary||"", guides:nsP.guides.slice(), lessonIds:nsP.lessonIds.slice() };
        else protocolEditor.open = false;
      }
    } else if(protocolEditor.open){ protocolEditor.open = false; }
    // Страница термина: «Назад» из неё ведёт к списку (несохранённое — как при уходе из раздела).
    if(!(staffState.mainTab==="glossary" && s.glossaryId)){ glossaryAdmin.edit = null; glossaryAdmin.dirty = false; }
    else if(!glossaryAdmin.edit || (glossaryAdmin.edit.id||"new")!==s.glossaryId){
      var nsG = s.glossaryId==="new" ? null : glossaryAdmin.list.find(function(x){ return x.id===s.glossaryId; });
      glossaryAdmin.edit = (s.glossaryId==="new" || nsG) ? glDraft(nsG) : null; glossaryAdmin.dirty = false;
      glossaryAdmin.check = nsG ? (nsG.foundIn||[]) : [];
    }
    if(s.selectedStudentId){
      // Синхронная часть openStudentPage отработает до первого await ещё до
      // возврата сюда (JS однопоточный) — drawerTab можно проставить сразу после.
      if(!staffState.selectedStudent || staffState.selectedStudent.id!==s.selectedStudentId){
        openStudentPage(s.selectedStudentId);
      }
      staffState.drawerTab = s.drawerTab || "progress";
    } else {
      staffState.selectedStudentId = null;
    }
  }
}
window.addEventListener("popstate", function(e){
  var s = e.state;
  if(!s || (s.view!=="student" && s.view!=="staff")){
    // Тот редкий случай, когда всё же попали на невалидную запись в своём же
    // документе (а не ушли на другой) — подкладываем последнее известное состояние.
    if(navHistoryReady && lastNavState){ history.pushState(lastNavState, ""); }
    return;
  }
  applyingNavState = true;
  applyNavState(s);
  lastNavState = s;
  render();
  applyingNavState = false;
  if(s.__floor){
    // Долистали до дна — сразу подкладываем ещё одну такую же запись поверх,
    // чтобы дно снова было двухслойным и следующее «назад» опять поймалось
    // здесь же, а не ушло на документ до входа в приложение.
    var refloor = Object.assign({}, s);
    history.pushState(refloor, "");
    lastNavState = refloor;
  }
});
var animSeen = {}, animScreen = "", animTimers = [], animRun = 0;
// Поочерёдно: следующий элемент стартует, когда закончился предыдущий (порядок —
// как на экране). Пока ждёт очереди, стоит на нуле. Процент внутри кольца идёт
// вместе со своим кольцом (один шаг).
var ANIM_RING_MS = 2000, ANIM_COUNT_MS = 1500;
function animateCount(elc, dur, onDone){
  var target = parseInt(elc.getAttribute("data-count"), 10);
  var suffix = elc.getAttribute("data-suffix") || "", start = null;
  if(!(target > 0)){ elc.textContent = target+suffix; if(onDone) onDone(); return; }
  function step(ts){
    if(!elc.isConnected) return;
    if(start===null) start = ts;
    // мягкое замедление (ease-out quad) — та же кривая, что у кольца
    var t = Math.min(1, (ts-start)/dur), eased = 1 - Math.pow(1-t, 2);
    elc.textContent = Math.round(target*eased)+suffix;
    if(t < 1) requestAnimationFrame(step); else if(onDone) onDone();
  }
  requestAnimationFrame(step);
}
function runEntranceAnimations(){
  var screen = view+"|"+(view==="student" ? studentState.tab : (view==="staff" ? staffState.mainTab : ""))+"|"+(activeCourseId||staffState.activeCourseId||"");
  if(screen !== animScreen){ animSeen = {}; animScreen = screen; }
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.getElementById("app");
  var steps = [];
  root.querySelectorAll('[data-anim="ring"], [data-count]').forEach(function(elx, i){
    if(elx.hasAttribute("data-count") && elx.closest('[data-anim="ring"]')) return; // идёт со своим кольцом
    var key = (elx.hasAttribute("data-count") ? "count" : "ring")+i;
    if(animSeen[key]) return;
    animSeen[key] = true;
    if(!reduce) steps.push(elx);
  });
  if(!steps.length) return;
  animTimers.forEach(clearTimeout); animTimers = [];
  // исходное состояние — всё на нуле
  steps.forEach(function(elx){
    if(elx.getAttribute("data-anim")==="ring"){
      elx.setAttribute("data-ring-target", elx.style.getPropertyValue("--ring-p"));
      elx.style.setProperty("--ring-p", "0%");
      elx.querySelectorAll("[data-count]").forEach(function(c){ c.textContent = "0"+(c.getAttribute("data-suffix")||""); });
    } else if(parseInt(elx.getAttribute("data-count"),10) > 0){
      // Ширина итогового числа держится с начала отсчёта: иначе «0» → «45» делает
      // число шире, подпись рядом переносится, и плитка прыгает по высоте.
      var cw = elx.getBoundingClientRect().width;
      if(cw){
        if(getComputedStyle(elx).display==="inline") elx.style.display = "inline-block";
        elx.style.minWidth = cw+"px";
      }
      elx.textContent = "0"+(elx.getAttribute("data-suffix")||"");
    }
  });
  // Цепочка по фактическому окончанию шага (а не по таймеру): CSS-анимация кольца
  // может стартовать на кадр позже, и таймер тогда давал бы наложение.
  var runId = ++animRun;
  function runStep(idx){
    if(runId !== animRun || idx >= steps.length) return;
    var elx = steps[idx], next = function(){ runStep(idx+1); };
    if(!elx.isConnected) return;
    if(elx.getAttribute("data-anim")==="ring"){
      elx.style.setProperty("--ring-p", elx.getAttribute("data-ring-target"));
      elx.classList.add("ring-fill");
      var inner = elx.querySelector("[data-count]"), suffix = inner ? (inner.getAttribute("data-suffix")||"") : "";
      var finished = false, done = function(){ if(finished) return; finished = true; if(inner) inner.textContent = inner.getAttribute("data-count")+suffix; next(); };
      elx.addEventListener("animationend", done, { once:true });
      animTimers.push(setTimeout(done, ANIM_RING_MS + 400)); // страховка
      // Цифра внутри кольца читает текущее заполнение самого кольца — идут строго вместе.
      (function tick(){
        if(finished || !elx.isConnected) return;
        // Кольцо заполняется в процентах, а внутри может быть и количество
        // (например, «1 протокол» при 25%) — пересчитываем пропорционально.
        if(inner){
          var cur = parseFloat(getComputedStyle(elx).getPropertyValue("--ring-p")) || 0;
          var tgt = parseFloat(elx.getAttribute("data-ring-target")) || 0;
          var cnt = parseFloat(inner.getAttribute("data-count")) || 0;
          inner.textContent = (tgt > 0 ? Math.round(cnt * Math.min(1, cur / tgt)) : cnt) + suffix;
        }
        requestAnimationFrame(tick);
      })();
    } else {
      animateCount(elx, ANIM_COUNT_MS, next);
    }
  }
  runStep(0);
}

/* ============================= ВЫДЕЛЕНИЕ ТЕКСТА В УРОКЕ ============================= */
// Врач выделяет фрагмент урока — над ним появляется панель: маркер (сохраняется
// и подсвечивается при следующих открытиях), в заметку, спросить куратора,
// найти в курсе, копировать. Панель живёт в body (вне #app), render() её закрывает.
var selTools = null; // { el, text, hid }

function hlNormalize(s){ return String(s||"").replace(/\s+/g, " ").trim(); }
function hlBlockOf(n){
  var e = n.parentElement;
  while(e && !/^(P|LI|H[1-6]|DIV|BLOCKQUOTE|TD|TH|PRE|UL|OL|SECTION|ARTICLE)$/.test(e.tagName)) e = e.parentElement;
  return e;
}
// Текст урока одной строкой (пробелы схлопнуты, между блоками — пробел) и карта
// «символ строки → (текстовый узел, смещение)», чтобы найти фрагмент, даже если
// он пересекает <b>, <i> или границу абзаца.
function hlIndex(root){
  var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), full = "", map = [], n, prevSpace = true, prevBlock = null;
  while((n = w.nextNode())){
    if(n.parentElement && n.parentElement.closest("mark.hl-skip, script, style")) continue;
    var blk = hlBlockOf(n);
    if(prevBlock && blk !== prevBlock && !prevSpace){ full += " "; map.push(null); prevSpace = true; }
    prevBlock = blk;
    var t = n.nodeValue;
    for(var i=0;i<t.length;i++){
      if(/\s/.test(t[i])){ if(prevSpace) continue; full += " "; map.push([n,i]); prevSpace = true; }
      else { full += t[i]; map.push([n,i]); prevSpace = false; }
    }
  }
  return { full:full, map:map };
}
function hlWrap(root, h){
  var ix = hlIndex(root), at = ix.full.indexOf(h.text);
  if(at === -1) return false; // текст урока изменили — фрагмента больше нет
  var spans = [], cur = null;
  for(var k=at; k<at+h.text.length; k++){
    var m = ix.map[k]; if(!m) continue;
    if(cur && cur.node === m[0]) cur.end = m[1]+1;
    else { cur = { node:m[0], start:m[1], end:m[1]+1 }; spans.push(cur); }
  }
  // с конца, чтобы разрезание узлов не сдвигало ещё не обработанные смещения
  spans.reverse().forEach(function(sp){
    var node = sp.node;
    if(sp.end < node.nodeValue.length) node.splitText(sp.end);
    var mid = sp.start > 0 ? node.splitText(sp.start) : node;
    var mk = document.createElement("mark"); mk.className = "hl"; mk.setAttribute("data-hid", h.id);
    mid.parentNode.insertBefore(mk, mid); mk.appendChild(mid);
  });
  return true;
}

/* ============================= ГЛОССАРИЙ: термины в тексте урока ============================= */
// Термины курса (src/content-glossary.js) подсвечиваются в тексте урока; по клику —
// статья в боковой панели. В «своём» уроке термина (lessonId) подсветка есть всегда,
// в остальных — пока врач ещё не открывал эту статью (glossary.seen). Термин,
// подсвеченный при открытии урока, остаётся подсвеченным до ухода из урока, даже
// если врач по нему кликнул (glossary.keep) — чтобы текст не «мигал».
var glossary = { courseId:null, loading:false, terms:[], seen:{}, open:null, tab:"brief", keep:{}, keepLesson:null };
function glossaryCourseId(){ return previewMode ? staffState.activeCourseId : activeCourseId; }
function ensureGlossary(){
  var cid = glossaryCourseId();
  if(!cid || glossary.courseId===cid || glossary.loading) return;
  glossary.loading = true;
  api("/glossary?courseId="+encodeURIComponent(cid)).then(function(d){
    glossary.courseId = cid; glossary.terms = d.terms || []; glossary.seen = {};
    (d.seen||[]).forEach(function(id){ glossary.seen[id] = true; });
    glossary.loading = false;
    if(document.getElementById("lessonProse")) applyGlossaryTerms();
  }).catch(function(){ glossary.loading = false; glossary.courseId = cid; });
}
function glEscape(x){ return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Поиск по всем написаниям термина: целым словом; аббревиатуры (ПСА, МГТ) — с учётом регистра.
function glMatchers(term){
  return (term.aliases||[]).slice().sort(function(a,b){ return b.length - a.length; }).map(function(a){
    var caps = a.length<=5 && a===a.toUpperCase() && /[A-ZА-ЯЁ]/.test(a);
    return new RegExp("(^|[^A-Za-zА-Яа-яЁё0-9])("+glEscape(a)+")(?![A-Za-zА-Яа-яЁё0-9])", caps ? "" : "i");
  });
}
function glossaryTermsForLesson(lesson){
  if(glossary.keepLesson!==lesson.id){ glossary.keep = {}; glossary.keepLesson = lesson.id; }
  return glossary.terms.filter(function(t){
    return t.lessonId===lesson.id || !glossary.seen[t.id] || glossary.keep[t.id];
  });
}
function applyGlossaryTerms(){
  var prose = document.getElementById("lessonProse");
  if(!prose || !course || !course.lessons) return;
  ensureGlossary();
  var lesson = course.lessons.find(function(l){ return l.id===prose.getAttribute("data-lesson-id"); });
  if(!lesson || !glossary.terms.length || prose.querySelector(".gl-term")) return;
  glossaryTermsForLesson(lesson).forEach(function(term){
    var ms = glMatchers(term);
    var w = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, null), n;
    while((n = w.nextNode())){
      if(n.parentElement.closest(".gl-term, a, button")) continue;
      var best = null;
      ms.forEach(function(re){
        var m = re.exec(n.nodeValue);
        if(m){ var at = m.index + m[1].length; if(!best || at < best.at) best = { at:at, len:m[2].length }; }
      });
      if(!best) continue;
      var mid = n.splitText(best.at); mid.splitText(best.len);
      var sp = document.createElement("span");
      sp.className = "gl-term"; sp.setAttribute("data-action", "open-term"); sp.setAttribute("data-id", term.id);
      sp.setAttribute("role", "button"); sp.setAttribute("tabindex", "0"); sp.title = "Что это: «"+term.title+"»";
      mid.parentNode.insertBefore(sp, mid); sp.appendChild(mid);
      glossary.keep[term.id] = true;
      break; // только первое упоминание в уроке
    }
  });
}
function openGlossaryTerm(id){
  var term = glossary.terms.find(function(t){ return t.id===id; });
  if(!term) return;
  glossary.open = id; glossary.tab = "brief";
  if(view==="student" && !previewMode && !glossary.seen[id]){
    glossary.seen[id] = true;
    api("/glossary/"+encodeURIComponent(id)+"/seen", { method:"POST" }).catch(function(){});
  }
  render();
}
function glossaryLessonsWith(term){
  var ms = glMatchers(term);
  return (course && course.lessons || []).map(function(l, i){
    var text = (l.html||"").replace(/<[^>]+>/g, " ");
    return ms.some(function(re){ return re.test(text); }) ? { l:l, i:i } : null;
  }).filter(Boolean);
}
var GL_TONES = { ok:"#9C86FF", warn:"#FF8FA3", bad:"#FF4D6D" };
// Статья термина — общая для панели врача и предпросмотра в разделе «Термины».
// opts.courseRows — строки вкладки «В курсе» (у врача — уроки с текстом, у персонала — foundIn).
function glossaryArticleHtml(term, tab, opts){
  opts = opts || {};
  var b = term.body || {}, more = b.more || [];
  var tabs = [["brief","Кратко"]].concat(more.length ? [["more","Подробнее"]] : [], opts.noCourseTab ? [] : [["course","В курсе"]]);
  if(!tabs.some(function(t){ return t[0]===tab; })) tab = "brief";
  var html = '<span class="gl-cat">Термин курса'+(term.category ? ' · '+escapeHtml(term.category) : '')+'</span>' +
    '<h2 class="gl-title">'+escapeHtml(term.title||"Без названия")+'</h2>' +
    (term.lead ? '<p class="gl-lead">'+escapeHtml(term.lead)+'</p>' : '') +
    '<div class="gl-tabs" role="tablist">'+tabs.map(function(t){ return '<button type="button" role="tab" class="'+(t[0]===tab?'on':'')+'" data-action="'+(opts.tabAction||"term-tab")+'" data-tab="'+t[0]+'">'+t[1]+'</button>'; }).join('')+'</div>';
  if(tab==="brief"){
    if(b.key && b.key.text){
      html += '<div class="gl-hero">'+(b.key.label ? '<span class="gl-badge">'+escapeHtml(b.key.label)+'</span>' : '')+'<b>'+escapeHtml(b.key.text)+'</b>' +
        ((b.key.scale||[]).length ? '<div class="gl-scale" style="grid-template-columns:repeat('+b.key.scale.length+',minmax(0,1fr));">'+b.key.scale.map(function(sc){
          return '<div><i style="background:'+(GL_TONES[sc[2]]||GL_TONES.ok)+'"></i><b>'+escapeHtml(sc[0]||"")+'</b>'+escapeHtml(sc[1]||"")+'</div>';
        }).join('')+'</div>' : '') + '</div>';
    }
    if(b.meaning && (b.meaning.text || (b.meaning.stats||[]).length)){
      html += '<div class="gl-card"><h5>Что это означает?</h5>'+(b.meaning.text ? '<p>'+escapeHtml(b.meaning.text)+'</p>' : '') +
        ((b.meaning.stats||[]).length ? '<div class="gl-stat">'+b.meaning.stats.map(function(st){ return '<div><b>'+escapeHtml(st[0]||"")+'</b><span>'+escapeHtml(st[1]||"")+'</span></div>'; }).join('')+'</div>' : '') + '</div>';
    }
    if((b.actions||[]).length){
      html += '<div class="gl-h">Что делать врачу?</div>' + b.actions.map(function(ac){
        return '<div class="gl-act"><span class="gl-ic">'+icon(ac[0]||"check")+'</span><div><b>'+escapeHtml(ac[1]||"")+'</b>'+(ac[2]?'<span>'+escapeHtml(ac[2])+'</span>':'')+'</div></div>';
      }).join('');
    }
  } else if(tab==="more"){
    html += more.map(function(m){ return '<div class="gl-card"><h5>'+escapeHtml(m[0]||"")+'</h5><p>'+escapeHtml(m[1]||"")+'</p></div>'; }).join('');
  } else {
    var rows = opts.courseRows || [];
    html += '<div class="gl-card"><h5>Где встречается в курсе</h5>' + (rows.length ? rows.map(function(r){
      return '<div class="gl-link'+(r.locked?' locked':'')+'"'+(r.locked||r.here ? '' : ' data-action="term-goto-lesson" data-idx="'+r.i+'"')+'>' +
        '<i>Урок '+(r.i+1)+'</i><span>'+escapeHtml(r.title)+'</span>' +
        '<em>'+(r.here ? 'вы здесь' : (r.locked ? icon("lock","ic-sm") : 'Открыть →'))+'</em></div>';
    }).join('') : '<p>Пока только в этом уроке.</p>') + '</div>';
  }
  return html;
}
function renderGlossaryPanel(){
  var term = glossary.terms.find(function(t){ return t.id===glossary.open; });
  if(!term) return el('<div></div>');
  var here = course && course.lessons[studentState.lessonIndex];
  var rows = glossaryLessonsWith(term).map(function(r){
    return { i:r.i, title:r.l.title, locked: r.l.hiddenForMe || r.l.dripLockedForMe, here: here && here.id===r.l.id };
  });
  var html = '<button type="button" class="gl-x" data-action="close-term" aria-label="Закрыть">'+icon("close","ic-sm")+'</button>' +
    glossaryArticleHtml(term, glossary.tab, { courseRows: rows });
  return el('<div class="overlay gl-overlay" data-action="overlay-close-term"><aside class="drawer gl-panel" data-stop="1" role="dialog" aria-label="'+escapeHtml(term.title)+'">'+html+'</aside></div>');
}

function applyLessonHighlights(){
  var prose = document.getElementById("lessonProse");
  if(!prose || !course || !course.progress) return;
  prose.querySelectorAll("mark.hl").forEach(function(m){ var p = m.parentNode; while(m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); });
  var list = ((course.progress.lesson_highlights||{})[prose.getAttribute("data-lesson-id")]) || [];
  list.forEach(function(h){ hlWrap(prose, h); });
}

function closeSelTools(){ if(selTools){ selTools.el.remove(); selTools = null; } }
function selLessonCtx(){
  var l = course && course.lessons[studentState.lessonIndex];
  return l ? { id:l.id, n:studentState.lessonIndex+1, title:l.title } : null;
}
function openSelTools(rect, text, hid){
  closeSelTools();
  var btn = function(act, ic, label){ return '<button type="button" data-sel-action="'+act+'">'+icon(ic,"ic-sm")+'<span>'+label+'</span></button>'; };
  var html = '<div class="sel-tools" role="toolbar" aria-label="Действия с выделенным">' +
    (hid ? btn("unmark","close","Убрать маркер") : (previewMode ? '' : btn("mark","star","Маркер"))) +
    (previewMode ? '' : btn("note","list","В заметку")) +
    btn("ask","message","Спросить куратора") +
    btn("search","search","Найти в курсе") +
    btn("copy","clipboard","Копировать") + '</div>';
  var el2 = el(html); document.body.appendChild(el2);
  selTools = { el:el2, text:text, hid:hid||null };
  // над выделением; если не помещается — под ним. На сенсорных экранах сверху
  // висит системное меню выделения — ставим панель снизу.
  var w = el2.offsetWidth, h = el2.offsetHeight, coarse = window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
  var top = coarse ? rect.bottom + 10 : rect.top - h - 10;
  if(top < 8) top = rect.bottom + 10;
  if(top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 10);
  // выделение частично за краем экрана — панель всё равно остаётся видимой
  top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
  var left = Math.min(Math.max(8, rect.left + rect.width/2 - w/2), window.innerWidth - w - 8);
  el2.style.top = top + "px"; el2.style.left = left + "px";
  el2.addEventListener("mousedown", function(e){ e.preventDefault(); }); // не снимать выделение кликом по панели
  el2.addEventListener("click", function(e){
    var b = e.target.closest("[data-sel-action]"); if(b) runSelAction(b.getAttribute("data-sel-action"));
  });
}
function selCheck(){
  var prose = document.getElementById("lessonProse");
  var sel = window.getSelection && window.getSelection();
  if(!prose || !sel || sel.isCollapsed || !sel.rangeCount){ if(selTools && !selTools.hid) closeSelTools(); return; }
  var r = sel.getRangeAt(0);
  if(!prose.contains(r.commonAncestorContainer)){ if(selTools && !selTools.hid) closeSelTools(); return; }
  var text = hlNormalize(sel.toString());
  if(text.length < 2){ closeSelTools(); return; }
  openSelTools(r.getBoundingClientRect(), text, null);
}
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }
  catch(e){
    var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    var ok = false; try{ ok = document.execCommand("copy"); }catch(e2){} ta.remove(); return ok;
  }
}
async function runSelAction(act){
  if(!selTools) return;
  var text = selTools.text, hid = selTools.hid, ctx = selLessonCtx();
  var clearSel = function(){ var s = window.getSelection && window.getSelection(); if(s) s.removeAllRanges(); closeSelTools(); };
  if(!ctx){ clearSel(); return; }
  var src = "урок "+ctx.n+" «"+ctx.title+"»";
  if(act==="mark"){
    clearSel();
    try{
      var r = await api("/course/lessons/"+ctx.id+"/highlights", { method:"POST", body: JSON.stringify({ text:text }) });
      if(!course.progress.lesson_highlights) course.progress.lesson_highlights = {};
      course.progress.lesson_highlights[ctx.id] = r.highlights;
      applyLessonHighlights();
      showToast("Выделено — останется при следующем открытии урока");
    }catch(err){ showToast(err.message); }
    return;
  }
  if(act==="unmark"){
    closeSelTools();
    try{
      var r2 = await api("/course/lessons/"+ctx.id+"/highlights/"+encodeURIComponent(hid), { method:"DELETE" });
      course.progress.lesson_highlights[ctx.id] = r2.highlights;
      applyLessonHighlights();
    }catch(err){ showToast(err.message); }
    return;
  }
  if(act==="note"){
    clearSel();
    var ta = document.getElementById("lessonNoteInput");
    var prev = ta ? ta.value : ((course.progress.lesson_notes||{})[ctx.id] || "");
    var next = (prev.trim() ? prev.replace(/\s+$/,"") + "\n\n" : "") + "«" + text + "»\n";
    try{
      await api("/course/lessons/"+ctx.id+"/note", { method:"PUT", body: JSON.stringify({ note: next }) });
      if(!course.progress.lesson_notes) course.progress.lesson_notes = {};
      course.progress.lesson_notes[ctx.id] = next.trim();
      if(ta){ ta.value = next; ta.defaultValue = next; ta.scrollIntoView({ behavior:"smooth", block:"center" }); ta.classList.add("flash"); setTimeout(function(){ ta.classList.remove("flash"); }, 1200); }
      showToast("Добавлено в заметку к уроку");
    }catch(err){ showToast(err.message); }
    return;
  }
  if(act==="ask"){
    clearSel();
    var msg = "Вопрос по уроку " + ctx.n + " «" + ctx.title + "»:\n«" + text + "»\n\n";
    var copied = await copyText(msg);
    var stream = me && me.stream_id ? (calendarState.streams||[]).find(function(s){ return s.id===me.stream_id; }) : null;
    if(stream && stream.telegram_url){
      window.open(stream.telegram_url, "_blank", "noopener");
      showToast(copied ? "Цитата скопирована — вставьте её в чат потока и допишите вопрос" : "Откройте чат потока и задайте вопрос");
    } else {
      showToast(copied ? "Цитата с вопросом скопирована — отправьте её куратору" : "Не удалось скопировать");
    }
    return;
  }
  if(act==="search"){
    clearSel();
    studentState.materialsSearch = text.length > 80 ? text.slice(0, 80) : text;
    studentState.materialsAutoFocus = false;
    await applyStudentTab("materials", "materials");
    return;
  }
  if(act==="copy"){
    clearSel();
    var ok = await copyText("«" + text + "»\n— " + src + (course.course ? ", курс «" + course.course.title + "»" : ""));
    showToast(ok ? "Скопировано вместе с источником" : "Не удалось скопировать");
  }
}
// Выделение мышью — по отпусканию кнопки; с клавиатуры и на сенсорных экранах —
// по selectionchange (с задержкой, пока пользователь тянет границы).
var selCheckTimer = null;
document.addEventListener("mouseup", function(e){
  if(e.target.closest && e.target.closest(".sel-tools")) return;
  var mk = e.target.closest && e.target.closest("#lessonProse mark.hl");
  var sel = window.getSelection && window.getSelection();
  if(mk && sel && sel.isCollapsed){
    var ctx = selLessonCtx(), hid = mk.getAttribute("data-hid");
    var h = ctx && ((course.progress.lesson_highlights||{})[ctx.id]||[]).find(function(x){ return x.id===hid; });
    if(h) openSelTools(mk.getBoundingClientRect(), h.text, hid);
    return;
  }
  if(selTools && selTools.hid) closeSelTools();
  setTimeout(selCheck, 0);
});
document.addEventListener("selectionchange", function(){
  clearTimeout(selCheckTimer);
  selCheckTimer = setTimeout(function(){ if(!(selTools && selTools.hid)) selCheck(); }, 350);
});
document.addEventListener("keydown", function(e){ if(e.key==="Escape") closeSelTools(); });
window.addEventListener("scroll", function(){ closeSelTools(); }, { passive:true, capture:true });

// Отклик карточек на курсор: координаты для подсветки рамки (.board-strip > .card).
document.addEventListener("pointermove", function(e){
  var c = e.target && e.target.closest && e.target.closest(".card");
  if(!c) return;
  var r = c.getBoundingClientRect();
  c.style.setProperty("--mx", (e.clientX - r.left)+"px");
  c.style.setProperty("--my", (e.clientY - r.top)+"px");
  // «Живой свет» на главной: наклон плитки навстречу курсору (±2.5°)
  if(c.closest(".home-grid.fx-light, .staff-home.fx-light") && !c.classList.contains("course-hero")){
    c.style.setProperty("--tx", (((e.clientY - r.top)/r.height - .5) * -5).toFixed(2)+"deg");
    c.style.setProperty("--ty", (((e.clientX - r.left)/r.width - .5) * 5).toFixed(2)+"deg");
  }
}, { passive:true });
// Свет за стеклом (вариант «Живой свет») следует за курсором по всей сетке главной.
var fxLightRaf = 0;
document.addEventListener("pointermove", function(e){
  if(fxLightRaf) return;
  fxLightRaf = requestAnimationFrame(function(){
    fxLightRaf = 0;
    var g = document.querySelector(".home-grid.fx-light, .staff-home.fx-light"); if(!g) return;
    var r = g.getBoundingClientRect();
    g.style.setProperty("--lx", Math.max(-10, Math.min(110, (e.clientX - r.left)/r.width*100)).toFixed(1)+"%");
    g.style.setProperty("--ly", Math.max(-10, Math.min(110, (e.clientY - r.top)/r.height*100)).toFixed(1)+"%");
    // Свет «фонариком» по стеклу: координаты курсора — в каждую плитку, а не
    // только в ту, что под ним, — рамки соседних плиток ловят край света.
    g.querySelectorAll(".board-tile, .home-next, .staff-home .card").forEach(function(c){
      var cr = c.getBoundingClientRect();
      c.style.setProperty("--mx", (e.clientX - cr.left)+"px");
      c.style.setProperty("--my", (e.clientY - cr.top)+"px");
    });
  });
}, { passive:true });


/* ============================= КАЛЕНДАРЬ ДЛЯ ПОЛЕЙ ДАТЫ ============================= */
// Системный выпадающий календарь браузера стилями не перекрасить, поэтому для всех
// <input type="date"> открываем свой — в стиле платформы. Само поле остаётся
// нативным (значение YYYY-MM-DD, ввод с клавиатуры, отправка форм, обработчики
// change/input работают как раньше): календарь лишь подставляет дату и шлёт те же
// события. Закрывается при перерисовке приложения (см. render()).
var datePop = null;
var DP_MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
function dpIso(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function dpParse(v){ var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v||""); return m ? new Date(+m[1], +m[2]-1, +m[3]) : null; }
function closeDatePicker(){ if(datePop){ datePop.el.remove(); datePop = null; } }
function setDateValue(input, v){
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles:true }));
  input.dispatchEvent(new Event("change", { bubbles:true }));
}
function renderDatePicker(){
  var st = datePop, input = st.input, sel = dpParse(input.value), today = new Date(); today.setHours(0,0,0,0);
  var min = dpParse(input.min), max = dpParse(input.max);
  var y = st.view.getFullYear(), m = st.view.getMonth();
  var first = new Date(y, m, 1), shift = (first.getDay()+6)%7, start = new Date(y, m, 1-shift);
  var h = '<div class="dp-head"><button type="button" class="dp-nav" data-dp="prev" aria-label="Предыдущий месяц">‹</button>' +
    '<b>'+DP_MONTHS[m]+' '+y+'</b><button type="button" class="dp-nav" data-dp="next" aria-label="Следующий месяц">›</button></div><div class="dp-grid">';
  ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].forEach(function(w){ h += '<span class="dp-wd">'+w+'</span>'; });
  for(var i=0;i<42;i++){
    var d = new Date(start); d.setDate(start.getDate()+i);
    var off = (min && d<min) || (max && d>max);
    h += '<button type="button" class="dp-day'+(d.getMonth()!==m?' out':'')+(+d===+today?' today':'')+(sel && +d===+sel?' sel':'')+'"'+(off?' disabled':'')+' data-dp="day" data-v="'+dpIso(d)+'">'+d.getDate()+'</button>';
  }
  h += '</div><div class="dp-foot"><button type="button" class="dp-link" data-dp="clear">Очистить</button><button type="button" class="dp-link" data-dp="today">Сегодня</button></div>';
  st.el.innerHTML = h;
}
function placeDatePicker(){
  var r = datePop.input.getBoundingClientRect(), el = datePop.el, w = el.offsetWidth, hgt = el.offsetHeight;
  var top = r.bottom + 6; if(top + hgt > window.innerHeight - 8 && r.top - hgt - 6 > 8) top = r.top - hgt - 6;
  var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  el.style.top = top+"px"; el.style.left = left+"px";
}
function openDatePicker(input){
  if(datePop && datePop.input === input){ closeDatePicker(); return; }
  closeDatePicker();
  var el = document.createElement("div"); el.className = "dp-pop"; el.setAttribute("role","dialog");
  document.body.appendChild(el);
  datePop = { el:el, input:input, view: dpParse(input.value) || new Date() };
  datePop.view = new Date(datePop.view.getFullYear(), datePop.view.getMonth(), 1);
  renderDatePicker(); placeDatePicker();
  el.addEventListener("mousedown", function(e){ e.preventDefault(); });  // фокус остаётся в поле
  el.addEventListener("click", function(e){
    var b = e.target.closest("[data-dp]"); if(!b || !datePop) return;
    var a = b.getAttribute("data-dp"), inp = datePop.input;
    if(a==="prev" || a==="next"){ datePop.view.setMonth(datePop.view.getMonth() + (a==="prev"?-1:1)); renderDatePicker(); placeDatePicker(); return; }
    if(a==="day"){ closeDatePicker(); setDateValue(inp, b.getAttribute("data-v")); return; }
    if(a==="today"){ closeDatePicker(); setDateValue(inp, dpIso(new Date())); return; }
    if(a==="clear"){ closeDatePicker(); setDateValue(inp, ""); return; }
  });
}
document.addEventListener("click", function(e){
  var inp = e.target.closest && e.target.closest('input[type="date"]');
  if(inp && !inp.disabled && !inp.readOnly){ e.preventDefault(); openDatePicker(inp); return; }
  if(datePop && !e.target.closest(".dp-pop")) closeDatePicker();
}, true);
document.addEventListener("keydown", function(e){
  if(!datePop) return;
  if(e.key==="Escape"){ closeDatePicker(); }
  else if(e.target === datePop.input && e.key!=="Tab") { /* ручной ввод — календарь не мешает */ }
  else if(e.key==="Tab") closeDatePicker();
}, true);
window.addEventListener("resize", function(){ if(datePop) placeDatePicker(); });
window.addEventListener("scroll", function(){ if(datePop) placeDatePicker(); }, true);


/* ============================= ВЫПАДАЮЩИЕ СПИСКИ ============================= */
// Системный список опций <select> стилями не перекрасить (синяя подсветка,
// системный шрифт), поэтому по клику открываем свой — в стиле платформы. Сам
// <select> остаётся нативным: значение, формы, клавиатура (стрелки) и
// обработчики change работают как раньше; список лишь выставляет value и шлёт
// те же события. Закрывается при перерисовке приложения (см. render()).
var selPop = null;
function closeSelectPop(){ if(selPop){ selPop.el.remove(); selPop = null; } }
function placeSelectPop(){
  var r = selPop.sel.getBoundingClientRect(), el = selPop.el;
  el.style.minWidth = r.width+"px";
  var h = el.offsetHeight, w = el.offsetWidth;
  var top = r.bottom + 6; if(top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
  el.style.top = top+"px"; el.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)+"px";
}
function openSelectPop(sel){
  if(selPop && selPop.sel === sel){ closeSelectPop(); return; }
  closeSelectPop(); closeDatePicker();
  var el = document.createElement("div"); el.className = "sel-pop"; el.setAttribute("role","listbox");
  function opt(o){
    if(o.hidden) return '';
    return '<button type="button" class="sel-opt'+(o.selected?' on':'')+'"'+(o.disabled?' disabled':'')+' data-i="'+o.index+'">' +
      '<span>'+escapeHtml(o.textContent)+'</span>'+(o.selected?icon("check","ic-sm"):'')+'</button>';
  }
  var h = '';
  Array.prototype.forEach.call(sel.children, function(node){
    if(node.tagName==="OPTGROUP"){ h += '<div class="sel-group">'+escapeHtml(node.label)+'</div>'; Array.prototype.forEach.call(node.children, function(o){ h += opt(o); }); }
    else h += opt(node);
  });
  el.innerHTML = h;
  document.body.appendChild(el);
  selPop = { el:el, sel:sel };
  placeSelectPop();
  var cur = el.querySelector(".sel-opt.on"); if(cur) cur.scrollIntoView({ block:"nearest" });
  el.addEventListener("mousedown", function(e){ e.preventDefault(); });
  el.addEventListener("click", function(e){
    var b = e.target.closest(".sel-opt"); if(!b || b.disabled || !selPop) return;
    var target = selPop.sel, i = +b.getAttribute("data-i");
    closeSelectPop();
    if(target.selectedIndex !== i){
      target.selectedIndex = i;
      target.dispatchEvent(new Event("input", { bubbles:true }));
      target.dispatchEvent(new Event("change", { bubbles:true }));
    }
  });
}
document.addEventListener("mousedown", function(e){
  var sel = e.target.closest && e.target.closest("select");
  if(sel && !sel.multiple && !(sel.size>1) && !sel.disabled && e.button===0){ e.preventDefault(); sel.focus(); openSelectPop(sel); return; }
  if(selPop && !e.target.closest(".sel-pop")) closeSelectPop();
}, true);
document.addEventListener("keydown", function(e){ if(selPop && (e.key==="Escape" || e.key==="Tab")) closeSelectPop(); }, true);
window.addEventListener("resize", function(){ if(selPop) placeSelectPop(); });
window.addEventListener("scroll", function(e){ if(selPop && !(e.target.closest && e.target.closest(".sel-pop"))) placeSelectPop(); }, true);

// Страница врача: из списка, из ленты и после возврата из его кабинета.
async function openStudentPage(id){
  staffState.selectedStudentId=id; staffState.drawerTab="progress"; staffState.selectedStudent=null; staffState.notes=[]; toolsState.studentAssign=[]; render(); window.scrollTo(0,0);
  try{
    var cqOpen=staffState.activeCourseId?"?courseId="+encodeURIComponent(staffState.activeCourseId):"";
    var d=await api("/staff/students/"+staffState.selectedStudentId+cqOpen);
    staffState.selectedStudent=d.student;
    staffState.selectedStudentEnrollments=d.enrollments||[];
    staffState.editSpecializationIds=(d.student.specialization_ids||[]).slice();
    staffState.editName=d.student.name||""; staffState.editPhone=d.student.phone||""; staffState.editWorkplace=d.student.workplace||"";
    render();
  }catch(err){ showToast(err.message); }
}

var stillTimer = null;

// Сайдбар не пересоздаётся при перерисовке: тот же элемент остаётся в документе,
// меняются только изменившиеся части. Иначе новый сайдбар на мгновение терял
// :hover — меню схлопывалось, и вся страница уезжала влево и обратно.
function syncNode(oldEl, newEl, depth){
  if(oldEl.outerHTML === newEl.outerHTML) return;
  if(oldEl.tagName !== newEl.tagName || depth > 2 || oldEl.children.length !== newEl.children.length || !oldEl.children.length){
    oldEl.replaceWith(newEl); return;
  }
  [].slice.call(oldEl.attributes).forEach(function(a){ if(!newEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name); });
  [].slice.call(newEl.attributes).forEach(function(a){ if(oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value); });
  var oc = [].slice.call(oldEl.children), nc = [].slice.call(newEl.children);
  oc.forEach(function(o, i){ syncNode(o, nc[i], depth+1); });
}
function mountKeepingSidebar(app, node){
  var oldWrap = app.firstElementChild;
  var oldSb = oldWrap && oldWrap.querySelector(":scope > .sidebar");
  var newSb = node.querySelector && node.querySelector(":scope > .sidebar");
  if(!oldSb || !newSb){ app.innerHTML = ""; app.appendChild(node); return; }
  [].slice.call(app.childNodes).forEach(function(c){ if(c !== oldWrap) c.remove(); });
  [].slice.call(oldWrap.childNodes).forEach(function(c){ if(c !== oldSb) c.remove(); });
  var before = true;
  [].slice.call(node.childNodes).forEach(function(k){
    if(k === newSb){ before = false; return; }
    if(before) oldWrap.insertBefore(k, oldSb); else oldWrap.appendChild(k);
  });
  // Сначала сам контейнер (классы, например mobile-open), затем содержимое.
  if(oldSb.className !== newSb.className) oldSb.className = newSb.className;
  syncNode(oldSb, newSb, 0);
}

function render(){
  var app = document.getElementById("app");
  if(!app) return;
  closeDatePicker();
  closeSelectPop();
  closeSelTools();
  // render() полностью пересобирает DOM (app.innerHTML="") и вызывается очень часто
  // по совершенно не связанным с уроком причинам — например, поллинг уведомлений
  // каждые 30с (см. startNotificationPolling). Без этого видео на шаге "Видео"
  // перезапускалось бы с нуля при каждом таком фоновом обновлении, пока врач его
  // смотрит. Запоминаем позицию/состояние воспроизведения ДО пересборки и
  // восстанавливаем её в wireLessonVideo — но только если это тот же самый источник
  // (иначе при переходе на видео другого урока получили бы случайную перемотку).
  var prevVideo = document.getElementById("lessonVideoPlayer");
  var savedVideoState = prevVideo ? { src: prevVideo.currentSrc, time: prevVideo.currentTime, playing: !prevVideo.paused && !prevVideo.ended } : null;
  // Приложение перерисовывается целиком (в т.ч. каждые 30с по опросу уведомлений),
  // и без этого все декоративные анимации («сияние», свет у урока, нить прогресса)
  // начинались бы заново — заметный скачок. Отрицательная задержка = время с
  // загрузки страницы, так что после перерисовки они продолжают с того же места.
  document.documentElement.style.setProperty("--anim-t", (-performance.now()/1000).toFixed(2)+"s");
  // Анимации появления не должны проигрываться заново при перерисовке (а она
  // случается на каждый клик и каждые 30с по опросу уведомлений) — иначе открытая
  // карточка врача/модалка заново «выезжает», статусы по всей таблице заново
  // «всплывают», и экран мигает. Запоминаем, что уже было на экране.
  var prevOverlays = {};
  app.querySelectorAll(".overlay").forEach(function(o){
    var sc = o.querySelector(".drawer") || o.firstElementChild;
    prevOverlays[o.getAttribute("data-action")||""] = { top: sc ? sc.scrollTop : 0 };
  });
  var hadBackdrop = !!app.querySelector(".sidebar-backdrop");
  var screenKey = view+"|"+(view==="student" ? studentState.tab : (view==="staff" ? staffState.mainTab : ""));
  var sameScreen = screenKey === lastRenderScreen;
  lastRenderScreen = screenKey;
  var node;
  applyGlow();
  if(view === "loading") node = el('<div style="min-height:100vh;"></div>');
  else if(view === "login") node = renderAuthScreen("login");
  else if(view === "register") node = renderAuthScreen("register");
  else if(view === "student") node = renderStudentShell();
  else if(view === "staff") node = renderStaffShell();
  mountKeepingSidebar(app, node);
  if(changePasswordOpen && (view==="student"||view==="staff")){
    app.appendChild(renderChangePasswordModal());
  }
  if(profileEditor.open && (view==="student"||view==="staff")){
    app.appendChild(renderProfileModal());
  }
  if(tempPasswordResult && view==="staff"){
    app.appendChild(renderTempPasswordModal());
  }
  // Редакторы урока, открытые вкладкой страницы урока, встроены в страницу —
  // поверх их не монтируем (см. renderLessonPage).
  if(lessonEditor.open && view==="staff" && !lpOwns("content")){
    app.appendChild(renderLessonEditorModal());
  }
  if(videoEditor.open && view==="staff" && !lpOwns("video")){
    app.appendChild(renderVideoEditorModal());
  }
  if(lessonQuizManager.open && view==="staff" && !lpOwns("quiz")){
    app.appendChild(renderLessonQuizManagerDrawer());
  }
  if(moduleQuizManager.open && view==="staff"){
    app.appendChild(renderModuleQuizManagerDrawer());
  }
  if(moduleFeedbackViewer.open && view==="staff"){
    app.appendChild(renderModuleFeedbackViewerDrawer());
  }
  if(protocolEditor.open && view==="staff" && staffState.mainTab!=="protocols"){
    app.appendChild(renderProtocolEditorModal());
  }
  if(specializationEditor.open && view==="staff"){
    app.appendChild(renderSpecializationEditorModal());
  }
  // quizEditor открывается поверх других модалок (и как редактор итогового теста,
  // и как редактор поурочного — см. lessonQuizManager) — поэтому монтируется последним,
  // чтобы его оверлей всегда оказывался сверху и не перекрывался открывшей его модалкой.
  if(quizEditor.open && view==="staff"){
    app.appendChild(renderQuizEditorModal());
  }
  if(protocolReader.id && view==="student" && studentState.tab==="protocols"){
    app.appendChild(renderProtocolReaderModal());
  }
  if(glossary.open && view==="student"){
    app.appendChild(renderGlossaryPanel());
  }
  if(unlockCelebration.open && view==="student"){
    app.appendChild(renderUnlockCelebrationModal());
  }
  if(view==="staff"){
    if(toolsState.orders.open) app.appendChild(renderOrderDrawer());
    if(toolsState.orders.draft) app.appendChild(renderOrderCreateModal());
    if(toolsState.products.editing) app.appendChild(renderProductModal());
    if(toolsState.surveys.editing) app.appendChild(renderSurveyBuilder());
    if(toolsState.assignEditor && !lpOwns("assign")) app.appendChild(renderAssignEditorModal());
  }
  if(view==="student" && studentTools.fillId) app.appendChild(renderSurveyFillModal());
  // confirmState монтируется последним — может быть открыт поверх любой другой
  // модалки (например, подтверждение удаления вопроса теста внутри редактора урока).
  if(confirmState && (view==="student"||view==="staff")){
    app.appendChild(renderConfirmModal());
  }
  app.classList.toggle("rerender", sameScreen);
  // Та же страница пересобрана заново (фоновое обновление, действие на месте):
  // браузер выставляет :hover новым элементам не сразу, и подсветка карточки или
  // кнопки под курсором гасла и заново проявлялась. Пока hover не восстановился —
  // без переходов, чтобы состояние под курсором вернулось мгновенно.
  if(sameScreen){
    app.classList.add("still");
    clearTimeout(stillTimer);
    stillTimer = setTimeout(function(){ app.classList.remove("still"); }, 200);
  }
  app.querySelectorAll(".overlay").forEach(function(o){
    var prev = prevOverlays[o.getAttribute("data-action")||""];
    if(!prev) return;
    o.classList.add("no-anim");
    var sc = o.querySelector(".drawer") || o.firstElementChild;   // и прокрутку внутри панели не сбрасываем
    if(sc && prev.top) sc.scrollTop = prev.top;
  });
  if(hadBackdrop){ var bd = app.querySelector(".sidebar-backdrop"); if(bd) bd.classList.add("no-anim"); }
  wireEvents(app);
  runEntranceAnimations();
  if(view==="login" || view==="register") initAuroraFx();
  ensureEmbers();
  if(view==="staff" && lpActive()) lpDecoratePreview();
  if(view==="student"){
    applyGlossaryTerms();
    applyLessonHighlights();
    if(studentState.scrollToHl){
      var hlEl = document.querySelector('#lessonProse mark.hl[data-hid="'+studentState.scrollToHl+'"]');
      studentState.scrollToHl = null;
      if(hlEl){ hlEl.scrollIntoView({ block:"center" }); hlEl.classList.add("hl-flash"); setTimeout(function(){ hlEl.classList.remove("hl-flash"); }, 1600); }
    }
  }
  if(view==="student" && studentState.tab==="lesson" && !studentState.quizMode && studentState.lessonStage==="video"){
    setTimeout(function(){ wireLessonVideo(savedVideoState); }, 0);
  } else if(lessonPlyrInstance){
    // Ушли со стадии "видео" — старую разметку Plyr уже снёс app.innerHTML="",
    // так что просто отпускаем ссылку на инстанс, а не пытаемся destroy() над
    // отсутствующими в DOM узлами.
    lessonPlyrInstance = null;
  }
  syncNavHistory();
}

// Plyr переодевает стандартный <video> в свой интерфейс, но сам элемент с id
// lessonVideoPlayer остаётся в DOM и продолжает как обычно стрелять timeupdate/
// ended — весь код ниже (главы, восстановление позиции) написан для нативного
// <video> и не менялся. render() пересобирает DOM целиком на каждый вызов
// (в т.ч. на фоновый поллинг уведомлений), поэтому старый экземпляр Plyr нужно
// явно уничтожать перед созданием нового — иначе на каждый render накапливался
// бы ещё один живой инстанс поверх уже удалённой из DOM разметки.
var lessonPlyrInstance = null;

// Подсветка текущей главы под видео обновляется через timeupdate БЕЗ полного
// render() на каждый тик (десятки раз в секунду) — иначе моргало бы видео и
// сбивался прогресс воспроизведения. render() дёргаем только на реальных
// переходах состояния (глава сменилась, видео закончилось).
function wireLessonVideo(savedVideoState){
  var v = document.getElementById("lessonVideoPlayer");
  if(!v || !course) return;
  var lesson = course.lessons[studentState.lessonIndex];
  if(!lesson) return;
  if(savedVideoState && savedVideoState.src && v.currentSrc===savedVideoState.src){
    if(savedVideoState.time>0) v.currentTime = savedVideoState.time;
    if(savedVideoState.playing) v.play().catch(function(){});
  }
  if(lessonPlyrInstance){ lessonPlyrInstance.destroy(); lessonPlyrInstance=null; }
  if(typeof Plyr!=="undefined"){
    // iconUrl по умолчанию у Plyr указывает на cdn.plyr.io — самохостим вместе с
    // JS/CSS (см. plyr.svg в public/vendor/plyr), иначе иконки не загрузятся ни
    // при заблокированном внешнем CDN за корпоративным файрволом, ни из-за CSP
    // connect-src 'self' на этом сервере (см. src/server.js).
    lessonPlyrInstance = new Plyr(v, {
      iconUrl: "vendor/plyr/plyr.svg",
      controls: ["play-large","play","progress","current-time","duration","mute","volume","settings","fullscreen"],
      settings: ["speed"],
      speed: { selected:1, options:[0.75,1,1.25,1.5,2] }
    });
  }
  var tcs = lesson.videoTimecodes||[];
  var lastChapterId = null;
  function updateChapter(){
    var t = v.currentTime;
    var current = null;
    tcs.forEach(function(tc){ if(t>=tc.time) current=tc; });
    if(current && current.id===lastChapterId) return;
    lastChapterId = current ? current.id : null;
    var panel = document.getElementById("lessonChapterSummary");
    if(panel) panel.innerHTML = current ? renderPlainToProse(current.summary||'') : '';
    document.querySelectorAll(".chapter-item").forEach(function(el){
      el.classList.toggle("active", !!current && el.getAttribute("data-chapter-id")===current.id);
    });
  }
  v.addEventListener("timeupdate", updateChapter);
  v.addEventListener("ended", function(){
    if(!studentState.videoEnded){ studentState.videoEnded=true; render(); }
  });
  updateChapter();
}

// Рукописный WYSIWYG на contenteditable + document.execCommand — сознательно без внешних
// библиотек (Quill/Pell и т.п.), чтобы не тащить CDN-зависимость и гарантировать, что
// редактор производит ровно те теги, что разрешены в sanitizeLessonHtml (src/sanitize.js).
// targetId/hiddenId — id contenteditable-поля и синхронизированного с ним скрытого textarea,
// значение которого реально уходит на сервер при submit формы.
function renderWysiwygToolbar(targetId, hiddenId){
  function btn(cmd, label, title){
    return '<button type="button" data-action="wysiwyg-cmd" data-cmd="'+cmd+'" data-target="'+targetId+'" data-hidden="'+hiddenId+'" title="'+escapeHtml(title)+'">'+label+'</button>';
  }
  return '<div class="wysiwyg-toolbar">' + (targetId==="lessonWysiwygEditor" ? lbMenuHtml() : '') +
    btn("bold","<b>Ж</b>","Жирный") + btn("italic","<i>К</i>","Курсив") + btn("underline","<u>Ч</u>","Подчёркнутый") +
    '<span class="wysiwyg-sep"></span>' +
    btn("h3","H3","Заголовок 3 уровня") + btn("h4","H4","Заголовок 4 уровня") + btn("h5","H5","Заголовок 5 уровня") + btn("p","¶","Обычный текст") +
    '<span class="wysiwyg-sep"></span>' +
    btn("ul","• Список","Маркированный список") + btn("ol","1. Список","Нумерованный список") + btn("quote","❝","Цитата") +
    '<span class="wysiwyg-sep"></span>' +
    btn("link","Ссылка","Вставить ссылку") + btn("image","Картинка","Вставить изображение по ссылке") + btn("video","Видео","Вставить видео (iframe-embed)") + btn("hr","—","Разделитель") +
    '<span class="wysiwyg-sep"></span>' +
    btn("clear","Очистить","Убрать форматирование") +
  '</div>';
}

/* ============================= БЛОКИ УРОКА: «+ Блок» и панель блока ============================= */
// Оформленные блоки в тексте урока (Главное, Цифры, Что делать врачу, Важно, Дополнительно,
// Шпаргалка). Разметка — div/span/h5/p/ul с классами lb-*, т.е. ровно то, что пропускает
// sanitizeLessonHtml; иконки шагов — классы lbi-*, картинка задаётся в CSS. Блок вставляется
// после абзаца с курсором, текст правится прямо в редакторе; когда курсор внутри блока,
// над редактором появляется панель: добавить/убрать деление, число, шаг, сменить цвет или
// иконку, передвинуть или удалить блок.
var LB_ICONS = [["search","анализ"],["drop","кровь"],["cal","сроки"],["user","пациент"],["clip","анамнез"],["pill","препарат"],["heart","сердце"],["scale","вес"],["check","проверка"],["alert","осторожно"]];
var LB_TONES = [["lbt-ok","норма"],["lbt-warn","пограничное"],["lbt-bad","отклонение"]];
var LB_KINDS = {
  key:   { name:"Главное", icon:"!", cls:"m-key", hint:"Цветной блок по центру: правило или порог, по желанию со шкалой",
    html:'<div class="lb lb-key"><span class="lb-lab">Главное</span><div class="lb-big">Главная мысль или порог — одной фразой</div>' +
      '<div class="lb-scale"><div class="lb-seg lbt-ok"><span class="lb-v">&gt; 12</span>норма</div><div class="lb-seg lbt-warn"><span class="lb-v">8–12</span>пограничное значение</div><div class="lb-seg lbt-bad"><span class="lb-v">&lt; 8</span>отклонение</div></div></div>' },
  stats: { name:"Цифры", icon:"%", cls:"", hint:"2–4 крупных числа с подписями",
    html:'<div class="lb lb-card"><h5>Заголовок</h5><div class="lb-stats"><div class="lb-stat"><span class="lb-v">40%</span>подпись к числу</div><div class="lb-stat"><span class="lb-v">&gt; 50%</span>подпись к числу</div></div></div>' },
  steps: { name:"Что делать врачу", icon:"✓", cls:"", hint:"Шаги карточками: иконка, действие, пояснение",
    html:'<div class="lb lb-card"><h5>Что делать врачу</h5><div class="lb-steps"><div class="lb-step lbi-search"><span class="lb-v">Действие</span>зачем или как</div><div class="lb-step lbi-clip"><span class="lb-v">Действие</span>зачем или как</div></div></div>' },
  warn:  { name:"Важно", icon:"⚠", cls:"m-warn", hint:"Противопоказания, предупреждения — красная рамка",
    html:'<div class="lb lb-warn"><span class="lb-lab">Важно</span><ul><li>Пункт</li></ul></div>' },
  note:  { name:"Дополнительно", icon:"+", cls:"m-note", hint:"Для тех, кто хочет глубже — спокойный блок",
    html:'<div class="lb lb-note"><span class="lb-lab">Дополнительно</span><p>Текст</p></div>' },
  cheat: { name:"Шпаргалка", icon:"✓", cls:"m-cheat", hint:"Итоги урока списком с галочками",
    html:'<div class="lb lb-cheat"><span class="lb-lab">Шпаргалка</span><ul><li>Итог</li></ul></div>' }
};
var LB_ORDER = ["key","stats","steps","warn","note","cheat"];
var lbCur = null;

function lbMenuHtml(){
  return '<button type="button" class="lb-add" data-action="lb-menu-toggle" title="Вставить оформленный блок">＋ Блок ▾</button>' +
    '<div class="lb-menu" id="lbMenu" hidden>' + LB_ORDER.map(function(k){ var d = LB_KINDS[k];
      return '<button type="button" data-action="lb-insert" data-kind="'+k+'"><i class="'+d.cls+'">'+d.icon+'</i><span><b>'+d.name+'</b><span>'+d.hint+'</span></span></button>';
    }).join('') + '</div><span class="wysiwyg-sep"></span>';
}
function lbKind(block){
  if(!block) return null;
  if(block.classList.contains("lb-key")) return "key";
  if(block.classList.contains("lb-warn")) return "warn";
  if(block.classList.contains("lb-note")) return "note";
  if(block.classList.contains("lb-cheat")) return "cheat";
  if(block.querySelector(".lb-steps")) return "steps";
  if(block.querySelector(".lb-stats")) return "stats";
  return "card";
}
// HTML редактора без служебной подсветки выбранного блока.
function lbHtml(ed){ return ed.innerHTML.replace(/ lb-focus/g, ""); }
function lbSync(){
  var ed = document.getElementById("lessonWysiwygEditor");
  if(!ed) return;
  var h = lbHtml(ed), hidden = document.getElementById("lessonHtmlHidden");
  if(hidden) hidden.value = h;
  lessonEditor.html = h;
  lpRefreshPreviewSoon();
}
function lbSelectText(el){
  if(!el) return;
  // Выделяем именно текстовый узел: выделение «содержимого элемента» Chrome сдвигает
  // в конец предыдущего inline-элемента (подписи блока), и ввод уходит туда.
  var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), first = w.nextNode(), last = first, x;
  while((x = w.nextNode())) last = x;
  var r = document.createRange(), s = window.getSelection();
  if(first){ r.setStart(first, 0); r.setEnd(last, last.nodeValue.length); } else r.selectNodeContents(el);
  s.removeAllRanges(); s.addRange(r);
}
function lbCaretNode(){
  var s = window.getSelection();
  if(!s.rangeCount) return null;
  var n = s.getRangeAt(0).startContainer;
  return n.nodeType===1 ? n : n.parentElement;
}
function lbInsert(kind){
  var ed = document.getElementById("lessonWysiwygEditor"), d = LB_KINDS[kind];
  if(!ed || !d) return;
  var n = lbCaretNode(), top = null;
  if(n && ed.contains(n) && n!==ed){ top = n; while(top.parentNode!==ed) top = top.parentNode; }
  var tmp = document.createElement("div"); tmp.innerHTML = d.html;
  var block = tmp.firstChild;
  if(top && top.tagName==="P" && !top.textContent.trim() && !top.querySelector("img,iframe")) ed.replaceChild(block, top);
  else if(top) ed.insertBefore(block, top.nextSibling);
  else ed.appendChild(block);
  var next = block.nextElementSibling;
  if(!next || next.tagName!=="P"){ var p = document.createElement("p"); p.innerHTML = "<br>"; ed.insertBefore(p, block.nextSibling); }
  ed.focus();
  lbSelectText(lbFirst(block, [".lb-big","h5","li","p",".lb-lab"]));
  block.scrollIntoView({ block:"nearest" });
  lbSync(); lbUpdateBar();
}
// querySelector со списком селекторов берёт первый по документу, а нужен первый по приоритету.
function lbFirst(el, sels){ for(var i=0;i<sels.length;i++){ var x = el.querySelector(sels[i]); if(x) return x; } return null; }
function lbItem(block, sel){
  var n = lbCaretNode(), it = n && n.closest(sel);
  return it && block.contains(it) ? it : null;
}
function lbBarHtml(block){
  var k = lbKind(block), b = function(op, label, cls){ return '<button type="button" data-action="lb-op" data-op="'+op+'"'+(cls?' class="'+cls+'"':'')+'>'+label+'</button>'; };
  var name = k==="card" ? "Карточка" : LB_KINDS[k].name, out = '<b>Блок «'+name+'»</b>';
  if(k==="key"){
    var seg = lbItem(block, ".lb-seg");
    out += block.querySelector(".lb-scale") ? b("seg-add","+ деление") + (seg ? b("seg-tone","Цвет: "+(LB_TONES.filter(function(t){ return seg.classList.contains(t[0]); })[0]||LB_TONES[0])[1]) + b("seg-del","− деление") : "") + b("scale-del","Убрать шкалу") : b("scale-add","+ шкала");
  } else if(k==="stats"){
    out += b("stat-add","+ число") + (lbItem(block, ".lb-stat") ? b("stat-del","− число") : "");
  } else if(k==="steps"){
    var st = lbItem(block, ".lb-step");
    out += b("step-add","+ шаг");
    if(st){
      var ic = LB_ICONS.filter(function(x){ return st.classList.contains("lbi-"+x[0]); })[0] || LB_ICONS[0];
      out += b("step-icon","Иконка: "+ic[1]) + b("step-up","↑ шаг") + b("step-down","↓ шаг") + b("step-del","− шаг");
    }
  } else if(k==="warn" || k==="cheat"){
    out += '<span style="color:var(--muted);font-size:12px;">Enter — новый пункт</span>';
  }
  return out + '<span class="lb-bar-sep"></span>' + b("up","↑ Выше") + b("down","↓ Ниже") + b("del","Удалить блок","danger");
}
function lbUpdateBar(){
  var ed = document.getElementById("lessonWysiwygEditor"), bar = document.getElementById("lbBar");
  if(!ed || !bar) { lbCur = null; return; }
  var n = lbCaretNode(), block = n && ed.contains(n) ? n.closest(".lb") : null;
  if(block && !ed.contains(block)) block = null;
  if(lbCur && lbCur!==block) lbCur.classList.remove("lb-focus");
  lbCur = block;
  if(!block){ bar.hidden = true; bar.innerHTML = ""; return; }
  block.classList.add("lb-focus");
  var h = lbBarHtml(block);
  if(bar.innerHTML!==h) bar.innerHTML = h;
  bar.hidden = false;
}
document.addEventListener("selectionchange", function(){
  var bar = document.getElementById("lbBar");
  if(!bar) return;
  var n = lbCaretNode();
  // Клик по кнопкам панели выделение не трогает (mousedown погашен), так что уход
  // курсора за пределы редактора — это действительно уход.
  if(n && !n.closest("#lessonWysiwygEditor")){ if(lbCur){ lbCur.classList.remove("lb-focus"); lbCur = null; } bar.hidden = true; return; }
  lbUpdateBar();
});
document.addEventListener("click", function(e){
  var m = document.getElementById("lbMenu");
  if(m && !m.hidden && !e.target.closest("#lbMenu, .lb-add")) m.hidden = true;
});
function lbOp(op){
  var ed = document.getElementById("lessonWysiwygEditor"), block = lbCur;
  if(!ed || !block || !ed.contains(block)) return;
  var focusEl = null, mk = function(html){ var t = document.createElement("div"); t.innerHTML = html; return t.firstChild; };
  var move = function(el, up){
    var sib = up ? el.previousElementSibling : el.nextElementSibling;
    if(sib) el.parentNode.insertBefore(el, up ? sib : sib.nextSibling);
  };
  var keepCaret = function(){ var s = window.getSelection(); return s.rangeCount ? s.getRangeAt(0).cloneRange() : null; };
  var saved = keepCaret();
  if(op==="up" || op==="down"){ var top = block; while(top.parentNode!==ed) top = top.parentNode; move(top, op==="up"); focusEl = lbFirst(block, [".lb-big","h5",".lb-lab"]); }
  else if(op==="del"){
    var nx = block.nextElementSibling || block.previousElementSibling;
    block.remove(); lbCur = null; saved = null;
    if(!ed.firstElementChild) ed.innerHTML = "<p><br></p>";
    focusEl = nx && ed.contains(nx) ? nx : ed.firstElementChild;
  }
  else if(op==="scale-add"){ var sc = mk(LB_KINDS.key.html).querySelector(".lb-scale"); block.appendChild(sc); focusEl = sc.querySelector(".lb-v"); }
  else if(op==="scale-del"){ var s0 = block.querySelector(".lb-scale"); if(s0) s0.remove(); focusEl = block.querySelector(".lb-big"); }
  else if(op==="seg-add" || op==="stat-add" || op==="step-add"){
    var cfg = { "seg-add":[".lb-seg",".lb-scale",'<div class="lb-seg lbt-ok"><span class="lb-v">значение</span>что это значит</div>'],
      "stat-add":[".lb-stat",".lb-stats",'<div class="lb-stat"><span class="lb-v">число</span>подпись к числу</div>'],
      "step-add":[".lb-step",".lb-steps",'<div class="lb-step lbi-check"><span class="lb-v">Действие</span>зачем или как</div>'] }[op];
    var cur = lbItem(block, cfg[0]), box = block.querySelector(cfg[1]), el = mk(cfg[2]);
    if(cur) cur.parentNode.insertBefore(el, cur.nextSibling); else box.appendChild(el);
    focusEl = el.querySelector(".lb-v");
  }
  else if(op==="seg-del" || op==="stat-del" || op==="step-del"){
    var sel = { "seg-del":".lb-seg", "stat-del":".lb-stat", "step-del":".lb-step" }[op];
    var it = lbItem(block, sel);
    if(it){
      var other = it.nextElementSibling || it.previousElementSibling;
      it.remove(); saved = null;
      if(other) focusEl = other.querySelector(".lb-v") || other;
      else if(op==="seg-del"){ var sc2 = block.querySelector(".lb-scale"); if(sc2) sc2.remove(); focusEl = block.querySelector(".lb-big"); }
      else focusEl = block.querySelector("h5");
    }
  }
  else if(op==="seg-tone"){
    var sg = lbItem(block, ".lb-seg");
    if(sg){ var i = LB_TONES.findIndex(function(t){ return sg.classList.contains(t[0]); });
      LB_TONES.forEach(function(t){ sg.classList.remove(t[0]); }); sg.classList.add(LB_TONES[(i+1) % LB_TONES.length][0]); }
  }
  else if(op==="step-icon"){
    var sp = lbItem(block, ".lb-step");
    if(sp){ var j = LB_ICONS.findIndex(function(x){ return sp.classList.contains("lbi-"+x[0]); });
      LB_ICONS.forEach(function(x){ sp.classList.remove("lbi-"+x[0]); }); sp.classList.add("lbi-"+LB_ICONS[(j+1) % LB_ICONS.length][0]); }
  }
  else if(op==="step-up" || op==="step-down"){ var s1 = lbItem(block, ".lb-step"); if(s1){ move(s1, op==="step-up"); focusEl = s1.querySelector(".lb-v") || s1; } }
  ed.focus();
  if(focusEl){ if(op==="del"){ var r = document.createRange(); r.selectNodeContents(focusEl); r.collapse(true); var ss = window.getSelection(); ss.removeAllRanges(); ss.addRange(r); } else lbSelectText(focusEl); }
  else if(saved){ var s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(saved); }
  lbSync(); lbUpdateBar();
}

function renderLessonEditorModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+(lessonEditor.isNew?"Новый урок":"Редактирование урока")+'</b><button class="btn btn-ghost btn-sm" data-action="close-lesson-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body">';
  if(!lessonEditor.isNew && !lessonEditor.loaded){
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
          body += '<div class="adm-row" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
            '<div style="flex:1;"><b style="font-size:14px;display:block;">'+escapeHtml(h.title)+'</b><span style="font-size:12px;color:var(--muted);">до '+fmtDate(h.edited_at)+' '+fmtTime(h.edited_at)+' · '+escapeHtml(h.edited_by||"")+'</span></div>' +
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
        '<div class="field"><label>Содержимое</label>' +
          renderWysiwygToolbar("lessonWysiwygEditor","lessonHtmlHidden") +
          '<div class="lb-bar" id="lbBar" hidden></div>' +
          '<div class="wysiwyg-editor" id="lessonWysiwygEditor" contenteditable="true">'+(lessonEditor.html||"")+'</div>' +
          '<textarea name="html" id="lessonHtmlHidden" required style="display:none;">'+escapeHtml(lessonEditor.html)+'</textarea>' +
        '<p class="hint">«＋ Блок» — оформленные вставки (главное, цифры, шаги, важно, шпаргалка); текст в них правится прямо здесь. Форматирование, списки, ссылки, изображения и видео — через панель выше. Опасные теги вырезаются автоматически при сохранении.</p></div>' +
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

// Редактор вопроса: тип плитками и своя форма под тип (см. src/quiz.js).
// Поля пишутся прямо в quizEditor по data-qe="путь" (см. обработчик input), поэтому
// добавление/удаление строк не стирает уже введённое.
var QE_TYPES = [
  ["single","Один верный","Классика: выбрать один вариант"],
  ["multi","Несколько верных","Отметить все подходящие, частичный балл"],
  ["order","Порядок","Расставить шаги алгоритма по порядку"],
  ["number","Число","Ввести дозу, порог, возраст — с допуском"],
  ["match","Сопоставление","Соединить пары: анализ ↔ отдел, препарат ↔ доза"],
  ["case","Клинический случай","Описание пациента и 2–3 шага по нему"]
];
function qeBlankStep(){ return { type:"single", question:"", options:["",""], correct:0, correctMulti:[], answer:"", tolerance:"", unit:"" }; }
function qeNew(lessonId, moduleId){
  return { open:true, isNew:true, id:null, lessonId:lessonId, moduleId:moduleId, type:"single", question:"", options:["",""], correct:0, correctMulti:[],
    answer:"", tolerance:"", unit:"", right:["",""], scenario:"", steps:[qeBlankStep()] };
}
function qeFromRow(q, lessonId, moduleId){
  var e = qeNew(lessonId, moduleId), p = q.payload || {};
  e.isNew = false; e.id = q.id; e.type = q.qtype || "single"; e.question = q.question;
  e.options = (q.options||[]).slice(); e.correct = q.correct || 0;
  if(e.type==="multi") e.correctMulti = (p.correct||[]).slice();
  if(e.type==="number"){ e.answer = p.answer!=null ? String(p.answer) : ""; e.tolerance = p.tolerance ? String(p.tolerance) : ""; e.unit = p.unit || ""; e.options = ["",""]; }
  if(e.type==="match") e.right = (p.right||[]).slice();
  if(e.type==="case"){
    e.scenario = p.scenario || ""; e.options = ["",""];
    e.steps = (p.steps||[]).map(function(st){
      var b = qeBlankStep(); b.type = st.type; b.question = st.question;
      if(st.type==="number"){ b.answer = st.answer!=null ? String(st.answer) : ""; b.tolerance = st.tolerance ? String(st.tolerance) : ""; b.unit = st.unit || ""; }
      else { b.options = (st.options||[]).slice(); if(st.type==="multi") b.correctMulti = (st.correct||[]).slice(); else b.correct = st.correct||0; }
      return b;
    });
    if(!e.steps.length) e.steps = [qeBlankStep()];
  }
  return e;
}
// Описание вопроса в списках куратора: тип и что считается верным.
function describeQuizQuestion(q){
  var t = q.qtype || "single", p = q.payload || {};
  if(t==="multi") return 'несколько верных: '+(p.correct||[]).map(function(i){ return '«'+escapeHtml(q.options[i]||"")+'»'; }).join(", ");
  if(t==="order") return 'порядок из '+q.options.length+' шагов';
  if(t==="number") return 'число: '+escapeHtml(String(p.answer))+(p.tolerance?' ±'+escapeHtml(String(p.tolerance)):'')+(p.unit?' '+escapeHtml(p.unit):'');
  if(t==="match") return 'сопоставление, '+q.options.length+' '+ruPluralClient(q.options.length,"пара","пары","пар");
  if(t==="case") return 'клинический случай, '+(p.steps||[]).length+' '+ruPluralClient((p.steps||[]).length,"шаг","шага","шагов");
  return q.options.length+' варианта, правильный: «'+escapeHtml(q.options[q.correct]||"")+'»';
}
function qeField(label, path, val, o){
  o = o || {};
  var inp = o.area
    ? '<textarea class="input" data-qe="'+path+'" rows="'+(o.rows||2)+'" placeholder="'+escapeHtml(o.ph||"")+'">'+escapeHtml(val||"")+'</textarea>'
    : '<input class="input" data-qe="'+path+'" value="'+escapeHtml(val==null?"":String(val))+'" placeholder="'+escapeHtml(o.ph||"")+'"'+(o.num?' inputmode="decimal"':'')+'>';
  return '<div class="field'+(o.cls?' '+o.cls:'')+'">'+(label?'<label>'+label+'</label>':'')+inp+'</div>';
}
// Варианты с отметкой верного: один (радио) или несколько (галочки). base — путь
// к объекту с полями options/correct/correctMulti (пусто — сам вопрос, «steps.N» — шаг).
function qeChoices(base, obj, multi){
  var pre = base ? base+"." : "";
  return '<div class="qe-opts">' + obj.options.map(function(opt, i){
    var on = multi ? obj.correctMulti.indexOf(i)!==-1 : obj.correct===i;
    return '<div class="qe-opt'+(on?' on':'')+'"><button type="button" class="qe-mark'+(multi?' sq':'')+'" data-action="qe-correct" data-base="'+base+'" data-i="'+i+'"'+(multi?' data-multi="1"':'')+' title="'+(multi?'Верный вариант (можно несколько)':'Верный вариант')+'">'+(on?icon("check","ic-sm"):'')+'</button>' +
      '<span class="qe-letter">'+QZ_LETTERS[i]+'</span><input class="input" data-qe="'+pre+'options.'+i+'" value="'+escapeHtml(opt)+'" placeholder="Вариант '+QZ_LETTERS[i]+'">' +
      '<button type="button" class="qe-x" data-action="qe-remove" data-list="'+pre+'options" data-i="'+i+'" title="Убрать">✕</button></div>';
  }).join("") + '</div><button type="button" class="link-btn qe-add" data-action="qe-add" data-list="'+pre+'options">+ Вариант</button>' +
  '<p class="hint">'+(multi?'Отметьте все верные — врач получит частичный балл за частично верный ответ.':'Отметьте кружком верный вариант.')+'</p>';
}
function qeNumber(base, obj){
  var pre = base ? base+"." : "";
  return '<div class="qe-num">' + qeField('Верный ответ', pre+'answer', obj.answer, { num:true, ph:'40' }) + qeField('Допуск ±', pre+'tolerance', obj.tolerance, { num:true, ph:'0' }) +
    qeField('Единица', pre+'unit', obj.unit, { ph:'лет, мг, нмоль/л…' }) + '</div>' +
    '<p class="hint">Засчитывается всё, что попадает в «ответ ± допуск». Можно писать через запятую: 8,5.</p>';
}
function renderQuizEditorModal(){
  var e = quizEditor, t = e.type || "single";
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+(e.isNew?"Новый вопрос":"Редактирование вопроса")+'</b><button class="btn btn-ghost btn-sm" data-action="close-quiz-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body qe">' +
      '<label class="qe-label">Тип вопроса</label><div class="qe-types">' + QE_TYPES.map(function(x){
        return '<button type="button" class="qe-type'+(t===x[0]?' on':'')+'" data-action="qe-type" data-type="'+x[0]+'"><b>'+x[1]+'</b><span>'+x[2]+'</span></button>';
      }).join("") + '</div>';
  if(t==="case") body += qeField('Описание пациента', 'scenario', e.scenario, { area:true, rows:4, ph:'Пациентка 52 лет, менопауза 3 года, жалобы на приливы…' });
  body += qeField(t==="case" ? 'Вопрос к случаю' : 'Текст вопроса', 'question', e.question, { area:true, rows:2, ph: t==="case" ? 'Как вести пациентку?' : '' });
  if(t==="single" || t==="multi") body += '<label class="qe-label">Варианты ответа</label>' + qeChoices("", e, t==="multi");
  if(t==="order"){
    body += '<label class="qe-label">Шаги в верном порядке</label><div class="qe-opts">' + e.options.map(function(opt, i){
      return '<div class="qe-opt"><span class="qe-n">'+(i+1)+'</span><input class="input" data-qe="options.'+i+'" value="'+escapeHtml(opt)+'" placeholder="Шаг '+(i+1)+'">' +
        '<button type="button" class="qe-x" data-action="qe-move" data-i="'+i+'" data-dir="-1"'+(i===0?' disabled':'')+' title="Выше">↑</button>' +
        '<button type="button" class="qe-x" data-action="qe-move" data-i="'+i+'" data-dir="1"'+(i===e.options.length-1?' disabled':'')+' title="Ниже">↓</button>' +
        '<button type="button" class="qe-x" data-action="qe-remove" data-list="options" data-i="'+i+'" title="Убрать">✕</button></div>';
    }).join("") + '</div><button type="button" class="link-btn qe-add" data-action="qe-add" data-list="options">+ Шаг</button>' +
    '<p class="hint">Врач увидит шаги перемешанными. Балл — доля шагов, стоящих на своём месте.</p>';
  }
  if(t==="number") body += qeNumber("", e);
  if(t==="match"){
    body += '<label class="qe-label">Пары: слева — что сопоставить, справа — верная пара</label><div class="qe-opts">' + e.options.map(function(opt, i){
      return '<div class="qe-opt qe-pair"><input class="input" data-qe="options.'+i+'" value="'+escapeHtml(opt)+'" placeholder="Например, зонулин"><span class="qe-arrow">→</span>' +
        '<input class="input" data-qe="right.'+i+'" value="'+escapeHtml(e.right[i]||"")+'" placeholder="тонкий кишечник">' +
        '<button type="button" class="qe-x" data-action="qe-remove" data-list="options" data-i="'+i+'" title="Убрать пару">✕</button></div>';
    }).join("") + '</div><button type="button" class="link-btn qe-add" data-action="qe-add" data-list="options">+ Пара</button>' +
    '<p class="hint">Правая колонка у врача будет перемешана. Балл — доля верно собранных пар.</p>';
  }
  if(t==="case"){
    body += '<label class="qe-label">Шаги по случаю</label>' + e.steps.map(function(st, si){
      var base = "steps."+si;
      return '<div class="qe-step"><div class="qe-step-head"><b>Шаг '+(si+1)+'</b><div class="qe-seg">' +
        [["single","Один верный"],["multi","Несколько"],["number","Число"]].map(function(x){ return '<button type="button" class="'+(st.type===x[0]?'on':'')+'" data-action="qe-step-type" data-i="'+si+'" data-type="'+x[0]+'">'+x[1]+'</button>'; }).join("") +
        '</div>' + (e.steps.length>1 ? '<button type="button" class="qe-x" data-action="qe-remove" data-list="steps" data-i="'+si+'" title="Убрать шаг">✕</button>' : '') + '</div>' +
        qeField('', base+'.question', st.question, { ph:'Например, какой анализ назначить первым?' }) +
        (st.type==="number" ? qeNumber(base, st) : qeChoices(base, st, st.type==="multi")) + '</div>';
    }).join("") + '<button type="button" class="btn btn-sm btn-ghost" data-action="qe-add" data-list="steps">+ Шаг</button>' +
    '<p class="hint">Балл за случай — среднее по шагам.</p>';
  }
  body += '<div class="err-text" id="quizEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="button" data-action="qe-save" style="margin-top:14px;">'+(e.isNew?"Добавить вопрос":"Сохранить вопрос")+'</button>' +
    '</div>';
  return el('<div class="overlay" data-action="overlay-close-quiz-editor"><div class="drawer" data-stop="1" style="width:min(600px,100%);">'+body+'</div></div>');
}
function qeGet(path){ return path.split(".").reduce(function(o, k){ return o==null ? o : o[k]; }, quizEditor); }
function qeSet(path, val){
  var parts = path.split("."), last = parts.pop();
  var obj = parts.reduce(function(o, k){ return o[k]; }, quizEditor);
  obj[last] = val;
}
// Тело запроса к серверу — только то, что нужно выбранному типу.
function qeBody(){
  var e = quizEditor, t = e.type, b = { type:t, question:e.question };
  var num = function(o){ return { answer:o.answer, tolerance:o.tolerance, unit:o.unit }; };
  if(t==="single"){ b.options = e.options; b.correct = e.correct; }
  if(t==="multi"){ b.options = e.options; b.correct = e.correctMulti; }
  if(t==="order") b.options = e.options;
  if(t==="number") Object.assign(b, num(e));
  if(t==="match"){ b.options = e.options; b.right = e.options.map(function(_, i){ return e.right[i]||""; }); }
  if(t==="case"){
    b.scenario = e.scenario;
    b.steps = e.steps.map(function(st){
      var o = { type:st.type, question:st.question };
      if(st.type==="number") Object.assign(o, num(st));
      else { o.options = st.options; o.correct = st.type==="multi" ? st.correctMulti : st.correct; }
      return o;
    });
  }
  return b;
}

function parseTimecodeInput(str){
  str = (str||"").trim();
  if(/^\d+:\d{1,2}$/.test(str)){ var parts=str.split(":"); return parseInt(parts[0],10)*60+parseInt(parts[1],10); }
  var n = parseInt(str,10);
  return isNaN(n) ? 0 : n;
}
// Перед add/remove главы синхронизируем то, что уже введено в открытых полях,
// обратно в состояние — иначе перерисовка стёрла бы несохранённый ввод (то же,
// что и с вариантами ответа в renderQuizEditorModal).
function syncVideoEditorFromDom(){
  var frm = document.getElementById("videoEditorForm");
  if(!frm) return;
  videoEditor.videoUrl = frm.videoUrl.value;
  videoEditor.timecodes = videoEditor.timecodes.map(function(tc,i){
    var timeField = frm["time_"+i], titleField = frm["title_"+i], summaryField = frm["summary_"+i];
    return {
      id: tc.id,
      time: timeField ? parseTimecodeInput(timeField.value) : tc.time,
      title: titleField ? titleField.value : tc.title,
      summary: summaryField ? summaryField.value : tc.summary
    };
  });
}

function renderVideoEditorModal(){
  var uploading = videoEditor.uploadProgress!==null;
  var body = '<div class="drawer-head"><b style="font-size:16px;">Видео урока «'+escapeHtml(videoEditor.lessonTitle)+'»</b><button class="btn btn-ghost btn-sm" data-action="close-video-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      // Без этого блока непонятно, что видео уже загружено: файловый инпут ниже браузер
      // всегда показывает пустым (не даёт подставить имя файла из соображений безопасности),
      // а поле-ссылка — просто текст среди других полей формы, легко пропустить. Мини-плеер
      // с самим видео убирает любые сомнения — его либо видно и можно проиграть, либо нет.
      (videoEditor.videoUrl
        ? '<div class="card" style="padding:12px;margin-bottom:14px;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--muted);font-size:13px;">' +
              icon("badge","ic-sm") + '<span>Сейчас загружено это видео — новая загрузка или ссылка его заменят</span>' +
            '</div>' +
            '<video src="'+escapeHtml(videoEditor.videoUrl)+'" controls preload="metadata" style="width:100%;max-height:220px;border-radius:var(--radius-s);background:#000;display:block;"></video>' +
          '</div>'
        : '') +
      '<div class="field"><label>Загрузить видео файлом <span style="font-weight:400;color:var(--muted-2);">(.mp4, .webm, .mov, .m4v — до 500 МБ)</span></label>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<input type="file" id="videoFileInput" accept=".mp4,.webm,.mov,.m4v" style="font-size:12px;flex:1;min-width:0;"'+(uploading?' disabled':'')+'>' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="upload-lesson-video" data-id="'+videoEditor.lessonId+'"'+(uploading?' disabled':'')+'>'+(uploading?'Загружаем…':'Загрузить')+'</button>' +
        '</div>' +
        (uploading ? '<div style="margin-top:8px;height:6px;border-radius:3px;background:var(--line-2);overflow:hidden;"><div id="videoUploadProgressFill" style="height:100%;width:100%;background:var(--primary);transform:scaleX('+(videoEditor.uploadProgress/100)+');transform-origin:left;transition:transform .15s;"></div></div>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:16px 0;color:var(--muted-2);font-size:13px;"><span style="flex:1;height:1px;background:var(--line-2);"></span>или<span style="flex:1;height:1px;background:var(--line-2);"></span></div>' +
    '<form id="videoEditorForm">' +
      '<div class="field"><label>Ссылка на видео <span style="font-weight:400;color:var(--muted-2);">(прямой URL на mp4-файл)</span></label><input class="input" name="videoUrl" value="'+escapeHtml(videoEditor.videoUrl||"")+'" placeholder="https://…/video.mp4"></div>' +
      '<label>Главы по таймкодам <span style="font-weight:400;color:var(--muted-2);">(необязательно — под видео появится сводка по текущей главе)</span></label>';
  videoEditor.timecodes.forEach(function(tc,i){
    body += '<div class="card" style="padding:12px 14px;margin-bottom:10px;">' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
        '<input class="input" style="max-width:90px;" name="time_'+i+'" value="'+escapeHtml(typeof tc.time==="number"?fmtTimecode(tc.time):(tc.time||""))+'" placeholder="мм:сс">' +
        '<input class="input" style="flex:1;" name="title_'+i+'" value="'+escapeHtml(tc.title||"")+'" placeholder="Тема главы" required>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="remove-video-timecode" data-idx="'+i+'" title="Удалить главу">✕</button>' +
      '</div>' +
      '<textarea class="input" name="summary_'+i+'" style="height:56px;font-size:13px;" placeholder="Краткая сводка по теме (покажется под видео)">'+escapeHtml(tc.summary||"")+'</textarea>' +
    '</div>';
  });
  body += '<button type="button" class="btn btn-sm btn-ghost" style="margin-bottom:14px;" data-action="add-video-timecode">+ Добавить главу</button>' +
      '<div class="err-text" id="videoEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Сохранить видео</button>' +
    '</form></div>';
  return el('<div class="overlay" data-action="overlay-close-video-editor"><div class="drawer" data-stop="1" style="width:min(560px,100%);">'+body+'</div></div>');
}

// Список поурочных вопросов конкретного урока — свой набор, отдельно от
// staffState.quizAdmin (итоговый тест курса). Редактирование каждого вопроса
// переиспользует renderQuizEditorModal (quizEditor.lessonId различает, куда слать запрос).
function renderLessonQuizManagerDrawer(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Поурочный тест «'+escapeHtml(lessonQuizManager.lessonTitle)+'»</b><button class="btn btn-ghost btn-sm" data-action="close-lesson-quiz-manager">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<p class="hint" style="margin-top:0;">«Развлекательный» тест на запоминание материала — открывается врачу после просмотра видео, не влияет на итоговый сертификат.</p>' +
      '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn btn-sm btn-primary" data-action="open-lesson-quiz-creator">+ Добавить вопрос</button></div>';
  if(!lessonQuizManager.questions.length){
    body += '<div class="empty-state" style="padding:24px 10px;">Вопросов пока нет — без них шаг «Тест» у этого урока просто не появится.</div>';
  } else {
    lessonQuizManager.questions.forEach(function(q,i){
      var qIsFirst=i===0, qIsLast=i===lessonQuizManager.questions.length-1;
      body += '<div class="adm-row" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-lesson-quiz-question" data-idx="'+i+'" data-dir="up"'+(qIsFirst?' disabled':'')+' title="Выше">↑</button>' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-lesson-quiz-question" data-idx="'+i+'" data-dir="down"'+(qIsLast?' disabled':'')+' title="Ниже">↓</button></div>' +
        '<div style="flex:1;"><b style="font-size:14px;display:block;">'+(i+1)+'. '+escapeHtml(q.question)+'</b><span style="font-size:12px;color:var(--muted);">'+describeQuizQuestion(q)+'</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-action="open-lesson-quiz-editor" data-id="'+q.id+'">Редактировать</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="delete-quiz-question" data-id="'+q.id+'" title="Удалить вопрос">'+icon("trash","ic-sm")+'</button></div>';
    });
  }
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-lesson-quiz-manager"><div class="drawer" data-stop="1" style="width:min(560px,100%);">'+body+'</div></div>');
}

function renderModuleQuizManagerDrawer(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Итоговый тест модуля «'+escapeHtml(moduleQuizManager.moduleTitle)+'»</b><button class="btn btn-ghost btn-sm" data-action="close-module-quiz-manager">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<p class="hint" style="margin-top:0;">Показывается врачу сразу после последнего урока модуля, перед мини-опросом. Без вопросов — сразу переходит к опросу.</p>' +
      '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn btn-sm btn-primary" data-action="open-module-quiz-creator">+ Добавить вопрос</button></div>';
  if(!moduleQuizManager.questions.length){
    body += '<div class="empty-state" style="padding:24px 10px;">Вопросов пока нет — тест модуля не появится, только мини-опрос.</div>';
  } else {
    moduleQuizManager.questions.forEach(function(q,i){
      var qIsFirst=i===0, qIsLast=i===moduleQuizManager.questions.length-1;
      body += '<div class="adm-row" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-module-quiz-question" data-idx="'+i+'" data-dir="up"'+(qIsFirst?' disabled':'')+' title="Выше">↑</button>' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-module-quiz-question" data-idx="'+i+'" data-dir="down"'+(qIsLast?' disabled':'')+' title="Ниже">↓</button></div>' +
        '<div style="flex:1;"><b style="font-size:14px;display:block;">'+(i+1)+'. '+escapeHtml(q.question)+'</b><span style="font-size:12px;color:var(--muted);">'+describeQuizQuestion(q)+'</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-action="open-module-quiz-editor" data-id="'+q.id+'">Редактировать</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="delete-quiz-question" data-id="'+q.id+'" title="Удалить вопрос">'+icon("trash","ic-sm")+'</button></div>';
    });
  }
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-module-quiz-manager"><div class="drawer" data-stop="1" style="width:min(560px,100%);">'+body+'</div></div>');
}

function renderModuleFeedbackViewerDrawer(){
  var v = moduleFeedbackViewer;
  var body = '<div class="drawer-head"><b style="font-size:16px;">Отзывы о модуле «'+escapeHtml(v.moduleTitle)+'»</b><button class="btn btn-ghost btn-sm" data-action="close-module-feedback-viewer">Закрыть ✕</button></div>' +
    '<div class="drawer-body">';
  if(!v.feedback.length){
    body += '<div class="empty-state" style="padding:24px 10px;">Пока никто не оставил отзыв по этому модулю.</div>';
  } else {
    body += '<div class="card" style="padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px;">' +
      icon("star","ic-lg") +
      '<div><b style="font-size:18px;display:block;">'+v.average.toFixed(1)+' / 5</b><span style="font-size:12px;color:var(--muted);">'+v.count+' '+(v.count===1?'отзыв':'отзывов')+'</span></div>' +
    '</div>';
    v.feedback.forEach(function(f){
      body += '<div style="padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
          '<b style="font-size:13px;">'+escapeHtml(f.userName)+'</b>' +
          '<span style="font-size:13px;color:var(--status-attention);">'+'★'.repeat(f.rating)+'<span style="color:var(--line-2);">'+'★'.repeat(5-f.rating)+'</span></span>' +
        '</div>' +
        (f.comment ? '<p style="font-size:13px;margin:0;color:var(--muted);">'+escapeHtml(f.comment)+'</p>' : '') +
      '</div>';
    });
  }
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-module-feedback-viewer"><div class="drawer" data-stop="1" style="width:min(480px,100%);">'+body+'</div></div>');
}

function renderTempPasswordModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Новый пароль создан</b><button class="btn btn-ghost btn-sm" data-action="close-temp-password">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<p style="font-size:14px;color:var(--muted);margin:0 0 14px;">Сообщите этот пароль <b style="color:var(--ink);">'+escapeHtml(tempPasswordResult.name)+'</b> лично или через Telegram — он больше нигде не отобразится.</p>' +
      '<div class="card" style="padding:16px;text-align:center;background:var(--primary-tint);border-color:transparent;margin-bottom:16px;">' +
        '<code style="font-size:20px;font-weight:700;letter-spacing:1px;color:var(--primary-dark);">'+escapeHtml(tempPasswordResult.tempPassword)+'</code>' +
      '</div>' +
      '<button class="btn btn-primary btn-block" data-action="close-temp-password">Понятно</button>' +
    '</div>';
  return el('<div class="overlay overlay-center" data-action="close-temp-password"><div class="drawer modal" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

function renderConfirmModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+escapeHtml(confirmState.title)+'</b><button class="btn btn-ghost btn-sm" data-action="confirm-modal-no">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      (confirmState.body ? '<p style="margin:0 0 18px;color:var(--muted);line-height:1.5;">'+escapeHtml(confirmState.body)+'</p>' : '') +
      '<div style="display:flex;gap:10px;">' +
        '<button class="btn btn-ghost btn-block" data-action="confirm-modal-no">Отмена</button>' +
        '<button class="btn '+(confirmState.danger?'btn-danger':'btn-primary')+' btn-block" data-action="confirm-modal-yes">'+escapeHtml(confirmState.confirmLabel)+'</button>' +
      '</div>' +
    '</div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-confirm"><div class="drawer modal" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
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
  return el('<div class="overlay overlay-center" data-action="overlay-close-password"><div class="drawer modal" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

// Врач раньше не видел вообще, за какой продукт и как оплачено — только персонал
// это редактировал. Показываем ему то же самое как read-only, без права правки.
function renderMyProductBlock(){
  var payStatus = me.payment_status || "unpaid";
  var payKind = payStatus==="paid" ? "done" : (payStatus==="partial" ? "attention" : "neutral");
  return '<div style="padding:16px 20px;border-top:1px solid var(--line);margin-top:4px;">' +
    '<b style="font-size:13px;display:block;margin-bottom:10px;">Ваш продукт и оплата</b>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<span style="font-size:13px;color:var(--muted);">Продукт</span>' +
      '<span style="font-size:13px;font-weight:600;">'+escapeHtml(PRODUCTS[me.product||"longevity"]||me.product)+'</span>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:13px;color:var(--muted);">Оплата</span>' +
      magnet(payKind, PAYMENT_LABELS[payStatus]||payStatus) +
    '</div>' +
    ((studentTools.orders||[]).length ? '' : '<p class="hint" style="margin-top:10px;">Вопрос по оплате — обратитесь к куратору в Telegram-группе потока.</p>') +
  '</div>';
}

function renderProfileModal(){
  var isStudent = me.role === "student";
  var body = '<div class="drawer-head"><b style="font-size:16px;">Профиль</b><button class="btn btn-ghost btn-sm" data-action="close-profile-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><form id="profileEditorForm">' +
      '<div class="field"><label>Имя и фамилия</label><input class="input" id="profileEditorName" required value="'+escapeHtml(profileEditor.name)+'"></div>' +
      (isStudent ? renderProfileSpecializationFields() : '') +
      '<div class="field"><label>Телефон</label><input class="input" type="tel" id="profileEditorPhone" value="'+escapeHtml(profileEditor.phone)+'"></div>' +
      (isStudent ? '<div class="field"><label>Место работы</label><input class="input" id="profileEditorWorkplace" value="'+escapeHtml(profileEditor.workplace)+'"></div>' : '') +
      '<div class="field"><label>Email</label><div class="input" style="background:var(--line-2);color:var(--muted);">'+escapeHtml(me.email||"")+'</div><p class="hint">Email нельзя изменить самостоятельно — обратитесь к куратору.</p></div>' +
      '<div class="err-text" id="profileEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Сохранить</button>' +
    '</form>' +
    (isStudent ? renderMyProductBlock() : '') +
    '</div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-profile-editor"><div class="drawer modal" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

// Всё общение врачей, кураторов и преподавателей — в Telegram-группе потока, не
// в приложении (см. streams.telegram_url). Раздел «Telegram» — полноценная
// страница: врачу — группа его потока, куратор, как задать вопрос и ближайшие
// эфиры; сотрудникам — все потоки с их группами и правкой ссылок на месте.
function tgHandle(url){ return String(url||"").replace(/^https?:\/\//,"").replace(/\/$/,""); }
function renderTelegramPage(){
  return view==="student" ? renderStudentTelegram() : renderStaffTelegram();
}
function renderStudentTelegram(){
  var mySid = me.stream_id || "";
  var stream = mySid ? (calendarState.streams||[]).find(function(s){ return s.id===mySid; }) : null;
  var url = stream && stream.telegram_url;
  var lead, actions = "";
  if(!mySid){
    lead = "Вы пока не в потоке. Куратор добавит вас, когда поток сформируется, — и здесь появится ссылка на группу.";
  } else if(!url){
    lead = "Куратор ещё не добавил ссылку на группу потока «"+escapeHtml(stream ? stream.name : "")+"». Как только добавит — она появится здесь.";
  } else {
    lead = "Куратор, преподаватели и врачи потока «"+escapeHtml(stream.name)+"» общаются в этой группе: вопросы по урокам, доступу и оплате, анонсы эфиров.";
    actions = '<div class="tg-actions"><a class="btn btn-primary" href="'+escapeHtml(url)+'" target="_blank" rel="noopener">'+icon("message","ic-sm")+' Открыть группу в Telegram</a>' +
      '<button class="btn btn-ghost" data-action="tg-copy" data-url="'+escapeHtml(url)+'">'+icon("clipboard","ic-sm")+' Скопировать ссылку</button></div>' +
      '<span class="tg-handle">'+escapeHtml(tgHandle(url))+'</span>';
  }
  var cur = me.curator;
  var html = '<div class="page-wide"><div class="card tg-hero">' +
    '<div class="proto-hero-glow aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
    '<div class="tg-hero-main"><span class="profile-kicker">Общение</span><h1>Группа потока в Telegram</h1><p>'+lead+'</p>'+actions+'</div>' +
    (cur ? '<div class="tg-curator">'+userAvatar(cur,"tg-cur-av")+'<div><span>Ваш куратор</span><b>'+escapeHtml(cur.name)+'</b></div></div>' : '') +
  '</div>';

  // Как спросить, чтобы ответили быстро
  html += '<div class="grid-2 tg-grid"><div class="card board-tile">' + cardHead("Как задать вопрос", "") +
    '<ol class="tg-steps">' +
      '<li><b>Назовите урок и шаг</b><span>«Урок 3, задание» — куратору не придётся уточнять.</span></li>' +
      '<li><b>Процитируйте фрагмент</b><span>Выделите текст в уроке → «Спросить куратора»: цитата с номером урока скопируется, останется вставить её в группу.</span></li>' +
      '<li><b>Доступ и оплата — туда же</b><span>Если урок не открывается или нужна рассрочка, напишите в группе или куратору лично.</span></li>' +
    '</ol></div>';

  // Эфиры потока
  var now = new Date();
  var evs = (calendarState.events||[]).filter(function(ev){
    return (!ev.stream_id || ev.stream_id===mySid) && new Date(ev.event_date+"T"+(ev.event_time||"00:00")).getTime() + (ev.duration_min||60)*60000 >= now.getTime();
  }).sort(function(a,b){ return (a.event_date+(a.event_time||"")).localeCompare(b.event_date+(b.event_time||"")); }).slice(0,3);
  html += '<div class="card board-tile">' + cardHead("Эфиры потока", '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="schedule">Расписание →</button>');
  if(!evs.length){
    html += '<span class="tile-sub">Ближайших эфиров нет — анонс появится здесь и в группе.</span>';
  } else {
    html += '<div class="tg-events">' + evs.map(function(ev){
      var d = new Date(ev.event_date+"T00:00:00");
      return '<div class="tg-ev"><div class="tg-ev-date"><b>'+d.getDate()+'</b><span>'+d.toLocaleDateString("ru-RU",{month:"short"}).replace(".","")+'</span></div>' +
        '<div class="tg-ev-body"><b>'+escapeHtml(ev.title)+'</b><span>'+escapeHtml(ev.event_time||"")+(ev.duration_min?' · '+ev.duration_min+' мин':'')+'</span></div></div>';
    }).join("") + '</div>';
  }
  html += '</div></div></div>';
  return el(html);
}
function renderStaffTelegram(){
  var streams = calendarState.streams || [];
  var withLink = streams.filter(function(s){ return !!s.telegram_url; }).length;
  var noStream = (staffState.students||[]).filter(function(s){ return !s.stream_id; }).length;
  var html = '<div class="page-wide"><div class="card tg-hero">' +
    '<div class="proto-hero-glow aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
    '<div class="tg-hero-main"><span class="profile-kicker">Общение</span><h1>Telegram-группы потоков</h1>' +
      '<p>Общение с врачами идёт в Telegram-группах их потоков. Врач видит в своём кабинете только группу своего потока.</p></div>' +
    '<div class="tg-stats"><div><b>'+withLink+' / '+streams.length+'</b><span>потоков с группой</span></div>' +
      '<div><b>'+noStream+'</b><span>'+ruPluralClient(noStream,"врач","врача","врачей")+' без потока</span></div></div>' +
  '</div>';
  var missing = streams.filter(function(s){ return !s.telegram_url; });
  if(missing.length || noStream){
    html += '<div class="card tg-warn">'+icon("bell","ic-sm")+'<span>' +
      (missing.length ? 'Без ссылки на группу: '+missing.map(function(s){ return '«'+escapeHtml(s.name)+'»'; }).join(", ")+' — врачи этих потоков не видят, куда писать. ' : '') +
      (noStream ? noStream+' '+ruPluralClient(noStream,"врач без потока не видит","врача без потока не видят","врачей без потока не видят")+' ни одной группы — '+(noStream===1?'добавьте его':'распределите их')+' в поток на странице «Ученики».' : '') +
    '</span></div>';
  }
  html += renderStreamsPanel() + '</div>';
  return el(html);
}

/* ============================= РЕНДЕР: АВТОРИЗАЦИЯ ============================= */
// Специализация — фиксированный справочник (не свободный текст, но с поиском по
// названию в выпадающем списке — их 50, чекбоксами было бы слишком длинно), от
// него зависит автоматический подбор протоколов под профиль врача (см. «Ваши
// протоколы»). Общий блок «Текущая специализация» (можно несколько — многие
// врачи практикуют сразу в нескольких направлениях) + «Желаемые специализации»
// для формы профиля — используется и в модалке (renderProfileModal), и на
// странице «Мой профиль». Оба поля — одинаковые выпадающие списки, но разных
// имён, чтобы не путать "чем занимаетесь сейчас" и "куда хотите развиваться".
function renderProfileSpecializationFields(){
  return renderSpecPicker("profile-current", "Текущая специализация", null, profileEditor.specializationIds||[]) +
    renderSpecPicker("profile-desired", "Желаемые специализации", "выберите специализации, в которых хотите развиваться, можно оставить поле пустым", profileEditor.interestIds||[]);
}
// Выпадающий список с поиском по названию (не просто <select> — вариантов 50,
// и нужно выбирать сразу несколько). pickerId — с каким полем сверяться при
// клике по пункту (см. specPickerFieldFor) и какой список считать открытым
// (specPickerOpen — глобально только один такой список открыт за раз).
function renderSpecPicker(pickerId, label, hint, selectedIds){
  var isOpen = specPickerOpen === pickerId;
  var labels = selectedIds.map(function(id){
    var m = specializationsList.find(function(s){ return s.id===id; });
    return m ? m.name : id;
  });
  var summary = !labels.length ? "Не выбрано" : (labels.length<=2 ? labels.join(", ") : labels.length+" выбрано");
  var query = isOpen ? specPickerQuery : "";
  var filtered = query ? specializationsList.filter(function(s){ return s.name.toLowerCase().indexOf(query.toLowerCase())!==-1; }) : specializationsList;
  var html = '<div class="field spec-picker-field" data-stop="1">' +
    '<label>'+escapeHtml(label)+(hint?' <span style="font-weight:400;color:var(--muted-2);">— '+escapeHtml(hint)+'</span>':'')+'</label>' +
    '<button type="button" class="dash-select'+(selectedIds.length?' has-value':'')+'" style="width:100%;" data-action="toggle-spec-picker" data-picker="'+pickerId+'">' +
      '<span class="dash-select-value">'+escapeHtml(summary)+'</span>'+icon("chevron","ic-sm") +
    '</button>';
  if(isOpen){
    html += '<div class="spec-picker-menu">' +
      '<input class="input" id="specPickerSearchInput" placeholder="Поиск специальности…" value="'+escapeHtml(query)+'">';
    if(!filtered.length){
      html += '<div class="dash-menu-empty">Ничего не найдено</div>';
    } else {
      filtered.forEach(function(s){
        var checked = selectedIds.indexOf(s.id)!==-1;
        html += '<label class="dash-menu-item"><input type="checkbox" data-action="toggle-spec-picker-item" data-picker="'+pickerId+'" data-value="'+s.id+'"'+(checked?' checked':'')+'>'+escapeHtml(s.name)+'</label>';
      });
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}
// Единая точка привязки pickerId к реальному массиву-хранилищу выбранных id —
// три разных места (регистрация, «Мой профиль», карточка врача у персонала)
// держат свой черновик состояния, чтобы открытие/поиск в одном не задевал другие.
function specPickerArrayFor(pickerId){
  if(pickerId==="register-current") return registerDraft.specializationIds;
  if(pickerId==="register-desired") return registerDraft.interestIds;
  if(pickerId==="profile-current") return profileEditor.specializationIds;
  if(pickerId==="profile-desired") return profileEditor.interestIds;
  if(pickerId==="staff-current") return staffState.editSpecializationIds;
  return [];
}

// Слои абстрактного «сияния» (стили — .aurora в styles.css): экран входа и плитка курса.
var AURORA_BANDS = '<span class="band b3"></span><span class="band b1"></span><span class="band b2"></span><span class="band b4"></span><span class="grain"></span>';

// Экран входа: сияние «продавливается» курсором, как поверхность воды — ленты
// рядом с курсором мягко отталкиваются и на пружине возвращаются. Двигаем только
// обёртки через transform (размытие не перерисовывается — дёшево для GPU), а
// цикл requestAnimationFrame крутится лишь пока есть движение, потом засыпает.
var auroraFx = null;
function initAuroraFx(){
  var host = document.querySelector(".onb-aurora");
  if(!host || (auroraFx && auroraFx.host===host)) return;
  if(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var ws = Array.prototype.map.call(host.querySelectorAll(".bw"), function(w){ return { el:w, k:+w.getAttribute("data-k")||1, x:0, y:0, tx:0, ty:0 }; });
  var dimple = host.querySelector(".dimple");
  var st = { host:host, px:-9999, py:-9999, raf:0, dx:0, dy:0, dop:0, tdop:0 };
  auroraFx = st;
  function centers(){ ws.forEach(function(w){ var b = w.el.firstElementChild.getBoundingClientRect(); w.cx = b.left + b.width/2; w.cy = b.top + b.height/2; w.r = Math.max(b.width, b.height)/2; }); }
  centers();
  function frame(){
    st.raf = 0;
    if(!host.isConnected){ window.removeEventListener("pointermove", onMove); return; }
    var hr = host.getBoundingClientRect(), moving = false;
    ws.forEach(function(w){
      var vx = (w.cx + w.x) - st.px, vy = (w.cy + w.y) - st.py, d = Math.sqrt(vx*vx+vy*vy) || 1, R = w.r + 220;
      var f = d < R ? Math.pow(1 - d/R, 2) * 120 * w.k : 0;
      w.tx = vx/d*f; w.ty = vy/d*f;
      w.x += (w.tx - w.x)*0.09; w.y += (w.ty - w.y)*0.09;
      if(Math.abs(w.tx-w.x)>0.2 || Math.abs(w.ty-w.y)>0.2) moving = true;
      w.el.style.transform = "translate3d("+w.x.toFixed(1)+"px,"+w.y.toFixed(1)+"px,0)";
    });
    var inside = st.px>hr.left-80 && st.px<hr.right+80 && st.py>hr.top-80 && st.py<hr.bottom+80;
    st.tdop = inside ? 1 : 0;
    st.dop += (st.tdop - st.dop)*0.1; st.dx += ((st.px-hr.left) - st.dx)*0.25; st.dy += ((st.py-hr.top) - st.dy)*0.25;
    if(Math.abs(st.tdop-st.dop)>0.01) moving = true;
    dimple.style.opacity = st.dop.toFixed(3);
    dimple.style.transform = "translate3d("+st.dx.toFixed(1)+"px,"+st.dy.toFixed(1)+"px,0)";
    if(moving) st.raf = requestAnimationFrame(frame);
  }
  function onMove(e){ st.px = e.clientX; st.py = e.clientY; if(!st.raf) st.raf = requestAnimationFrame(frame); }
  window.addEventListener("pointermove", onMove, { passive:true });
  window.addEventListener("resize", centers);
}

function renderAuthScreen(mode){
  var isLogin = mode === "login";
  var left =
    '<div class="onb-left">' +
      '<div><div class="brand">'+brandMark()+'Медицина Долголетия</div>' +
      '<h1 style="margin-top:56px;">'+(isLogin ? "С возвращением" : (registerDraft.asStaff ? "Регистрация сотрудника" : "Регистрация на демо-курс"))+'</h1>' +
      '<p>'+(isLogin ? "Войдите, чтобы продолжить обучение или открыть панель куратора." : (registerDraft.asStaff ? "По приглашению на ваш email и коду сотрудника — сразу в панель куратора." : "Пара полей — и вы сразу в первом уроке."))+'</p></div>' +
      '<div class="onb-aurora aurora" aria-hidden="true">' +
        '<span class="bw" data-k="0.6"><span class="band b3"></span></span><span class="bw" data-k="1"><span class="band b1"></span></span>' +
        '<span class="bw" data-k="1.3"><span class="band b2"></span></span><span class="bw" data-k="0.8"><span class="band b4"></span></span>' +
        '<span class="grain"></span><span class="dimple"></span></div>' +
    '</div>';

  var right;
  if(isLogin){
    right =
      '<div class="onb-right"><div class="onb-box">' +
        '<div class="brand" style="margin-bottom:28px;">'+brandMark()+'Медицина Долголетия</div>' +
        '<h2 style="font-size:20px;margin:0 0 20px;">Вход</h2>' +
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
        '<h2 style="font-size:20px;margin:0 0 14px;">Расскажите о себе</h2>' +
        // Врач и сотрудник регистрируются по-разному: врачу нужна специализация
        // (от неё зависят протоколы), сотруднику — приглашение на email и код.
        '<div class="seg" role="tablist"><button type="button" class="seg-btn'+(registerDraft.asStaff?'':' on')+'" data-action="register-as" data-staff="0">Я врач</button>' +
          '<button type="button" class="seg-btn'+(registerDraft.asStaff?' on':'')+'" data-action="register-as" data-staff="1">Я сотрудник</button></div>' +
        (registerDraft.asStaff ? '<p class="hint" style="margin:-6px 0 14px;">Регистрируйтесь на email, на который вам отправили приглашение, и введите код сотрудника — его называет пригласивший. Специализация не нужна.</p>' : '') +
        '<form id="registerForm">' +
          '<div class="field"><label>Имя и фамилия</label><input class="input" id="registerName" required placeholder="Например, Анна Ковалёва" value="'+escapeHtml(registerDraft.name)+'"></div>' +
          (registerDraft.asStaff ? '' : renderSpecPicker("register-current", "Текущая специализация", null, registerDraft.specializationIds)+
          renderSpecPicker("register-desired", "Желаемые специализации", "выберите специализации, в которых хотите развиваться, можно оставить поле пустым", registerDraft.interestIds)) +
          '<div class="field"><label>Email</label><input class="input" type="email" id="registerEmail" required value="'+escapeHtml(registerDraft.email)+'"></div>' +
          '<div class="field"><label>Телефон <span style="font-weight:400;color:var(--muted-2);">(необязательно)</span></label><input class="input" type="tel" id="registerPhone" value="'+escapeHtml(registerDraft.phone)+'"></div>' +
          '<div class="field"><label>Пароль <span style="font-weight:400;color:var(--muted-2);">(от 6 символов)</span></label><input class="input" type="password" id="registerPassword" required minlength="6" value="'+escapeHtml(registerDraft.password)+'"></div>' +
          (registerDraft.asStaff ? '<div class="field"><label>Код сотрудника <span style="font-weight:400;color:var(--muted-2);">(уточните код у пригласившего)</span></label><input class="input" id="registerStaffCode" required placeholder="Например, 6A794ZF9" value="'+escapeHtml(registerDraft.staffInviteCode)+'"></div>' : '') +
          '<div class="err-text" id="authError" style="display:none;"></div>' +
          '<button class="btn btn-primary btn-block" type="submit">'+(registerDraft.asStaff?'Зарегистрироваться':'Начать курс')+'</button>' +
        '</form>' +
      '</div></div>';
  }
  return el('<div class="onb-shell">'+left+right+'</div>');
}

/* ============================= РЕНДЕР: БОКОВАЯ НАВИГАЦИЯ ============================= */
// Напоминания об эфирах считаем на лету из уже загруженного календаря — они не
// хранятся в базе (нет кронджоба, который бы их "погасил"), поэтому просто
// подмешиваем их в список уведомлений (страница «Уведомления» и счётчик бейджа).
function upcomingEventReminders(){
  var mySid = me.stream_id || "";
  var now = new Date();
  var reminders = [];
  (calendarState.events||[]).forEach(function(ev){
    if(ev.stream_id && ev.stream_id!==mySid) return;
    var start = new Date(ev.event_date+"T"+(ev.event_time||"00:00")+":00");
    var minsLeft = (start.getTime()-now.getTime())/60000;
    if(minsLeft>0 && minsLeft<=30){
      reminders.push({ id:"ev-"+ev.id, synthetic:true, title:"До эфира «"+ev.title+"» "+Math.round(minsLeft)+" мин", body:null, created_at:now.toISOString() });
    }
  });
  return reminders;
}

var sidebarGroupsOpen = (function(){ try{ return JSON.parse(localStorage.getItem("lms-nav-groups")||"{}"); }catch(e){ return {}; } })();
function sidebarGroup(id, iconName, label, activeKey, children){
  var hasActive = children.some(function(c){ return c[0]===activeKey; });
  var open = hasActive || !!sidebarGroupsOpen[id];
  // Бейдж пункта (например, непроверенные задания) виден и на свёрнутой группе.
  var badgeSum = children.reduce(function(n,c){ return n + (c[3]||0); }, 0);
  var h = '<div class="nav-group'+(open?' open':'')+(hasActive?' has-active':'')+'">' +
    '<button type="button" class="sidebar-item nav-group-head" data-action="sidebar-group" data-group="'+id+'" title="'+escapeHtml(label)+'" aria-expanded="'+open+'">' +
      icon(iconName)+'<span class="sidebar-item-label">'+escapeHtml(label)+'</span>' +
      (badgeSum>0 && !open ? '<span class="sidebar-item-badge">'+(badgeSum>9?"9+":badgeSum)+'</span><span class="sidebar-item-dot"></span>' : '') +
      '<span class="nav-chev">'+icon("chevron","ic-sm")+'</span></button>' +
    '<div class="nav-sub">';
  children.forEach(function(c){ h += sidebarItem(c[0], c[1], c[2], c[0]===activeKey, c[3]); });
  return h + '</div></div>';
}
function sidebarItem(key, iconName, label, active, badge){
  // Настоящая ссылка (не <button>), чтобы браузер сам предлагал «Открыть в новой
  // вкладке» по ПКМ и открывал в новой вкладке по Ctrl/⌘+клику или клику средней
  // кнопкой — это не меняет URL при обычном клике (см. navigateToTab: клик
  // гасится через preventDefault), а только даёт данные о разделе для тех
  // способов открытия, которые браузер обрабатывает сам, в обход наших обработчиков.
  // ?tab=… читается при загрузке в routeAfterLogin — так открытая в новой вкладке
  // ссылка попадает сразу в нужный раздел, а не на главную.
  return '<a href="?tab='+encodeURIComponent(key)+'" class="sidebar-item'+(active?' active':'')+'" data-action="sidebar-nav" data-key="'+key+'" title="'+escapeHtml(label)+'">' +
    (key==="profile" && me && me.avatar_url ? '<img class="sidebar-av" src="'+escapeHtml(me.avatar_url)+'" alt="">' : icon(iconName)) +
    '<span class="sidebar-item-label">'+escapeHtml(label)+'</span>' +
    (badge>0 ? '<span class="sidebar-item-badge">'+(badge>9?"9+":badge)+'</span><span class="sidebar-item-dot"></span>' : '') +
  '</a>';
}

function renderSidebar(){
  var items = "";
  if(view==="student"){
    var navKey = studentState.navKey || "course";
    if(previewMode){
      items += sidebarItem("course","home","Главная", navKey==="course");
      items += sidebarItem("schedule","calendar","Расписание", navKey==="schedule");
    } else {
      var notifBadge = notifState.unreadCount + upcomingEventReminders().length;
      items += sidebarItem("profile","user","Мой профиль", navKey==="profile");
      items += sidebarItem("course","home","Главная", navKey==="course");
      items += sidebarItem("materials","list","Мой конспект", navKey==="materials");
      items += sidebarItem("progress","chartbar","Мой прогресс", navKey==="progress");
      // См. protocolsSectionAvailable — до этого момента в коллекции нечему появиться.
      if(course && protocolsSectionAvailable()){
        items += sidebarItem("protocols","doctor","Ваши протоколы", navKey==="protocols");
      }
      items += sidebarItem("schedule","calendar","Расписание", navKey==="schedule");
      items += sidebarItem("telegram","message","Telegram", navKey==="telegram");
      items += sidebarItem("notifications","bell","Уведомления", navKey==="notifications", notifBadge);
      items += sidebarItem("settings","gear","Настройки", navKey==="settings");
    }
  } else {
    var snavKey = staffState.navKey || "students";
    var isAdmin = me.role==="admin" || me.role==="super_admin";
    var staffNotifBadge = upcomingEventReminders().length + (notifState.unreadCount||0);
    // Меню по задачам: главная → врачи и их ответы → расписание → обучение →
    // продажи → управление. «Мой профиль» — вниз, к настройкам: у персонала он
    // нужен редко.
    items += sidebarItem("home","home","Главная", snavKey==="home");
    items += sidebarGroup("people","users","Врачи", snavKey, [
      ["students","users","Список врачей"], ["dashboard","chartbar","Аналитика"]
    ]);
    items += sidebarGroup("answers","task","Ответы врачей", snavKey, [
      ["assignments","task","Проверка заданий", (toolsState.assign.counts||{}).pending||0], ["feed","feed","Лента ответов"], ["surveys","poll","Анкеты"]
    ]);
    items += sidebarItem("calendar","calendar","Расписание", snavKey==="calendar");
    // «Уроки» объединяют прежние «Учебные материалы» и «Модули»: модули — секции списка.
    items += sidebarGroup("learning","book","Обучение", snavKey, (isAdmin?[["courses","folder","Курсы"]]:[]).concat([
      ["materials","folder","Уроки"]], [["glossary","book","Термины"], ["protocols","doctor","Протоколы"]]));
    items += sidebarGroup("sales","wallet","Продажи", snavKey, [
      ["orders","wallet","Заказы и оплаты", (toolsState.orders.summary||{}).overdueOrders||0]].concat(isAdmin?[["products","folder","Продукты"]]:[]));
    if(isAdmin){
      items += sidebarGroup("admin","shield","Управление", snavKey, [
        ["team","users","Команда"], ["specializations","doctor","Специализации"], ["audit","list","Журнал действий"]
      ]);
    }
    items += sidebarItem("telegram","message","Telegram", snavKey==="telegram");
    items += sidebarItem("notifications","bell","Уведомления", snavKey==="notifications", staffNotifBadge);
    items += sidebarItem("profile","user","Мой профиль", snavKey==="profile");
    items += sidebarItem("settings","gear","Настройки", snavKey==="settings");
  }

  // Пункты «Мой профиль» и «Настройки» — в нижней строке профиля, в списке их нет.
  items = items.replace(/<a [^>]*data-key="(profile|settings)"[\s\S]*?<\/a>/g, "");
  // Разделители между смысловыми группами: у врача «учёба | общение», у сотрудников — перед связью.
  if(view==="student"){ if(!previewMode) items = items.replace(/(<a [^>]*data-key="schedule")/, '<div class="sbx-hr"></div>$1'); }
  else items = items.replace(/(<a [^>]*data-key="telegram")/, '<div class="sbx-hr"></div>$1');
  // Идёт эфир — точка у «Расписания».
  if(liveEventNow()) items = items.replace(/(data-key="(?:schedule|calendar)"[^>]*>[\s\S]*?)(<\/a>)/, '$1<span class="sbx-live" title="Идёт эфир"></span>$2');

  var collapsed = sidebarCollapsed() && !mobileNavOpen;
  var top, next = "", meRow;
  if(view==="student" && course && course.lessons){
    var pr = course.progress || {}, doneIds = pr.completed_lessons || [], total = course.lessons.length;
    var pct = Math.round((doneIds.length + (pr.completed?1:0)) / (total+1) * 100);
    top = '<div class="sbx-ring" style="--p:'+pct+'%"><b>'+pct+'%</b></div>' +
      '<div class="sbx-title"><strong>'+escapeHtml(course.course.title)+'</strong><span>'+doneIds.length+' из '+total+' '+ruPluralClient(total,"урока","уроков","уроков")+'</span></div>';
    var curIdx = -1; course.lessons.forEach(function(l,i){ if(curIdx<0 && doneIds.indexOf(l.id)===-1 && !l.hiddenForMe && !l.dripLockedForMe) curIdx = i; });
    if(!previewMode && !(course.locked||{}).locked && studentState.tab!=="lesson"){
      if(curIdx>=0){
        var nl = course.lessons[curIdx];
        next = '<button type="button" class="sbx-next" data-action="open-lesson-at" data-idx="'+curIdx+'" title="Продолжить: '+escapeHtml(nl.title)+'"><span class="sbx-next-k">Продолжить'+(nl.duration?' · '+escapeHtml(nl.duration):'')+'</span><b>'+escapeHtml(nl.title)+'</b><span class="sbx-go">'+icon("go")+'</span></button>';
      } else if(!pr.completed && !course.quizHiddenForMe){
        next = '<button type="button" class="sbx-next" data-action="open-final-quiz" title="Итоговый тест"><span class="sbx-next-k">Остался последний шаг</span><b>Итоговый тест</b><span class="sbx-go">'+icon("go")+'</span></button>';
      }
    }
  } else {
    var roleLabel = { super_admin:"Главный администратор", admin:"Администратор", curator:"Куратор", student:"Врач" }[me && me.role] || "";
    top = '<div class="sbx-mark">'+icon("doctor")+'</div><div class="sbx-title"><strong>Медицина Долголетия</strong><span>'+(view==="student"?"Демо-курс":escapeHtml(roleLabel))+'</span></div>';
  }
  var navKeyNow = view==="student" ? (studentState.navKey||"course") : (staffState.navKey||"home");
  if(previewMode){
    meRow = '<div class="sbx-me"><button type="button" class="sidebar-item sbx-exit" data-action="exit-preview" title="Вернуться в панель">'+icon("logout")+'<span class="sidebar-item-label">Вернуться в панель</span></button></div>';
  } else {
    var gam = view==="student" && course ? (course.gamification||{}) : null;
    var sub = gam ? (gam.currentStreak ? icon("flame","sbx-flame")+gam.currentStreak+' '+ruPluralClient(gam.currentStreak,"день","дня","дней")+' · ' : '')+(gam.points||0)+' очков' : escapeHtml(({ super_admin:"Главный администратор", admin:"Администратор", curator:"Куратор" })[me.role]||"");
    meRow = '<div class="sbx-me">' +
      '<a href="?tab=profile" class="sbx-who'+(navKeyNow==="profile"?' active':'')+'" data-action="sidebar-nav" data-key="profile" title="Мой профиль">'+userAvatar(me,"sbx-av")+'<span class="sbx-who-t"><b>'+escapeHtml(me.name||"")+'</b><span>'+sub+'</span></span></a>' +
      '<span class="sbx-btns"><a href="?tab=settings" class="sbx-ib'+(navKeyNow==="settings"?' on':'')+'" data-action="sidebar-nav" data-key="settings" title="Настройки">'+icon("gear")+'</a>' +
      '<button type="button" class="sbx-ib" data-action="logout" title="Выйти">'+icon("logout")+'</button></span></div>';
  }
  return el(
    '<div class="sidebar sbx'+(collapsed?' collapsed':'')+(mobileNavOpen?' mobile-open':'')+'">' +
      '<div class="sbx-top">'+top +
        '<button type="button" class="sbx-collapse" data-action="toggle-sidebar" title="'+(collapsed?'Развернуть меню':'Свернуть меню')+'" aria-label="'+(collapsed?'Развернуть меню':'Свернуть меню')+'">'+icon("panel")+'</button>' +
        '<button type="button" class="sidebar-toggle" data-action="toggle-mobile-nav" title="Меню" aria-label="Меню">'+icon(mobileNavOpen?"close":"menu")+'</button>' +
      '</div>' +
      '<div class="sidebar-nav">'+items+'</div>' + next + meRow +
    '</div>'
  );
}
// Свёрнутый сайдбар — выбор пользователя, хранится в браузере.
function sidebarCollapsed(){ try{ return localStorage.getItem("lms-sb-collapsed")==="1"; }catch(e){ return false; } }
function liveEventNow(){
  if(!me) return null;
  var mySid = me.stream_id || "", now = new Date();
  return (calendarState.events||[]).filter(function(ev){ return view!=="student" || !ev.stream_id || ev.stream_id===mySid; }).find(function(ev){
    var st = new Date(ev.event_date+"T"+(ev.event_time||"00:00")), en = new Date(st.getTime() + (ev.duration_min||60)*60000);
    return st<=now && now<=en;
  }) || null;
}

// Подложка мобильного меню — отдельный элемент (не вложенный в .sidebar), чтобы
// не ломать связь .sidebar ~ .app-main в CSS (сдвиг контента под раскрытый
// сайдбар на десктопе завязан на то, что они прямые соседи).
function renderMobileNavBackdrop(){
  return mobileNavOpen ? el('<div class="sidebar-backdrop" data-action="close-mobile-nav"></div>') : null;
}

// Темы: «Тёмная» — дефолт продукта, «Светлая», «Глубина» — тёмная тема на двух
// цветах (фиолетовый + красный) с туманностью за стеклом, и две темы с живым фоном
// на весь экран — «Созвездие» (ночное небо с Млечным Путём) и «Клетки» (живая
// ткань под микроскопом). Все тёмные строятся поверх тёмной (data-theme="dark"),
// три последние — ещё и поверх «Глубины» (data-look="depth"), поэтому всё, что
// рассчитано на тёмную тему, в них работает без отдельных правил; живой фон и
// плотное стекло добавляет data-sky.
var THEMES = ["dark","light","depth","stars","cells"];
var SKY_THEMES = { stars:1, cells:1 };
function getTheme(){
  var v = null; try{ v = localStorage.getItem("lms-theme"); }catch(e){}
  var q = /[?&]theme=(dark|light|depth|stars|cells)/.exec(location.search); if(q) v = q[1];
  return THEMES.indexOf(v)>=0 ? v : "dark";
}
function applyTheme(){
  var t = getTheme(), root = document.documentElement;
  root.setAttribute("data-theme", t==="light" ? "light" : "dark");
  if(t==="depth" || SKY_THEMES[t]) root.setAttribute("data-look", "depth"); else root.removeAttribute("data-look");
  if(SKY_THEMES[t]) root.setAttribute("data-sky", t); else root.removeAttribute("data-sky");
  skyStart(SKY_THEMES[t] ? t : null);
}
function setTheme(t){
  try{
    localStorage.setItem("lms-theme", t);
    if(t!=="light") localStorage.setItem("lms-theme-dark", t);
  }catch(e){}
  applyTheme();
}

/* ---------- Живой фон тем «Созвездие» и «Клетки» (WebGL) ---------- */
// Один холст на всё окно под приложением (вне #app — перерисовка его не трогает).
// Кадры не чаще 30 в секунду и только пока вкладка видна; при «уменьшить движение»
// рисуется один неподвижный кадр; без WebGL остаётся туманность «Глубины».
var SKY_VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
var SKY_FS = {
  stars: "precision highp float;uniform vec2 R;uniform float T;uniform vec2 M;float h1(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}vec2 h2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}float n2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h1(i),h1(i+vec2(1,0)),f.x),mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x),f.y);}float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n2(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}vec3 pal(float x){vec3 a=vec3(.616,.482,1.),b=vec3(1.,.302,.427),c=vec3(1.,.72,.42),d=vec3(.247,.816,.788);x=fract(x)*4.;return x<1.?mix(a,b,x):x<2.?mix(b,c,x-1.):x<3.?mix(c,d,x-2.):mix(d,a,x-3.);}vec3 finish(vec3 c,vec2 uv){c*=1.-.55*pow(length((uv-.5)*vec2(1.1,1.25)),2.2);c=1.-exp(-c*1.35);return pow(c,vec3(.95));}vec3 temp(float k){return k<.33?mix(vec3(.62,.72,1.),vec3(1.),k*3.):k<.75?mix(vec3(1.),vec3(1.,.9,.72),(k-.33)*2.4):mix(vec3(1.,.9,.72),vec3(1.,.66,.5),(k-.75)*4.);}vec3 layer(vec2 p,float sc,float th,float sz){vec2 g=p*sc;vec2 ip=floor(g),fp=fract(g);vec3 acc=vec3(0.); for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 o=vec2(float(x),float(y));vec2 id=ip+o;float r=h1(id);if(r<th)continue;  vec2 pos=o+h2(id)*.8+.1-fp;float win=smoothstep(1.35,.6,length(pos));float d=length(pos)/sc;float b=pow((r-th)/(1.-th),3.);  float tw=.7+.3*sin(T*(1.+h1(id+3.)*3.)+r*40.);vec3 c=temp(h1(id+7.));  float core=exp(-d*d/(sz*sz*(.6+b*2.)));float halo=exp(-d*d/(sz*sz*(9.+b*60.)))*.18*b;  vec2 q=abs(pos/sc);float spike=b>.8?(exp(-q.x*2600.)*exp(-q.y*160.)+exp(-q.y*2600.)*exp(-q.x*160.))*(b-.8)*3.:0.;  acc+=c*(core*b*1.6+halo+spike)*tw*win;}return acc;}void main(){vec2 uv=gl_FragCoord.xy/R;float a=R.x/R.y;vec2 p=vec2(uv.x*a,uv.y);vec2 m=step(0.,M.x)*(M/R-.5);float t=T*.01;vec3 col=mix(vec3(.010,.006,.022),vec3(.022,.012,.045),uv.y);vec2 bp=p-vec2(a*.5,.5)-m*.02;float bd=bp.x*.55+bp.y*.84;float band=exp(-bd*bd*9.);float neb=fbm(p*1.6+vec2(t,t*.6));float neb2=fbm(p*4.+neb*1.5);vec3 nc=mix(vec3(.38,.25,.75),vec3(.85,.30,.45),smoothstep(.35,.75,neb));nc=mix(nc,vec3(.95,.70,.48),smoothstep(.6,.85,neb2)*.35);float dust=smoothstep(.45,.75,fbm(p*3.2+vec2(5.,t*2.)));col+=nc*band*neb*.5*(1.-dust*.8);col+=vec3(.6,.55,.85)*band*.05;col+=layer(p-m*.010,110.,.90,0.00080)*(.25+band*1.2);col+=layer(p-m*.025,40.,.93,0.00110)*(.6+band*.6);col+=layer(p-m*.050,13.,.95,0.00150);gl_FragColor=vec4(finish(col,uv),1.);}",
  cells: "precision highp float;uniform vec2 R;uniform float T;uniform vec2 M;float h1(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}vec2 h2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}float n2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h1(i),h1(i+vec2(1,0)),f.x),mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),f.x),f.y);}float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n2(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}vec3 pal(float x){vec3 a=vec3(.616,.482,1.),b=vec3(1.,.302,.427),c=vec3(1.,.72,.42),d=vec3(.247,.816,.788);x=fract(x)*4.;return x<1.?mix(a,b,x):x<2.?mix(b,c,x-1.):x<3.?mix(c,d,x-2.):mix(d,a,x-3.);}vec3 finish(vec3 c,vec2 uv){c*=1.-.55*pow(length((uv-.5)*vec2(1.1,1.25)),2.2);c=1.-exp(-c*1.35);return pow(c,vec3(.95));}void main(){vec2 uv=gl_FragCoord.xy/R;vec2 p=gl_FragCoord.xy/R.y*2.2;float t=T*.25;vec2 mm=M/R.y*2.2;vec2 dm=p-mm;float push=step(0.,M.x)*.35*exp(-dot(dm,dm)*1.6);p+=normalize(dm+1e-4)*push;p+=.18*vec2(fbm(p*.6+t*.3),fbm(p*.6-t*.25+4.))-.09;vec2 ip=floor(p),fp=fract(p);float d1=8.,d2=8.;vec2 cid=vec2(0.);for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 g=vec2(float(x),float(y));vec2 o=h2(ip+g);o=.5+.34*sin(t*.8+6.2831*o); vec2 r=g+o-fp;float d=dot(r,r);if(d<d1){d2=d1;d1=d;cid=ip+g;}else if(d<d2)d2=d;}float e=sqrt(d2)-sqrt(d1);float k=h1(cid);vec3 c=pal(k*.9+.05);float alive=smoothstep(.25,.5,k);float mem=exp(-e*e*260.)*.9+exp(-e*e*28.)*.18;float inside=smoothstep(0.,.35,e);float breath=.8+.2*sin(T*.9+k*20.);float nuc=exp(-d1*(22.+8.*k))*breath;float nuc2=exp(-d1*90.)*breath;float org=smoothstep(.62,.9,fbm(p*5.+cid*3.+t))*inside*.35;vec3 col=vec3(.016,.010,.032);col+=c*inside*.03*alive+c*org*.08*alive;col+=mix(c,vec3(1.),.1)*mem*.22*(.45+.55*alive);col+=c*nuc*.28*alive+vec3(1.,.95,1.)*nuc2*.14*alive;float dof=smoothstep(.15,.75,fbm(uv*1.4+vec2(t*.05,0.)));col*=mix(.55,1.05,dof);gl_FragColor=vec4(finish(col*.85,uv),1.);}"
};
var sky = { kind:null, cv:null, gl:null, raf:0, t0:0, last:0, mouse:[-1,-1], target:[-1,-1] };
function skyStart(kind){
  if(sky.kind===kind) return;
  skyStop();
  if(!kind || !document.body) return;
  var cv = document.createElement("canvas"); cv.id = "skyCanvas"; cv.setAttribute("aria-hidden", "true");
  var grain = document.createElement("div"); grain.id = "skyGrain"; grain.setAttribute("aria-hidden", "true");
  document.body.insertBefore(grain, document.body.firstChild); document.body.insertBefore(cv, document.body.firstChild);
  var gl = null; try{ gl = cv.getContext("webgl", { antialias:false, alpha:false }); }catch(e){}
  if(!gl){ cv.remove(); grain.remove(); document.documentElement.removeAttribute("data-sky"); return; }
  function sh(type, src){ var x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; }
  var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, SKY_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, SKY_FS[kind])); gl.linkProgram(pr);
  if(!gl.getProgramParameter(pr, gl.LINK_STATUS)){ cv.remove(); grain.remove(); document.documentElement.removeAttribute("data-sky"); return; }
  gl.useProgram(pr);
  var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  var lp = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
  sky.u = { R:gl.getUniformLocation(pr, "R"), T:gl.getUniformLocation(pr, "T"), M:gl.getUniformLocation(pr, "M") };
  sky.kind = kind; sky.cv = cv; sky.grain = grain; sky.gl = gl; sky.t0 = performance.now();
  sky.raf = requestAnimationFrame(skyFrame);
}
function skyStop(){
  if(sky.raf) cancelAnimationFrame(sky.raf);
  if(sky.cv) sky.cv.remove(); if(sky.grain) sky.grain.remove();
  if(sky.gl){ var ext = sky.gl.getExtension("WEBGL_lose_context"); if(ext) ext.loseContext(); }
  sky.kind = null; sky.cv = null; sky.grain = null; sky.gl = null; sky.raf = 0;
}
function skyFrame(now){
  sky.raf = 0;
  if(!sky.gl) return;
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!document.hidden && (now - sky.last >= 33 || !sky.last)){
    sky.last = now;
    var gl = sky.gl, d = Math.min(1.5, window.devicePixelRatio||1), W = Math.round(innerWidth*d), H = Math.round(innerHeight*d);
    if(sky.cv.width!==W || sky.cv.height!==H){ sky.cv.width = W; sky.cv.height = H; gl.viewport(0, 0, W, H); }
    var tg = sky.target; sky.mouse = tg[0]<0 ? [-1,-1] : (sky.mouse[0]<0 ? tg.slice() : [sky.mouse[0]+(tg[0]-sky.mouse[0])*.08, sky.mouse[1]+(tg[1]-sky.mouse[1])*.08]);
    gl.uniform2f(sky.u.R, W, H); gl.uniform1f(sky.u.T, still ? 20 : 20 + (now - sky.t0)/1000);
    gl.uniform2f(sky.u.M, sky.mouse[0]*d, sky.mouse[1]*d);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if(still) return;
  }
  sky.raf = requestAnimationFrame(skyFrame);
}
document.addEventListener("pointermove", function(e){ if(sky.kind) sky.target = [e.clientX, innerHeight - e.clientY]; }, { passive:true });
document.addEventListener("visibilitychange", function(){ if(sky.gl && !sky.raf && !document.hidden) sky.raf = requestAnimationFrame(skyFrame); });

// Переключатель в меню: светлая ↔ последняя из тёмных.
function toggleTheme(){
  var back = null; try{ back = localStorage.getItem("lms-theme-dark"); }catch(e){}
  setTheme(getTheme()==="light" ? (THEMES.indexOf(back)>0 && back!=="light" ? back : "dark") : "light");
}

/* ============================= РЕНДЕР: СТУДЕНТ ============================= */
// «Растекающийся» свет в полях страницы (стили .side-flow). Кладём в .app-main
// ДО .shell: слои закреплены относительно окна и должны лежать под контентом.
function addSideFlow(main){
  var blobs = '<span class="blob f1"></span><span class="blob f2"></span><span class="blob f3"></span><span class="blob f4"></span>';
  var shell = main.querySelector(".shell");
  [["l"],["r"]].forEach(function(side){
    var node = el('<div class="side-flow '+side[0]+'" aria-hidden="true">'+blobs+'</div>');
    if(shell) main.insertBefore(node, shell); else main.appendChild(node);
  });
}

// «Искры» — редкие огоньки (красный, янтарный, фиолетовый) медленно поднимаются
// за стеклянными плитками главной и слегка расходятся от курсора. Частицы живут
// вне DOM, поэтому перерисовка страницы (раз в 30 с) их не сбрасывает: цикл просто
// находит новый холст. 30 кадров/с, без курсора и при «уменьшить движение» — нет.
var embers = [], emberRaf = 0, emberLast = 0, emberMouse = { x:-9999, y:-9999 };
document.addEventListener("pointermove", function(e){ emberMouse.x = e.clientX; emberMouse.y = e.clientY; }, { passive:true });
function ensureEmbers(){
  if(emberRaf || !document.querySelector(".fx-ember-cv")) return;
  if(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  emberRaf = requestAnimationFrame(emberTick);
}
function emberSpawn(w, h, anywhere){
  var cs = getComputedStyle(document.documentElement), pick = Math.random();
  var pal = HOME_BG_COLORS[homeBg()] || HOME_BG_COLORS["ember-warm"], col = "";
  for(var ci=0; ci<pal.length; ci++){ if(pick < pal[ci][1]){ col = cs.getPropertyValue(pal[ci][0]); break; } }
  return { x: Math.random()*w, y: anywhere ? Math.random()*h : h + 10, r: 1.3 + Math.random()*2.2, vy: .25 + Math.random()*.45,
    ph: Math.random()*6.28, sw: .3 + Math.random()*.5, life: 0, max: 380 + Math.random()*420, col: col.trim() || "#FF4D6D", dx:0 };
}
function emberTick(ts){
  var cv = document.querySelector(".fx-ember-cv");
  if(!cv){ emberRaf = 0; embers = []; return; }
  emberRaf = requestAnimationFrame(emberTick);
  if(ts - emberLast < 33) return; // ~30 кадров/с
  emberLast = ts;
  var host = cv.parentElement, r = host.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio||1);
  var w = Math.round(r.width), h = Math.round(r.height);
  if(cv.width !== w*dpr || cv.height !== h*dpr){ cv.width = w*dpr; cv.height = h*dpr; cv.style.width = w+"px"; cv.style.height = h+"px"; }
  var ctx = cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
  var want = Math.min(90, Math.round(w*h/10000));
  while(embers.length < want) embers.push(emberSpawn(w, h, true)); // сразу по всей площади, а не волной снизу
  if(embers.length > want) embers.length = want;
  var mx = emberMouse.x - r.left, my = emberMouse.y - r.top;
  ctx.globalCompositeOperation = "lighter";
  embers.forEach(function(p, i){
    p.life++; p.y -= p.vy; p.ph += .03;
    var ddx = p.x - mx, ddy = p.y - my, d2 = ddx*ddx + ddy*ddy;
    if(d2 < 14400){ var f = (1 - d2/14400) * 1.6; p.dx += ddx/Math.sqrt(d2+1)*f; }
    p.dx *= .92; p.x += Math.sin(p.ph)*p.sw + p.dx;
    var a = Math.min(1, p.life/60) * Math.min(1, (p.max - p.life)/80);
    if(p.life > p.max || p.y < -20){ embers[i] = emberSpawn(w, h, false); return; }
    var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r*6);
    g.addColorStop(0, p.col); g.addColorStop(1, "transparent");
    ctx.globalAlpha = a*.35; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r*6, 0, 6.283); ctx.fill();
    ctx.globalAlpha = a*.95; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
  });
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
}

// Спираль ДНК (два витка по центру): медленно вращается, звенья по одному плавно
// меняются цветами (фиолет ↔ бирюза), вдоль проходит мягкая волна подсветки.
// Canvas в родном разрешении экрана. Состояние звеньев живёт вне функции, чтобы
// 30-секундная перерисовка приложения не перетасовывала узор скачком; фаза
// вращения берётся от времени страницы — тоже без скачков.
var dnaPairs = [];
function startDnaDecor(host){
  // Спираль ДНК в 3D на обычном canvas 2D (без WebGL): точки нитей считаются в
  // трёх измерениях, проецируются с перспективой, все элементы — отрезки нитей,
  // половинки перемычек, шарики-узлы — сортируются по глубине и рисуются от
  // дальних к ближним. Ближнее крупнее, ярче и толще, дальнее уходит в дымку.
  // Спираль вращается вокруг своей оси и слегка покачивается — объём читается.
  var cv = document.createElement("canvas"); host.appendChild(cv);
  var ctx = cv.getContext("2d");
  var cs = getComputedStyle(document.documentElement);
  var light = document.documentElement.getAttribute("data-theme") === "light";
  function toRgb(h){ h = h.trim().replace("#",""); if(h.length===3) h = h.split("").map(function(c){ return c+c; }).join(""); var n = parseInt(h,16); return [n>>16&255, n>>8&255, n&255]; }
  var V = toRgb(cs.getPropertyValue("--primary")), T = toRgb(cs.getPropertyValue("--teal"));
  // Цвет фона страницы из темы — к нему растворяются дальние части и кончики нитей.
  var bgRaw = cs.getPropertyValue("--bg").trim();
  var BG = /^#([0-9a-f]{3}){1,2}$/i.test(bgRaw) ? toRgb(bgRaw) : (light ? [245,245,247] : [18,18,22]);
  function mix(a,b,k){ return a.map(function(x,i){ return Math.round(x+(b[i]-x)*k); }); }
  function rgba(c,a){ return "rgba("+c[0]+","+c[1]+","+c[2]+","+a+")"; }
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var W = 0, H = 0;
  function size(){ var dpr = Math.min(2, window.devicePixelRatio||1); W = host.clientWidth; H = host.clientHeight; cv.width = W*dpr; cv.height = H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
  size();
  var TURNS = 2, PERIOD = 300, STEP = 20, LEN = TURNS*PERIOD, SAMPLES = 120, last = 0, CAM = 700, prevTs = 0;
  function pair(i){ return dnaPairs[i] || (dnaPairs[i] = { k: Math.random()<.5?0:1, to:null, from:0, t0:0 }); }
  function env(u){ return Math.pow(Math.sin(Math.PI*u), .7); }
  function fade(u){ return Math.min(1, Math.sin(Math.PI*u)*1.6); }
  function frame(ts){
    if(!host.isConnected) return;
    // Украшение с медленным движением — 30 кадров в секунду достаточно, вдвое дешевле.
    if(!reduce && prevTs && ts - prevTs < 30){ requestAnimationFrame(frame); return; }
    prevTs = ts;
    if(host.clientWidth !== W || host.clientHeight !== H) size();
    var t = ts/1000;
    ctx.clearRect(0,0,W,H);
    var cx = W/2, mid = H*.56, R = Math.min(56, H*.26), k = Math.PI*2/PERIOD;
    var spin = reduce ? 0 : t*.45, yaw = reduce ? .18 : .22*Math.sin(t*.23), cyw = Math.cos(yaw), syw = Math.sin(yaw);
    var wave = ((t*70) % (LEN+500)) - 250, n = Math.floor(LEN/STEP);
    if(!reduce && ts-last > 700){ last = ts; var pr = pair(1+Math.floor(Math.random()*(n-1))); if(pr.to===null){ pr.from = pr.k; pr.to = 1-pr.k; pr.t0 = t; } }
    // точка на оси спирали (u — доля длины, a — угол вокруг оси, r — радиус)
    function P(u, a, r){
      var lx = (u-.5)*LEN, ly = Math.sin(a)*r, lz = Math.cos(a)*r;
      var x = lx*cyw - lz*syw, z = lx*syw + lz*cyw;
      var s = CAM/(CAM - z);
      return { x: cx + x*s, y: mid + ly*s, z: z, s: s };
    }
    var items = [];
    // нити: непрерывные куски по CH сэмплов — у каждого своя глубина, толщина и
    // блик; один путь на кусок, поэтому трубка гладкая, без «бусин» на стыках
    var CH = 5;
    [0, Math.PI].forEach(function(off, si){
      var pts = [];
      for(var j=0; j<=SAMPLES; j++){ var u = j/SAMPLES; pts.push(P(u, u*LEN*k + spin + off, R*env(u))); pts[j].u = u; }
      for(var c0=0; c0<SAMPLES; c0+=CH){
        var chunk = pts.slice(c0, Math.min(SAMPLES, c0+CH)+1), zs = 0, uu = 0;
        chunk.forEach(function(q){ zs += q.z; uu += q.u; });
        uu /= chunk.length;
        items.push({ kind:"seg", pts:chunk, a:chunk[Math.floor(chunk.length/2)], z:zs/chunk.length, u:uu, c: mix(si?T:V, si?V:T, uu) });
      }
    });
    // перемычки (пары оснований) — по половинке от каждой нити до центра, и узлы
    for(var i=1; i<n; i++){
      var u2 = i/n, ang = u2*LEN*k + spin, r2 = R*env(u2);
      var pa = P(u2, ang, r2), pb = P(u2, ang+Math.PI, r2), pc = P(u2, 0, 0);
      var pp = pair(i);
      if(pp.to!==null){ var q = Math.min(1,(t-pp.t0)/2); pp.k = pp.from+(pp.to-pp.from)*(q*q*(3-2*q)); if(q>=1){ pp.k = pp.to; pp.to = null; } }
      var glow = Math.max(0, 1-Math.abs(u2*LEN-wave)/140);
      var c1 = mix(V,T,pp.k), c2 = mix(V,T,1-pp.k);
      items.push({ kind:"rung", a:pa, b:pc, z:(pa.z+pc.z)/2, u:u2, c:c1, glow:glow });
      items.push({ kind:"rung", a:pb, b:pc, z:(pb.z+pc.z)/2, u:u2, c:c2, glow:glow });
      items.push({ kind:"node", a:pa, z:pa.z+.5, u:u2, c:c1, glow:glow });
      items.push({ kind:"node", a:pb, z:pb.z+.5, u:u2, c:c2, glow:glow });
    }
    items.sort(function(x,y){ return x.z - y.z; });
    ctx.lineCap = "round";
    items.forEach(function(it){
      var d = Math.max(0, Math.min(1, (it.z + R)/(2*R)));        // 0 — дальняя сторона, 1 — ближняя
      var f = fade(it.u), fog = .35 + .65*d;                      // дымка вдали
      // Цвета нитей непрозрачные, заранее смешанные с фоном (и дымкой, и затуханием
      // к концам), — иначе полупрозрачные отрезки накладывались на стыках «бусами».
      var col = mix(BG, it.c, fog * f * (light ? 1 : 1.08) > 1 ? 1 : fog * f * (light ? 1 : 1.08));
      if(it.kind==="seg"){
        var w = (2.2 + d*3.6) * it.a.s, path = function(dy){ ctx.beginPath(); it.pts.forEach(function(q, qi){ if(qi) ctx.lineTo(q.x, q.y+dy); else ctx.moveTo(q.x, q.y+dy); }); ctx.stroke(); };
        ctx.lineJoin = "round";
        ctx.strokeStyle = rgba(mix(col, BG, light ? .1 : .12), 1); ctx.lineWidth = w; path(0);   // тело трубки
        // блик — светлее цвета нити (не белый), гаснет вместе с нитью к концам
        ctx.strokeStyle = rgba(mix(col, light ? [255,255,255] : mix(it.c,[255,255,255],.5), (light ? .35 : .25 + d*.3) * f), 1);
        ctx.lineWidth = Math.max(.7, w*.34); path(-w*.17);
      } else if(it.kind==="rung"){
        ctx.strokeStyle = rgba(col, f*((light?.22:.28) + d*(light?.32:.45) + it.glow*.3));
        ctx.lineWidth = (1.2 + d*1.8) * it.a.s;
        ctx.beginPath(); ctx.moveTo(it.a.x, it.a.y); ctx.lineTo(it.b.x, it.b.y); ctx.stroke();
      } else {
        // Шарик: мягкий ореол (дешёвая замена shadowBlur), тело и блик сверху-слева.
        var r = (1.8 + d*2.6) * it.a.s * (1 + it.glow*.35);
        if(d > .6 || it.glow > .25){ ctx.fillStyle = rgba(it.c, ((light ? .05 : .09) + it.glow*(light ? .1 : .18)) * f); ctx.beginPath(); ctx.arc(it.a.x, it.a.y, r*1.8, 0, 7); ctx.fill(); }
        ctx.fillStyle = rgba(col, 1); ctx.beginPath(); ctx.arc(it.a.x, it.a.y, r, 0, 7); ctx.fill();
        ctx.fillStyle = rgba(mix(col, [255,255,255], .55), .9 * f); ctx.beginPath(); ctx.arc(it.a.x - r*.32, it.a.y - r*.32, r*.38, 0, 7); ctx.fill();
      }
    });
    if(!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderStudentShell(){
  var wrap = el('<div></div>');
  var mobNavBackdrop = renderMobileNavBackdrop();
  if(mobNavBackdrop) wrap.appendChild(mobNavBackdrop);
  wrap.appendChild(renderSidebar());
  var main = el('<div class="app-main"></div>');
  wrap.appendChild(main);
  if(me && me.impersonator){
    main.appendChild(el('<div class="imp-bar">'+icon("eye")+'<span>Вы смотрите кабинет глазами врача <b>'+escapeHtml(me.name)+'</b> — только просмотр, врач этого не видит</span>' +
      '<button class="btn btn-sm" data-action="impersonate-stop">Вернуться в панель</button></div>'));
  }
  if(previewMode){
    main.appendChild(el('<div style="background:var(--accent);color:#1B1A14;text-align:center;padding:10px 16px;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;">'+icon("eye")+' Режим просмотра «глазами врача» — изменения не сохраняются</div>'));
  }
  if(course && studentState.tab === "lesson") addSideFlow(main);
  // Внизу «Моего прогресса» под карточками — анимированная спираль ДНК (декор).
  if(course && studentState.tab === "progress"){
    var dnaHost = el('<div class="dna-decor" aria-hidden="true"></div>');
    main.appendChild(dnaHost);
    startDnaDecor(dnaHost);
  }
  var shell = el('<div class="shell"><div class="wrap'+(course && studentState.tab==="course" && !previewMode ? ' wrap-wide' : '')+'" id="studentContent"></div></div>');
  main.appendChild(shell);
  var content = shell.querySelector("#studentContent");

  if(!course){
    content.appendChild(el('<div class="empty-state">Не удалось загрузить курс.</div>'));
    return wrap;
  }

  if(studentEnrollments.length > 1){
    content.appendChild(renderCourseSwitcher());
  }

  if(studentState.tab === "lesson"){
    content.appendChild(renderCoursePlayer());
  } else if(studentState.tab === "schedule"){
    content.appendChild(renderStudentSchedule());
  } else if(studentState.tab === "materials" && !previewMode){
    content.appendChild(renderStudentMaterials());
  } else if(studentState.tab === "progress" && !previewMode){
    content.appendChild(renderMyProgressPage());
  } else if(studentState.tab === "protocols" && !previewMode){
    content.appendChild(renderProtocolsPage());
  } else if(studentState.tab === "notifications" && !previewMode){
    content.appendChild(renderNotificationsPage());
  } else if(studentState.tab === "telegram" && !previewMode){
    content.appendChild(renderTelegramPage());
  } else if(studentState.tab === "settings" && !previewMode){
    content.appendChild(renderSettingsPage());
  } else if(studentState.tab === "profile" && !previewMode){
    content.appendChild(renderMyProfilePage());
  } else {
    content.appendChild(renderStudentHome());
  }
  return wrap;
}

// Показывается только когда врач записан больше чем на один курс — переключает
// activeCourseId и перезагружает GET /course/content/:courseId целиком.
function renderCourseSwitcher(){
  var html = '<div class="tabs" style="margin-bottom:14px;">';
  studentEnrollments.forEach(function(en){
    html += '<button type="button" class="tab'+(en.courseId===activeCourseId?' active':'')+'" data-action="switch-course" data-course-id="'+en.courseId+'">'+escapeHtml(en.title)+'</button>';
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

  function startOf(ev){ return new Date(ev.event_date+"T"+(ev.event_time||"00:00")+":00"); }
  var WD = ["вс","пн","вт","ср","чт","пт","сб"];
  function whenLabel(ev){
    var d = startOf(ev), today = new Date(); today.setHours(0,0,0,0);
    var day = new Date(d); day.setHours(0,0,0,0);
    var diff = Math.round((day - today)/86400000);
    return diff===0 ? "сегодня" : diff===1 ? "завтра" : diff>1 ? "через "+diff+" дн." : "";
  }
  function dateLine(ev){
    var d = startOf(ev);
    return WD[d.getDay()]+", "+d.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})+" · "+escapeHtml(ev.event_time||"—");
  }
  function actions(ev, live, primary){
    return '<div class="sched-actions">' +
      (ev.join_url?'<a class="btn btn-sm '+(live||primary?'btn-primary':'btn-ghost')+'" href="'+escapeHtml(ev.join_url)+'" target="_blank" rel="noopener">Подключиться</a>':'') +
      '<button class="btn btn-sm btn-ghost" data-action="download-ics" data-id="'+ev.id+'">В календарь</button></div>';
  }
  function row(ev, isUpcoming){
    var live = isUpcoming && isLiveNow(ev), d = startOf(ev);
    return '<div class="sched-row">' +
      '<div class="sched-date"><b>'+d.getDate()+'</b><span>'+d.toLocaleDateString("ru-RU",{month:"short"}).replace(".","")+'</span></div>' +
      '<div class="sched-info">'+(live?magnet("live","В эфире"):'')+'<b>'+escapeHtml(ev.title)+'</b>' +
      '<span>'+dateLine(ev)+(ev.speaker?' · '+escapeHtml(ev.speaker):'')+'</span></div>' +
      (isUpcoming ? actions(ev, live, false) : '') +
    '</div>';
  }

  // Мини-календарь месяца: месяц ближайшего эфира (или текущий), дни с эфирами отмечены.
  function monthCalendar(){
    var base = upcoming.length ? startOf(upcoming[0]) : new Date();
    var y = base.getFullYear(), m = base.getMonth();
    var marked = {};
    relevant.forEach(function(ev){ var d = startOf(ev); if(d.getFullYear()===y && d.getMonth()===m) marked[d.getDate()] = true; });
    var todayD = new Date(), isThisMonth = todayD.getFullYear()===y && todayD.getMonth()===m;
    var first = (new Date(y, m, 1).getDay()+6)%7, days = new Date(y, m+1, 0).getDate();
    var title = new Date(y, m, 1).toLocaleDateString("ru-RU",{month:"long",year:"numeric"}).replace(" г.","");
    var h = '<div class="card sched-cal"><b class="sched-cal-title">'+title.charAt(0).toUpperCase()+title.slice(1)+'</b><div class="sched-cal-grid">';
    ["пн","вт","ср","чт","пт","сб","вс"].forEach(function(w){ h += '<span class="wd">'+w+'</span>'; });
    for(var i=0;i<first;i++) h += '<span></span>';
    for(var dd=1; dd<=days; dd++){
      h += '<span class="d'+(marked[dd]?' ev':'')+(isThisMonth && dd===todayD.getDate()?' today':'')+'">'+dd+'</span>';
    }
    h += '</div><div class="sched-cal-legend"><i></i>день эфира</div></div>';
    return h;
  }

  var html = '<div class="page-wide"><b class="page-h">Ближайшие эфиры</b>';
  if(!upcoming.length){
    html += '<div class="sched-top"><div class="card empty-state" style="padding:40px 20px;">Пока эфиры не запланированы.</div>'+monthCalendar()+'</div>';
  } else {
    var nx = upcoming[0], nxLive = isLiveNow(nx);
    // Карточка по зонам: статус и отсчёт → что за эфир → факты подписанными
    // ячейками → действия в подвале. Раньше всё шло одной колонкой мелким текстом.
    // Когда — одной спокойной фразой того же кегля, что статус, а не огромной цифрой.
    var nxStart = startOf(nx), nxMs = nxStart - new Date(), wl = whenLabel(nx);
    var cd = nxLive ? "идёт сейчас"
      : nxMs < 3600000 ? "через "+Math.max(1, Math.round(nxMs/60000))+" мин"
      : wl==="сегодня" ? "сегодня в "+escapeHtml(nx.event_time||"")
      : wl==="завтра" ? "завтра в "+escapeHtml(nx.event_time||"")
      : (function(){ var dd = Math.round((new Date(nxStart.getFullYear(),nxStart.getMonth(),nxStart.getDate()) - new Date(new Date().setHours(0,0,0,0)))/86400000); return "через "+dd+" "+ruPluralClient(dd,"день","дня","дней"); })();
    var nxStream = nx.stream_id ? (calendarState.streams||[]).find(function(x){ return x.id===nx.stream_id; }) : null;
    var fact = function(lbl, val){ return '<div class="sh-fact"><span>'+lbl+'</span><b>'+val+'</b></div>'; };
    html += '<div class="sched-top">' +
      '<div class="card sched-hero">' +
        '<div class="sh-top">' + (nxLive ? magnet("live","Идёт сейчас") : magnet("attention","Ближайший эфир")) +
          '<span class="sh-when'+(nxLive?' live':'')+'">'+icon("clock","ic-sm")+cd+'</span></div>' +
        '<h2>'+escapeHtml(nx.title)+'</h2>' +
        '<div class="sh-facts">' +
          fact('Дата', WD[nxStart.getDay()]+', '+nxStart.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})) +
          fact('Начало', escapeHtml(nx.event_time||"—")) +
          fact('Длительность', (nx.duration_min||60)+' мин') +
          fact(nx.speaker ? 'Ведущий' : 'Для кого', nx.speaker ? escapeHtml(nx.speaker) : (nxStream ? escapeHtml(nxStream.name) : 'все потоки')) +
        '</div>' +
        '<div class="sh-foot"><span class="sh-hint">'+(nx.join_url ? 'Ссылка откроется в новой вкладке' : 'Ссылку на подключение куратор пришлёт в Telegram-группу потока')+'</span>' +
          actions(nx, nxLive, true) + '</div>' +
      '</div>' +
      monthCalendar() +
    '</div>';
    if(upcoming.length>1){
      html += '<b class="page-h" style="margin-top:24px;">Дальше</b><div class="card sched-list">';
      upcoming.slice(1).forEach(function(ev){ html += row(ev, true); });
      html += '</div>';
    }
  }
  if(past.length){
    html += '<b class="page-h" style="margin-top:24px;">Прошедшие</b><div class="card sched-list">';
    past.slice(-5).reverse().forEach(function(ev){ html += row(ev, false); });
    html += '</div>';
  }
  html += '</div>';
  return el(html);
}

// Три пункта первых шагов новичка — не хранятся отдельным флагом каждый,
// а считаются из уже имеющихся данных (профиль/прогресс) плюс один локальный
// флаг на "посмотрели расписание" (смотреть его не с чем сверять на сервере).
function onboardingChecklistItems(){
  var profileDone = !!(me.workplace && me.workplace.trim()) && !!(me.phone && me.phone.trim());
  var lessonDone = ((course.progress && course.progress.completed_lessons) || []).length > 0;
  var scheduleDone = localStorage.getItem("lms-viewed-schedule-"+me.id) === "1";
  return [
    { done:profileDone, label:"Заполните профиль", action:"open-profile-editor" },
    { done:lessonDone, label:"Посмотрите первый урок", action:"open-course" },
    { done:scheduleDone, label:"Посмотрите расписание эфиров", action:"student-tab", tab:"schedule" }
  ];
}
function renderOnboardingCard(){
  var pr = course.progress || {};
  if(pr.onboarding_dismissed) return "";
  var items = onboardingChecklistItems();
  var doneCount = items.filter(function(i){ return i.done; }).length;
  if(doneCount===items.length) return "";
  var html = '<div class="card" style="padding:18px 20px;margin-bottom:14px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<b style="font-size:14px;">Первые шаги ('+doneCount+'/'+items.length+')</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="dismiss-onboarding">Скрыть</button>' +
    '</div>';
  items.forEach(function(i,idx){
    html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;'+(idx<items.length-1?'border-bottom:1px solid var(--line-2);':'')+(i.done?'':'cursor:pointer;')+'" '+(i.done?'':'data-action="'+i.action+'"'+(i.tab?' data-tab="'+i.tab+'"':''))+'>' +
      '<span style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff;background:'+(i.done?'var(--status-done)':'var(--line-2)')+';">'+(i.done?icon("check","ic-sm"):'')+'</span>' +
      '<span style="font-size:14px;'+(i.done?'color:var(--muted);text-decoration:line-through;':'')+'">'+escapeHtml(i.label)+'</span>' +
    '</div>';
  });
  html += '</div>';
  return html;
}

// Главная врача. При самом первом входе (ни одного урока, приветствие ещё не
// закрыто) — экран «Добро пожаловать»: как устроен курс и кто куратор. Кнопка
// «Приступить к обучению» с анимацией сменяет его обычной главной: один следующий
// шаг, одна полоска прогресса, ближайшие уроки, справа куратор и эфир. Серия дней,
// очки и «Пригласите коллегу» появляются после первого пройденного урока — до этого
// там одни нули. Курс демо, поэтому про сертификат здесь ничего нет.
var homeEnterAnim = false;
function homeCuratorTile(){
  var cur = me.curator;
  return '<div class="card board-tile ho-1">' + cardHead("Ваш куратор", "") +
    (cur ? '<div class="home-cur">'+userAvatar(cur,"home-cur-av")+'<div><b>'+escapeHtml(cur.name)+'</b><span>отвечает в Telegram-группе потока</span></div></div>' : '') +
    '<span class="tile-sub">Непонятно, как проходить курс, нет доступа, вопрос по теме урока — пишите, здесь же преподаватели и коллеги.</span>' +
    '<div class="tile-foot"><button class="btn btn-sm btn-ghost" data-action="open-telegram-modal">Написать в Telegram →</button></div></div>';
}
function homeEventTile(){
  var mySid = me.stream_id || "", nextEvent = null, liveNow = false, now = new Date();
  calendarState.events.filter(function(ev){ return !ev.stream_id || ev.stream_id===mySid; }).forEach(function(ev){
    var start = new Date(ev.event_date+"T"+(ev.event_time||"00:00"));
    var end = new Date(start.getTime() + (ev.duration_min||60)*60000);
    if(!nextEvent && end >= now){ nextEvent = ev; liveNow = (start<=now && now<=end); }
  });
  var html = '<div class="card board-tile ho-1">' +
    cardHead(liveNow ? "Идёт эфир" : "Ближайший эфир", '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="schedule">Все эфиры →</button>');
  if(nextEvent){
    html += '<b class="tile-main">'+escapeHtml(nextEvent.title)+'</b>' +
      '<span class="tile-sub">'+(liveNow ? magnet("live","идёт сейчас") : fmtDate(nextEvent.event_date)+' · '+escapeHtml(nextEvent.event_time||""))+'</span>' +
      (liveNow && nextEvent.join_url ? '<div class="tile-foot"><a class="btn btn-sm btn-primary" href="'+escapeHtml(nextEvent.join_url)+'" target="_blank" rel="noopener">Подключиться</a></div>' : '');
  } else {
    html += '<span class="tile-sub">Эфиры пока не запланированы.</span>';
  }
  return html + '</div>';
}
function renderWelcomeHome(){
  var L = course.lessons, first = L[0] || {}, q = first.quiz ? first.quiz.length : 0;
  var name = (me.name||"").trim().split(/\s+/)[0] || "";
  var step = function(n, ic, title, text){ return '<div class="wl-step"><em>'+n+'</em><span class="wl-si">'+icon(ic)+'</span><b>'+title+'</b><span>'+text+'</span></div>'; };
  return '<div class="home-grid wl-mode '+homeFxClass()+homeBgClass()+'" style="margin-top:10px;">'+homeBgLayer() +
    '<div class="wl" id="welcomeHome">' +
      '<div class="card course-hero wl-hello"><div class="hero-aurora aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
        '<span class="wl-kick">Демо-курс «'+escapeHtml(course.course.title)+'»</span>' +
        '<h2 class="wl-h">Добро пожаловать'+(name?', '+escapeHtml(name):'')+'!</h2>' +
        '<p class="wl-sub">'+L.length+' '+ruPluralClient(L.length,"короткий урок","коротких урока","коротких уроков")+' от практикующих врачей. Вот как всё устроено:</p>' +
        '<div class="wl-steps">' +
          step(1, "book", "Урок ~10 минут", "Текст с ключевыми цифрами, где-то видео. Важное можно отмечать маркером и писать заметки.") +
          step(2, "check", "Короткий тест", (q ? q+' '+ruPluralClient(q,"вопрос","вопроса","вопросов")+' после урока' : 'После урока')+" — сразу видно, что понятно, а что стоит перечитать.") +
          step(3, "badge", "Итоговый тест", "После всех уроков. Затем можно оставить заявку на полную программу обучения — баллы за уроки дают на неё скидку.") +
        '</div>' +
        '<div class="wl-foot"><span>'+(first.title ? 'Первый урок: '+escapeHtml(first.title)+(first.duration?' · '+escapeHtml(first.duration):'') : '')+'</span>' +
          '<button class="btn btn-primary" data-action="welcome-start">Приступить к обучению →</button></div>' +
      '</div>' +
      '<div class="wl-two">'+homeCuratorTile()+homeEventTile()+'</div>' +
    '</div></div>';
}

function renderStudentHome(){
  var pr = course.progress || {};
  var total = course.lessons.length;
  var doneIds = pr.completed_lessons||[];
  var done = doneIds.length;
  var lock = course.locked || {locked:false};
  if(!lock.locked && !done && !pr.completed && !pr.welcome_seen) return el(renderWelcomeHome());

  // На широком экране — две колонки: слева следующий шаг и что потом, справа —
  // куратор, эфир и прочее «сбоку». На узком всё идёт одной колонкой.
  var enter = homeEnterAnim; homeEnterAnim = false;
  // Следующий шаг — первым; анкета и чеклист «Первые шаги» идут после «Потом».
  var html = '<div class="home-grid '+homeFxClass()+homeBgClass()+(enter?' home-enter':'')+'" style="margin-top:10px;">'+homeBgLayer()+'<div class="home-main">';
  var curIdx = -1;
  course.lessons.forEach(function(l,i){ if(curIdx<0 && doneIds.indexOf(l.id)===-1) curIdx = i; });
  if(lock.locked){
    html += '<div class="card course-hero" style="background:var(--status-blocked-tint);">' +
      magnet("blocked", "Доступ ограничен") +
      '<h2 style="margin-top:14px;">'+escapeHtml(course.course.title)+'</h2>' +
      '<p>'+(lock.reason==="blocked" ? 'Куратор временно ограничил ваш доступ к демо-курсу.' : 'Срок доступа к демо-курсу истёк.')+' Чтобы продолжить обучение, напишите куратору в Telegram-группе потока — он может продлить или снять ограничение.</p>' +
      '<button class="btn btn-primary" data-action="open-telegram-modal">Написать куратору</button></div>';
  } else {
    var quizDone = !!pr.completed, kick, title, sub, acts;
    var allBtn = '<button class="btn btn-ghost" data-action="open-course">Все уроки</button>';
    if(curIdx >= 0){
      var l = course.lessons[curIdx], q = l.quiz ? l.quiz.length : 0, locked = l.hiddenForMe || l.dripLockedForMe;
      kick = "Ваш следующий шаг";
      title = "Урок "+(curIdx+1)+". "+escapeHtml(l.title);
      sub = locked ? (l.hiddenForMe ? "Урок пока недоступен — куратор откроет его." : "Урок откроется "+fmtDateShort(l.availableAt)+".")
        : (l.duration ? escapeHtml(l.duration)+" чтения" : "Короткий урок") + (q ? ", затем короткий тест из "+q+" "+ruPluralClient(q,"вопроса","вопросов","вопросов")+" — он проверяет, что главное понятно." : ".");
      acts = (locked ? '' : '<button class="btn btn-primary" data-action="open-lesson-at" data-idx="'+curIdx+'">Начать урок</button>') + allBtn;
    } else if(!quizDone){
      var fq = course.quiz ? course.quiz.length : 0;
      kick = "Остался последний шаг";
      title = "Итоговый тест";
      sub = (fq ? fq+" "+ruPluralClient(fq,"вопрос","вопроса","вопросов")+", нужно от 60%. " : "") + "После него можно оставить заявку на полную программу обучения.";
      acts = '<button class="btn btn-primary" data-action="open-final-quiz">Пройти тест</button>' + allBtn;
    } else {
      kick = "Демо-курс пройден";
      title = escapeHtml(course.course.title);
      sub = "Итоговый тест — "+pr.quiz_score+"%. "+(pr.requested_full_access ? "Заявка на полную программу отправлена — куратор свяжется с вами." : "Если хотите продолжить — оставьте заявку на полную программу обучения.");
      acts = (pr.requested_full_access ? magnet("done","Заявка отправлена") : '<button class="btn btn-primary" data-action="request-full">Хочу полное обучение</button>') + allBtn;
    }
    var pct = Math.round((done + (quizDone?1:0)) / (total+1) * 100);
    html += '<div class="card course-hero hs-hero">' +
      '<div class="hero-aurora aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
      '<span class="hs-kick">'+kick+'</span><h2 class="hs-h">'+title+'</h2><p class="hs-sub">'+sub+'</p>' +
      '<div class="hs-act">'+acts+'</div>' +
      '<div class="hs-bar"><div class="hs-bar-t"><span><b>'+escapeHtml(course.course.title)+'</b> · '+done+' из '+total+' '+ruPluralClient(total,"урока","уроков","уроков")+'</span>' +
        '<span>'+(quizDone ? (curIdx<0 ? 'курс пройден' : 'итоговый тест сдан') : done===total ? 'остался итоговый тест' : 'дальше — итоговый тест')+'</span></div>' +
        '<div class="hs-track"><i style="width:'+Math.max(pct,2)+'%"></i></div></div>' +
    '</div>';
  }

  if(!lock.locked) html += renderHomeNextLessons(doneIds, curIdx);
  html += renderSurveyHomeCard() + renderOnboardingCard();
  if(!lock.locked) html += renderHomeExtras();
  html += '</div><aside class="home-rail">' + homeCuratorTile() + homeEventTile();

  if(pr.completed && course.course && course.course.certificatesEnabled){
    var issued = pr.certificate_status==="issued";
    html += '<div class="card board-tile ho-1">' + cardHead("Сертификат", "") +
      '<div class="tile-row"><b class="tile-num">'+pr.quiz_score+'%</b><span class="tile-sub">результат теста</span></div>' +
      '<div style="margin-top:6px;">'+magnet(issued?"done":"attention", issued?"выдан":"на проверке")+'</div></div>';
  }

  if(done > 0 || pr.completed){
    var gam = course.gamification || { points:0, currentStreak:0, longestStreak:0 };
    var ptsPct = Math.min(100, Math.round((gam.points||0)/10));
    html += '<div class="card board-tile ho-1">' +
      cardHead("Прогресс", '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="progress">Подробнее →</button>') +
      '<div class="tile-row">'+icon("flame","ic-sm streak-flame") +
        '<b class="tile-num" data-count="'+(gam.currentStreak||0)+'">'+(gam.currentStreak||0)+'</b>' +
        '<span class="tile-sub">'+ruPluralClient(gam.currentStreak||0,"день подряд","дня подряд","дней подряд")+' · рекорд '+(gam.longestStreak||0)+'</span></div>' +
      '<div class="tile-row"><b class="tile-num" data-count="'+(gam.points||0)+'">'+(gam.points||0)+'</b>' +
        '<span class="tile-sub">из 1000 очков — это скидка на полный курс</span></div>' +
      '<div class="home-pts"><i style="width:'+ptsPct+'%"></i></div>' +
    '</div>';
  }

  // Уведомления — только когда есть что показать (пустая плитка «нет новых» — лишний шум).
  var homeNotifItems = upcomingEventReminders().concat(notifState.items.filter(function(n){ return !n.read_at; }));
  if(homeNotifItems.length){
    html += '<div class="card board-tile ho-3">' + cardHead("Уведомления", '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="notifications">Все →</button>') +
      '<div class="home-notifs">' + homeNotifItems.slice(0,3).map(function(n){ return '<div>'+escapeHtml(n.title)+'</div>'; }).join("") + '</div></div>';
  }

  if(me.referral_code && (done > 0 || pr.completed)){
    // От адреса самой платформы, а не корня домена — иначе при установке в
    // подпапку (/lms/) ссылка вела бы на главную основного сайта.
    var refLink = window.location.origin + window.location.pathname.replace(/[^/]*$/, "") + "?ref=" + me.referral_code;
    html += '<div class="card board-tile ho-3">' + cardHead("Пригласите коллегу", "") +
      '<span class="tile-sub">Поделитесь ссылкой — когда коллега зарегистрируется по ней, мы это увидим.</span>' +
      '<div class="home-ref"><input class="input" readonly value="'+escapeHtml(refLink)+'" id="refLinkInput">' +
        '<button class="btn btn-sm btn-ghost" data-action="copy-ref-link">Скопировать</button></div></div>';
  }
  html += '</aside></div>';
  return el(html);
}

// «Потом»: два урока после текущего (а когда текущий — последний, итоговый тест),
// остальные — по «Все уроки». Текущий урок уже крупно в карточке выше.
function renderHomeNextLessons(doneIds, curIdx){
  var lessons = course.lessons, pr = course.progress || {};
  if(curIdx < 0) return "";
  var rows = lessons.slice(curIdx+1, curIdx+3).map(function(l, k){
    var i = curIdx+1+k, done = doneIds.indexOf(l.id)!==-1, locked = l.hiddenForMe || l.dripLockedForMe;
    var st = done ? '<span class="hn-st done">'+icon("check","ic-sm")+'пройден</span>'
      : locked ? '<span class="hn-st">'+icon("lock","ic-sm")+(l.hiddenForMe?'недоступен':'откроется '+fmtDateShort(l.availableAt))+'</span>' : '';
    return '<div class="hn-row'+(done?' done':'')+(locked?' locked':'')+'" style="--k:'+k+'"'+(locked?'':' data-action="open-lesson-at" data-idx="'+i+'"')+'>' +
      '<span class="hn-num">'+(done?icon("check","ic-sm"):(i+1))+'</span><div class="hn-body"><b>'+escapeHtml(l.title)+'</b>' +
      '<span>'+(l.duration?escapeHtml(l.duration):'')+(l.quiz && l.quiz.length?' · тест '+l.quiz.length+' '+ruPluralClient(l.quiz.length,"вопрос","вопроса","вопросов"):'')+(l.assignment?' · задание':'')+'</span></div>'+st+'</div>';
  }).join("");
  if(curIdx >= lessons.length-2 && !pr.completed){
    rows += '<div class="hn-row hn-final locked"><span class="hn-num">'+icon("badge","ic-sm")+'</span><div class="hn-body"><b>Итоговый тест</b><span>'+(course.quiz&&course.quiz.length?course.quiz.length+' '+ruPluralClient(course.quiz.length,"вопрос","вопроса","вопросов")+' · ':'')+'нужно от 60%</span></div><span class="hn-st">после всех уроков</span></div>';
  }
  return '<div class="card home-next ho-2">' + cardHead("Потом", '<button class="btn btn-sm btn-ghost" data-action="open-course">Все '+lessons.length+' '+ruPluralClient(lessons.length,"урок","урока","уроков")+' →</button>') + rows + '</div>';
}
// Конспект и протоколы — с реальными цифрами; плитка появляется, только когда
// в разделе уже есть что показать.
function renderHomeExtras(){
  var out = [];
  var hl = (course.progress && course.progress.lesson_highlights) || {}, notes = (course.progress && course.progress.lesson_notes) || {};
  var hlCount = 0, lastQuote = null;
  Object.keys(hl).forEach(function(k){ (hl[k]||[]).forEach(function(h){ hlCount++; if(!lastQuote || (h.at||"") > (lastQuote.at||"")) lastQuote = h; }); });
  var noteCount = Object.keys(notes).filter(function(k){ return (notes[k]||"").trim(); }).length;
  var saved = (course.bookmarkedLessonIds||[]).length;
  out.push('<div class="card board-tile">' + cardHead("Мой конспект", '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="materials">Открыть →</button>') +
    (hlCount || noteCount || saved
      ? '<div class="home-stats"><div><b>'+hlCount+'</b><span>'+ruPluralClient(hlCount,"выделение","выделения","выделений")+'</span></div><div><b>'+noteCount+'</b><span>'+ruPluralClient(noteCount,"заметка","заметки","заметок")+'</span></div><div><b>'+saved+'</b><span>'+ruPluralClient(saved,"урок сохранён","урока сохранено","уроков сохранено")+'</span></div></div>' +
        (lastQuote ? '<p class="home-quote">«'+escapeHtml(lastQuote.text.length>140?lastQuote.text.slice(0,140)+'…':lastQuote.text)+'»</p>' : '')
      : '<span class="tile-sub">Выделяйте главное в уроках маркером и делайте заметки — всё соберётся здесь.</span>') + '</div>');
  if(protocolsSectionAvailable()){
    var sp = studentProtocols, opened = (sp.forYou||[]).length + (sp.additional||[]).length, total = Math.max(sp.totalInCourse||0, opened);
    out.push('<div class="card board-tile">' + cardHead("Протоколы", '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="protocols">Открыть →</button>') +
      (studentState.protocolsLoaded
        ? '<div class="home-stats"><div><b>'+opened+'</b><span>из '+total+' открыто</span></div>' + ((sp.forYou||[]).length ? '<div><b>'+(sp.forYou||[]).length+'</b><span>под вашу специализацию</span></div>' : '') + '</div>' +
          (sp.nextLesson ? '<span class="tile-sub">Урок '+(sp.nextLesson.idx+1)+' откроет ещё '+sp.nextLesson.unlocks+' '+ruPluralClient(sp.nextLesson.unlocks,"протокол","протокола","протоколов")+'.</span>' : '')
        : '<span class="tile-sub">Гайды применения протоколов из уроков под вашу специализацию.</span>') + '</div>');
  }
  return '<div class="home-extras ho-2">' + out.join("") + '</div>';
}

function stripHtml(html){
  var div = document.createElement("div");
  div.innerHTML = html || "";
  return (div.textContent || div.innerText || "").replace(/\s+/g," ").trim();
}

function snippetAround(text, q){
  if(!q) return text.slice(0,110)+(text.length>110?"…":"");
  var idx = text.toLowerCase().indexOf(q.toLowerCase());
  if(idx===-1) return text.slice(0,110)+(text.length>110?"…":"");
  var start = Math.max(0, idx-40);
  var end = Math.min(text.length, idx+q.length+70);
  return (start>0?"…":"")+text.slice(start,end)+(end<text.length?"…":"");
}

// Поиск по материалам — целиком на клиенте: у врача уже загружен весь текст уроков
// (course.lessons[].html) для плеера, гонять его туда-обратно через отдельный
// поисковый эндпоинт не нужно — достаточно снять теги и сравнить подстроку.
// «Мой конспект» — всё, что врач сам отметил в уроках: выделения маркером,
// заметки и сохранённые уроки, собранные по урокам. Список всех уроков здесь
// не дублируется (он на «Главной» и в самом курсе). Поиск сверху ищет сразу
// в текстах уроков, в выделениях и в заметках.
function nbData(){
  var hl = (course.progress && course.progress.lesson_highlights) || {};
  var notes = (course.progress && course.progress.lesson_notes) || {};
  var saved = course.bookmarkedLessonIds || [];
  return course.lessons.map(function(l, idx){
    // Выделения — в порядке текста урока, а не в порядке, в каком их отмечали.
    var list = (hl[l.id] || []).slice();
    if(list.length > 1){
      var plain = hlNormalize(stripHtml(l.html));
      list.sort(function(a, b){ return plain.indexOf(a.text) - plain.indexOf(b.text); });
    }
    return { lesson:l, idx:idx, hl: list, note: notes[l.id] || "", saved: saved.indexOf(l.id)!==-1 };
  });
}
function nbMark(text, q){
  var t = escapeHtml(text);
  if(!q) return t;
  var qe = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp("("+qe+")", "gi"), '<mark class="nb-hit">$1</mark>');
}
function nbQuote(it, h, q){
  return '<div class="nb-quote" data-action="nb-open-hl" data-idx="'+it.idx+'" data-hid="'+h.id+'" title="Открыть в уроке">' +
    '<span class="nb-quote-text">'+nbMark(h.text, q)+'</span>' +
    '<button type="button" class="nb-x" data-action="nb-del-hl" data-lesson-id="'+it.lesson.id+'" data-hid="'+h.id+'" title="Убрать выделение" aria-label="Убрать выделение">'+icon("close","ic-sm")+'</button></div>';
}
function nbNote(it, q){
  if(studentState.nbEditId === it.lesson.id){
    return '<div class="nb-note editing"><span class="nb-label">Заметка</span>' +
      '<textarea class="input" id="nbNoteInput" rows="4">'+escapeHtml(it.note)+'</textarea>' +
      '<div class="nb-note-btns"><button class="btn btn-sm btn-primary" data-action="nb-note-save" data-id="'+it.lesson.id+'">Сохранить</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="nb-note-cancel">Отмена</button></div></div>';
  }
  if(!it.note) return '';
  return '<div class="nb-note"><div class="nb-note-head"><span class="nb-label">Заметка</span>' +
    '<button type="button" class="link-btn" data-action="nb-note-edit" data-id="'+it.lesson.id+'">Изменить</button></div>' +
    '<p>'+nbMark(it.note, q)+'</p></div>';
}
function nbLessonCard(it, opts){
  opts = opts || {};
  var l = it.lesson, q = opts.q || "";
  var hl = opts.hl || it.hl, showNote = opts.note !== false;
  var html = '<div class="card nb-lesson">' +
    '<div class="card-head"><div class="nb-title" data-action="goto-lesson-from-materials" data-idx="'+it.idx+'"><span>Урок '+(it.idx+1)+'</span><b>'+escapeHtml(l.title)+'</b></div>' +
    '<div class="nb-head-btns"><button class="btn btn-sm btn-ghost nb-star'+(it.saved?' on':'')+'" data-action="toggle-bookmark" data-id="'+l.id+'" data-bookmarked="'+(it.saved?"1":"0")+'" title="'+(it.saved?"Убрать из сохранённых":"Сохранить урок")+'">'+(it.saved?"★":"☆")+'</button>' +
    '<button class="btn btn-sm btn-ghost" data-action="goto-lesson-from-materials" data-idx="'+it.idx+'">Открыть урок →</button></div></div>';
  var body = hl.map(function(h){ return nbQuote(it, h, q); }).join("") + (showNote ? nbNote(it, q) : "");
  if(!body) body = '<p class="nb-empty-line">Урок сохранён — выделений и заметок в нём пока нет. Выделите текст в уроке, чтобы отметить главное.</p>';
  if(showNote && !q && !it.note && studentState.nbEditId !== l.id) body += '<button type="button" class="link-btn nb-add-note" data-action="nb-note-edit" data-id="'+l.id+'">+ Добавить заметку</button>';
  return html + '<div class="nb-body">'+body+'</div></div>';
}
function renderStudentMaterials(){
  var q = studentState.materialsSearch.trim(), ql = q.toLowerCase();
  var data = nbData();
  var cnt = { hl:0, notes:0, saved:0 };
  data.forEach(function(it){ cnt.hl += it.hl.length; if(it.note) cnt.notes++; if(it.saved) cnt.saved++; });
  var f = studentState.materialsFilter;
  if(["all","highlights","notes","saved"].indexOf(f)===-1) f = studentState.materialsFilter = "all";
  var chip = function(key, label, n){ return '<button class="tab'+(f===key?' active':'')+'" data-action="materials-filter" data-filter="'+key+'">'+label+(n?' <span class="nb-count">'+n+'</span>':'')+'</button>'; };
  var html = '<div class="page-wide"><div class="card nb-hero">' +
    '<span class="profile-kicker">Только для вас</span><h1>Мой конспект</h1>' +
    '<p>Всё, что вы отметили в уроках: выделения, заметки и сохранённые уроки — в одном месте.</p>' +
    '<div class="nb-search">'+icon("search","ic-sm")+'<input class="input" id="materialsSearchInput" placeholder="Поиск по урокам, выделениям и заметкам…" value="'+escapeHtml(studentState.materialsSearch)+'"></div>' +
    (q ? '' : '<div class="tabs nb-tabs">'+chip("all","Всё",0)+chip("highlights","Выделения",cnt.hl)+chip("notes","Заметки",cnt.notes)+chip("saved","Сохранённые",cnt.saved)+'</div>') +
  '</div>';

  if(q){
    // Поиск: сначала совпадения в своих записях, затем — в текстах уроков.
    var mine = [];
    data.forEach(function(it){
      var hl = it.hl.filter(function(h){ return h.text.toLowerCase().indexOf(ql)!==-1; });
      var noteHit = !!it.note && it.note.toLowerCase().indexOf(ql)!==-1;
      if(hl.length || noteHit) mine.push(nbLessonCard(it, { q:q, hl:hl, note: noteHit }));
    });
    var lessons = data.filter(function(it){ var l = it.lesson; return !l.hiddenForMe && (l.title.toLowerCase().indexOf(ql)!==-1 || stripHtml(l.html).toLowerCase().indexOf(ql)!==-1); });
    if(mine.length) html += '<div class="courses-head nb-sec"><b class="page-h" style="margin:0;">В моих записях</b><span class="courses-count">'+mine.length+'</span></div>' + mine.join("");
    html += '<div class="courses-head nb-sec"><b class="page-h" style="margin:0;">В уроках</b><span class="courses-count">'+lessons.length+'</span></div>';
    if(!lessons.length && !mine.length){
      html += '<div class="card empty-state" style="padding:30px 20px;">Ничего не нашлось по запросу «'+escapeHtml(q)+'».</div>';
    } else if(lessons.length){
      html += '<div class="mat-grid">' + lessons.map(function(it){
        var l = it.lesson, locked = l.dripLockedForMe;
        return '<div class="mat-item'+(locked?' locked':'')+'"'+(locked?'':' data-action="goto-lesson-from-materials" data-idx="'+it.idx+'"')+'>' +
          '<div class="mat-head"><b>'+(it.idx+1)+'. '+nbMark(l.title, q)+'</b></div>' +
          '<p>'+nbMark(snippetAround(stripHtml(l.html), q), q)+'</p>' +
          '<div class="mat-foot">'+(locked?'<span class="mat-status">'+icon("lock","ic-sm")+'откроется '+fmtDate(l.availableAt)+'</span>':'<span class="mat-open">Открыть →</span>')+'</div></div>';
      }).join("") + '</div>';
    } else {
      html += '<p class="nb-empty-line">В текстах уроков совпадений нет.</p>';
    }
    return el(html + '</div>');
  }

  var list = data.filter(function(it){
    var editing = studentState.nbEditId===it.lesson.id;
    if(f==="highlights") return it.hl.length;
    if(f==="notes") return !!it.note || editing;
    if(f==="saved") return it.saved;
    return it.hl.length || it.note || it.saved || editing;
  });
  if(!list.length){
    var none = !cnt.hl && !cnt.notes && !cnt.saved;
    html += '<div class="card nb-empty">' +
      '<b>'+(none ? 'Конспект пока пуст' : ({highlights:"Выделений пока нет", notes:"Заметок пока нет", saved:"Сохранённых уроков пока нет"})[f])+'</b>' +
      '<ol class="tg-steps">' +
        '<li><b>Выделите текст в уроке</b><span>Появится панель: «Маркер» — фрагмент подсветится и попадёт сюда.</span></li>' +
        '<li><b>«В заметку»</b><span>Цитата добавится в вашу заметку к уроку. Заметку можно дописать и здесь.</span></li>' +
        '<li><b>☆ Сохранить</b><span>Звёздочка в шапке урока — чтобы быстро вернуться к нему.</span></li>' +
      '</ol><div><button class="btn btn-primary" data-action="open-course">Перейти к урокам</button></div></div>';
  } else {
    html += list.map(function(it){
      return nbLessonCard(it, { hl: f==="notes" ? [] : it.hl, note: f!=="highlights" });
    }).join("");
  }
  return el(html + '</div>');
}

// Формат урока: текстовое интро (как и раньше) → видео с главами по таймкодам
// (если куратор его добавил) → поурочный «развлекательный» тест на запоминание
// (если куратор его добавил). Оба шага опциональны — урок без видео и теста
// работает ровно как раньше (одна кнопка "Урок пройден, далее →").
function lessonStagesFor(lesson){
  var stages = ["intro"];
  if(lesson.videoUrl) stages.push("video");
  if(lesson.quiz && lesson.quiz.length) stages.push("quiz");
  if(lesson.assignment) stages.push("task");
  return stages;
}
function resetLessonStageState(){
  studentState.lessonStage = "intro";
  studentState.videoEnded = false;
  studentState.lessonQuizResult = null;
  Object.keys(quizRuns).forEach(function(k){ if(k.indexOf("lesson:")===0) delete quizRuns[k]; });
}
// Модуль, все уроки которого уже пройдены, но отзыв по нему ещё не оставлен —
// именно отзыв (не тест) считается финальным шагом гейта, поэтому проверяем по
// нему: так гейт переживает перезагрузку страницы (studentState не хранится на
// сервере) и не пропускает шаг, если врач закрыл вкладку сразу после теста модуля.
function findPendingModuleGate(){
  var doneIds = (course.progress && course.progress.completed_lessons) || [];
  var given = course.moduleFeedbackGiven || [];
  return (course.modules||[]).find(function(m){
    return m.lessonIds.length>0 &&
      m.lessonIds.every(function(id){ return doneIds.indexOf(id)!==-1; }) &&
      given.indexOf(m.id)===-1;
  }) || null;
}
// «Ваши протоколы» реально появляется врачу после прохождения третьего урока
// курса — именно с этого урока в текущей программе начинают привязываться
// первые протоколы (см. lesson_protocols), до этого коллекции нечему появиться.
// Используется и для видимости пункта сайдбара, и для того, чтобы поймать
// момент перехода false→true и показать unlockCelebration (см.
// maybeCelebrateProtocolsUnlock) — иначе рассинхронились бы момент появления
// пункта меню и момент, когда мы про это радостно сообщаем. В курсе короче
// трёх уроков ждать нечего — доступно сразу после первого пройденного.
function protocolsSectionAvailable(){
  var doneIds = (course.progress && course.progress.completed_lessons) || [];
  var thirdLesson = course.lessons && course.lessons[2];
  if(thirdLesson) return doneIds.indexOf(thirdLesson.id)!==-1;
  return doneIds.length>0;
}
function maybeCelebrateProtocolsUnlock(wasAvailable){
  if(!wasAvailable && protocolsSectionAvailable()) unlockCelebration.open = true;
}
function resetModuleGateState(){
  studentState.moduleGateStage = null;
  studentState.moduleGateId = null;
  studentState.moduleQuizResult = null;
  studentState.moduleFeedbackRating = 0;
  studentState.moduleFeedbackComment = "";
}
// Куда вести врача после "урок пройден" — на следующий незаблокированный урок,
// либо на итоговый тест курса, либо (если и то, и другое недоступно) остаёмся на месте.
// Если пройденный урок закрыл модуль — это подхватит renderCoursePlayer() сам
// (см. findPendingModuleGate) на следующей отрисовке, отдельно решать тут не нужно.
function advanceAfterLesson(){
  var nextIdx = -1;
  for(var i=studentState.lessonIndex+1;i<course.lessons.length;i++){
    if(!course.lessons[i].hiddenForMe && !course.lessons[i].dripLockedForMe){ nextIdx=i; break; }
  }
  resetLessonStageState();
  if(nextIdx!==-1){ studentState.lessonIndex=nextIdx; }
  else if(!course.quizHiddenForMe){ studentState.quizMode=true; studentState.quizSubmitted=false; }
  else { showToast("Пока больше нечего проходить — куратор скоро откроет остальные материалы"); studentState.tab="course"; studentState.quizMode=false; }
}

function renderCoursePlayer(){
  if(!studentState.moduleGateStage){
    var pendingModule = findPendingModuleGate();
    if(pendingModule){
      studentState.moduleGateId = pendingModule.id;
      studentState.moduleGateStage = (pendingModule.quiz && pendingModule.quiz.length) ? "quiz" : "feedback";
      studentState.moduleQuizResult = null;
      studentState.moduleFeedbackRating = 0;
      studentState.moduleFeedbackComment = "";
    }
  }
  if(studentState.moduleGateStage) return renderModuleGate();
  if(studentState.quizMode) return renderQuizOrCert();
  var idx = studentState.lessonIndex;
  var lesson = course.lessons[idx];
  var doneIds = (course.progress && course.progress.completed_lessons) || [];

  var nav = '<div class="lesson-nav">';
  course.lessons.forEach(function(l,i){
    var isDone = doneIds.indexOf(l.id)!==-1;
    var isLocked = l.hiddenForMe || l.dripLockedForMe;
    var lsub = (course.assignments||{})[l.id];
    var taskNote = lsub ? (lsub.status==="pending" ? ' · задание на проверке' : (lsub.status==="returned" ? ' · задание вернули' : '')) : '';
    var lockLabel = l.hiddenForMe ? 'Временно недоступен' : (l.dripLockedForMe ? 'Откроется '+fmtDate(l.availableAt) : escapeHtml(l.duration||"")+taskNote);
    var sub = "";
    if(i===idx && !studentState.quizMode && !isLocked){
      var ltoc = lessonToc(l.html);
      if(ltoc.length) sub = '<div class="lesson-sub">' + ltoc.map(function(x, k){
        return '<button type="button" class="'+(x.cheat?'mut':'')+(k===0?' on':'')+'" data-action="lesson-toc" data-i="'+x.i+'">'+escapeHtml(x.title)+'</button>';
      }).join('') + '</div>';
    }
    nav += '<div class="lesson-item'+(i===idx?' active':'')+(isDone?' done':'')+'" data-action="goto-lesson" data-idx="'+i+'"'+(isLocked?' style="opacity:.45;cursor:not-allowed;"':'')+'>' +
      '<span class="lesson-num">'+(isLocked?icon("lock","ic-sm"):(isDone?icon("check","ic-sm"):(i+1)))+'</span><div><b>'+escapeHtml(l.title)+'</b><span>'+lockLabel+'</span>'+sub+'</div></div>';
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

  var isDoneAlready = doneIds.indexOf(lesson.id)!==-1;
  var stages = lessonStagesFor(lesson);
  var stage = stages.indexOf(studentState.lessonStage)!==-1 ? studentState.lessonStage : "intro";
  var isBookmarked = (course.bookmarkedLessonIds||[]).indexOf(lesson.id)!==-1;

  var body = '<div class="lesson-body">' +
    '<button class="back-link" data-action="close-course">← К курсу</button>' +
    '<div class="lesson-head">' +
      '<h3>'+escapeHtml(lesson.title)+'</h3>' +
      '<button class="btn btn-sm btn-ghost lesson-save" data-action="toggle-bookmark" data-id="'+lesson.id+'" data-bookmarked="'+(isBookmarked?"1":"0")+'" title="'+(isBookmarked?"Убрать из конспекта":"Сохранить урок в конспект")+'" aria-label="'+(isBookmarked?"Убрать из конспекта":"Сохранить урок в конспект")+'">'+(isBookmarked?"★":"☆")+'<span>'+(isBookmarked?" В конспекте":" Сохранить")+'</span></button>' +
    '</div>' +
    '<div class="meta">Урок '+(idx+1)+' из '+course.lessons.length+' · '+escapeHtml(lesson.duration||"")+'</div>';

  var tocMenu = stage==="intro" ? lessonTocMenu(lessonToc(lesson.html)) : "";
  if(stages.length>1 || tocMenu){
    var stageLabels = { intro:"Материал", video:"Видео", quiz:"Тест", task:"Задание" };
    body += '<div class="lesson-tabs-row">';
    if(stages.length>1){
      body += '<div class="tabs" style="margin:14px 0 4px;">';
      stages.forEach(function(sKey){
        body += '<button type="button" class="tab'+(stage===sKey?' active':'')+'" data-action="lesson-stage" data-stage="'+sKey+'">'+stageLabels[sKey]+'</button>';
      });
      body += '</div>';
    }
    body += tocMenu + '</div>';
  }

  if(stage==="intro"){
    var noteVal = (course.progress && course.progress.lesson_notes && course.progress.lesson_notes[lesson.id]) || "";
    var opener = lessonOpener(lesson);
    body += '<div class="prose lesson-text" id="lessonProse" data-lesson-id="'+lesson.id+'">'+opener.rest+'</div>' +
      (previewMode ? '' : '<p class="sel-hint">'+icon("star","ic-sm")+' Выделите фрагмент текста — его можно отметить маркером, добавить в заметку или задать по нему вопрос куратору.</p>') +
      '<div class="lesson-note">' +
        '<label>Ваша заметка к уроку <span style="font-weight:400;color:var(--muted-2);">(видна только вам)</span></label>' +
        '<textarea class="input" id="lessonNoteInput" style="height:64px;font-size:14px;" placeholder="Например: спросить куратора про дозировки">'+escapeHtml(noteVal)+'</textarea>' +
        '<button class="btn btn-sm btn-ghost" style="margin-top:8px;" data-action="save-lesson-note" data-id="'+lesson.id+'">Сохранить заметку</button>' +
      '</div>';
    if(stages.length>1){
      body += '<div class="lesson-footer"><span></span><button class="btn btn-primary" data-action="lesson-stage" data-stage="'+stages[1]+'">Далее → '+stageLabels[stages[1]]+'</button></div>';
    } else {
      var isLast = idx === course.lessons.length-1;
      body += '<div class="lesson-footer">' +
        '<button class="btn btn-ghost" data-action="prev-lesson"'+(idx===0?' disabled':'')+'>← Предыдущий</button>' +
        '<button class="btn btn-primary" data-action="next-lesson">'+(isLast?"Перейти к тесту":"Урок пройден, далее →")+'</button>' +
      '</div>';
    }
  } else if(stage==="video"){
    body += renderLessonVideoStage(lesson, stages, isDoneAlready);
  } else if(stage==="quiz"){
    body += renderLessonQuizStage(lesson);
  } else if(stage==="task"){
    body += renderLessonTaskStage(lesson, stages);
  }

  body += '</div>';
  return el('<div class="player" style="margin-top:6px;">'+nav+body+'</div>');
}

// «Вход» в материал урока: без него вкладки сразу переходили в сплошной текст и
// было непонятно, что урок начался. Лектор выносится из первого абзаца («Урок
// ведёт <b>Имя</b> — …»), разделы урока (заголовки h4) — оглавлением со ссылками,
// шпаргалка в конце — отдельной ссылкой. Если в тексте нет ни лектора, ни
// заголовков, карточка всё равно показывает номер урока, время и шаги.
// Оглавление урока: разделы (заголовки h4) и шпаргалка. В самом тексте урока над
// ним ничего не выводится: на компьютере разделы стоят под текущим уроком в списке
// слева, на телефоне — в меню «Содержание» справа от вкладок. Строка «Урок ведёт …»
// остаётся первым абзацем текста, только приглушённым.
function lessonToc(html){
  var toc = [], re = /<h4[^>]*>([\s\S]*?)<\/h4>/g, h, i = 0;
  while((h = re.exec(html||""))){
    var t = h[1].replace(/<[^>]+>/g,"").trim();
    toc.push({ title: t==="Шпаргалка" ? "Шпаргалка" : t, i: String(i), cheat: t==="Шпаргалка" }); i++;
  }
  if(!toc.some(function(x){ return x.cheat; }) && /class="lb lb-cheat"/.test(html||"")) toc.push({ title:"Шпаргалка", i:"cheat", cheat:true });
  return toc;
}
function lessonOpener(lesson){
  var rest = (lesson.html || "").replace(/^\s*<p>(\s*Урок ведёт\s*<b>)/, '<p class="lo-lect">$1');
  return { html: "", rest: rest };
}
function lessonTocMenu(toc){
  if(!toc.length) return "";
  return '<div class="lo-toc-wrap"><button type="button" class="lo-toc-btn" data-action="lesson-toc-menu">'+icon("list","ic-sm")+'Содержание</button></div>' +
    '<div class="lo-dd" id="lessonTocMenu" hidden>' + toc.map(function(x){
      return '<button type="button" class="'+(x.cheat?'mut':'')+'" data-action="lesson-toc" data-i="'+x.i+'">'+escapeHtml(x.title)+'</button>';
    }).join('') + '</div>';
}
// Подсветка раздела, который сейчас читают (список слева и меню «Содержание»).
function lessonTocSpy(){
  var prose = document.getElementById("lessonProse");
  if(!prose) return;
  var marks = [].slice.call(prose.querySelectorAll("h4")).map(function(h, i){ return { el:h, i:String(i) }; });
  var ch = prose.querySelector(".lb-cheat");
  if(ch && !marks.some(function(m){ return /Шпаргалка/.test(m.el.textContent); })) marks.push({ el:ch, i:"cheat" });
  var cur = marks.length ? marks[0].i : null;
  marks.forEach(function(m){ if(m.el.getBoundingClientRect().top < 140) cur = m.i; });
  document.querySelectorAll('.lesson-sub [data-action="lesson-toc"], #lessonTocMenu [data-action="lesson-toc"]').forEach(function(x){
    x.classList.toggle("on", x.getAttribute("data-i")===cur);
  });
}
var lessonTocSpyQueued = false;
window.addEventListener("scroll", function(){
  if(lessonTocSpyQueued) return; lessonTocSpyQueued = true;
  requestAnimationFrame(function(){ lessonTocSpyQueued = false; lessonTocSpy(); });
}, { passive:true });
document.addEventListener("click", function(e){
  var m = document.getElementById("lessonTocMenu");
  if(m && !m.hidden && !e.target.closest(".lo-toc-wrap, #lessonTocMenu")) m.hidden = true;
});

function renderLessonVideoStage(lesson, stages, isDoneAlready){
  var tcs = lesson.videoTimecodes||[];
  var html = '<div class="lesson-video-wrap"><video id="lessonVideoPlayer" controls preload="metadata" src="'+escapeHtml(lesson.videoUrl)+'"></video></div>';

  if(tcs.length){
    // Раньше здесь были ещё и главы-«пилюли» в ряд над этим блоком — тот же список,
    // только без диапазонов. Дублировали один и тот же список глав дважды подряд,
    // убрал: список диапазонов ниже кликабелен точно так же (тот же chapter-item
    // и data-action) и вдобавок показывает конец каждой главы.
    html += '<div id="lessonChapterSummary" class="prose" style="min-height:24px;">'+renderPlainToProse(tcs[0].summary||'')+'</div>';
    html += '<div class="video-timecodes">';
    tcs.forEach(function(tc,i){
      var next = tcs[i+1];
      var range = fmtTimecode(tc.time) + (next ? '–'+fmtTimecode(next.time) : '');
      html += '<button type="button" class="chapter-item video-timecode-row" data-action="seek-lesson-video" data-time="'+tc.time+'" data-chapter-id="'+tc.id+'">' +
        '<span class="video-timecode-range">'+range+'</span><span class="video-timecode-title">'+escapeHtml(tc.title)+'</span></button>';
    });
    html += '</div>';
  }

  var hasQuiz = stages.indexOf("quiz")!==-1;
  var canProceed = isDoneAlready || studentState.videoEnded;
  html += '<div class="lesson-footer">' +
    '<button class="btn btn-ghost" data-action="lesson-stage" data-stage="intro">← К материалу</button>';
  if(hasQuiz){
    html += '<button class="btn btn-primary" data-action="lesson-stage" data-stage="quiz">Пройти тест →</button>';
  } else if(stages.indexOf("task")!==-1){
    html += '<button class="btn btn-primary" data-action="lesson-stage" data-stage="task"'+(canProceed?'':' disabled title="Досмотрите видео до конца"')+'>К заданию →</button>';
  } else {
    html += '<button class="btn btn-primary" data-action="next-lesson"'+(canProceed?'':' disabled title="Досмотрите видео до конца"')+'>Урок пройден, далее →</button>';
  }
  html += '</div>';
  return html;
}

/* ============================= ТЕСТЫ: ОБЩИЙ ПОШАГОВЫЙ ДВИЖОК ============================= */
// Один движок для теста урока, теста модуля и итогового теста: по одному вопросу
// на экране, полоска прогресса, свой элемент ввода под тип вопроса (см. src/quiz.js):
//   single — карточки A/B/C (выбор = сразу к следующему), multi — «отметьте все
//   верные», order — перетащить / стрелками, number — поле с единицей измерения,
//   match — к каждому пункту слева выбрать пару, case — описание пациента и шаги.
// Ответы копятся в quizRuns[key].answers «плоско» по пути: qid или qid#шаг.
var QZ_LETTERS = "ABCDEFGH";
var quizRuns = {};
function quizRun(key){ return quizRuns[key] || (quizRuns[key] = { step:0, answers:{} }); }
function qzParseNum(v){ if(v==null || String(v).trim()==="") return null; var n = parseFloat(String(v).replace(",", ".").replace(/\s+/g, "")); return isFinite(n) ? n : null; }
function qzAnswered(def, val){
  var t = def.type || "single";
  if(t==="single") return typeof val==="number";
  if(t==="multi") return Array.isArray(val) && val.length>0;
  if(t==="number") return qzParseNum(val)!==null;
  if(t==="order") return true;
  if(t==="match") return !!val && (def.left||[]).every(function(_, i){ return !!val[i]; });
  return false;
}
function qzQuestionDone(q, answers){
  if(q.type==="case") return (q.steps||[]).every(function(st, i){ return qzAnswered(st, answers[q.id+"#"+i]); });
  if(q.type==="order") return true;
  return qzAnswered(q, answers[q.id]);
}
// Ответы в том виде, какой ждёт сервер.
function qzBuildAnswers(questions, answers){
  var out = {};
  questions.forEach(function(q){
    if(q.type==="case") out[q.id] = (q.steps||[]).map(function(st, i){ var v = answers[q.id+"#"+i]; return st.type==="number" ? String(v==null?"":v) : v; });
    else if(q.type==="order") out[q.id] = answers[q.id] || (q.items||[]).map(function(it){ return it.token; });
    else if(q.type==="number") out[q.id] = String(answers[q.id]==null?"":answers[q.id]);
    else out[q.id] = answers[q.id];
  });
  return out;
}
function qzChoice(key, path, options, val, multi){
  return '<div class="qz-opts'+(multi?' multi':'')+'" role="'+(multi?'group':'radiogroup')+'">' + options.map(function(opt, oi){
    var on = multi ? (Array.isArray(val) && val.indexOf(oi)!==-1) : val===oi;
    return '<button type="button" role="'+(multi?'checkbox':'radio')+'" aria-checked="'+on+'" class="qz-opt'+(on?' on':'')+'" data-action="qr-pick" data-key="'+key+'" data-path="'+path+'" data-o="'+oi+'"'+(multi?' data-multi="1"':'')+'>' +
      '<span class="qz-key">'+(multi && on ? icon("check","ic-sm") : QZ_LETTERS[oi])+'</span><span class="qz-text">'+escapeHtml(opt)+'</span></button>';
  }).join("") + '</div>';
}
function qzNumber(key, path, unit, val){
  return '<div class="qz-num"><input class="input" inputmode="decimal" autocomplete="off" placeholder="Ваш ответ" data-qr-num="1" data-key="'+key+'" data-path="'+path+'" value="'+escapeHtml(val==null?"":String(val))+'">' +
    (unit ? '<span class="qz-unit">'+escapeHtml(unit)+'</span>' : '') + '</div>';
}
function qzOrder(key, q, val){
  var byTok = {}; (q.items||[]).forEach(function(it){ byTok[it.token] = it.text; });
  var order = Array.isArray(val) && val.length ? val : (q.items||[]).map(function(it){ return it.token; });
  var n = order.length;
  return '<div class="qz-ord" data-key="'+key+'" data-path="'+q.id+'">' + order.map(function(tk, i){
    return '<div class="qz-ord-item" draggable="true" data-tok="'+tk+'">' +
      '<span class="qz-ord-grip" aria-hidden="true">⋮⋮</span><span class="qz-ord-n">'+(i+1)+'</span><span class="qz-ord-text">'+escapeHtml(byTok[tk]||"")+'</span>' +
      '<span class="qz-ord-btns"><button type="button" class="qz-ord-btn" data-action="qr-move" data-key="'+key+'" data-path="'+q.id+'" data-i="'+i+'" data-dir="-1"'+(i===0?' disabled':'')+' aria-label="Выше">↑</button>' +
      '<button type="button" class="qz-ord-btn" data-action="qr-move" data-key="'+key+'" data-path="'+q.id+'" data-i="'+i+'" data-dir="1"'+(i===n-1?' disabled':'')+' aria-label="Ниже">↓</button></span></div>';
  }).join("") + '</div>';
}
function qzMatch(key, q, val){
  val = val || {};
  var used = {}; Object.keys(val).forEach(function(k){ used[val[k]] = k; });
  return '<div class="qz-match">' + (q.left||[]).map(function(l, li){
    return '<div class="qz-mrow"><div class="qz-mleft"><span class="qz-mnum">'+(li+1)+'</span>'+escapeHtml(l)+'</div><div class="qz-mright">' +
      (q.right||[]).map(function(r){
        var on = val[li]===r.token, taken = !on && used[r.token]!=null;
        return '<button type="button" class="qz-chip'+(on?' on':'')+(taken?' taken':'')+'" data-action="qr-match" data-key="'+key+'" data-path="'+q.id+'" data-l="'+li+'" data-t="'+r.token+'">'+escapeHtml(r.text)+(taken?'<i>'+(parseInt(used[r.token],10)+1)+'</i>':'')+'</button>';
      }).join("") + '</div></div>';
  }).join("") + '</div>';
}
function qzInput(key, q, answers){
  var t = q.type || "single";
  if(t==="multi") return '<p class="qz-sub">Отметьте все верные варианты</p>' + qzChoice(key, q.id, q.options, answers[q.id], true);
  if(t==="number") return qzNumber(key, q.id, q.unit, answers[q.id]);
  if(t==="order") return '<p class="qz-sub">Перетащите или расставьте стрелками — сверху первый шаг</p>' + qzOrder(key, q, answers[q.id]);
  if(t==="match") return '<p class="qz-sub">Для каждого пункта слева выберите пару</p>' + qzMatch(key, q, answers[q.id]);
  if(t==="case"){
    return '<div class="qz-steps">' + (q.steps||[]).map(function(st, i){
      var path = q.id+"#"+i, v = answers[path];
      return '<div class="qz-step"><div class="qz-step-head"><span class="qz-step-n">Шаг '+(i+1)+'</span><b>'+escapeHtml(st.question)+'</b></div>' +
        (st.type==="number" ? qzNumber(key, path, st.unit, v)
          : (st.type==="multi" ? '<p class="qz-sub">Отметьте все верные</p>' : '') + qzChoice(key, path, st.options, v, st.type==="multi")) + '</div>';
    }).join("") + '</div>';
  }
  return qzChoice(key, q.id, q.options, answers[q.id], false);
}
var QZ_TYPE_LABELS = { multi:"Несколько верных", order:"Порядок", number:"Число", match:"Сопоставление", "case":"Клинический случай" };
function renderQuizRunner(key, questions, o){
  o = o || {};
  var run = quizRun(key), ans = run.answers;
  var step = Math.min(run.step||0, questions.length-1), q = questions[step];
  // «Порядок» считается ответом сразу (врач может согласиться с исходным), фиксируем его.
  if(q.type==="order" && !ans[q.id]) ans[q.id] = (q.items||[]).map(function(it){ return it.token; });
  var done = questions.map(function(x){ return qzQuestionDone(x, ans); });
  var firstOpen = done.indexOf(false); if(firstOpen===-1) firstOpen = questions.length;
  var allDone = firstOpen===questions.length, thisDone = done[step];
  var kind = QZ_TYPE_LABELS[q.type];
  var html = '<div class="qz" data-key="'+key+'">' +
    '<div class="qz-top"><span class="qz-count">Вопрос <b>'+(step+1)+'</b> из '+questions.length+'</span><span class="qz-prev">'+(o.hint||"")+'</span></div>' +
    '<div class="qz-bar">' + questions.map(function(x, i){
      var cls = i===step ? ' cur' : (done[i] ? ' done' : '');
      var can = i===step || done[i] || i<=firstOpen;
      return '<button type="button" class="qz-seg'+cls+'"'+(can?' data-action="qr-goto" data-key="'+key+'" data-i="'+i+'"':' disabled')+' aria-label="Вопрос '+(i+1)+'"></button>';
    }).join("") + '</div>' +
    '<div class="qz-card'+(q.type==="case"?' is-case':'')+'">' +
      (kind ? '<span class="qz-kind">'+kind+'</span>' : '') +
      (q.type==="case" ? '<div class="qz-scenario">'+icon("doctor","ic-sm")+'<p>'+escapeHtml(q.scenario||"")+'</p></div>' : '') +
      '<p class="qz-q">'+escapeHtml(q.question)+'</p>' + qzInput(key, q, ans) +
    '</div>' +
    '<div class="qz-nav">' +
      '<button type="button" class="btn btn-ghost" data-action="qr-prev" data-key="'+key+'"'+(step===0?' disabled':'')+'>← Назад</button>' +
      '<span class="qz-hint">'+((q.type||"single")==="single" || q.type==="multi" ? 'Можно выбирать клавишами 1–'+q.options.length : (q.type==="number" ? 'Enter — дальше' : ''))+'</span>' +
      (step===questions.length-1
        ? '<button type="button" class="btn btn-primary" data-action="qr-submit" data-key="'+key+'" data-qr-next="1"'+(allDone?'':' disabled title="Ответьте на все вопросы"')+'>'+(o.submitLabel||"Завершить тест")+'</button>'
        : '<button type="button" class="btn btn-primary" data-action="qr-next" data-key="'+key+'" data-qr-next="1"'+(thisDone?'':' disabled')+'>Далее →</button>') +
    '</div></div>';
  return html;
}
function qzQuestionsFor(key){
  if(/^preview:/.test(key)) return (previewQuizCache[key] && previewQuizCache[key].questions) || [];
  if(!course) return [];
  if(key==="final") return course.quiz || [];
  var m = key.match(/^(lesson|module):(.+)$/); if(!m) return [];
  if(m[1]==="lesson"){ var l = course.lessons.find(function(x){ return x.id===m[2]; }); return (l && l.quiz) || []; }
  var md = (course.modules||[]).find(function(x){ return x.id===m[2]; }); return (md && md.quiz) || [];
}
function qzSetButtons(key){
  var qs = qzQuestionsFor(key), run = quizRun(key), q = qs[Math.min(run.step||0, qs.length-1)];
  var btn = document.querySelector('[data-qr-next][data-key="'+key+'"]'); if(!btn || !q) return;
  btn.disabled = btn.getAttribute("data-action")==="qr-submit" ? !qs.every(function(x){ return qzQuestionDone(x, run.answers); }) : !qzQuestionDone(q, run.answers);
}
var qzAdvanceTimer = null;
function qzGo(key, step){ clearTimeout(qzAdvanceTimer); quizRun(key).step = step; render(); }
function qzPick(key, path, oi, multi){
  var run = quizRun(key), qs = qzQuestionsFor(key);
  if(multi){
    var arr = Array.isArray(run.answers[path]) ? run.answers[path].slice() : [];
    var at = arr.indexOf(oi); if(at===-1) arr.push(oi); else arr.splice(at, 1);
    run.answers[path] = arr; render(); return;
  }
  run.answers[path] = oi;
  var step = run.step||0, q = qs[step];
  render();
  clearTimeout(qzAdvanceTimer);
  // Одиночный выбор — сразу к следующему вопросу (в случае из нескольких шагов — нет).
  if(q && (q.type||"single")==="single" && path===q.id && step < qs.length-1){
    qzAdvanceTimer = setTimeout(function(){ if(quizRun(key).step===step && document.querySelector('.qz[data-key="'+key+'"]')){ quizRun(key).step = step+1; render(); } }, 420);
  }
}
async function qzSubmit(key){
  var qs = qzQuestionsFor(key), answers = qzBuildAnswers(qs, quizRun(key).answers);
  var btn = document.querySelector('[data-action="qr-submit"][data-key="'+key+'"]'); if(btn){ btn.disabled = true; btn.textContent = "Считаем результат…"; }
  var fail = function(err){ showToast(err.message); if(btn){ btn.disabled = false; btn.textContent = "Завершить тест"; } };
  if(key.indexOf("lesson:")===0) return submitLessonQuiz(key.slice(7), answers, fail);
  if(key.indexOf("module:")===0){
    var mid = key.slice(7);
    if(previewMode){ studentState.moduleQuizResult = { score:100 }; render(); return; }
    try{
      var rmq = await api("/course/modules/"+mid+"/quiz-submit", { method:"POST", body: JSON.stringify({ answers: answers }) });
      if(!course.progress.module_quiz_scores) course.progress.module_quiz_scores = {};
      course.progress.module_quiz_scores[mid] = rmq.score;
      studentState.moduleQuizResult = { score: rmq.score };
      delete quizRuns[key];
    }catch(err){ fail(err); return; }
    render(); return;
  }
  if(previewMode){
    course.progress.quiz_score = 100; course.progress.completed = true; course.progress.certificate_status = "pending";
    studentState.quizSubmitted = true; render(); return;
  }
  try{
    var r3 = await api("/course/quiz-submit", { method:"POST", body: JSON.stringify({ answers: answers, courseId: activeCourseId }) });
    course.progress.quiz_score = r3.score; course.progress.completed = r3.completed; course.progress.certificate_status = r3.certificateStatus;
    await loadCourse(); // очки/стрик пересчитываются на сервере из всего прогресса разом
    studentState.quizSubmitted = true;
    delete quizRuns[key];
  }catch(err){ fail(err); return; }
  render();
}

// Тест урока: разбор после отправки (тест для закрепления, на сертификат не влияет).
function renderLessonQuizStage(lesson){
  if(studentState.lessonQuizResult) return renderLessonQuizResult(lesson, studentState.lessonQuizResult);
  var prevScore = course.progress && course.progress.lesson_quiz_scores && course.progress.lesson_quiz_scores[lesson.id];
  return renderQuizRunner("lesson:"+lesson.id, lesson.quiz || [], {
    hint: typeof prevScore==="number" ? 'прошлый результат — '+prevScore+'%' : 'для закрепления, на итоговый результат не влияет'
  });
}
function qzPill(ok, letter, text){ return '<span class="qz-rv-pill '+(ok?'ok':'bad')+'">'+(letter?'<i>'+letter+'</i>':'')+escapeHtml(text)+'</span>'; }
function qzNumText(v, unit){ return (v==null ? "—" : String(v).replace(".", ",")) + (unit ? " "+unit : ""); }
// Разбор одного вопроса или шага случая: что выбрано и что верно — в виде, удобном типу.
function qzReviewBody(def, r){
  var t = def.type || "single", ok = r.score>=0.999;
  if(t==="single"){
    return (r.chosen!=null ? qzPill(ok, QZ_LETTERS[r.chosen], def.options[r.chosen]||"") : '') +
      (ok ? '' : '<span class="qz-rv-right">верно: '+qzPill(true, QZ_LETTERS[r.correct], def.options[r.correct]||"")+'</span>');
  }
  if(t==="multi"){
    var all = def.options.map(function(opt, i){
      var picked = (r.chosen||[]).indexOf(i)!==-1, right = (r.correct||[]).indexOf(i)!==-1;
      if(!picked && !right) return '';
      var cls = picked && right ? 'ok' : (picked ? 'bad' : 'miss');
      return '<span class="qz-rv-pill '+cls+'"><i>'+(picked && right ? '✓' : picked ? '✕' : '+')+'</i>'+escapeHtml(opt)+'</span>';
    }).join("");
    return all + (ok ? '' : '<span class="qz-rv-legend">✓ верно · ✕ лишний · + пропущен</span>');
  }
  if(t==="number"){
    var c = r.correct || {}, range = c.min!==c.max ? ' (засчитывается '+qzNumText(c.min)+'–'+qzNumText(c.max, c.unit)+')' : '';
    return qzPill(ok, '', qzNumText(r.chosen, def.unit)) + (ok ? '' : '<span class="qz-rv-right">верно: '+qzPill(true, '', qzNumText(c.answer, c.unit))+range+'</span>');
  }
  if(t==="order"){
    var byTok = {}; (def.items||[]).forEach(function(it){ byTok[it.token] = it.text; });
    return '<ol class="qz-rv-order">' + (r.correct||[]).map(function(tk, i){
      var mine = (r.chosen||[])[i]===tk;
      return '<li class="'+(mine?'ok':'bad')+'"><span>'+(i+1)+'</span>'+escapeHtml(byTok[tk]||"")+(mine?'':' <em>у вас: '+escapeHtml(byTok[(r.chosen||[])[i]]||"—")+'</em>')+'</li>';
    }).join("") + '</ol>';
  }
  if(t==="match"){
    var rt = {}; (def.right||[]).forEach(function(x){ rt[x.token] = x.text; });
    return '<div class="qz-rv-match">' + (def.left||[]).map(function(l, i){
      var mine = (r.chosen||{})[i], right = (r.correct||{})[i], good = mine===right;
      return '<div class="'+(good?'ok':'bad')+'"><b>'+escapeHtml(l)+'</b><span>→ '+escapeHtml(rt[right]||"")+(good?'':' <em>у вас: '+escapeHtml(rt[mine]||"—")+'</em>')+'</span></div>';
    }).join("") + '</div>';
  }
  return '';
}
function renderLessonQuizResult(lesson, result){
  var qs = lesson.quiz || [];
  var total = result.total || qs.length, right = typeof result.correctCount==="number" ? result.correctCount : Math.round(result.score*total/100);
  var mood = result.score===100 ? ["Отлично — всё верно", "Материал урока усвоен полностью."]
    : result.score>=60 ? ["Хороший результат", "Посмотрите разбор ниже — там видно, где была ошибка."]
    : ["Стоит повторить материал", "Загляните в разбор и перечитайте урок — тест можно пройти ещё раз."];
  var html = '<div class="qz qz-result">' +
    '<div class="qz-res-head"><div class="progress-ring qz-ring'+(result.score>=60?'':' low')+'" data-anim="ring" style="--ring-p:'+result.score+'%;"><div class="progress-ring-inner"><span data-count="'+result.score+'" data-suffix="%">'+result.score+'%</span></div></div>' +
      '<div><b class="qz-res-title">'+mood[0]+'</b><p class="qz-res-sub">'+right+' из '+total+' '+ruPluralClient(total,"ответа","ответов","ответов")+' полностью верно. '+mood[1]+'</p></div></div>';
  if(result.review && result.review.length){
    html += '<div class="qz-review">' + result.review.map(function(r, i){
      var q = qs.find(function(x){ return x.id===r.id; }); if(!q) return "";
      var ok = r.score>=0.999, part = !ok && r.score>0;
      var body = q.type==="case"
        ? '<p class="qz-rv-scn">'+escapeHtml(q.scenario||"")+'</p>' + (r.steps||[]).map(function(sr, si){
            var st = (q.steps||[])[si] || {};
            return '<div class="qz-rv-step"><span class="qz-step-n">Шаг '+(si+1)+'</span><b>'+escapeHtml(st.question||"")+'</b><div class="qz-rv-ans">'+qzReviewBody(st, sr)+'</div></div>';
          }).join("")
        : '<div class="qz-rv-ans">'+qzReviewBody(q, r)+'</div>';
      return '<div class="qz-rv'+(ok?' ok':(part?' part':' bad'))+'"><div class="qz-rv-head"><span class="qz-rv-mark">'+(ok?icon("check","ic-sm"):(part?'½':icon("close","ic-sm")))+'</span>' +
        '<b>'+(i+1)+'. '+escapeHtml(q.question)+'</b>'+(part?'<span class="qz-rv-score">'+Math.round(r.score*100)+'%</span>':'')+'</div>' + body + '</div>';
    }).join("") + '</div>';
  }
  html += '<div class="qz-nav"><button type="button" class="btn btn-ghost" data-action="lq-retry">Пройти ещё раз</button><span></span>' +
    (lesson.assignment
      ? '<button class="btn btn-primary" data-action="lesson-stage" data-stage="task">Далее → задание</button>'
      : '<button class="btn btn-primary" data-action="next-lesson">Далее →</button>') + '</div></div>';
  return html;
}
async function submitLessonQuiz(lessonId, answers, fail){
  var wasProtoAvailLQ = protocolsSectionAvailable();
  if(previewMode){
    studentState.lessonQuizResult = { score:100 };
    if(course.progress.completed_lessons.indexOf(lessonId)===-1) course.progress.completed_lessons.push(lessonId);
    maybeCelebrateProtocolsUnlock(wasProtoAvailLQ);
    render(); return;
  }
  try{
    var rlq = await api("/course/lessons/"+lessonId+"/quiz-submit", { method:"POST", body: JSON.stringify({ answers: answers }) });
    course.progress.completed_lessons = rlq.completedLessons;
    if(rlq.gamification) course.gamification = Object.assign({}, course.gamification, rlq.gamification);
    if(!course.progress.lesson_quiz_scores) course.progress.lesson_quiz_scores = {};
    course.progress.lesson_quiz_scores[lessonId] = rlq.score;
    studentState.lessonQuizResult = { score: rlq.score, correctCount: rlq.correctCount, total: rlq.total, review: rlq.review };
    delete quizRuns["lesson:"+lessonId];
    maybeCelebrateProtocolsUnlock(wasProtoAvailLQ);
    render(); window.scrollTo({ top:0, behavior:"smooth" });
  }catch(err){ fail(err); }
}
// Открытый сейчас тест (если есть) — для клавиатуры.
function qzActiveKey(){ var el0 = document.querySelector("#app .qz[data-key]"); return el0 ? el0.getAttribute("data-key") : null; }
document.addEventListener("keydown", function(e){
  if(view!=="student" || e.ctrlKey || e.metaKey || e.altKey) return;
  var key = qzActiveKey(); if(!key) return;
  var qs = qzQuestionsFor(key), run = quizRun(key), step = Math.min(run.step||0, qs.length-1), q = qs[step]; if(!q) return;
  var typing = isTypingNow();
  if(e.key==="Enter" && (!typing || (document.activeElement && document.activeElement.hasAttribute("data-qr-num")))){
    if(!qzQuestionDone(q, run.answers)) return;
    e.preventDefault();
    if(step < qs.length-1) qzGo(key, step+1);
    else if(qs.every(function(x){ return qzQuestionDone(x, run.answers); })) qzSubmit(key);
    return;
  }
  if(typing) return;
  var t = q.type || "single";
  if(t==="single" || t==="multi"){
    var k = e.key.toUpperCase(), map = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5, "A":0,"B":1,"C":2,"D":3,"E":4,"F":5, "А":0,"Б":1,"В":2,"Г":3 };
    if(k in map && map[k] < q.options.length){ e.preventDefault(); qzPick(key, q.id, map[k], t==="multi"); return; }
  }
  if(e.key==="ArrowLeft" && step>0) qzGo(key, step-1);
  if(e.key==="ArrowRight" && step<qs.length-1 && qzQuestionDone(q, run.answers)) qzGo(key, step+1);
});
// Ввод числа — без перерисовки (фокус и курсор в поле не прыгают), только кнопка «Далее».
document.addEventListener("input", function(e){
  var inp = e.target.closest && e.target.closest("[data-qr-num]"); if(!inp) return;
  var key = inp.getAttribute("data-key");
  quizRun(key).answers[inp.getAttribute("data-path")] = inp.value;
  qzSetButtons(key);
});
// Перетаскивание в вопросе «порядок» (мышью; на телефоне — стрелки).
var qzDragTok = null;
document.addEventListener("dragstart", function(e){
  var it = e.target.closest && e.target.closest(".qz-ord-item"); if(!it) return;
  qzDragTok = it.getAttribute("data-tok"); it.classList.add("dragging");
  try{ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", qzDragTok); }catch(err){}
});
document.addEventListener("dragover", function(e){
  if(!qzDragTok) return;
  var it = e.target.closest && e.target.closest(".qz-ord-item"); if(!it) return;
  e.preventDefault();
  var list = it.parentElement, dragged = list.querySelector('.qz-ord-item[data-tok="'+qzDragTok+'"]'); if(!dragged || dragged===it) return;
  var r = it.getBoundingClientRect();
  list.insertBefore(dragged, e.clientY < r.top + r.height/2 ? it : it.nextSibling);
});
document.addEventListener("dragend", function(e){
  if(!qzDragTok) return;
  var list = e.target.closest && e.target.closest(".qz-ord");
  qzDragTok = null;
  if(!list) return;
  quizRun(list.getAttribute("data-key")).answers[list.getAttribute("data-path")] = [].map.call(list.querySelectorAll(".qz-ord-item"), function(x){ return x.getAttribute("data-tok"); });
  render();
});


// Гейт после последнего урока модуля: сначала итоговый тест по модулю (если у него
// есть вопросы), потом мини-опрос — оба шага в одном "плеере", без сайдбара с
// уроками (тот же приём, что и renderQuizOrCert для итогового теста курса).
function renderModuleGate(){
  var mod = (course.modules||[]).find(function(m){ return m.id===studentState.moduleGateId; });
  if(!mod){ resetModuleGateState(); return renderCoursePlayer(); }
  var body = '<div class="lesson-body">' +
    (studentState.moduleGateStage==="quiz" ? renderModuleQuizStage(mod) : renderModuleFeedbackStage(mod)) +
  '</div>';
  return el('<div class="player" style="margin-top:6px;grid-template-columns:minmax(0,1fr);">'+body+'</div>');
}

function renderModuleQuizStage(mod){
  var result = studentState.moduleQuizResult;
  if(result){
    return '<div class="qz qz-result"><div class="qz-res-head"><div class="progress-ring qz-ring'+(result.score>=60?'':' low')+'" data-anim="ring" style="--ring-p:'+result.score+'%;"><div class="progress-ring-inner"><span data-count="'+result.score+'" data-suffix="%">'+result.score+'%</span></div></div>' +
      '<div><b class="qz-res-title">Тест модуля пройден</b><p class="qz-res-sub">Итоговый тест модуля «'+escapeHtml(mod.title)+'» — для закрепления материала.</p></div></div>' +
      '<div class="qz-nav"><span></span><span></span><button class="btn btn-primary" data-action="module-gate-to-feedback">Далее → короткий отзыв</button></div></div>';
  }
  return '<div class="meta" style="margin-bottom:2px;">Модуль «'+escapeHtml(mod.title)+'» пройден</div>' +
    '<h3 style="margin:4px 0 14px;">Итоговый тест модуля</h3>' +
    renderQuizRunner("module:"+mod.id, mod.quiz || [], { hint: 'для закрепления материала' });
}

// Интерактивный мини-тест обратной связи — не текстовая форма, а клик по звёздам
// (обязателен) + необязательный комментарий. Кнопка недоступна, пока не выбрана оценка.
function renderModuleFeedbackStage(mod){
  var rating = studentState.moduleFeedbackRating || 0;
  var html = '<div class="meta" style="margin-bottom:2px;">Модуль «'+escapeHtml(mod.title)+'» пройден</div>' +
    '<h3 style="margin-top:4px;">Как вам этот модуль?</h3>' +
    '<p class="meta">Оцените и, если хотите, добавьте пару слов — куратор это увидит.</p>' +
    '<div style="display:flex;gap:4px;margin:18px 0 14px;">';
  for(var i=1;i<=5;i++){
    html += '<button type="button" class="star-btn'+(i<=rating?' active':'')+'" data-action="set-module-feedback-rating" data-value="'+i+'" aria-label="'+i+' из 5">'+icon("star","ic-lg")+'</button>';
  }
  html += '</div>' +
    '<textarea class="input" id="moduleFeedbackComment" style="height:80px;" placeholder="Комментарий необязателен">'+escapeHtml(studentState.moduleFeedbackComment||"")+'</textarea>' +
    '<button class="btn btn-primary" style="margin-top:14px;" data-action="submit-module-feedback" data-module-id="'+mod.id+'"'+(rating?'':' disabled')+'>Отправить и продолжить</button>' +
    (rating?'':'<p class="hint" style="margin-top:6px;">Выберите оценку, чтобы продолжить.</p>');
  return html;
}

function renderQuizOrCert(){
  var pr = course.progress || {};
  if(pr.completed && !studentState.quizSubmitted) return renderCertificate();
  if(course.quizHiddenForMe){
    return el('<div class="player" style="margin-top:6px;grid-template-columns:minmax(0,1fr);"><div class="lesson-body">' +
      '<button class="back-link" data-action="close-course">← К курсу</button>' +
      '<div class="empty-state" style="padding:60px 10px;"><div class="big">'+icon("lock","ic-lg")+'</div>Итоговый тест временно недоступен.<br>Куратор откроет его позже.</div></div></div>');
  }

  // Стоп-уроки держат итоговый тест (сервер тоже не примет ответы) — говорим об
  // этом до того, как врач потратит время на вопросы.
  var stopPending = course.lessons.map(function(l,i){ return { l:l, i:i }; }).filter(function(x){
    var a = x.l.assignment, sub = (course.assignments||{})[x.l.id];
    return a && a.required && !x.l.hiddenForMe && !(sub && sub.status==="accepted");
  });
  if(stopPending.length){
    var sh = '<div class="player" style="margin-top:6px;grid-template-columns:minmax(0,1fr);"><div class="lesson-body">' +
      '<button class="back-link" data-action="close-course">← К курсу</button>' +
      '<h3>Итоговый тест</h3><div class="task-state pending" style="margin-top:14px;"><b>'+icon("lock","ic-sm")+' Откроется, когда куратор примет обязательные задания</b></div>';
    stopPending.forEach(function(x){
      var sub = (course.assignments||{})[x.l.id];
      var st = !sub ? "ответ ещё не отправлен" : (sub.status==="pending" ? "на проверке" : "вернули на доработку");
      sh += '<div class="stop-row" data-action="open-lesson-task" data-idx="'+x.i+'"><span>Урок '+(x.i+1)+' · '+escapeHtml(x.l.title)+'</span><em>'+st+' →</em></div>';
    });
    return el(sh + '</div></div>');
  }

  // Только что сдали — итог (без разбора: итоговый тест правильные ответы не раскрывает).
  if(studentState.quizSubmitted && typeof pr.quiz_score==="number"){
    var fsc = pr.quiz_score, passed = fsc>=60, certsOnF = course.course && course.course.certificatesEnabled;
    return el('<div class="player" style="margin-top:6px;grid-template-columns:minmax(0,1fr);"><div class="lesson-body">' +
      '<button class="back-link" data-action="close-course">← К курсу</button><h3 style="margin-bottom:14px;">Итоговый тест</h3>' +
      '<div class="qz qz-result"><div class="qz-res-head"><div class="progress-ring qz-ring'+(passed?'':' low')+'" data-anim="ring" style="--ring-p:'+fsc+'%;"><div class="progress-ring-inner"><span data-count="'+fsc+'" data-suffix="%">'+fsc+'%</span></div></div>' +
        '<div><b class="qz-res-title">'+(passed?'Тест сдан':'Пока не хватило баллов')+'</b><p class="qz-res-sub">'+(passed
          ? (certsOnF ? 'Куратор проверит результат и выдаст сертификат — вы получите уведомление.' : 'Курс пройден — теперь доступна скидка 10% на полное обучение.')
          : 'Для зачёта нужно от 60%. Повторите уроки, в которых сомневаетесь, и пройдите тест ещё раз.')+'</p></div></div>' +
      '<div class="qz-nav">'+(passed ? '<span></span><span></span><button class="btn btn-primary" data-action="final-quiz-done">'+(certsOnF?'К сертификату →':'Готово →')+'</button>'
        : '<button class="btn btn-ghost" data-action="close-course">К урокам</button><span></span><button class="btn btn-primary" data-action="final-quiz-retry">Пройти ещё раз</button>')+'</div></div></div></div>');
  }
  var html = '<div class="player" style="margin-top:6px;grid-template-columns:minmax(0,1fr);"><div class="lesson-body">' +
    '<button class="back-link" data-action="close-course">← К курсу</button>' +
    '<h3 style="margin-bottom:14px;">Итоговый тест</h3>' +
    renderQuizRunner("final", course.quiz || [], { hint: 'нужно набрать от 60%', submitLabel: 'Завершить тест' });
  html += '</div></div>';
  return el(html);
}

function renderCertificate(){
  var pr = course.progress || {};
  var certsOn = course && course.course && course.course.certificatesEnabled;
  var html = '<div class="player" style="margin-top:6px;grid-template-columns:minmax(0,1fr);"><div class="cert">';

  if(!certsOn){
    // Текущий курс — демо: сертификат за него не выдаётся, вместо этого предлагаем
    // скидку и заявку на полноценное обучение (см. существующий request-full-access).
    var requested = !!pr.requested_full_access;
    html += '<div class="seal">'+icon("badge","ic-lg")+'</div>' +
      '<h2>Поздравляем с прохождением демо-курса!</h2>' +
      '<p style="color:var(--muted);font-size:14px;">'+escapeHtml(me.name)+', «'+escapeHtml(course.course.title)+'»</p>' +
      '<div class="score">'+pr.quiz_score+'%</div>' +
      '<p style="color:var(--muted);font-size:13px;margin-bottom:24px;">правильных ответов в итоговом тесте</p>' +
      '<p style="font-size:14px;color:var(--muted);max-width:380px;margin:0 auto 24px;">Вы получили скидку 10% на обучение по курсу «Медицина Долголетия». Желаете присоединиться к полноценному обучению?</p>';
    if(requested){
      html += '<div style="margin-bottom:16px;">'+magnet("done","Заявка отправлена")+'</div>';
    } else {
      html += '<button class="btn btn-primary" data-action="request-full" style="margin-right:8px;">Да, хочу полное обучение</button>';
    }
    html += '<button class="btn" data-action="close-course">Вернуться к курсу</button></div></div>';
    return el(html);
  }

  var issued = pr.certificate_status === "issued";
  html += '<div class="seal'+(issued?'':' pending')+'">'+icon(issued?"badge":"clock","ic-lg")+'</div>' +
    '<h2>'+(issued?'Сертификат выдан':'Тест сдан — сертификат на проверке')+'</h2>' +
    '<p style="color:var(--muted);font-size:14px;">'+escapeHtml(me.name)+', «'+escapeHtml(course.course.title)+'»</p>' +
    '<div class="score">'+pr.quiz_score+'%</div>' +
    '<p style="color:var(--muted);font-size:13px;margin-bottom:24px;">правильных ответов в итоговом тесте</p>';
  if(!issued){
    html += '<p style="font-size:14px;color:var(--muted);max-width:360px;margin:0 auto 24px;">Куратор проверит результат и выдаст сертификат — он появится здесь автоматически.</p>';
  } else {
    html += '<p style="font-size:13px;color:var(--muted);margin:0 0 24px;">Выдан '+fmtDate(pr.certificate_issued_at)+(pr.certificate_issued_by?(' · '+escapeHtml(pr.certificate_issued_by)):'')+'</p>';
  }
  if(issued){
    html += '<a class="btn btn-primary" href="api/course/certificate/download?courseId='+encodeURIComponent(activeCourseId)+'" target="_blank" rel="noopener" style="margin-right:8px;">'+icon("download")+' Скачать сертификат (PDF)</a>';
  }
  html += '<button class="btn'+(issued?'':' btn-primary')+'" data-action="close-course">Вернуться к курсу</button></div></div>';
  return el(html);
}

// Три ступени вместо одной планки "всё или ничего" — врач видит скидку,
// которую уже заслужил, и сколько очков осталось до следующей ступени.
function renderPointTiers(points){
  var html = '<div style="display:flex;flex-direction:column;gap:2px;margin-bottom:4px;">';
  POINT_TIERS.forEach(function(t,idx){
    var unlocked = points >= t.points;
    html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;'+(idx<POINT_TIERS.length-1?'border-bottom:1px solid var(--line-2);':'')+'">' +
      '<span style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff;background:'+(unlocked?'var(--status-done)':'var(--line-2)')+';">'+(unlocked?icon("check","ic-sm"):'')+'</span>' +
      '<span style="font-size:14px;flex:1;'+(unlocked?'':'color:var(--muted);')+'">'+t.points+' очков</span>' +
      '<b style="font-size:14px;'+(unlocked?'color:var(--ink);':'color:var(--muted);')+'">скидка '+t.discount+'%</b>' +
    '</div>';
  });
  html += '</div>';
  return html;
}
function renderPointTiersCta(points){
  var current = null;
  POINT_TIERS.forEach(function(t){ if(points>=t.points) current=t; });
  var next = POINT_TIERS.filter(function(t){ return points<t.points; })[0];
  var html = '';
  if(current){
    html += '<div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      magnet("done","Доступна скидка "+current.discount+"%") +
      '<button class="btn btn-sm btn-primary" data-action="open-telegram-modal">Написать куратору, чтобы оформить скидку '+current.discount+'%</button>' +
    '</div>';
    if(next) html += '<p style="font-size:13px;color:var(--muted-2);margin:10px 0 0;">Ещё '+(next.points-points)+' очков — и скидка вырастет до '+next.discount+'%.</p>';
  } else {
    html += '<p style="font-size:13px;color:var(--muted-2);margin:0;">Наберите '+POINT_TIERS[0].points+' очков, чтобы открыть первую скидку — '+POINT_TIERS[0].discount+'%. Осталось '+(POINT_TIERS[0].points-points)+'.</p>';
  }
  return html;
}

// «Ваши протоколы» — коллекция, которая пополняется по мере прохождения уроков
// (каждый пройденный урок может открыть свои протоколы — см. lesson_protocols).
// Разбивка на «по вашей специализации» / «дополнительные» приходит уже готовой
// с бэкенда (GET /course/protocols), тут только рендер и переключение гайдов.
// Гайд к протоколу приходит одним абзацем, но внутри у него есть структура:
// «Название — описание» / «Название: описание», цепочки «A → B → C» и вводная
// фраза с двоеточием («Алгоритм по отделам ЖКТ: …»). Показываем её явно:
// пункты с названием слева, цепочки — шагами. Если структуры нет — обычный текст.
function guideSentences(text){
  // Конец предложения — точка/!/? и пробел перед заглавной; «H. pylori» не режем.
  return String(text||"").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«(])/).filter(Boolean);
}
function guideInline(t){
  return escapeHtml(t).replace(/(\d[\d.,]*(?:[–-]\d[\d.,]*)?\s?(?:мг|г|мкг|МЕ|нмоль\/л|промилле|лет|недель|месяцев|дней|%)(?:\/сутки)?)/g, '<span class="gd-num">$1</span>');
}
function guideRow(sent){
  var body = sent.replace(/\.$/, "");
  // «Порядок ведения: 1) …; 2) …; 3) …» — нумерованный список.
  if(/(^|[\s:])1\)\s/.test(body) && /\s2\)\s/.test(body)){
    var at = body.search(/(^|[\s:])1\)\s/), lead1 = body.slice(0, at).replace(/[:\s]+$/, "");
    var items = body.slice(at).split(/\s*\d+\)\s/).map(function(x){ return x.replace(/[;,.\s]+$/, "").trim(); }).filter(Boolean);
    return '<div class="gd-row">' + (lead1 ? '<div class="gd-term">'+escapeHtml(lead1)+'</div>' : '') +
      '<div class="gd-text"><ol class="gd-list">' + items.map(function(x){ return '<li>'+guideInline(x.replace(/^./, function(c){ return c.toUpperCase(); }))+'</li>'; }).join("") + '</ol></div></div>';
  }
  if((body.match(/→/g)||[]).length >= 2){
    var lead = "", chain = body, ci = body.indexOf(":");
    if(ci > 0 && ci < body.indexOf("→")){ lead = body.slice(0, ci); chain = body.slice(ci+1); }
    var tail = "";
    var steps = chain.split("→").map(function(x){ return x.trim().replace(/^./, function(c){ return c.toUpperCase(); }); }).filter(Boolean);
    var last = steps[steps.length-1], cut = last.search(/\.\s/);
    if(cut > 0){ tail = last.slice(cut+1).trim(); steps[steps.length-1] = last.slice(0, cut); }
    return '<div class="gd-row gd-chain-row">' + (lead ? '<div class="gd-term">'+escapeHtml(lead)+'</div>' : '') +
      '<div class="gd-text"><div class="gd-chain">' + steps.map(function(x, i){ return (i?'<span class="gd-arrow">→</span>':'')+'<span class="gd-step">'+guideInline(x)+'</span>'; }).join("") + '</div>' +
      (tail ? '<p>'+guideInline(tail)+'</p>' : '') + '</div></div>';
  }
  var m = body.match(/^([^—:()]{2,48}?)\s?(?:\s—\s|:\s)(.+)$/);
  if(m) return '<div class="gd-row"><div class="gd-term">'+escapeHtml(m[1].trim())+'</div><div class="gd-text"><p>'+guideInline(m[2].trim().replace(/^./, function(c){ return c.toUpperCase(); }))+'.</p></div></div>';
  return '<div class="gd-row gd-plain"><div class="gd-text"><p>'+guideInline(body)+'.</p></div></div>';
}
function renderGuide(text){
  var paras = String(text||"").split(/\n+/).map(function(x){ return x.trim(); }).filter(Boolean);
  return '<div class="gd">' + paras.map(function(par){
    var sents = guideSentences(par), head = "";
    // «Алгоритм по отделам ЖКТ: Желудок — …» — вводная становится заголовком.
    var hm = sents.length && sents[0].match(/^([^—:()]{3,48}):\s(.+)$/);
    if(hm && /^[А-ЯЁA-Z]/.test(hm[2]) && /\s—\s|:\s/.test(hm[2]) && !/→/.test(hm[2]) && !/(^|\s)1\)\s/.test(hm[2])){ head = hm[1]; sents[0] = hm[2]; }
    return (head ? '<div class="gd-head">'+escapeHtml(head)+'</div>' : '') + sents.map(guideRow).join("");
  }).join("") + '</div>';
}

function renderProtocolCard(p, isForYou, readerMode){
  var expanded = readerMode || !!protocolExpanded[p.id];
  var myIds = (me.specializationIds||[]).concat(me.interestIds||[]);
  var defaultGuide = null;
  if(isForYou){
    defaultGuide = p.guides.find(function(g){ return myIds.indexOf(g.specializationId)!==-1; });
  }
  var activeSpecId = protocolGuideTab[p.id] || (defaultGuide ? defaultGuide.specializationId : (p.guides[0] ? p.guides[0].specializationId : null));
  var activeGuide = p.guides.find(function(g){ return g.specializationId===activeSpecId; });

  var html = readerMode ? '<div>' : '<div class="card" style="padding:18px 20px;margin-bottom:12px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;cursor:pointer;" data-action="toggle-protocol" data-id="'+p.id+'">' +
      '<div><b style="font-size:15px;display:block;">'+escapeHtml(p.title)+'</b>' +
        (p.summary ? '<p style="font-size:13px;color:var(--muted);margin:4px 0 0;">'+renderPlainToProse(p.summary)+'</p>' : '') +
      '</div>' +
      '<button type="button" class="btn btn-sm btn-ghost" style="flex-shrink:0;">'+(expanded?'Свернуть':'Открыть гайд')+'</button>' +
    '</div>';

  if(expanded){
    if(!p.guides.length){
      html += '<p class="hint" style="margin-top:12px;">Гайд применения ещё не добавлен куратором.</p>';
    } else {
      // Специализация — спокойный переключатель «Гайд для: …», а не ряд крупных кнопок.
      html += '<div class="gd-for"><span>Гайд для</span>' + (p.guides.length>1
        ? '<div class="gd-seg" role="tablist">' + p.guides.map(function(g){
            var on = g.specializationId===activeSpecId, mine = myIds.indexOf(g.specializationId)!==-1;
            return '<button type="button" role="tab" aria-selected="'+on+'" class="gd-seg-btn'+(on?' on':'')+'" data-action="select-protocol-guide" data-id="'+p.id+'" data-spec="'+g.specializationId+'">'+escapeHtml(g.specializationName)+(mine?'<i class="gd-mine" title="Ваша специализация"></i>':'')+'</button>';
          }).join("") + '</div>'
        : '<b>'+escapeHtml(p.guides[0].specializationName)+'</b>') + '</div>';
      html += activeGuide && activeGuide.guideHtml ? renderGuide(activeGuide.guideHtml) : '<p class="hint">Для этой специализации текст гайда ещё не добавлен.</p>';
      if(activeGuide && activeGuide.files && activeGuide.files.length){
        html += '<div class="gd-files"><span class="gd-files-label">Материалы</span>' + activeGuide.files.map(function(f){
          return '<a class="gd-file" href="'+f.url+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+'<span>'+escapeHtml(f.originalName)+'</span></a>';
        }).join("") + '</div>';
      }
    }
  }
  html += '</div>';
  return html;
}

function renderProtocolsPage(){
  // Коллекция: шапка с прогрессом сбора (открыто X из Y, что откроет следующий
  // урок), ниже — плитки протоколов; гайд открывается в окне для чтения.
  var forYou = studentProtocols.forYou||[], additional = studentProtocols.additional||[];
  var opened = forYou.length + additional.length, total = Math.max(studentProtocols.totalInCourse||0, opened);
  var pct = total ? Math.round(opened/total*100) : 0;
  var nl = studentProtocols.nextLesson;
  var html = '<div class="page-wide"><div class="card proto-hero">' +
    '<div class="proto-hero-glow aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
    '<div class="proto-hero-main"><span class="profile-kicker">Ваша коллекция</span><h1>Протоколы</h1>' +
      '<p>После каждого пройденного урока сюда добавляются протоколы, о которых говорил спикер, — с готовым гайдом применения под вашу специализацию.</p>' +
      (nl ? '<div class="proto-next">'+icon("lock","ic-sm")+'Урок '+(nl.idx+1)+' «'+escapeHtml(nl.title)+'» откроет ещё <b>'+nl.unlocks+'</b> '+ruPluralClient(nl.unlocks,"протокол","протокола","протоколов")+'</div>' : '') +
    '</div>' +
    '<div class="proto-count"><div class="progress-ring" data-anim="ring" style="--ring-p:'+pct+'%;"><div class="progress-ring-inner"><span data-count="'+opened+'">'+opened+'</span></div></div>' +
      '<span>открыто из '+total+'</span></div>' +
  '</div>';
  var upcoming = studentProtocols.upcoming || [];
  if(!opened && !upcoming.length){
    html += '<div class="card proto-empty">'+icon("doctor","ic-lg")+'<b>Пока пусто</b><p>Пройдите первый урок — и здесь появятся первые протоколы.</p>' +
      '<button class="btn btn-primary" data-action="open-course">Перейти к курсу</button></div></div>';
    return el(html);
  }
  // Одна сетка: сначала протоколы по специализации врача (метка «Для вас»),
  // затем дополнительные, затем закрытые — что откроют два следующих урока.
  // Так плитки ложатся ровными рядами, без полупустых разделов по одной.
  function tile(p, kind, i){
    if(kind==="locked"){
      return '<div class="card proto-tile locked" data-action="open-lesson-at" data-idx="'+p.lessonIdx+'" title="Откроется после урока '+(p.lessonIdx+1)+'" style="animation-delay:'+(i*60)+'ms">' +
        '<div class="proto-tile-top"><span class="proto-ic">'+icon("lock")+'</span><span class="proto-src">урок '+(p.lessonIdx+1)+'</span></div>' +
        '<b class="proto-title">'+escapeHtml(p.title)+'</b>' +
        (p.summary ? '<p class="proto-sum">'+escapeHtml(stripHtml(renderPlainToProse(p.summary)))+'</p>' : '') +
        '<div class="proto-foot"><span>Откроется после урока «'+escapeHtml(p.lessonTitle)+'»</span><span class="proto-open">К уроку →</span></div></div>';
    }
    var files = p.guides.reduce(function(n,g){ return n + (g.files||[]).length; }, 0);
    return '<div class="card proto-tile'+(kind==="mine"?' mine':'')+'" data-action="open-protocol" data-id="'+p.id+'" data-mine="'+(kind==="mine"?1:0)+'" style="animation-delay:'+(i*60)+'ms">' +
      '<div class="proto-tile-top"><span class="proto-ic">'+icon("doctor")+'</span>'+(kind==="mine"?'<span class="proto-badge">для вас</span>':'')+(p.lessonIdx!=null?'<span class="proto-src">из урока '+(p.lessonIdx+1)+'</span>':'')+'</div>' +
      '<b class="proto-title">'+escapeHtml(p.title)+'</b>' +
      (p.summary ? '<p class="proto-sum">'+escapeHtml(stripHtml(renderPlainToProse(p.summary)))+'</p>' : '') +
      '<div class="proto-foot"><span>'+p.guides.length+' '+ruPluralClient(p.guides.length,"гайд","гайда","гайдов")+(files?' · '+files+' '+ruPluralClient(files,"файл","файла","файлов"):'')+'</span><span class="proto-open">Открыть гайд →</span></div>' +
    '</div>';
  }
  var n = 0, grid = '<div class="proto-grid">';
  forYou.forEach(function(p){ grid += tile(p, "mine", n++); });
  additional.forEach(function(p){ grid += tile(p, "extra", n++); });
  upcoming.forEach(function(p){ grid += tile(p, "locked", n++); });
  grid += '</div>';
  html += '<div class="courses-head proto-legend-row" style="margin-top:22px;"><b class="page-h" style="margin:0;">Все протоколы</b>' +
    '<span class="courses-count">'+opened+' '+ruPluralClient(opened,"открыт","открыто","открыто")+(upcoming.length?' · '+upcoming.length+' скоро':'')+'</span></div>' + grid;
  html += '</div>';
  return el(html);
}

// Окно чтения гайда протокола (по центру экрана).
function renderProtocolReaderModal(){
  var all = (studentProtocols.forYou||[]).concat(studentProtocols.additional||[]);
  var p = all.find(function(x){ return x.id===protocolReader.id; });
  if(!p) return el('<div></div>');
  var inner = renderProtocolCard(p, protocolReader.mine, true);
  return el('<div class="overlay overlay-center" data-action="overlay-close-protocol-reader"><div class="drawer modal proto-reader" data-stop="1">' +
    '<div class="drawer-head"><div class="gd-top"><span class="profile-kicker">Протокол'+(p.lessonIdx!=null?' · из урока '+(p.lessonIdx+1):'')+'</span><b class="gd-title">'+escapeHtml(p.title)+'</b>' +
      (p.summary ? '<p class="gd-sum">'+escapeHtml(stripHtml(renderPlainToProse(p.summary)))+'</p>' : '') + '</div>' +
    '<button class="btn btn-ghost btn-sm gd-close" data-action="close-protocol-reader" aria-label="Закрыть"><span>Закрыть</span> ✕</button></div><div class="drawer-body">'+inner+'</div></div></div>');
}

function renderMyProgressPage(){
  var pr = course.progress || {};
  var total = course.lessons.length;
  var doneIds = pr.completed_lessons || [];
  var done = doneIds.length;
  var quizDone = !!pr.completed;
  var pct = Math.round((done + (quizDone?1:0)) / (total+1) * 100);
  var gam = course.gamification || { points:0, currentStreak:0, longestStreak:0 };
  var POINTS_MAX = 1000;
  var points = Math.min(POINTS_MAX, gam.points||0);
  var pointsPct = Math.round((points/POINTS_MAX)*100);
  var maxedOut = points >= POINTS_MAX;
  var anyDiscountUnlocked = points >= POINT_TIERS[0].points;

  var certsOn = course.course && course.course.certificatesEnabled;
  var nextIdx = -1;
  course.lessons.forEach(function(l,i){ if(nextIdx<0 && doneIds.indexOf(l.id)===-1 && !l.hiddenForMe && !l.dripLockedForMe) nextIdx = i; });

  // Левая колонка: общий прогресс + серия, очки с «лестницей» скидок.
  var left = '<div class="pp-col">' +
    '<div class="card pp-summary">' +
      '<div class="progress-ring" data-anim="ring" style="--ring-p:'+pct+'%;"><div class="progress-ring-inner"><span data-count="'+pct+'" data-suffix="%">'+pct+'%</span></div></div>' +
      '<div style="flex:1;min-width:0;"><b style="font-size:15px;display:block;">Прогресс по курсу</b>' +
      '<span style="font-size:13px;color:var(--muted);">'+done+' из '+total+' уроков'+(quizDone?' · тест сдан':'')+'</span></div>' +
      '<div class="pp-streak">'+icon("flame","ic-sm streak-flame")+'<b data-count="'+(gam.currentStreak||0)+'">'+(gam.currentStreak||0)+'</b>' +
        '<span>'+(gam.currentStreak===1?"день подряд":"дней подряд")+'<br>рекорд: '+(gam.longestStreak||0)+'</span></div>' +
    '</div>' +
    '<div class="card pp-points'+(maxedOut?' maxed':'')+'">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;">' +
        magnet(anyDiscountUnlocked?"done":"neutral","Очки") +
        '<div class="pp-points-num"><b data-count="'+points+'">'+points+'</b> / '+POINTS_MAX+'</div>' +
      '</div>' +
      renderPointsLadder(points, POINTS_MAX) +
      '<p class="pp-points-how">Очки начисляются за активность: <b>+20</b> за каждый пройденный урок, столько же процентов, сколько результат теста — за итоговый тест, <b>+100</b> — за сертификат, <b>+5</b> за каждый день серии подряд.</p>' +
      renderPointTiersCta(points) +
    '</div>' +
    '%%FINAL%%' +
  '</div>';

  // Правая колонка: уроки (со статусом и длительностью) + итоговый тест/сертификат.
  var right = '<div class="pp-col"><div class="card pp-lessons"><b class="pp-h">Уроки</b>';
  course.lessons.forEach(function(l,i){
    var isDone = doneIds.indexOf(l.id)!==-1, isLocked = !isDone && (l.hiddenForMe || l.dripLockedForMe), isNext = i===nextIdx;
    var meta = l.hiddenForMe ? 'временно недоступен' : (l.dripLockedForMe ? 'откроется '+fmtDate(l.availableAt) : escapeHtml(l.duration||""));
    right += '<div class="pp-lesson'+(isDone?' done':'')+(isNext?' next':'')+(isLocked?' locked':'')+'"'+(isLocked?'':' data-action="open-lesson-at" data-idx="'+i+'"')+'>' +
      '<span class="pp-dot">'+(isDone?icon("check","ic-sm"):(isLocked?icon("lock","ic-sm"):''))+'</span>' +
      '<span class="pp-title">'+(i+1)+'. '+escapeHtml(l.title)+'</span>' +
      (isNext ? '<button class="btn btn-sm btn-primary" data-action="open-lesson-at" data-idx="'+i+'">'+(done?'Продолжить':'Начать')+'</button>' : '<span class="pp-meta">'+meta+'</span>') +
    '</div>';
  });
  right += '</div>';

  right += '</div>';
  var left_lessons = total - done, fin = '<div class="card pp-final">';
  if(!quizDone){
    fin += magnet(left_lessons? "neutral" : "attention", "Итоговый тест") +
      (left_lessons
        ? '<p>Откроется после всех уроков — осталось <b>'+left_lessons+'</b> '+(left_lessons===1?'урок':(left_lessons<5?'урока':'уроков'))+'.</p>' +
          '<div class="pp-final-bar"><i style="width:'+Math.round(done/Math.max(1,total)*100)+'%"></i></div>'
        : '<p>Все уроки пройдены — можно сдавать.'+(course.quiz?' '+course.quiz.length+' вопросов.':'')+'</p>' +
          '<button class="btn btn-primary" data-action="open-final-quiz">Пройти тест</button>') +
      '<p class="pp-final-after">'+(certsOn ? 'После теста куратор проверит результат и выдаст сертификат.' : 'После теста — скидка 10% на полное обучение.')+'</p>';
  } else {
    var issued = pr.certificate_status==="issued";
    fin += magnet(certsOn ? (issued?"done":"attention") : "done", certsOn ? (issued?"Сертификат выдан":"Сертификат на проверке") : "Демо-курс пройден") +
      '<div class="pp-final-score"><b data-count="'+pr.quiz_score+'" data-suffix="%">'+pr.quiz_score+'%</b><span>результат итогового теста</span></div>' +
      (certsOn && issued ? '<a class="btn btn-sm btn-primary" href="api/course/certificate/download?courseId='+encodeURIComponent(activeCourseId)+'" target="_blank" rel="noopener">'+icon("download")+' Скачать сертификат</a>' : '');
  }
  fin += '</div>';
  left = left.replace('%%FINAL%%', function(){ return fin; });

  return el('<div class="page-wide pp-grid">'+left+right+'</div>');
}

// «Лестница» скидок: полоса очков с отметками ступеней и подписями под ними.
function renderPointsLadder(points, max){
  var pctNow = Math.min(100, Math.round(points/max*100));
  var h = '<div class="ladder"><div class="ladder-track"><div class="ladder-fill" style="width:'+pctNow+'%"></div>';
  POINT_TIERS.forEach(function(t){
    var on = points >= t.points, x = t.points/max*100;
    h += '<span class="ladder-tick'+(on?' on':'')+'" style="left:'+x+'%"></span>';
  });
  h += '<span class="ladder-you" style="left:'+pctNow+'%"></span></div><div class="ladder-labels">';
  POINT_TIERS.forEach(function(t){
    var on = points >= t.points, x = t.points/max*100;
    h += '<span class="'+(on?'on':'')+(x>=100?' end':'')+'" style="left:'+x+'%"><b>−'+t.discount+'%</b>'+t.points+'</span>';
  });
  return h + '</div></div>';
}

// Уведомления врача: лента на всю ширину, по дням, со значком типа; новые —
// с точкой, прочитанные приглушены (но читаемы). Клик ведёт туда, к чему
// уведомление относится. Справа — «Сейчас важно»: что ждёт действия врача.
var NOTIF_KINDS = {
  assignment_returned: ["repeat","blocked"], assignment_accepted: ["check","done"], assignment_submitted: ["task","primary"],
  new_lesson: ["book","primary"], content_unlocked: ["book","primary"], course_opened: ["book","done"], access_unblocked: ["lock","done"],
  course_closed: ["lock","blocked"], certificate_issued: ["badge","done"], survey_new: ["poll","teal"], live: ["calendar","live"], reminder: ["clock","live"]
};
function notifTarget(n){
  var t = n.synthetic ? "live" : n.type;
  if(t==="assignment_returned" || t==="assignment_accepted") return "Открыть задание";
  if(t==="new_lesson" || t==="content_unlocked" || t==="course_opened" || t==="access_unblocked") return "К урокам";
  if(t==="survey_new") return "Заполнить анкету";
  if(t==="certificate_issued") return "К сертификату";
  if(t==="reminder") return "К итоговому тесту";
  if(t==="live") return "К расписанию";
  return "";
}
function renderNotificationsPage(){
  var reminders = upcomingEventReminders().map(function(r){ return Object.assign({ type:"live" }, r); });
  var all = reminders.concat(notifState.items);
  var onlyNew = studentState.notifFilter==="unread";
  var items = onlyNew ? all.filter(function(n){ return n.synthetic || !n.read_at; }) : all;
  var unread = all.filter(function(n){ return n.synthetic || !n.read_at; }).length;

  var html = '<div class="page-wide pp-grid nt-grid"><div class="pp-col"><div class="card co-card nt-card">' +
    '<div class="co-head nt-head"><b>Уведомления</b>' +
      '<div class="nt-tools"><div class="seg nt-seg"><button type="button" class="seg-btn'+(onlyNew?'':' on')+'" data-action="notif-filter" data-f="all">Все</button>' +
        '<button type="button" class="seg-btn'+(onlyNew?' on':'')+'" data-action="notif-filter" data-f="unread">Новые'+(unread?' · '+unread:'')+'</button></div>' +
      (notifState.unreadCount>0 ? '<button class="btn btn-sm btn-ghost" data-action="mark-all-notifs-read">Прочитать все</button>' : '') + '</div></div>';
  if(!items.length){
    html += '<div class="empty-state nt-empty"><div class="big">'+icon("bell","ic-lg")+'</div>'+(onlyNew ? 'Новых уведомлений нет — всё прочитано.' : 'Уведомлений пока нет. Здесь появятся новые уроки, ответы куратора на задания и напоминания об эфирах.')+'</div>';
  } else {
    var lastDay = "";
    items.forEach(function(n){
      var d = new Date(n.created_at || Date.now());
      var day = n.synthetic ? "Скоро" : (isSameCalendarDay(d, new Date()) ? "Сегодня" : d.toLocaleDateString("ru-RU",{ weekday:"long", day:"numeric", month:"long" }));
      if(day!==lastDay){ html += '<div class="feed-day">'+day+'</div>'; lastDay = day; }
      var k = NOTIF_KINDS[n.synthetic ? "live" : n.type] || ["bell","neutral"], isNew = n.synthetic || !n.read_at, go = notifTarget(n);
      html += '<div class="nt-row'+(isNew?' new':'')+(go?' link':'')+'" data-action="notif-open" data-id="'+escapeHtml(n.id)+'">' +
        '<span class="nt-ic '+k[1]+'">'+icon(k[0],"ic-sm")+'</span>' +
        '<div class="nt-main"><b>'+escapeHtml(n.title)+'</b>'+(n.body?'<span>'+escapeHtml(n.body)+'</span>':'')+'</div>' +
        '<div class="nt-side">'+(n.synthetic?'<span class="nt-time">скоро</span>':'<span class="nt-time">'+fmtTime(n.created_at)+'</span>')+
          (go?'<em>'+go+' →</em>':'')+'</div>' +
        (isNew && !n.synthetic ? '<i class="nt-dot" aria-label="новое"></i>' : '') +
      '</div>';
    });
  }
  html += '</div></div>';

  // Справа — что ждёт действия врача прямо сейчас.
  var returned = course ? course.lessons.map(function(l,i){ return { l:l, i:i, a:(course.assignments||{})[l.id] }; }).filter(function(x){ return x.a && x.a.status==="returned"; }) : [];
  var survey = (studentTools.surveys||[]).find(function(x){ return !x.my_answers; });
  var nowD = new Date(), mySid = me.stream_id || "";
  var nextEv = (calendarState.events||[]).filter(function(ev){ return (!ev.stream_id || ev.stream_id===mySid) && new Date(ev.event_date+"T"+(ev.event_time||"00:00")) >= nowD; })
    .sort(function(a,b){ return (a.event_date+a.event_time).localeCompare(b.event_date+b.event_time); })[0];
  html += '<div class="pp-col"><div class="card co-card nt-now"><b class="co-card-title">Сейчас важно</b>';
  var any = false;
  returned.forEach(function(x){ any = true;
    html += '<div class="att-row" data-action="open-lesson-task" data-idx="'+x.i+'"><span class="nt-ic blocked">'+icon("repeat","ic-sm")+'</span><span>Задание к уроку '+(x.i+1)+' вернули на доработку</span><em>→</em></div>'; });
  if(survey){ any = true; html += '<div class="att-row" data-action="sf-open" data-id="'+survey.id+'"><span class="nt-ic teal">'+icon("poll","ic-sm")+'</span><span>Анкета «'+escapeHtml(survey.title)+'» ждёт ответа</span><em>→</em></div>'; }
  if(nextEv){ any = true;
    var ed = new Date(nextEv.event_date+"T00:00:00");
    html += '<div class="att-row" data-action="student-tab" data-tab="schedule"><span class="nt-ic live">'+icon("calendar","ic-sm")+'</span><span>Эфир «'+escapeHtml(nextEv.title)+'» — '+ed.toLocaleDateString("ru-RU",{ day:"numeric", month:"long" })+', '+escapeHtml(nextEv.event_time||"")+'</span><em>→</em></div>'; }
  if(!any) html += '<p class="set-muted">Ничего не ждёт вашего действия. Продолжайте курс в своём темпе.</p>';
  html += '</div>' +
    '<div class="card co-card nt-about"><b class="co-card-title">О чём мы сообщаем</b>' +
      '<div class="nt-legend">' +
        ['book|primary|Новые уроки и открытые материалы','task|primary|Ответы куратора на ваши задания','calendar|live|Эфир начнётся через 30 минут','poll|teal|Новые анкеты','badge|done|Выдан сертификат'].map(function(r){ var p = r.split("|"); return '<div><span class="nt-ic '+p[1]+'">'+icon(p[0],"ic-sm")+'</span>'+p[2]+'</div>'; }).join('') +
      '</div></div>';
  html += '</div></div>';
  return el(html);
}

// Список отражает реальные правила доступа на бэкенде (requireRole в src/routes/*),
// а не придуман отдельно — честная витрина того, что уже проверяется на сервере.
function roleCapabilities(role){
  if(role==="student"){
    return [
      { label:"Просматривать уроки, материалы и расписание эфиров", allowed:true },
      { label:"Проходить итоговый тест и получать сертификат", allowed:true },
      { label:"Общаться с куратором и потоком в Telegram-группе", allowed:true },
      { label:"Сохранять уроки в «Мои материалы» и оставлять личные заметки", allowed:true },
      { label:"Отвечать на задания к урокам и заполнять анкеты", allowed:true },
      { label:"Просматривать прогресс и данные других врачей", allowed:false },
      { label:"Редактировать уроки, тест или график их открытия", allowed:false },
      { label:"Управлять доступом, сертификатами или ролями сотрудников", allowed:false }
    ];
  }
  if(role==="curator"){
    return [
      { label:"Просматривать назначенных врачей и врачей без куратора", allowed:true },
      { label:"Продлевать/блокировать доступ, выдавать сертификаты", allowed:true },
      { label:"Назначать график открытия уроков (индивидуально и массово)", allowed:true },
      { label:"Приглашать новых врачей, управлять потоками и эфирами", allowed:true },
      { label:"Проверять задания врачей, вести заказы и отмечать оплаты", allowed:true },
      { label:"Создавать продукты, анкеты и задания к урокам", allowed:false },
      { label:"Редактировать содержимое уроков, тест и их порядок", allowed:false },
      { label:"Назначать роли сотрудникам, просматривать журнал действий", allowed:false }
    ];
  }
  if(role==="admin"){
    return [
      { label:"Всё, что доступно куратору обучения", allowed:true },
      { label:"Редактировать уроки, тест, черновики и историю правок", allowed:true },
      { label:"Создавать продукты, анкеты и задания к урокам", allowed:true },
      { label:"Назначать и снимать роль куратора у сотрудников", allowed:true },
      { label:"Просматривать полный журнал действий платформы", allowed:true },
      { label:"Откатывать действия из журнала", allowed:false },
      { label:"Назначать роль администратора", allowed:false }
    ];
  }
  return [
    { label:"Всё, что доступно администратору", allowed:true },
    { label:"Откатывать любые обратимые действия из журнала", allowed:true },
    { label:"Назначать роли администратора и куратора", allowed:true },
    { label:"Полный доступ ко всем разделам платформы", allowed:true }
  ];
}

function renderMyProfilePage(){
  // Шапка-обложка с фото (можно загрузить/убрать), именем, ролью и ключевыми
  // цифрами; ниже — редактирование данных и «что доступно роли». Пароль и
  // сеансы — в «Настройках».
  var isStudent = me.role==="student";
  var caps = roleCapabilities(me.role);
  var stats = [];
  if(isStudent && course){
    var pr = course.progress || {}, gam = course.gamification || {};
    stats.push([(pr.completed_lessons||[]).length+' / '+course.lessons.length, "уроков пройдено"]);
    stats.push([gam.currentStreak||0, "дней подряд"]);
    stats.push([gam.points||0, "очков"]);
  } else if(!isStudent){
    var mine = (staffState.students||[]).filter(function(st){ return me.role!=="curator" || st.assigned_curator_id===me.id; });
    stats.push([mine.length, me.role==="curator" ? "моих врачей" : "врачей на курсе"]);
    stats.push([mine.filter(function(st){ return st.completed; }).length, "завершили демо"]);
    stats.push([(staffState.staff||[]).length, "в команде"]);
  }
  var specNamesList = isStudent ? (me.specializationIds||[]).map(function(id){ var sp=(specializationsList||[]).find(function(x){ return x.id===id; }); return sp?sp.name:null; }).filter(Boolean) : [];
  var myStream = isStudent && me.stream_id ? (calendarState.streams||[]).find(function(x){ return x.id===me.stream_id; }) : null;

  var html = '<div class="page-wide"><div class="card profile-hero">' +
    '<div class="profile-cover aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
    '<div class="profile-main">' +
      '<div class="profile-photo">'+userAvatar(me, "profile-av")+
        '<button type="button" class="profile-photo-btn" data-action="pick-avatar" title="Загрузить фото">'+icon("camera","ic-sm")+'</button>' +
        '<input type="file" id="avatarFileInput" accept="image/png,image/jpeg,image/webp" hidden></div>' +
      '<div class="profile-id"><span class="profile-kicker">Мой профиль</span><h1>'+escapeHtml(me.name||"")+'</h1>' +
        '<div class="profile-tags"><span class="team-role">'+escapeHtml(roleLabel(me.role))+'</span>' +
          specNamesList.map(function(n){ return '<span class="profile-chip">'+escapeHtml(n)+'</span>'; }).join("") +
          (myStream?'<span class="profile-chip">'+escapeHtml(myStream.name)+'</span>':'') + '</div>' +
        '<div class="profile-contacts"><span>'+escapeHtml(me.email||"")+'</span>'+(me.phone?'<span>'+escapeHtml(me.phone)+'</span>':'')+(me.created_at?'<span>на платформе с '+fmtDateShort(me.created_at)+'</span>':'')+'</div>' +
        '<div class="profile-photo-actions"><button class="btn btn-sm btn-ghost" data-action="pick-avatar">'+(me.avatar_url?'Сменить фото':'Загрузить фото')+'</button>' +
          (me.avatar_url?'<button class="btn btn-sm btn-ghost" data-action="remove-avatar">Убрать</button>':'') + '</div>' +
      '</div>' +
      (stats.length ? '<div class="profile-stats">'+stats.map(function(x){ return '<div><b>'+x[0]+'</b><span>'+x[1]+'</span></div>'; }).join("")+'</div>' : '') +
    '</div></div>';

  html += '<div class="team-row" style="margin-top:18px;">';
  html += '<div class="team-cell"><div class="card co-card"><b class="co-card-title">Личные данные</b>' +
    '<form id="profileEditorForm">' +
      '<div class="field"><label>Имя и фамилия</label><input class="input" id="profileEditorName" required value="'+escapeHtml(profileEditor.name)+'"></div>' +
      (isStudent ? renderProfileSpecializationFields() : '') +
      '<div class="profile-2f"><div class="field"><label>Телефон</label><input class="input" type="tel" id="profileEditorPhone" value="'+escapeHtml(profileEditor.phone)+'"></div>' +
      (isStudent ? '<div class="field"><label>Место работы</label><input class="input" id="profileEditorWorkplace" value="'+escapeHtml(profileEditor.workplace)+'"></div>' : '<div class="field"><label>Email</label><div class="input input-ro">'+escapeHtml(me.email||"")+'</div></div>') + '</div>' +
      (isStudent ? '<div class="field"><label>Email</label><div class="input input-ro">'+escapeHtml(me.email||"")+'</div></div>' : '') +
      '<p class="hint" style="margin-top:-4px;">Email нельзя изменить самостоятельно — обратитесь к куратору.</p>' +
      '<div class="err-text" id="profileEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary" type="submit">Сохранить изменения</button>' +
    '</form>' +
    (isStudent ? renderMyProductBlock() : '') +
  '</div></div>';
  html += '<div class="team-cell"><div class="card co-card"><b class="co-card-title" style="margin-bottom:4px;">Ваши доступы</b>' +
    '<p class="hint" style="margin:0 0 10px;">Что доступно при роли «'+escapeHtml(roleLabel(me.role))+'».</p>';
  caps.forEach(function(c){
    html += '<div class="cap-row'+(c.allowed?'':' off')+'"><span class="cap-dot">'+(c.allowed?icon("check","ic-sm"):'')+'</span><span>'+escapeHtml(c.label)+'</span></div>';
  });
  if(isStudent) html += renderMyOrdersBlock();
  html += '<button class="btn btn-sm btn-ghost btn-block" style="margin-top:14px;" data-action="sidebar-nav" data-key="settings">Пароль, сеансы и тема — в «Настройках» →</button>';
  html += '</div></div></div></div>';
  return el(html);
}

// Фото профиля: центрируем и ужимаем до 256×256 в браузере, шлём data URL.
async function uploadAvatarFile(file){
  if(!file) return;
  if(!/^image\//.test(file.type)){ showToast("Выберите картинку"); return; }
  try{
    var bmp = await createImageBitmap(file);
    var side = Math.min(bmp.width, bmp.height), size = 256;
    var cv = document.createElement("canvas"); cv.width = cv.height = size;
    cv.getContext("2d").drawImage(bmp, (bmp.width-side)/2, (bmp.height-side)/2, side, side, 0, 0, size, size);
    var url = cv.toDataURL("image/webp", 0.85);
    if(url.indexOf("data:image/webp")!==0) url = cv.toDataURL("image/jpeg", 0.85);   // Safari без WebP-кодера
    if(url.length > 95000) url = cv.toDataURL("image/jpeg", 0.7);
    var r = await api("/auth/me/avatar", { method:"PUT", body: JSON.stringify({ image: url }) });
    me.avatar_url = r.avatar_url;
    showToast("Фото обновлено");
  }catch(err){ showToast(err.message || "Не удалось загрузить фото"); }
  render();
}

// Анимация главной (Настройки → Внешний вид), два варианта:
//   live — «Каскад и живой свет»: при заходе на главную плитки собираются каскадом
//          (классы fx-cascade), а за стеклянными плитками мягкий свет следует за
//          курсором и плитка под курсором слегка наклоняется (fx-light);
//   off  — без анимаций (и всегда, если в системе включено «уменьшить движение»).
// Сохранённые прежние значения (cascade, light, thread) переводятся в live.
var HOME_FX = [["live","Каскад и живой свет","Плитки собираются по очереди при входе, свет за стеклом следует за курсором"],
  ["off","Без анимации","Только сами данные"]];
// Бывшие отдельные варианты («Каскад», «Живой свет») и снятая «Нить прогресса» → объединённый.
var HOME_FX_OLD = { cascade:"live", light:"live", thread:"live" };
var HOME_FX_STAFF_TEXT = {};
// Фон главной — отдельная настройка, сочетается с любой анимацией: огоньки-искры
// в цветах платформы или без фона.
var HOME_BG = [["none","Без фона","Только стекло и цвета темы"],["ember-mix","Искры","Огоньки всех цветов платформы"]];
var HOME_BG_OLD = { "ember-warm":"ember-mix", "ember-cool":"ember-mix" };
var HOME_BG_COLORS = { "ember-warm":[["--rose",.55],["--accent",1]], "ember-cool":[["--primary",.6],["--teal",1]], "ember-mix":[["--rose",.3],["--accent",.5],["--primary",.78],["--teal",1]] };
function homeBg(){
  var v = null; try{ v = localStorage.getItem("lms-home-bg"); }catch(e){}
  // Раньше «Искры» были одной из анимаций — переносим выбор в фон.
  try{ if(!v && localStorage.getItem("lms-home-fx")==="ember"){ v = "ember-mix"; localStorage.setItem("lms-home-bg", v); localStorage.setItem("lms-home-fx", "live"); } }catch(e){}
  if(HOME_BG_OLD[v]) v = HOME_BG_OLD[v];
  var q = /[?&]bg=(none|ember-warm|ember-cool|ember-mix)\b/.exec(location.search); if(q) v = q[1];
  return HOME_BG.some(function(x){ return x[0]===v; }) ? v : "none";
}
function homeBgLayer(){ return homeBg()!=="none" ? '<canvas class="fx-ember-cv" aria-hidden="true"></canvas>' : ''; }
function homeBgClass(){ return homeBg()!=="none" ? ' bg-ember' : ''; }
function homeFx(){
  var v = null; try{ v = localStorage.getItem("lms-home-fx"); }catch(e){}
  var q = /[?&]fx=(live|cascade|light|thread|off)\b/.exec(location.search); if(q) v = q[1];
  if(HOME_FX_OLD[v]) v = HOME_FX_OLD[v];
  return HOME_FX.some(function(x){ return x[0]===v; }) ? v : "live";
}
// Классы анимации на сетке главной: объединённый вариант = каскад + живой свет.
function homeFxClass(){ return homeFx()==="live" ? "fx-cascade fx-light" : "fx-off"; }
function renderSettingsPage(){
  // Слева — внешний вид (превью тем) и безопасность (пароль, сеансы с устройствами),
  // справа — карточка аккаунта. Сеансы подгружаются лениво при первом открытии.
  if(!mySessionsLoaded && !mySessionsLoading){ mySessionsLoading = true; loadMySessions().then(function(){ mySessionsLoading = false; render(); }); }
  function themeCard(key, label, ic){
    var on = getTheme()===key;
    return '<button type="button" class="theme-card'+(on?' on':'')+'" data-action="set-theme" data-theme="'+key+'">' +
      '<span class="theme-prev '+key+'"><i></i><i></i><i></i></span>' +
      '<span class="theme-label">'+icon(ic,"ic-sm")+label+(on?'<em>выбрана</em>':'')+'</span></button>';
  }
  var left = '<div class="pp-col">' +
    '<div class="card co-card"><b class="co-card-title">Внешний вид</b>' +
      '<b class="fx-title" style="margin-top:0;">Тема</b><div class="theme-cards">'+themeCard("dark","Тёмная","moon")+themeCard("light","Светлая","sun")+themeCard("depth","Глубина","sparkle")+themeCard("stars","Созвездие","star")+themeCard("cells","Клетки","eye")+'</div>' +
      '<b class="fx-title">Анимация главной</b><div class="fx-cards">' + HOME_FX.map(function(x){
        var on = homeFx()===x[0], text = me.role!=="student" && HOME_FX_STAFF_TEXT[x[0]] ? HOME_FX_STAFF_TEXT[x[0]] : x[2];
        return '<button type="button" class="fx-card'+(on?' on':'')+'" data-action="set-home-fx" data-fx="'+x[0]+'"><span class="fx-prev '+(x[0]==="live"?"fxp-cascade fxp-light":"fxp-"+x[0])+'"><i></i><i></i><i></i></span><b>'+x[1]+(on?' <em>выбрана</em>':'')+'</b><span>'+text+'</span></button>';
      }).join("") + '</div>' +
      '<b class="fx-title">Фон главной</b><div class="fx-cards">' + HOME_BG.map(function(x){
        var on = homeBg()===x[0];
        return '<button type="button" class="fx-card'+(on?' on':'')+'" data-action="set-home-bg" data-bg="'+x[0]+'"><span class="fx-prev fxp-bg fxp-'+x[0]+'"><i></i><i></i><i></i></span><b>'+x[1]+(on?' <em>выбран</em>':'')+'</b><span>'+x[2]+'</span></button>';
      }).join("") + '</div></div>' +
    '<div class="card co-card"><b class="co-card-title">Безопасность</b>' +
      '<div class="set-row"><div><b>Пароль</b><span>Меняйте пароль, если входили с чужого устройства.</span></div><button class="btn btn-sm btn-ghost" data-action="open-change-password">Сменить пароль</button></div>' +
      '<div class="set-row" style="border-bottom:none;"><div><b>Активные сеансы</b><span>С каких устройств входили в аккаунт.</span></div><button class="btn btn-sm btn-ghost" data-action="logout-everywhere">Выйти со всех устройств</button></div>' +
      '<div class="set-sessions">';
  if(!mySessionsLoaded) left += '<p class="set-muted">Загрузка…</p>';
  else if(!mySessionsList.length) left += '<p class="set-muted">Сеансов пока нет.</p>';
  else mySessionsList.slice(0,6).forEach(function(se, i){
    left += '<div class="set-session"><span class="set-dev">'+icon("user","ic-sm")+'</span><div><b>'+escapeHtml(se.device||"Устройство")+(i===0?' <em>это устройство</em>':'')+'</b>' +
      '<span>'+escapeHtml(se.ip||"—")+' · '+fmtDateShort(se.createdAt)+', '+fmtTime(se.createdAt)+'</span></div></div>';
  });
  left += '</div></div></div>';
  var right = '<div class="pp-col"><div class="card co-card set-account">' +
    userAvatar(me,'set-av') +
    '<b class="set-name">'+escapeHtml(me.name||"")+'</b><span class="set-mail">'+escapeHtml(me.email||"")+'</span>' +
    '<span class="team-role" style="margin-top:6px;">'+escapeHtml(roleLabel(me.role))+'</span>' +
    '<div class="set-facts">' +
      (me.phone?'<div><span>Телефон</span><b>'+escapeHtml(me.phone)+'</b></div>':'') +
      (me.workplace?'<div><span>Место работы</span><b>'+escapeHtml(me.workplace)+'</b></div>':'') +
      (me.created_at?'<div><span>На платформе с</span><b>'+fmtDateShort(me.created_at)+'</b></div>':'') +
    '</div>' +
    '<button class="btn btn-sm btn-ghost btn-block" style="margin-top:auto;" data-action="sidebar-nav" data-key="profile">Открыть профиль →</button>' +
  '</div></div>';
  return el('<div class="page-wide pp-grid">'+left+right+'</div>');
}

/* ============================= РЕНДЕР: ПЕРСОНАЛ ============================= */
var STAFF_PAGE_TITLES = { home:"Главная", students:"Врачи", dashboard:"Аналитика", calendar:"Расписание", courses:"Курсы",
  materials:"Уроки", glossary:"Термины", protocols:"Протоколы", assignments:"Проверка заданий", feed:"Лента ответов", surveys:"Анкеты и опросы",
  orders:"Заказы и оплаты", products:"Продукты", team:"Команда", audit:"Журнал действий", specializations:"Специализации",
  telegram:"Telegram", notifications:"Уведомления", settings:"Настройки", profile:"Мой профиль" };
// Разделы, где данные зависят от выбранного курса (запросы с courseId); в остальных
// (заказы, продукты, анкеты, команда, журнал, Telegram, профиль, настройки, сами
// курсы — у них выбор плиткой) переключатель курса только занимал место.
var STAFF_COURSE_SCOPED = ["home","students","dashboard","calendar","materials","glossary","protocols","assignments","feed","notifications"];
function renderStaffShell(){
  var wrap = el('<div></div>');
  var mobNavBackdrop = renderMobileNavBackdrop();
  if(mobNavBackdrop) wrap.appendChild(mobNavBackdrop);
  wrap.appendChild(renderSidebar());
  var main = el('<div class="app-main"></div>');
  wrap.appendChild(main);
  var shell = el('<div class="shell"><div class="wrap" id="staffContent"></div></div>');
  main.appendChild(shell);
  var content = shell.querySelector("#staffContent");
  // «Модули» теперь часть раздела «Уроки» (старые ссылки и записи истории ведут туда).
  if(staffState.mainTab === "modules"){ staffState.mainTab = "materials"; staffState.navKey = "materials"; }
  // У страницы урока и протокола своя шапка с «хлебными крошками» — общий
  // заголовок и переключатель курса там лишние.
  var ownPage = (staffState.mainTab==="materials" && staffState.lessonPageId) || (staffState.mainTab==="protocols" && protocolEditor.open) || (staffState.mainTab==="glossary" && glossaryAdmin.edit);
  if(!ownPage){
    // Заголовок — название раздела (раньше на каждом экране было «Главный
    // администратор»: роль не подсказывает, где ты и что здесь делать).
    content.appendChild(el('<h1 class="section-title">'+escapeHtml(STAFF_PAGE_TITLES[staffState.mainTab] || roleLabel(me.role))+'</h1>'));
    // Переключатель курса — только там, где данные зависят от выбранного курса.
    if(STAFF_COURSE_SCOPED.indexOf(staffState.mainTab)!==-1) content.appendChild(renderStaffCourseSwitcher());
  }

  if(staffState.mainTab === "courses" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderCoursesTab());
  } else if(staffState.mainTab === "team" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderTeamTab());
  } else if(staffState.mainTab === "calendar"){
    content.appendChild(renderCalendarTab());
  } else if(staffState.mainTab === "materials"){
    content.appendChild(renderLessonsTab());
  } else if(staffState.mainTab === "dashboard"){
    content.appendChild(renderDashboardTab());
  } else if(staffState.mainTab === "protocols"){
    content.appendChild(renderProtocolsAdminTab());
  } else if(staffState.mainTab === "glossary"){
    content.appendChild(renderGlossaryAdminTab());
  } else if(staffState.mainTab === "specializations" && isAdminRole()){
    content.appendChild(el('<div class="page-wide">'+renderSpecializationsCard()+'</div>'));
  } else if(staffState.mainTab === "audit" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderAuditLogTab());
  } else if(staffState.mainTab === "notifications"){
    content.appendChild(renderStaffNotificationsPage());
  } else if(staffState.mainTab === "settings"){
    content.appendChild(renderSettingsPage());
  } else if(staffState.mainTab === "profile"){
    content.appendChild(renderMyProfilePage());
  } else if(staffState.mainTab === "assignments"){
    content.appendChild(renderAssignmentsTab());
  } else if(staffState.mainTab === "feed"){
    content.appendChild(renderFeedTab());
  } else if(staffState.mainTab === "orders"){
    content.appendChild(renderOrdersTab());
  } else if(staffState.mainTab === "telegram"){
    content.appendChild(renderTelegramPage());
  } else if(staffState.mainTab === "products" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderProductsTab());
  } else if(staffState.mainTab === "surveys"){
    content.appendChild(renderSurveysTab());
  } else if(staffState.mainTab === "students"){
    addSideFlow(main);
    content.appendChild(renderInboxCard());
    content.appendChild(renderStaffStats());
    content.appendChild(renderCertificateQueue());
    content.appendChild(el(renderStreamsPanel()));
    content.appendChild(renderRoster());
  } else {
    addSideFlow(main);
    // Главная сотрудника — в обёртке с выбранным вариантом анимации (как у врача).
    var staffHomeBox = el('<div class="staff-home '+homeFxClass()+homeBgClass()+'">'+homeBgLayer()+'</div>');
    content.appendChild(staffHomeBox);
    renderStaffHome(staffHomeBox);
  }

  if(staffState.selectedStudentId){
    content.innerHTML = "";
    if(!staffState.selectedStudent) content.appendChild(el('<div class="page-wide"><div class="card empty-state" style="padding:40px;">Загрузка профиля…</div></div>'));
    else content.appendChild(renderStudentDrawer());
  }
  if(calendarState.eventModalMode){
    wrap.appendChild(renderEventModal());
  }
  if(materialsPicker.open && !lpOwns("access")){
    wrap.appendChild(renderMaterialsPickerModal());
  }
  if(scheduleModal.open && !lpOwns("schedule")){
    wrap.appendChild(renderScheduleModal());
  }
  return wrap;
}

// У персонала пока нет отдельной системы уведомлений (в отличие от врача) — честно
// показываем то немногое, что уже можно посчитать на лету (напоминания об эфирах),
// и пустое состояние вместо выдуманной ленты.
function renderStaffNotificationsPage(){
  // Лента событий за 14 дней, собранная из уже загруженных данных: регистрации,
  // заявки на полную программу, завершение демо-курса, выданные сертификаты,
  // напоминания об эфирах. Справа — что требует внимания и ближайшие эфиры.
  var students = staffState.students || [];
  var since = Date.now() - 14*86400000;
  var feed = upcomingEventReminders().map(function(r){ return { t:Date.now(), kind:"live", icon:"calendar", text:escapeHtml(r.title) }; });
  // Уведомления, адресованные самому сотруднику (например, новый ответ его врача на задание).
  (notifState.items||[]).forEach(function(n){
    if(new Date(n.created_at).getTime()<since) return;
    feed.push({ t:new Date(n.created_at).getTime(), kind:"task", icon:"task", text:'<b>'+escapeHtml(n.title)+'</b>'+(n.body?' · '+escapeHtml(n.body):''), nav:/^assignment_/.test(n.type)?"assignments":null });
  });
  students.forEach(function(st){
    var nm = '<b>'+escapeHtml(st.name)+'</b>';
    if(st.created_at && new Date(st.created_at).getTime()>=since) feed.push({ t:new Date(st.created_at).getTime(), kind:"reg", icon:"user", text:nm+' зарегистрировался(-ась)'+(specNames(st)?' · '+escapeHtml(specNames(st)):''), id:st.id });
    if(st.certificate_issued_at && new Date(st.certificate_issued_at).getTime()>=since) feed.push({ t:new Date(st.certificate_issued_at).getTime(), kind:"crt", icon:"badge", text:nm+' получил(-а) сертификат', id:st.id });
  });
  feed.sort(function(a,b){ return b.t-a.t; });
  var html = '<div class="page-wide pp-grid"><div class="pp-col"><div class="card co-card"><div class="co-head"><b>Лента событий</b><span class="courses-count">за 14 дней</span></div>';
  if(!feed.length){
    html += '<div class="empty-state" style="padding:40px 10px;">За две недели событий не было.</div>';
  } else {
    var lastDay = "";
    feed.slice(0,40).forEach(function(f){
      var d = new Date(f.t), day = d.toDateString()===new Date().toDateString() ? "Сегодня" : d.toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long"});
      if(day!==lastDay){ html += '<div class="feed-day">'+day+'</div>'; lastDay = day; }
      html += '<div class="feed-row'+(f.id||f.nav?' feed-link':'')+'"'+(f.id?' data-action="open-student" data-id="'+f.id+'"':(f.nav?' data-action="sidebar-nav" data-key="'+f.nav+'"':''))+'>' +
        '<span class="feed-ic '+f.kind+'">'+icon(f.icon,"ic-sm")+'</span><span class="feed-text">'+f.text+'</span>' +
        '<span class="feed-time">'+(f.kind==="live"?"скоро":fmtTime(d.toISOString()))+'</span></div>';
    });
  }
  html += '</div></div>';
  // Справа
  var inbox = staffState.inbox || {inactive:[],pendingCertificates:[]};
  var reqFull = students.filter(function(st){ return st.requested_full_access; });
  html += '<div class="pp-col"><div class="card co-card"><b class="co-card-title">Требует внимания</b>' +
    '<div class="att-row" data-action="sidebar-nav" data-key="students"><b>'+inbox.inactive.length+'</b><span>не заходили 7+ дней</span><em>→</em></div>' +
    '<div class="att-row" data-action="sidebar-nav" data-key="students"><b>'+inbox.pendingCertificates.length+'</b><span>ждут сертификат</span><em>→</em></div>' +
    '<div class="att-row" data-action="sidebar-nav" data-key="students"><b>'+reqFull.length+'</b><span>'+ruPluralClient(reqFull.length,"заявка","заявки","заявок")+' на полную программу</span><em>→</em></div>' +
    '<div class="att-row" data-action="sidebar-nav" data-key="assignments"><b>'+((toolsState.assign.counts||{}).pending||0)+'</b><span>ответов ждут проверки</span><em>→</em></div>' +
    '<div class="att-row" data-action="sidebar-nav" data-key="orders"><b>'+((toolsState.orders.summary||{}).overdueOrders||0)+'</b><span>заказов с просроченным платежом</span><em>→</em></div></div>';
  var now = new Date();
  var evs = (calendarState.events||[]).filter(function(ev){ return new Date(ev.event_date+"T"+(ev.event_time||"00:00"))>=now; })
    .sort(function(a,b){ return (a.event_date+a.event_time).localeCompare(b.event_date+b.event_time); }).slice(0,4);
  html += '<div class="card co-card"><div class="co-head"><b>Ближайшие эфиры</b><button class="btn btn-sm btn-ghost" data-action="sidebar-nav" data-key="calendar">Расписание →</button></div>';
  if(!evs.length) html += '<p class="set-muted" style="margin-top:12px;">Эфиры не запланированы.</p>';
  evs.forEach(function(ev){
    var d = new Date(ev.event_date+"T00:00:00"), st = ev.stream_id ? calendarState.streams.find(function(x){ return x.id===ev.stream_id; }) : null;
    html += '<div class="sched-row"><div class="sched-date"><b>'+d.getDate()+'</b><span>'+d.toLocaleDateString("ru-RU",{month:"short"}).replace(".","")+'</span></div>' +
      '<div class="sched-info"><b>'+escapeHtml(ev.title)+'</b><span>'+escapeHtml(ev.event_time||"")+' · '+escapeHtml(st?st.name:"все потоки")+'</span></div></div>';
  });
  html += '</div></div></div>';
  return el(html);
}

// Главная куратора/администратора: сводка по потокам в зоне ответственности,
// задачи на сегодня (переиспользует уже существующий renderInboxCard), короткие
// окна уведомлений/сообщений (как на главной врача) и дайджест-«ИИ-ассистент»
// за вчера (детерминированный шаблон из src/dailyDigest.js, не LLM-вызов —
// см. комментарий в самом dailyDigest.js).
// Быстрые действия на главной персонала — самое частое, без поиска по меню.
function renderStaffQuickActions(){
  var admin = isAdminRole();
  var acts = [];
  if(admin) acts.push(["open-lesson-creator","book","Урок","новый урок курса"]);
  if(admin) acts.push(["home-new-protocol","doctor","Протокол","гайды по специализациям"]);
  acts.push(["open-event-form","calendar","Эфир","в расписание потока", ' data-date="'+todayIso()+'"']);
  acts.push(["home-invite","users","Врач","пригласить на курс"]);
  return '<div class="qa-row">' + acts.map(function(a){
    return '<button type="button" class="card qa-btn" data-action="'+a[0]+'"'+(a[4]||'')+'><span class="qa-ic">'+icon(a[1])+'</span><span><b>+ '+a[2]+'</b><em>'+a[3]+'</em></span></button>';
  }).join('') + '</div>';
}
// «Что доделать в курсе» (только администратор): уроки без теста, неопубликованные
// правки, итоговый тест без вопросов, протоколы без урока или гайдов, пустые
// модули. Каждая строка ведёт прямо туда, где это исправляется.
function staffContentIssues(){
  var out = [], list = staffState.materials || [];
  list.forEach(function(l, i){
    if(l.has_draft) out.push({ kind:"warn", text:"Урок "+(i+1)+" «"+l.title+"» — правки не опубликованы", act:' data-action="open-lesson-page" data-id="'+l.id+'" data-tab="content"', go:"Опубликовать" });
  });
  list.forEach(function(l, i){
    if(!l.quiz_count) out.push({ kind:"warn", text:"Урок "+(i+1)+" «"+l.title+"» — нет теста", act:' data-action="open-lesson-page" data-id="'+l.id+'" data-tab="quiz"', go:"Добавить" });
  });
  var noVideo = list.filter(function(l){ return !l.has_video; }).length;
  if(noVideo) out.push({ kind:"info", text:noVideo+" "+ruPluralClient(noVideo,"урок","урока","уроков")+" без видео", act:' data-action="sidebar-nav" data-key="materials"', go:"К урокам" });
  if(list.length && !(staffState.quizAdmin||[]).length) out.push({ kind:"warn", text:"В итоговом тесте нет вопросов — сертификат не выдать", act:' data-action="open-lesson-page" data-id="quiz" data-tab="questions"', go:"Добавить" });
  (adminProtocolsState.list||[]).forEach(function(pr){
    if(!(pr.lessonIds||[]).length) out.push({ kind:"warn", text:"Протокол «"+pr.title+"» не привязан к уроку — врачи его не получат", act:' data-action="home-open-protocol" data-id="'+pr.id+'"', go:"Привязать" });
    else if(!(pr.guides||[]).length) out.push({ kind:"warn", text:"У протокола «"+pr.title+"» нет гайдов", act:' data-action="home-open-protocol" data-id="'+pr.id+'"', go:"Добавить" });
  });
  (moduleManagerState.modules||[]).forEach(function(m){
    if(!(m.lessonIds||[]).length) out.push({ kind:"info", text:"В модуле «"+m.title+"» нет уроков", act:' data-action="sidebar-nav" data-key="materials"', go:"К урокам" });
  });
  return out;
}
function renderContentIssuesCard(){
  var issues = staffContentIssues(), shown = issues.slice(0, 6);
  var html = '<div class="card co-card ci-card"><div class="ci-head"><b>Что доделать в курсе</b>' +
    (issues.length ? '<span class="ls-n">'+issues.length+' '+ruPluralClient(issues.length,"пункт","пункта","пунктов")+'</span>' : '') + '</div>';
  if(!issues.length) return html + '<p class="ci-ok">'+icon("check","ic-sm")+'Во всех уроках есть тест, правки опубликованы, протоколы привязаны.</p></div>';
  html += shown.map(function(x){
    return '<div class="ci-row"'+x.act+'><span class="lp-dot '+(x.kind==="warn"?"no":"na")+'">'+(x.kind==="warn"?"!":"i")+'</span><span class="ci-text">'+escapeHtml(x.text)+'</span><em>'+x.go+' →</em></div>';
  }).join('');
  if(issues.length > shown.length) html += '<button type="button" class="link-btn ci-more" data-action="sidebar-nav" data-key="materials">Ещё '+(issues.length-shown.length)+' — в разделе «Уроки» →</button>';
  return html + '</div>';
}
function renderStaffHome(container){
  container.appendChild(el(renderStaffQuickActions()));
  var totalLessons = (staffState.materials||[]).length || 1;
  var students = staffState.students || [];
  var byStream = {};
  students.forEach(function(s){
    var key = s.stream_id || "__none";
    (byStream[key] = byStream[key] || []).push(s);
  });
  var streamKeys = Object.keys(byStream);

  var streamsHtml = '<b style="font-size:15px;display:block;margin-bottom:10px;">Ваши потоки</b>';
  if(!streamKeys.length){
    streamsHtml += '<div class="card empty-state" style="padding:32px 20px;">' +
      '<div class="tile-icon" style="background:var(--primary-tint);color:var(--primary);margin:0 auto 12px;">'+icon("users")+'</div>' +
      '<b style="font-size:14px;display:block;color:var(--ink);">Врачей пока нет</b>' +
      '<p style="font-size:13px;margin:4px 0 0;">Как только куратор добавит первого врача в поток, здесь появится карточка с его прогрессом.</p>' +
    '</div>';
  } else {
    streamsHtml += '<div class="board-strip">';
    streamKeys.forEach(function(key){
      var list = byStream[key];
      var stream = calendarState.streams.find(function(x){ return x.id===key; });
      var name = stream ? stream.name : "Без потока";
      var activeCount = list.filter(function(s){ return (s.completed_lessons||[]).length>0 && !s.completed; }).length;
      var avgPct = Math.round(list.reduce(function(sum,s){ return sum + Math.min(100, Math.round(((s.completed_lessons||[]).length/totalLessons)*100)); },0) / list.length);
      streamsHtml += '<div class="card" style="padding:18px;">' +
        '<div style="display:flex;align-items:center;gap:12px;">' +
          '<div class="progress-ring" data-anim="ring" style="width:46px;height:46px;--ring-p:'+avgPct+'%;"><div class="progress-ring-inner" style="width:34px;height:34px;font-size:11px;"><span data-count="'+avgPct+'" data-suffix="%">'+avgPct+'%</span></div></div>' +
          '<div>' +
            '<b style="font-size:14px;display:block;">'+escapeHtml(name)+'</b>' +
            '<span style="font-size:12px;color:var(--muted);">средний прогресс</span>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line-2);display:flex;align-items:baseline;gap:6px;">' +
          '<span style="font-family:var(--sans);font-weight:700;font-size:22px;" data-count="'+list.length+'">'+list.length+'</span>' +
          '<span style="font-size:12px;color:var(--muted);">врачей · '+activeCount+' активных</span>' +
        '</div>' +
      '</div>';
    });
    streamsHtml += '</div>';
  }
  container.appendChild(el('<div style="margin-top:6px;">'+streamsHtml+'</div>'));

  var inbox = staffState.inbox || {inactive:[],pendingCertificates:[]};
  var pendingTasks = (toolsState.assign.counts||{}).pending||0, overdueOrders = (toolsState.orders.summary||{}).overdueOrders||0;
  var totalTasks = inbox.inactive.length + inbox.pendingCertificates.length + pendingTasks + overdueOrders;
  container.appendChild(el(
    '<div style="display:flex;align-items:center;gap:10px;margin:20px 0 10px;">' +
      '<div class="tile-icon" style="background:var(--status-attention-tint);color:var(--status-attention);">'+icon("clipboard")+'</div>' +
      '<b style="font-size:15px;">Задачи на сегодня</b>' +
    '</div>'
  ));
  if(pendingTasks || overdueOrders){
    container.appendChild(el('<div class="card co-card today-extra">' +
      (pendingTasks ? '<div class="att-row" data-action="sidebar-nav" data-key="assignments"><b>'+pendingTasks+'</b><span>'+ruPluralClient(pendingTasks,"ответ врача ждёт","ответа врачей ждут","ответов врачей ждут")+' проверки</span><em>→</em></div>' : '') +
      (overdueOrders ? '<div class="att-row" data-action="sidebar-nav" data-key="orders"><b>'+overdueOrders+'</b><span>'+ruPluralClient(overdueOrders,"заказ","заказа","заказов")+' с просроченным платежом</span><em>→</em></div>' : '') +
    '</div>'));
  }
  if(inbox.inactive.length + inbox.pendingCertificates.length) container.appendChild(renderInboxCard());
  else if(!totalTasks) container.appendChild(el(
    '<div class="card empty-state" style="padding:32px 20px;">' +
      '<div class="tile-icon" style="background:var(--status-active-tint);color:var(--status-active);margin:0 auto 12px;">'+icon("check")+'</div>' +
      '<b style="font-size:14px;display:block;color:var(--ink);">Всё разобрано</b>' +
      '<p style="font-size:13px;margin:4px 0 0;">Никто не ждёт ответа и не завис без активности — новые задачи появятся здесь сами.</p>' +
    '</div>'
  ));

  if(isAdminRole() && (staffState.materials||[]).length) container.appendChild(el('<div style="margin-top:14px;">'+renderContentIssuesCard()+'</div>'));

  var reminders = upcomingEventReminders();
  var gridHtml = '<div class="grid-2" style="margin-top:20px;">';
  gridHtml += '<div class="card home-tile" style="padding:18px 20px;">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
      '<div class="tile-icon" style="background:var(--primary-tint);color:var(--primary);">'+icon("bell")+'</div>' +
      '<b style="font-size:14px;">Уведомления</b>' +
    '</div>';
  if(!reminders.length){
    gridHtml += '<div style="display:flex;align-items:center;gap:8px;color:var(--status-active);">'+icon("check","ic-sm")+'<p style="font-size:13px;color:var(--muted);margin:0;">Ближайших эфиров и дедлайнов не запланировано — тут спокойно.</p></div>';
  } else {
    reminders.slice(0,3).forEach(function(n){
      gridHtml += '<div style="padding:8px 0;border-bottom:1px solid var(--line-2);"><b style="font-size:13px;display:block;">'+escapeHtml(n.title)+'</b></div>';
    });
  }
  gridHtml += '</div>';
  gridHtml += '<div class="card home-tile" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<div class="tile-icon" style="background:var(--primary-tint);color:var(--primary);">'+icon("message")+'</div>' +
        '<b style="font-size:14px;">Общение</b>' +
      '</div>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-telegram-modal">Открыть →</button>' +
    '</div>' +
    '<p style="font-size:13px;color:var(--muted);margin:0;">Врачи, кураторы и преподаватели — в Telegram-группах потоков.</p>' +
  '</div></div>';
  container.appendChild(el(gridHtml));

  var d = staffState.digest;
  var digestHtml = '<div class="card home-tile" style="padding:18px 20px;margin-top:20px;">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
      '<div class="tile-icon" style="background:var(--status-done-tint);color:var(--status-done);">'+icon("chartbar")+'</div>' +
      '<b style="font-size:14px;">ИИ-ассистент — отчёт за вчера</b>' +
    '</div>';
  if(!d){
    digestHtml += '<div style="display:flex;align-items:center;gap:8px;color:var(--muted-2);">'+icon("clock","ic-sm")+'<p style="font-size:13px;color:var(--muted);margin:0;">Ещё не готов — соберёт итоги дня и появится здесь к 9:00 по МСК.</p></div>';
  } else {
    digestHtml += '<p style="font-size:14px;margin:0;line-height:1.5;">'+escapeHtml(d.summary)+'</p>';
  }
  digestHtml += '</div>';
  container.appendChild(el(digestHtml));
}

function renderCalendarTab(){
  return el('<div style="margin-top:6px;">' + renderMonthCalendar() + '</div>');
}

function renderStreamsPanel(){
  var streams = calendarState.streams;
  var countsByStream = {};
  staffState.students.forEach(function(s){ var sid=s.stream_id||""; countsByStream[sid]=(countsByStream[sid]||0)+1; });

  var html = '<div class="card" style="padding:18px 20px;margin-bottom:20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:15px;">Потоки обучения</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="toggle-stream-form">'+(calendarState.showStreamForm?'Скрыть':'+ Новый поток')+'</button>' +
    '</div>';
  if(calendarState.showStreamForm){
    html += '<form id="streamForm" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px;">' +
      '<div class="field" style="margin-bottom:0;min-width:220px;flex:1;"><label>Название потока</label><input class="input" name="name" required placeholder="Например, Поток «Октябрь 2026»"></div>' +
      '<div class="field" style="margin-bottom:0;"><label>Дата старта</label><input class="input" type="date" name="startDate"></div>' +
      '<div class="field" style="margin-bottom:0;min-width:220px;flex:1;"><label>Ссылка на Telegram-группу (можно позже)</label><input class="input" name="telegramUrl" type="text" inputmode="url" placeholder="https://t.me/..."></div>' +
      '<button class="btn btn-primary" type="submit">Создать</button></form>';
  }
  if(!streams.length){
    html += '<p style="font-size:13px;color:var(--muted);margin:0;">Пока нет ни одного потока.</p>';
  } else {
    // Компактная карточка: название, старт, число врачей, Telegram одной строкой.
    // Поле ссылки открывается по «Изменить», «Изменить»/«Удалить» — по наведению.
    html += '<div class="streams-grid">';
    streams.forEach(function(s){
      var editing = calendarState.editingStreamId === s.id;
      var tg = s.telegram_url ? String(s.telegram_url).replace(/^https?:\/\//,"") : "";
      var actions = '<div class="stream-actions">' +
            (editing ? '' : '<button class="btn btn-sm btn-ghost" data-action="edit-stream" data-id="'+s.id+'">Изменить</button>') +
            '<button class="btn btn-sm btn-ghost" data-action="delete-stream" data-id="'+s.id+'">Удалить</button></div>';
      html += '<div class="stream-card'+(editing?' editing':'')+'">' +
        '<b class="stream-name">'+escapeHtml(s.name)+'</b>' +
        '<span class="stream-meta">старт: '+(s.start_date?fmtDate(s.start_date):"—")+' · '+(countsByStream[s.id]||0)+' врачей</span>' +
        (editing
          ? '<div class="stream-edit"><input class="input" data-stream-telegram-input data-id="'+s.id+'" value="'+escapeHtml(s.telegram_url||"")+'" placeholder="Ссылка на Telegram-группу, https://t.me/…">' +
              '<div class="stream-edit-btns"><button class="btn btn-sm btn-primary" data-action="save-stream-telegram" data-id="'+s.id+'">Сохранить</button>' +
              '<button class="btn btn-sm btn-ghost" data-action="cancel-edit-stream">Отмена</button>'+actions+'</div></div>'
          : '<div class="stream-foot">' + (s.telegram_url
              ? '<a class="stream-tg" href="'+escapeHtml(s.telegram_url)+'" target="_blank" rel="noopener">'+icon("message","ic-sm")+'<span>'+escapeHtml(tg)+'</span> ↗</a>'
              : '<span class="stream-tg off">'+icon("message","ic-sm")+'Telegram не подключён</span>') + actions + '</div>') +
      '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
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
          '<span style="font-size:14px;">Повторять еженедельно</span></label>' +
        (calendarState.recurring ? '<div class="field"><label>Повторять до</label><input class="input" type="date" name="recurrenceUntil" required></div>' : '') +
        '<button class="btn btn-primary btn-block" type="submit">Добавить в расписание</button></form></div>';
    return el('<div class="overlay" data-action="overlay-close-event"><div class="drawer" data-stop="1" style="width:min(480px,100%);">'+body+'</div></div>');
  }
  var ev = calendarState.events.filter(function(x){ return x.id===calendarState.eventModalId; })[0];
  if(!ev) return el('<div></div>');
  var stream = calendarState.streams.filter(function(s){ return s.id===ev.stream_id; })[0];
  var body2 = '<div class="drawer-head"><b style="font-size:16px;">'+escapeHtml(ev.title)+'</b><button class="btn btn-ghost btn-sm" data-action="close-event-modal">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><p style="font-size:14px;color:var(--muted);margin:0 0 4px;">'+fmtDate(ev.event_date)+' в '+escapeHtml(ev.event_time||"—")+' · '+(ev.duration_min||60)+' мин</p>' +
    (ev.speaker?'<p style="font-size:14px;margin:0 0 4px;">Спикер: '+escapeHtml(ev.speaker)+'</p>':'') +
    '<p style="font-size:14px;margin:0 0 4px;">Поток: '+(stream?escapeHtml(stream.name):'Все потоки')+'</p>' +
    (ev.recurrence_group_id ? '<p style="font-size:13px;color:var(--accent);margin:0 0 4px;display:flex;align-items:center;gap:5px;">'+icon("repeat","ic-sm")+' Часть серии повторов</p>' : '') +
    (ev.join_url?'<p style="font-size:14px;margin:0 0 12px;"><a href="'+escapeHtml(ev.join_url)+'" target="_blank" rel="noopener" style="color:var(--primary-dark);">Ссылка на подключение →</a></p>':'') +
    (ev.description?'<p style="font-size:14px;color:var(--muted);margin:0 0 16px;">'+escapeHtml(ev.description)+'</p>':'') +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      '<button class="btn btn-ghost" data-action="delete-event" data-id="'+ev.id+'">Удалить эфир</button>' +
      (ev.recurrence_group_id ? '<button class="btn btn-ghost" data-action="delete-event-series" data-id="'+ev.id+'">Удалить всю серию</button>' : '') +
    '</div></div>';
  return el('<div class="overlay" data-action="overlay-close-event"><div class="drawer" data-stop="1" style="width:min(480px,100%);">'+body2+'</div></div>');
}

var AUDIT_ACTION_LABELS = {
  "assignment.accept": "Задание принято",
  "assignment.return": "Задание возвращено на доработку",
  "assignment.config": "Задание к уроку изменено",
  "order.create": "Создан заказ",
  "order.payment": "Отмечена оплата",
  "order.payment_undo": "Снята отметка об оплате",
  "order.cancel": "Заказ отменён",
  "product.create": "Создан продукт",
  "product.update": "Изменён продукт",
  "product.delete": "Удалён продукт",
  "survey.create": "Создана анкета",
  "survey.update": "Изменена анкета",
  "survey.delete": "Удалена анкета",
  "protocol.create": "Создан протокол",
  "protocol.update": "Изменён протокол",
  "protocol.delete": "Удалён протокол",
  "protocol.guide_update": "Изменён гайд протокола",
  "protocol.guide_delete": "Удалён гайд протокола",
  "protocol.guide_file_add": "Файл добавлен в гайд",
  "protocol.guide_file_delete": "Файл удалён из гайда",
  "protocol.lessons_update": "Уроки протокола изменены",
  "content.module_created": "Создан модуль",
  "content.module_updated": "Изменён модуль",
  "content.module_deleted": "Удалён модуль",
  "content.lesson_module_assigned": "Урок перенесён в модуль",
  "content.module_quiz_created": "Вопрос теста модуля добавлен",
  "content.module_quiz_reordered": "Порядок теста модуля изменён",
  "content.lesson_quiz_created": "Вопрос теста урока добавлен",
  "content.lesson_quiz_reordered": "Порядок теста урока изменён",
  "content.lesson_video_updated": "Видео урока изменено",
  "specialization.create": "Создана специализация",
  "specialization.update": "Изменена специализация",
  "specialization.delete": "Удалена специализация",
  "stream.update_telegram": "Ссылка Telegram потока изменена",
  "auth.register": "Регистрация",
  "auth.change_password": "Смена пароля",
  "auth.logout_everywhere": "Выход со всех устройств",
  "student.impersonate": "Вход в кабинет врача (просмотр)",
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
  "course.create": "Создан курс",
  "course.update": "Изменён курс",
  "course.delete": "Удалён курс",
  "course.enroll": "Врач записан на курс",
  "student.bulk_import": "Массовый импорт врачей",
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
  "content.lesson_scheduled": "Назначена дата открытия урока",
  "content.lesson_schedule_cleared": "Сброшено расписание урока",
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
  if(a.indexOf("access.block")===0 || a==="staff.remove" || a==="invite.cancel" || a==="order.cancel" || a==="assignment.return" || /\.delete$|_deleted$/.test(a)) return "blocked";
  if(a==="order.payment" || a==="assignment.accept") return "done";
  if(a.indexOf("access.")===0 || a.indexOf("password.")===0) return "attention";
  if(a==="certificate.issue" || a.indexOf("content.lesson_published")===0) return "done";
  if(a==="audit.revert") return "live";
  return "active";
}

// Актёр может быть и сотрудником (куратор/админ), и врачом (свои auth.* события) —
// поэтому список для фильтра собирается из обоих источников, а не только из
// directory (который знает только про персонал).
function auditActorOptions(){
  var seen = {}; var opts = [];
  directory.forEach(function(p){ if(!seen[p.id]){ seen[p.id]=true; opts.push({id:p.id,name:p.name}); } });
  staffState.students.forEach(function(s){ if(!seen[s.id]){ seen[s.id]=true; opts.push({id:s.id,name:s.name}); } });
  opts.sort(function(a,b){ return a.name.localeCompare(b.name,"ru"); });
  return opts;
}

function auditExportUrl(){
  var params = new URLSearchParams();
  if(auditFilters.q) params.set("q", auditFilters.q);
  if(auditFilters.action) params.set("action", auditFilters.action);
  if(auditFilters.actorId) params.set("actorId", auditFilters.actorId);
  if(auditFilters.dateFrom) params.set("dateFrom", auditFilters.dateFrom);
  if(auditFilters.dateTo) params.set("dateTo", auditFilters.dateTo);
  var qs = params.toString();
  return "api/staff/audit-log/export.csv"+(qs?"?"+qs:"");
}

function renderAuditLogTab(){
  var html = '<div class="card" style="padding:18px 20px;margin-top:6px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:15px;">Журнал действий персонала</b>' +
      '<a class="btn btn-sm btn-ghost" href="'+auditExportUrl()+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+' Экспорт CSV</a>' +
    '</div>' +
    '<p style="font-size:13px;color:var(--muted);margin:4px 0 16px;">Последние 100 действий (с учётом фильтров ниже) — экспорт выгружает те же фильтры, до 5000 строк. '+(me.role==="super_admin"?'Обратимые действия можно откатить — это вернёт состояние к тому, что было до изменения.':'')+'</p>';

  var actorOpts = auditActorOptions();
  html += '<div class="dash-filters-grid" style="margin-bottom:16px;">' +
    '<div class="dash-field" style="grid-column:span 2;"><label>Поиск</label><input class="input" id="auditSearchInput" placeholder="Кто или что" value="'+escapeHtml(auditFilters.q)+'"></div>' +
    '<div class="dash-field"><label>Действие</label><select class="input" id="auditActionFilter" style="padding:8px 9px;font-size:13px;">' +
      '<option value="">Все</option>' +
      auditActionsList.map(function(a){ return '<option value="'+escapeHtml(a)+'"'+(auditFilters.action===a?' selected':'')+'>'+escapeHtml(auditActionLabel(a))+'</option>'; }).join('') +
    '</select></div>' +
    '<div class="dash-field"><label>Кто</label><select class="input" id="auditActorFilter" style="padding:8px 9px;font-size:13px;">' +
      '<option value="">Все</option>' +
      actorOpts.map(function(p){ return '<option value="'+p.id+'"'+(auditFilters.actorId===p.id?' selected':'')+'>'+escapeHtml(p.name)+'</option>'; }).join('') +
    '</select></div>' +
    '<div class="dash-field dash-field-period"><label>Период</label><div class="dash-period-inputs">' +
      '<input class="input" type="date" id="auditDateFrom" value="'+escapeHtml(auditFilters.dateFrom)+'">' +
      '<span>—</span>' +
      '<input class="input" type="date" id="auditDateTo" value="'+escapeHtml(auditFilters.dateTo)+'">' +
    '</div></div>' +
    (auditFilters.q||auditFilters.action||auditFilters.actorId||auditFilters.dateFrom||auditFilters.dateTo ?
      '<div class="dash-field" style="align-self:end;"><button class="btn btn-sm btn-ghost" data-action="reset-audit-filters">Сбросить</button></div>' : '') +
  '</div>';

  if(!staffState.auditLog.length){
    var hasFilters = auditFilters.q||auditFilters.action||auditFilters.actorId||auditFilters.dateFrom||auditFilters.dateTo;
    html += '<div class="empty-state"><div class="big">'+icon("clipboard","ic-lg")+'</div>'+(hasFilters?'Ничего не нашлось по этим фильтрам.':'Пока пусто.')+'</div>';
  } else {
    html += '<div style="overflow-x:auto;"><table class="roster"><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Кого/чего касается</th><th></th></tr></thead><tbody>';
    staffState.auditLog.forEach(function(l){
      var canRevert = me.role==="super_admin" && l.revertible && !l.reverted_at;
      var statusNote = l.reverted_at ? '<span style="font-size:11px;color:var(--muted-2);display:block;">откачено '+fmtDate(l.reverted_at)+(l.reverted_by?(' · '+escapeHtml(l.reverted_by)):'')+'</span>' : '';
      html += '<tr>' +
        '<td class="audit-when">'+fmtDate(l.created_at)+' '+fmtTime(l.created_at)+'</td>' +
        '<td>'+escapeHtml(l.actor_name)+(l.actor_role?(' <span style="color:var(--muted);font-size:12px;">('+roleLabel(l.actor_role)+')</span>'):'')+'</td>' +
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

/* ============================= РЕНДЕР: УРОКИ (список и страница урока) ============================= */
// Один раздел вместо прежних «Учебных материалов» и «Модулей»: модули — секциями,
// уроки внутри по порядку, у каждого — плашки состояния (видео, тест, задание,
// расписание, видимость) вместо ряда кнопок. Клик по уроку открывает страницу
// урока с вкладками. На вкладках — те же самые редакторы, что раньше открывались
// окнами: пока вкладка открыта, окно не монтируется поверх (см. lpOwns в render()),
// а его содержимое встраивается в страницу — сохранение идёт теми же обработчиками.
var LP_TABS = [["content","Содержание"],["video","Видео"],["quiz","Тест"],["assign","Задание"],["schedule","Расписание"],["access","Доступ"]];
var lpAuto = { pending:null, fails:{} };

function lsLessons(){ return staffState.materials || []; }
function lsLesson(id){ return lsLessons().find(function(l){ return l.id===id; }) || null; }
function lsPill(kind, text, ic){ return '<span class="ls-pill'+(kind?' '+kind:'')+'">'+(ic?icon(ic,"ic-sm"):'')+escapeHtml(text)+'</span>'; }
function lpQuizCount(l){ return (lessonQuizManager.open && lessonQuizManager.loaded && lessonQuizManager.lessonId===l.id) ? lessonQuizManager.questions.length : (l.quiz_count||0); }
// Плашки урока — по сохранённому: ссылка, только введённая в форму, видео не делает
// (для предпросмотра форма читается отдельно). Загруженный файл сохраняется сразу.
function lpHasVideo(l){ return !!l.has_video || (videoEditor.lessonId===l.id && !!videoEditor._uploaded); }
function lsDripLabel(l){ return (l.drip_days===null || l.drip_days===undefined || l.drip_days===0) ? "открыт сразу" : "через "+l.drip_days+" "+ruPluralClient(l.drip_days,"день","дня","дней")+" после старта"; }
function lsHiddenLabel(n){ return "скрыт от "+n+" "+ruPluralClient(n,"врача","врачей","врачей"); }
function lsChips(l){
  var c = [], hidden = (courseVisibility[l.id]||[]).length, qc = lpQuizCount(l);
  if(l.has_draft) c.push(lsPill("warn","правки не опубликованы"));
  c.push(lpHasVideo(l) ? lsPill("ok","видео","play") : lsPill("warn","нет видео","play"));
  c.push(qc ? lsPill("ok","тест · "+qc+" "+ruPluralClient(qc,"вопрос","вопроса","вопросов"),"check") : lsPill("warn","нет теста"));
  if(l.assignment_prompt) c.push(lsPill("info", l.assignment_required ? "задание · стоп-урок" : "задание", "task"));
  c.push(lsPill("", lsDripLabel(l), "calendar"));
  c.push(hidden ? lsPill("warn", lsHiddenLabel(hidden), "eye") : lsPill("", "видят все", "eye"));
  return c.join("");
}
// Меню «⋯»: items — [action, подпись, иконка, доп. атрибуты, "danger"] или "-" (разделитель).
function lsMenu(key, items){
  var open = staffState.lsMenu === key;
  var html = '<span class="ls-menu-wrap" data-action="ls-noop"><button type="button" class="ls-more'+(open?' on':'')+'" data-action="ls-menu" data-key="'+escapeHtml(key)+'" title="Ещё" aria-label="Ещё">⋯</button>';
  if(open){
    html += '<span class="ls-menu" role="menu">' + items.map(function(it){
      if(it==="-") return '<i class="ls-menu-sep"></i>';
      return '<button type="button" role="menuitem" class="ls-menu-item'+(it[4]?' '+it[4]:'')+'" data-action="'+it[0]+'"'+(it[3]||'')+'>'+(it[2]?icon(it[2],"ic-sm"):'')+escapeHtml(it[1])+'</button>';
    }).join('') + '</span>';
  }
  return html + '</span>';
}
function lsRow(l, i, admin, modules){
  var items = [["open-course-preview","Как видит врач","eye",' data-idx="'+i+'"'], "-",
    ["open-lesson-page","Расписание","calendar",' data-id="'+l.id+'" data-tab="schedule"'],
    ["open-lesson-page","Доступ","users",' data-id="'+l.id+'" data-tab="access"']];
  if(admin){
    items.push("-", ["ls-move","Выше в модуле","chevron",' data-id="'+l.id+'" data-dir="up"'], ["ls-move","Ниже в модуле","chevron",' data-id="'+l.id+'" data-dir="down"']);
    var targets = modules.filter(function(m){ return m.id!==l.module_id; });
    if(targets.length || l.module_id) items.push("-");
    targets.forEach(function(m){ items.push(["ls-set-module","В модуль «"+m.title+"»","folder",' data-id="'+l.id+'" data-module="'+m.id+'"']); });
    if(l.module_id) items.push(["ls-set-module","Убрать из модуля","folder",' data-id="'+l.id+'" data-module=""']);
    items.push("-", ["delete-lesson","Удалить урок","trash",' data-id="'+l.id+'" data-title="'+escapeHtml(l.title)+'"',"danger"]);
  }
  return '<div class="ls-row'+(staffState.lsMenu==="l:"+l.id?' menu-open':'')+'" data-action="open-lesson-page" data-id="'+l.id+'"'+(admin?' draggable="true" data-drag="1"':'')+'>' +
    (admin ? '<span class="ls-grip" title="Перетащите, чтобы поменять порядок или модуль">⋮⋮</span>' : '') +
    '<span class="ls-num">'+(i+1)+'</span>' +
    '<div class="ls-main"><b>'+escapeHtml(l.title)+'</b><div class="ls-chips">'+lsChips(l)+'</div></div>' +
    '<button type="button" class="btn btn-sm btn-ghost ls-open" data-action="open-lesson-page" data-id="'+l.id+'">Открыть</button>' +
    lsMenu("l:"+l.id, items) +
  '</div>';
}

function renderLessonsTab(){
  if(staffState.lessonPageId) return renderLessonPage();
  var admin = isAdminRole();
  var list = lsLessons(), q = (staffState.lsQuery||"").trim().toLowerCase();
  var mods = admin ? (moduleManagerState.modules||[]) : [];
  var modInfo = {}; mods.forEach(function(m){ modInfo[m.id] = m; });
  var hasModules = mods.length>0 || list.some(function(l){ return !!l.module_id; });
  // Секции — подряд идущие уроки одного модуля, в реальном порядке курса: если
  // модуль разорван другими уроками, он честно показывается дважды.
  var runs = [], seen = {};
  list.forEach(function(l, i){
    var mid = l.module_id || "", last = runs[runs.length-1];
    if(last && last.mid===mid) last.items.push({ l:l, i:i });
    else { runs.push({ mid:mid, title:l.module_title || (modInfo[mid]&&modInfo[mid].title) || "", cont:!!seen[mid], items:[{ l:l, i:i }] }); seen[mid] = true; }
  });
  mods.forEach(function(m){ if(!seen[m.id]) runs.push({ mid:m.id, title:m.title, cont:false, items:[] }); });

  var html = '<div class="ls-page">' +
    '<div class="ls-bar"><p class="ls-sub">'+(admin
      ? 'Модули и уроки в том порядке, в котором их проходит врач. Перетащите урок за ⋮⋮, чтобы поменять порядок или модуль, и нажмите на урок, чтобы открыть его.'
      : 'Уроки курса по порядку. Нажмите на урок, чтобы назначить дату открытия или скрыть его от части врачей.')+'</p>' +
    '<div class="ls-actions"><label class="ls-search">'+icon("search","ic-sm")+'<input id="lessonsSearchInput" placeholder="Найти урок" value="'+escapeHtml(staffState.lsQuery||"")+'" autocomplete="off"></label>' +
      (admin ? '<button type="button" class="btn btn-ghost" data-action="toggle-module-create">+ Модуль</button><button type="button" class="btn btn-primary" data-action="open-lesson-creator">+ Урок</button>' : '') +
    '</div></div>';
  if(admin && staffState.showModuleCreate){
    html += '<form id="moduleCreateForm" class="card ls-modform"><input class="input" name="title" placeholder="Название модуля, например «Гормональное здоровье»" required>' +
      '<button class="btn btn-primary" type="submit">Добавить модуль</button><button type="button" class="btn btn-ghost" data-action="toggle-module-create">Отмена</button></form>';
  }
  if(!list.length){
    html += '<div class="card empty-state" style="padding:36px 16px;">В курсе пока нет уроков.'+(admin?' Нажмите «+ Урок», чтобы добавить первый.':'')+'</div>';
  }
  var shown = 0;
  runs.forEach(function(r){
    var items = q ? r.items.filter(function(x){ return x.l.title.toLowerCase().indexOf(q)!==-1; }) : r.items;
    if(q && !items.length) return;
    shown += items.length;
    var m = modInfo[r.mid];
    html += '<div class="card ls-sec" data-module="'+escapeHtml(r.mid)+'" data-last="'+(r.items.length ? r.items[r.items.length-1].l.id : '')+'">';
    if(hasModules){
      if(r.mid){
        html += '<div class="ls-sec-h"><b>'+escapeHtml(r.title || "Модуль")+(r.cont?' <span class="ls-cont">продолжение</span>':'')+'</b>' +
          '<span class="ls-n">'+r.items.length+' '+ruPluralClient(r.items.length,"урок","урока","уроков")+'</span><span class="ls-sp"></span>';
        if(admin && m && !r.cont){
          var fb = m.feedback || { count:0, average:null };
          html += '<button type="button" class="ls-chip-btn'+(m.quizCount?' ok':'')+'" data-action="open-module-quiz-manager" data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'">'+(m.quizCount ? 'тест модуля · '+m.quizCount+' '+ruPluralClient(m.quizCount,"вопрос","вопроса","вопросов") : '+ тест модуля')+'</button>' +
            '<button type="button" class="ls-chip-btn" data-action="open-module-feedback-viewer" data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'">'+(fb.count ? '★ '+fb.average.toFixed(1)+' · '+fb.count+' '+ruPluralClient(fb.count,"отзыв","отзыва","отзывов") : 'отзывов нет')+'</button>' +
            lsMenu("m:"+m.id, [
              ["rename-module","Переименовать модуль","gear",' data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'"'],
              ["open-module-quiz-manager","Тест модуля","check",' data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'"'],
              ["open-module-feedback-viewer","Отзывы о модуле","star",' data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'"'],
              "-",
              ["delete-module","Удалить модуль","trash",' data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'"',"danger"]
            ]);
        }
        html += '</div>';
      } else {
        html += '<div class="ls-sec-h"><b class="ls-muted">Без модуля</b></div>';
      }
    }
    if(!r.items.length) html += '<div class="ls-empty">В модуле пока нет уроков — перетащите сюда урок или выберите «В модуль…» в меню урока.</div>';
    items.forEach(function(x){ html += lsRow(x.l, x.i, admin, mods); });
    html += '</div>';
  });
  if(q && !shown) html += '<div class="card empty-state" style="padding:28px 16px;">Уроков с «'+escapeHtml(staffState.lsQuery)+'» в названии нет.</div>';
  if(list.length && !q){
    var qHidden = (courseVisibility.quiz||[]).length, qn = (staffState.quizAdmin||[]).length;
    html += '<div class="card ls-sec ls-final"><div class="ls-row" data-action="open-lesson-page" data-id="quiz">' +
      '<span class="ls-num">'+icon("badge","ic-sm")+'</span>' +
      '<div class="ls-main"><b>Итоговый тест курса</b><div class="ls-chips">' +
        (admin ? (qn ? lsPill("ok", qn+" "+ruPluralClient(qn,"вопрос","вопроса","вопросов"), "check") : lsPill("warn","нет вопросов")) : '') +
        (qHidden ? lsPill("warn", lsHiddenLabel(qHidden), "eye") : lsPill("","видят все","eye")) +
      '</div></div><button type="button" class="btn btn-sm btn-ghost ls-open" data-action="open-lesson-page" data-id="quiz">Открыть</button></div></div>';
  }
  return el(html + '</div>');
}

/* ---------- Страница урока ---------- */
function lpTabs(){
  var admin = isAdminRole();
  if(staffState.lessonPageId==="quiz") return admin ? [["questions","Вопросы"],["access","Доступ"]] : [["access","Доступ"]];
  return admin ? LP_TABS : LP_TABS.filter(function(t){ return t[0]==="schedule" || t[0]==="access"; });
}
function lpActive(){ return view==="staff" && staffState.mainTab==="materials" && !!staffState.lessonPageId && !staffState.selectedStudentId && !previewMode; }
function lpOwns(tab){ return lpActive() && staffState.lessonPageTab===tab; }
function lpReady(tab){
  var id = staffState.lessonPageId;
  if(tab==="content") return lessonEditor.open && !lessonEditor.isNew && lessonEditor.id===id;
  if(tab==="video") return videoEditor.open && videoEditor.lessonId===id;
  if(tab==="quiz") return lessonQuizManager.open && lessonQuizManager.lessonId===id;
  if(tab==="assign") return !!toolsState.assignEditor && toolsState.assignEditor.lessonId===id;
  if(tab==="schedule") return scheduleModal.open && scheduleModal.lessonId===id;
  if(tab==="access") return materialsPicker.open && materialsPicker.targetId===id;
  return true;
}
function lpTitle(){ var id = staffState.lessonPageId; if(id==="quiz") return "Итоговый тест"; var l = lsLesson(id); return l ? l.title : ""; }
async function lpOpen(tab){
  var id = staffState.lessonPageId, title = lpTitle();
  if(tab==="content") await openLessonEditor(id);
  else if(tab==="video") await openVideoEditor(id, title);
  else if(tab==="quiz") await openLessonQuizManager(id, title);
  else if(tab==="assign"){ openAssignEditor(id); render(); }
  else if(tab==="schedule") await openScheduleModal(id, title);
  else if(tab==="access"){ openMaterialsPicker(id, title); render(); }
}
function lpCloseEditors(){
  if(!lessonEditor.isNew) lessonEditor.open = false;
  videoEditor.open = false; lessonQuizManager.open = false; scheduleModal.open = false; materialsPicker.open = false;
  toolsState.assignEditor = null;
}
// Редактор вкладки открывается сам: при входе на вкладку и после сохранения
// (обработчики сохранения закрывают «окно» — здесь оно тут же открывается
// заново уже со свежими данными). Не больше двух неудачных попыток подряд.
function lpEnsure(tab){
  if(lpReady(tab)) return true;
  var key = staffState.lessonPageId+":"+tab;
  if(lpAuto.pending!==key && (lpAuto.fails[key]||0) < 2){
    lpAuto.pending = key;
    setTimeout(function(){
      if(!(lpActive() && staffState.lessonPageId+":"+staffState.lessonPageTab===key)){ lpAuto.pending = null; return; }
      refreshMaterials().then(function(){ if(lpActive() && !isTypingNow()) render(); });
      lpOpen(tab).then(function(){
        if(!lpReady(tab)) lpAuto.fails[key] = (lpAuto.fails[key]||0) + 1;
        lpAuto.pending = null;
      }, function(){ lpAuto.fails[key] = (lpAuto.fails[key]||0) + 1; lpAuto.pending = null; });
    }, 0);
  }
  return false;
}
async function refreshMaterials(){
  var cid = staffState.activeCourseId;
  if(!cid) return;
  try{ var mat = await api("/course/materials?courseId="+encodeURIComponent(cid)); staffState.materials = mat.lessons; }catch(e){}
}
// Несохранённое на открытой вкладке — перед уходом с неё спрашиваем. Обычный
// confirm(), а не askConfirm: тот перерисовывает экран и стёр бы введённое ещё до ответа.
function lpHasUnsaved(){
  var p = document.querySelector(".lp-panel");
  if(!p) return false;
  if(lpOwns("content") && lessonEditor.loaded && lessonEditor._origHtml!==undefined && lessonEditor.html!==lessonEditor._origHtml) return true;
  if(lpOwns("assign") && toolsState.assignEditor && toolsState.assignEditor._dirty) return true;
  if(lpOwns("access") && materialsPicker.open){
    var was = (courseVisibility[materialsPicker.targetId]||[]).slice().sort().join(","), now = materialsPicker.selectedIds.slice().sort().join(",");
    if(was!==now) return true;
  }
  return [].some.call(p.querySelectorAll("input,textarea,select"), function(f){ return !/Search$/.test(f.id||"") && fieldIsChanged(f); });
}
function lpLeaveOk(){ return !lpHasUnsaved() || window.confirm("Уйти без сохранения? Изменения на этой вкладке пропадут."); }
// Тело прежнего окна без его шапки — прямо в карточку вкладки.
function lpInline(node){
  var b = node && node.querySelector(".drawer-body");
  if(!b) return el('<div></div>');
  b.classList.remove("drawer-body"); b.classList.add("lp-inline");
  return b;
}
function lpReadiness(l){
  var hidden = (courseVisibility[l.id]||[]).length, qc = lpQuizCount(l);
  function row(state, title, sub, tab, link){
    return '<div class="lp-chk"><span class="lp-dot '+state+'">'+(state==="ok"?'✓':(state==="no"?'!':'—'))+'</span><div><b>'+title+'</b><span>'+sub+'</span></div>' +
      (link ? '<button type="button" class="link-btn" data-action="lesson-page-tab" data-tab="'+tab+'">'+link+'</button>' : '') + '</div>';
  }
  return '<div class="card lp-ready"><b class="lp-ready-t">Готовность урока</b><span class="lp-ready-s">Что врач увидит в этом уроке</span>' +
    (l.has_draft ? row("no","Правки не опубликованы","Врачи видят прежнюю версию","content", staffState.lessonPageTab==="content"?"":"Открыть") : row("ok","Текст урока","Опубликованная версия актуальна")) +
    (lpHasVideo(l) ? row("ok","Видео","Загружено","video") : row("no","Видео","Не загружено","video", staffState.lessonPageTab==="video"?"":"Загрузить")) +
    (qc ? row("ok","Тест урока",qc+" "+ruPluralClient(qc,"вопрос","вопроса","вопросов")) : row("no","Тест урока","Нет вопросов — шага «Тест» не будет","quiz", staffState.lessonPageTab==="quiz"?"":"Добавить")) +
    (l.assignment_prompt ? row("ok","Задание", l.assignment_required?"Стоп-урок: засчитается после проверки":"Есть, необязательное") : row("na","Задание","Необязательно","assign", staffState.lessonPageTab==="assign"?"":"Добавить")) +
    row("ok","Открытие", lsDripLabel(l).replace(/^./, function(c){ return c.toUpperCase(); })) +
    (hidden ? row("no","Доступ", lsHiddenLabel(hidden).replace(/^./, function(c){ return c.toUpperCase(); }), "access", staffState.lessonPageTab==="access"?"":"Изменить") : row("ok","Доступ","Видят все врачи курса")) +
  '</div>';
}
var LP_HINTS = {
  schedule: "Дата открытия урока — для всех врачей или для выбранных. Без неё урок открывается по обычному графику курса.",
  access: "Скройте урок от конкретных врачей или от всех сразу. Прогресс, который врачи уже прошли, сохранится."
};
function renderFinalQuizQuestions(){
  var html = '<div class="lp-qhead"><div><b>Вопросы итогового теста</b><span>Врач проходит его после всех уроков — по нему выдаётся сертификат.</span></div>' +
    '<button type="button" class="btn btn-sm btn-primary" data-action="open-quiz-creator">+ Вопрос</button></div>';
  if(!(staffState.quizAdmin||[]).length) return html + '<div class="empty-state" style="padding:24px 10px;">Вопросов пока нет.</div>';
  staffState.quizAdmin.forEach(function(q, i){
    var qIsFirst = i===0, qIsLast = i===staffState.quizAdmin.length-1;
    html += '<div class="adm-row" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
      '<div style="display:flex;flex-direction:column;gap:2px;">' +
        '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-quiz-question" data-id="'+q.id+'" data-dir="up"'+(qIsFirst?' disabled':'')+' title="Выше">↑</button>' +
        '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-quiz-question" data-id="'+q.id+'" data-dir="down"'+(qIsLast?' disabled':'')+' title="Ниже">↓</button></div>' +
      '<div style="flex:1;min-width:0;"><b style="font-size:14px;display:block;">'+(i+1)+'. '+escapeHtml(q.question)+'</b><span style="font-size:12px;color:var(--muted);">'+describeQuizQuestion(q)+'</span></div>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-quiz-editor" data-id="'+q.id+'">Редактировать</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="delete-quiz-question" data-id="'+q.id+'" title="Удалить вопрос">'+icon("trash","ic-sm")+'</button></div>';
  });
  return html;
}
function renderLessonPage(){
  var id = staffState.lessonPageId, isQuiz = id==="quiz", admin = isAdminRole();
  var list = lsLessons(), idx = isQuiz ? -1 : list.findIndex(function(x){ return x.id===id; }), l = idx>=0 ? list[idx] : null;
  if(!isQuiz && !l){ staffState.lessonPageId = null; lpCloseEditors(); return renderLessonsTab(); }
  var tabs = lpTabs(), tab = staffState.lessonPageTab;
  if(!tabs.some(function(t){ return t[0]===tab; })){ tab = tabs[0][0]; staffState.lessonPageTab = tab; }
  var prev = !isQuiz && idx>0 ? list[idx-1] : null, next = !isQuiz && idx<list.length-1 ? list[idx+1] : null;

  var head = '<div class="lp-crumbs"><button type="button" class="link-btn" data-action="close-lesson-page">← Уроки</button>' +
      (l && l.module_title ? '<span>/</span><span>'+escapeHtml(l.module_title)+'</span>' : '') +
      '<span>/</span><b>'+(isQuiz ? 'Итоговый тест' : 'Урок '+(idx+1)+' из '+list.length)+'</b></div>' +
    '<div class="lp-head"><div class="lp-head-main"><h1 class="lp-title">'+escapeHtml(isQuiz ? "Итоговый тест курса" : l.title)+'</h1>' +
      (l ? '<div class="ls-chips">'+lsChips(l)+(l.duration?lsPill("",l.duration):'')+'</div>' : '') + '</div>' +
      '<div class="lp-head-acts">' +
        (!isQuiz ? '<button type="button" class="btn btn-ghost lp-nav" data-action="lesson-page-go" data-id="'+(prev?prev.id:'')+'"'+(prev?'':' disabled')+' title="Предыдущий урок">←</button>' +
          '<button type="button" class="btn btn-ghost lp-nav" data-action="lesson-page-go" data-id="'+(next?next.id:'')+'"'+(next?'':' disabled')+' title="Следующий урок">→</button>' +
          '<button type="button" class="btn btn-ghost" data-action="open-course-preview" data-idx="'+idx+'">'+icon("eye","ic-sm")+'Как видит врач</button>' : '') +
        (admin && !isQuiz ? lsMenu("lp:"+id, [["delete-lesson","Удалить урок","trash",' data-id="'+id+'" data-title="'+escapeHtml(l.title)+'"',"danger"]]) : '') +
      '</div></div>';

  function badge(t){
    if(isQuiz || !l) return t[0]==="questions" && admin ? ' <i class="lp-badge">'+(staffState.quizAdmin||[]).length+'</i>' : '';
    if(t[0]==="video") return lpHasVideo(l) ? '' : ' <i class="lp-badge warn">нет</i>';
    if(t[0]==="quiz"){ var qc = lpQuizCount(l); return ' <i class="lp-badge'+(qc?'':' warn')+'">'+(qc||'нет')+'</i>'; }
    if(t[0]==="assign") return l.assignment_prompt ? ' <i class="lp-badge">есть</i>' : '';
    if(t[0]==="access"){ var h = (courseVisibility[l.id]||[]).length; return h ? ' <i class="lp-badge warn">скрыт · '+h+'</i>' : ''; }
    return '';
  }
  var tabsHtml = '<div class="tabs lp-tabs">' + tabs.map(function(t){
    return '<button type="button" class="tab'+(t[0]===tab?' active':'')+'" data-action="lesson-page-tab" data-tab="'+t[0]+'">'+t[1]+badge(t)+'</button>';
  }).join('') + '</div>';

  // Материал, видео, тест и задание — рядом предпросмотр «так врач увидит»; на
  // расписании и доступе — готовность урока (там предпросматривать нечего).
  var withPrev = ["content","video","quiz","assign","questions"].indexOf(tab)!==-1 && (tab!=="content" || lessonEditor.loaded);
  var side = withPrev ? docPreview(lpPreviewHtml(tab), tab==="quiz"||tab==="questions" ? "можно пройти — ответы не сохраняются" : "обновляется, пока вы правите") : (admin && l ? lpReadiness(l) : '');
  var wrap = el('<div class="lp-page">'+head+tabsHtml+'<div class="lp-grid'+(withPrev ? ' with-prev' : (admin && l ? '' : ' single'))+'"><div class="card lp-panel"></div>'+side+'</div></div>');
  var panel = wrap.querySelector(".lp-panel");
  if(LP_HINTS[tab]) panel.appendChild(el('<p class="lp-hint">'+(isQuiz && tab==="access" ? 'Скройте итоговый тест от конкретных врачей или от всех сразу.' : LP_HINTS[tab])+'</p>'));
  if(tab==="questions"){
    panel.appendChild(el('<div>'+renderFinalQuizQuestions()+'</div>'));
  } else if(!lpEnsure(tab) || (tab==="quiz" && !lessonQuizManager.loaded) || (tab==="content" && !lessonEditor.loaded)){
    panel.appendChild(el('<div class="empty-state" style="padding:30px 10px;">Загрузка…</div>'));
  } else {
    var node = tab==="content" ? renderLessonEditorModal() : tab==="video" ? renderVideoEditorModal() : tab==="quiz" ? renderLessonQuizManagerDrawer()
      : tab==="assign" ? renderAssignEditorModal() : tab==="schedule" ? renderScheduleModal() : renderMaterialsPickerModal();
    panel.appendChild(lpInline(node));
  }
  return wrap;
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
        '<span style="font-size:14px;font-weight:600;">Скрыть от всех врачей</span></label>' +
      '<input class="input" id="materialsPickerSearch" placeholder="Поиск по имени, email или телефону" value="'+escapeHtml(materialsPicker.search)+'" style="margin-bottom:12px;">' +
      '<div style="max-height:320px;overflow-y:auto;">';
  if(!students.length){
    body += '<div class="empty-state" style="padding:24px 10px;">Никого не нашлось.</div>';
  } else {
    students.forEach(function(s){
      var checked = materialsPicker.selectedIds.indexOf(s.id)!==-1;
      body += '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--line-2);cursor:pointer;">' +
        '<input type="checkbox" data-action="toggle-picker-student" data-id="'+s.id+'"'+(checked?' checked':'')+'>' +
        userAvatar(s,null,'width:26px;height:26px;font-size:11px;') +
        '<div style="flex:1;"><b style="font-size:14px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:12px;color:var(--muted);">'+escapeHtml(s.email||s.phone||"—")+'</span></div></label>';
    });
  }
  body += '</div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">' +
    '<span style="font-size:13px;color:var(--muted);">Выбрано: '+materialsPicker.selectedIds.length+'</span>' +
    '<button class="btn btn-primary" data-action="apply-materials-picker">Сохранить</button></div></div>';

  return el('<div class="overlay" data-action="overlay-close-materials"><div class="drawer" data-stop="1" style="width:min(440px,100%);">'+body+'</div></div>');
}

// Куратор назначает дату открытия урока — конкретным врачам или всем сразу
// (в своём скоупе). Список ниже показывает, у кого уже есть переопределение,
// а у кого урок идёт по обычному дрипу.
function renderScheduleModal(){
  var q = scheduleModal.search.toLowerCase();
  var students = staffState.students.filter(function(s){
    if(!q) return true;
    return (s.name||"").toLowerCase().indexOf(q)!==-1 || (s.email||"").toLowerCase().indexOf(q)!==-1;
  });
  var scheduleByStudent = {};
  scheduleModal.schedule.forEach(function(r){ scheduleByStudent[r.student_id]=r.unlock_at; });

  var body = '<div class="drawer-head"><b style="font-size:16px;">Расписание урока «'+escapeHtml(scheduleModal.lessonTitle)+'»</b><button class="btn btn-ghost btn-sm" data-action="close-schedule-modal">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<div class="field"><label>Дата открытия</label><input class="input" type="date" id="scheduleUnlockDate" value="'+escapeHtml(scheduleModal.unlockDate)+'"></div>' +
      '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-s);margin-bottom:14px;cursor:pointer;background:var(--primary-tint);">' +
        '<input type="checkbox" data-action="toggle-schedule-all"'+(scheduleModal.applyToAll?' checked':'')+'>' +
        '<span style="font-size:14px;font-weight:600;">Применить ко всем врачам</span></label>' +
      (!scheduleModal.applyToAll ?
        '<input class="input" id="scheduleSearch" placeholder="Поиск по имени или email" value="'+escapeHtml(scheduleModal.search)+'" style="margin-bottom:12px;">' +
        '<div style="max-height:220px;overflow-y:auto;margin-bottom:14px;">' +
        (students.length ? students.map(function(s){
          var checked = scheduleModal.selectedIds.indexOf(s.id)!==-1;
          var current = scheduleByStudent[s.id];
          return '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--line-2);cursor:pointer;">' +
            '<input type="checkbox" data-action="toggle-schedule-student" data-id="'+s.id+'"'+(checked?' checked':'')+'>' +
            userAvatar(s,null,'width:26px;height:26px;font-size:11px;') +
            '<div style="flex:1;"><b style="font-size:14px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:12px;color:var(--muted);">'+(current?'открыт с '+fmtDate(current):'по дрипу')+'</span></div></label>';
        }).join('') : '<div class="empty-state" style="padding:24px 10px;">Никого не нашлось.</div>') +
        '</div>'
      : '<p class="hint" style="margin-top:-6px;">Затронет всех врачей в вашей зоне ответственности ('+staffState.students.length+').</p>') +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="btn btn-primary" data-action="apply-schedule">Назначить дату</button>' +
        '<button class="btn btn-ghost" data-action="clear-schedule">Сбросить на автоматический дрип</button>' +
      '</div>' +
    '</div>';
  return el('<div class="overlay" data-action="overlay-close-schedule"><div class="drawer" data-stop="1" style="width:min(460px,100%);">'+body+'</div></div>');
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

function specNames(s){ return (s.specializations||[]).join(", "); }

function distinctSpecializations(){
  var set = {};
  staffState.students.forEach(function(s){ (s.specializations||[]).forEach(function(v){ if(v) set[v]=true; }); });
  return Object.keys(set).sort();
}

function computeFilteredStudents(){
  return staffState.students.filter(function(s){
    var regDate = (s.created_at||"").slice(0,10);
    if(dashboardState.periodFrom && regDate && regDate < dashboardState.periodFrom) return false;
    if(dashboardState.periodTo && regDate && regDate > dashboardState.periodTo) return false;
    if(dashboardState.specializations.length && !(s.specializations||[]).some(function(v){ return dashboardState.specializations.indexOf(v)!==-1; })) return false;
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
      s.name||"", (s.specializations||[]).join(", "), s.email||"", s.phone||"",
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

/* ---------------- Аналитика дашборда: тренд регистраций, воронка, поурочный отсев, ответы теста ---------------- */
// Все три блока считаются из УЖЕ отфильтрованного computeFilteredStudents() —
// те же фильтры дашборда (период, поток, куратор и т.д.) автоматически
// применяются и к графикам, без отдельной второй системы фильтрации.
function analyticsRegistrationsByDay(filtered){
  var toDate = dashboardState.periodTo ? new Date(dashboardState.periodTo+"T00:00:00") : new Date();
  var fromDate = dashboardState.periodFrom ? new Date(dashboardState.periodFrom+"T00:00:00") : new Date(toDate.getTime()-29*86400000);
  var days = Math.max(1, Math.round((toDate-fromDate)/86400000)+1);
  var weekly = days > 45;
  var buckets = {}, order = [], members = {};
  if(!weekly){
    for(var i=0;i<days;i++){ var key=isoDate(new Date(fromDate.getTime()+i*86400000)); buckets[key]=0; order.push(key); }
  } else {
    var d0=new Date(fromDate.getTime()); var dow=(d0.getDay()+6)%7; d0.setDate(d0.getDate()-dow);
    for(var wd=new Date(d0.getTime()); wd<=toDate; wd.setDate(wd.getDate()+7)){ var key2=isoDate(wd); buckets[key2]=0; order.push(key2); }
  }
  filtered.forEach(function(s){
    var regDate=(s.created_at||"").slice(0,10);
    if(!regDate) return;
    var d=new Date(regDate+"T00:00:00");
    if(d<fromDate || d>toDate) return;
    var key;
    if(!weekly) key=regDate;
    else{ var dd=new Date(d.getTime()); var dow2=(dd.getDay()+6)%7; dd.setDate(dd.getDate()-dow2); key=isoDate(dd); }
    if(buckets[key]!==undefined){ buckets[key]++; (members[key] = members[key] || []).push(s); }
  });
  return { weekly:weekly, labels:order, counts:order.map(function(k){ return buckets[k]; }), members:members };
}

function analyticsFunnel(filtered){
  var registered = filtered.length;
  var started = filtered.filter(function(s){ return (s.completed_lessons||[]).length>0; }).length;
  var completedDemo = filtered.filter(function(s){ return !!s.completed; }).length;
  var certified = filtered.filter(function(s){ return s.certificate_status==="issued"; }).length;
  return [
    { label:"Зарегистрировались", count:registered },
    { label:"Начали курс", count:started },
    { label:"Прошли демо-курс", count:completedDemo },
    { label:"Получили сертификат", count:certified }
  ];
}

function analyticsLessonDropoff(filtered){
  return staffState.materials.map(function(l,idx){
    var reached = filtered.filter(function(s){ return (s.completed_lessons||[]).length > idx; }).length;
    return { label:(idx+1)+". "+l.title, count:reached };
  });
}

// Только admin/super_admin — только они видят правильные ответы (staffState.quizAdmin),
// без которых нельзя определить верно/неверно ответил врач.
function analyticsQuizStats(filtered){
  if(!staffState.quizAdmin || !staffState.quizAdmin.length) return [];
  return staffState.quizAdmin.map(function(q,idx){
    var correct=0, incorrect=0;
    filtered.forEach(function(s){
      var answers=s.quiz_answers;
      if(!answers || answers[q.id]===undefined || answers[q.id]===null) return;
      // Балл по вопросу считает сервер (у новых типов ответ — не номер варианта);
      // для старых попыток без quiz_results — прежнее сравнение с номером.
      var res = s.quiz_results && s.quiz_results[q.id];
      var ok = typeof res==="number" ? res>=0.999 : answers[q.id]===q.correct;
      if(ok) correct++; else incorrect++;
    });
    return { idx:idx, question:q.question, correct:correct, incorrect:incorrect };
  });
}

function renderVBarChart(labels, counts, weekly, selectedKey){
  var max = Math.max.apply(null, counts.concat([1]));
  var html = '<div class="chart-vbars'+(selectedKey?' has-sel':'')+'">';
  counts.forEach(function(c,i){
    var h = Math.round((c/max)*100);
    // Вся колонка кликабельна (а не только сам столбик — он бывает в 2px высотой).
    html += '<div class="chart-vbar-col'+(labels[i]===selectedKey?' sel':'')+'" data-action="reg-bar-select" data-key="'+labels[i]+'" title="'+escapeHtml(fmtDate(labels[i]))+(weekly?' (неделя)':'')+': '+c+'">' +
      '<div class="chart-vbar" style="height:'+(h||1)+'%;"></div></div>';
  });
  html += '</div>';
  // Абсолютное позиционирование вместо ячейки-на-колонку: при 30+ узких столбцах
  // flex-ячейка шириной с саму колонку обрезала бы дату по text-overflow задолго
  // до того, как текст реально перестал бы помещаться — так подпись не зависит
  // от ширины своей колонки и не режется, сколько бы баров ни было.
  var maxLabels = Math.min(labels.length, 6);
  var shownIdx = [];
  for(var k=0;k<maxLabels;k++){ shownIdx.push(Math.round(k*(labels.length-1)/Math.max(1,maxLabels-1))); }
  shownIdx = shownIdx.filter(function(v,i,arr){ return arr.indexOf(v)===i; });
  html += '<div class="chart-vbar-labels">';
  shownIdx.forEach(function(i){
    var pct = ((i+0.5)/labels.length)*100;
    var text = new Date(labels[i]+"T00:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"short"});
    html += '<div class="chart-vbar-label-abs" style="left:'+pct+'%;">'+escapeHtml(text)+'</div>';
  });
  html += '</div>';
  return html;
}

function renderHBarChart(items){
  var max = Math.max.apply(null, items.map(function(x){ return x.count; }).concat([1]));
  var html = '<div class="chart-hbars">';
  items.forEach(function(it){
    var w = Math.round((it.count/max)*100);
    var pct = items[0].count ? Math.round((it.count/items[0].count)*100) : 0;
    html += '<div class="chart-hbar-row">' +
      '<div class="chart-hbar-name" title="'+escapeHtml(it.label)+'">'+escapeHtml(it.label)+'</div>' +
      '<div class="chart-hbar-track"><div class="chart-hbar-fill" style="width:'+(w||1)+'%;" title="'+escapeHtml(it.label)+': '+it.count+'"></div></div>' +
      '<div class="chart-hbar-value">'+it.count+' · '+pct+'%</div>' +
    '</div>';
  });
  html += '</div>';
  return html;
}

function renderQuizStackChart(stats){
  if(!stats.length) return '<div class="empty-state" style="padding:24px 10px;">Вопросов пока нет.</div>';
  var html = '<div class="chart-legend">' +
    '<div class="chart-legend-item"><span class="chart-legend-swatch" style="background:var(--status-active);"></span>Верно</div>' +
    '<div class="chart-legend-item"><span class="chart-legend-swatch" style="background:var(--status-blocked);"></span>Неверно</div>' +
  '</div>';
  stats.forEach(function(st){
    var total = st.correct + st.incorrect;
    var correctPct = total ? Math.round((st.correct/total)*100) : 0;
    var caption = total ? (st.correct+' из '+total+' верно ('+correctPct+'%)'+(st.incorrect?' · '+st.incorrect+' ошиблись':'')) : 'Никто ещё не отвечал';
    html += '<div class="chart-stack-row">' +
      '<span class="chart-stack-q">'+(st.idx+1)+'. '+escapeHtml(st.question)+'</span>' +
      '<div class="chart-stack">' +
        (st.correct ? '<div class="chart-stack-seg correct" style="flex:'+st.correct+';" title="Верно: '+st.correct+'"></div>' : '') +
        (st.incorrect ? '<div class="chart-stack-seg incorrect" style="flex:'+st.incorrect+';" title="Неверно: '+st.incorrect+'"></div>' : '') +
      '</div>' +
      '<span class="chart-stack-caption">'+caption+'</span>' +
    '</div>';
  });
  return html;
}

// Кто зарегистрировался в выбранный день/неделю (клик по столбцу «Регистрации»).
function renderRegBarDetail(reg){
  var key = dashboardState.regBarKey;
  if(!key || reg.labels.indexOf(key)===-1) return '';
  var list = (reg.members[key]||[]).slice().sort(function(a,b){ return (b.created_at||"").localeCompare(a.created_at||""); });
  var d = new Date(key+"T00:00:00"), title;
  if(reg.weekly){ var e = new Date(d.getTime()+6*86400000); title = "Неделя "+d.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})+" – "+e.toLocaleDateString("ru-RU",{day:"numeric",month:"short"}); }
  else title = d.toLocaleDateString("ru-RU",{weekday:"short",day:"numeric",month:"long"});
  var n = list.length, word = n%10===1&&n%100!==11 ? "врач" : (n%10>=2&&n%10<=4&&(n%100<10||n%100>=20) ? "врача" : "врачей");
  var h = '<div class="reg-detail"><div class="reg-detail-head"><b>'+escapeHtml(title)+'</b><span>'+n+' '+word+'</span>' +
    '<button class="btn btn-sm btn-ghost" data-action="reg-bar-select" data-key="'+key+'" title="Закрыть">✕</button></div>';
  if(!n){ h += '<p class="reg-detail-empty">В этот '+(reg.weekly?'период':'день')+' никто не зарегистрировался.</p></div>'; return h; }
  list.forEach(function(st){
    var stream = st.stream_id ? calendarState.streams.find(function(x){ return x.id===st.stream_id; }) : null;
    var sub = [specNames(st), stream ? stream.name : "без потока"].filter(Boolean).join(" · ");
    h += '<div class="reg-detail-row" data-action="open-student" data-id="'+st.id+'">' +
      userAvatar(st) +
      '<div class="reg-detail-who"><b>'+escapeHtml(st.name)+'</b><small>'+escapeHtml(sub)+'</small></div>' +
      '<span class="reg-detail-meta">'+escapeHtml(STAGE_LABELS[studentStage(st)]||"")+' · '+(st.completed_lessons||[]).length+' ур.</span>' +
      '<span class="reg-detail-open">Открыть →</span></div>';
  });
  return h + '</div>';
}

function renderAnalyticsSection(filtered){
  var reg = analyticsRegistrationsByDay(filtered);
  var funnel = analyticsFunnel(filtered);
  var dropoff = analyticsLessonDropoff(filtered);
  var quizStats = (me.role==="admin"||me.role==="super_admin") ? analyticsQuizStats(filtered) : null;
  var regTotal = reg.counts.reduce(function(a,b){ return a+b; }, 0);

  var html = '<div class="chart-grid">';
  html += '<div class="card chart-card">' +
    '<b class="chart-card-title">Регистрации '+(reg.weekly?'по неделям':'по дням')+'</b>' +
    '<p class="chart-card-sub">Всего за период: '+regTotal+' · нажмите на столбец, чтобы увидеть врачей</p>' +
    renderVBarChart(reg.labels, reg.counts, reg.weekly, reg.labels.indexOf(dashboardState.regBarKey)!==-1 ? dashboardState.regBarKey : null) +
    renderRegBarDetail(reg) +
  '</div>';
  html += '<div class="card chart-card">' +
    '<b class="chart-card-title">Воронка</b>' +
    '<p class="chart-card-sub">От регистрации до сертификата</p>' +
    renderHBarChart(funnel) +
  '</div>';
  html += '</div>';

  // Без вопросов теста (не admin/super_admin) второй график остаётся один —
  // тогда сетку в 2 колонки не открываем вовсе, а не оставляем пустую половину.
  html += quizStats ? '<div class="chart-grid">' : '<div style="margin-bottom:16px;">';
  html += '<div class="card chart-card">' +
    '<b class="chart-card-title">Отсев по урокам</b>' +
    '<p class="chart-card-sub">Сколько врачей дошло хотя бы до этого урока</p>' +
    (dropoff.length ? renderHBarChart(dropoff) : '<div class="empty-state" style="padding:24px 10px;">Уроков пока нет.</div>') +
  '</div>';
  if(quizStats){
    html += '<div class="card chart-card">' +
      '<b class="chart-card-title">Ответы на вопросы теста</b>' +
      '<p class="chart-card-sub">Какие вопросы чаще всего отвечают неверно</p>' +
      renderQuizStackChart(quizStats) +
    '</div>';
  }
  html += '</div>';
  return html;
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
      '<b style="font-size:15px;">Фильтры</b><button class="btn btn-sm btn-ghost" data-action="reset-dash-filters">Сбросить всё</button></div>';

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
  html += '</div></div>';

  html += renderAnalyticsSection(filtered);

  html += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:15px;">Найдено: '+filtered.length+' из '+staffState.students.length+'</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="export-dash-csv"'+(!filtered.length?' disabled':'')+'>Экспорт в CSV</button></div>';

  if(!filtered.length){
    html += '<div class="empty-state"><div class="big">'+icon("search","ic-lg")+'</div>Никого не нашлось по этим фильтрам.</div>';
  } else {
    // 12 колонок не помещались в карточку — правый край уезжал под рамку.
    // Специальность — под именем, продукт — под потоком, сертификат — рядом с
    // баллом теста; строка целиком кликабельна (без отдельной кнопки «Открыть»).
    html += '<div class="table-wrap"><table class="roster roster-compact"><thead><tr><th>Врач</th><th>Поток · продукт</th><th>Этап</th><th>Тест</th><th>Оплата</th><th>Доступ</th><th>Куратор</th><th>Регистрация</th></tr></thead><tbody>';
    filtered.forEach(function(s){
      var streamName = (calendarState.streams.filter(function(x){ return x.id===s.stream_id; })[0]||{}).name || "—";
      var curatorName = (directory.filter(function(c){ return c.id===s.assigned_curator_id; })[0]||{}).name || "—";
      var accessSt = accessStatusOf(s);
      var accessMagnet = accessSt==="active"?magnet("active","Активен"):(accessSt==="blocked"?magnet("blocked","Заблокирован"):magnet("attention","Истёк"));
      var stage = studentStage(s);
      var stageMagnet = magnet(stage==="certified"?"done":(stage==="demo_done"?"attention":(stage==="in_progress"?"active":"neutral")), STAGE_LABELS[stage]);
      html += '<tr class="row-link" data-action="open-student" data-id="'+s.id+'">' +
        '<td><div class="who-cell">'+userAvatar(s)+'<div><b>'+escapeHtml(s.name)+'</b><span>'+escapeHtml(specNames(s)||"—")+'</span></div></div></td>' +
        '<td class="cell-2l"><span class="ell" title="'+escapeHtml(streamName)+'">'+escapeHtml(streamName)+'</span><small>'+escapeHtml(PRODUCTS[s.product||"longevity"])+'</small></td>' +
        '<td class="nowrap">'+stageMagnet+'</td>' +
        '<td class="nowrap">'+(typeof s.quiz_score==="number"?s.quiz_score+'%':'—')+(s.certificate_status==="issued"?'<small class="sub">серт. выдан</small>':'')+'</td>' +
        '<td>'+PAYMENT_LABELS[s.payment_status||"unpaid"]+'</td>' +
        '<td class="nowrap">'+accessMagnet+'</td>' +
        '<td><span class="ell">'+escapeHtml(curatorName)+'</span></td>' +
        '<td class="nowrap" style="color:var(--muted);">'+fmtDateShort(s.created_at)+'</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div></div>';
  return el(html);
}

// Мягкий оттенок аватарки по имени — чтобы строки подряд не сливались в одинаковые
// фиолетовые кружки. Только приглушённые тинты из палитры (без красного).
var AVATAR_TONES = ["--primary","--teal","--status-attention","--status-done","--status-active"];
function avatarTone(name){
  var h = 0; String(name||"").split("").forEach(function(c){ h = (h*31 + c.charCodeAt(0)) >>> 0; });
  var v = AVATAR_TONES[h % AVATAR_TONES.length];
  return "background:color-mix(in srgb,var("+v+") 18%,transparent);color:var("+v+");";
}
function daysSince(iso){ if(!iso) return 0; return Math.floor((Date.now()-new Date(iso).getTime())/86400000); }

// Два разных сигнала «пора обратить внимание», сведённые в одну карточку сверху
// вкладки «Ученики» — кто давно не заходил и кому пора выдать сертификат.
function renderInboxCard(){
  var inbox = staffState.inbox || {inactive:[],pendingCertificates:[]};
  var total = inbox.inactive.length + inbox.pendingCertificates.length;
  if(!total) return el('<div></div>');

  var html = '<div class="card" style="padding:18px 20px;margin-bottom:20px;">' +
    '<b style="font-size:15px;display:block;margin-bottom:14px;">Требует внимания ('+total+')</b>';

  if(inbox.inactive.length){
    html += '<div class="inbox-group">'+magnet("attention","Неактивны 7+ дней");
    // Вся строка кликабельна, «Открыть» проявляется при наведении — семь одинаковых
    // кнопок подряд рябили. Дни без входа — нейтральная «таблетка» справа (без
    // красного/жёлтого: сортировка и так от самых давних).
    inbox.inactive.forEach(function(r){
      var st = (staffState.students||[]).find(function(x){ return x.id===r.id; });
      var stream = st && st.stream_id ? calendarState.streams.find(function(x){ return x.id===st.stream_id; }) : null;
      html += '<div class="inbox-row inbox-row-link" data-action="open-student" data-id="'+r.id+'">' +
        userAvatar(r) +
        '<div class="inbox-who"><b>'+escapeHtml(r.name)+'</b><small>'+escapeHtml(stream ? stream.name : "Без потока")+'</small></div>' +
        '<span class="days-pill"><b>'+daysSince(r.last_seen)+'</b> дн. без входа</span>' +
        '<button class="btn btn-sm btn-ghost" data-action="open-student" data-id="'+r.id+'">Открыть</button>' +
      '</div>';
    });
    html += '</div>';
  }
  if(inbox.pendingCertificates.length){
    html += '<div class="inbox-group">'+magnet("done","Ждут сертификат");
    inbox.pendingCertificates.forEach(function(r){
      html += '<div class="inbox-row">' +
        userAvatar(r) +
        '<div style="flex:1;"><b style="font-size:14px;display:block;">'+escapeHtml(r.name)+'</b><span style="font-size:12px;color:var(--muted);">тест: '+r.quiz_score+'%</span></div>' +
        '<button class="btn btn-sm btn-primary" data-action="issue-certificate" data-id="'+r.id+'">Выдать</button>' +
      '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
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
  // Полоса-доля под каждой цифрой — чтобы было видно, много это или мало.
  function share(n){ return total ? Math.round(n/total*100) : 0; }
  function bar(pct){ return '<div class="stat-bar"><i style="width:'+pct+'%"></i></div>'; }
  return el(
    '<div class="stat-row">' +
      '<div class="card stat"><div class="num" data-count="'+total+'">'+total+'</div><div class="lbl">Врачей зарегистрировано</div>'+bar(total?100:0)+'</div>' +
      '<div class="card stat"><div class="num" data-count="'+inProgress+'">'+inProgress+'</div><div class="lbl">Проходят курс сейчас'+(total?' · <b>'+share(inProgress)+'%</b>':'')+'</div>'+bar(share(inProgress))+'</div>' +
      '<div class="card stat"><div class="num" data-count="'+completed+'">'+completed+'</div><div class="lbl">Завершили демо-курс'+(total?' · <b>'+share(completed)+'%</b>':'')+'</div>'+bar(share(completed))+'</div>' +
      '<div class="card stat"><div class="num"'+(avg===null?'':' data-count="'+avg+'" data-suffix="%"')+'>'+(avg===null?'—':avg+'%')+'</div><div class="lbl">Средний балл теста</div>'+bar(avg||0)+'</div>' +
    '</div>'
  );
}

function renderCertificateQueue(){
  // Пока курс демо-версии (certificatesEnabled=false) — сертификаты не выдаются
  // никому, и этой очереди попросту не должно быть: иначе каждый прошедший демо-курс
  // врач вечно висел бы тут "в очереди", хотя выдавать ему на самом деле нечего.
  if(!staffState.certificatesEnabled) return el('<div></div>');
  var pending = staffState.students.filter(function(s){ return s.completed && s.certificate_status!=="issued"; });
  if(!pending.length) return el('<div></div>');
  var pendingIds = pending.map(function(s){ return s.id; });
  var selected = staffState.certSelectedIds.filter(function(id){ return pendingIds.indexOf(id)!==-1; });
  var allSelected = selected.length>0 && selected.length===pending.length;
  var html = '<div class="card" style="padding:18px 20px;margin-bottom:20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;cursor:pointer;">' +
        '<input type="checkbox" data-action="toggle-cert-select-all"'+(allSelected?' checked':'')+' style="accent-color:var(--primary);">Очередь сертификатов</label>' +
      (selected.length ? '<button class="btn btn-sm btn-primary" data-action="bulk-issue-certificates">Выдать выбранным ('+selected.length+')</button>' : '') +
    '</div>';
  pending.forEach(function(s){
    var checked = selected.indexOf(s.id)!==-1;
    html += '<div class="adm-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-2);">' +
      '<input type="checkbox" data-action="toggle-cert-select" data-id="'+s.id+'"'+(checked?' checked':'')+' style="accent-color:var(--primary);">' +
      userAvatar(s) +
      '<div style="flex:1;"><b style="font-size:14px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:12px;color:var(--muted);">тест: '+s.quiz_score+'%</span></div>' +
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
    return (s.name||"").toLowerCase().indexOf(q)!==-1 || specNames(s).toLowerCase().indexOf(q)!==-1 ||
      (s.email||"").toLowerCase().indexOf(q)!==-1 || (s.phone||"").toLowerCase().indexOf(q)!==-1;
  });
  var visibleIds = students.map(function(s){ return s.id; });
  var selected = staffState.selectedIds.filter(function(id){ return visibleIds.indexOf(id)!==-1; });
  var allSelected = students.length>0 && selected.length===students.length;

  var html = '<div class="card" style="padding:18px 18px 6px;">' +
    '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;"><input class="input" id="rosterSearch" placeholder="Поиск по имени, специализации, email или телефону" value="'+escapeHtml(staffState.search)+'" style="max-width:320px;">' +
    '<button class="btn btn-sm btn-ghost" data-action="toggle-invite-student">'+(staffState.showInviteStudent?'Скрыть':'+ Пригласить врача')+'</button>' +
    '<button class="btn btn-sm btn-ghost" data-action="toggle-import-students">'+(staffState.showImportStudents?'Скрыть импорт':'Импорт из CSV')+'</button>' +
    '<a class="btn btn-sm btn-ghost" href="api/staff/students/export.csv?courseId='+encodeURIComponent(staffState.activeCourseId||"")+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+' Экспорт CSV</a>' +
    '<a class="btn btn-sm btn-ghost" href="api/staff/leads/export.csv?courseId='+encodeURIComponent(staffState.activeCourseId||"")+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+' Экспорт заявок</a>' +
    '<button class="btn btn-sm btn-ghost" data-action="open-course-preview">'+icon("eye","ic-sm")+' Просмотреть как врач</button></div>';

  if(staffState.showImportStudents){
    html += '<div class="card" style="padding:14px 16px;margin-bottom:16px;background:var(--surface-2);">' +
      '<b style="font-size:14px;display:block;margin-bottom:6px;">Массовый импорт врачей</b>' +
      '<p style="font-size:13px;color:var(--muted);margin:0 0 10px;">CSV с заголовком: Имя, Email, Телефон, Место работы, Специализация, Поток (последние три необязательны). Записывает сразу на курс «'+escapeHtml((staffState.coursesList.find(function(c){return c.id===staffState.activeCourseId;})||{}).title||"")+'» — переключите курс сверху, если нужен другой.</p>' +
      '<form id="importStudentsForm" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        '<input class="input" type="file" name="file" accept=".csv,.txt" required style="max-width:360px;flex:1;">' +
        '<button class="btn btn-sm btn-primary" type="submit">Загрузить</button>' +
      '</form>';
    if(staffState.importResult){
      var ir = staffState.importResult;
      html += '<div style="margin-top:12px;font-size:13px;"><b>Создано: '+ir.created.length+'</b>'+(ir.skipped.length?' · <b>Пропущено: '+ir.skipped.length+'</b>':'')+'</div>';
      if(ir.created.length){
        html += '<div style="overflow-x:auto;margin-top:8px;"><table class="roster"><thead><tr><th>Имя</th><th>Email</th><th>Временный пароль</th></tr></thead><tbody>';
        ir.created.forEach(function(c){
          html += '<tr><td>'+escapeHtml(c.name)+'</td><td>'+escapeHtml(c.email)+'</td><td style="font-family:monospace;">'+escapeHtml(c.tempPassword)+'</td></tr>';
        });
        html += '</tbody></table></div><p class="hint">Сохраните пароли сейчас — повторно они не показываются, только через «Сбросить пароль».</p>';
      }
      if(ir.skipped.length){
        html += '<div style="margin-top:8px;">'+ir.skipped.map(function(s){ return '<div style="font-size:13px;color:var(--muted);">Строка '+s.row+' ('+escapeHtml(s.email||"—")+'): '+escapeHtml(s.reason)+'</div>'; }).join("")+'</div>';
      }
    }
    html += '</div>';
  }

  if(staffState.showInviteStudent){
    html += '<div class="tabs" style="margin-bottom:14px;">' +
      '<button type="button" class="tab'+(staffState.inviteMode!=="bulk"?' active':'')+'" data-action="invite-mode" data-mode="single">Один email</button>' +
      '<button type="button" class="tab'+(staffState.inviteMode==="bulk"?' active':'')+'" data-action="invite-mode" data-mode="bulk">Список / CSV</button>' +
    '</div>';
    if(staffState.inviteMode==="bulk"){
      html += '<form id="inviteBulkForm" style="margin-bottom:16px;">' +
        '<div class="field"><label>Список email (по одному в строке, или вставьте из Excel/CSV)</label>' +
        '<textarea class="input" name="emails" required style="height:110px;font-family:monospace;font-size:13px;" placeholder="doctor1@clinic.ru&#10;doctor2@clinic.ru&#10;doctor3@clinic.ru"></textarea></div>' +
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
      '<b style="font-size:14px;color:var(--primary-dark);">Выбрано: '+selected.length+'</b>' +
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
    html += '<div style="overflow-x:auto;"><table class="roster"><thead><tr><th style="width:32px;"><input type="checkbox" data-action="select-all-students"'+(allSelected?' checked':'')+'></th><th>Врач</th><th>Прогресс</th><th>Тест</th><th>Статус</th><th>Поток</th><th>Была в сети</th><th>Регистрация</th><th></th></tr></thead><tbody>';
    students.forEach(function(s){
      var done = (s.completed_lessons||[]).length;
      var isChecked = staffState.selectedIds.indexOf(s.id)!==-1;
      var status = s.completed ? magnet("done","Завершил") : (done>0 ? magnet("active","В процессе") : magnet("neutral","Новый"));
      html += '<tr>' +
        '<td><input type="checkbox" data-action="select-student" data-id="'+s.id+'"'+(isChecked?' checked':'')+'></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;"><div class="who-cell"><div class="avatar-wrap">'+userAvatar(s)+''+(s.online?'<span class="presence-dot" title="Онлайн"></span>':'')+'</div><div><b>'+escapeHtml(s.name)+'</b><span>'+escapeHtml(specNames(s)||"—")+'</span></div></div></td>' +
        '<td class="nowrap" data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+done+'/'+((staffState.materials||[]).length||5)+'</td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+(typeof s.quiz_score==="number"?s.quiz_score+'%':'—')+'</td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+status+'</td>' +
        '<td><select class="input" style="font-size:13px;padding:5px 8px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" data-stream-select data-id="'+s.id+'">'+buildStreamOptions(s.stream_id||"", "Без потока")+'</select></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+(s.online?magnet("active","В сети"):'<span style="color:var(--muted);font-size:13px;">'+escapeHtml(timeSince(s.last_seen_at))+'</span>')+'</td>' +
        '<td class="nowrap" style="color:var(--muted);">'+fmtDateShort(s.created_at)+'</td>' +
        '<td class="nowrap" style="text-align:right;"><button class="btn btn-sm btn-ghost row-open" data-action="open-student" data-id="'+s.id+'">Открыть →</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  return el(html);
}

// Перенос урока: рядом с другим уроком (where = before/after, модуль — как у
// него) или в конец секции модуля (where = into, moduleId; "" — без модуля).
// Порядок и модуль — через те же запросы, что и раньше (reorder и PUT module).
async function lsApplyMove(lessonId, targetId, where, moduleId){
  var prev = lsLessons().slice(), arr = prev.slice();
  var from = arr.findIndex(function(x){ return x.id===lessonId; });
  if(from===-1) return;
  var item = Object.assign({}, arr[from]);
  arr.splice(from, 1);
  var newModule, pos;
  if(where==="into"){
    newModule = moduleId || null;
    var lastIdx = -1;
    arr.forEach(function(x, i){ if((x.module_id||null)===newModule) lastIdx = i; });
    pos = lastIdx===-1 ? arr.length : lastIdx+1;
  } else {
    var ti = arr.findIndex(function(x){ return x.id===targetId; });
    if(ti===-1) return;
    newModule = arr[ti].module_id || null;
    pos = where==="before" ? ti : ti+1;
  }
  var modChanged = (item.module_id||null)!==newModule;
  if(modChanged){
    item.module_id = newModule;
    var mm = (moduleManagerState.modules||[]).find(function(m){ return m.id===newModule; });
    item.module_title = mm ? mm.title : null;
  }
  arr.splice(pos, 0, item);
  var orderChanged = arr.some(function(x, i){ return x.id!==prev[i].id; });
  if(!orderChanged && !modChanged){ render(); return; }
  staffState.materials = arr;
  render();
  try{
    if(modChanged) await api("/course/lessons/"+lessonId+"/module", { method:"PUT", body: JSON.stringify({ moduleId: newModule }) });
    if(orderChanged) await api("/course/lessons/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: arr.map(function(x){ return x.id; }) }) });
    if(modChanged){
      showToast(newModule ? "Урок перенесён в модуль «"+(item.module_title||"")+"»" : "Урок убран из модуля");
      try{ var mods = await api("/course/modules?courseId="+encodeURIComponent(staffState.activeCourseId)); moduleManagerState.modules = mods.modules; moduleManagerState.allLessons = mods.allLessons; }catch(e){}
    }
  }catch(err){
    staffState.materials = prev; showToast(err.message);
  }
  render();
}

/* ============================= РЕНДЕР: ТЕРМИНЫ (куратор и админ) ============================= */
// Раздел «Обучение → Термины»: глоссарий курса. Список сгруппирован по урокам, у
// каждого термина видно, подсвечивается ли он (нашлось ли написание в тексте урока).
// Страница термина — форма из понятных блоков (всё, кроме названия и написаний,
// необязательно) и рядом живой предпросмотр «так увидит врач»; написания
// проверяются по текстам уроков прямо во время ввода.
var glossaryAdmin = { list:[], loaded:false, loading:false, courseId:null, q:"", edit:null, dirty:false, tab:"brief", check:null, checkTimer:null };
var GL_ICON_CHOICES = [["check","Галочка"],["clipboard","Опросник"],["search","Анализ"],["calendar","Срок / график"],["users","Консультация"],["doctor","Врач"],["task","Задача"],["star","Важно"],["book","Материал"],["chartbar","Показатель"],["bell","Напоминание"]];
var GL_TONE_CHOICES = [["ok","Норма"],["warn","Внимание"],["bad","Опасно"]];

function glAdminLoad(){
  var cid = staffState.activeCourseId;
  if(!cid || glossaryAdmin.loading) return Promise.resolve();
  glossaryAdmin.loading = true;
  return api("/glossary/admin?courseId="+encodeURIComponent(cid)).then(function(d){
    glossaryAdmin.list = d.terms || []; glossaryAdmin.loaded = true; glossaryAdmin.courseId = cid; glossaryAdmin.loading = false;
  }, function(e){ glossaryAdmin.loading = false; glossaryAdmin.loaded = true; glossaryAdmin.courseId = cid; showToast(e.message); });
}
function glLessonLabel(id){
  var list = lsLessons(), i = list.findIndex(function(l){ return l.id===id; });
  return i===-1 ? null : { n:i+1, title:list[i].title };
}
function glFoundText(found, homeId){
  if(!found || !found.length) return { kind:"warn", text:"не найден в тексте уроков — проверьте написания" };
  var names = found.map(function(id){ var l = glLessonLabel(id); return l ? "уроке "+l.n : null; }).filter(Boolean);
  var inHome = homeId && found.indexOf(homeId)!==-1;
  if(homeId && !inHome) return { kind:"warn", text:"в своём уроке не найден · есть в "+names.join(", ") };
  return { kind:"ok", text:"подсвечивается в "+names.join(", ") };
}
function renderGlossaryAdminTab(){
  if(!glossaryAdmin.loaded || glossaryAdmin.courseId!==staffState.activeCourseId){
    glAdminLoad().then(render);
    return el('<div class="card empty-state" style="padding:36px 16px;">Загрузка терминов…</div>');
  }
  if(glossaryAdmin.edit) return renderGlossaryTermPage();
  var q = glossaryAdmin.q.trim().toLowerCase(), all = glossaryAdmin.list;
  var list = q ? all.filter(function(t){ return (t.title+" "+t.category+" "+(t.aliases||[]).join(" ")).toLowerCase().indexOf(q)!==-1; }) : all;
  var html = '<div class="ls-page"><div class="ls-bar"><p class="ls-sub">Термины подсвечиваются в тексте уроков — врач нажимает на слово и читает короткую статью. В своём уроке термин подсвечен всегда, в остальных — пока врач его ещё не открывал.</p>' +
    '<div class="ls-actions"><label class="ls-search">'+icon("search","ic-sm")+'<input id="glossarySearchInput" placeholder="Найти термин" value="'+escapeHtml(glossaryAdmin.q)+'" autocomplete="off"></label>' +
    '<button type="button" class="btn btn-primary" data-action="gl-new">+ Термин</button></div></div>';
  if(!all.length) return el(html + '<div class="card empty-state" style="padding:36px 16px;">Терминов пока нет. Нажмите «+ Термин» — например, название болезни или методики из урока.</div></div>');
  if(!list.length) html += '<div class="card empty-state" style="padding:28px 16px;">Ничего не нашлось.</div>';
  var groups = [], byLesson = {};
  lsLessons().forEach(function(l, i){ byLesson[l.id] = { title:"Урок "+(i+1)+" · "+l.title, items:[] }; groups.push(byLesson[l.id]); });
  var none = { title:"Без урока", items:[] };
  list.forEach(function(t){ (byLesson[t.lessonId] || none).items.push(t); });
  groups.concat([none]).forEach(function(g){
    if(!g.items.length) return;
    html += '<div class="card ls-sec"><div class="ls-sec-h"><b>'+escapeHtml(g.title)+'</b><span class="ls-n">'+g.items.length+' '+ruPluralClient(g.items.length,"термин","термина","терминов")+'</span></div>';
    g.items.forEach(function(t){
      var f = glFoundText(t.foundIn, t.lessonId);
      html += '<div class="ls-row" data-action="gl-edit" data-id="'+t.id+'"><div class="ls-main"><b>'+escapeHtml(t.title)+'</b>' +
        '<div class="ls-chips">'+(t.category ? lsPill("info", t.category) : '')+lsPill(f.kind, f.text, f.kind==="ok"?"eye":null)+
          '<span class="ls-pill gl-aliases" title="Написания в тексте">'+escapeHtml((t.aliases||[]).slice(0,3).join(", ")+((t.aliases||[]).length>3?" …":""))+'</span></div></div>' +
        '<button type="button" class="btn btn-sm btn-ghost ls-open" data-action="gl-edit" data-id="'+t.id+'">Изменить</button></div>';
    });
    html += '</div>';
  });
  return el(html + '</div>');
}

// Черновик формы ↔ термин
function glDraft(t){
  var b = (t && t.body) || {};
  return {
    id: t ? t.id : null, title: t ? t.title : "", category: t ? (t.category||"") : "", lessonId: t ? (t.lessonId||"") : "",
    aliasesText: t ? (t.aliases||[]).join("\n") : "", lead: t ? (t.lead||"") : "",
    key: { label: (b.key && b.key.label) || "", text: (b.key && b.key.text) || "", scale: ((b.key && b.key.scale) || []).map(function(r){ return r.slice(); }) },
    meaning: { text: (b.meaning && b.meaning.text) || "", stats: ((b.meaning && b.meaning.stats) || []).map(function(r){ return r.slice(); }) },
    actions: (b.actions || []).map(function(r){ return r.slice(); }),
    more: (b.more || []).map(function(r){ return r.slice(); }),
    foundIn: t ? t.foundIn : null
  };
}
function glAliases(d){ return d.aliasesText.split(/\n|,/).map(function(x){ return x.trim(); }).filter(Boolean); }
function glDraftTerm(d){
  return { title:d.title, category:d.category, lead:d.lead, lessonId:d.lessonId||null, aliases:glAliases(d),
    body:{ key: d.key.text ? d.key : null, meaning: (d.meaning.text || d.meaning.stats.length) ? d.meaning : null, actions:d.actions, more:d.more } };
}
function glSetPath(obj, path, val){
  var ps = path.split("."), o = obj;
  for(var i=0;i<ps.length-1;i++) o = o[ps[i]];
  o[ps[ps.length-1]] = val;
}
function glPreviewHtml(){
  var d = glossaryAdmin.edit;
  return glossaryArticleHtml(glDraftTerm(d), glossaryAdmin.tab, { noCourseTab:true, tabAction:"gl-preview-tab" });
}
function glCheckAliases(){
  var d = glossaryAdmin.edit;
  if(!d) return;
  clearTimeout(glossaryAdmin.checkTimer);
  glossaryAdmin.checkTimer = setTimeout(function(){
    var aliases = glAliases(d);
    if(!aliases.length){ glossaryAdmin.check = []; glPaintCheck(); return; }
    api("/glossary/check", { method:"POST", body: JSON.stringify({ courseId: staffState.activeCourseId, aliases: aliases }) })
      .then(function(r){ glossaryAdmin.check = r.foundIn || []; glPaintCheck(); }, function(){});
  }, 350);
}
function glCheckHtml(){
  var d = glossaryAdmin.edit, found = glossaryAdmin.check;
  if(found===null) return '<span class="gl-chk wait">Проверяем по текстам уроков…</span>';
  if(!glAliases(d).length) return '<span class="gl-chk warn">Добавьте хотя бы одно написание</span>';
  var f = glFoundText(found, d.lessonId || null);
  return '<span class="gl-chk '+f.kind+'">'+icon(f.kind==="ok"?"check":"eye","ic-sm")+(f.kind==="ok" ? "Найдено: " : "")+escapeHtml(f.text.replace(/^подсвечивается в /, "будет подсвечен в "))+'</span>';
}
function glPaintCheck(){ var c = document.getElementById("glAliasCheck"); if(c) c.innerHTML = glCheckHtml(); }
function glRows(list, path, cols, addLabel){
  var html = '<div class="gl-rows">';
  list.forEach(function(r, i){
    html += '<div class="gl-rowf">' + cols.map(function(c, j){
      if(c.stack) return '<div class="gl-stack">'+c.stack.map(function(sc){ return '<input class="input'+(sc.strong?' strong':'')+'" data-gb="'+path+'.'+i+'.'+sc.j+'" value="'+escapeHtml(r[sc.j]||"")+'" placeholder="'+escapeHtml(sc.ph||"")+'">'; }).join('')+'</div>';
      if(c.select) return '<select class="input" data-gb="'+path+'.'+i+'.'+j+'">'+c.select.map(function(o){ return '<option value="'+o[0]+'"'+(r[j]===o[0]?' selected':'')+'>'+escapeHtml(o[1])+'</option>'; }).join('')+'</select>';
      if(c.area) return '<textarea class="input" rows="3" data-gb="'+path+'.'+i+'.'+j+'" placeholder="'+escapeHtml(c.ph||"")+'">'+escapeHtml(r[j]||"")+'</textarea>';
      return '<input class="input'+(c.narrow?' narrow':'')+'" data-gb="'+path+'.'+i+'.'+j+'" value="'+escapeHtml(r[j]||"")+'" placeholder="'+escapeHtml(c.ph||"")+'">';
    }).join('') + '<button type="button" class="gl-rowx" data-action="gl-row-del" data-list="'+path+'" data-i="'+i+'" title="Убрать">'+icon("close","ic-sm")+'</button></div>';
  });
  return html + '<button type="button" class="link-btn" data-action="gl-row-add" data-list="'+path+'">+ '+addLabel+'</button></div>';
}
function renderGlossaryTermPage(){
  var d = glossaryAdmin.edit, isNew = !d.id;
  var lessonOpts = '<option value="">— без урока —</option>' + lsLessons().map(function(l, i){ return '<option value="'+l.id+'"'+(d.lessonId===l.id?' selected':'')+'>Урок '+(i+1)+' · '+escapeHtml(l.title)+'</option>'; }).join('');
  var sec = function(n, title, hint, body, optional){
    return '<div class="card pr-sec"><div class="pr-sec-h"><i>'+n+'</i><b>'+title+'</b>'+(optional?'<span class="gl-opt">необязательно</span>':'')+'</div><p class="pr-sec-s">'+hint+'</p>'+body+'</div>';
  };
  var html = '<div class="lp-page"><div class="lp-crumbs"><button type="button" class="link-btn" data-action="gl-close">← Термины</button><span>/</span><b>'+(isNew?'Новый термин':escapeHtml(d.title))+'</b></div>' +
    '<div class="lp-head"><div class="lp-head-main"><h1 class="lp-title">'+(isNew ? 'Новый термин' : escapeHtml(d.title))+'</h1></div>' +
    '<div class="lp-head-acts">'+(isNew ? '' : '<button type="button" class="btn btn-ghost" data-action="gl-delete">'+icon("trash","ic-sm")+'Удалить</button>')+
      '<button type="button" class="btn btn-primary" data-action="gl-save">'+(isNew?'Создать термин':'Сохранить')+'</button></div></div>' +
    '<div class="gl-edit"><div class="pr-secs">';
  html += sec(1, "Термин и где он встречается", "Название — заголовок статьи. Написания — как слово стоит в тексте урока: по ним термин находится и подсвечивается.",
    '<div class="gl-grid2"><div class="field"><label>Название</label><input class="input" data-gb="title" value="'+escapeHtml(d.title)+'" placeholder="Например, «Возрастной гипогонадизм»"></div>' +
    '<div class="field"><label>Категория</label><input class="input" data-gb="category" value="'+escapeHtml(d.category)+'" placeholder="Например, «Эндокринология»"></div></div>' +
    '<div class="field"><label>Урок, где термин вводится</label><select class="input" data-gb="lessonId">'+lessonOpts+'</select><p class="hint">В этом уроке слово подсвечено всегда, в остальных — пока врач не открыл статью.</p></div>' +
    '<div class="field"><label>Написания в тексте — по одному в строке</label><textarea class="input" rows="4" data-gb="aliasesText" placeholder="гипогонадизм&#10;гипогонадизма&#10;гипогонадизму">'+escapeHtml(d.aliasesText)+'</textarea>' +
      '<p class="hint">Добавьте нужные падежи: «гипогонадизм», «гипогонадизма»… Сокращения вроде «ПСА» ищутся с учётом регистра.</p><div id="glAliasCheck">'+glCheckHtml()+'</div></div>' +
    '<div class="field" style="margin-bottom:0;"><label>Коротко, что это</label><textarea class="input" rows="2" data-gb="lead" placeholder="1–2 предложения под заголовком статьи">'+escapeHtml(d.lead)+'</textarea></div>');
  html += sec(2, "Главное", "Цветной блок по центру статьи: одно правило или число, которое важно запомнить. Шкала — если есть пороги или этапы.",
    '<div class="field"><label>Текст крупно</label><textarea class="input" rows="2" data-gb="key.text" placeholder="Например, «Общий тестостерон ниже 8 нмоль/л — гипогонадизм»">'+escapeHtml(d.key.text)+'</textarea></div>' +
    '<div class="field" style="max-width:320px;"><label>Подпись над текстом</label><input class="input" data-gb="key.label" value="'+escapeHtml(d.key.label)+'" placeholder="Главное число"></div>' +
    '<label class="gl-sublab">Шкала — до 5 делений: значение, подпись и цвет (норма — фиолетовый, внимание — розовый, опасно — красный)</label>' + glRows(d.key.scale, "key.scale", [{ ph:"> 12,1", narrow:true }, { ph:"норма" }, { select:GL_TONE_CHOICES }], "деление шкалы"), true);
  html += sec(3, "Что это означает?", "Пояснение простым языком и, если есть, крупные цифры — распространённость, доли, пороги.",
    '<div class="field"><textarea class="input" rows="3" data-gb="meaning.text" placeholder="Что важно понимать про этот термин">'+escapeHtml(d.meaning.text)+'</textarea></div>' +
    '<label class="gl-sublab">Крупные цифры (до 4)</label>' + glRows(d.meaning.stats, "meaning.stats", [{ ph:"≈ 40%", narrow:true }, { ph:"мужчин старше 45 лет" }], "цифру"), true);
  html += sec(4, "Что делать врачу?", "Короткие практические шаги — каждый отдельной карточкой с иконкой и красной подписью.",
    glRows(d.actions, "actions", [{ select:GL_ICON_CHOICES }, { stack:[{ j:1, ph:"Шаг — например, «Скрининг опросником AMS»", strong:true }, { j:2, ph:"Пояснение красным — например, «выше 26 баллов — симптомы выражены»" }] }], "шаг"), true);
  html += sec(5, "Подробнее", "Отдельная вкладка статьи для тех, кто хочет глубже: несколько абзацев с заголовками.",
    glRows(d.more, "more", [{ ph:"Заголовок абзаца" }, { ph:"Текст", area:true }], "абзац"), true);
  html += '<div class="gl-savebar"><button type="button" class="btn btn-primary" data-action="gl-save">'+(isNew?'Создать термин':'Сохранить')+'</button><button type="button" class="btn btn-ghost" data-action="gl-close">Отмена</button></div>';
  html += '</div><div class="gl-prevcol"><div class="gl-prevlab">'+icon("eye","ic-sm")+'Так врач увидит статью</div><div class="gl-prev" id="glPreview">'+glPreviewHtml()+'</div></div></div></div>';
  return el(html);
}

/* ============================= ПРЕДПРОСМОТР «ТАК ВРАЧ УВИДИТ» ============================= */
// Колонка рядом с редактором урока (материал, видео, тест, задание) и протокола:
// те же функции отрисовки, что у врача, на данных из формы — обновляется во время
// правки. Внутри работают только «врачебные» действия, которые ничего не меняют на
// сервере (ответить на вопрос теста, перемотать видео, переключить гайд), — всё
// остальное (отправка, переходы) гасится перехватчиком кликов ниже.
var PREVIEW_ALLOWED = ["qr-pick","qr-goto","qr-prev","qr-next","qr-move","qr-match","seek-lesson-video","select-protocol-guide","prev-toc"];
var previewQuizCache = {};
document.addEventListener("click", function(e){
  var box = e.target.closest && e.target.closest(".doc-prev-body");
  if(!box) return;
  var t = e.target.closest("[data-action]");
  if(!t || !box.contains(t)) return;
  var a = t.getAttribute("data-action");
  if(a==="qr-submit"){ e.preventDefault(); e.stopPropagation(); showToast("Это предпросмотр — ответы не отправляются и не засчитываются"); return; }
  if(a==="prev-toc"){
    e.preventDefault(); e.stopPropagation();
    var h = t.getAttribute("data-i")==="cheat" ? box.querySelector(".prose .lb-cheat") : box.querySelectorAll(".prose h4")[parseInt(t.getAttribute("data-i"),10)];
    if(h) h.scrollIntoView({ behavior:"smooth", block:"start" });
    return;
  }
  if(a==="select-protocol-guide"){
    e.preventDefault(); e.stopPropagation();
    protocolGuideTab[t.getAttribute("data-id")] = t.getAttribute("data-spec"); prRefreshPreview();
    return;
  }
  if(PREVIEW_ALLOWED.indexOf(a)===-1){ e.preventDefault(); e.stopPropagation(); }
}, true);

function docPreview(inner, note){
  return '<div class="doc-prev"><div class="doc-prev-lab">'+icon("eye","ic-sm")+'Так врач увидит'+(note?'<span>'+note+'</span>':'')+'</div>' +
    '<div class="doc-prev-body" id="docPreview">'+inner+'</div></div>';
}
// Подсветка терминов глоссария в тексте (как у врача, впервые открывшего урок).
function glHighlightIn(prose, terms, lessonId){
  (terms||[]).forEach(function(term){
    var ms = glMatchers(term);
    var w = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, null), n;
    while((n = w.nextNode())){
      if(n.parentElement.closest(".gl-term, a, button")) continue;
      var best = null;
      ms.forEach(function(re){ var m = re.exec(n.nodeValue); if(m){ var at = m.index + m[1].length; if(!best || at < best.at) best = { at:at, len:m[2].length }; } });
      if(!best) continue;
      var mid = n.splitText(best.at); mid.splitText(best.len);
      var sp = document.createElement("span"); sp.className = "gl-term"; sp.title = "Термин: «"+term.title+"»";
      mid.parentNode.insertBefore(sp, mid); sp.appendChild(mid);
      break;
    }
  });
}
// Вопрос в том виде, в каком его получает врач (как src/quiz.js publicQuestion):
// порядок и правую колонку сопоставления — перемешанными, без верных ответов.
function qzPublicFromAdmin(q){
  var t = q.qtype || "single", p = q.payload || {}, n;
  var rot = function(arr){ n = arr.length; return arr.map(function(_, i){ return (i+1) % n; }); };
  if(t==="order") return { id:q.id, type:t, question:q.question, items: rot(q.options).map(function(i){ return { token:"o"+i, text:q.options[i] }; }) };
  if(t==="number") return { id:q.id, type:t, question:q.question, unit:p.unit||"" };
  if(t==="match") return { id:q.id, type:t, question:q.question, left:q.options, right: rot(p.right||[]).map(function(i){ return { token:"r"+i, text:p.right[i] }; }) };
  if(t==="case") return { id:q.id, type:t, question:q.question, scenario:p.scenario||"", steps:(p.steps||[]).map(function(s){ return s.type==="number" ? { type:"number", question:s.question, unit:s.unit||"" } : { type:s.type, question:s.question, options:s.options }; }) };
  return { id:q.id, type:t, question:q.question, options:q.options };
}
function previewQuizHtml(key, rows, emptyText){
  if(!rows || !rows.length) return '<p class="doc-prev-empty">'+emptyText+'</p>';
  var pub = rows.map(qzPublicFromAdmin);
  var sig = pub.map(function(x){ return x.id; }).join(",");
  if(previewQuizCache[key] && previewQuizCache[key].sig!==sig) delete quizRuns[key];
  previewQuizCache[key] = { sig:sig, questions:pub };
  return renderQuizRunner(key, pub, { hint:"предпросмотр: можно пройти, ответы не сохраняются", submitLabel:"Завершить тест" });
}
function lpStagesFor(l){
  var st = ["intro"];
  if(lpHasVideo(l) || (videoEditor.open && videoEditor.lessonId===l.id && videoEditor.videoUrl)) st.push("video");
  if(lpQuizCount(l)) st.push("quiz");
  if(l.assignment_prompt) st.push("task");
  return st;
}
function lpPreviewHtml(tab){
  var id = staffState.lessonPageId, list = lsLessons();
  if(id==="quiz") return previewQuizHtml("preview:final", staffState.quizAdmin, "В итоговом тесте пока нет вопросов.");
  var idx = list.findIndex(function(x){ return x.id===id; }), l = list[idx];
  if(!l) return "";
  var stages = lpStagesFor(l), labels = { intro:"Материал", video:"Видео", quiz:"Тест", task:"Задание" };
  var stageKey = { content:"intro", video:"video", quiz:"quiz", assign:"task" }[tab];
  var frm = document.getElementById("lessonEditorForm");
  var title = frm && frm.title ? frm.title.value : (lessonEditor.title || l.title);
  var duration = frm && frm.duration ? frm.duration.value : (lessonEditor.duration || l.duration || "");
  var head = '<div class="lesson-head"><h3>'+escapeHtml(title)+'</h3></div><div class="meta">Урок '+(idx+1)+' из '+list.length+(duration?' · '+escapeHtml(duration):'')+'</div>';
  if(stages.indexOf(stageKey)===-1) stages.push(stageKey);
  head += '<div class="tabs" style="margin:14px 0 4px;">'+stages.map(function(k){ return '<button type="button" class="tab'+(k===stageKey?' active':'')+'">'+labels[k]+'</button>'; }).join('')+'</div>';
  var body = "";
  if(tab==="content"){
    var op = lessonOpener({ html: lessonEditor.html || "" });
    body = '<div class="prose lesson-text" data-prev-prose="1">'+op.rest+'</div>';
  } else if(tab==="video"){
    var tcs = (videoEditor.timecodes||[]).filter(function(tc){ return typeof tc.time==="number" && isFinite(tc.time) && tc.title; })
      .map(function(tc, i){ return { id: tc.id || ("prev"+i), time: tc.time, title: tc.title, summary: tc.summary||"" }; })
      .sort(function(a, b){ return a.time - b.time; });
    body = videoEditor.videoUrl ? renderLessonVideoStage({ videoUrl: videoEditor.videoUrl, videoTimecodes: tcs }, stages, false)
      : '<p class="doc-prev-empty">Видео ещё не загружено — у врача не будет шага «Видео».</p>';
  } else if(tab==="quiz"){
    body = previewQuizHtml("preview:"+id, lessonQuizManager.lessonId===id ? lessonQuizManager.questions : [], "Вопросов пока нет — у врача не будет шага «Тест».");
  } else if(tab==="assign"){
    var ae = toolsState.assignEditor;
    body = ae && ae.prompt && ae.prompt.trim()
      ? '<div class="task-box"><div class="task-label">'+icon("task","ic-sm")+' Задание к уроку'+(ae.required?'<span class="task-req">обязательное</span>':'')+'</div><div class="task-prompt">'+renderPlainToProse(ae.prompt)+'</div>' +
          '<textarea class="input task-input" disabled placeholder="Ваш ответ — куратор прочитает его и ответит"></textarea>' +
          '<div class="task-send"><button class="btn btn-sm btn-primary" disabled>Отправить куратору</button></div></div>' +
          (ae.required ? '<p class="doc-prev-note">Стоп-урок: урок засчитается врачу, когда куратор примет ответ.</p>' : '')
      : '<p class="doc-prev-empty">Задания нет — у врача не будет шага «Задание».</p>';
  }
  return '<div class="lesson-body doc-prev-lesson">'+head+body+'</div>';
}
function lpRefreshPreview(){
  var box = document.getElementById("docPreview");
  if(!box || !lpActive()) return;
  var tab = staffState.lessonPageTab;
  if(["content","video","quiz","assign","questions"].indexOf(tab)===-1) return;
  var sc = box.scrollTop;
  box.innerHTML = lpPreviewHtml(tab);
  lpDecoratePreview();
  box.scrollTop = sc;
}
var lpPrevTimer = null;
function lpRefreshPreviewSoon(){ clearTimeout(lpPrevTimer); lpPrevTimer = setTimeout(lpRefreshPreview, 180); }
// Термины в тексте предпросмотра — по глоссарию курса (грузится один раз).
function lpDecoratePreview(){
  var prose = document.querySelector("#docPreview [data-prev-prose]");
  if(!prose) return;
  if(!glossaryAdmin.loaded || glossaryAdmin.courseId!==staffState.activeCourseId){ glAdminLoad().then(lpDecoratePreview); return; }
  if(prose.querySelector(".gl-term")) return;
  glHighlightIn(prose, glossaryAdmin.list, staffState.lessonPageId);
}

/* ---------- Протокол глазами врача ---------- */
function prPreviewHtml(){
  var p = protocolEditor, frm = document.getElementById("protocolEditorForm");
  var title = frm && frm.title ? frm.title.value : p.title, summary = frm && frm.summary ? frm.summary.value : p.summary;
  var guides = (p.guides||[]).map(function(g){
    var ed = document.getElementById("guideEditText");
    return p.editSpec===g.specializationId && ed ? Object.assign({}, g, { guideHtml: ed.value }) : g;
  });
  var nsel = document.getElementById("newGuideSpec"), ntx = document.getElementById("newGuideText");
  if(nsel && ntx && ntx.value.trim()){
    var sp = specializationsList.find(function(s){ return s.id===nsel.value; });
    guides = guides.concat([{ specializationId: nsel.value, specializationName: (sp ? sp.name : "") + " (новый)", guideHtml: ntx.value, files: [] }]);
  }
  var pp = { id: p.id || "preview-new", title: title || "Без названия", summary: summary, guides: guides };
  return '<div class="doc-prev-proto"><span class="profile-kicker">Протокол</span><b class="gd-title">'+escapeHtml(pp.title)+'</b>' +
    (pp.summary ? '<p class="gd-sum">'+escapeHtml(stripHtml(renderPlainToProse(pp.summary)))+'</p>' : '') +
    '<div class="doc-prev-proto-body">'+renderProtocolCard(pp, false, true)+'</div></div>';
}
function prRefreshPreview(){
  var box = document.getElementById("docPreview");
  if(!box || !(staffState.mainTab==="protocols" && protocolEditor.open)) return;
  box.innerHTML = prPreviewHtml();
}

/* ============================= РЕНДЕР: ПРОТОКОЛЫ (АДМИН) ============================= */
// Специализации — фиксированный справочник (см. schema.sql «Этап 11»): отсюда админ
// им управляет, отсюда же их читают форма регистрации и профиль врача.
function renderSpecializationsCard(){
  var html = '<div class="card" style="padding:18px 20px;margin-bottom:16px;">' +
    '<b style="font-size:15px;display:block;margin-bottom:4px;">Специализации</b>' +
    '<p style="font-size:13px;color:var(--muted);margin:0 0 14px;">Справочник, из которого врач выбирает специализацию при регистрации — на нём же основан подбор протоколов.</p>';
  specializationsList.forEach(function(s){
    html += '<div class="adm-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-2);">' +
      '<span style="flex:1;font-size:14px;">'+escapeHtml(s.name)+'</span>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-specialization-editor" data-id="'+s.id+'" data-name="'+escapeHtml(s.name)+'">Переименовать</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="delete-specialization" data-id="'+s.id+'" data-name="'+escapeHtml(s.name)+'" title="Удалить">'+icon("trash","ic-sm")+'</button>' +
    '</div>';
  });
  html += '<form id="specializationCreateForm" style="display:flex;gap:8px;margin-top:14px;">' +
      '<input class="input" name="name" placeholder="Новая специализация" required style="flex:1;">' +
      '<button class="btn btn-sm btn-primary" type="submit">Добавить</button>' +
    '</form>' +
  '</div>';
  return html;
}

// Протоколы — карточками (видно, для каких специализаций есть гайды и какой урок
// открывает протокол), справочник специализаций — на соседней вкладке. Протокол
// открывается отдельной страницей из трёх шагов: описание → когда открывается →
// гайды. Формы и действия те же, что были в прежнем окне редактора протокола.
function prLessonLabels(p){
  var list = lsLessons(), inCourse = [], other = 0;
  (p.lessonIds||[]).forEach(function(id){
    var i = list.findIndex(function(l){ return l.id===id; });
    if(i===-1) other++; else inCourse.push((i+1)+". "+list[i].title);
  });
  return { inCourse:inCourse, other:other };
}
function renderProtocolsAdminTab(){
  if(protocolEditor.open) return renderProtocolPage();
  var admin = isAdminRole(), tab = "list";
  var all = adminProtocolsState.list, q = (staffState.protoQuery||"").trim().toLowerCase();
  var list = q ? all.filter(function(p){ return (p.title+" "+(p.summary||"")).toLowerCase().indexOf(q)!==-1; }) : all;
  var html = '<div class="ls-page"><div class="ls-bar"><p class="ls-sub">Протокол открывается врачу после привязанных уроков — с гайдом под его специализацию.</p>' +
    '<div class="ls-actions">'+(tab==="list" ? '<label class="ls-search">'+icon("search","ic-sm")+'<input id="protocolsSearchInput" placeholder="Найти протокол" value="'+escapeHtml(staffState.protoQuery||"")+'" autocomplete="off"></label>' : '') +
      (admin ? '<button type="button" class="btn btn-primary" data-action="open-protocol-creator">+ Протокол</button>' : '') + '</div></div>';

  if(!all.length){
    html += '<div class="card empty-state" style="padding:36px 16px;">Протоколов пока нет.'+(admin?' Нажмите «+ Протокол», чтобы добавить первый.':'')+'</div>';
    return el(html + '</div>');
  }
  if(!list.length) html += '<div class="card empty-state" style="padding:28px 16px;">Ничего не нашлось.</div>';
  html += '<div class="pr-grid">';
  list.forEach(function(p){
    var ll = prLessonLabels(p), bound = (p.lessonIds||[]).length>0, guides = p.guides||[];
    html += '<div class="card pr-card" data-action="open-protocol-editor" data-id="'+p.id+'">' +
      '<div class="pr-top">'+(bound ? lsPill("ok","открывается врачам") : lsPill("warn","не привязан к уроку"))+(guides.length ? '' : lsPill("warn","нет гайдов"))+'<span class="ls-sp"></span>' +
        (admin ? lsMenu("p:"+p.id, [["open-protocol-editor","Изменить","gear",' data-id="'+p.id+'"'], "-", ["delete-protocol","Удалить протокол","trash",' data-id="'+p.id+'" data-title="'+escapeHtml(p.title)+'"',"danger"]]) : '') + '</div>' +
      '<b class="pr-title">'+escapeHtml(p.title)+'</b>' +
      (p.summary ? '<p class="pr-sum">'+escapeHtml(p.summary)+'</p>' : '') +
      '<div class="pr-kv"><div>'+icon("doctor","ic-sm")+'<span>Гайды: <b>'+(guides.length ? escapeHtml(guides.map(function(g){ return g.specializationName; }).join(", ")) : '—')+'</b></span></div>' +
        '<div>'+icon("book","ic-sm")+'<span>Открывает: <b>'+(ll.inCourse.length ? escapeHtml(ll.inCourse.join("; ")) : (ll.other ? '' : '—'))+(ll.other ? (ll.inCourse.length?' + ':'')+ll.other+' '+ruPluralClient(ll.other,"урок","урока","уроков")+' других курсов' : '')+'</b></span></div></div>' +
      '<button type="button" class="btn btn-sm btn-ghost pr-edit" data-action="open-protocol-editor" data-id="'+p.id+'">Изменить</button>' +
    '</div>';
  });
  if(admin && !q) html += '<button type="button" class="pr-new" data-action="open-protocol-creator"><span>+</span>Новый протокол</button>';
  return el(html + '</div></div>');
}

// Специализации врачей курса, под которые у протокола ещё нет гайда.
function prMissingSpecs(p){
  var have = {}; (p.guides||[]).forEach(function(g){ have[g.specializationId] = true; });
  var byName = {}; specializationsList.forEach(function(s){ byName[s.name] = s; });
  var counts = {};
  (staffState.students||[]).forEach(function(st){ (st.specializations||[]).forEach(function(n){ var s = byName[n]; if(s && !have[s.id]) counts[s.id] = (counts[s.id]||0) + 1; }); });
  return Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; }).map(function(id){ return { id:id, name:specializationsList.find(function(s){ return s.id===id; }).name, count:counts[id] }; });
}
function prHasUnsaved(){
  var pg = document.querySelector(".pr-page");
  if(!pg) return false;
  return [].some.call(pg.querySelectorAll("input,textarea,select"), function(f){ return f.id!=="newGuideSpec" && !/^guideFileInput-/.test(f.id||"") && fieldIsChanged(f); });
}
function prLeaveOk(){ return !prHasUnsaved() || window.confirm("Уйти без сохранения? Введённое на этой странице пропадёт."); }
function renderProtocolPage(){
  var p = protocolEditor, admin = isAdminRole(), isNew = !p.id;
  var bound = p.lessonIds.length>0;
  var html = '<div class="lp-page pr-page"><div class="lp-crumbs"><button type="button" class="link-btn" data-action="close-protocol-editor">← Протоколы</button><span>/</span><b>'+(isNew ? 'Новый протокол' : escapeHtml(p.title))+'</b></div>' +
    '<div class="lp-head"><div class="lp-head-main"><h1 class="lp-title">'+(isNew ? 'Новый протокол' : escapeHtml(p.title))+'</h1>' +
      (isNew ? '<p class="lp-hint" style="margin:6px 0 0;">Сначала название и описание — после создания добавите уроки и гайды.</p>'
        : '<div class="ls-chips">'+(bound ? lsPill("ok","открывается врачам") : lsPill("warn","не привязан к уроку"))+lsPill("", p.guides.length+" "+ruPluralClient(p.guides.length,"гайд","гайда","гайдов"), "doctor")+'</div>') + '</div>' +
      '<div class="lp-head-acts">'+(admin && !isNew ? lsMenu("pp:"+p.id, [["delete-protocol","Удалить протокол","trash",' data-id="'+p.id+'" data-title="'+escapeHtml(p.title)+'"',"danger"]]) : '')+'</div></div>';

  var steps = [["prSec1","Описание",""]];
  if(!isNew){
    if(admin) steps.push(["prSec2","Когда открывается", p.lessonIds.length ? String(p.lessonIds.length) : "—"]);
    steps.push(["prSec3","Гайды", String(p.guides.length)]);
  }
  // Слева — шаги редактора, справа — протокол глазами врача (обновляется при правке).
  html += '<div class="pr-layout with-prev"><div class="pr-secs">';

  // 1. Описание
  html += '<div class="card pr-sec" id="prSec1"><div class="pr-sec-h"><i>1</i><b>Описание</b></div><p class="pr-sec-s">Видно всем врачам, даже без гайда под их специализацию.</p>';
  if(admin){
    html += '<form id="protocolEditorForm">' +
      '<div class="field"><label>Название протокола</label><input class="input" name="title" required value="'+escapeHtml(p.title)+'"></div>' +
      '<div class="field"><label>Краткое описание</label><textarea class="input" name="summary" style="height:84px;">'+escapeHtml(p.summary)+'</textarea></div>' +
      '<div class="err-text" id="protocolEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary" type="submit">'+(isNew?"Создать и продолжить":"Сохранить описание")+'</button></form>';
  } else {
    html += '<b style="font-size:15px;display:block;">'+escapeHtml(p.title)+'</b>' + (p.summary ? '<p class="pr-sum" style="-webkit-line-clamp:unset;">'+escapeHtml(p.summary)+'</p>' : '');
  }
  html += '</div>';

  if(!isNew){
    // 2. Когда открывается
    if(admin){
      html += '<div class="card pr-sec" id="prSec2"><div class="pr-sec-h"><i>2</i><b>Когда открывается</b></div><p class="pr-sec-s">Врач получит протокол, когда пройдёт отмеченные уроки.</p>';
      if(!lsLessons().length) html += '<p class="hint">В этом курсе пока нет уроков.</p>';
      lsLessons().forEach(function(l, i){
        var checked = p.lessonIds.indexOf(l.id)!==-1;
        html += '<label class="pr-lchk'+(checked?' on':'')+'"><input type="checkbox" data-action="toggle-protocol-lesson" data-id="'+l.id+'"'+(checked?' checked':'')+'><span>'+(i+1)+'. '+escapeHtml(l.title)+'</span></label>';
      });
      html += '<button type="button" class="btn btn-ghost" style="margin-top:10px;" data-action="save-protocol-lessons">Сохранить уроки</button></div>';
    }
    // 3. Гайды
    html += '<div class="card pr-sec" id="prSec3"><div class="pr-sec-h"><i>'+(admin?3:2)+'</i><b>Гайды по специализациям</b></div><p class="pr-sec-s">Врач видит гайд своей специализации, остальные — только описание.</p>';
    if(!p.guides.length) html += '<p class="hint" style="margin:0 0 6px;">Гайдов пока нет.</p>';
    p.guides.forEach(function(g){
      var editing = p.editSpec===g.specializationId, files = (g.files||[]).length;
      html += '<div class="pr-guide"><div class="pr-guide-h"><span class="pr-av">'+icon("doctor","ic-sm")+'</span><div class="ls-main"><b>'+escapeHtml(g.specializationName)+'</b>' +
          '<span>'+(g.guideHtml ? 'текст' : 'без текста')+' · '+(files ? files+' '+ruPluralClient(files,"файл","файла","файлов") : 'без файлов')+'</span></div>' +
          (editing ? '' : '<button type="button" class="btn btn-sm btn-ghost" data-action="edit-protocol-guide" data-spec="'+g.specializationId+'">Изменить текст</button>') +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="delete-protocol-guide" data-spec="'+g.specializationId+'" title="Удалить гайд">'+icon("trash","ic-sm")+'</button></div>';
      if(editing){
        html += '<textarea class="input" id="guideEditText" style="height:140px;margin-top:10px;">'+escapeHtml(g.guideHtml||"")+'</textarea>' +
          '<div style="display:flex;gap:8px;margin-top:8px;"><button type="button" class="btn btn-sm btn-primary" data-action="save-protocol-guide-edit" data-spec="'+g.specializationId+'">Сохранить</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="cancel-protocol-guide-edit">Отмена</button></div>';
      } else if(g.guideHtml){
        html += '<div class="prose pr-guide-text">'+renderPlainToProse(g.guideHtml)+'</div>';
      }
      html += renderProtocolGuideFiles(g) + '</div>';
    });
    var usedSpecs = p.guides.map(function(g){ return g.specializationId; });
    var availableSpecs = specializationsList.filter(function(s){ return usedSpecs.indexOf(s.id)===-1; });
    var missing = prMissingSpecs(p);
    if(missing.length){
      html += '<div class="pr-missing"><span class="lp-dot no">!</span><div><b>Нет гайда для специализаций врачей курса</b><div class="pr-miss-chips">' +
        missing.slice(0,8).map(function(m){ return '<button type="button" class="ls-chip-btn" data-action="pick-guide-spec" data-spec="'+m.id+'">'+escapeHtml(m.name)+' · '+m.count+'</button>'; }).join('') +
        (missing.length>8 ? '<span class="ls-n">и ещё '+(missing.length-8)+'</span>' : '') + '</div></div></div>';
    }
    if(availableSpecs.length){
      var pre = p.newSpec && availableSpecs.some(function(s){ return s.id===p.newSpec; }) ? p.newSpec : (missing[0] ? missing[0].id : availableSpecs[0].id);
      html += '<div class="pr-add" id="prGuideAdd"><b>Новый гайд</b>' +
        '<div class="field" style="margin:8px 0;"><label>Специализация</label><select class="input" id="newGuideSpec">' +
          availableSpecs.map(function(s){ return '<option value="'+s.id+'"'+(s.id===pre?' selected':'')+'>'+escapeHtml(s.name)+'</option>'; }).join('') +
        '</select></div>' +
        '<div class="field" style="margin-bottom:8px;"><label>Текст гайда</label><textarea class="input" id="newGuideText" style="height:90px;" placeholder="Как применять этот протокол в рамках этой специализации"></textarea></div>' +
        '<button type="button" class="btn btn-sm btn-primary" data-action="save-protocol-guide">Добавить гайд</button><p class="hint" style="margin:8px 0 0;">Файлы (PDF, схемы) прикрепляются к гайду после его создания.</p></div>';
    } else {
      html += '<p class="hint">Гайды добавлены под все специализации из справочника.</p>';
    }
    html += '</div>';
  }
  return el(html + '</div>' + docPreview(prPreviewHtml(), "обновляется, пока вы правите") + '</div></div>');
}

// Разовая анимация «разблокировали функцию» — центрированная модалка (не боковой
// drawer, как остальные оверлеи) с раскрывающимся замком. Показывается один раз,
// в момент, когда protocolsSectionAvailable() впервые становится true — см.
// maybeCelebrateProtocolsUnlock. Закрывается кликом по фону, кнопкой «Понятно»
// или переходом сразу в «Ваши протоколы».
function renderUnlockCelebrationModal(){
  var body =
    '<div class="unlock-lock-wrap">' +
      '<div class="unlock-burst"></div>' +
      '<svg class="unlock-lock-svg" viewBox="0 0 24 24">' +
        '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/>' +
        '<path class="unlock-lock-shackle" d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>' +
      '</svg>' +
    '</div>' +
    '<h3>Новая функция разблокирована!</h3>' +
    '<p>Вам стали доступны «Ваши протоколы» — готовые гайды по применению того, о чём говорили спикеры, подобранные под вашу специализацию.</p>' +
    '<div class="unlock-actions">' +
      '<button class="btn btn-primary btn-block" data-action="goto-protocols-from-celebration">Смотреть протоколы</button>' +
      '<button class="btn btn-ghost btn-block" data-action="close-unlock-celebration">Продолжить обучение</button>' +
    '</div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-unlock-celebration"><div class="unlock-card" data-stop="1">'+body+'</div></div>');
}

function renderSpecializationEditorModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Переименовать специализацию</b><button class="btn btn-ghost btn-sm" data-action="close-specialization-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body"><form id="specializationEditorForm">' +
      '<div class="field"><label>Название</label><input class="input" name="name" required value="'+escapeHtml(specializationEditor.name)+'"></div>' +
      '<div class="err-text" id="specializationEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Сохранить</button>' +
    '</form></div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-specialization-editor"><div class="drawer modal" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

function renderProtocolGuideFiles(g){
  var html = '<div style="margin-top:10px;">';
  (g.files||[]).forEach(function(f){
    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line-2);">' +
      '<a href="'+f.url+'" target="_blank" rel="noopener" style="flex:1;font-size:13px;display:flex;align-items:center;gap:6px;min-width:0;color:var(--primary);text-decoration:underline;">'+icon("folder","ic-sm")+'<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escapeHtml(f.originalName)+'</span></a>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="delete-protocol-guide-file" data-spec="'+g.specializationId+'" data-file-id="'+f.id+'" data-name="'+escapeHtml(f.originalName)+'" title="Удалить файл">'+icon("trash","ic-sm")+'</button>' +
    '</div>';
  });
  html += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;">' +
    '<input type="file" id="guideFileInput-'+g.specializationId+'" style="font-size:12px;flex:1;min-width:0;">' +
    '<button type="button" class="btn btn-sm btn-ghost" data-action="upload-protocol-guide-file" data-spec="'+g.specializationId+'">Прикрепить файл</button>' +
  '</div></div>';
  return html;
}

function renderProtocolEditorModal(){
  var isNew = !protocolEditor.id;
  var isProtocolAdmin = me.role==="admin" || me.role==="super_admin";
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+(isNew?"Новый протокол":"Редактирование протокола")+'</b><button class="btn btn-ghost btn-sm" data-action="close-protocol-editor">Закрыть ✕</button></div>' +
    '<div class="drawer-body">';

  if(isProtocolAdmin){
    body += '<form id="protocolEditorForm">' +
      '<div class="field"><label>Название протокола</label><input class="input" name="title" required value="'+escapeHtml(protocolEditor.title)+'"></div>' +
      '<div class="field"><label>Краткое описание <span style="font-weight:400;color:var(--muted-2);">(видно всем, даже без гайда под их специализацию)</span></label><textarea class="input" name="summary" style="height:64px;">'+escapeHtml(protocolEditor.summary)+'</textarea></div>' +
      '<div class="err-text" id="protocolEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary" type="submit">'+(isNew?"Создать и продолжить":"Сохранить")+'</button>' +
    '</form>';
  } else {
    body += '<b style="font-size:15px;display:block;">'+escapeHtml(protocolEditor.title)+'</b>' +
      (protocolEditor.summary ? '<p style="font-size:13px;color:var(--muted);margin:6px 0 0;">'+escapeHtml(protocolEditor.summary)+'</p>' : '');
  }

  if(!isNew){
    body += '<div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line-2);">' +
      '<b style="font-size:14px;display:block;margin-bottom:10px;">Гайды по специализациям</b>';
    protocolEditor.guides.forEach(function(g){
      body += '<div class="card" style="padding:12px 14px;margin-bottom:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b style="font-size:13px;">'+escapeHtml(g.specializationName)+'</b>' +
          '<button class="btn btn-sm btn-ghost" data-action="delete-protocol-guide" data-spec="'+g.specializationId+'" title="Удалить гайд">'+icon("trash","ic-sm")+'</button></div>' +
        (g.guideHtml ? '<div class="prose" style="font-size:13px;">'+renderPlainToProse(g.guideHtml)+'</div>' : '<p class="hint" style="margin:0;">Текста пока нет — только файлы.</p>') +
        renderProtocolGuideFiles(g) +
      '</div>';
    });
    var usedSpecs = protocolEditor.guides.map(function(g){ return g.specializationId; });
    var availableSpecs = specializationsList.filter(function(s){ return usedSpecs.indexOf(s.id)===-1; });
    if(availableSpecs.length){
      body += '<div class="card" style="padding:12px 14px;">' +
        '<div class="field" style="margin-bottom:8px;"><label>Специализация</label><select class="input" id="newGuideSpec">' +
          availableSpecs.map(function(s){ return '<option value="'+s.id+'">'+escapeHtml(s.name)+'</option>'; }).join('') +
        '</select></div>' +
        '<div class="field" style="margin-bottom:8px;"><label>Текст гайда</label><textarea class="input" id="newGuideText" style="height:70px;" placeholder="Как применять этот протокол в рамках этой специализации"></textarea></div>' +
        '<button type="button" class="btn btn-sm btn-primary" data-action="save-protocol-guide">Добавить гайд</button>' +
      '</div>';
    } else {
      body += '<p class="hint">Гайды добавлены под все специализации из справочника.</p>';
    }
    body += '</div>';

    if(isProtocolAdmin){
      body += '<div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line-2);">' +
        '<b style="font-size:14px;display:block;margin-bottom:10px;">Какие уроки открывают этот протокол</b>';
      (staffState.materials||[]).forEach(function(l){
        var checked = protocolEditor.lessonIds.indexOf(l.id)!==-1;
        body += '<label style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2);cursor:pointer;">' +
          '<input type="checkbox" data-action="toggle-protocol-lesson" data-id="'+l.id+'"'+(checked?' checked':'')+'>' +
          '<span style="font-size:13px;">'+escapeHtml(l.title)+'</span></label>';
      });
      body += '<button class="btn btn-sm btn-ghost" style="margin-top:12px;" data-action="save-protocol-lessons">Сохранить привязку</button>' +
      '</div>';
    }
  }

  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-protocol-editor"><div class="drawer" data-stop="1" style="width:min(600px,100%);">'+body+'</div></div>');
}

// Полоска переключения курса — видна на всех страницах персонала (не только там,
// где courseId реально используется) просто чтобы всегда было понятно, какой
// курс сейчас "активен". Один курс — полоска всё равно рисуется (без вариантов
// выбора она безобидна и заодно показывает название курса).
function renderStaffCourseSwitcher(){
  if(!staffState.coursesList.length){
    return el('<p class="section-sub" style="margin-top:-2px;">Курсов пока нет — создайте первый на странице «Курсы».</p>');
  }
  var html = '<div class="tabs" style="margin:2px 0 14px;flex-wrap:wrap;">';
  staffState.coursesList.forEach(function(c){
    html += '<button type="button" class="tab'+(c.id===staffState.activeCourseId?' active':'')+'" data-action="switch-staff-course" data-course-id="'+c.id+'">'+escapeHtml(c.title)+'</button>';
  });
  html += '</div>';
  return el(html);
}

function renderCoursesTab(){
  // Плитки курсов на всю ширину (как потоки): название, врачи, дата создания,
  // статус сертификатов; «Изменить»/«Удалить» — по наведению. Создание курса —
  // пунктирная плитка «+ Новый курс», раскрывающаяся в форму.
  var list = staffState.coursesList;
  var html = '<div class="page-wide"><div class="courses-head">' +
    '<span class="courses-count">'+list.length+' '+ruPluralClient(list.length,"курс","курса","курсов")+'</span></div>' +
    '<div class="courses-grid">';
  list.forEach(function(c){
    var isEditing = staffState.courseEditorId === c.id;
    var isDeleting = staffState.courseDeleteConfirmId === c.id;
    var isActive = staffState.activeCourseId === c.id;
    html += '<div class="card course-tile'+(isEditing||isDeleting?' busy':'')+'">';
    if(isEditing){
      html += '<b class="course-tile-title">Изменить курс</b>' +
        '<div class="field" style="margin:10px 0 8px;"><label>Название</label><input class="input" id="courseEditTitleInput" value="'+escapeHtml(staffState.courseEditorTitle)+'"></div>' +
        '<label class="course-check"><input type="checkbox" id="courseEditCertsInput"'+(staffState.courseEditorCertsEnabled?' checked':'')+'> Выдавать сертификаты по этому курсу</label>' +
        '<div class="course-tile-btns"><button class="btn btn-sm btn-primary" data-action="save-course">Сохранить</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="cancel-edit-course">Отмена</button></div>';
    } else if(isDeleting){
      html += '<b class="course-tile-title">Удалить курс?</b>' +
        '<p class="course-tile-warn">Вы уверены, что хотите удалить «'+escapeHtml(c.title)+'» безвозвратно вместе со всеми уроками, тестами и прогрессом '+c.enrolledCount+' '+ruPluralClient(c.enrolledCount,"врача","врачей","врачей")+'? Для подтверждения наберите название курса.</p>' +
        '<input class="input" id="courseDeleteConfirmInput" placeholder="'+escapeHtml(c.title)+'" style="margin-bottom:10px;">' +
        '<div class="course-tile-btns"><button class="btn btn-sm btn-danger" data-action="confirm-delete-course" data-id="'+c.id+'">Удалить курс</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="cancel-delete-course">Отмена</button></div>';
    } else {
      html += '<div class="course-tile-top"><span class="course-tile-icon">'+icon("folder")+'</span>' +
          (isActive ? '<span class="course-tile-badge">выбран сейчас</span>' : '') +
          '<div class="course-tile-actions"><button class="btn btn-sm btn-ghost" data-action="edit-course-open" data-id="'+c.id+'">Изменить</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="delete-course-open" data-id="'+c.id+'">Удалить</button></div></div>' +
        '<b class="course-tile-title">'+escapeHtml(c.title)+'</b>' +
        '<div class="course-tile-stats">' +
          '<div><b data-count="'+c.enrolledCount+'">'+c.enrolledCount+'</b><span>'+ruPluralClient(c.enrolledCount,"врач","врача","врачей")+'</span></div>' +
          '<div><b>'+(c.createdAt?fmtDateShort(c.createdAt):"—")+'</b><span>создан</span></div>' +
        '</div>' +
        '<div class="course-tile-foot"><span class="course-cert'+(c.certificatesEnabled?' on':'')+'">'+icon("badge","ic-sm")+'Сертификаты '+(c.certificatesEnabled?"выдаются":"выключены")+'</span></div>';
    }
    html += '</div>';
  });
  if(staffState.showCreateCourse){
    html += '<div class="card course-tile busy"><b class="course-tile-title">Новый курс</b>' +
      '<form id="createCourseForm" style="margin-top:10px;"><div class="field"><label>Название</label><input class="input" name="title" required placeholder="Например, «Пептидная терапия»"></div>' +
      '<div class="course-tile-btns"><button class="btn btn-sm btn-primary" type="submit">Создать</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-action="toggle-create-course">Отмена</button></div></form></div>';
  } else {
    html += '<button type="button" class="course-tile-new" data-action="toggle-create-course"><span>+</span>Новый курс</button>';
  }
  html += '</div>' + renderCourseOverview() + '</div>';
  return el(html);
}

// Обзор выбранного курса под плитками: слева — уроки с долей врачей, прошедших
// каждый (и пометками «черновик» / «открывается на N-й день»), справа — состав
// курса и распределение врачей по этапам. Всё из уже загруженных данных.
function renderCourseOverview(){
  var c = (staffState.coursesList||[]).find(function(x){ return x.id===staffState.activeCourseId; });
  if(!c) return '';
  var lessons = staffState.materials || [], students = staffState.students || [];
  var total = students.length;
  var h = '<div class="co-grid">';
  // Уроки
  h += '<div class="card co-lessons"><div class="co-head"><b>Уроки курса «'+escapeHtml(c.title)+'»</b>' +
    '<button class="btn btn-sm btn-ghost" data-action="sidebar-nav" data-key="materials">Редактировать →</button></div>';
  if(!lessons.length){
    h += '<div class="empty-state" style="padding:28px 10px;">Уроков пока нет — добавьте их в «Учебных материалах».</div>';
  } else {
    h += '<div class="co-lessons-sub">доля врачей курса, прошедших урок</div>';
    lessons.forEach(function(l, i){
      var doneN = students.filter(function(st){ return (st.completed_lessons||[]).indexOf(l.id)!==-1; }).length;
      var pct = total ? Math.round(doneN/total*100) : 0;
      var tags = (l.has_draft?'<span class="co-tag">черновик</span>':'') + (l.drip_days?'<span class="co-tag">открывается на '+l.drip_days+'-й день</span>':'');
      h += '<div class="co-lesson"><span class="co-num">'+(i+1)+'</span>' +
        '<div class="co-lesson-main"><div class="co-lesson-title"><span>'+escapeHtml(l.title)+'</span>'+tags+'</div>' +
        '<div class="co-bar"><i style="width:'+pct+'%"></i></div></div>' +
        '<span class="co-pct">'+pct+'%<small>'+doneN+' из '+total+'</small></span></div>';
    });
  }
  h += '</div>';
  // Справа: состав + врачи по этапам
  var mods = (moduleManagerState.modules||[]).length, qs = (staffState.quizAdmin||[]).length, prots = (adminProtocolsState.list||[]).length;
  h += '<div class="co-side"><div class="card co-card"><b class="co-card-title">Состав курса</b><div class="co-stats">' +
    '<div><b>'+lessons.length+'</b><span>'+ruPluralClient(lessons.length,"урок","урока","уроков")+'</span></div>' +
    '<div><b>'+mods+'</b><span>'+ruPluralClient(mods,"модуль","модуля","модулей")+'</span></div>' +
    '<div><b>'+qs+'</b><span>'+ruPluralClient(qs,"вопрос","вопроса","вопросов")+' в тесте</span></div>' +
    '<div><b>'+prots+'</b><span>'+ruPluralClient(prots,"протокол","протокола","протоколов")+'</span></div></div></div>';
  var stages = [["new","Новые","var(--muted-2)"],["in_progress","Проходят","var(--primary)"],["demo_done","Завершили демо","var(--teal)"],["certified","С сертификатом","var(--status-done)"]];
  var cnt = {}; students.forEach(function(st){ var k = studentStage(st); cnt[k] = (cnt[k]||0)+1; });
  var weekAgo = Date.now() - 7*86400000;
  var active7 = students.filter(function(st){ return st.last_seen_at && new Date(st.last_seen_at).getTime() >= weekAgo; }).length;
  h += '<div class="card co-card"><b class="co-card-title">Врачи на курсе · '+total+'</b><div class="co-stack">';
  stages.forEach(function(sg){ var n = cnt[sg[0]]||0; if(n) h += '<i style="flex:'+n+';background:'+sg[2]+'" title="'+sg[1]+': '+n+'"></i>'; });
  if(!total) h += '<i style="flex:1;background:var(--line-2)"></i>';
  h += '</div><div class="co-legend">';
  stages.forEach(function(sg){ h += '<div><span style="background:'+sg[2]+'"></span>'+sg[1]+'<b>'+(cnt[sg[0]]||0)+'</b></div>'; });
  h += '</div><div class="co-active">Заходили за последние 7 дней: <b>'+active7+'</b> из '+total+'</div></div></div>';
  return h + '</div>';
}

function renderTeamTab(){
  // Два ряда вместо двух длинных колонок — блоки в ряду близки по высоте сами,
  // без растянутой пустоты: [сотрудники | код сотрудника], [врачи по кураторам |
  // приглашение]. В «Врачах по кураторам» — назначение куратора прямо из списка.
  var myOptions = assignableRoleOptions(me.role);
  var students = staffState.students || [];
  var weekAgo = Date.now() - 7*86400000;

  var tiles = '';
  if(!staffState.staff.length){
    tiles = '<div class="card empty-state" style="padding:30px 10px;">Пока только вы.</div>';
  } else {
    tiles = '<div class="team-tiles">';
    staffState.staff.forEach(function(c){
      var isMe = c.id===me.id;
      var canManage = !isMe && canAssignRole(me.role, c.role);
      var canChangeRole = canManage && myOptions.length>1;
      tiles += '<div class="card team-tile">' +
        '<div class="team-top">'+userAvatar(c,'team-av')+'' +
          '<div class="team-who"><b>'+escapeHtml(c.name)+(isMe?' <span class="team-me">вы</span>':'')+'</b><small>'+escapeHtml(c.email||"")+'</small></div></div>' +
        '<div class="team-meta"><span class="team-role">'+roleLabel(c.role)+'</span><span>в команде с '+fmtDateShort(c.created_at)+'</span></div>';
      if(c.role==="curator"){
        var mine = students.filter(function(st){ return st.assigned_curator_id===c.id; });
        var act = mine.filter(function(st){ return st.last_seen_at && new Date(st.last_seen_at).getTime()>=weekAgo; }).length;
        var fin = mine.filter(function(st){ return st.completed; }).length;
        tiles += '<div class="team-stats">' +
          '<div><span>Врачей закреплено</span><b>'+mine.length+'</b></div>' +
          '<div><span>Активны за 7 дней</span><b>'+act+'</b></div>' +
          '<div><span>Завершили курс</span><b>'+fin+'</b></div></div>';
      } else {
        // Те же строки «подпись — число», что у куратора, — карточки в ряду
        // устроены одинаково и не гуляют по высоте и выравниванию.
        var curCount = (staffState.staff||[]).filter(function(x){ return x.role==="curator"; }).length;
        tiles += '<div class="team-stats">' +
          '<div><span>Курсов на платформе</span><b>'+(staffState.coursesList||[]).length+'</b></div>' +
          '<div><span>Врачей на курсе</span><b>'+students.length+'</b></div>' +
          '<div><span>Кураторов в команде</span><b>'+curCount+'</b></div></div>';
      }
      if(canManage){
        tiles += '<div class="team-actions">' +
          (canChangeRole ? '<select class="input" data-role-select data-id="'+c.id+'">' +
            myOptions.map(function(r){ return '<option value="'+r+'"'+(c.role===r?' selected':'')+'>'+roleLabel(r)+'</option>'; }).join("") + '</select>' : '') +
          '<button class="btn btn-sm btn-ghost" data-action="reset-staff-password" data-id="'+c.id+'" data-name="'+escapeHtml(c.name)+'">Сбросить пароль</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="remove-staff" data-id="'+c.id+'">Убрать</button></div>';
      }
      tiles += '</div>';
    });
    tiles += '</div>';
  }

  var code = '';
  if(myOptions.length && staffState.inviteCode){
    code = '<div class="card co-card team-code-card"><b class="co-card-title" style="margin-bottom:6px;">Код сотрудника</b>' +
      '<div class="team-code">'+escapeHtml(staffState.inviteCode.code)+'</div>' +
      '<p class="team-hint">Продиктуйте его отдельно (не тем же письмом, где email) тому, кого приглашаете куратором или администратором — без кода регистрация по приглашению останется обычным врачом.</p>' +
      '<p class="team-hint team-code-foot">Сменится сам '+fmtDateShort(staffState.inviteCode.expiresAt)+' в '+fmtTime(staffState.inviteCode.expiresAt)+'</p></div>';
  } else if(!myOptions.length){
    code = '<div class="card co-card"><p style="font-size:13px;color:var(--muted);margin:0;">Назначать роли может главный администратор или администратор.</p></div>';
  }

  var load = '';
  var curators = staffState.staff.filter(function(c){ return c.role==="curator"; });
  if(curators.length){
    var unassignedList = students.filter(function(st){ return !st.assigned_curator_id || !curators.some(function(c){ return c.id===st.assigned_curator_id; }); });
    var counts = curators.map(function(c){ return students.filter(function(st){ return st.assigned_curator_id===c.id; }).length; });
    var maxN = Math.max.apply(null, counts.concat([unassignedList.length,1]));
    load = '<div class="card co-card"><div class="co-head"><b>Врачи по кураторам</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="sidebar-nav" data-key="students">К врачам →</button></div><div class="load-rows">';
    curators.forEach(function(c, i){
      load += '<div class="load-row"><span class="load-name">'+escapeHtml(c.name)+'</span><div class="co-bar"><i style="width:'+Math.round(counts[i]/maxN*100)+'%"></i></div><b>'+counts[i]+'</b></div>';
    });
    load += '<div class="load-row muted"><span class="load-name">Без куратора</span><div class="co-bar"><i style="width:'+Math.round(unassignedList.length/maxN*100)+'%;background:var(--muted-2)"></i></div><b>'+unassignedList.length+'</b></div></div>';
    if(unassignedList.length){
      var opts = '<option value="" selected>Назначить…</option>' + curators.map(function(c){ return '<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>'; }).join("");
      load += '<div class="assign-h">Без куратора — назначьте прямо здесь</div>';
      unassignedList.slice(0,5).forEach(function(st){
        load += '<div class="assign-row">'+userAvatar(st)+'' +
          '<div class="assign-who" data-action="open-student" data-id="'+st.id+'"><b>'+escapeHtml(st.name)+'</b><small>'+(specNames(st)?escapeHtml(specNames(st))+' · ':'')+'с '+fmtDateShort(st.created_at)+'</small></div>' +
          '<select class="input" data-field-select="curator" data-id="'+st.id+'">'+opts+'</select></div>';
      });
      if(unassignedList.length>5) load += '<p class="team-hint" style="margin:10px 0 0;">И ещё '+(unassignedList.length-5)+' — во вкладке «Ученики».</p>';
    } else {
      load += '<p class="team-hint" style="margin:14px 0 0;">У всех врачей есть куратор.</p>';
    }
    load += '</div>';
  }

  var invite = '';
  if(myOptions.length){
    invite = '<div class="card co-card"><b class="co-card-title" style="margin-bottom:10px;">Пригласить сотрудника</b>' +
      '<form id="inviteStaffForm">' +
        '<div class="field"><label>Email</label><input class="input" type="email" name="email" required placeholder="name@clinic.ru"></div>' +
        '<div class="field"><label>Роль</label><select class="input" name="role">' + myOptions.map(function(r){ return '<option value="'+r+'">'+roleLabel(r)+'</option>'; }).join("") + '</select></div>' +
        '<button class="btn btn-primary btn-block" type="submit">Отправить приглашение</button>' +
      '</form>';
    var pending = (staffState.invites||[]).filter(function(iv){ return iv.role==="curator" || iv.role==="admin"; });
    if(pending.length){
      invite += '<div class="team-pending"><div class="team-pending-h">Ожидают регистрации · '+pending.length+'</div>';
      pending.forEach(function(iv){
        invite += '<div class="team-pending-row"><span class="ell">'+escapeHtml(iv.email)+'</span><small>'+roleLabel(iv.role)+' · '+fmtDateShort(iv.invited_at)+'</small></div>';
      });
      invite += '</div>';
    }
    invite += '</div>';
  }

  var html = '<div class="page-wide team-layout">' +
    '<div class="team-row"><div class="team-cell"><div class="courses-head"><b class="page-h" style="margin:0;">Администраторы и кураторы</b><span class="courses-count">'+staffState.staff.length+' '+ruPluralClient(staffState.staff.length,"человек","человека","человек")+'</span></div>'+tiles+'</div>' +
      '<div class="team-cell"><div class="courses-head"><b class="page-h" style="margin:0;">Приглашения</b></div>'+code+'</div></div>' +
    ((load||invite) ? '<div class="team-row">'+(load?'<div class="team-cell">'+load+'</div>':'<div></div>')+'<div class="team-cell">'+invite+'</div></div>' : '') +
  '</div>';
  return el(html);
}

/* ============================= РЕНДЕР: КАРТОЧКА ВРАЧА ============================= */
function renderStudentDrawer(){
  var s = staffState.selectedStudent;
  if(!s) return el('<div class="overlay"><div class="drawer" data-stop="1"><div class="drawer-body">Загрузка…</div></div></div>');
  var done = (s.completed_lessons||[]).length;

  var head = '<div class="drawer-head">' +
    '<div style="display:flex;gap:12px;align-items:center;"><div class="avatar-wrap">'+userAvatar(s,null,'width:42px;height:42px;font-size:15px;')+''+(s.online?'<span class="presence-dot" title="Онлайн"></span>':'')+'</div>' +
    '<div><b style="font-size:16px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:13px;color:var(--muted);">'+escapeHtml(specNames(s)||"—")+'</span>' +
    '<span style="font-size:12px;color:var(--muted-2);display:block;margin-top:2px;">'+(s.online?'<span style="color:var(--status-active);font-weight:600;">● В сети сейчас</span>':'Была в сети: '+escapeHtml(timeSince(s.last_seen_at)))+'</span></div></div>' +
    '<button class="btn btn-ghost btn-sm" data-action="close-drawer">Закрыть ✕</button></div>';

  var body = '<div class="drawer-body">' +
    '<div class="tabs"><button class="tab'+(staffState.drawerTab==="progress"?' active':'')+'" data-action="drawer-tab" data-tab="progress">Прогресс</button>' +
    '<button class="tab'+(staffState.drawerTab==="access"?' active':'')+'" data-action="drawer-tab" data-tab="access">Доступ</button>' +
    '<button class="tab'+(staffState.drawerTab==="profile"?' active':'')+'" data-action="drawer-tab" data-tab="profile">Профиль</button>' +
    '<button class="tab'+(staffState.drawerTab==="tasks"?' active':'')+'" data-action="drawer-tab" data-tab="tasks">Задания</button>' +
    '<button class="tab'+(staffState.drawerTab==="orders"?' active':'')+'" data-action="drawer-tab" data-tab="orders">Оплаты</button>' +
    '<button class="tab'+(staffState.drawerTab==="notes"?' active':'')+'" data-action="drawer-tab" data-tab="notes">Заметки</button></div>';

  if(staffState.drawerTab === "progress"){
    var enrolledIds = staffState.selectedStudentEnrollments.map(function(e){ return e.courseId; });
    var notEnrolled = staffState.coursesList.filter(function(c){ return enrolledIds.indexOf(c.id)===-1; });
    body += '<div class="field"><label>Записан на курсы</label>' +
      (staffState.selectedStudentEnrollments.length
        ? '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+staffState.selectedStudentEnrollments.map(function(e){ return magnet("neutral", e.title); }).join("")+'</div>'
        : '<p class="hint" style="margin:0;">Ни на один курс не записан.</p>') +
      (notEnrolled.length
        ? '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<select class="input" id="enrollCourseSelect" style="flex:1;">' +
              notEnrolled.map(function(c){ return '<option value="'+c.id+'">'+escapeHtml(c.title)+'</option>'; }).join("") +
            '</select>' +
            '<button class="btn btn-sm btn-ghost" data-action="enroll-student" data-id="'+s.id+'">Записать</button>' +
          '</div>'
        : '') +
    '</div>';
    body += '<div class="progress-label">'+done+' из '+((staffState.materials||[]).length||done)+' уроков'+(typeof s.quiz_score==="number"?' · тест: '+s.quiz_score+'%':'')+'</div>';
    if(s.completed){
      if(staffState.certificatesEnabled){
        body += '<div class="card" style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
          '<b style="font-size:14px;">Сертификат: '+(s.certificate_status==="issued"?"выдан":"ожидает выдачи")+'</b>' +
          (s.certificate_status==="issued"
            ? '<a class="btn btn-sm btn-ghost" href="api/staff/students/'+s.id+'/certificate/download?courseId='+encodeURIComponent(staffState.activeCourseId||"")+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+' Скачать PDF</a>'
            : '<button class="btn btn-sm btn-primary" data-action="issue-certificate" data-id="'+s.id+'">Выдать сертификат</button>') +
        '</div>';
      } else {
        body += '<div class="card" style="padding:14px 16px;">' +
          '<b style="font-size:14px;">Демо-курс пройден · тест '+s.quiz_score+'%</b>' +
          '<p style="font-size:13px;color:var(--muted);margin:4px 0 0;">Сертификаты на демо-курсе не выдаются.</p>' +
        '</div>';
      }
    }
    if(s.requested_full_access){
      body += '<div class="card" style="padding:14px 16px;margin-top:12px;background:var(--accent-tint);border-color:transparent;"><b style="font-size:14px;">Оставил(а) заявку на полную программу</b></div>';
    }
  } else if(staffState.drawerTab === "access"){
    var expiresAtRaw = s.access_expires_at ? String(s.access_expires_at).slice(0,10) : "";
    var isBlocked = !!s.access_blocked;
    var todayIso = isoDate(new Date());
    var isExpired = expiresAtRaw && expiresAtRaw < todayIso;
    var statusText = isBlocked ? "Доступ заблокирован" : (isExpired ? "Доступ истёк "+fmtDate(expiresAtRaw) : (expiresAtRaw ? "Доступ активен до "+fmtDate(expiresAtRaw) : "Доступ бессрочный"));

    body += '<div class="card" style="padding:14px 16px;margin-bottom:16px;'+((isBlocked||isExpired)?'background:var(--danger-tint);':'background:var(--primary-tint);')+'border-color:transparent;"><b style="font-size:14px;">'+statusText+'</b></div>' +
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
  } else if(staffState.drawerTab === "tasks"){
    body += renderStudentAssignTab();
  } else if(staffState.drawerTab === "orders"){
    body += renderStudentOrdersTab(s);
  } else if(staffState.drawerTab === "notes"){
    body += '<p class="hint" style="margin-top:0;">Видно только персоналу — врач эти записи не видит.</p>' +
      '<div class="field"><textarea class="input" id="studentNoteInput" style="height:64px;" placeholder="Например: пропускает эфиры, стоит позвонить"></textarea></div>' +
      '<button class="btn btn-sm btn-primary" data-action="add-student-note" data-id="'+s.id+'">Добавить заметку</button>' +
      '<div style="margin-top:18px;">';
    if(!staffState.notes.length){
      body += '<p class="hint">Заметок пока нет.</p>';
    } else {
      staffState.notes.forEach(function(n){
        body += '<div style="padding:10px 0;border-bottom:1px solid var(--line-2);"><p style="font-size:14px;margin:0 0 4px;">'+escapeHtml(n.body)+'</p>' +
          '<span style="font-size:12px;color:var(--muted-2);">'+escapeHtml(n.author_name||"")+' · '+fmtDate(n.created_at)+' '+fmtTime(n.created_at)+'</span></div>';
      });
    }
    body += '</div>';
  } else {
    var curatorSelectOpts = '<option value=""'+(!s.assigned_curator_id?' selected':'')+'>Не назначен</option>' +
      directory.map(function(c){ return '<option value="'+c.id+'"'+(s.assigned_curator_id===c.id?' selected':'')+'>'+escapeHtml(c.name)+'</option>'; }).join("");
    var productSelectOpts = Object.keys(PRODUCTS).map(function(k){ return '<option value="'+k+'"'+((s.product||"longevity")===k?' selected':'')+'>'+escapeHtml(PRODUCTS[k])+'</option>'; }).join("");
    var paymentSelectOpts = Object.keys(PAYMENT_LABELS).map(function(k){ return '<option value="'+k+'"'+((s.payment_status||"unpaid")===k?' selected':'')+'>'+escapeHtml(PAYMENT_LABELS[k])+'</option>'; }).join("");
    body += '<div class="field"><label>Имя и фамилия</label><input class="input" id="studentProfileName" value="'+escapeHtml(staffState.editName)+'"></div>' +
      renderSpecPicker("staff-current", "Текущая специализация", null, staffState.editSpecializationIds) +
      '<div class="field"><label>Email</label><div class="input" style="background:var(--line-2);">'+escapeHtml(s.email||"—")+'</div></div>' +
      '<div class="field"><label>Телефон</label><input class="input" id="studentProfilePhone" value="'+escapeHtml(staffState.editPhone)+'"></div>' +
      '<div class="field"><label>Место работы</label><input class="input" id="studentProfileWorkplace" value="'+escapeHtml(staffState.editWorkplace)+'"></div>' +
      '<button class="btn btn-sm btn-ghost" data-action="save-student-profile" data-id="'+s.id+'">Сохранить данные</button>' +
      '<div class="field" style="margin-top:18px;"><label>Дата регистрации</label><div class="input" style="background:var(--line-2);">'+fmtDate(s.created_at)+'</div></div>' +
      '<div class="field"><label>Продукт</label><select class="input" data-field-select="product" data-id="'+s.id+'">'+productSelectOpts+'</select></div>' +
      ((toolsState.orders.list||[]).some(function(o){ return o.user_id===s.id; })
        ? '<div class="field"><label>Оплата</label><div class="input input-ro pay-ro"><span>'+escapeHtml(PAYMENT_LABELS[s.payment_status||"unpaid"])+'</span><button type="button" class="link-btn" data-action="drawer-tab" data-tab="orders">по заказам →</button></div></div>'
        : '<div class="field"><label>Оплата</label><select class="input" data-field-select="payment" data-id="'+s.id+'">'+paymentSelectOpts+'</select></div>') +
      '<div class="field"><label>Ответственный куратор</label><select class="input" data-field-select="curator" data-id="'+s.id+'">'+curatorSelectOpts+'</select></div>' +
      '<button class="btn btn-ghost" style="margin-top:6px;" data-action="reset-student-password" data-id="'+s.id+'" data-name="'+escapeHtml(s.name)+'">Сбросить пароль</button>';
  }
  body += '</div>';
  // Полноценная страница врача (раньше — боковая панель): шапка с фото, данными
  // и ключевыми цифрами, ниже — те же вкладки «Прогресс/Доступ/Профиль/Заметки».
  var total = (staffState.materials||[]).length || done;
  var stream = s.stream_id ? (calendarState.streams||[]).find(function(x){ return x.id===s.stream_id; }) : null;
  var curator = s.assigned_curator_id ? (directory||[]).find(function(x){ return x.id===s.assigned_curator_id; }) : null;
  var stage = studentStage(s);
  var hero = '<div class="card profile-hero student-hero">' +
    '<div class="profile-cover aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
    '<div class="profile-main"><div class="profile-photo avatar-wrap">'+userAvatar(s,"profile-av")+(s.online?'<span class="presence-dot big" title="Онлайн"></span>':'')+'</div>' +
      '<div class="profile-id"><span class="profile-kicker">Профиль врача</span><h1>'+escapeHtml(s.name)+'</h1>' +
        '<div class="profile-tags">'+magnet(stage==="certified"?"done":(stage==="demo_done"?"attention":(stage==="in_progress"?"active":"neutral")), STAGE_LABELS[stage]) +
          (s.specializations||[]).map(function(n){ return '<span class="profile-chip">'+escapeHtml(n)+'</span>'; }).join("") +
          '<span class="profile-chip">'+escapeHtml(stream?stream.name:"без потока")+'</span>' +
          (curator?'<span class="profile-chip">куратор: '+escapeHtml(curator.name)+'</span>':'') + '</div>' +
        '<div class="profile-contacts"><span>'+escapeHtml(s.email||"")+'</span>'+(s.phone?'<span>'+escapeHtml(s.phone)+'</span>':'')+(s.workplace?'<span>'+escapeHtml(s.workplace)+'</span>':'')+
          '<span>'+(s.online?'<b style="color:var(--status-active);">● в сети сейчас</b>':'был(а) в сети: '+escapeHtml(timeSince(s.last_seen_at)))+'</span></div>' +
      '</div>' +
      '<div class="profile-stats"><div><b>'+done+' / '+total+'</b><span>уроков</span></div>' +
        '<div><b>'+(typeof s.quiz_score==="number"?s.quiz_score+'%':'—')+'</b><span>итоговый тест</span></div>' +
        '<div><b>'+fmtDateShort(s.created_at)+'</b><span>регистрация</span></div></div>' +
    '</div></div>';
  return el('<div class="page-wide student-page"><div class="student-page-top"><button class="back-link" data-action="close-drawer">← Назад</button>' +
    '<button class="btn btn-ghost btn-sm" data-action="impersonate-student" data-id="'+s.id+'" title="Открыть кабинет врача в режиме просмотра">'+icon("eye","ic-sm")+' Войти как врач</button></div>'+hero+
    '<div class="card student-page-body">'+body+'</div></div>');
}

// Общая точка входа для переключения раздела врача — используется и прямыми
// ссылками внутри страниц (data-action="student-tab"), и боковой навигацией
// (sidebar-nav), поэтому navKey передаётся отдельно от tab (пункт меню может
// подсвечиваться не так, как называется вкладка).
async function applyStudentTab(tab, navKey){
  studentState.tab = tab;
  studentState.navKey = navKey || tab;
  if(tab==="schedule") localStorage.setItem("lms-viewed-schedule-"+me.id, "1");
  if(tab==="notifications") await loadNotifications();
  if(tab==="protocols" && !studentState.protocolsLoaded) await loadProtocols();
  render();
  if(tab==="materials" && studentState.materialsAutoFocus){
    var searchInp = document.getElementById("materialsSearchInput");
    if(searchInp) searchInp.focus();
    studentState.materialsAutoFocus = false;
  }
}

// Общее для клика по пункту сайдбара и для открытия ссылки вида "?tab=…" в новой
// вкладке (см. sidebarItem — там теперь настоящий href) — раньше это было только
// внутри обработчика клика, поэтому переиспользовать при загрузке было нельзя.
async function navigateToTab(navKey){
  mobileNavOpen = false;
  if(navKey==="profile"){
    if(view==="student"){ studentState.tab="profile"; studentState.navKey="profile"; }
    else { staffState.mainTab="profile"; staffState.navKey="profile"; }
    profileEditor.name=me.name||""; profileEditor.phone=me.phone||""; profileEditor.workplace=me.workplace||"";
    profileEditor.specializationIds=(me.specializationIds||[]).slice();
    profileEditor.interestIds=(me.interestIds||[]).slice();
    specPickerOpen=null;
    if(view==="staff"){ staffState.selectedStudentId=null; staffState.selectedStudent=null; }
    render();
    // Сеансы и заказы — одним обновлением экрана, а не двумя подряд.
    window.scrollTo(0,0);
    await Promise.all([loadMySessions(), view==="student" ? loadMyOrders() : null]);
    render();
    return;
  }
  if(view==="student"){
    // Новый раздел всегда открывается с начала, а не на прокрутке прошлого.
    if(navKey==="materials"){ studentState.materialsAutoFocus=false; await applyStudentTab("materials","materials"); window.scrollTo(0,0); return; }
    await applyStudentTab(navKey, navKey);
    window.scrollTo(0,0);
    return;
  }
  if(staffState.lessonPageId && !lpLeaveOk()) return;
  if(protocolEditor.open && staffState.mainTab==="protocols" && !prLeaveOk()) return;
  if(glossaryAdmin.edit && glossaryAdmin.dirty && !window.confirm("Уйти без сохранения? Изменения термина пропадут.")) return;
  glossaryAdmin.edit = null; glossaryAdmin.dirty = false;
  if(navKey==="modules") navKey = "materials";
  staffState.navKey = navKey;
  staffState.mainTab = navKey;
  // Раздел из меню всегда открывается списком — а не последним открытым уроком/протоколом.
  if(staffState.lessonPageId){ lpCloseEditors(); staffState.lessonPageId = null; }
  protocolEditor.open = false; staffState.lsMenu = null;
  // Открытая страница врача заменяет содержимое раздела — без сброса клик по
  // меню переключал бы пункт, а на экране оставался бы врач.
  staffState.selectedStudentId = null; staffState.selectedStudent = null;
  render();
  window.scrollTo(0,0);
  if(["assignments","feed","orders","products","surveys"].indexOf(navKey)!==-1){ await loadToolsSection(navKey); render(); }
  if(navKey==="notifications" && notifState.unreadCount){ api("/notifications/read-all", { method:"POST" }).then(loadNotifications).then(render).catch(function(){}); }
}

/* ============================= СОБЫТИЯ ============================= */
/* ============================= ЗАДАНИЯ, ЛЕНТА ОТВЕТОВ, ЗАКАЗЫ, АНКЕТЫ ============================= */
// Разделы «как в GetCourse»: проверка заданий к урокам, лента всех ответов
// врачей, продукты/заказы/рассрочки и анкеты. Данные грузятся лениво — при
// заходе в раздел (loadToolsSection), счётчик непроверенных — вместе с данными
// панели (бейдж в меню).
var toolsState = {
  assign:{ status:"pending", lessonId:"", list:[], counts:{pending:0,accepted:0,returned:0}, loaded:false, comments:{}, openHistory:{}, busy:null },
  feed:{ type:"all", items:[], loaded:false },
  orders:{ filter:"all", q:"", list:[], summary:null, loaded:false, open:null, draft:null, busy:false },
  products:{ list:[], loaded:false, editing:null },
  surveys:{ list:[], loaded:false, editing:null, results:null, resultsId:null },
  assignEditor:null,
  studentAssign:[]
};
var studentTools = { surveys:[], fillId:null, answers:{}, surveyError:"", orders:[], ordersLoaded:false, taskDraft:{}, taskEditing:{} };
var SURVEY_TYPE_LABELS = { single:"Один вариант", multi:"Несколько вариантов", scale:"Шкала", text:"Свободный ответ" };
var ORDER_STATUS = { "new":["neutral","Ждёт оплаты"], partial:["attention","Оплачен частично"], paid:["done","Оплачен"], cancelled:["neutral","Отменён"] };

function isAdminRole(){ return me && (me.role==="admin" || me.role==="super_admin"); }
function fmtMoney(n){ return (Number(n)||0).toLocaleString("ru-RU")+" ₽"; }
function fmtDay(v){ var d = dpParse(v); return d ? fmtDateShort(d) : "—"; }
function todayIso(){ return dpIso(new Date()); }
// Номер урока — по текущему порядку в «Учебных материалах» (idx в базе после
// перестановок может идти с пропусками).
function lessonNo(lessonId, idx){
  var i = (staffState.materials||[]).findIndex(function(l){ return l.id===lessonId; });
  return i!==-1 ? i+1 : (typeof idx==="number" ? idx+1 : "");
}
// Название раздела уже в общем заголовке страницы (STAFF_PAGE_TITLES) — здесь
// только пояснение и кнопки справа; title оставлен для читаемости вызовов.
function toolsHead(title, sub, right){
  return '<div class="tools-head"><div>'+(sub?'<p>'+sub+'</p>':'')+'</div>'+(right?'<div class="tools-head-r">'+right+'</div>':'')+'</div>';
}
function starsHtml(n){ var h=''; for(var i=1;i<=5;i++) h += '<span class="'+(i<=n?'on':'')+'">'+icon("star","ic-sm")+'</span>'; return h; }
function splitAmountClient(total, n){ var base=Math.floor(total/n), parts=[]; for(var i=0;i<n;i++) parts.push(base); parts[0]+=total-base*n; return parts; }
function addMonthsIso(iso, k){
  var d = dpParse(iso) || new Date(), day = d.getDate();
  var t = new Date(d.getFullYear(), d.getMonth()+k, 1);
  var last = new Date(t.getFullYear(), t.getMonth()+1, 0).getDate();
  t.setDate(Math.min(day, last));
  return dpIso(t);
}
// Фоновое обновление (раз в 30с) не должно выбивать курсор из поля, где человек
// сейчас пишет ответ или комментарий.
function isTypingNow(){
  // Открытый календарь или выпадающий список render() закрыл бы — тоже «занят».
  if(datePop || selPop || specPickerOpen || (dashboardState && dashboardState.openFilterMenu)) return true;
  if(hasUnsavedInput()) return true;
  var a = document.activeElement;
  return !!(a && (a.tagName==="TEXTAREA" || (a.tagName==="INPUT" && /^(text|search|email|tel|number|url|password)$/.test(a.type)) || a.isContentEditable));
}

// Многие формы (редактор урока, эфир, протокол, вопрос теста…) держат введённое
// только в самих полях — render() вернул бы их к исходным значениям. Поэтому фоновое
// обновление не перерисовывает экран, пока открыт диалог/панель или в любом поле
// есть изменения, которых ещё не было на момент отрисовки.
function fieldIsChanged(f){
  if(f.type==="file" || f.type==="hidden") return false;
  if(f.type==="checkbox" || f.type==="radio") return f.checked!==f.defaultChecked;
  if(f.tagName==="SELECT"){
    var def = [].findIndex.call(f.options, function(o){ return o.defaultSelected; });
    return f.selectedIndex !== (def===-1 ? 0 : def);
  }
  return f.value!==f.defaultValue;
}
function overlayHasUnsaved(action, overlayEl){
  if(action==="overlay-close-survey") return !!(toolsState.surveys.editing && toolsState.surveys.editing._dirty);
  if(action==="overlay-close-assign-editor") return !!(toolsState.assignEditor && toolsState.assignEditor._dirty);
  if(action==="overlay-close-order-draft") return !!(toolsState.orders.draft && toolsState.orders.draft._dirty);
  if(action==="overlay-close-product") return !!(toolsState.products.editing && toolsState.products.editing._dirty);
  if(action==="overlay-close-lesson-editor" && lessonEditor._origHtml!==undefined && lessonEditor.html!==lessonEditor._origHtml) return true;
  return [].some.call(overlayEl.querySelectorAll("input,textarea,select"), fieldIsChanged);
}
function hasUnsavedInput(){
  var app = document.getElementById("app");
  if(!app) return false;
  if(app.querySelector(".overlay")) return true;
  var ed = app.querySelector("[contenteditable=true]");
  if(ed && ed.getAttribute("data-initial")!==null && ed.innerHTML!==ed.getAttribute("data-initial")) return true;
  // Без явно отмеченного пункта в списке браузер выбирает первый — это не изменение.
  return [].some.call(app.querySelectorAll("input,textarea,select"), fieldIsChanged);
}

async function loadAssignments(){
  var p = new URLSearchParams(); p.set("status", toolsState.assign.status);
  if(staffState.activeCourseId) p.set("courseId", staffState.activeCourseId);
  if(toolsState.assign.lessonId) p.set("lessonId", toolsState.assign.lessonId);
  try{ var r = await api("/assignments?"+p.toString()); toolsState.assign.list = r.submissions; toolsState.assign.counts = r.counts; toolsState.assign.loaded = true; }
  catch(e){ showToast(e.message); }
}
async function loadAssignCounts(){
  try{ var r = await api("/assignments?status=pending"+(staffState.activeCourseId?"&courseId="+encodeURIComponent(staffState.activeCourseId):"")); toolsState.assign.counts = r.counts; }catch(e){}
}
async function loadFeed(){
  var p = new URLSearchParams(); p.set("type", toolsState.feed.type);
  if(staffState.activeCourseId) p.set("courseId", staffState.activeCourseId);
  try{ var r = await api("/assignments/feed?"+p.toString()); toolsState.feed.items = r.items; toolsState.feed.loaded = true; }catch(e){ showToast(e.message); }
}
async function loadOrders(){
  try{ var r = await api("/orders"); toolsState.orders.list = r.orders; toolsState.orders.summary = r.summary; toolsState.orders.loaded = true; }catch(e){}
}
async function loadProducts(){
  try{ var r = await api("/orders/products"); toolsState.products.list = r.products; toolsState.products.loaded = true; }catch(e){ showToast(e.message); }
}
async function loadSurveysAdmin(){
  var S = toolsState.surveys;
  try{ var r = await api("/surveys"); S.list = r.surveys; S.loaded = true; }catch(e){ showToast(e.message); return; }
  if(!S.list.some(function(x){ return x.id===S.resultsId; })) S.resultsId = S.list.length ? S.list[0].id : null;
  if(S.resultsId) await loadSurveyResults(S.resultsId);
}
async function loadSurveyResults(id){
  try{ var r = await api("/surveys/"+id+"/results"); if(toolsState.surveys.resultsId===id) toolsState.surveys.results = r; }catch(e){ showToast(e.message); }
}
async function loadToolsSection(key){
  if(key==="assignments") await loadAssignments();
  else if(key==="feed") await loadFeed();
  else if(key==="orders") await Promise.all([loadOrders(), loadProducts()]);
  else if(key==="products") await Promise.all([loadProducts(), loadOrders()]);
  else if(key==="surveys") await loadSurveysAdmin();
}
async function loadStudentTools(){
  try{ var r = await api("/surveys/mine"); studentTools.surveys = r.surveys; }catch(e){}
}
async function loadMyOrders(){
  try{ var r = await api("/orders/mine"); studentTools.orders = r.orders; studentTools.ordersLoaded = true; }catch(e){}
}

/* ---------- Проверка заданий ---------- */

function renderAssignmentsTab(){
  var A = toolsState.assign, c = A.counts || {};
  var lessons = staffState.materials || [];
  var withTask = lessons.filter(function(l){ return l.assignment_prompt; });
  var lessonSel = '<select class="input tools-select" data-tchange="assign-lesson"><option value="">Все уроки</option>' +
    lessons.map(function(l,i){ return '<option value="'+l.id+'"'+(A.lessonId===l.id?' selected':'')+'>Урок '+(i+1)+'. '+escapeHtml(l.title)+'</option>'; }).join('') + '</select>';
  var html = '<div class="page-wide">' + toolsHead("Проверка заданий",
    "Ответы врачей на задания к урокам. Примите ответ или верните на доработку с комментарием — врач сразу получит уведомление, а принятый ответ засчитает урок.", lessonSel);
  var tabs = [["pending","На проверке",c.pending],["returned","На доработке",c.returned],["accepted","Принятые",c.accepted],["all","Все",null]];
  html += '<div class="tabs">' + tabs.map(function(t){
    return '<button type="button" class="tab'+(A.status===t[0]?' active':'')+'" data-action="assign-status" data-status="'+t[0]+'">'+t[1]+(t[2]?'<span class="tab-count">'+t[2]+'</span>':'')+'</button>';
  }).join('') + '</div>';
  if(!A.loaded){ return el(html + '<div class="card empty-state">Загрузка…</div></div>'); }
  if(!A.list.length){
    var txt = A.status==="pending"
      ? (withTask.length ? '<b>Все ответы проверены</b>Новые ответы появятся здесь сами — и в уведомлениях.' : '<b>Заданий пока нет</b>Ни у одного урока нет задания. Добавьте его в «Учебных материалах» — кнопка «Задание» у урока.')
      : '<b>Здесь пусто</b>Ответов с таким статусом нет.';
    html += '<div class="card empty-state tools-empty"><div class="big">'+icon("task","ic-lg")+'</div>'+txt +
      (A.status==="pending" && !withTask.length && isAdminRole() ? '<div><button class="btn btn-sm btn-primary" data-action="sidebar-nav" data-key="materials">К учебным материалам →</button></div>' : '') + '</div></div>';
    return el(html);
  }
  html += '<div class="tk-list">' + A.list.map(renderAssignmentCard).join('') + '</div></div>';
  return el(html);
}

function renderAssignHistoryEntry(x){
  var label = x.kind==="submit" ? "Ответ врача" : (x.kind==="return" ? "Возвращено" : "Принято") + (x.name ? " · "+escapeHtml(x.name) : "");
  return '<div class="tk-h '+x.kind+'"><span>'+label+' · '+fmtDateShort(x.at)+', '+fmtTime(x.at)+'</span>'+(x.text?'<p>'+escapeHtml(x.text)+'</p>':'')+'</div>';
}

function renderAssignmentCard(s){
  var A = toolsState.assign;
  var h = s.history || [], lastSub = -1;
  h.forEach(function(x,i){ if(x.kind==="submit") lastSub = i; });
  var earlier = lastSub>0 ? h.slice(0,lastSub) : [];
  var statusMag = s.status==="pending" ? magnet("attention","Ждёт проверки") : (s.status==="accepted" ? magnet("done","Принято") : magnet("blocked","На доработке"));
  var html = '<div class="card tk-card"><div class="tk-main">' +
    '<div class="tk-top"><div class="who-cell tk-who" data-action="open-student" data-id="'+s.user_id+'">'+userAvatar({ id:s.user_id, name:s.student_name, avatar_url:s.avatar_url }) +
      '<div><b>'+escapeHtml(s.student_name)+'</b><span>Урок '+lessonNo(s.lesson_id, s.lesson_idx)+' · '+escapeHtml(s.lesson_title)+'</span></div></div>' +
      '<div class="tk-meta">'+statusMag+'<span>'+escapeHtml(timeSince(s.submitted_at))+(s.attempts>1?' · попытка '+s.attempts:'')+'</span></div></div>' +
    '<div class="tk-answer">'+escapeHtml(s.answer)+'</div></div><div class="tk-side">' +
    '<div class="tk-prompt"><span>Задание'+(s.assignment_required?' · стоп-урок':'')+'</span><p>'+escapeHtml(s.assignment_prompt||"")+'</p></div>';
  if(earlier.length){
    var open = !!A.openHistory[s.id];
    html += '<button type="button" class="tk-hist-toggle" data-action="assign-history" data-id="'+s.id+'">'+icon("repeat","ic-sm")+(open?' Скрыть':' Показать')+' прошлые попытки</button>';
    if(open) html += '<div class="tk-history">'+earlier.map(renderAssignHistoryEntry).join('')+'</div>';
  }
  if(s.status==="pending"){
    var busy = A.busy===s.id;
    html += '<div class="tk-review"><textarea class="input" rows="2" data-tbind="assign-comment" data-id="'+s.id+'" placeholder="Комментарий врачу — обязателен, если возвращаете на доработку">'+escapeHtml(A.comments[s.id]||"")+'</textarea>' +
      '<div class="tk-actions"><button class="btn btn-sm btn-ghost" data-action="assign-review" data-decision="return" data-id="'+s.id+'"'+(busy?' disabled':'')+'>Вернуть на доработку</button>' +
      '<button class="btn btn-sm btn-primary" data-action="assign-review" data-decision="accept" data-id="'+s.id+'"'+(busy?' disabled':'')+'>'+icon("check","ic-sm")+' Принять</button></div></div>';
  } else {
    html += '<div class="tk-verdict '+s.status+'"><b>'+(s.status==="accepted"?"Принято":"Возвращено на доработку")+'</b>'+
      '<span>'+[s.reviewer_name?escapeHtml(s.reviewer_name):"", s.reviewed_at?fmtDateShort(s.reviewed_at):""].filter(Boolean).join(" · ")+'</span>' +
      (s.curator_comment?'<p>'+escapeHtml(s.curator_comment)+'</p>':'')+'</div>';
  }
  return html + '</div></div>';
}

// Настройка задания у урока — отдельное окошко из «Учебных материалов», не
// связано с черновиком/публикацией текста урока.
function renderAssignEditorModal(){
  var a = toolsState.assignEditor;
  var body = '<div class="drawer-head"><div><b style="font-size:16px;">Задание к уроку</b><div class="set-muted">'+escapeHtml(a.title)+'</div></div><button class="btn btn-ghost btn-sm" data-action="assign-editor-close">Закрыть ✕</button></div>' +
    '<div class="drawer-body">' +
      '<div class="field"><label>Что должен сделать врач</label><textarea class="input" rows="6" data-tbind="ae.prompt" placeholder="Например: разберите пациента из своей практики по схеме из урока — жалобы, анализы, что назначили бы">'+escapeHtml(a.prompt)+'</textarea>' +
        '<p class="hint">Врач увидит задание отдельным шагом урока и ответит текстом. Куратор примет ответ или вернёт с комментарием.</p></div>' +
      '<label class="check-line"><input type="checkbox" data-tbind="ae.required"'+(a.required?' checked':'')+'><span><b>Стоп-урок</b>урок засчитается только после того, как куратор примет ответ</span></label>' +
      '<div class="modal-actions">' +
        (a.hadTask ? '<button class="btn btn-ghost" data-action="assign-editor-remove">Убрать задание</button>' : '<span></span>') +
        '<button class="btn btn-primary" data-action="assign-editor-save">Сохранить</button></div>' +
    '</div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-assign-editor"><div class="drawer modal" data-stop="1" style="width:min(560px,100%);">'+body+'</div></div>');
}

/* ---------- Лента ответов ---------- */

function renderFeedItem(it){
  var who = '<b class="fd-name" data-action="open-student" data-id="'+it.student_id+'">'+escapeHtml(it.student_name)+'</b>';
  var head, body = '', tag = '', ic;
  if(it.type==="assignment"){
    ic = "task";
    head = who+' ответил(а) на задание к уроку '+lessonNo(null, it.lesson_idx)+' «'+escapeHtml(it.lesson_title)+'»';
    tag = it.status==="pending" ? magnet("attention","ждёт проверки") : (it.status==="accepted" ? magnet("done","принято") : magnet("blocked","на доработке"));
    body = '<div class="fd-quote">'+escapeHtml(it.text)+'</div>';
    if(it.status==="pending") body += '<button class="btn btn-sm btn-ghost fd-go" data-action="sidebar-nav" data-key="assignments">Проверить →</button>';
  } else if(it.type==="feedback"){
    ic = "star";
    head = who+' оценил(а) модуль «'+escapeHtml(it.module_title)+'»';
    tag = '<span class="fd-stars">'+starsHtml(it.rating)+'</span>';
    if(it.text) body = '<div class="fd-quote">'+escapeHtml(it.text)+'</div>';
  } else {
    ic = "poll";
    head = who+' заполнил(а) анкету «'+escapeHtml(it.survey_title)+'»';
    body = '<div class="fd-lines">'+(it.lines||[]).slice(0,4).map(function(l){ return '<div><span>'+escapeHtml(l.q)+'</span>'+escapeHtml(l.a)+'</div>'; }).join('') +
      ((it.lines||[]).length>4 ? '<em>ещё '+(it.lines.length-4)+' '+ruPluralClient(it.lines.length-4,"ответ","ответа","ответов")+' — в результатах анкеты</em>' : '') + '</div>';
  }
  return '<div class="fd-item"><div class="fd-av">'+userAvatar({ id:it.student_id, name:it.student_name, avatar_url:it.avatar_url })+'<span class="fd-kind '+it.type+'">'+icon(ic,"ic-sm")+'</span></div>' +
    '<div class="fd-main"><div class="fd-head"><span class="fd-title">'+head+'</span>'+tag+'<span class="fd-time">'+fmtTime(it.at)+'</span></div>'+body+'</div></div>';
}

function renderFeedTab(){
  var F = toolsState.feed;
  var html = '<div class="page-wide">' + toolsHead("Лента ответов", "Всё, что врачи пишут по обучению, — ответы на задания, отзывы о модулях и анкеты — одной лентой, от новых к старым.");
  html += '<div class="seg tools-seg">' + [["all","Все"],["assignment","Задания"],["feedback","Отзывы о модулях"],["survey","Анкеты"]].map(function(x){
    return '<button type="button" class="seg-btn'+(F.type===x[0]?' on':'')+'" data-action="feed-type" data-type="'+x[0]+'">'+x[1]+'</button>';
  }).join('') + '</div>';
  if(!F.loaded) return el(html + '<div class="card empty-state">Загрузка…</div></div>');
  if(!F.items.length){
    return el(html + '<div class="card empty-state tools-empty"><div class="big">'+icon("feed","ic-lg")+'</div><b>Ответов пока нет</b>Когда врачи начнут отвечать на задания, оценивать модули и заполнять анкеты, всё появится здесь.</div></div>');
  }
  html += '<div class="card co-card fd-card">';
  var lastDay = "";
  F.items.forEach(function(it){
    var d = new Date(it.at), day = isSameCalendarDay(d, new Date()) ? "Сегодня" : d.toLocaleDateString("ru-RU",{ weekday:"long", day:"numeric", month:"long" });
    if(day!==lastDay){ html += '<div class="feed-day">'+day+'</div>'; lastDay = day; }
    html += renderFeedItem(it);
  });
  return el(html + '</div></div>');
}

/* ---------- Заказы и оплаты ---------- */

function orderStatusMag(o){
  if(o.status!=="cancelled" && o.status!=="paid" && o.overdue_amount>0) return magnet("blocked","Просрочен платёж");
  var s = ORDER_STATUS[o.status] || ["neutral", o.status];
  return magnet(s[0], s[1]);
}
function orderMatches(o, f){
  if(f==="waiting") return o.status==="new" || o.status==="partial";
  if(f==="installments") return o.installments>1 && o.status!=="cancelled";
  if(f==="overdue") return o.overdue_amount>0 && o.status!=="cancelled" && o.status!=="paid";
  if(f==="paid") return o.status==="paid";
  if(f==="cancelled") return o.status==="cancelled";
  return true;
}
function renderOrdersTab(){
  var O = toolsState.orders, S = O.summary || { received:0, receivedThisMonth:0, expected:0, overdue:0, overdueOrders:0, ordersCount:0 };
  var html = '<div class="page-wide">' + toolsHead("Заказы и оплаты",
    "Продукт, сумма и график платежей по каждому врачу. Отмечайте поступившие платежи — статус оплаты у врача обновится сам, а после полной оплаты откроется курс продукта.",
    '<button class="btn btn-primary" data-action="order-new">+ Новый заказ</button>');
  var total = S.received + S.expected;
  html += '<div class="stat-row">' +
    '<div class="card stat"><div class="num">'+fmtMoney(S.receivedThisMonth)+'</div><div class="lbl">Получено в этом месяце</div><div class="stat-bar"><i style="width:'+(S.received?Math.round(S.receivedThisMonth/S.received*100):0)+'%"></i></div></div>' +
    '<div class="card stat"><div class="num">'+fmtMoney(S.received)+'</div><div class="lbl">Получено всего · <b>'+S.ordersCount+'</b> '+ruPluralClient(S.ordersCount,"заказ","заказа","заказов")+'</div><div class="stat-bar"><i style="width:'+(total?Math.round(S.received/total*100):0)+'%"></i></div></div>' +
    '<div class="card stat"><div class="num">'+fmtMoney(S.expected)+'</div><div class="lbl">Ожидается по графику</div><div class="stat-bar"><i style="width:'+(total?Math.round(S.expected/total*100):0)+'%"></i></div></div>' +
    '<div class="card stat'+(S.overdue?' stat-warn':'')+'"><div class="num">'+fmtMoney(S.overdue)+'</div><div class="lbl">Просрочено'+(S.overdueOrders?' · <b>'+S.overdueOrders+'</b> '+ruPluralClient(S.overdueOrders,"заказ","заказа","заказов"):'')+'</div><div class="stat-bar"><i style="width:'+(S.expected?Math.round(S.overdue/S.expected*100):0)+'%"></i></div></div>' +
  '</div>';
  var filters = [["all","Все"],["waiting","Ждут оплаты"],["installments","Рассрочки"],["overdue","Просрочено"],["paid","Оплачены"],["cancelled","Отменены"]];
  html += '<div class="card co-card ord-card"><div class="ord-bar"><div class="tabs ord-tabs">' + filters.map(function(f){
      var n = O.list.filter(function(o){ return orderMatches(o, f[0]); }).length;
      return '<button type="button" class="tab'+(O.filter===f[0]?' active':'')+'" data-action="order-filter" data-filter="'+f[0]+'">'+f[1]+(n&&f[0]!=="all"?'<span class="tab-count">'+n+'</span>':'')+'</button>';
    }).join('') + '</div>' +
    '<input class="input ord-search" id="ordersSearch" data-tbind="order-q" placeholder="Поиск: врач, продукт, №" value="'+escapeHtml(O.q)+'"></div>';
  var q = O.q.trim().toLowerCase();
  var list = O.list.filter(function(o){ return orderMatches(o, O.filter) && (!q || (o.student_name+" "+o.student_email+" "+o.title+" №"+o.number).toLowerCase().indexOf(q)!==-1); });
  if(!O.loaded){ html += '<div class="empty-state">Загрузка…</div>'; }
  else if(!O.list.length){
    html += '<div class="empty-state tools-empty"><div class="big">'+icon("wallet","ic-lg")+'</div><b>Заказов пока нет</b>Создайте заказ: выберите врача и продукт, при необходимости — рассрочку. '+
      (isAdminRole() && !toolsState.products.list.length ? 'Сначала заведите продукты в разделе «Продукты».' : '') + '</div>';
  } else if(!list.length){
    html += '<div class="empty-state">Ничего не найдено.</div>';
  } else {
    html += '<div class="table-wrap"><table class="roster roster-compact ord-table"><thead><tr><th>№</th><th>Врач</th><th>Продукт</th><th>Сумма</th><th>Оплачено</th><th>Следующий платёж</th><th>Статус</th><th></th></tr></thead><tbody>';
    list.forEach(function(o){
      var pct = o.amount ? Math.round(o.paid_amount/o.amount*100) : 100;
      var overdue = o.overdue_amount>0 && o.status!=="cancelled" && o.status!=="paid";
      html += '<tr class="row-link'+(o.status==="cancelled"?' ord-off':'')+'" data-action="order-open" data-id="'+o.id+'">' +
        '<td class="nowrap ord-num">'+o.number+'</td>' +
        '<td><div class="who-cell">'+userAvatar({ id:o.user_id, name:o.student_name, avatar_url:o.avatar_url })+'<div class="cell-2l"><b class="ell">'+escapeHtml(o.student_name)+'</b><small>'+escapeHtml(o.student_email)+'</small></div></div></td>' +
        '<td><div class="cell-2l"><span class="ell">'+escapeHtml(o.title)+'</span><small>'+(o.installments>1?'Рассрочка · '+o.installments_paid+' из '+o.installments:'Один платёж')+'</small></div></td>' +
        '<td class="nowrap"><b>'+fmtMoney(o.amount)+'</b></td>' +
        '<td><div class="ord-paid"><div class="stat-bar"><i style="width:'+pct+'%"></i></div><span>'+fmtMoney(o.paid_amount)+'</span></div></td>' +
        '<td class="nowrap'+(overdue?' ord-overdue':'')+'">'+(o.status==="paid"||o.status==="cancelled"||!o.next_due?'—':fmtDay(o.next_due)+(overdue?' · просрочен':''))+'</td>' +
        '<td class="nowrap">'+orderStatusMag(o)+'</td>' +
        '<td class="nowrap" style="text-align:right;"><button class="btn btn-sm btn-ghost row-open" data-action="order-open" data-id="'+o.id+'">Открыть →</button></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return el(html + '</div></div>');
}

function renderOrderDrawer(){
  var o = toolsState.orders.open;
  var head = '<div class="drawer-head"><div><b style="font-size:16px;">Заказ №'+o.number+'</b><div class="set-muted">'+escapeHtml(o.title)+'</div></div><button class="btn btn-ghost btn-sm" data-action="order-close">Закрыть ✕</button></div>';
  var rest = o.amount - o.paid_amount, today = todayIso();
  var body = '<div class="drawer-body">' +
    '<div class="ord-who" data-action="order-to-student" data-id="'+o.user_id+'">'+userAvatar({ id:o.user_id, name:o.student_name, avatar_url:o.avatar_url })+'<div class="ow-t"><b>'+escapeHtml(o.student_name)+'</b><span>'+escapeHtml(o.student_email)+'</span></div><em>Профиль →</em></div>' +
    '<div class="ord-sum"><div><span>Сумма</span><b>'+fmtMoney(o.amount)+'</b></div><div><span>Оплачено</span><b>'+fmtMoney(o.paid_amount)+'</b></div><div><span>Остаток</span><b>'+fmtMoney(o.status==="cancelled"?0:rest)+'</b></div></div>' +
    '<div class="ord-facts"><div><span>Статус</span>'+orderStatusMag(o)+'</div>' +
      '<div><span>Создан</span>'+fmtDateShort(o.created_at)+(o.created_by_name?' · '+escapeHtml(o.created_by_name):'')+'</div>' +
      (o.course_title?'<div><span>Доступ</span>'+(o.status==="paid"?'курс «'+escapeHtml(o.course_title)+'» открыт':'после полной оплаты откроется курс «'+escapeHtml(o.course_title)+'»')+'</div>':'') +
      (o.comment?'<div><span>Комментарий</span>'+escapeHtml(o.comment)+'</div>':'') + '</div>' +
    '<b class="co-card-title" style="margin:22px 0 10px;">'+(o.payments.length>1?'График платежей':'Платёж')+'</b><div class="ord-sched">';
  o.payments.forEach(function(p,i){
    var paid = !!p.paid_at, overdue = !paid && p.due_date < today && o.status!=="cancelled";
    body += '<div class="ord-pay'+(paid?' paid':(overdue?' overdue':''))+'"><span class="ord-pay-n">'+(paid?icon("check","ic-sm"):(i+1))+'</span>' +
      '<div class="ord-pay-main"><b>'+fmtMoney(p.amount)+'</b><span>'+(paid ? 'оплачен '+fmtDateShort(p.paid_at)+(p.marked_by_name?' · отметил(а) '+escapeHtml(p.marked_by_name):'') : 'до '+fmtDay(p.due_date)+(overdue?' · просрочен':''))+'</span></div>' +
      (o.status==="cancelled" ? '' : paid
        ? '<button class="btn btn-sm btn-ghost" data-action="order-unpay" data-pid="'+p.id+'"'+(toolsState.orders.busy?' disabled':'')+'>Отменить отметку</button>'
        : '<button class="btn btn-sm btn-primary" data-action="order-pay" data-pid="'+p.id+'"'+(toolsState.orders.busy?' disabled':'')+'>Отметить оплату</button>') +
    '</div>';
  });
  body += '</div>';
  if(o.status!=="cancelled") body += '<button class="btn btn-sm btn-ghost ord-cancel" data-action="order-cancel">Отменить заказ</button>';
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-order"><div class="drawer" data-stop="1" style="width:min(540px,100%);">'+head+body+'</div></div>');
}

function newOrderDraft(userId){ return { userId:userId||"", productId:"", title:"", amount:"", installments:"1", firstDueDate:todayIso(), paidNow:false, comment:"", error:"" }; }
function renderOrderCreateModal(){
  var d = toolsState.orders.draft;
  var prods = toolsState.products.list.filter(function(p){ return p.active || p.id===d.productId; });
  var prod = prods.find(function(p){ return p.id===d.productId; }) || null;
  var maxInst = prod ? prod.max_installments : 24;
  var students = (staffState.students||[]).slice().sort(function(a,b){ return a.name.localeCompare(b.name,"ru"); });
  var amount = d.amount!=="" ? parseInt(d.amount,10) : (prod ? prod.price : NaN);
  var n = Math.max(1, Math.min(maxInst, parseInt(d.installments,10)||1));
  var preview = '';
  if(amount>=0){
    var parts = splitAmountClient(amount, n);
    preview = '<div class="ord-preview"><b>'+(n>1?n+' '+ruPluralClient(n,"платёж","платежа","платежей"):'Один платёж')+'</b>' + parts.map(function(a,i){
      return '<div><span>'+(i+1)+'.</span>'+fmtMoney(a)+'<em>до '+fmtDay(addMonthsIso(d.firstDueDate, i))+'</em>'+(i===0&&d.paidNow?'<i>оплачен</i>':'')+'</div>';
    }).join('') + '</div>';
  }
  var instOpts = ''; for(var i=1;i<=maxInst;i++) instOpts += '<option value="'+i+'"'+(i===n?' selected':'')+'>'+(i===1?'Без рассрочки':i+' '+ruPluralClient(i,"платёж","платежа","платежей"))+'</option>';
  var body = '<div class="drawer-head"><b style="font-size:16px;">Новый заказ</b><button class="btn btn-ghost btn-sm" data-action="order-draft-close">Закрыть ✕</button></div><div class="drawer-body">' +
    '<div class="field"><label>Врач</label><select class="input" data-tbind="od.userId" data-rerender="1"><option value="">— выберите врача —</option>' +
      students.map(function(s){ return '<option value="'+s.id+'"'+(s.id===d.userId?' selected':'')+'>'+escapeHtml(s.name)+' — '+escapeHtml(s.email)+'</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>Продукт</label><select class="input" data-tbind="od.productId" data-rerender="1"><option value="">— без продукта, своё название —</option>' +
      prods.map(function(p){ return '<option value="'+p.id+'"'+(p.id===d.productId?' selected':'')+'>'+escapeHtml(p.title)+' · '+fmtMoney(p.price)+'</option>'; }).join('') + '</select>' +
      (isAdminRole() && !toolsState.products.list.length ? '<p class="hint">Продуктов пока нет — их можно завести в разделе «Продукты».</p>' : '') + '</div>' +
    (prod ? '' : '<div class="field"><label>Название</label><input class="input" data-tbind="od.title" value="'+escapeHtml(d.title)+'" placeholder="Например, консультация по протоколу"></div>') +
    '<div class="profile-2f"><div class="field"><label>Сумма, ₽</label><input class="input" type="number" min="0" step="1" data-tbind="od.amount" data-rerender="1" value="'+escapeHtml(d.amount)+'" placeholder="'+(prod?prod.price:'0')+'">' +
      (prod?'<p class="hint">Цена продукта — '+fmtMoney(prod.price)+'. Укажите другую, если скидка.</p>':'') + '</div>' +
      '<div class="field"><label>Рассрочка</label><select class="input" data-tbind="od.installments" data-rerender="1">'+instOpts+'</select></div></div>' +
    '<div class="profile-2f"><div class="field"><label>'+(n>1?'Первый платёж':'Оплатить до')+'</label><input class="input" type="date" data-tbind="od.firstDueDate" data-rerender="1" value="'+escapeHtml(d.firstDueDate)+'"></div>' +
      '<div class="field"><label class="sp-label">&nbsp;</label><label class="check-line"><input type="checkbox" data-tbind="od.paidNow" data-rerender="1"'+(d.paidNow?' checked':'')+'><span>'+(n>1?'Первый платёж уже получен':'Уже оплачено')+'</span></label></div></div>' +
    preview +
    '<div class="field"><label>Комментарий <span class="set-muted">(виден только персоналу)</span></label><textarea class="input" rows="2" data-tbind="od.comment">'+escapeHtml(d.comment)+'</textarea></div>' +
    (d.error?'<div class="err-text">'+escapeHtml(d.error)+'</div>':'') +
    '<div class="modal-actions"><button class="btn btn-ghost" data-action="order-draft-close">Отмена</button><button class="btn btn-primary" data-action="order-create"'+(toolsState.orders.busy?' disabled':'')+'>Создать заказ</button></div></div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-order-draft"><div class="drawer modal" data-stop="1" style="width:min(600px,100%);">'+body+'</div></div>');
}

/* ---------- Продукты ---------- */

function renderProductsTab(){
  var P = toolsState.products;
  var html = '<div class="page-wide">' + toolsHead("Продукты", "Что вы продаёте: цена, возможная рассрочка и курс, который откроется врачу после полной оплаты заказа.",
    isAdminRole() ? '<button class="btn btn-primary" data-action="product-new">+ Новый продукт</button>' : '');
  if(!P.loaded) return el(html + '<div class="card empty-state">Загрузка…</div></div>');
  if(!P.list.length){
    return el(html + '<div class="card empty-state tools-empty"><div class="big">'+icon("wallet","ic-lg")+'</div><b>Продуктов пока нет</b>Например: «Медицина Долголетия — полный курс», 90 000 ₽, рассрочка до 3 платежей, открывает полный курс.' +
      (isAdminRole()?'<div><button class="btn btn-sm btn-primary" data-action="product-new">Создать продукт</button></div>':'') + '</div></div>');
  }
  html += '<div class="sv-layout prod-layout"><div class="prod-grid">';
  P.list.forEach(function(p){
    html += '<div class="card prod-card'+(p.active?'':' off')+'"><div class="prod-top"><b>'+escapeHtml(p.title)+'</b>'+(p.active?magnet("active","В продаже"):magnet("neutral","Скрыт"))+'</div>' +
      '<div class="prod-price">'+fmtMoney(p.price)+'</div>' +
      '<div class="prod-facts"><div>'+icon("repeat","ic-sm")+(p.max_installments>1?'Рассрочка до '+p.max_installments+' '+ruPluralClient(p.max_installments,"платежа","платежей","платежей"):'Один платёж')+'</div>' +
        '<div>'+icon("book","ic-sm")+(p.course_title?'Открывает курс «'+escapeHtml(p.course_title)+'»':'Без автоматического доступа к курсу')+'</div>' +
        '<div>'+icon("list","ic-sm")+p.orders_count+' '+ruPluralClient(p.orders_count,"заказ","заказа","заказов")+'</div></div>' +
      (isAdminRole() ? '<div class="prod-actions"><button class="btn btn-sm btn-ghost" data-action="product-edit" data-id="'+p.id+'">Изменить</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="product-toggle" data-id="'+p.id+'">'+(p.active?'Скрыть':'Вернуть в продажу')+'</button>' +
        (p.orders_count ? '' : '<button class="btn btn-sm btn-ghost prod-del" data-action="product-delete" data-id="'+p.id+'" title="Удалить">'+icon("trash","ic-sm")+'</button>') + '</div>' : '') +
    '</div>';
  });
  return el(html + '</div>' + renderProductSales() + '</div></div>');
}

// Продажи по продуктам — из уже загруженных заказов (без отменённых).
function renderProductSales(){
  var orders = (toolsState.orders.list||[]).filter(function(o){ return o.status!=="cancelled"; });
  var rows = toolsState.products.list.map(function(p){
    var mine = orders.filter(function(o){ return o.product_id===p.id; });
    return { title:p.title, n:mine.length, paid:mine.reduce(function(a,o){ return a+o.paid_amount; },0), total:mine.reduce(function(a,o){ return a+o.amount; },0) };
  });
  var free = orders.filter(function(o){ return !o.product_id; });
  if(free.length) rows.push({ title:"Без продукта", n:free.length, paid:free.reduce(function(a,o){ return a+o.paid_amount; },0), total:free.reduce(function(a,o){ return a+o.amount; },0) });
  var sumPaid = rows.reduce(function(a,r){ return a+r.paid; },0), sumTotal = rows.reduce(function(a,r){ return a+r.total; },0);
  var h = '<div class="card co-card ps-card"><div class="co-head"><b>Продажи по продуктам</b><button class="btn btn-sm btn-ghost" data-action="sidebar-nav" data-key="orders">Заказы →</button></div>' +
    '<div class="ps-total"><div><b>'+fmtMoney(sumPaid)+'</b><span>получено</span></div><div><b>'+fmtMoney(sumTotal-sumPaid)+'</b><span>ожидается</span></div></div>';
  if(!orders.length) h += '<p class="set-muted">Заказов пока нет — как только появятся, здесь будет видно, что продаётся лучше.</p>';
  rows.filter(function(r){ return r.n; }).sort(function(a,b){ return b.total-a.total; }).forEach(function(r){
    h += '<div class="ps-row"><div class="ps-head"><b>'+escapeHtml(r.title)+'</b><span>'+r.n+' '+ruPluralClient(r.n,"заказ","заказа","заказов")+'</span></div>' +
      '<div class="ps-bar"><i class="paid" style="width:'+(sumTotal?r.paid/sumTotal*100:0)+'%"></i><i class="rest" style="width:'+(sumTotal?(r.total-r.paid)/sumTotal*100:0)+'%"></i></div>' +
      '<div class="ps-sub"><span>'+fmtMoney(r.paid)+' получено</span><span>из '+fmtMoney(r.total)+'</span></div></div>';
  });
  return h + '</div>';
}

function renderProductModal(){
  var p = toolsState.products.editing;
  var courseOpts = '<option value="">— не открывать курс —</option>' + (staffState.coursesList||[]).map(function(c){ return '<option value="'+c.id+'"'+(c.id===p.courseId?' selected':'')+'>'+escapeHtml(c.title)+'</option>'; }).join('');
  var instOpts = ''; [1,2,3,4,5,6,8,10,12,18,24].forEach(function(i){ instOpts += '<option value="'+i+'"'+(String(i)===String(p.maxInstallments)?' selected':'')+'>'+(i===1?'Без рассрочки':'До '+i+' '+ruPluralClient(i,"платежа","платежей","платежей"))+'</option>'; });
  var body = '<div class="drawer-head"><b style="font-size:16px;">'+(p.id?'Продукт':'Новый продукт')+'</b><button class="btn btn-ghost btn-sm" data-action="product-close">Закрыть ✕</button></div><div class="drawer-body">' +
    '<div class="field"><label>Название</label><input class="input" data-tbind="pd.title" value="'+escapeHtml(p.title)+'" placeholder="Медицина Долголетия — полный курс"></div>' +
    '<div class="profile-2f"><div class="field"><label>Цена, ₽</label><input class="input" type="number" min="0" step="1" data-tbind="pd.price" value="'+escapeHtml(p.price)+'"></div>' +
      '<div class="field"><label>Рассрочка</label><select class="input" data-tbind="pd.maxInstallments">'+instOpts+'</select></div></div>' +
    '<div class="field"><label>После полной оплаты открыть курс</label><select class="input" data-tbind="pd.courseId">'+courseOpts+'</select></div>' +
    '<label class="check-line"><input type="checkbox" data-tbind="pd.active"'+(p.active?' checked':'')+'><span><b>В продаже</b>скрытый продукт нельзя выбрать в новом заказе</span></label>' +
    (p.error?'<div class="err-text">'+escapeHtml(p.error)+'</div>':'') +
    '<div class="modal-actions"><button class="btn btn-ghost" data-action="product-close">Отмена</button><button class="btn btn-primary" data-action="product-save">Сохранить</button></div></div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-product"><div class="drawer modal" data-stop="1" style="width:min(520px,100%);">'+body+'</div></div>');
}

/* ---------- Анкеты ---------- */

function newSurveyQuestion(type){
  type = type || "single";
  return { id:"q"+Math.random().toString(36).slice(2,10), type:type, text:"", options:(type==="single"||type==="multi")?["",""]:[], required:type!=="text", max:5 };
}
function surveyTemplate(){
  return { id:null, title:"Знакомство: ваша практика", description:"Пара минут — чтобы куратор лучше понимал ваш опыт и подбирал примеры под вашу практику.", courseId:"", active:true, questions:[
    { id:"q-exp", type:"single", text:"Сколько лет вы практикуете?", options:["До 3 лет","3–10 лет","10–20 лет","Больше 20 лет"], required:true, max:5 },
    { id:"q-topics", type:"multi", text:"Какие темы для вас сейчас важнее всего?", options:["Гормональное здоровье","Питание и нутрицевтики","Сон и восстановление","Анализы и их интерпретация","Работа с пациентами 45+"], required:false, max:5 },
    { id:"q-ready", type:"scale", text:"Насколько вы готовы применять подходы превентивной медицины уже сейчас?", options:[], required:true, max:5 },
    { id:"q-wish", type:"text", text:"Что должно быть в курсе, чтобы он точно оказался для вас полезным?", options:[], required:false, max:5 }
  ], error:"" };
}
function renderSurveysTab(){
  var S = toolsState.surveys;
  var html = '<div class="page-wide">' + toolsHead("Анкеты и опросы", "Соберите анкету из вопросов — врачи увидят её у себя на главной и получат уведомление. Результаты — сводкой по каждому вопросу и поимённо.",
    isAdminRole() ? '<button class="btn btn-ghost" data-action="survey-template">Шаблон «Знакомство»</button><button class="btn btn-primary" data-action="survey-new">+ Новая анкета</button>' : '');
  if(!S.loaded) return el(html + '<div class="card empty-state">Загрузка…</div></div>');
  if(!S.list.length){
    return el(html + '<div class="card empty-state tools-empty"><div class="big">'+icon("poll","ic-lg")+'</div><b>Анкет пока нет</b>Анкета на входе поможет узнать опыт и интересы врачей, опрос после эфира — что улучшить.' +
      (isAdminRole()?'<div><button class="btn btn-sm btn-primary" data-action="survey-template">Начать с шаблона</button></div>':'') + '</div></div>');
  }
  // Список анкет слева, результаты выбранной — справа (по умолчанию первой).
  html += '<div class="sv-layout"><div class="sv-list">';
  S.list.forEach(function(s){
    var pct = s.audience_count ? Math.min(100, Math.round(s.responses_count/s.audience_count*100)) : 0;
    html += '<div class="card sv-card'+(s.active?'':' off')+(S.resultsId===s.id?' sel':'')+'" data-action="survey-results" data-id="'+s.id+'"><div class="prod-top"><b>'+escapeHtml(s.title)+'</b>'+(s.active?magnet("active","Собирает ответы"):magnet("neutral","Закрыта"))+'</div>' +
      (s.description?'<p class="sv-desc">'+escapeHtml(s.description)+'</p>':'') +
      '<div class="sv-meta"><span>'+icon("users","ic-sm")+(s.course_title?'Курс «'+escapeHtml(s.course_title)+'»':'Все врачи')+'</span><span>'+icon("list","ic-sm")+s.questions.length+' '+ruPluralClient(s.questions.length,"вопрос","вопроса","вопросов")+'</span></div>' +
      '<div class="sv-progress"><div><b>'+s.responses_count+'</b> '+ruPluralClient(s.responses_count,"ответ","ответа","ответов")+' из '+s.audience_count+' возможных<span>'+pct+'%</span></div><div class="stat-bar"><i style="width:'+pct+'%"></i></div></div>' +
      (isAdminRole() ? '<div class="prod-actions"><button class="btn btn-sm btn-ghost" data-action="survey-edit" data-id="'+s.id+'">Изменить</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="survey-toggle" data-id="'+s.id+'">'+(s.active?'Закрыть':'Открыть снова')+'</button>' +
          '<button class="btn btn-sm btn-ghost prod-del" data-action="survey-delete" data-id="'+s.id+'" title="Удалить">'+icon("trash","ic-sm")+'</button></div>' : '') + '</div>';
  });
  html += renderSurveyPeople() + '</div><div class="card co-card sv-results">'+renderSurveyResultsBody()+'</div></div>';
  return el(html + '</div>');
}

function renderSurveyBuilder(){
  var s = toolsState.surveys.editing;
  var courseOpts = '<option value="">Все врачи</option>' + (staffState.coursesList||[]).map(function(c){ return '<option value="'+c.id+'"'+(c.id===s.courseId?' selected':'')+'>Записанные на «'+escapeHtml(c.title)+'»</option>'; }).join('');
  var head = '<div class="drawer-head"><b style="font-size:16px;">'+(s.id?'Анкета':'Новая анкета')+'</b><button class="btn btn-ghost btn-sm" data-action="survey-close">Закрыть ✕</button></div>';
  var body = '<div class="drawer-body">' +
    '<div class="field"><label>Название</label><input class="input" data-tbind="sv.title" value="'+escapeHtml(s.title)+'" placeholder="Например, опрос после эфира"></div>' +
    '<div class="field"><label>Пояснение для врача <span class="set-muted">(необязательно)</span></label><textarea class="input" rows="2" data-tbind="sv.description">'+escapeHtml(s.description||"")+'</textarea></div>' +
    '<div class="profile-2f"><div class="field"><label>Кому показывать</label><select class="input" data-tbind="sv.courseId">'+courseOpts+'</select></div>' +
      '<div class="field"><label class="sp-label">&nbsp;</label><label class="check-line"><input type="checkbox" data-tbind="sv.active"'+(s.active?' checked':'')+'><span>Собирать ответы</span></label></div></div>' +
    '<b class="co-card-title" style="margin:10px 0 10px;">Вопросы</b>';
  s.questions.forEach(function(q, qi){
    var typeOpts = ["single","multi","scale","text"].map(function(t){ return '<option value="'+t+'"'+(q.type===t?' selected':'')+'>'+SURVEY_TYPE_LABELS[t]+'</option>'; }).join('');
    body += '<div class="sq-card"><div class="sq-head"><span class="sq-n">'+(qi+1)+'</span><select class="input sq-type" data-tbind="sq.type" data-id="'+qi+'" data-rerender="1">'+typeOpts+'</select>' +
      '<div class="sq-tools"><button type="button" class="btn btn-sm btn-ghost" data-action="sq-move" data-id="'+qi+'" data-dir="-1"'+(qi===0?' disabled':'')+' title="Выше">↑</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="sq-move" data-id="'+qi+'" data-dir="1"'+(qi===s.questions.length-1?' disabled':'')+' title="Ниже">↓</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="sq-del" data-id="'+qi+'" title="Удалить вопрос">'+icon("trash","ic-sm")+'</button></div></div>' +
      '<input class="input" data-tbind="sq.text" data-id="'+qi+'" value="'+escapeHtml(q.text)+'" placeholder="Текст вопроса">';
    if(q.type==="single" || q.type==="multi"){
      body += '<div class="sq-opts">';
      q.options.forEach(function(o, oi){
        body += '<div class="sq-opt"><span class="sq-mark '+q.type+'"></span><input class="input" data-tbind="sq.opt" data-id="'+qi+':'+oi+'" value="'+escapeHtml(o)+'" placeholder="Вариант '+(oi+1)+'">' +
          (q.options.length>2?'<button type="button" class="btn btn-sm btn-ghost" data-action="sq-opt-del" data-id="'+qi+':'+oi+'" title="Убрать вариант">✕</button>':'') + '</div>';
      });
      body += '<button type="button" class="btn btn-sm btn-ghost" data-action="sq-opt-add" data-id="'+qi+'">+ Вариант</button></div>';
    } else if(q.type==="scale"){
      body += '<div class="sq-scale-set"><span>Шкала от 1 до</span><select class="input" data-tbind="sq.max" data-id="'+qi+'" data-rerender="1"><option value="5"'+(q.max!==10?' selected':'')+'>5</option><option value="10"'+(q.max===10?' selected':'')+'>10</option></select></div>';
    }
    body += '<label class="check-line sq-req"><input type="checkbox" data-tbind="sq.req" data-id="'+qi+'"'+(q.required?' checked':'')+'><span>Обязательный вопрос</span></label></div>';
  });
  body += '<div class="sq-add">' + ["single","multi","scale","text"].map(function(t){ return '<button type="button" class="btn btn-sm btn-ghost" data-action="sq-add" data-type="'+t+'">+ '+SURVEY_TYPE_LABELS[t]+'</button>'; }).join('') + '</div>' +
    (s.error?'<div class="err-text">'+escapeHtml(s.error)+'</div>':'') +
    '<div class="modal-actions"><button class="btn btn-ghost" data-action="survey-close">Отмена</button><button class="btn btn-primary" data-action="survey-save">'+(s.id?'Сохранить':'Создать и разослать')+'</button></div></div>';
  return el('<div class="overlay" data-action="overlay-close-survey"><div class="drawer" data-stop="1" style="width:min(680px,100%);">'+head+body+'</div></div>');
}

function renderSurveyResultsBody(){
  var R = toolsState.surveys.results;
  var body = '<div class="co-head sr-top"><div><span class="sv-kicker">Результаты</span><b>'+(R?escapeHtml(R.survey.title):'…')+'</b></div>'+(R?'<span class="courses-count">'+R.total+' '+ruPluralClient(R.total,"ответ","ответа","ответов")+'</span>':'')+'</div>';
  if(!R){ body += '<div class="empty-state">Загрузка…</div>'; }
  else if(!R.total){ body += '<div class="empty-state tools-empty"><div class="big">'+icon("poll","ic-lg")+'</div><b>Ответов пока нет</b>Как только врачи начнут заполнять анкету, здесь появится сводка.</div>'; }
  else {
    R.survey.questions.forEach(function(q, qi){
      var sm = R.summary[qi] || { answered:0 };
      body += '<div class="sr-q"><div class="sr-head"><b>'+(qi+1)+'. '+escapeHtml(q.text)+'</b><span>'+sm.answered+' '+ruPluralClient(sm.answered,"ответ","ответа","ответов")+'</span></div>';
      if(q.type==="single" || q.type==="multi"){
        var maxC = Math.max.apply(null, sm.counts.concat([1]));
        q.options.forEach(function(o, oi){
          var c = sm.counts[oi]||0, pct = sm.answered ? Math.round(c/sm.answered*100) : 0;
          body += '<div class="sr-bar'+(c===maxC&&c>0?' top':'')+'"><span class="sr-label">'+escapeHtml(o)+'</span><div class="sr-track"><i style="width:'+pct+'%"></i></div><span class="sr-num">'+c+' · '+pct+'%</span></div>';
        });
      } else if(q.type==="scale"){
        body += '<div class="sr-scale"><div class="sr-avg"><b>'+(sm.avg===null?'—':String(sm.avg).replace(".",","))+'</b><span>в среднем из '+q.max+'</span></div><div class="sr-cols">';
        var maxS = Math.max.apply(null, sm.counts.concat([1]));
        sm.counts.forEach(function(c, i){ body += '<div class="sr-col"><i style="height:'+Math.round(c/maxS*100)+'%"></i><span>'+(i+1)+'</span></div>'; });
        body += '</div></div>';
      } else {
        var texts = R.responses.filter(function(r){ return (r.answers||{})[q.id]; });
        if(!texts.length) body += '<p class="set-muted">Пока без ответов.</p>';
        texts.slice(0,20).forEach(function(r){ body += '<div class="sr-text"><p>'+escapeHtml(r.answers[q.id])+'</p><span>'+escapeHtml(r.student_name)+' · '+fmtDateShort(r.created_at)+'</span></div>'; });
        if(texts.length>20) body += '<p class="set-muted">и ещё '+(texts.length-20)+'</p>';
      }
      body += '</div>';
    });
  }
  return body;
}
// Левая колонка под списком анкет: кто ответил и кто ещё нет. Карточка
// тянется до низа результатов справа, список внутри прокручивается.
function renderSurveyPeople(){
  var R = toolsState.surveys.results;
  if(!R) return '';
  var person = function(r, sub){ return '<div class="sr-person" data-action="open-student" data-id="'+r.student_id+'">'+userAvatar({ id:r.student_id, name:r.student_name, avatar_url:r.avatar_url })+'<div class="ow-t"><b>'+escapeHtml(r.student_name)+'</b><span>'+sub+'</span></div><em>→</em></div>'; };
  var pend = R.pending || [];
  var h = '<div class="card co-card sv-people"><div class="sv-people-body">' +
    '<div class="co-head"><b>Кто ответил</b><span class="courses-count">'+R.responses.length+'</span></div>';
  h += R.responses.length ? R.responses.map(function(r){ return person(r, timeSince(r.created_at)); }).join('') : '<p class="set-muted" style="margin:8px 0 0;">Пока никто.</p>';
  h += '<div class="co-head" style="margin-top:18px;"><b>Ещё не ответили</b><span class="courses-count">'+pend.length+'</span></div>';
  h += pend.length ? pend.map(function(r){ return person(r, "анкета ждёт на главной"); }).join('') : '<p class="set-muted" style="margin:8px 0 0;">Ответили все.</p>';
  return h + '</div></div>';
}

/* ---------- Врач: задание в уроке, анкеты, оплаты ---------- */

function renderLessonTaskStage(lesson, stages){
  var a = lesson.assignment, sub = (course.assignments||{})[lesson.id], editing = !!studentTools.taskEditing[lesson.id];
  var accepted = sub && sub.status==="accepted";
  var alreadyDone = ((course.progress && course.progress.completed_lessons) || []).indexOf(lesson.id)!==-1;
  var html = '<div class="task-box"><div class="task-label">'+icon("task","ic-sm")+' Задание к уроку'+(a.required?'<span class="task-req">обязательное</span>':'')+'</div><div class="task-prompt">'+renderPlainToProse(a.prompt)+'</div></div>';
  if(sub && !editing){
    if(sub.status==="pending") html += '<div class="task-state pending"><b>'+icon("clock","ic-sm")+' Ответ отправлен — куратор проверяет</b><span>'+timeSince(sub.submittedAt)+'</span></div>';
    else if(sub.status==="returned") html += '<div class="task-state returned"><b>'+icon("repeat","ic-sm")+' Куратор вернул ответ на доработку</b>'+(sub.curatorComment?'<p>'+escapeHtml(sub.curatorComment)+'</p>':'')+'<span>'+(sub.reviewerName?escapeHtml(sub.reviewerName)+' · ':'')+timeSince(sub.reviewedAt)+'</span></div>';
    else html += '<div class="task-state accepted"><b>'+icon("check","ic-sm")+' Ответ принят</b>'+(sub.curatorComment?'<p>'+escapeHtml(sub.curatorComment)+'</p>':'')+'<span>'+(sub.reviewerName?escapeHtml(sub.reviewerName)+' · ':'')+timeSince(sub.reviewedAt)+'</span></div>';
    html += '<div class="task-answer"><span>Ваш ответ</span>'+escapeHtml(sub.answer)+'</div>';
    if(sub.status==="pending") html += '<button class="btn btn-sm btn-ghost" data-action="task-edit" data-id="'+lesson.id+'">Изменить ответ</button>';
    if(sub.status==="returned") html += '<button class="btn btn-sm btn-primary" data-action="task-edit" data-id="'+lesson.id+'">Исправить и отправить снова</button>';
  } else {
    var draft = studentTools.taskDraft[lesson.id]!=null ? studentTools.taskDraft[lesson.id] : (sub ? sub.answer : "");
    html += '<textarea class="input task-input" id="taskAnswer" data-tbind="task-draft" data-id="'+lesson.id+'" placeholder="Ваш ответ — куратор прочитает его и ответит">'+escapeHtml(draft)+'</textarea>' +
      '<div class="task-send">'+(editing?'<button class="btn btn-sm btn-ghost" data-action="task-edit-cancel" data-id="'+lesson.id+'">Отмена</button>':'') +
      '<button class="btn btn-sm btn-primary" data-action="task-submit" data-id="'+lesson.id+'">Отправить куратору</button></div>';
  }
  var prevStage = stages[stages.indexOf("task")-1] || "intro";
  var stageNames = { intro:"К материалу", video:"К видео", quiz:"К тесту" };
  html += '<div class="lesson-footer"><button class="btn btn-ghost" data-action="lesson-stage" data-stage="'+prevStage+'">← '+stageNames[prevStage]+'</button>';
  if(a.required && !accepted && !alreadyDone){
    html += '<div class="task-next"><span>Урок засчитается, когда куратор примет ответ</span><button class="btn btn-ghost" data-action="task-skip-next">Следующий урок →</button></div>';
  } else {
    html += '<button class="btn btn-primary" data-action="next-lesson">Урок пройден, далее →</button>';
  }
  return html + '</div>';
}

function renderSurveyHomeCard(){
  var pending = (studentTools.surveys||[]).filter(function(s){ return !s.my_answers; });
  if(!pending.length) return '';
  var s = pending[0], n = s.questions.length;
  return '<div class="card sv-home"><div class="tile-icon">'+icon("poll")+'</div><div class="sv-home-main"><span class="sv-kicker">Анкета'+(pending.length>1?' · ещё '+(pending.length-1):'')+'</span><b>'+escapeHtml(s.title)+'</b><span>'+n+' '+ruPluralClient(n,"вопрос","вопроса","вопросов")+' · около '+Math.max(1,Math.round(n*0.5))+' мин</span></div>' +
    '<button class="btn btn-primary btn-sm" data-action="sf-open" data-id="'+s.id+'">Заполнить</button></div>';
}

function renderSurveyFillModal(){
  var s = studentTools.surveys.find(function(x){ return x.id===studentTools.fillId; });
  if(!s) return el('<div></div>');
  var A = studentTools.answers;
  var body = '<div class="drawer-head"><div><b style="font-size:16px;">'+escapeHtml(s.title)+'</b>'+(s.my_answers?'<div class="set-muted">Вы уже отвечали — можно изменить ответы</div>':'')+'</div><button class="btn btn-ghost btn-sm" data-action="sf-close">Закрыть ✕</button></div><div class="drawer-body">' +
    (s.description?'<p class="sf-desc">'+escapeHtml(s.description)+'</p>':'');
  s.questions.forEach(function(q, qi){
    body += '<div class="sf-q'+(studentTools.missingQ===q.id?' missing':'')+'" id="sfq-'+q.id+'"><p class="qtext">'+(qi+1)+'. '+escapeHtml(q.text)+(q.required?' <span class="sf-req">*</span>':'')+'</p>';
    if(q.type==="single" || q.type==="multi"){
      var cur = A[q.id];
      q.options.forEach(function(o, oi){
        var on = q.type==="single" ? cur===oi : (Array.isArray(cur) && cur.indexOf(oi)!==-1);
        body += '<button type="button" class="opt sf-opt'+(on?' on':'')+'" data-action="sf-pick" data-q="'+q.id+'" data-i="'+oi+'" data-multi="'+(q.type==="multi"?1:0)+'"><span class="sf-mark '+q.type+'">'+(on?icon("check","ic-sm"):'')+'</span>'+escapeHtml(o)+'</button>';
      });
      if(q.type==="multi") body += '<p class="hint" style="margin-top:0;">Можно выбрать несколько</p>';
    } else if(q.type==="scale"){
      body += '<div class="sf-scale">';
      for(var i=1;i<=q.max;i++) body += '<button type="button" class="'+(A[q.id]===i?'on':'')+'" data-action="sf-pick" data-q="'+q.id+'" data-i="'+i+'" data-multi="0">'+i+'</button>';
      body += '</div><div class="sf-scale-legend"><span>совсем нет</span><span>полностью</span></div>';
    } else {
      body += '<textarea class="input" rows="3" data-tbind="sa.text" data-id="'+q.id+'" placeholder="Ваш ответ">'+escapeHtml(A[q.id]||"")+'</textarea>';
    }
    body += '</div>';
  });
  body += (studentTools.surveyError?'<div class="err-text">'+escapeHtml(studentTools.surveyError)+'</div>':'') +
    '<div class="modal-actions"><button class="btn btn-ghost" data-action="sf-close">Позже</button><button class="btn btn-primary" data-action="sf-submit">Отправить</button></div></div>';
  return el('<div class="overlay overlay-center" data-action="overlay-close-sf"><div class="drawer modal" data-stop="1" style="width:min(620px,100%);">'+body+'</div></div>');
}

function renderMyOrdersBlock(){
  var list = studentTools.orders || [];
  if(!list.length) return '';
  var today = todayIso();
  var html = '<div class="my-orders"><b class="co-card-title" style="margin-bottom:10px;">Оплаты</b>';
  list.forEach(function(o){
    var pct = o.amount ? Math.round(o.paid_amount/o.amount*100) : 100;
    var next = o.payments.filter(function(p){ return !p.paid_at; })[0];
    html += '<div class="my-order"><div class="my-order-top"><b>'+escapeHtml(o.title)+'</b>'+orderStatusMag(o)+'</div>' +
      '<div class="stat-bar"><i style="width:'+pct+'%"></i></div>' +
      '<div class="my-order-sub"><span>Оплачено '+fmtMoney(o.paid_amount)+' из '+fmtMoney(o.amount)+'</span>' +
        (next ? '<span class="'+(next.due_date<today?'ord-overdue':'')+'">Следующий платёж: '+fmtMoney(next.amount)+' до '+fmtDay(next.due_date)+'</span>' : '') + '</div>' +
      (o.payments.length>1 ? '<div class="my-order-plan">'+o.payments.map(function(p){ return '<span class="'+(p.paid_at?'paid':(p.due_date<today?'overdue':''))+'" title="'+fmtMoney(p.amount)+' · до '+fmtDay(p.due_date)+'"></span>'; }).join('')+'</div>' : '') +
    '</div>';
  });
  return html + '<p class="hint">Вопрос по оплате — напишите куратору в Telegram-группе потока.</p></div>';
}

/* ---------- Страница врача у куратора: задания и оплаты ---------- */

function renderStudentAssignTab(){
  var list = toolsState.studentAssign || [];
  if(!list.length) return '<div class="empty-state" style="padding:30px 10px;">Врач пока не отвечал на задания.</div>';
  return '<div class="tk-list tk-list-1">' + list.map(renderAssignmentCard).join('') + '</div>';
}
function renderStudentOrdersTab(s){
  var list = toolsState.orders.list.filter(function(o){ return o.user_id===s.id; });
  var html = '<div class="co-head" style="margin-bottom:12px;"><b>Заказы</b><button class="btn btn-sm btn-primary" data-action="order-new" data-user="'+s.id+'">+ Новый заказ</button></div>';
  if(!toolsState.orders.loaded) return html + '<div class="empty-state">Загрузка…</div>';
  if(!list.length) return html + '<div class="empty-state" style="padding:30px 10px;">Заказов нет. Статус оплаты можно выставить вручную во вкладке «Профиль» или создать заказ с графиком платежей.</div>';
  list.forEach(function(o){
    var pct = o.amount ? Math.round(o.paid_amount/o.amount*100) : 100;
    html += '<div class="my-order my-order-link" data-action="order-open" data-id="'+o.id+'"><div class="my-order-top"><b>№'+o.number+' · '+escapeHtml(o.title)+'</b>'+orderStatusMag(o)+'</div>' +
      '<div class="stat-bar"><i style="width:'+pct+'%"></i></div><div class="my-order-sub"><span>Оплачено '+fmtMoney(o.paid_amount)+' из '+fmtMoney(o.amount)+'</span>' +
      (o.next_due && o.status!=="paid" && o.status!=="cancelled" ? '<span>следующий платёж до '+fmtDay(o.next_due)+'</span>' : '') + '</div></div>';
  });
  return html;
}

/* ---------- Обработчики ---------- */

function toolsBind(t){
  var k = t.getAttribute("data-tbind"), id = t.getAttribute("data-id");
  // «Есть несохранённое» — чтобы клик по фону не закрыл окно молча.
  if(/^ae\./.test(k) && toolsState.assignEditor){ toolsState.assignEditor._dirty = true; if(typeof lpRefreshPreviewSoon==="function") lpRefreshPreviewSoon(); }
  if(/^od\./.test(k) && toolsState.orders.draft) toolsState.orders.draft._dirty = true;
  if(/^pd\./.test(k) && toolsState.products.editing) toolsState.products.editing._dirty = true;
  if(/^s[vq]\./.test(k) && toolsState.surveys.editing) toolsState.surveys.editing._dirty = true;
  var v = t.type==="checkbox" ? t.checked : t.value;
  var O = toolsState.orders, S = toolsState.surveys;
  if(k==="assign-comment") toolsState.assign.comments[id] = v;
  else if(k==="order-q") O.q = v;
  else if(k==="ae.prompt") toolsState.assignEditor.prompt = v;
  else if(k==="ae.required") toolsState.assignEditor.required = v;
  else if(k.indexOf("od.")===0 && O.draft){
    var f = k.slice(3);
    O.draft[f] = v;
    if(f==="productId"){ O.draft.amount = ""; O.draft.installments = "1"; }
  }
  else if(k.indexOf("pd.")===0 && toolsState.products.editing) toolsState.products.editing[k.slice(3)] = v;
  else if(k.indexOf("sv.")===0 && S.editing) S.editing[k.slice(3)] = v;
  else if(k.indexOf("sq.")===0 && S.editing){
    var f2 = k.slice(3);
    if(f2==="opt"){ var p = id.split(":"); S.editing.questions[+p[0]].options[+p[1]] = v; return; }
    var q = S.editing.questions[+id];
    if(f2==="text") q.text = v;
    else if(f2==="req") q.required = v;
    else if(f2==="max") q.max = parseInt(v,10);
    else if(f2==="type"){ q.type = v; if((v==="single"||v==="multi") && q.options.length<2) q.options = (q.options.concat(["",""])).slice(0, Math.max(2,q.options.length)); }
  }
  else if(k==="task-draft") studentTools.taskDraft[id] = v;
  else if(k==="sa.text") studentTools.answers[id] = v;
}

async function toolsChange(t){
  var k = t.getAttribute("data-tchange");
  if(k==="assign-lesson"){ toolsState.assign.lessonId = t.value; toolsState.assign.loaded = false; render(); await loadAssignments(); render(); }
}

// Открытие редакторов урока — общее для прежних кнопок и вкладок страницы урока
// (renderLessonPage показывает те же редакторы прямо на странице).
async function openLessonEditor(lessonId){
  lessonEditor = { open:true, isNew:false, id:lessonId, title:"", duration:"", html:"", dripDays:null, hasDraft:false, publishedTitle:"", publishedDuration:"", publishedHtml:"", history:[], showHistory:false, showPreview:false };
  var ed = lessonEditor; // ответ мог прийти, когда уже открыт другой урок
  render();
  try{
    var le=await api("/course/lessons/"+lessonId);
    var l=le.lesson;
    ed.publishedTitle=l.title; ed.publishedDuration=l.duration||""; ed.publishedHtml=l.html;
    ed.hasDraft=!!l.has_draft;
    ed.title = l.has_draft ? l.draft_title : l.title;
    ed.duration = l.has_draft ? (l.draft_duration||"") : (l.duration||"");
    ed.html = l.has_draft ? l.draft_html : l.html;
    ed._origHtml = ed.html;
    ed.dripDays = (typeof l.drip_days==="number") ? l.drip_days : null;
    ed.loaded = true;
  }catch(err){ showToast(err.message); ed.open=false; }
  render();
}
async function openVideoEditor(lessonId, title){
  videoEditor = { open:true, lessonId:lessonId, lessonTitle:title||"", videoUrl:"", timecodes:[], uploadProgress:null };
  var ve = videoEditor;
  render();
  try{
    var lv=await api("/course/lessons/"+lessonId);
    ve.videoUrl = lv.lesson.video_url || "";
    ve.timecodes = lv.lesson.video_timecodes || [];
  }catch(err){ showToast(err.message); }
  render();
}
async function openLessonQuizManager(lessonId, title){
  lessonQuizManager = { open:true, lessonId:lessonId, lessonTitle:title||"", questions:[], loaded:false };
  var qm = lessonQuizManager;
  render();
  try{ var lqm=await api("/course/lessons/"+lessonId+"/quiz-admin"); qm.questions=lqm.quiz; }
  catch(err){ showToast(err.message); }
  qm.loaded = true;
  render();
}
function openMaterialsPicker(targetId, title){
  materialsPicker.open=true; materialsPicker.targetId=targetId; materialsPicker.targetTitle=title||"";
  materialsPicker.search=""; materialsPicker.selectedIds=(courseVisibility[targetId]||[]).slice();
}
async function openScheduleModal(lessonId, title){
  scheduleModal = { open:true, lessonId:lessonId, lessonTitle:title||"", search:"", selectedIds:[], applyToAll:true, unlockDate:"", schedule:[] };
  var sm = scheduleModal;
  render();
  try{ var sch=await api("/course/lessons/"+lessonId+"/schedule"); sm.schedule=sch.schedule; render(); }catch(err){ showToast(err.message); }
}
function openAssignEditor(lessonId){
  var l = (staffState.materials||[]).find(function(x){ return x.id===lessonId; }) || {};
  toolsState.assignEditor = { lessonId:lessonId, title:l.title||"", prompt:l.assignment_prompt||"", required:!!l.assignment_required, hadTask:!!l.assignment_prompt };
}

async function handleToolsClick(action, t, e){
  var A = toolsState.assign, O = toolsState.orders, P = toolsState.products, S = toolsState.surveys;
  var id = t.getAttribute("data-id");
  /* --- проверка заданий --- */
  if(action==="assign-status"){ A.status = t.getAttribute("data-status"); A.loaded = false; render(); await loadAssignments(); render(); return true; }
  if(action==="assign-history"){ A.openHistory[id] = !A.openHistory[id]; render(); return true; }
  if(action==="assign-review"){
    var dec = t.getAttribute("data-decision"), cm = (A.comments[id]||"").trim();
    if(dec==="return" && !cm){
      showToast("Напишите, что доработать, — врач увидит комментарий");
      var ta = document.querySelector('[data-tbind="assign-comment"][data-id="'+id+'"]'); if(ta) ta.focus();
      return true;
    }
    A.busy = id; render();
    try{
      await api("/assignments/"+id+"/review", { method:"POST", body: JSON.stringify({ decision:dec, comment:cm }) });
      delete A.comments[id];
      showToast(dec==="accept" ? "Ответ принят — урок засчитан врачу" : "Ответ возвращён на доработку");
      await loadAssignments();
      if(staffState.selectedStudentId) await loadStudentAssign(staffState.selectedStudentId);
      toolsState.feed.loaded = false;
    }catch(err){ showToast(err.message); }
    A.busy = null; render(); return true;
  }
  if(action==="open-assign-editor"){ openAssignEditor(id); render(); return true; }
  if(action==="assign-editor-close" || (action==="overlay-close-assign-editor" && !e.target.closest("[data-stop]"))){ toolsState.assignEditor = null; render(); return true; }
  if(action==="assign-editor-save" || action==="assign-editor-remove"){
    var ae = toolsState.assignEditor, removing = action==="assign-editor-remove";
    if(!removing && !ae.prompt.trim()){ showToast("Напишите формулировку задания"); return true; }
    try{
      await api("/assignments/lessons/"+ae.lessonId+"/config", { method:"PUT", body: JSON.stringify(removing ? { prompt:"", required:false } : { prompt:ae.prompt, required:ae.required }) });
      var ml = (staffState.materials||[]).find(function(x){ return x.id===ae.lessonId; });
      if(ml){ ml.assignment_prompt = removing ? null : ae.prompt.trim(); ml.assignment_required = removing ? false : !!ae.required; }
      toolsState.assignEditor = null;
      showToast(removing ? "Задание убрано" : "Задание сохранено");
    }catch(err){ showToast(err.message); }
    render(); return true;
  }
  /* --- лента --- */
  if(action==="feed-type"){ toolsState.feed.type = t.getAttribute("data-type"); toolsState.feed.loaded = false; render(); await loadFeed(); render(); return true; }
  /* --- заказы --- */
  if(action==="order-filter"){ O.filter = t.getAttribute("data-filter"); render(); return true; }
  if(action==="order-new"){
    O.draft = newOrderDraft(t.getAttribute("data-user"));
    render();
    if(!P.loaded){ await loadProducts(); render(); }
    return true;
  }
  if(action==="order-draft-close" || (action==="overlay-close-order-draft" && !e.target.closest("[data-stop]"))){ O.draft = null; render(); return true; }
  if(action==="order-create"){
    var d = O.draft;
    if(!d.userId){ d.error = "Выберите врача"; render(); return true; }
    O.busy = true; d.error = ""; render();
    try{
      var r = await api("/orders", { method:"POST", body: JSON.stringify({ userId:d.userId, productId:d.productId||null, title:d.title, amount:d.amount, installments:parseInt(d.installments,10)||1, firstDueDate:d.firstDueDate, paidNow:!!d.paidNow, comment:d.comment }) });
      O.draft = null; O.open = r.order;
      showToast("Заказ №"+r.order.number+" создан");
      await loadOrders();
      if(staffState.selectedStudentId===r.order.user_id) await refreshSelectedStudent();
      else { var st = staffState.students.find(function(x){ return x.id===r.order.user_id; }); if(st) loadStaffData().then(render); }
    }catch(err){ d.error = err.message; }
    O.busy = false; render(); return true;
  }
  if(action==="order-open"){
    try{ var ro = await api("/orders/"+id); O.open = ro.order; }catch(err){ showToast(err.message); }
    render(); return true;
  }
  if(action==="order-close" || (action==="overlay-close-order" && !e.target.closest("[data-stop]"))){ O.open = null; render(); return true; }
  if(action==="order-pay" || action==="order-unpay"){
    var pay = action==="order-pay";
    O.busy = true; render();
    try{
      var rp = await api("/orders/"+O.open.id+"/payments/"+t.getAttribute("data-pid")+"/"+(pay?"pay":"unpay"), { method:"POST" });
      O.open = rp.order;
      showToast(pay ? (rp.status==="paid" ? "Заказ оплачен полностью"+(rp.order.course_title?" — курс открыт врачу":"") : "Платёж отмечен") : "Отметка об оплате снята");
      await loadOrders();
      if(staffState.selectedStudentId===rp.order.user_id) await refreshSelectedStudent();
      else { var su = staffState.students.find(function(x){ return x.id===rp.order.user_id; }); if(su) loadStaffData().then(render); }
    }catch(err){ showToast(err.message); }
    O.busy = false; render(); return true;
  }
  if(action==="order-cancel"){
    var oc = O.open;
    // Если заказ сам открыл курс — отмена закроет доступ к нему (прогресс сохранится).
    var closes = oc.opened_course && oc.course_title;
    askConfirm({ title:"Вы уверены, что хотите отменить заказ №"+oc.number+"?"+(closes?" Доступы к урокам ученика также будут закрыты":""),
      body: closes
        ? "Закроется курс «"+oc.course_title+"». Прогресс врача сохранится — доступ можно вернуть во вкладке «Доступ» или новой оплатой."
        : "Заказ останется в истории со статусом «Отменён», неоплаченные платежи больше не будут ждать оплаты.",
      confirmLabel:"Отменить заказ", danger:true, onConfirm: async function(){
      try{
        var rc = await api("/orders/"+oc.id+"/cancel", { method:"POST" });
        O.open = null;
        showToast(rc.closedCourse ? "Заказ отменён, доступ к курсу «"+rc.closedCourse+"» закрыт" : "Заказ отменён");
        await loadOrders(); if(staffState.selectedStudentId===oc.user_id) await refreshSelectedStudent();
      }catch(err){ showToast(err.message); }
      render();
    } });
    return true;
  }
  if(action==="order-to-student"){ O.open = null; return "open-student"; }
  /* --- продукты --- */
  if(action==="product-new"){ P.editing = { id:null, title:"", price:"", maxInstallments:"1", courseId:"", active:true, error:"" }; render(); return true; }
  if(action==="product-edit"){
    var pe = P.list.find(function(x){ return x.id===id; });
    P.editing = { id:pe.id, title:pe.title, price:String(pe.price), maxInstallments:String(pe.max_installments), courseId:pe.course_id||"", active:pe.active, error:"" };
    render(); return true;
  }
  if(action==="product-close" || (action==="overlay-close-product" && !e.target.closest("[data-stop]"))){ P.editing = null; render(); return true; }
  if(action==="product-save"){
    var pd = P.editing;
    try{
      var payload = { title:pd.title, price:pd.price, maxInstallments:parseInt(pd.maxInstallments,10)||1, courseId:pd.courseId||null, active:!!pd.active };
      await api("/orders/products"+(pd.id?"/"+pd.id:""), { method:pd.id?"PUT":"POST", body: JSON.stringify(payload) });
      P.editing = null; showToast("Продукт сохранён"); await loadProducts();
    }catch(err){ pd.error = err.message; }
    render(); return true;
  }
  if(action==="product-toggle"){
    var pt = P.list.find(function(x){ return x.id===id; });
    try{ await api("/orders/products/"+id, { method:"PUT", body: JSON.stringify({ title:pt.title, price:pt.price, maxInstallments:pt.max_installments, courseId:pt.course_id, active:!pt.active }) }); await loadProducts(); }catch(err){ showToast(err.message); }
    render(); return true;
  }
  if(action==="product-delete"){
    var pdl = P.list.find(function(x){ return x.id===id; });
    askConfirm({ title:"Вы уверены, что хотите удалить продукт «"+pdl.title+"»?", body:"Заказов по нему нет, так что удаление ничего не затронет.", confirmLabel:"Удалить", danger:true, onConfirm: async function(){
      try{ await api("/orders/products/"+id, { method:"DELETE" }); showToast("Продукт удалён"); await loadProducts(); }catch(err){ showToast(err.message); }
      render();
    } });
    return true;
  }
  /* --- анкеты --- */
  if(action==="survey-new"){ S.editing = { id:null, title:"", description:"", courseId:"", active:true, questions:[newSurveyQuestion("single")], error:"" }; render(); return true; }
  if(action==="survey-template"){ S.editing = surveyTemplate(); render(); return true; }
  if(action==="survey-edit"){
    var se = S.list.find(function(x){ return x.id===id; });
    S.editing = { id:se.id, title:se.title, description:se.description||"", courseId:se.course_id||"", active:se.active, questions:JSON.parse(JSON.stringify(se.questions)).map(function(q){ q.options = q.options||[]; q.max = q.max||5; return q; }), error:"" };
    render(); return true;
  }
  if(action==="survey-close" || (action==="overlay-close-survey" && !e.target.closest("[data-stop]"))){ S.editing = null; render(); return true; }
  if(action==="sq-add"){ S.editing._dirty = true; S.editing.questions.push(newSurveyQuestion(t.getAttribute("data-type"))); render(); return true; }
  if(action==="sq-del"){ S.editing._dirty = true; if(S.editing.questions.length<=1){ showToast("В анкете должен остаться хотя бы один вопрос"); return true; } S.editing.questions.splice(+id,1); render(); return true; }
  if(action==="sq-move"){ S.editing._dirty = true; var qs = S.editing.questions, i1 = +id, i2 = i1 + parseInt(t.getAttribute("data-dir"),10); var tmp = qs[i1]; qs[i1] = qs[i2]; qs[i2] = tmp; render(); return true; }
  if(action==="sq-opt-add"){ S.editing._dirty = true; S.editing.questions[+id].options.push(""); render(); return true; }
  if(action==="sq-opt-del"){ S.editing._dirty = true; var po = id.split(":"); S.editing.questions[+po[0]].options.splice(+po[1],1); render(); return true; }
  if(action==="survey-save"){
    var sv = S.editing;
    var qsClean = sv.questions.map(function(q){ var o = { id:q.id, type:q.type, text:q.text, required:!!q.required }; if(q.type==="single"||q.type==="multi") o.options = q.options.filter(function(x){ return x.trim(); }); if(q.type==="scale") o.max = q.max===10?10:5; return o; });
    try{
      await api("/surveys"+(sv.id?"/"+sv.id:""), { method:sv.id?"PUT":"POST", body: JSON.stringify({ title:sv.title, description:sv.description, courseId:sv.courseId||null, active:!!sv.active, questions:qsClean }) });
      showToast(sv.id ? "Анкета сохранена" : (sv.active ? "Анкета создана — врачи получили уведомление" : "Анкета создана"));
      S.editing = null; await loadSurveysAdmin();
    }catch(err){ sv.error = err.message; }
    render(); return true;
  }
  if(action==="survey-toggle"){
    var stg = S.list.find(function(x){ return x.id===id; });
    try{ await api("/surveys/"+id, { method:"PUT", body: JSON.stringify({ title:stg.title, description:stg.description, courseId:stg.course_id, active:!stg.active, questions:stg.questions }) }); await loadSurveysAdmin(); showToast(stg.active?"Анкета закрыта":"Анкета снова собирает ответы"); }catch(err){ showToast(err.message); }
    render(); return true;
  }
  if(action==="survey-delete"){
    var sd = S.list.find(function(x){ return x.id===id; });
    askConfirm({ title:"Вы уверены, что хотите удалить анкету «"+sd.title+"»?", body:"Вместе с ней удалятся и все ответы врачей ("+sd.responses_count+"). Если нужно просто перестать собирать ответы — закройте её.", confirmLabel:"Удалить", danger:true, onConfirm: async function(){
      try{ await api("/surveys/"+id, { method:"DELETE" }); showToast("Анкета удалена"); await loadSurveysAdmin(); }catch(err){ showToast(err.message); }
      render();
    } });
    return true;
  }
  if(action==="survey-results"){
    if(S.resultsId===id && S.results) return true;
    S.resultsId = id; S.results = null; render();
    await loadSurveyResults(id);
    render(); return true;
  }
  /* --- врач: задание --- */
  if(action==="task-edit"){ studentTools.taskEditing[id] = true; render(); setTimeout(function(){ var x = document.getElementById("taskAnswer"); if(x){ x.focus(); x.selectionStart = x.selectionEnd = x.value.length; } }, 0); return true; }
  if(action==="task-edit-cancel"){ studentTools.taskEditing[id] = false; delete studentTools.taskDraft[id]; render(); return true; }
  if(action==="task-submit"){
    var ta2 = document.getElementById("taskAnswer");
    var val = (studentTools.taskDraft[id]!=null ? studentTools.taskDraft[id] : (ta2 ? ta2.value : "")).trim();
    if(!val){ showToast("Напишите ответ"); return true; }
    if(previewMode){ showToast("В режиме предпросмотра ответы не отправляются"); return true; }
    t.disabled = true;
    try{
      var rs = await api("/assignments/lessons/"+id, { method:"POST", body: JSON.stringify({ answer:val }) });
      course.assignments = course.assignments || {};
      course.assignments[id] = Object.assign({}, course.assignments[id]||{}, rs.submission);
      delete studentTools.taskDraft[id]; studentTools.taskEditing[id] = false;
      showToast("Ответ отправлен куратору");
    }catch(err){ showToast(err.message); t.disabled = false; }
    render(); return true;
  }
  if(action==="open-lesson-task"){
    studentState.tab = "lesson"; studentState.quizMode = false; studentState.lessonIndex = parseInt(t.getAttribute("data-idx"),10);
    resetLessonStageState(); studentState.lessonStage = "task"; render(); window.scrollTo(0,0); return true;
  }
  if(action==="task-skip-next"){ advanceAfterLesson(); render(); window.scrollTo(0,0); return true; }
  /* --- врач: анкета --- */
  if(action==="sf-open"){
    var sf = studentTools.surveys.find(function(x){ return x.id===id; });
    studentTools.fillId = id; studentTools.answers = sf && sf.my_answers ? JSON.parse(JSON.stringify(sf.my_answers)) : {}; studentTools.surveyError = ""; studentTools.missingQ = null;
    render(); return true;
  }
  if(action==="sf-close" || (action==="overlay-close-sf" && !e.target.closest("[data-stop]"))){ studentTools.fillId = null; render(); return true; }
  if(action==="sf-pick"){
    var qid = t.getAttribute("data-q"), oi = parseInt(t.getAttribute("data-i"),10);
    if(t.getAttribute("data-multi")==="1"){
      var arr = Array.isArray(studentTools.answers[qid]) ? studentTools.answers[qid] : [];
      var at = arr.indexOf(oi);
      if(at===-1) arr.push(oi); else arr.splice(at,1);
      studentTools.answers[qid] = arr;
    } else studentTools.answers[qid] = oi;
    if(studentTools.missingQ===qid){ studentTools.missingQ = null; studentTools.surveyError = ""; }
    render(); return true;
  }
  if(action==="sf-submit"){
    var sfs = studentTools.surveys.find(function(x){ return x.id===studentTools.fillId; });
    if(previewMode){ showToast("В режиме предпросмотра ответы не отправляются"); return true; }
    try{
      var rr = await api("/surveys/"+sfs.id+"/respond", { method:"POST", body: JSON.stringify({ answers:studentTools.answers }) });
      sfs.my_answers = rr.answers; studentTools.fillId = null; studentTools.surveyError = "";
      showToast("Спасибо! Ответы отправлены");
    }catch(err){
      studentTools.surveyError = err.message;
      studentTools.missingQ = (err.data && err.data.questionId) || null;
      render();
      var mq = studentTools.missingQ && document.getElementById("sfq-"+studentTools.missingQ);
      if(mq) mq.scrollIntoView({ behavior:"smooth", block:"center" });
      return true;
    }
    render(); return true;
  }
  return false;
}

async function loadStudentAssign(studentId){
  try{ var r = await api("/assignments?status=all&studentId="+encodeURIComponent(studentId)); toolsState.studentAssign = r.submissions; }catch(e){ toolsState.studentAssign = []; }
}

function wireEvents(root){
  // render() calls wireEvents(app) on every re-render; app (the #app container) is never
  // replaced, only its innerHTML is cleared, so without this guard every listener below
  // would be re-attached on top of the previous ones and a single click/input would fire
  // once per render that has happened so far (theme toggle flips twice, forms submit twice…).
  if(root.__wired) return;
  root.__wired = true;
  // Без preventDefault здесь клик по кнопке тулбара сначала уводит фокус/выделение
  // из contenteditable (браузер снимает Range при потере фокуса), и к моменту клика
  // execCommand уже нечего форматировать — поэтому mousedown гасим отдельно от click.
  root.addEventListener("mousedown", function(e){
    if(e.target.closest('[data-action="wysiwyg-cmd"], [data-action="lb-menu-toggle"], [data-action="lb-insert"], [data-action="lb-op"]')) e.preventDefault();
    // Клик мышью по меню не оставляет в нём фокус: сайдбар не пересоздаётся при
    // перерисовке, и :focus-within держал бы его раскрытым после ухода курсора.
    // С клавиатуры (Tab) фокус и раскрытие работают как раньше. Пункты меню теперь
    // ссылки (<a>), не только <button> (группы) — гасим оба, иначе тот же самый
    // сдвиг клавиатурного фокуса случался бы только для части пунктов.
    if(e.target.closest(".sidebar .sidebar-item")) e.preventDefault();
  });
  root.addEventListener("click", async function(e){
    // Клик вне открытого поповера дашборд-фильтра закрывает его — не return,
    // чтобы клик по чему-то ещё (например, кнопке в таблице ниже) всё равно сработал.
    if(dashboardState.openFilterMenu && !e.target.closest(".dash-field")){
      dashboardState.openFilterMenu = null; render();
    }
    if(specPickerOpen && !e.target.closest(".spec-picker-field")){
      specPickerOpen = null; render();
    }
    if(staffState.lsMenu && !e.target.closest(".ls-menu-wrap")){
      staffState.lsMenu = null;
      if(!e.target.closest("[data-action]")) render();
    }
    var t = e.target.closest("[data-action]");
    if(!t) return;
    var action = t.getAttribute("data-action");
    // Пункт меню — ссылка: отменяем переход сразу, до первого await ниже, иначе
    // при клике из скрипта (el.click()) браузер успевает перейти по href.
    if(action==="sidebar-nav" && t.tagName==="A" && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) e.preventDefault();
    // Клик по фону окна с несохранённым вводом — сначала спросить.
    if(/^overlay-close/.test(action) && !e.target.closest("[data-stop]") && !t.__confirmedClose && overlayHasUnsaved(action, t)){
      askConfirm({ title:"Закрыть без сохранения?", body:"Введённое в этом окне пропадёт.", confirmLabel:"Закрыть", onConfirm:function(){
        var o = document.querySelector('.overlay[data-action="'+action+'"]');
        if(o){ o.__confirmedClose = true; o.click(); } else render();
      } });
      return;
    }
    var toolsRes = await handleToolsClick(action, t, e);
    if(toolsRes===true) return;
    if(typeof toolsRes==="string") action = toolsRes;

    if(action==="go-register"){ view="register"; registerDraft={name:"",email:"",phone:"",password:"",staffInviteCode:"",specializationIds:[],interestIds:[]}; specPickerOpen=null; render(); return; }
    if(action==="go-login"){ view="login"; render(); return; }
    if(action==="impersonate-student"){
      try{
        await api("/staff/students/"+t.getAttribute("data-id")+"/impersonate", { method:"POST" });
        try{ sessionStorage.setItem("lms-imp-return", t.getAttribute("data-id")); }catch(e){}
        window.location.reload();
      }catch(err){ showToast(err.message); }
      return;
    }
    if(action==="impersonate-stop"){
      try{ await api("/auth/impersonate/stop", { method:"POST" }); }catch(err){}
      window.location.reload();
      return;
    }
    if(action==="logout"){ stopNotificationPolling(); stopHeartbeat(); sendOfflineBeacon(); await api("/auth/logout", { method:"POST" }); me=null; course=null; view="login"; mySessionsList=[]; mySessionsLoaded=false; studentProtocols={forYou:[],additional:[]}; protocolExpanded={}; protocolGuideTab={}; render(); return; }
    if(action==="open-protocol"){ protocolReader = { id:t.getAttribute("data-id"), mine:t.getAttribute("data-mine")==="1" }; render(); return; }
    if(action==="close-protocol-reader" || (action==="overlay-close-protocol-reader" && !e.target.closest("[data-stop]"))){ protocolReader.id=null; render(); return; }
    if(action==="register-as"){ registerDraft.asStaff = t.getAttribute("data-staff")==="1"; if(registerDraft.asStaff){ registerDraft.specializationIds=[]; registerDraft.interestIds=[]; } render(); return; }
    if(action==="sidebar-group"){
      var gid=t.getAttribute("data-group"), grp=t.closest(".nav-group");
      if(t.closest(".sidebar.collapsed")){ try{ localStorage.setItem("lms-sb-collapsed","0"); }catch(err){} sidebarGroupsOpen[gid]=true; render(); return; }
      if(grp && grp.classList.contains("has-active")) return;
      sidebarGroupsOpen[gid]=!sidebarGroupsOpen[gid];
      try{ localStorage.setItem("lms-nav-groups", JSON.stringify(sidebarGroupsOpen)); }catch(e){}
      if(grp){ grp.classList.toggle("open", !!sidebarGroupsOpen[gid]); t.setAttribute("aria-expanded", !!sidebarGroupsOpen[gid]); }
      return;
    }
    if(action==="pick-avatar"){ var fi=document.getElementById("avatarFileInput"); if(fi) fi.click(); return; }
    if(action==="remove-avatar"){
      askConfirm({ title:"Убрать фото?", body:"Вы уверены, что хотите убрать фото профиля? Вместо него будут показаны инициалы.", confirmLabel:"Убрать фото",
        onConfirm: async function(){ try{ await api("/auth/me/avatar", { method:"DELETE" }); me.avatar_url=null; showToast("Фото убрано"); }catch(err){ showToast(err.message); } render(); } });
      return;
    }
    if(action==="set-theme"){ var nt=t.getAttribute("data-theme"); if(nt!==getTheme()){ setTheme(nt); embers = []; } render(); return; }
    if(action==="toggle-theme"){ toggleTheme(); render(); return; }
    if(action==="notif-filter"){ studentState.notifFilter = t.getAttribute("data-f"); render(); return; }
    if(action==="notif-open"){
      var nid2 = t.getAttribute("data-id");
      var nn = notifState.items.find(function(x){ return String(x.id)===nid2; }) || upcomingEventReminders().find(function(x){ return x.id===nid2; });
      if(!nn) return;
      if(!nn.synthetic && !nn.read_at){
        nn.read_at = new Date().toISOString(); notifState.unreadCount = Math.max(0, notifState.unreadCount-1);
        api("/notifications/"+nid2+"/read", { method:"POST" }).catch(function(){});
      }
      var ty = nn.synthetic ? "live" : nn.type;
      if(ty==="assignment_returned" || ty==="assignment_accepted"){
        var q = /«([^»]+)»/.exec(nn.body||""), li = q && course ? course.lessons.findIndex(function(l){ return l.title===q[1]; }) : -1;
        if(li!==-1){ studentState.tab="lesson"; studentState.navKey="course"; studentState.quizMode=false; studentState.lessonIndex=li; resetLessonStageState(); studentState.lessonStage="task"; render(); window.scrollTo(0,0); return; }
      }
      if(ty==="new_lesson" || ty==="content_unlocked" || ty==="course_opened" || ty==="access_unblocked"){ await applyStudentTab("course","course"); return; }
      if(ty==="survey_new"){ var sv2 = (studentTools.surveys||[]).find(function(x){ return !x.my_answers; }); if(sv2){ studentTools.fillId = sv2.id; studentTools.answers = {}; studentTools.surveyError = ""; } render(); return; }
      if(ty==="certificate_issued"){ await applyStudentTab("progress","progress"); return; }
      if(ty==="reminder" && course && !course.quizHiddenForMe){ studentState.tab="lesson"; studentState.navKey="course"; studentState.quizMode=true; studentState.quizSubmitted=false; render(); window.scrollTo(0,0); return; }
      if(ty==="live"){ await applyStudentTab("schedule","schedule"); return; }
      render(); return;
    }
    if(action==="mark-notif-read"){
      var nid=t.getAttribute("data-id");
      var n = notifState.items.find(function(x){ return x.id===nid; });
      if(n && !n.read_at){
        n.read_at = new Date().toISOString();
        notifState.unreadCount = Math.max(0, notifState.unreadCount-1);
        render();
        api("/notifications/"+nid+"/read", { method:"POST" }).catch(function(){});
      }
      return;
    }
    if(action==="mark-all-notifs-read"){
      notifState.items.forEach(function(n){ n.read_at = n.read_at || new Date().toISOString(); });
      notifState.unreadCount = 0;
      render();
      api("/notifications/read-all", { method:"POST" }).catch(function(){});
      return;
    }
    if(action==="revert-log"){
      askConfirm({
        title: 'Откатить действие «'+t.getAttribute("data-label")+'»?',
        body: "Это вернёт состояние к тому, что было до этого изменения.",
        confirmLabel: "Откатить", danger: false,
        onConfirm: async function(){
          t.disabled=true; t.textContent="Откатываем…";
          try{
            await api("/staff/audit-log/"+t.getAttribute("data-id")+"/revert", { method:"POST" });
            showToast("Действие откачено");
            var log = await api("/staff/audit-log"); staffState.auditLog=log.log;
            await loadStaffData();
          }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="logout-everywhere"){
      askConfirm({
        title: "Выйти со всех устройств?",
        body: "Понадобится войти заново здесь тоже.",
        confirmLabel: "Выйти", danger: false,
        onConfirm: async function(){
          stopNotificationPolling(); stopHeartbeat(); sendOfflineBeacon();
          try{ await api("/auth/logout-everywhere", { method:"POST" }); }catch(err){}
          me=null; course=null; view="login"; changePasswordOpen=false; render();
        }
      });
      return;
    }
    if(action==="open-change-password"){ changePasswordOpen=true; render(); return; }
    if(action==="close-change-password"){ changePasswordOpen=false; render(); return; }
    if(action==="overlay-close-password" && !e.target.closest("[data-stop]")){ changePasswordOpen=false; render(); return; }
    if(action==="confirm-modal-yes"){
      var confirmedFn = confirmState && confirmState.onConfirm;
      confirmState = null;
      if(confirmedFn) confirmedFn();
      else render();
      return;
    }
    if(action==="confirm-modal-no"){ confirmState=null; render(); return; }
    if(action==="overlay-close-confirm" && !e.target.closest("[data-stop]")){ confirmState=null; render(); return; }
    if(action==="open-profile-editor"){
      profileEditor.open=true;
      profileEditor.name=me.name||""; profileEditor.phone=me.phone||""; profileEditor.workplace=me.workplace||"";
      profileEditor.specializationIds=(me.specializationIds||[]).slice();
      profileEditor.interestIds=(me.interestIds||[]).slice();
      specPickerOpen=null;
      render(); return;
    }
    if(action==="close-profile-editor"){ profileEditor.open=false; render(); return; }
    if(action==="overlay-close-profile-editor" && !e.target.closest("[data-stop]")){ profileEditor.open=false; render(); return; }

    if(action==="student-tab"){
      await applyStudentTab(t.getAttribute("data-tab"));
      return;
    }
    if(action==="toggle-sidebar"){ try{ localStorage.setItem("lms-sb-collapsed", sidebarCollapsed() ? "0" : "1"); }catch(err){} render(); return; }
    if(action==="toggle-mobile-nav"){ mobileNavOpen = !mobileNavOpen; render(); return; }
    if(action==="close-mobile-nav"){ mobileNavOpen = false; render(); return; }
    if(action==="sidebar-nav"){
      // Пункты меню — теперь настоящие <a href="?tab=..."> (см. sidebarItem), чтобы
      // по ним работало ПКМ → «Открыть в новой вкладке» и Ctrl/⌘+клик — в этих
      // случаях отдаём браузеру его обычное поведение, а не гасим клик как обычно.
      if(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      await navigateToTab(t.getAttribute("data-key"));
      return;
    }
    if(action==="open-course"){
      if(course.locked && course.locked.locked){ showToast("Доступ к курсу ограничен — напишите куратору в Telegram-группе потока"); return; }
      studentState.tab="lesson"; studentState.lessonIndex=Math.min((course.progress&&course.progress.completed_lessons||[]).length, course.lessons.length-1); studentState.quizMode=false; studentState.quizSubmitted=false; resetLessonStageState(); render(); return;
    }
    if(action==="close-course"){ studentState.tab="course"; studentState.quizMode=false; render(); return; }
    if(action==="switch-course"){
      var newCourseId=t.getAttribute("data-course-id");
      if(newCourseId!==activeCourseId){
        activeCourseId=newCourseId;
        studentState.tab="course"; studentState.lessonIndex=0; studentState.quizMode=false; studentState.protocolsLoaded=false;
        resetLessonStageState();
        await loadCourse();
        render();
      }
      return;
    }
    if(action==="goto-lesson"){
      var goIdx=parseInt(t.getAttribute("data-idx"),10);
      var goLesson=course.lessons[goIdx];
      if(goLesson.hiddenForMe){ showToast("Этот урок временно недоступен"); return; }
      if(goLesson.dripLockedForMe){ showToast("Этот урок откроется "+fmtDate(goLesson.availableAt)); return; }
      studentState.lessonIndex=goIdx; studentState.quizMode=false; resetLessonStageState(); render(); return;
    }
    if(action==="open-term"){ openGlossaryTerm(t.getAttribute("data-id")); return; }
    if(action==="close-term" || (action==="overlay-close-term" && !e.target.closest("[data-stop]"))){ glossary.open=null; render(); return; }
    if(action==="term-tab"){ glossary.tab=t.getAttribute("data-tab"); render(); var glp=document.querySelector(".gl-panel"); if(glp) glp.scrollTop=0; return; }
    if(action==="term-goto-lesson"){
      glossary.open=null;
      studentState.tab="lesson"; studentState.lessonIndex=parseInt(t.getAttribute("data-idx"),10); studentState.quizMode=false; resetLessonStageState();
      render(); window.scrollTo(0,0); return;
    }
    if(action==="lesson-toc-menu"){ var ltm = document.getElementById("lessonTocMenu"); if(ltm){ ltm.hidden = !ltm.hidden; lessonTocSpy(); } return; }
    if(action==="lesson-toc"){
      var tocI = t.getAttribute("data-i");
      var tocGo = function(){
        var tocH = tocI==="cheat" ? document.querySelector("#lessonProse .lb-cheat") : document.querySelectorAll("#lessonProse h4")[parseInt(tocI,10)];
        if(tocH) tocH.scrollIntoView({ behavior:"smooth", block:"start" });
      };
      var ltm2 = document.getElementById("lessonTocMenu"); if(ltm2) ltm2.hidden = true;
      // Раздел выбран с вкладки «Тест»/«Видео» — сначала возвращаемся к тексту урока.
      if(!document.getElementById("lessonProse")){ studentState.lessonStage = "intro"; render(); setTimeout(tocGo, 60); }
      else tocGo();
      return;
    }
    if(action==="lesson-stage"){
      studentState.lessonStage = t.getAttribute("data-stage"); render(); return;
    }
    if(action==="seek-lesson-video"){
      var v = document.getElementById("lessonVideoPlayer");
      if(v) v.currentTime = parseFloat(t.getAttribute("data-time"));
      return;
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
    if(action==="qr-pick"){ qzPick(t.getAttribute("data-key"), t.getAttribute("data-path"), parseInt(t.getAttribute("data-o"),10), t.hasAttribute("data-multi")); return; }
    if(action==="qr-goto"){ qzGo(t.getAttribute("data-key"), parseInt(t.getAttribute("data-i"),10)); return; }
    if(action==="qr-prev"){ var qpK=t.getAttribute("data-key"); qzGo(qpK, Math.max(0,(quizRun(qpK).step||0)-1)); return; }
    if(action==="qr-next"){ var qnK=t.getAttribute("data-key"); qzGo(qnK, (quizRun(qnK).step||0)+1); return; }
    if(action==="qr-submit"){ await qzSubmit(t.getAttribute("data-key")); return; }
    if(action==="qr-move"){
      var mvRun=quizRun(t.getAttribute("data-key")), mvPath=t.getAttribute("data-path"), mvI=parseInt(t.getAttribute("data-i"),10), mvD=parseInt(t.getAttribute("data-dir"),10);
      var mvArr=(mvRun.answers[mvPath]||[]).slice(), mvJ=mvI+mvD;
      if(mvJ<0 || mvJ>=mvArr.length) return;
      var mvTmp=mvArr[mvI]; mvArr[mvI]=mvArr[mvJ]; mvArr[mvJ]=mvTmp; mvRun.answers[mvPath]=mvArr; render(); return;
    }
    if(action==="qr-match"){
      // Выбор пары: если этот вариант уже стоит у другого пункта — пары меняются местами.
      var mtRun=quizRun(t.getAttribute("data-key")), mtPath=t.getAttribute("data-path"), mtL=t.getAttribute("data-l"), mtT=t.getAttribute("data-t");
      var mtVal=Object.assign({}, mtRun.answers[mtPath]||{});
      var mtPrev=mtVal[mtL];
      Object.keys(mtVal).forEach(function(k){ if(k!==mtL && mtVal[k]===mtT){ if(mtPrev) mtVal[k]=mtPrev; else delete mtVal[k]; } });
      if(mtPrev===mtT) delete mtVal[mtL]; else mtVal[mtL]=mtT;
      mtRun.answers[mtPath]=mtVal; render(); return;
    }
    if(action==="set-home-bg"){
      try{ localStorage.setItem("lms-home-bg", t.getAttribute("data-bg")); }catch(err){}
      embers = []; render();
      showToast("Фон главной: «"+t.querySelector("b").childNodes[0].textContent.trim()+"» — посмотрите на главной"); return;
    }
    if(action==="set-home-fx"){ try{ localStorage.setItem("lms-home-fx", t.getAttribute("data-fx")); }catch(err){} render(); showToast("Анимация главной: «"+t.querySelector("b").childNodes[0].textContent.trim()+"» — посмотрите на главной"); return; }
    if(action==="final-quiz-retry"){ delete quizRuns["final"]; studentState.quizSubmitted=false; render(); window.scrollTo(0,0); return; }
    if(action==="final-quiz-done"){ studentState.quizSubmitted=false; render(); window.scrollTo(0,0); return; }
    if(action==="lq-retry"){ var lrL=course.lessons[studentState.lessonIndex]; if(lrL) delete quizRuns["lesson:"+lrL.id]; studentState.lessonQuizResult=null; render(); return; }
    if(action==="nb-open-hl"){
      if(e.target.closest("[data-action='nb-del-hl']")) return;
      var hIdx=parseInt(t.getAttribute("data-idx"),10), hL=course.lessons[hIdx];
      if(hL.hiddenForMe || hL.dripLockedForMe){ showToast("Этот урок сейчас недоступен"); return; }
      studentState.tab="lesson"; studentState.lessonIndex=hIdx; studentState.quizMode=false; resetLessonStageState();
      studentState.scrollToHl=t.getAttribute("data-hid"); render(); return;
    }
    if(action==="nb-del-hl"){
      var dLid=t.getAttribute("data-lesson-id");
      try{
        var rD=await api("/course/lessons/"+dLid+"/highlights/"+encodeURIComponent(t.getAttribute("data-hid")), { method:"DELETE" });
        if(rD.highlights.length) course.progress.lesson_highlights[dLid]=rD.highlights; else delete course.progress.lesson_highlights[dLid];
        render(); showToast("Выделение убрано");
      }catch(err){ showToast(err.message); }
      return;
    }
    if(action==="nb-note-edit"){
      studentState.nbEditId=t.getAttribute("data-id"); render();
      var nIn=document.getElementById("nbNoteInput"); if(nIn){ nIn.focus(); nIn.selectionStart=nIn.selectionEnd=nIn.value.length; }
      return;
    }
    if(action==="nb-note-cancel"){ studentState.nbEditId=null; render(); return; }
    if(action==="nb-note-save"){
      var nId=t.getAttribute("data-id"), nVal=(document.getElementById("nbNoteInput")||{}).value||"";
      try{
        await api("/course/lessons/"+nId+"/note", { method:"PUT", body: JSON.stringify({ note:nVal }) });
        if(!course.progress.lesson_notes) course.progress.lesson_notes={};
        if(nVal.trim()) course.progress.lesson_notes[nId]=nVal.trim(); else delete course.progress.lesson_notes[nId];
        studentState.nbEditId=null; render(); showToast("Заметка сохранена");
      }catch(err){ showToast(err.message); }
      return;
    }
    if(action==="materials-filter"){ studentState.materialsFilter=t.getAttribute("data-filter"); render(); return; }
    if(action==="toggle-bookmark"){
      var bkId=t.getAttribute("data-id"); var wasBookmarked=t.getAttribute("data-bookmarked")==="1";
      if(!course.bookmarkedLessonIds) course.bookmarkedLessonIds=[];
      if(wasBookmarked) course.bookmarkedLessonIds=course.bookmarkedLessonIds.filter(function(id){ return id!==bkId; });
      else course.bookmarkedLessonIds.push(bkId);
      render();
      api("/course/lessons/"+bkId+"/bookmark", { method:"PUT", body: JSON.stringify({ bookmarked: !wasBookmarked }) }).catch(function(){});
      return;
    }
    if(action==="goto-lesson-from-materials"){
      var gmL=course.lessons[parseInt(t.getAttribute("data-idx"),10)];
      if(gmL && (gmL.hiddenForMe || gmL.dripLockedForMe)){ showToast("Этот урок сейчас недоступен"); return; }
      studentState.tab="lesson"; studentState.lessonIndex=parseInt(t.getAttribute("data-idx"),10); studentState.quizMode=false; resetLessonStageState(); render(); return;
    }
    if(action==="open-lesson-at"){
      var oi=parseInt(t.getAttribute("data-idx"),10), ol=course.lessons[oi];
      if(ol.hiddenForMe || ol.dripLockedForMe) return;
      studentState.tab="lesson"; studentState.lessonIndex=oi; studentState.quizMode=false; resetLessonStageState(); render(); return;
    }
    if(action==="open-final-quiz"){
      if(course.quizHiddenForMe){ showToast("Тест временно недоступен"); return; }
      studentState.tab="lesson"; studentState.quizMode=true; studentState.quizSubmitted=false; render(); return;
    }
    if(action==="goto-quiz"){
      if(course.quizHiddenForMe){ showToast("Тест временно недоступен"); return; }
      studentState.quizMode=true; studentState.quizSubmitted=false; render(); return;
    }
    if(action==="prev-lesson"){ if(studentState.lessonIndex>0) studentState.lessonIndex--; resetLessonStageState(); render(); return; }
    if(action==="next-lesson"){
      var lid = course.lessons[studentState.lessonIndex].id;
      var wasProtoAvailNL = protocolsSectionAvailable();
      // Если урок уже засчитан поурочным тестом (lessonQuizResult проставлен
      // POST /lessons/:id/quiz-submit атомарно), второй раз /lesson-done не дёргаем.
      if(!studentState.lessonQuizResult){
        if(!previewMode){
          try{ var r = await api("/course/lesson-done", { method:"POST", body: JSON.stringify({lessonId:lid}) }); course.progress.completed_lessons = r.completedLessons; if(r.gamification) course.gamification = Object.assign({}, course.gamification, r.gamification); }catch(err){ showToast(err.message); }
        } else {
          course.progress.completed_lessons.push(lid);
        }
      }
      maybeCelebrateProtocolsUnlock(wasProtoAvailNL);
      advanceAfterLesson();
      render(); return;
    }
    if(action==="module-gate-to-feedback"){
      studentState.moduleGateStage="feedback"; studentState.moduleQuizResult=null; render(); return;
    }
    if(action==="set-module-feedback-rating"){
      studentState.moduleFeedbackRating = parseInt(t.getAttribute("data-value"),10); render(); return;
    }
    if(action==="submit-module-feedback"){
      var mfModuleId = t.getAttribute("data-module-id");
      var mfComment = document.getElementById("moduleFeedbackComment");
      studentState.moduleFeedbackComment = mfComment ? mfComment.value : "";
      if(!studentState.moduleFeedbackRating){ showToast("Выберите оценку"); return; }
      if(!previewMode){
        try{
          await api("/course/modules/"+mfModuleId+"/feedback", { method:"POST", body: JSON.stringify({
            rating: studentState.moduleFeedbackRating, comment: studentState.moduleFeedbackComment
          }) });
        }catch(err){ showToast(err.message); return; }
      }
      if(!course.moduleFeedbackGiven) course.moduleFeedbackGiven=[];
      if(course.moduleFeedbackGiven.indexOf(mfModuleId)===-1) course.moduleFeedbackGiven.push(mfModuleId);
      resetModuleGateState();
      // lessonIndex/quizMode уже стоят на следующем шаге — их выставил
      // advanceAfterLesson() ДО того, как renderCoursePlayer показал этот гейт
      // (см. findPendingModuleGate); здесь просто убираем гейт с дороги.
      render(); return;
    }
    if(action==="welcome-start"){
      // Приветствие уезжает, главная въезжает (см. .wl-leave / .home-enter в styles.css).
      var wl = document.getElementById("welcomeHome");
      var go = function(){ course.progress = course.progress || {}; course.progress.welcome_seen = true; homeEnterAnim = true; render(); window.scrollTo(0, 0); };
      if(!previewMode) api("/course/welcome-seen", { method:"PUT" }).catch(function(){});
      if(wl && !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)){ wl.classList.add("wl-leave"); setTimeout(go, 460); } else go();
      return;
    }
    if(action==="request-full"){
      if(previewMode){ showToast("Режим просмотра — заявки не отправляются"); return; }
      t.disabled=true;
      try{ await api("/course/request-full-access", { method:"POST", body: JSON.stringify({ courseId: activeCourseId }) }); course.progress.requested_full_access=true; showToast("Заявка отправлена куратору"); }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="toggle-protocol"){
      var tpId=t.getAttribute("data-id"); protocolExpanded[tpId]=!protocolExpanded[tpId]; render(); return;
    }
    if(action==="select-protocol-guide"){
      var sgId=t.getAttribute("data-id"); protocolGuideTab[sgId]=t.getAttribute("data-spec"); render(); return;
    }
    if(action==="dismiss-onboarding"){
      course.progress.onboarding_dismissed=true; render();
      api("/course/onboarding-dismiss", { method:"PUT" }).catch(function(){});
      return;
    }
    if(action==="download-ics"){
      var evObj = calendarState.events.filter(function(x){ return x.id===t.getAttribute("data-id"); })[0];
      if(evObj) downloadICS(evObj);
      return;
    }

    if(action==="toggle-invite-student"){ staffState.showInviteStudent=!staffState.showInviteStudent; render(); return; }
    if(action==="toggle-import-students"){ staffState.showImportStudents=!staffState.showImportStudents; staffState.importResult=null; render(); return; }
    if(action==="invite-mode"){ staffState.inviteMode=t.getAttribute("data-mode"); render(); return; }
    if(action==="open-course-preview"){
      staffState.lsMenu = null;
      previewMode = true; previewReturnTab = staffState.mainTab;
      try{ course = await api("/staff/course-preview"+(staffState.activeCourseId?"?courseId="+encodeURIComponent(staffState.activeCourseId):"")); }
      catch(err){ showToast(err.message); previewMode=false; return; }
      studentState = { tab:"course", navKey:"course", lessonIndex:0, quizMode:false, quizSubmitted:false,
        lessonStage:"intro", videoEnded:false, lessonQuizResult:null };
      // «Как видит врач» со страницы или из меню урока — сразу этот урок.
      var pvIdx = parseInt(t.getAttribute("data-idx"),10);
      if(!isNaN(pvIdx) && course.lessons && course.lessons[pvIdx]){ studentState.tab="lesson"; studentState.lessonIndex=pvIdx; resetLessonStageState(); }
      view = "student";
      render(); return;
    }
    if(action==="exit-preview"){
      previewMode = false; course = null; view = "staff";
      staffState.mainTab = previewReturnTab || "students";
      staffState.navKey = staffState.mainTab;
      render(); return;
    }
    if(action==="open-student"){ await openStudentPage(t.getAttribute("data-id")); return; }
    if(action==="close-drawer" || (action==="overlay-close" && !e.target.closest("[data-stop]"))){ staffState.selectedStudentId=null; render(); return; }
    if(action==="drawer-tab"){
      staffState.drawerTab=t.getAttribute("data-tab"); render();
      if(staffState.drawerTab==="tasks"){ await loadStudentAssign(staffState.selectedStudentId); render(); }
      if(staffState.drawerTab==="orders"){ await loadOrders(); render(); }
      if(staffState.drawerTab==="notes"){
        try{ var dn=await api("/staff/students/"+staffState.selectedStudentId+"/notes"); staffState.notes=dn.notes; render(); }catch(err){ showToast(err.message); }
      }
      return;
    }
    if(action==="save-student-profile"){
      var spId=t.getAttribute("data-id");
      var spSpecIds=staffState.editSpecializationIds;
      var spPayload={
        name: staffState.editName,
        specializationIds: spSpecIds,
        phone: staffState.editPhone,
        workplace: staffState.editWorkplace
      };
      t.disabled=true; t.textContent="Сохраняем…";
      try{
        await api("/staff/students/"+spId+"/profile", { method:"PATCH", body: JSON.stringify(spPayload) });
        // specialization_ids/specializations (список имён — то, что показывают ростер
        // и шапка карточки) досчитываем сами — иначе они остались бы старыми до
        // следующей перезагрузки списка.
        var spMerge=Object.assign({}, spPayload, {
          specialization_ids: spSpecIds,
          specializations: spSpecIds.map(function(id){
            var m=specializationsList.find(function(sp){ return sp.id===id; }); return m?m.name:id;
          })
        });
        delete spMerge.specializationIds;
        staffState.selectedStudent=Object.assign({}, staffState.selectedStudent, spMerge);
        var spIdx=staffState.students.findIndex(function(x){ return x.id===spId; });
        if(spIdx!==-1) staffState.students[spIdx]=Object.assign({}, staffState.students[spIdx], spMerge);
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
    if(action==="issue-certificate"){
      t.disabled=true; t.textContent="Выдаём…";
      try{
        await api("/course/certificate/"+t.getAttribute("data-id")+"/issue", { method:"POST", body: JSON.stringify({ courseId: staffState.activeCourseId }) });
        showToast("Сертификат выдан"); await loadStaffData();
        if(staffState.selectedStudentId) await refreshSelectedStudent();
      }
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
    if(action==="enroll-student"){
      var enrSelect=document.getElementById("enrollCourseSelect");
      var enrCourseId=enrSelect?enrSelect.value:"";
      if(!enrCourseId) return;
      try{
        await api("/staff/students/"+t.getAttribute("data-id")+"/enroll", { method:"POST", body: JSON.stringify({ courseId: enrCourseId }) });
        showToast("Врач записан на курс");
        await refreshSelectedStudent();
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="remove-staff"){
      askConfirm({
        title: "Отозвать доступ у этого человека?", confirmLabel: "Отозвать", danger: true,
        onConfirm: async function(){
          try{ await api("/staff/team/"+t.getAttribute("data-id"), { method:"DELETE" }); await loadStaffData(); showToast("Доступ отозван"); }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="reset-student-password"){
      askConfirm({
        title: "Создать новый пароль для этого врача?",
        body: "Старый перестанет работать.",
        confirmLabel: "Создать пароль", danger: false,
        onConfirm: async function(){
          try{ var r1=await api("/staff/students/"+t.getAttribute("data-id")+"/reset-password", { method:"POST" }); tempPasswordResult={ name:t.getAttribute("data-name"), tempPassword:r1.tempPassword }; }
          catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="reset-staff-password"){
      askConfirm({
        title: "Создать новый пароль для этого сотрудника?",
        body: "Старый перестанет работать.",
        confirmLabel: "Создать пароль", danger: false,
        onConfirm: async function(){
          try{ var r2=await api("/staff/team/"+t.getAttribute("data-id")+"/reset-password", { method:"POST" }); tempPasswordResult={ name:t.getAttribute("data-name"), tempPassword:r2.tempPassword }; }
          catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="close-temp-password"){ tempPasswordResult=null; render(); return; }

    if(action==="switch-staff-course"){
      var newSCourseId=t.getAttribute("data-course-id");
      if(newSCourseId!==staffState.activeCourseId){
        staffState.activeCourseId=newSCourseId;
        staffState.selectedStudentId=null; staffState.selectedStudent=null;
        toolsState.assign.loaded=false; toolsState.feed.loaded=false;
        await loadStaffData();
        render();
        if(staffState.mainTab==="assignments"||staffState.mainTab==="feed"){ await loadToolsSection(staffState.mainTab); render(); }
      }
      return;
    }
    if(action==="toggle-create-course"){ staffState.showCreateCourse=!staffState.showCreateCourse; render(); if(staffState.showCreateCourse){ var ci=document.querySelector('#createCourseForm input'); if(ci) ci.focus(); } return; }
    if(action==="edit-course-open"){
      var ecId=t.getAttribute("data-id");
      var ecCourse=staffState.coursesList.find(function(c){return c.id===ecId;});
      if(!ecCourse) return;
      staffState.courseEditorId=ecId; staffState.courseEditorTitle=ecCourse.title; staffState.courseEditorCertsEnabled=ecCourse.certificatesEnabled;
      staffState.courseDeleteConfirmId=null;
      render(); return;
    }
    if(action==="cancel-edit-course"){ staffState.courseEditorId=null; render(); return; }
    if(action==="save-course"){
      var titleInp=document.getElementById("courseEditTitleInput");
      var certsInp=document.getElementById("courseEditCertsInput");
      var newTitle=titleInp?titleInp.value.trim():"";
      if(!newTitle){ showToast("Укажите название курса"); return; }
      try{
        await api("/courses/"+staffState.courseEditorId, { method:"PUT", body: JSON.stringify({ title:newTitle, certificatesEnabled: certsInp?certsInp.checked:false }) });
        staffState.courseEditorId=null;
        await loadStaffData();
        showToast("Курс обновлён");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="delete-course-open"){
      staffState.courseDeleteConfirmId=t.getAttribute("data-id");
      staffState.courseEditorId=null;
      render(); return;
    }
    if(action==="cancel-delete-course"){ staffState.courseDeleteConfirmId=null; render(); return; }
    if(action==="confirm-delete-course"){
      var confirmInp=document.getElementById("courseDeleteConfirmInput");
      try{
        await api("/courses/"+t.getAttribute("data-id"), { method:"DELETE", body: JSON.stringify({ confirmTitle: confirmInp?confirmInp.value:"" }) });
        staffState.courseDeleteConfirmId=null;
        if(staffState.activeCourseId===t.getAttribute("data-id")) staffState.activeCourseId=null;
        await loadStaffData();
        showToast("Курс удалён");
      }catch(err){ showToast(err.message); }
      render(); return;
    }

    /* ---------- Уроки: список и страница урока ---------- */
    if(action==="ls-noop") return;
    /* ---------- Термины ---------- */
    if(action==="gl-new"){ glossaryAdmin.edit = glDraft(null); glossaryAdmin.dirty = false; glossaryAdmin.tab = "brief"; glossaryAdmin.check = []; render(); window.scrollTo(0,0); return; }
    if(action==="gl-edit"){
      var glT = glossaryAdmin.list.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!glT) return;
      glossaryAdmin.edit = glDraft(glT); glossaryAdmin.dirty = false; glossaryAdmin.tab = "brief"; glossaryAdmin.check = glT.foundIn || [];
      render(); window.scrollTo(0,0); return;
    }
    if(action==="gl-close"){
      if(glossaryAdmin.dirty && !window.confirm("Уйти без сохранения? Изменения термина пропадут.")) return;
      glossaryAdmin.edit = null; glossaryAdmin.dirty = false; render(); return;
    }
    if(action==="gl-preview-tab"){ glossaryAdmin.tab = t.getAttribute("data-tab"); var glPv = document.getElementById("glPreview"); if(glPv) glPv.innerHTML = glPreviewHtml(); return; }
    if(action==="gl-row-add" || action==="gl-row-del"){
      var glPath = t.getAttribute("data-list"), glArr = glPath.split(".").reduce(function(o, k){ return o[k]; }, glossaryAdmin.edit);
      var glLimits = { "key.scale":5, "meaning.stats":4, "actions":8, "more":10 };
      if(action==="gl-row-add"){
        if(glArr.length >= (glLimits[glPath]||10)){ showToast("Больше не поместится — лучше короче"); return; }
        glArr.push(glPath==="key.scale" ? ["","","ok"] : glPath==="actions" ? ["check","",""] : ["",""]);
      } else glArr.splice(parseInt(t.getAttribute("data-i"),10), 1);
      glossaryAdmin.dirty = true; render(); return;
    }
    if(action==="gl-save"){
      var gd = glossaryAdmin.edit;
      if(!gd.title.trim()){ showToast("Укажите название термина"); return; }
      if(!glAliases(gd).length){ showToast("Добавьте хотя бы одно написание — по нему термин ищется в тексте"); return; }
      var gPayload = Object.assign({ courseId: staffState.activeCourseId }, glDraftTerm(gd));
      t.disabled = true;
      try{
        var gRes = gd.id ? await api("/glossary/"+encodeURIComponent(gd.id), { method:"PUT", body: JSON.stringify(gPayload) })
                         : await api("/glossary", { method:"POST", body: JSON.stringify(gPayload) });
        await glAdminLoad();
        var gSaved = glossaryAdmin.list.find(function(x){ return x.id===(gd.id || gRes.id); });
        glossaryAdmin.edit = gSaved ? glDraft(gSaved) : null; glossaryAdmin.dirty = false;
        if(gSaved) glossaryAdmin.check = gSaved.foundIn || [];
        glossary.courseId = null; // врачу в предпросмотре — свежий глоссарий
        showToast(gd.id ? "Термин сохранён" : "Термин создан — он уже подсвечивается в уроках");
      }catch(err){ showToast(err.message); t.disabled = false; return; }
      render(); return;
    }
    if(action==="gl-delete"){
      var gdel = glossaryAdmin.edit;
      askConfirm({ title:'Удалить термин «'+gdel.title+'»?', body:"Слово перестанет подсвечиваться в уроках.", confirmLabel:"Удалить", danger:true,
        onConfirm: async function(){
          try{ await api("/glossary/"+encodeURIComponent(gdel.id), { method:"DELETE" }); glossaryAdmin.edit = null; glossaryAdmin.dirty = false; await glAdminLoad(); showToast("Термин удалён"); }
          catch(err){ showToast(err.message); }
          render();
        } });
      return;
    }
    if(action==="home-new-protocol" || action==="home-open-protocol"){
      var hpId = t.getAttribute("data-id");
      await navigateToTab("protocols");
      if(staffState.mainTab!=="protocols") return;
      var hp = hpId ? (adminProtocolsState.list||[]).find(function(x){ return x.id===hpId; }) : null;
      protocolEditor = hp ? { open:true, id:hp.id, title:hp.title, summary:hp.summary||"", guides:hp.guides.slice(), lessonIds:hp.lessonIds.slice() }
        : { open:true, id:null, title:"", summary:"", guides:[], lessonIds:[] };
      render(); window.scrollTo(0,0); return;
    }
    if(action==="home-invite"){
      await navigateToTab("students");
      if(staffState.mainTab!=="students") return;
      staffState.showInviteStudent = true; render();
      var hiForm = document.getElementById("inviteStudentForm");
      if(hiForm){ hiForm.scrollIntoView({ behavior:"smooth", block:"center" }); var hiIn = hiForm.querySelector("input"); if(hiIn) hiIn.focus(); }
      return;
    }
    if(action==="ls-menu"){ var lmKey=t.getAttribute("data-key"); staffState.lsMenu = staffState.lsMenu===lmKey ? null : lmKey; render(); return; }
    if(action==="toggle-module-create"){ staffState.showModuleCreate=!staffState.showModuleCreate; render(); return; }
    if(action==="open-lesson-page" || action==="lesson-page-go"){
      var olpId=t.getAttribute("data-id");
      if(!olpId) return;
      staffState.lsMenu=null;
      if(staffState.lessonPageId && !lpLeaveOk()){ render(); return; }
      var olpTab=t.getAttribute("data-tab") || (action==="lesson-page-go" ? staffState.lessonPageTab : null);
      // Со главной («Что доделать в курсе») — сначала в раздел «Уроки».
      if(staffState.mainTab!=="materials"){ staffState.mainTab="materials"; staffState.navKey="materials"; }
      lpCloseEditors(); lpAuto = { pending:null, fails:{} };
      staffState.lessonPageId=olpId;
      staffState.lessonPageTab=olpTab || (olpId==="quiz" ? (isAdminRole()?"questions":"access") : (isAdminRole()?"content":"schedule"));
      render(); window.scrollTo(0,0); return;
    }
    if(action==="close-lesson-page"){
      if(!lpLeaveOk()) return;
      lpCloseEditors(); staffState.lessonPageId=null; staffState.lsMenu=null; render(); return;
    }
    if(action==="lesson-page-tab"){
      var lptTab=t.getAttribute("data-tab");
      if(lptTab===staffState.lessonPageTab) return;
      if(!lpLeaveOk()) return;
      lpCloseEditors(); staffState.lessonPageTab=lptTab; render(); return;
    }
    if(action==="ls-move"){
      var lmvId=t.getAttribute("data-id"), lmvDir=t.getAttribute("data-dir");
      var lmvArr=lsLessons(), lmvI=lmvArr.findIndex(function(x){ return x.id===lmvId; });
      if(lmvI===-1) return;
      var lmvMod=lmvArr[lmvI].module_id||"", lmvJ=-1;
      if(lmvDir==="up"){ for(var ui=lmvI-1; ui>=0; ui--){ if((lmvArr[ui].module_id||"")===lmvMod){ lmvJ=ui; break; } } }
      else { for(var di=lmvI+1; di<lmvArr.length; di++){ if((lmvArr[di].module_id||"")===lmvMod){ lmvJ=di; break; } } }
      staffState.lsMenu=null;
      if(lmvJ===-1){ showToast(lmvDir==="up"?"Урок уже первый в модуле":"Урок уже последний в модуле"); render(); return; }
      await lsApplyMove(lmvId, lmvArr[lmvJ].id, lmvDir==="up"?"before":"after", null);
      return;
    }
    if(action==="ls-set-module"){
      staffState.lsMenu=null;
      await lsApplyMove(t.getAttribute("data-id"), null, "into", t.getAttribute("data-module")||"");
      return;
    }
    if(action==="pr-scroll"){ var prTarget=document.getElementById(t.getAttribute("data-target")); if(prTarget) prTarget.scrollIntoView({ behavior:"smooth", block:"start" }); return; }
    if(action==="pick-guide-spec"){
      protocolEditor.newSpec=t.getAttribute("data-spec"); render();
      var prAdd=document.getElementById("prGuideAdd"); if(prAdd) prAdd.scrollIntoView({ behavior:"smooth", block:"center" });
      var prTa=document.getElementById("newGuideText"); if(prTa) prTa.focus();
      return;
    }
    if(action==="edit-protocol-guide"){ protocolEditor.editSpec=t.getAttribute("data-spec"); render(); return; }
    if(action==="cancel-protocol-guide-edit"){ protocolEditor.editSpec=null; render(); return; }
    if(action==="save-protocol-guide-edit"){
      var geSpec=t.getAttribute("data-spec"), geTa=document.getElementById("guideEditText");
      if(!geTa || !geTa.value.trim()){ showToast("Текст гайда не может быть пустым"); return; }
      t.disabled=true;
      try{
        var geRes=await api("/protocols/"+protocolEditor.id+"/guides/"+geSpec, { method:"PUT", body: JSON.stringify({ guideHtml: geTa.value }) });
        var geG=protocolEditor.guides.find(function(g){ return g.specializationId===geSpec; });
        if(geG) geG.guideHtml=geRes.guideHtml;
        var geIdx=adminProtocolsState.list.findIndex(function(x){ return x.id===protocolEditor.id; });
        if(geIdx!==-1) adminProtocolsState.list[geIdx].guides = protocolEditor.guides.slice();
        protocolEditor.editSpec=null;
        showToast("Гайд обновлён");
      }catch(err){ showToast(err.message); t.disabled=false; return; }
      render(); return;
    }

    if(action==="open-lesson-editor"){ await openLessonEditor(t.getAttribute("data-id")); return; }
    if(action==="open-lesson-creator"){
      lessonEditor = { open:true, isNew:true, id:null, title:"", duration:"", html:"<p></p>", dripDays:null, hasDraft:false, publishedTitle:"", publishedDuration:"", publishedHtml:"", history:[], showHistory:false, showPreview:false };
      render(); return;
    }
    if(action==="close-lesson-editor"){ lessonEditor.open=false; render(); return; }
    if(action==="overlay-close-lesson-editor" && !e.target.closest("[data-stop]")){ lessonEditor.open=false; render(); return; }
    if(action==="lb-menu-toggle"){ var lbm = document.getElementById("lbMenu"); if(lbm) lbm.hidden = !lbm.hidden; return; }
    if(action==="lb-insert"){ var lbm2 = document.getElementById("lbMenu"); if(lbm2) lbm2.hidden = true; lbInsert(t.getAttribute("data-kind")); return; }
    if(action==="lb-op"){ lbOp(t.getAttribute("data-op")); return; }
    if(action==="wysiwyg-cmd"){
      var wTarget=document.getElementById(t.getAttribute("data-target"));
      var wHidden=document.getElementById(t.getAttribute("data-hidden"));
      if(!wTarget) return;
      wTarget.focus();
      var cmd=t.getAttribute("data-cmd");
      if(cmd==="h3"||cmd==="h4"||cmd==="h5") document.execCommand("formatBlock", false, cmd.toUpperCase());
      else if(cmd==="p") document.execCommand("formatBlock", false, "P");
      else if(cmd==="quote") document.execCommand("formatBlock", false, "BLOCKQUOTE");
      else if(cmd==="ul") document.execCommand("insertUnorderedList");
      else if(cmd==="ol") document.execCommand("insertOrderedList");
      else if(cmd==="hr") document.execCommand("insertHorizontalRule");
      else if(cmd==="clear") document.execCommand("removeFormat");
      else if(cmd==="link"){
        var url=prompt("Ссылка (полный адрес, начиная с https://):");
        if(url && url.trim()) document.execCommand("createLink", false, url.trim());
      }
      else if(cmd==="image"){
        var imgUrl=prompt("Ссылка на изображение:");
        if(imgUrl && imgUrl.trim()) document.execCommand("insertImage", false, imgUrl.trim());
      }
      else if(cmd==="video"){
        var vidUrl=prompt("Ссылка для встраивания (embed-URL, например из YouTube: «Поделиться» → «Встроить»):");
        if(vidUrl && vidUrl.trim()){
          var embedHtml='<div class="video-wrap"><iframe src="'+escapeHtml(vidUrl.trim())+'" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen frameborder="0"></iframe></div><p><br></p>';
          document.execCommand("insertHTML", false, embedHtml);
        }
      }
      else document.execCommand(cmd);
      if(wTarget.id==="lessonWysiwygEditor") lbSync();
      else if(wHidden) wHidden.value = wTarget.innerHTML;
      return;
    }
    if(action==="delete-lesson"){
      staffState.lsMenu = null;
      askConfirm({
        title: 'Удалить урок «'+t.getAttribute("data-title")+'»?',
        body: "Действие можно откатить в журнале.",
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
          try{ await api("/course/lessons/"+t.getAttribute("data-id"), { method:"DELETE" }); showToast("Урок удалён"); await loadStaffData(); }
          catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
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
      askConfirm({
        title: "Восстановить эту версию урока?",
        body: "Текущая опубликованная версия перед этим тоже сохранится в историю.",
        confirmLabel: "Восстановить", danger: false,
        onConfirm: async function(){
      try{
        await api("/course/lessons/"+lessonEditor.id+"/restore/"+t.getAttribute("data-history-id"), { method:"POST" });
        showToast("Версия восстановлена");
        lessonEditor.open=false;
        await loadStaffData();
      }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }

    if(action==="open-quiz-editor"){
      var q=staffState.quizAdmin.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!q) return;
      quizEditor = qeFromRow(q, null, null);
      render(); return;
    }
    if(action==="open-quiz-creator"){
      quizEditor = qeNew(null, null);
      render(); return;
    }
    if(action==="close-quiz-editor"){ quizEditor.open=false; render(); return; }
    if(action==="overlay-close-quiz-editor" && !e.target.closest("[data-stop]")){ quizEditor.open=false; render(); return; }
    // Общий обработчик и для вопроса итогового теста, и для поурочного —
    // после удаления обновляем тот список, который сейчас реально открыт.
    if(action==="delete-quiz-question"){
      askConfirm({
        title: "Удалить этот вопрос теста?",
        body: "Действие можно откатить в журнале.",
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
      try{
        await api("/course/quiz-admin/"+t.getAttribute("data-id"), { method:"DELETE" });
        showToast("Вопрос удалён");
        if(lessonQuizManager.open){
          var lqd=await api("/course/lessons/"+lessonQuizManager.lessonId+"/quiz-admin");
          lessonQuizManager.questions=lqd.quiz;
        } else if(moduleQuizManager.open){
          var mqd=await api("/course/modules/"+moduleQuizManager.moduleId+"/quiz-admin");
          moduleQuizManager.questions=mqd.quiz;
          await loadStaffData(); // обновить счётчик вопросов у карточки модуля
        } else {
          await loadStaffData();
        }
      }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="move-quiz-question"){
      var mqId=t.getAttribute("data-id"); var mqDir=t.getAttribute("data-dir");
      var mqIdx=staffState.quizAdmin.findIndex(function(x){ return x.id===mqId; });
      var mqSwap = mqDir==="up" ? mqIdx-1 : mqIdx+1;
      if(mqIdx===-1 || mqSwap<0 || mqSwap>=staffState.quizAdmin.length) return;
      var mqPrev = staffState.quizAdmin.slice();
      var mqArr = staffState.quizAdmin;
      var mqTmp = mqArr[mqIdx]; mqArr[mqIdx]=mqArr[mqSwap]; mqArr[mqSwap]=mqTmp;
      render();
      try{ await api("/course/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: mqArr.map(function(x){ return x.id; }) }) }); }
      catch(err){ staffState.quizAdmin = mqPrev; showToast(err.message); render(); }
      return;
    }

    /* ---------- Видео урока ---------- */
    if(action==="open-lesson-video-editor"){ await openVideoEditor(t.getAttribute("data-id"), t.getAttribute("data-title")); return; }
    if(action==="close-video-editor"){ videoEditor.open=false; render(); return; }
    if(action==="overlay-close-video-editor" && !e.target.closest("[data-stop]")){ videoEditor.open=false; render(); return; }
    if(action==="upload-lesson-video"){
      var vfInput = document.getElementById("videoFileInput");
      if(!vfInput || !vfInput.files || !vfInput.files[0]){ showToast("Выберите файл"); return; }
      var vfFile = vfInput.files[0];
      // Проверяем до отправки: сервер всё равно откажет, но только после того, как
      // файл целиком уйдёт по сети, — на обычном канале это минуты ожидания впустую.
      if(!/\.(mp4|webm|mov|m4v)$/i.test(vfFile.name)){ showToast("Поддерживаются только .mp4, .webm, .mov, .m4v"); return; }
      if(vfFile.size > 500*1024*1024){ showToast("Файл "+Math.round(vfFile.size/1024/1024)+" МБ — больше 500 МБ. Сожмите видео или загрузите его по ссылке"); return; }
      var vfd = new FormData();
      vfd.append("file", vfFile);
      videoEditor.uploadProgress = 0;
      render();
      try{
        var vur = await apiUploadWithProgress("/course/lessons/"+videoEditor.lessonId+"/video-upload", vfd, function(pct){
          // Событий прогресса — десятки-сотни в секунду. render() пересобирает
          // ВЕСЬ app.innerHTML на каждый вызов — на такой частоте это заметно
          // мерцало экраном на всё время загрузки. Двигаем сам прогресс-бар
          // напрямую через DOM, без render(); полный render() нужен только один
          // раз в начале (чтобы бар вообще появился) и один раз в конце.
          videoEditor.uploadProgress = pct;
          var fill = document.getElementById("videoUploadProgressFill");
          if(fill) fill.style.transform = "scaleX("+(pct/100)+")";
        });
        videoEditor.videoUrl = vur.videoUrl; videoEditor._uploaded = true;
        showToast("Видео загружено");
      }catch(err){ showToast(err.message); }
      videoEditor.uploadProgress = null;
      render(); return;
    }
    if(action==="add-video-timecode"){
      syncVideoEditorFromDom();
      videoEditor.timecodes.push({ id:null, time:0, title:"", summary:"" });
      render(); return;
    }
    if(action==="remove-video-timecode"){
      syncVideoEditorFromDom();
      videoEditor.timecodes.splice(parseInt(t.getAttribute("data-idx"),10), 1);
      render(); return;
    }

    /* ---------- Поурочный тест ---------- */
    if(action==="open-lesson-quiz-manager"){ await openLessonQuizManager(t.getAttribute("data-id"), t.getAttribute("data-title")); return; }
    if(action==="close-lesson-quiz-manager"){ lessonQuizManager.open=false; render(); return; }
    if(action==="overlay-close-lesson-quiz-manager" && !e.target.closest("[data-stop]")){ lessonQuizManager.open=false; render(); return; }
    if(action==="open-lesson-quiz-creator"){
      quizEditor = qeNew(lessonQuizManager.lessonId, null);
      render(); return;
    }
    if(action==="open-lesson-quiz-editor"){
      var lq=lessonQuizManager.questions.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!lq) return;
      quizEditor = qeFromRow(lq, lessonQuizManager.lessonId, null);
      render(); return;
    }
    if(action==="move-lesson-quiz-question"){
      var lmIdx=parseInt(t.getAttribute("data-idx"),10); var lmDir=t.getAttribute("data-dir");
      var lmSwap = lmDir==="up" ? lmIdx-1 : lmIdx+1;
      if(lmSwap<0 || lmSwap>=lessonQuizManager.questions.length) return;
      var lmPrev = lessonQuizManager.questions.slice();
      var lmArr = lessonQuizManager.questions;
      var lmTmp = lmArr[lmIdx]; lmArr[lmIdx]=lmArr[lmSwap]; lmArr[lmSwap]=lmTmp;
      render();
      try{
        await api("/course/lessons/"+lessonQuizManager.lessonId+"/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: lmArr.map(function(x){ return x.id; }) }) });
      }catch(err){ lessonQuizManager.questions = lmPrev; showToast(err.message); render(); }
      return;
    }

    /* ---------- Модули курса ---------- */
    if(action==="rename-module"){
      staffState.lsMenu = null;
      var rmTitle = prompt("Новое название модуля:", t.getAttribute("data-title"));
      if(!rmTitle || !rmTitle.trim()) return;
      try{
        await api("/course/modules/"+t.getAttribute("data-id"), { method:"PUT", body: JSON.stringify({ title: rmTitle.trim() }) });
        await loadStaffData();
        showToast("Модуль переименован");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="delete-module"){
      staffState.lsMenu = null;
      askConfirm({
        title: 'Удалить модуль «'+t.getAttribute("data-title")+'»?',
        body: "Уроки останутся, но перестанут быть в модуле — тест и отзывы модуля удалятся.",
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
          try{ await api("/course/modules/"+t.getAttribute("data-id"), { method:"DELETE" }); await loadStaffData(); showToast("Модуль удалён"); }
          catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="open-module-quiz-manager"){
      staffState.lsMenu = null;
      moduleQuizManager = { open:true, moduleId:t.getAttribute("data-id"), moduleTitle:t.getAttribute("data-title"), questions:[] };
      render();
      try{ var mqm=await api("/course/modules/"+moduleQuizManager.moduleId+"/quiz-admin"); moduleQuizManager.questions=mqm.quiz; }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="close-module-quiz-manager"){ moduleQuizManager.open=false; render(); return; }
    if(action==="overlay-close-module-quiz-manager" && !e.target.closest("[data-stop]")){ moduleQuizManager.open=false; render(); return; }
    if(action==="open-module-quiz-creator"){
      quizEditor = qeNew(null, moduleQuizManager.moduleId);
      render(); return;
    }
    if(action==="open-module-quiz-editor"){
      var mq=moduleQuizManager.questions.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!mq) return;
      quizEditor = qeFromRow(mq, null, moduleQuizManager.moduleId);
      render(); return;
    }
    if(action==="move-module-quiz-question"){
      var mmIdx=parseInt(t.getAttribute("data-idx"),10); var mmDir=t.getAttribute("data-dir");
      var mmSwap = mmDir==="up" ? mmIdx-1 : mmIdx+1;
      if(mmSwap<0 || mmSwap>=moduleQuizManager.questions.length) return;
      var mmPrev = moduleQuizManager.questions.slice();
      var mmArr = moduleQuizManager.questions;
      var mmTmp = mmArr[mmIdx]; mmArr[mmIdx]=mmArr[mmSwap]; mmArr[mmSwap]=mmTmp;
      render();
      try{
        await api("/course/modules/"+moduleQuizManager.moduleId+"/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: mmArr.map(function(x){ return x.id; }) }) });
      }catch(err){ moduleQuizManager.questions = mmPrev; showToast(err.message); render(); }
      return;
    }
    if(action==="open-module-feedback-viewer"){
      staffState.lsMenu = null;
      moduleFeedbackViewer = { open:true, moduleId:t.getAttribute("data-id"), moduleTitle:t.getAttribute("data-title"), feedback:[], average:null, count:0 };
      render();
      try{
        var mfv=await api("/course/modules/"+moduleFeedbackViewer.moduleId+"/feedback");
        moduleFeedbackViewer.feedback=mfv.feedback; moduleFeedbackViewer.average=mfv.average; moduleFeedbackViewer.count=mfv.count;
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="close-module-feedback-viewer"){ moduleFeedbackViewer.open=false; render(); return; }
    if(action==="overlay-close-module-feedback-viewer" && !e.target.closest("[data-stop]")){ moduleFeedbackViewer.open=false; render(); return; }

    /* ---------- Протоколы ---------- */
    if(action==="open-protocol-creator"){
      staffState.lsMenu = null;
      protocolEditor = { open:true, id:null, title:"", summary:"", guides:[], lessonIds:[] };
      render(); window.scrollTo(0,0); return;
    }
    if(action==="open-protocol-editor"){
      var pe=adminProtocolsState.list.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!pe) return;
      staffState.lsMenu = null;
      protocolEditor = { open:true, id:pe.id, title:pe.title, summary:pe.summary||"", guides:pe.guides.slice(), lessonIds:pe.lessonIds.slice() };
      render(); window.scrollTo(0,0); return;
    }
    if(action==="close-protocol-editor"){ if(staffState.mainTab==="protocols" && !prLeaveOk()) return; protocolEditor.open=false; render(); return; }
    if(action==="overlay-close-protocol-editor" && !e.target.closest("[data-stop]")){ protocolEditor.open=false; render(); return; }
    if(action==="delete-protocol"){
      askConfirm({
        title: 'Удалить протокол «'+t.getAttribute("data-title")+'»?',
        body: "Вместе с ним удалятся все его гайды и привязки к урокам.",
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
          try{
            await api("/protocols/"+t.getAttribute("data-id"), { method:"DELETE" });
            adminProtocolsState.list=adminProtocolsState.list.filter(function(p){ return p.id!==t.getAttribute("data-id"); });
            if(protocolEditor.id===t.getAttribute("data-id")) protocolEditor.open=false;
            showToast("Протокол удалён");
          }
          catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="save-protocol-guide"){
      var gSpec=document.getElementById("newGuideSpec"); var gText=document.getElementById("newGuideText");
      if(!gSpec || !gText || !gText.value.trim()){ showToast("Заполните текст гайда"); return; }
      try{
        await api("/protocols/"+protocolEditor.id+"/guides/"+gSpec.value, { method:"PUT", body: JSON.stringify({ guideHtml: gText.value }) });
        var specMatch=specializationsList.find(function(s){ return s.id===gSpec.value; });
        protocolEditor.guides.push({ specializationId:gSpec.value, specializationName:specMatch?specMatch.name:gSpec.value, guideHtml:gText.value });
        var adminIdx=adminProtocolsState.list.findIndex(function(p){ return p.id===protocolEditor.id; });
        if(adminIdx!==-1) adminProtocolsState.list[adminIdx].guides = protocolEditor.guides.slice();
        showToast("Гайд добавлен");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="delete-protocol-guide"){
      var dgSpec=t.getAttribute("data-spec");
      try{
        await api("/protocols/"+protocolEditor.id+"/guides/"+dgSpec, { method:"DELETE" });
        protocolEditor.guides = protocolEditor.guides.filter(function(g){ return g.specializationId!==dgSpec; });
        var adminIdx2=adminProtocolsState.list.findIndex(function(p){ return p.id===protocolEditor.id; });
        if(adminIdx2!==-1) adminProtocolsState.list[adminIdx2].guides = protocolEditor.guides.slice();
        showToast("Гайд удалён");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="upload-protocol-guide-file"){
      var ufSpec = t.getAttribute("data-spec");
      var ufInput = document.getElementById("guideFileInput-"+ufSpec);
      if(!ufInput || !ufInput.files || !ufInput.files[0]){ showToast("Выберите файл"); return; }
      var fd = new FormData();
      fd.append("file", ufInput.files[0]);
      try{
        var ufRes = await apiUpload("/protocols/"+protocolEditor.id+"/guides/"+ufSpec+"/files", fd);
        var ufGuide = protocolEditor.guides.find(function(g){ return g.specializationId===ufSpec; });
        if(ufGuide){
          ufGuide.files = (ufGuide.files||[]).concat([ufRes.file]);
        }
        var ufIdx = adminProtocolsState.list.findIndex(function(p){ return p.id===protocolEditor.id; });
        if(ufIdx!==-1) adminProtocolsState.list[ufIdx].guides = protocolEditor.guides.slice();
        showToast("Файл прикреплён");
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="delete-protocol-guide-file"){
      askConfirm({
        title: 'Удалить файл «'+t.getAttribute("data-name")+'»?',
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
      var dfSpec = t.getAttribute("data-spec");
      var dfFileId = t.getAttribute("data-file-id");
      try{
        await api("/protocols/"+protocolEditor.id+"/guides/"+dfSpec+"/files/"+dfFileId, { method:"DELETE" });
        var dfGuide = protocolEditor.guides.find(function(g){ return g.specializationId===dfSpec; });
        if(dfGuide) dfGuide.files = (dfGuide.files||[]).filter(function(f){ return f.id!==dfFileId; });
        var dfIdx = adminProtocolsState.list.findIndex(function(p){ return p.id===protocolEditor.id; });
        if(dfIdx!==-1) adminProtocolsState.list[dfIdx].guides = protocolEditor.guides.slice();
        showToast("Файл удалён");
      }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="toggle-protocol-lesson"){
      var tlId=t.getAttribute("data-id"); var tlIdx=protocolEditor.lessonIds.indexOf(tlId);
      if(t.checked && tlIdx===-1) protocolEditor.lessonIds.push(tlId);
      if(!t.checked && tlIdx!==-1) protocolEditor.lessonIds.splice(tlIdx,1);
      return;
    }
    if(action==="save-protocol-lessons"){
      try{
        var slr=await api("/protocols/"+protocolEditor.id+"/lessons", { method:"PUT", body: JSON.stringify({ lessonIds: protocolEditor.lessonIds }) });
        protocolEditor.lessonIds = slr.lessonIds;
        var adminIdx3=adminProtocolsState.list.findIndex(function(p){ return p.id===protocolEditor.id; });
        if(adminIdx3!==-1) adminProtocolsState.list[adminIdx3].lessonIds = slr.lessonIds;
        showToast("Привязка к урокам сохранена");
      }catch(err){ showToast(err.message); }
      render(); return;
    }

    /* ---------- Специализации ---------- */
    if(action==="open-specialization-editor"){
      specializationEditor = { open:true, id:t.getAttribute("data-id"), name:t.getAttribute("data-name") };
      render(); return;
    }
    if(action==="close-specialization-editor"){ specializationEditor.open=false; render(); return; }
    if(action==="overlay-close-specialization-editor" && !e.target.closest("[data-stop]")){ specializationEditor.open=false; render(); return; }
    if(action==="close-unlock-celebration"){ unlockCelebration.open=false; render(); return; }
    if(action==="overlay-close-unlock-celebration" && !e.target.closest("[data-stop]")){ unlockCelebration.open=false; render(); return; }
    if(action==="goto-protocols-from-celebration"){
      unlockCelebration.open=false;
      await applyStudentTab("protocols","protocols");
      return;
    }
    if(action==="delete-specialization"){
      askConfirm({
        title: 'Удалить специализацию «'+t.getAttribute("data-name")+'»?',
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
          try{
            await api("/specializations/"+t.getAttribute("data-id"), { method:"DELETE" });
            specializationsList = specializationsList.filter(function(s){ return s.id!==t.getAttribute("data-id"); });
            showToast("Специализация удалена");
          }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="qe-type"){
      var qeT=t.getAttribute("data-type"), qe=quizEditor;
      qe.type=qeT;
      if(qeT==="order") while(qe.options.length<3) qe.options.push("");
      if(qeT==="match") while(qe.right.length<qe.options.length) qe.right.push("");
      if(qeT==="multi") qe.correctMulti=qe.correctMulti.filter(function(i){ return i<qe.options.length; });
      render(); return;
    }
    if(action==="qe-step-type"){ quizEditor.steps[parseInt(t.getAttribute("data-i"),10)].type=t.getAttribute("data-type"); render(); return; }
    if(action==="qe-correct"){
      var qcBase=t.getAttribute("data-base"), qcObj=qcBase?qeGet(qcBase):quizEditor, qcI=parseInt(t.getAttribute("data-i"),10);
      if(t.hasAttribute("data-multi")){ var qcAt=qcObj.correctMulti.indexOf(qcI); if(qcAt===-1) qcObj.correctMulti.push(qcI); else qcObj.correctMulti.splice(qcAt,1); }
      else qcObj.correct=qcI;
      render(); return;
    }
    if(action==="qe-add"){
      var qaList=t.getAttribute("data-list"), qaArr=qeGet(qaList);
      if(qaList==="steps") qaArr.push(qeBlankStep());
      else { qaArr.push(""); if(qaList==="options" && quizEditor.type==="match") quizEditor.right.push(""); }
      render(); return;
    }
    if(action==="qe-remove"){
      var qrList=t.getAttribute("data-list"), qrArr=qeGet(qrList), qrI=parseInt(t.getAttribute("data-i"),10);
      var qrMin = qrList==="steps" ? 1 : (quizEditor.type==="order" && qrList==="options" ? 3 : 2);
      if(qrArr.length<=qrMin){ showToast(qrList==="steps" ? "Нужен хотя бы один шаг" : "Минимум "+qrMin+" "+ruPluralClient(qrMin,"строка","строки","строк")); return; }
      qrArr.splice(qrI,1);
      if(qrList.slice(-7)==="options"){
        var qrObj = qrList==="options" ? quizEditor : qeGet(qrList.slice(0,-8));
        if(qrList==="options" && quizEditor.type==="match") quizEditor.right.splice(qrI,1);
        if(qrObj.correct===qrI) qrObj.correct=0; else if(qrObj.correct>qrI) qrObj.correct--;
        qrObj.correctMulti = qrObj.correctMulti.filter(function(i){ return i!==qrI; }).map(function(i){ return i>qrI?i-1:i; });
      }
      render(); return;
    }
    if(action==="qe-move"){
      var qmI=parseInt(t.getAttribute("data-i"),10), qmJ=qmI+parseInt(t.getAttribute("data-dir"),10), qmA=quizEditor.options;
      if(qmJ<0 || qmJ>=qmA.length) return;
      var qmT=qmA[qmI]; qmA[qmI]=qmA[qmJ]; qmA[qmJ]=qmT; render(); return;
    }
    if(action==="qe-save"){
      var errQe=document.getElementById("quizEditorError"); errQe.style.display="none";
      t.disabled=true; t.textContent="Сохраняем…";
      var isLessonQuiz = !!quizEditor.lessonId, isModuleQuiz = !!quizEditor.moduleId;
      var qBody = qeBody();
      try{
        if(quizEditor.isNew){
          var createUrl = isLessonQuiz ? "/course/lessons/"+quizEditor.lessonId+"/quiz-admin"
            : isModuleQuiz ? "/course/modules/"+quizEditor.moduleId+"/quiz-admin"
            : "/course/quiz-admin";
          if(!isLessonQuiz && !isModuleQuiz) qBody.courseId = staffState.activeCourseId;
          await api(createUrl, { method:"POST", body: JSON.stringify(qBody) });
          showToast("Вопрос добавлен");
        } else {
          await api("/course/quiz-admin/"+quizEditor.id, { method:"PUT", body: JSON.stringify(qBody) });
          showToast("Вопрос сохранён");
        }
        var qeLesson = quizEditor.lessonId, qeModule = quizEditor.moduleId;
        quizEditor.open=false;
        if(isLessonQuiz){
          var lqRefresh=await api("/course/lessons/"+qeLesson+"/quiz-admin"); lessonQuizManager.questions=lqRefresh.quiz;
        } else if(isModuleQuiz){
          var mqRefresh=await api("/course/modules/"+qeModule+"/quiz-admin"); moduleQuizManager.questions=mqRefresh.quiz;
          await loadStaffData(); // обновить счётчик вопросов у карточки модуля
        } else {
          await loadStaffData();
        }
      }catch(err){ errQe.textContent=err.message; errQe.style.display="block"; t.disabled=false; t.textContent=quizEditor.isNew?"Добавить вопрос":"Сохранить вопрос"; return; }
      render(); return;
    }

    if(action==="reg-bar-select"){ var rk=t.getAttribute("data-key"); dashboardState.regBarKey = dashboardState.regBarKey===rk ? null : rk; render(); return; }
    if(action==="edit-stream"){ calendarState.editingStreamId=t.getAttribute("data-id"); render(); var ei=document.querySelector('[data-stream-telegram-input]'); if(ei) ei.focus(); return; }
    if(action==="cancel-edit-stream"){ calendarState.editingStreamId=null; render(); return; }
    if(action==="toggle-stream-form"){ calendarState.showStreamForm=!calendarState.showStreamForm; render(); return; }
    if(action==="delete-stream"){
      var delId=t.getAttribute("data-id");
      var delStream=calendarState.streams.find(function(x){ return x.id===delId; });
      var delCount=(staffState.students||[]).filter(function(x){ return x.stream_id===delId; }).length;
      var delMod10=delCount%10, delMod100=delCount%100;
      var delPhrase=delCount+(delMod10===1&&delMod100!==11?" врач останется":(delMod10>=2&&delMod10<=4&&(delMod100<10||delMod100>=20)?" врача останутся":" врачей останутся"));
      var delEvents=(calendarState.events||[]).filter(function(x){ return x.stream_id===delId && new Date(x.event_date+"T23:59:59")>=new Date(); }).length;
      askConfirm({
        title:"Удалить поток?",
        // На сервере streams удаляется с ON DELETE SET NULL: врачи остаются без потока,
        // а эфиры потока становятся общими — их увидят врачи всех потоков.
        body:"Вы уверены, что хотите удалить поток «"+(delStream?delStream.name:"")+"»?"+
          (delCount?" "+delPhrase+" без потока — их нужно будет распределить заново.":"")+
          (delEvents?" "+delEvents+" "+(delEvents%10===1&&delEvents%100!==11?"предстоящий эфир потока станет общим — его":"предстоящих эфира(-ов) потока станут общими — их")+" увидят врачи всех потоков.":"")+
          " Это действие нельзя отменить.",
        confirmLabel:"Удалить поток",
        onConfirm: async function(){
          try{ await api("/streams/"+delId, { method:"DELETE" }); await loadCalendarData(); showToast("Поток удалён"); }catch(err){ showToast(err.message); }
          render();
        }
      });
      return;
    }
    if(action==="save-stream-telegram"){
      var stId=t.getAttribute("data-id");
      var stInp=root.querySelector('[data-stream-telegram-input][data-id="'+stId+'"]');
      var stUrl=stInp?stInp.value.trim():"";
      try{
        var rst = await api("/streams/"+stId, { method:"PATCH", body: JSON.stringify({ telegramUrl: stUrl }) });
        // Сервер приводит ссылку к https://t.me/… — показываем то, что сохранено.
        var stObj=calendarState.streams.find(function(s){ return s.id===stId; });
        if(stObj) stObj.telegram_url = rst.telegramUrl || null;
        calendarState.editingStreamId = null;
        showToast("Ссылка сохранена");
      }catch(err){ showToast(err.message); if(stInp) stInp.focus(); return; }
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
      askConfirm({
        title: "Удалить все эфиры этой серии повторов?",
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
          try{ await api("/events/"+t.getAttribute("data-id")+"?series=true", { method:"DELETE" }); await loadCalendarData(); showToast("Серия удалена"); }catch(err){ showToast(err.message); }
          calendarState.eventModalMode=null; render();
        }
      });
      return;
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
        return (s.name||"").toLowerCase().indexOf(q0)!==-1 || specNames(s).toLowerCase().indexOf(q0)!==-1 ||
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
        await api("/course/certificate/bulk-issue", { method:"POST", body: JSON.stringify({ studentIds: certIds, courseId: staffState.activeCourseId }) });
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
      try{
        var rbp = await api("/staff/students/bulk-field", { method:"POST", body: JSON.stringify({ids:ids3, field:"payment_status", value: selPay?selPay.value:"unpaid"}) });
        await loadStaffData();
        showToast("Оплата обновлена у врачей: "+rbp.updated+(rbp.skippedWithOrders?" · пропущено "+rbp.skippedWithOrders+" — у них статус считается из заказов":""));
      }
      catch(err){ showToast(err.message); }
      staffState.selectedIds=[]; render(); return;
    }

    if(action==="open-materials-picker"){ openMaterialsPicker(t.getAttribute("data-id"), t.getAttribute("data-title")); render(); return; }
    if(action==="close-materials-picker"){ materialsPicker.open=false; render(); return; }
    if(action==="overlay-close-materials" && !e.target.closest("[data-stop]")){ materialsPicker.open=false; render(); return; }

    if(action==="open-telegram-modal"){
      if(view==="student"){ await applyStudentTab("telegram"); window.scrollTo(0,0); return; }
      staffState.navKey="telegram"; staffState.mainTab="telegram"; staffState.selectedStudentId=null; staffState.selectedStudent=null; render(); window.scrollTo(0,0); return;
    }
    if(action==="tg-copy"){
      var okTg = await copyText(t.getAttribute("data-url"));
      showToast(okTg ? "Ссылка на группу скопирована" : "Не удалось скопировать");
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
        await api("/course/visibility/"+materialsPicker.targetId, { method:"PUT", body: JSON.stringify({ ids: materialsPicker.selectedIds, courseId: staffState.activeCourseId }) });
        courseVisibility[materialsPicker.targetId] = materialsPicker.selectedIds.slice();
        materialsPicker.open=false;
        showToast(materialsPicker.selectedIds.length ? "Видимость обновлена — скрыто от "+materialsPicker.selectedIds.length : "Материал снова виден всем");
      }catch(err){ showToast(err.message); }
      render(); return;
    }

    if(action==="open-schedule-modal"){ await openScheduleModal(t.getAttribute("data-id"), t.getAttribute("data-title")); return; }
    if(action==="close-schedule-modal"){ scheduleModal.open=false; render(); return; }
    if(action==="overlay-close-schedule" && !e.target.closest("[data-stop]")){ scheduleModal.open=false; render(); return; }
    if(action==="toggle-schedule-all"){ scheduleModal.applyToAll=t.checked; render(); return; }
    if(action==="toggle-schedule-student"){
      var schId=t.getAttribute("data-id"); var schIdx=scheduleModal.selectedIds.indexOf(schId);
      if(t.checked && schIdx===-1) scheduleModal.selectedIds.push(schId);
      if(!t.checked && schIdx!==-1) scheduleModal.selectedIds.splice(schIdx,1);
      render(); return;
    }
    if(action==="apply-schedule" || action==="clear-schedule"){
      var dateInp=document.getElementById("scheduleUnlockDate");
      var isClear = action==="clear-schedule";
      if(!isClear && (!dateInp || !dateInp.value)){ showToast("Укажите дату открытия"); return; }
      if(!scheduleModal.applyToAll && !scheduleModal.selectedIds.length){ showToast("Выберите хотя бы одного врача"); return; }
      var payload = {
        studentIds: scheduleModal.applyToAll ? null : scheduleModal.selectedIds,
        unlockAt: isClear ? null : new Date(dateInp.value+"T00:00:00").toISOString()
      };
      t.disabled=true;
      try{
        var r=await api("/course/lessons/"+scheduleModal.lessonId+"/schedule", { method:"PUT", body: JSON.stringify(payload) });
        showToast(isClear ? "Расписание сброшено у "+r.updated+" врачей" : "Дата назначена "+r.updated+" врачам");
        var sch2=await api("/course/lessons/"+scheduleModal.lessonId+"/schedule"); scheduleModal.schedule=sch2.schedule;
      }catch(err){ showToast(err.message); }
      t.disabled=false; render(); return;
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
    if(action==="toggle-spec-picker"){
      var spPicker=t.getAttribute("data-picker");
      specPickerOpen = (specPickerOpen===spPicker) ? null : spPicker;
      specPickerQuery = "";
      render(); return;
    }
    if(action==="toggle-spec-picker-item"){
      var spiPicker=t.getAttribute("data-picker"); var spiVal=t.getAttribute("data-value");
      var spiArr=specPickerArrayFor(spiPicker); var spiIdx=spiArr.indexOf(spiVal);
      if(spiIdx===-1) spiArr.push(spiVal); else spiArr.splice(spiIdx,1);
      render(); return;
    }
    if(action==="reset-dash-filters"){
      dashboardState = { periodFrom:"", periodTo:"", specializations:[], streams:[], stages:[], products:[], certStatuses:[], paymentStatuses:[], demoStatuses:[], accessStatuses:[], curatorIds:[], openFilterMenu:null };
      render(); return;
    }
    if(action==="export-dash-csv"){ exportDashboardCSV(computeFilteredStudents()); return; }
    if(action==="reset-audit-filters"){
      auditFilters = { q:"", action:"", actorId:"", dateFrom:"", dateTo:"" };
      await loadAuditLog(); render(); return;
    }
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
      var errBox2=document.getElementById("authError"); errBox2.style.display="none";
      var btn2=e.target.querySelector("button[type=submit]"); btn2.disabled=true; btn2.textContent="Регистрируем…";
      try{
        var d2=await api("/auth/register", { method:"POST", body: JSON.stringify({
          name:registerDraft.name, specializationIds:registerDraft.specializationIds, email:registerDraft.email,
          phone:registerDraft.phone, password:registerDraft.password,
          staffInviteCode:registerDraft.asStaff ? registerDraft.staffInviteCode : "",
          interestIds: registerDraft.interestIds
        }) });
        me=d2.user; await routeAfterLogin();
      }catch(err){ errBox2.textContent=err.message; errBox2.style.display="block"; btn2.disabled=false; btn2.textContent=registerDraft.asStaff?"Зарегистрироваться":"Начать курс"; }
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
          await api("/course/lessons", { method:"POST", body: JSON.stringify(Object.assign({ courseId: staffState.activeCourseId }, payload)) });
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
    if(e.target.id==="videoEditorForm"){
      e.preventDefault();
      syncVideoEditorFromDom();
      var errVe=document.getElementById("videoEditorError"); errVe.style.display="none";
      var btnVe=e.target.querySelector("button[type=submit]"); btnVe.disabled=true; btnVe.textContent="Сохраняем…";
      try{
        await api("/course/lessons/"+videoEditor.lessonId+"/video", { method:"PUT", body: JSON.stringify({
          videoUrl: videoEditor.videoUrl, timecodes: videoEditor.timecodes
        }) });
        videoEditor.open=false; showToast("Видео сохранено");
      }catch(err){ errVe.textContent=err.message; errVe.style.display="block"; btnVe.disabled=false; btnVe.textContent="Сохранить видео"; return; }
      render(); return;
    }
    if(e.target.id==="protocolEditorForm"){
      e.preventDefault();
      var fdpr=new FormData(e.target);
      var errPr=document.getElementById("protocolEditorError"); errPr.style.display="none";
      var btnPr=e.target.querySelector("button[type=submit]"); btnPr.disabled=true; btnPr.textContent="Сохраняем…";
      try{
        if(!protocolEditor.id){
          var crPr=await api("/protocols", { method:"POST", body: JSON.stringify({ title:fdpr.get("title"), summary:fdpr.get("summary") }) });
          protocolEditor.id=crPr.id; protocolEditor.title=crPr.title; protocolEditor.summary=crPr.summary;
          adminProtocolsState.list.unshift({ id:crPr.id, title:crPr.title, summary:crPr.summary, guides:[], lessonIds:[] });
          showToast("Протокол создан — теперь добавьте гайды и уроки");
        } else {
          await api("/protocols/"+protocolEditor.id, { method:"PUT", body: JSON.stringify({ title:fdpr.get("title"), summary:fdpr.get("summary") }) });
          protocolEditor.title=fdpr.get("title"); protocolEditor.summary=fdpr.get("summary");
          var adminIdxP=adminProtocolsState.list.findIndex(function(p){ return p.id===protocolEditor.id; });
          if(adminIdxP!==-1){ adminProtocolsState.list[adminIdxP].title=protocolEditor.title; adminProtocolsState.list[adminIdxP].summary=protocolEditor.summary; }
          showToast("Протокол сохранён");
        }
      }catch(err){ errPr.textContent=err.message; errPr.style.display="block"; btnPr.disabled=false; btnPr.textContent=protocolEditor.id?"Сохранить":"Создать и продолжить"; return; }
      render(); return;
    }
    if(e.target.id==="specializationEditorForm"){
      e.preventDefault();
      var fdse=new FormData(e.target);
      var errSe=document.getElementById("specializationEditorError"); errSe.style.display="none";
      var btnSe=e.target.querySelector("button[type=submit]"); btnSe.disabled=true; btnSe.textContent="Сохраняем…";
      try{
        await api("/specializations/"+specializationEditor.id, { method:"PUT", body: JSON.stringify({ name:fdse.get("name") }) });
        var specI=specializationsList.findIndex(function(s){ return s.id===specializationEditor.id; });
        if(specI!==-1) specializationsList[specI].name=fdse.get("name");
        specializationEditor.open=false; showToast("Специализация переименована");
      }catch(err){ errSe.textContent=err.message; errSe.style.display="block"; btnSe.disabled=false; btnSe.textContent="Сохранить"; return; }
      render(); return;
    }
    if(e.target.id==="specializationCreateForm"){
      e.preventDefault();
      var fdsc=new FormData(e.target);
      var btnSc=e.target.querySelector("button[type=submit]"); btnSc.disabled=true;
      try{
        var crSc=await api("/specializations", { method:"POST", body: JSON.stringify({ name:fdsc.get("name") }) });
        specializationsList.push({ id:crSc.id, name:crSc.name });
        showToast("Специализация добавлена");
      }catch(err){ showToast(err.message); }
      btnSc.disabled=false; render(); return;
    }
    if(e.target.id==="moduleCreateForm"){
      e.preventDefault();
      var fdmc=new FormData(e.target);
      var btnMc=e.target.querySelector("button[type=submit]"); btnMc.disabled=true;
      try{
        await api("/course/modules", { method:"POST", body: JSON.stringify({ title:fdmc.get("title"), courseId: staffState.activeCourseId }) });
        staffState.showModuleCreate = false;
        await loadStaffData();
        showToast("Модуль добавлен");
      }catch(err){ showToast(err.message); }
      btnMc.disabled=false; render(); return;
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
      var errPe=document.getElementById("profileEditorError"); errPe.style.display="none";
      var btnPe=e.target.querySelector("button[type=submit]"); btnPe.disabled=true; btnPe.textContent="Сохраняем…";
      var payloadPe={ name:profileEditor.name, phone:profileEditor.phone||"" };
      if(me.role==="student"){
        payloadPe.workplace=profileEditor.workplace||"";
        payloadPe.specializationIds=profileEditor.specializationIds;
        payloadPe.interestIds=profileEditor.interestIds;
      }
      try{
        var rPe=await api("/auth/me", { method:"PATCH", body: JSON.stringify(payloadPe) });
        me = rPe.user;
        profileEditor.open=false; showToast("Профиль обновлён");
      }catch(err){ errPe.textContent=err.message; errPe.style.display="block"; btnPe.disabled=false; btnPe.textContent="Сохранить"; }
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
    if(e.target.id==="importStudentsForm"){
      e.preventDefault();
      var fdis=new FormData(e.target);
      fdis.append("courseId", staffState.activeCourseId||"");
      var btnis=e.target.querySelector("button[type=submit]"); btnis.disabled=true; btnis.textContent="Загружаем…";
      try{
        var irRes=await apiUpload("/staff/students/import", fdis);
        staffState.importResult={ created: irRes.created, skipped: irRes.skipped };
        await loadStaffData();
        showToast("Создано аккаунтов: "+irRes.created.length);
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(e.target.id==="createCourseForm"){
      e.preventDefault();
      var fdcc=new FormData(e.target); var btncc=e.target.querySelector("button[type=submit]"); btncc.disabled=true; btncc.textContent="Создаём…";
      try{
        var newC=await api("/courses", { method:"POST", body: JSON.stringify({ title:fdcc.get("title") }) });
        staffState.activeCourseId=newC.id; staffState.showCreateCourse=false;
        await loadStaffData();
        showToast("Курс создан — теперь добавьте уроки на странице «Учебные материалы»");
      }
      catch(err){ showToast(err.message); btncc.disabled=false; btncc.textContent="Создать"; }
      render(); return;
    }
    if(e.target.id==="streamForm"){
      e.preventDefault();
      var fd6=new FormData(e.target); var btn6=e.target.querySelector("button[type=submit]"); btn6.disabled=true; btn6.textContent="Создаём…";
      try{ await api("/streams", { method:"POST", body: JSON.stringify({ name:fd6.get("name"), startDate:fd6.get("startDate"), telegramUrl:fd6.get("telegramUrl") }) }); await loadCalendarData(); calendarState.showStreamForm=false; showToast("Поток создан"); }
      catch(err){ showToast(err.message); return; }  // без render(): введённое в форме остаётся
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
    if(e.target.hasAttribute("data-tchange")){ await toolsChange(e.target); return; }
    if(e.target.hasAttribute("data-tbind")){ toolsBind(e.target); if(e.target.hasAttribute("data-rerender")) render(); return; }
    if(e.target.id==="avatarFileInput"){ uploadAvatarFile(e.target.files && e.target.files[0]); return; }
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
        if(field==="curator" && view==="staff" && staffState.mainTab==="team") render();
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
    if(e.target.hasAttribute && e.target.hasAttribute("data-tbind")){
      toolsBind(e.target);
      if(e.target.id==="ordersSearch"){
        render();
        setTimeout(function(){ var s=document.getElementById("ordersSearch"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
      }
      return;
    }
    if(e.target.getAttribute && e.target.getAttribute("data-gb") && glossaryAdmin.edit){
      var gbPath = e.target.getAttribute("data-gb");
      glSetPath(glossaryAdmin.edit, gbPath, e.target.value);
      glossaryAdmin.dirty = true;
      var gbPrev = document.getElementById("glPreview"); if(gbPrev) gbPrev.innerHTML = glPreviewHtml();
      if(gbPath==="aliasesText" || gbPath==="lessonId"){ glossaryAdmin.check = null; glPaintCheck(); glCheckAliases(); }
      return;
    }
    if(e.target.id==="glossarySearchInput"){
      glossaryAdmin.q = e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("glossarySearchInput"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
      return;
    }
    if(e.target.id==="lessonsSearchInput" || e.target.id==="protocolsSearchInput"){
      var srId = e.target.id;
      if(srId==="lessonsSearchInput") staffState.lsQuery=e.target.value; else staffState.protoQuery=e.target.value;
      render();
      setTimeout(function(){ var s=document.getElementById(srId); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
      return;
    }
    if(e.target.id==="rosterSearch"){
      staffState.search=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("rosterSearch"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
      return;
    }
    if(e.target.id==="materialsPickerSearch"){
      materialsPicker.search=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("materialsPickerSearch"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
    }
    if(e.target.id==="scheduleSearch"){
      scheduleModal.search=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("scheduleSearch"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
    }
    if(e.target.id==="scheduleUnlockDate"){ scheduleModal.unlockDate=e.target.value; }
    // Поля форм регистрации/профиля не перерисовываются на каждый ввод (не нужно —
    // DOM и так уже показывает набранное), но должны попадать в JS-состояние, иначе
    // клик по выпадающему списку специализаций (он вызывает render()) стёр бы то,
    // что человек уже успел напечатать в соседних полях той же формы.
    if(e.target.id==="registerName"){ registerDraft.name=e.target.value; return; }
    if(e.target.id==="registerEmail"){ registerDraft.email=e.target.value; return; }
    if(e.target.id==="registerPhone"){ registerDraft.phone=e.target.value; return; }
    if(e.target.id==="registerPassword"){ registerDraft.password=e.target.value; return; }
    if(e.target.id==="registerStaffCode"){ registerDraft.staffInviteCode=e.target.value; return; }
    if(e.target.id==="profileEditorName"){ profileEditor.name=e.target.value; return; }
    if(e.target.id==="profileEditorPhone"){ profileEditor.phone=e.target.value; return; }
    if(e.target.id==="profileEditorWorkplace"){ profileEditor.workplace=e.target.value; return; }
    if(e.target.id==="studentProfileName"){ staffState.editName=e.target.value; return; }
    if(e.target.id==="studentProfilePhone"){ staffState.editPhone=e.target.value; return; }
    if(e.target.id==="studentProfileWorkplace"){ staffState.editWorkplace=e.target.value; return; }
    // Редактор вопроса: поле сразу пишется в quizEditor (без перерисовки).
    if(e.target.hasAttribute && e.target.hasAttribute("data-qe") && quizEditor.open){ qeSet(e.target.getAttribute("data-qe"), e.target.value); return; }
    if(e.target.id==="materialsSearchInput"){
      studentState.materialsSearch=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("materialsSearchInput"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
    }
    if(e.target.id==="specPickerSearchInput"){
      specPickerQuery=e.target.value; render();
      setTimeout(function(){ var s=document.getElementById("specPickerSearchInput"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; } },0);
      return;
    }
    if(e.target.id==="dashPeriodFrom"){ dashboardState.periodFrom=e.target.value; render(); }
    if(e.target.id==="dashPeriodTo"){ dashboardState.periodTo=e.target.value; render(); }
    if(e.target.id==="auditSearchInput"){
      auditFilters.q=e.target.value;
      clearTimeout(auditSearchDebounceTimer);
      auditSearchDebounceTimer=setTimeout(async function(){
        await loadAuditLog(); render();
        var s=document.getElementById("auditSearchInput"); if(s){ s.focus(); s.selectionStart=s.selectionEnd=s.value.length; }
      }, 400);
      return;
    }
    if(e.target.id==="auditActionFilter"){ auditFilters.action=e.target.value; loadAuditLog().then(render); return; }
    if(e.target.id==="auditActorFilter"){ auditFilters.actorId=e.target.value; loadAuditLog().then(render); return; }
    if(e.target.id==="auditDateFrom"){ auditFilters.dateFrom=e.target.value; loadAuditLog().then(render); return; }
    if(e.target.id==="auditDateTo"){ auditFilters.dateTo=e.target.value; loadAuditLog().then(render); return; }
    if(e.target.id==="lessonWysiwygEditor"){
      // Намеренно НЕ вызываем render() на каждое нажатие — это пересобрало бы весь DOM
      // и убило курсор/выделение в contenteditable. Скрытый textarea — единственный
      // канал, через который реальный HTML доходит до отправки формы.
      var hidden=document.getElementById("lessonHtmlHidden");
      if(hidden) hidden.value = lbHtml(e.target);
      lessonEditor.html = lbHtml(e.target);
      lpRefreshPreviewSoon();
    }
    if(e.target.closest && e.target.closest("#lessonEditorForm") && e.target.id!=="lessonWysiwygEditor") lpRefreshPreviewSoon();
    if(e.target.closest && e.target.closest("#videoEditorForm")){ syncVideoEditorFromDom(); lpRefreshPreviewSoon(); }
    if(e.target.closest && (e.target.closest("#protocolEditorForm") || e.target.id==="guideEditText" || e.target.id==="newGuideText" || e.target.id==="newGuideSpec")) prRefreshPreview();
  });
}

// Esc закрывает открытую модалку/дровер — раньше работало только по клику на
// подложку или на «Закрыть», без единого глобального обработчика клавиатуры.
// Порядок проверки — от заведомо самого верхнего слоя (confirmState монтируется
// последним) к самому нижнему, чтобы Esc закрывал именно то, что видно сверху.
document.addEventListener("keydown", function(e){
  if(e.key==="Enter" && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("gl-term")){ document.activeElement.click(); return; }
  if(e.key !== "Escape") return;
  if(confirmState){ confirmState=null; render(); return; }
  if(glossary.open){ glossary.open=null; render(); return; }
  if(quizEditor.open){ quizEditor.open=false; render(); return; }
  if(unlockCelebration.open){ unlockCelebration.open=false; render(); return; }
  if(specializationEditor.open){ specializationEditor.open=false; render(); return; }
  if(protocolEditor.open && staffState.mainTab!=="protocols"){ protocolEditor.open=false; render(); return; }
  if(moduleFeedbackViewer.open){ moduleFeedbackViewer.open=false; render(); return; }
  if(moduleQuizManager.open){ moduleQuizManager.open=false; render(); return; }
  if(lessonQuizManager.open && !lpOwns("quiz")){ lessonQuizManager.open=false; render(); return; }
  if(videoEditor.open && !lpOwns("video")){ videoEditor.open=false; render(); return; }
  if(lessonEditor.open && !lpOwns("content")){ lessonEditor.open=false; render(); return; }
  if(tempPasswordResult){ tempPasswordResult=null; render(); return; }
  if(protocolReader.id){ protocolReader.id=null; render(); return; }
  if(profileEditor.open){ profileEditor.open=false; render(); return; }
  if(changePasswordOpen){ changePasswordOpen=false; render(); return; }
  if(typeof calendarState!=="undefined" && calendarState.eventModalMode){ calendarState.eventModalMode=null; render(); return; }
  if(typeof materialsPicker!=="undefined" && materialsPicker.open && !lpOwns("access")){ materialsPicker.open=false; render(); return; }
  if(typeof scheduleModal!=="undefined" && scheduleModal.open && !lpOwns("schedule")){ scheduleModal.open=false; render(); return; }
  if(staffState && staffState.lsMenu){ staffState.lsMenu=null; render(); return; }
  if(typeof staffState!=="undefined" && staffState.selectedStudentId){ staffState.selectedStudentId=null; render(); return; }
});


// Перетаскивание уроков в разделе «Уроки» (только у администратора): строка
// урока — draggable, бросить можно на другой урок (выше/ниже его середины) или
// на секцию модуля (в её конец).
var lsDrag = null;
function lsDropClear(){ [].forEach.call(document.querySelectorAll(".drop-before,.drop-after,.drop-into"), function(n){ n.classList.remove("drop-before","drop-after","drop-into"); }); }
function lsDropTarget(e){
  var row = e.target.closest && e.target.closest(".ls-row[data-drag]");
  if(row && row.getAttribute("data-id")!==lsDrag){
    var r = row.getBoundingClientRect();
    return { el:row, id:row.getAttribute("data-id"), where: (e.clientY < r.top + r.height/2) ? "before" : "after" };
  }
  var sec = e.target.closest && e.target.closest(".ls-sec[data-module]");
  if(sec && !row) return { el:sec, where:"into", moduleId: sec.getAttribute("data-module") };
  return null;
}
document.addEventListener("dragstart", function(e){
  var row = e.target.closest && e.target.closest(".ls-row[data-drag]");
  if(!row) return;
  lsDrag = row.getAttribute("data-id");
  staffState.lsMenu = null;
  try{ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", lsDrag); }catch(err){}
  row.classList.add("dragging");
});
document.addEventListener("dragover", function(e){
  if(!lsDrag) return;
  var d = lsDropTarget(e);
  if(!d) return;
  e.preventDefault();
  lsDropClear();
  d.el.classList.add(d.where==="into" ? "drop-into" : "drop-"+d.where);
});
document.addEventListener("drop", function(e){
  if(!lsDrag) return;
  var d = lsDropTarget(e), id = lsDrag;
  lsDropClear(); lsDrag = null;
  if(!d) return;
  e.preventDefault();
  lsApplyMove(id, d.id||null, d.where, d.moduleId);
});
document.addEventListener("dragend", function(){
  lsDrag = null; lsDropClear();
  [].forEach.call(document.querySelectorAll(".ls-row.dragging"), function(n){ n.classList.remove("dragging"); });
});

applyTheme();
init();

// Вынесено сюда из index.html (было инлайновым <script>) — так CSP может запрещать
// инлайновые скрипты (script-src 'self') и не ломать регистрацию service worker.
if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js").catch(function(){});
  });
}
})();
