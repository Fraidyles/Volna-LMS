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
  lessonStage:"intro", videoEnded:false, lessonQuizAnswers:{}, lessonQuizResult:null, protocolsLoaded:false,
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
var registerDraft = { name:"", email:"", phone:"", password:"", staffInviteCode:"", specializationIds:[], interestIds:[] };
// Какой из выпадающих списков специализаций сейчас открыт — один на всё
// приложение, т.к. одновременно виден только один такой список — и что
// набрано в его строке поиска.
var specPickerOpen = null;
var specPickerQuery = "";
var calendarState = { monthDate:new Date(), streams:[], events:[], showStreamForm:false, eventModalMode:null, eventModalDate:null, eventModalId:null, recurring:false };
var materialsPicker = { open:false, targetId:null, targetTitle:"", search:"", selectedIds:[] };
var scheduleModal = { open:false, lessonId:null, lessonTitle:"", search:"", selectedIds:[], applyToAll:true, unlockDate:"", schedule:[] };
// Окно «Общение» — вместо внутреннего чата просто ведёт в Telegram-группу потока
// (см. streams.telegram_url); открывается по клику на иконку "Чат" в сайдбаре.
var telegramModal = { open:false };
var notifState = { items:[], unreadCount:0 };
var mySessionsList = [];
var mySessionsLoaded = false;
var studentProtocols = { forYou:[], additional:[] };
var protocolExpanded = {}; // id протокола -> открыта ли карточка гайда
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
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/>',
  download: '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M8 11l4 4 4-4"/><path d="M12 14.5V4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>'
};
function icon(name, cls){ return '<svg class="ic'+(cls?' '+cls:'')+'" viewBox="0 0 24 24">'+(ICONS[name]||'')+'</svg>'; }
function brandMark(style){ return '<span class="mark"'+(style?' style="'+style+'"':'')+'>'+icon("doctor")+'</span>'; }

/* ============================= МАГНИТ (единственный язык статуса) ============================= */
function magnet(kind, label){
  return '<span class="magnet '+kind+'"><span class="magnet-dot"></span><span class="magnet-label">'+escapeHtml(label)+'</span></span>';
}
function fmtDate(iso){ if(!iso) return "—"; try{ return new Date(iso).toLocaleDateString("ru-RU",{day:"numeric",month:"short",year:"numeric"}); }catch(e){ return "—"; } }
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
  if(!me || me.role!=="student") return;
  try{ navigator.sendBeacon(API+"/course/offline"); }catch(e){}
}
window.addEventListener("pagehide", sendOfflineBeacon);

async function routeAfterLogin(){
  if(me.role === "student"){
    view = "student";
    await loadCourse();
    await loadCalendarData();
    await loadNotifications();
    startNotificationPolling();
    startHeartbeat();
  } else {
    view = "staff";
    await loadStaffData();
    await loadCalendarData();
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
  try{ var d = await api("/course/protocols?courseId="+encodeURIComponent(activeCourseId)); studentProtocols = { forYou:d.forYou, additional:d.additional }; }
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
  notifPollTimer = setInterval(async function(){ await loadNotifications(); render(); }, 30000);
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
        if(inner) inner.textContent = Math.round(parseFloat(getComputedStyle(elx).getPropertyValue("--ring-p")) || 0)+suffix;
        requestAnimationFrame(tick);
      })();
    } else {
      animateCount(elx, ANIM_COUNT_MS, next);
    }
  }
  runStep(0);
}

// Отклик карточек на курсор: координаты для подсветки рамки (.board-strip > .card).
document.addEventListener("pointermove", function(e){
  var c = e.target && e.target.closest && e.target.closest(".board-strip > .card");
  if(!c) return;
  var r = c.getBoundingClientRect();
  c.style.setProperty("--mx", (e.clientX - r.left)+"px");
  c.style.setProperty("--my", (e.clientY - r.top)+"px");
}, { passive:true });

function render(){
  var app = document.getElementById("app");
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
  var node;
  applyGlow();
  if(view === "loading") node = el('<div style="min-height:100vh;"></div>');
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
  if(telegramModal.open && (view==="student"||view==="staff")){
    app.appendChild(renderTelegramModal());
  }
  if(tempPasswordResult && view==="staff"){
    app.appendChild(renderTempPasswordModal());
  }
  if(lessonEditor.open && view==="staff"){
    app.appendChild(renderLessonEditorModal());
  }
  if(videoEditor.open && view==="staff"){
    app.appendChild(renderVideoEditorModal());
  }
  if(lessonQuizManager.open && view==="staff"){
    app.appendChild(renderLessonQuizManagerDrawer());
  }
  if(moduleQuizManager.open && view==="staff"){
    app.appendChild(renderModuleQuizManagerDrawer());
  }
  if(moduleFeedbackViewer.open && view==="staff"){
    app.appendChild(renderModuleFeedbackViewerDrawer());
  }
  if(protocolEditor.open && view==="staff"){
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
  if(unlockCelebration.open && view==="student"){
    app.appendChild(renderUnlockCelebrationModal());
  }
  // confirmState монтируется последним — может быть открыт поверх любой другой
  // модалки (например, подтверждение удаления вопроса теста внутри редактора урока).
  if(confirmState && (view==="student"||view==="staff")){
    app.appendChild(renderConfirmModal());
  }
  wireEvents(app);
  runEntranceAnimations();
  if(view==="student" && studentState.tab==="lesson" && !studentState.quizMode && studentState.lessonStage==="video"){
    setTimeout(function(){ wireLessonVideo(savedVideoState); }, 0);
  } else if(lessonPlyrInstance){
    // Ушли со стадии "видео" — старую разметку Plyr уже снёс app.innerHTML="",
    // так что просто отпускаем ссылку на инстанс, а не пытаемся destroy() над
    // отсутствующими в DOM узлами.
    lessonPlyrInstance = null;
  }
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
  return '<div class="wysiwyg-toolbar">' +
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
        '<div class="field"><label>Содержимое</label>' +
          renderWysiwygToolbar("lessonWysiwygEditor","lessonHtmlHidden") +
          '<div class="wysiwyg-editor" id="lessonWysiwygEditor" contenteditable="true">'+(lessonEditor.html||"")+'</div>' +
          '<textarea name="html" id="lessonHtmlHidden" required style="display:none;">'+escapeHtml(lessonEditor.html)+'</textarea>' +
        '<p class="hint">Форматирование, списки, ссылки, изображения и видео — через панель выше. Опасные теги вырезаются автоматически при сохранении.</p></div>' +
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
      '<div class="field"><label>Загрузить видео файлом <span style="font-weight:400;color:var(--muted-2);">(.mp4, .webm, .mov, .m4v — до 500 МБ)</span></label>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<input type="file" id="videoFileInput" accept=".mp4,.webm,.mov,.m4v" style="font-size:12px;flex:1;min-width:0;"'+(uploading?' disabled':'')+'>' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="upload-lesson-video" data-id="'+videoEditor.lessonId+'"'+(uploading?' disabled':'')+'>'+(uploading?'Загружаем…':'Загрузить')+'</button>' +
        '</div>' +
        (uploading ? '<div style="margin-top:8px;height:6px;border-radius:3px;background:var(--line-2);overflow:hidden;"><div id="videoUploadProgressFill" style="height:100%;width:100%;background:var(--primary);transform:scaleX('+(videoEditor.uploadProgress/100)+');transform-origin:left;transition:transform .15s;"></div></div>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:16px 0;color:var(--muted-2);font-size:12.5px;"><span style="flex:1;height:1px;background:var(--line-2);"></span>или<span style="flex:1;height:1px;background:var(--line-2);"></span></div>' +
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
      body += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-lesson-quiz-question" data-idx="'+i+'" data-dir="up"'+(qIsFirst?' disabled':'')+' title="Выше">↑</button>' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-lesson-quiz-question" data-idx="'+i+'" data-dir="down"'+(qIsLast?' disabled':'')+' title="Ниже">↓</button></div>' +
        '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+(i+1)+'. '+escapeHtml(q.question)+'</b><span style="font-size:12px;color:var(--muted);">'+q.options.length+' варианта, правильный: «'+escapeHtml(q.options[q.correct]||"")+'»</span></div>' +
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
      body += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-module-quiz-question" data-idx="'+i+'" data-dir="up"'+(qIsFirst?' disabled':'')+' title="Выше">↑</button>' +
          '<button class="btn btn-sm btn-ghost" style="padding:2px 7px;" data-action="move-module-quiz-question" data-idx="'+i+'" data-dir="down"'+(qIsLast?' disabled':'')+' title="Ниже">↓</button></div>' +
        '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+(i+1)+'. '+escapeHtml(q.question)+'</b><span style="font-size:12px;color:var(--muted);">'+q.options.length+' варианта, правильный: «'+escapeHtml(q.options[q.correct]||"")+'»</span></div>' +
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
          '<span style="font-size:12.5px;color:var(--status-attention);">'+'★'.repeat(f.rating)+'<span style="color:var(--line-2);">'+'★'.repeat(5-f.rating)+'</span></span>' +
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
      '<p style="font-size:13.5px;color:var(--muted);margin:0 0 14px;">Сообщите этот пароль <b style="color:var(--ink);">'+escapeHtml(tempPasswordResult.name)+'</b> лично или через Telegram — он больше нигде не отобразится.</p>' +
      '<div class="card" style="padding:16px;text-align:center;background:var(--primary-tint);border-color:transparent;margin-bottom:16px;">' +
        '<code style="font-size:20px;font-weight:700;letter-spacing:1px;color:var(--primary-dark);">'+escapeHtml(tempPasswordResult.tempPassword)+'</code>' +
      '</div>' +
      '<button class="btn btn-primary btn-block" data-action="close-temp-password">Понятно</button>' +
    '</div>';
  return el('<div class="overlay" data-action="close-temp-password"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
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
  return el('<div class="overlay" data-action="overlay-close-confirm"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
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
    '<p class="hint" style="margin-top:10px;">Вопрос по оплате — обратитесь к куратору в Telegram-группе потока.</p>' +
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
  return el('<div class="overlay" data-action="overlay-close-profile-editor"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

// Всё общение врачей, кураторов и преподавателей — в Telegram-группе потока, не
// в приложении (см. streams.telegram_url). Окно только показывает ссылку(и) и
// ведёт наружу — своей переписки внутри платформы больше нет.
function renderTelegramModal(){
  var body = '<div class="drawer-head"><b style="font-size:16px;">Общение</b><button class="btn btn-ghost btn-sm" data-action="close-telegram-modal">Закрыть ✕</button></div>' +
    '<div class="drawer-body">';
  if(view==="student"){
    var mySid = me.stream_id || "";
    var myStream = mySid ? (calendarState.streams||[]).find(function(s){ return s.id===mySid; }) : null;
    if(!mySid){
      body += '<div class="empty-state" style="padding:30px 10px;">Вы пока не привязаны ни к одному потоку — куратор добавит вас, когда сформируется поток, и здесь появится ссылка на Telegram-группу.</div>';
    } else if(!myStream || !myStream.telegram_url){
      body += '<div class="empty-state" style="padding:30px 10px;">Куратор ещё не добавил ссылку на Telegram-группу вашего потока — уточните у него лично.</div>';
    } else {
      body += '<p style="font-size:13.5px;color:var(--muted);margin:0 0 14px;">Куратор, преподаватели и другие врачи вашего потока «'+escapeHtml(myStream.name)+'» — в этой группе.</p>' +
        '<a class="btn btn-primary btn-block" href="'+escapeHtml(myStream.telegram_url)+'" target="_blank" rel="noopener">Открыть Telegram-группу →</a>';
    }
  } else {
    var streams = calendarState.streams || [];
    if(!streams.length){
      body += '<div class="empty-state" style="padding:30px 10px;">Потоков пока нет — создайте их на странице «Расписание».</div>';
    } else {
      body += '<p style="font-size:13.5px;color:var(--muted);margin:0 0 14px;">Общение с врачами — в Telegram-группах их потоков.</p>';
      streams.forEach(function(s){
        body += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line-2);gap:10px;">' +
          '<b style="font-size:13.5px;">'+escapeHtml(s.name)+'</b>' +
          (s.telegram_url
            ? '<a class="btn btn-sm btn-primary" href="'+escapeHtml(s.telegram_url)+'" target="_blank" rel="noopener">Открыть →</a>'
            : '<span style="font-size:12px;color:var(--muted);">ссылка не добавлена</span>') +
        '</div>';
      });
      body += '<p class="hint" style="margin-top:12px;">Добавить или изменить ссылку — на странице «Расписание».</p>';
    }
  }
  body += '</div>';
  return el('<div class="overlay" data-action="overlay-close-telegram-modal"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
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

function renderAuthScreen(mode){
  var isLogin = mode === "login";
  var left =
    '<div class="onb-left">' +
      '<div><div class="brand">'+brandMark()+'Медицина Долголетия</div>' +
      '<h1 style="margin-top:56px;">'+(isLogin ? "С возвращением" : "Регистрация на демо-курс")+'</h1>' +
      '<p>'+(isLogin ? "Войдите, чтобы продолжить обучение или открыть панель куратора." : "Пара полей — и вы сразу в первом уроке.")+'</p></div>' +
      '<div class="onb-aurora aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
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
          '<div class="field"><label>Имя и фамилия</label><input class="input" id="registerName" required placeholder="Например, Анна Ковалёва" value="'+escapeHtml(registerDraft.name)+'"></div>' +
          renderSpecPicker("register-current", "Текущая специализация", null, registerDraft.specializationIds) +
          renderSpecPicker("register-desired", "Желаемые специализации", "выберите специализации, в которых хотите развиваться, можно оставить поле пустым", registerDraft.interestIds) +
          '<div class="field"><label>Email</label><input class="input" type="email" id="registerEmail" required value="'+escapeHtml(registerDraft.email)+'"></div>' +
          '<div class="field"><label>Телефон <span style="font-weight:400;color:var(--muted-2);">(необязательно)</span></label><input class="input" type="tel" id="registerPhone" value="'+escapeHtml(registerDraft.phone)+'"></div>' +
          '<div class="field"><label>Пароль <span style="font-weight:400;color:var(--muted-2);">(от 6 символов)</span></label><input class="input" type="password" id="registerPassword" required minlength="6" value="'+escapeHtml(registerDraft.password)+'"></div>' +
          '<div class="field"><label>Код сотрудника <span style="font-weight:400;color:var(--muted-2);">(только если вас пригласили куратором/администратором — уточните код у пригласившего)</span></label><input class="input" id="registerStaffCode" placeholder="Оставьте пустым, если регистрируетесь на курс" value="'+escapeHtml(registerDraft.staffInviteCode)+'"></div>' +
          '<div class="err-text" id="authError" style="display:none;"></div>' +
          '<button class="btn btn-primary btn-block" type="submit">Начать курс</button>' +
        '</form>' +
        '<p class="hint">Если вам уже выдали доступ куратора или администратора на этот email — роль назначится автоматически вместо регистрации на курс, но только вместе с верным кодом сотрудника выше.</p>' +
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

function sidebarItem(key, iconName, label, active, badge){
  return '<button type="button" class="sidebar-item'+(active?' active':'')+'" data-action="sidebar-nav" data-key="'+key+'" title="'+escapeHtml(label)+'">' +
    icon(iconName) +
    '<span class="sidebar-item-label">'+escapeHtml(label)+'</span>' +
    (badge>0 ? '<span class="sidebar-item-badge">'+(badge>9?"9+":badge)+'</span><span class="sidebar-item-dot"></span>' : '') +
  '</button>';
}

function renderSidebar(){
  var items = "";
  if(view==="student"){
    var navKey = studentState.navKey || "course";
    if(previewMode){
      items += sidebarItem("course","home","Обучение", navKey==="course");
      items += sidebarItem("schedule","calendar","Расписание", navKey==="schedule");
    } else {
      var notifBadge = notifState.unreadCount + upcomingEventReminders().length;
      items += sidebarItem("search","search","Поиск", navKey==="search");
      items += sidebarItem("profile","user","Мой профиль", navKey==="profile");
      items += sidebarItem("course","home","Обучение", navKey==="course");
      items += sidebarItem("schedule","calendar","Расписание", navKey==="schedule");
      items += sidebarItem("materials","folder","Материалы обучения", navKey==="materials");
      items += sidebarItem("progress","chartbar","Мой прогресс", navKey==="progress");
      // См. protocolsSectionAvailable — до этого момента в коллекции нечему появиться.
      if(course && protocolsSectionAvailable()){
        items += sidebarItem("protocols","doctor","Ваши протоколы", navKey==="protocols");
      }
      items += sidebarItem("messages","message","Telegram", false);
      items += sidebarItem("notifications","bell","Уведомления", navKey==="notifications", notifBadge);
      items += sidebarItem("settings","gear","Настройки", navKey==="settings");
    }
  } else {
    var snavKey = staffState.navKey || "students";
    var isAdmin = me.role==="admin" || me.role==="super_admin";
    var staffNotifBadge = upcomingEventReminders().length;
    items += sidebarItem("profile","user","Мой профиль", snavKey==="profile");
    items += sidebarItem("home","home","Главная", snavKey==="home");
    items += sidebarItem("students","users","Ученики", snavKey==="students");
    items += sidebarItem("calendar","calendar","Расписание", snavKey==="calendar");
    items += sidebarItem("materials","folder","Учебные материалы", snavKey==="materials");
    items += sidebarItem("dashboard","chartbar","Аналитика", snavKey==="dashboard");
    items += sidebarItem("protocols","doctor","Протоколы", snavKey==="protocols");
    if(isAdmin){
      items += sidebarItem("courses","folder","Курсы", snavKey==="courses");
      items += sidebarItem("team","users","Команда", snavKey==="team");
      items += sidebarItem("modules","clipboard","Модули", snavKey==="modules");
      items += sidebarItem("audit","list","Журнал", snavKey==="audit");
    }
    items += sidebarItem("chats","message","Telegram", false);
    items += sidebarItem("notifications","bell","Уведомления", snavKey==="notifications", staffNotifBadge);
    items += sidebarItem("settings","gear","Настройки", snavKey==="settings");
  }

  var footer;
  if(previewMode){
    footer = '<div class="sidebar-footer">' +
      '<button type="button" class="sidebar-item" data-action="exit-preview" title="Вернуться в панель">'+icon("logout")+'<span class="sidebar-item-label">Вернуться в панель</span></button>' +
    '</div>';
  } else {
    var isDark = getTheme()==="dark";
    footer = '<div class="sidebar-footer">' +
      '<button type="button" class="sidebar-item" data-action="toggle-theme" title="Переключить тему">'+icon(isDark?"sun":"moon")+'<span class="sidebar-item-label">'+(isDark?"Светлая тема":"Тёмная тема")+'</span></button>' +
      '<button type="button" class="sidebar-item" data-action="logout" title="Выйти">'+icon("logout")+'<span class="sidebar-item-label">Выйти</span></button>' +
    '</div>';
  }

  return el(
    '<div class="sidebar'+(mobileNavOpen?' mobile-open':'')+'">' +
      '<div class="sidebar-brand">'+brandMark()+'<span class="sidebar-item-label">Медицина Долголетия</span>' +
        '<button type="button" class="sidebar-toggle" data-action="toggle-mobile-nav" title="Меню" aria-label="Меню">'+icon(mobileNavOpen?"close":"menu")+'</button>' +
      '</div>' +
      '<div class="sidebar-nav">'+items+'</div>' +
      footer +
    '</div>'
  );
}

// Подложка мобильного меню — отдельный элемент (не вложенный в .sidebar), чтобы
// не ломать связь .sidebar ~ .app-main в CSS (сдвиг контента под раскрытый
// сайдбар на десктопе завязан на то, что они прямые соседи).
function renderMobileNavBackdrop(){
  return mobileNavOpen ? el('<div class="sidebar-backdrop" data-action="close-mobile-nav"></div>') : null;
}

// Тёмная тема — дефолт продукта (не только системная), можно переключить вручную.
function getTheme(){ return localStorage.getItem("lms-theme") || "dark"; }
function applyTheme(){ document.documentElement.setAttribute("data-theme", getTheme()); }
function toggleTheme(){
  localStorage.setItem("lms-theme", getTheme()==="dark" ? "light" : "dark");
  applyTheme();
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

function renderStudentShell(){
  var wrap = el('<div></div>');
  var mobNavBackdrop = renderMobileNavBackdrop();
  if(mobNavBackdrop) wrap.appendChild(mobNavBackdrop);
  wrap.appendChild(renderSidebar());
  var main = el('<div class="app-main"></div>');
  wrap.appendChild(main);
  if(previewMode){
    main.appendChild(el('<div style="background:var(--accent);color:#1B1A14;text-align:center;padding:10px 16px;font-size:13.5px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;">'+icon("eye")+' Режим просмотра «глазами врача» — изменения не сохраняются</div>'));
  }
  if(course && studentState.tab === "lesson") addSideFlow(main);
  var shell = el('<div class="shell"><div class="wrap" id="studentContent"></div></div>');
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
    html += '<div class="sched-top">' +
      '<div class="card sched-hero">' +
        (nxLive ? magnet("live","Идёт сейчас") : magnet("attention","Ближайший эфир"+(whenLabel(nx)?' · '+whenLabel(nx):''))) +
        '<h2>'+escapeHtml(nx.title)+'</h2>' +
        '<div class="sched-hero-meta"><span>'+dateLine(nx)+'</span><span>'+(nx.duration_min||60)+' мин</span>'+(nx.speaker?'<span>'+escapeHtml(nx.speaker)+'</span>':'')+'</div>' +
        actions(nx, nxLive, true) +
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
      '<span style="font-size:13.5px;'+(i.done?'color:var(--muted);text-decoration:line-through;':'')+'">'+escapeHtml(i.label)+'</span>' +
    '</div>';
  });
  html += '</div>';
  return html;
}

function renderStudentHome(){
  var pr = course.progress || {};
  var total = course.lessons.length;
  var doneIds = pr.completed_lessons||[];
  var done = doneIds.length;
  var lock = course.locked || {locked:false};

  var html = '<div style="margin-top:10px;">' + renderOnboardingCard();
  if(lock.locked){
    html += '<div class="card course-hero" style="background:var(--status-blocked-tint);">' +
      magnet("blocked", "Доступ ограничен") +
      '<h2 style="margin-top:14px;">'+escapeHtml(course.course.title)+'</h2>' +
      '<p>'+(lock.reason==="blocked" ? 'Куратор временно ограничил ваш доступ к демо-курсу.' : 'Срок доступа к демо-курсу истёк.')+' Чтобы продолжить обучение, напишите куратору в Telegram-группе потока — он может продлить или снять ограничение.</p>' +
      '<button class="btn btn-primary" data-action="open-telegram-modal">Написать куратору</button></div>';
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

    var pct = Math.round((done + (quizDone?1:0)) / (total+1) * 100);
    html += '<div class="card course-hero">' +
      '<div class="hero-aurora aurora" aria-hidden="true">'+AURORA_BANDS+'</div>' +
      '<div class="course-hero-top">' +
        '<div class="progress-ring" data-anim="ring" style="--ring-p:'+pct+'%;"><div class="progress-ring-inner"><span data-count="'+pct+'" data-suffix="%">'+pct+'%</span></div></div>' +
        '<div><h2 style="margin:0;">'+escapeHtml(course.course.title)+'</h2>' +
        '<p style="margin:4px 0 0;">'+total+' коротких уроков и итоговый тест. По завершении — сертификат и возможность оставить заявку на полную программу обучения.</p></div>' +
      '</div>' +
      slots +
      '<div class="progress-label">'+done+' / '+total+' уроков'+(pr.completed?' · тест '+pr.quiz_score+'%':'')+'</div>';
    // Название конкретного следующего шага рядом с кнопкой — чтобы врач видел,
    // куда именно попадёт, не открывая курс наугад.
    var nextStepLabel = null;
    if(done < total) nextStepLabel = "Урок "+(done+1)+": "+course.lessons[done].title;
    else if(!quizDone) nextStepLabel = "Итоговый тест";
    html += (nextStepLabel ? '<div style="font-size:12.5px;color:var(--muted);margin-bottom:12px;">Далее: '+escapeHtml(nextStepLabel)+'</div>' : '') +
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
      '<span style="font-size:12.5px;color:var(--muted);">'+fmtDate(nextEvent.event_date)+' · '+escapeHtml(nextEvent.event_time||"")+'</span>' +
      (liveNow && nextEvent.join_url ? '<a class="btn btn-sm btn-primary" style="margin-top:12px;" href="'+escapeHtml(nextEvent.join_url)+'" target="_blank" rel="noopener">Подключиться</a>' :
        '<button class="btn btn-sm btn-ghost" style="margin-top:12px;" data-action="student-tab" data-tab="schedule">Все эфиры →</button>');
  } else {
    html += magnet("neutral","Эфиры") + '<p style="font-size:12.5px;color:var(--muted);margin:10px 0 0;">Пока не запланированы.</p>';
  }
  html += '</div>';

  if(pr.completed){
    var certsOn = course && course.course && course.course.certificatesEnabled;
    html += '<div class="card" style="padding:18px;">';
    if(certsOn){
      var issued = pr.certificate_status==="issued";
      html += magnet(issued?"done":"attention", issued?"Сертификат выдан":"На проверке") +
        '<div style="font-family:var(--sans);font-weight:800;font-size:26px;margin:10px 0 2px;letter-spacing:-.02em;">'+pr.quiz_score+'%</div>' +
        '<span style="font-size:12px;color:var(--muted);">результат теста</span>';
      if(!issued && !pr.requested_full_access){
        html += '<button class="btn btn-sm btn-primary btn-block" style="margin-top:12px;" data-action="request-full">Заявка на полную программу</button>';
      } else if(pr.requested_full_access){
        html += '<div style="margin-top:12px;">'+magnet("done","Заявка отправлена")+'</div>';
      }
    } else {
      html += magnet("done","Демо пройдено") +
        '<div style="font-family:var(--sans);font-weight:800;font-size:26px;margin:10px 0 2px;letter-spacing:-.02em;">'+pr.quiz_score+'%</div>' +
        '<span style="font-size:12px;color:var(--muted);">результат теста · скидка 10% на полный курс</span>';
      if(!pr.requested_full_access){
        html += '<button class="btn btn-sm btn-primary btn-block" style="margin-top:12px;" data-action="request-full">Хочу полное обучение</button>';
      } else {
        html += '<div style="margin-top:12px;">'+magnet("done","Заявка отправлена")+'</div>';
      }
    }
    html += '</div>';
  }

  html += '<div class="card" style="padding:18px;">' +
    magnet("neutral","Куратор") +
    '<p style="font-size:13px;color:var(--muted);margin:10px 0 12px;line-height:1.4;">Вопрос по курсу или доступу — напишите в Telegram-группе потока.</p>' +
    '<button class="btn btn-sm btn-ghost" data-action="open-telegram-modal">Открыть Telegram →</button>' +
  '</div>';

  var gam = course.gamification || { points:0, currentStreak:0, longestStreak:0 };
  html += '<div class="card" style="padding:18px;">' +
    magnet("neutral","Прогресс") +
    '<div style="display:flex;align-items:baseline;gap:6px;margin-top:10px;">' +
      icon("flame","ic-sm streak-flame") +
      '<span style="font-family:var(--sans);font-weight:800;font-size:22px;letter-spacing:-.02em;" data-count="'+(gam.currentStreak||0)+'">'+(gam.currentStreak||0)+'</span>' +
      '<span style="font-size:12px;color:var(--muted);">'+(gam.currentStreak===1?"день подряд":"дней подряд")+'</span>' +
    '</div>' +
    '<span style="font-size:12px;color:var(--muted);display:block;margin-top:2px;">рекорд: '+(gam.longestStreak||0)+'</span>' +
    '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-2);">' +
      '<span style="font-family:var(--sans);font-weight:800;font-size:18px;" data-count="'+(gam.points||0)+'">'+(gam.points||0)+'</span>' +
      '<span style="font-size:12px;color:var(--muted);"> / 1000 очков</span>' +
      '<button class="btn btn-sm btn-ghost" style="display:block;margin-top:8px;padding:4px 0;" data-action="student-tab" data-tab="progress">Как получить скидку →</button>' +
    '</div>' +
  '</div>';

  html += '</div>';

  // Короткий предпросмотр на главной — не дублирует полную страницу «Уведомления»
  // из сайдбара, а просто отвечает на вопрос «есть что-то новое?», не уходя со страницы.
  var homeReminders = upcomingEventReminders();
  var homeNotifItems = homeReminders.concat(notifState.items.filter(function(n){ return !n.read_at; }));
  html += '<div class="grid-2" style="margin-top:14px;">';
  html += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<b style="font-size:14px;">Уведомления</b>' +
      (homeNotifItems.length ? '<button class="btn btn-sm btn-ghost" data-action="student-tab" data-tab="notifications">Все →</button>' : '') +
    '</div>';
  if(!homeNotifItems.length){
    html += '<p style="font-size:13px;color:var(--muted);margin:0;">У вас нет новых уведомлений.</p>';
  } else {
    homeNotifItems.slice(0,3).forEach(function(n){
      html += '<div style="padding:8px 0;border-bottom:1px solid var(--line-2);"><b style="font-size:12.5px;display:block;">'+escapeHtml(n.title)+'</b></div>';
    });
  }
  html += '</div>';
  html += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<b style="font-size:14px;">Общение</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-telegram-modal">Открыть →</button>' +
    '</div>' +
    '<p style="font-size:13px;color:var(--muted);margin:0;">Куратор, преподаватели и другие врачи вашего потока — в Telegram-группе.</p>' +
  '</div></div>';

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
function renderStudentMaterials(){
  var q = studentState.materialsSearch.trim();
  var bookmarks = course.bookmarkedLessonIds || [];
  var items = course.lessons.map(function(l,idx){
    var text = stripHtml(l.html);
    return { lesson:l, idx:idx, text:text, isBookmarked: bookmarks.indexOf(l.id)!==-1 };
  });
  if(studentState.materialsFilter==="bookmarked") items = items.filter(function(it){ return it.isBookmarked; });
  if(q){
    var qLower = q.toLowerCase();
    items = items.filter(function(it){ return it.lesson.title.toLowerCase().indexOf(qLower)!==-1 || it.text.toLowerCase().indexOf(qLower)!==-1; });
  }

  var html = '<div style="margin-top:6px;max-width:720px;">' +
    '<div class="card" style="padding:18px 20px;">' +
      '<b style="font-size:14.5px;display:block;margin-bottom:12px;">Материалы обучения</b>' +
      '<input class="input" id="materialsSearchInput" placeholder="Искать по названию или тексту урока…" value="'+escapeHtml(studentState.materialsSearch)+'" style="margin-bottom:12px;">' +
      '<div class="tabs" style="margin-top:0;margin-bottom:14px;">' +
        '<button class="tab'+(studentState.materialsFilter==="all"?' active':'')+'" data-action="materials-filter" data-filter="all">Все материалы</button>' +
        '<button class="tab'+(studentState.materialsFilter==="bookmarked"?' active':'')+'" data-action="materials-filter" data-filter="bookmarked">Мои материалы'+(bookmarks.length?' ('+bookmarks.length+')':'')+'</button>' +
      '</div>';

  if(!items.length){
    html += '<div class="empty-state" style="padding:30px 10px;">'+(q?'Ничего не нашлось по запросу «'+escapeHtml(q)+'».':(studentState.materialsFilter==="bookmarked"?'Вы ещё ничего не сохранили. Откройте урок и нажмите на закладку.':'Материалов пока нет.'))+'</div>';
  } else {
    items.forEach(function(it){
      var l = it.lesson;
      var isLocked = l.hiddenForMe || l.dripLockedForMe;
      html += '<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--line-2);">' +
        '<button class="btn btn-sm btn-ghost" style="padding:6px 9px;flex-shrink:0;" data-action="toggle-bookmark" data-id="'+l.id+'" data-bookmarked="'+(it.isBookmarked?"1":"0")+'" title="'+(it.isBookmarked?"Убрать из моих материалов":"Сохранить в мои материалы")+'">'+(it.isBookmarked?"★":"☆")+'</button>' +
        '<div style="flex:1;min-width:0;">' +
          '<b style="font-size:13.5px;display:block;">'+(it.idx+1)+'. '+escapeHtml(l.title)+(isLocked?' '+magnet("neutral","недоступен"):'')+'</b>' +
          '<span style="font-size:12.5px;color:var(--muted);line-height:1.5;">'+escapeHtml(snippetAround(it.text,q))+'</span>' +
        '</div>' +
        (isLocked ? '' : '<button class="btn btn-sm btn-ghost" style="flex-shrink:0;" data-action="goto-lesson-from-materials" data-idx="'+it.idx+'">Открыть →</button>') +
      '</div>';
    });
  }
  html += '</div></div>';
  return el(html);
}

// Формат урока: текстовое интро (как и раньше) → видео с главами по таймкодам
// (если куратор его добавил) → поурочный «развлекательный» тест на запоминание
// (если куратор его добавил). Оба шага опциональны — урок без видео и теста
// работает ровно как раньше (одна кнопка "Урок пройден, далее →").
function lessonStagesFor(lesson){
  var stages = ["intro"];
  if(lesson.videoUrl) stages.push("video");
  if(lesson.quiz && lesson.quiz.length) stages.push("quiz");
  return stages;
}
function resetLessonStageState(){
  studentState.lessonStage = "intro";
  studentState.videoEnded = false;
  studentState.lessonQuizAnswers = {};
  studentState.lessonQuizResult = null;
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

  var isDoneAlready = doneIds.indexOf(lesson.id)!==-1;
  var stages = lessonStagesFor(lesson);
  var stage = stages.indexOf(studentState.lessonStage)!==-1 ? studentState.lessonStage : "intro";
  var isBookmarked = (course.bookmarkedLessonIds||[]).indexOf(lesson.id)!==-1;

  var body = '<div class="lesson-body">' +
    '<button class="back-link" data-action="close-course">← К курсу</button>' +
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">' +
      '<h3 style="margin:0;">'+escapeHtml(lesson.title)+'</h3>' +
      '<button class="btn btn-sm btn-ghost" style="flex-shrink:0;" data-action="toggle-bookmark" data-id="'+lesson.id+'" data-bookmarked="'+(isBookmarked?"1":"0")+'" title="'+(isBookmarked?"Убрать из моих материалов":"Сохранить в мои материалы")+'">'+(isBookmarked?"★ В моих материалах":"☆ Сохранить")+'</button>' +
    '</div>' +
    '<div class="meta">Урок '+(idx+1)+' из '+course.lessons.length+' · '+escapeHtml(lesson.duration||"")+'</div>';

  if(stages.length>1){
    var stageLabels = { intro:"Материал", video:"Видео", quiz:"Тест" };
    body += '<div class="tabs" style="margin:14px 0 4px;">';
    stages.forEach(function(sKey){
      var locked = sKey==="quiz" && !isDoneAlready && stages.indexOf("video")!==-1 && !studentState.videoEnded;
      body += '<button type="button" class="tab'+(stage===sKey?' active':'')+'"'+(locked?' disabled title="Сначала досмотрите видео"':'')+' data-action="lesson-stage" data-stage="'+sKey+'">'+stageLabels[sKey]+(locked?' '+icon("lock","ic-sm"):'')+'</button>';
    });
    body += '</div>';
  }

  if(stage==="intro"){
    var noteVal = (course.progress && course.progress.lesson_notes && course.progress.lesson_notes[lesson.id]) || "";
    body += '<div class="prose">'+lesson.html+'</div>' +
      '<div class="lesson-note">' +
        '<label>Ваша заметка к уроку <span style="font-weight:400;color:var(--muted-2);">(видна только вам)</span></label>' +
        '<textarea class="input" id="lessonNoteInput" style="height:64px;font-size:13.5px;" placeholder="Например: спросить куратора про дозировки">'+escapeHtml(noteVal)+'</textarea>' +
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
  }

  body += '</div>';
  return el('<div class="player" style="margin-top:6px;">'+nav+body+'</div>');
}

function renderLessonVideoStage(lesson, stages, isDoneAlready){
  var tcs = lesson.videoTimecodes||[];
  var html = '<div class="lesson-video-wrap"><video id="lessonVideoPlayer" controls preload="metadata" src="'+escapeHtml(lesson.videoUrl)+'"></video></div>';

  if(tcs.length){
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">';
    tcs.forEach(function(tc,i){
      html += '<button type="button" class="chapter-item btn btn-sm btn-ghost" data-action="seek-lesson-video" data-time="'+tc.time+'" data-chapter-id="'+tc.id+'" style="'+(i===0?'':'')+'">'+fmtTimecode(tc.time)+' · '+escapeHtml(tc.title)+'</button>';
    });
    html += '</div>';
    html += '<div id="lessonChapterSummary" class="prose" style="min-height:24px;">'+renderPlainToProse(tcs[0].summary||'')+'</div>';
  }

  var hasQuiz = stages.indexOf("quiz")!==-1;
  var canProceed = isDoneAlready || studentState.videoEnded;
  html += '<div class="lesson-footer">' +
    '<button class="btn btn-ghost" data-action="lesson-stage" data-stage="intro">← К материалу</button>';
  if(hasQuiz){
    html += '<button class="btn btn-primary" data-action="lesson-stage" data-stage="quiz"'+(canProceed?'':' disabled title="Досмотрите видео до конца"')+'>Пройти тест →</button>';
  } else {
    html += '<button class="btn btn-primary" data-action="next-lesson"'+(canProceed?'':' disabled title="Досмотрите видео до конца"')+'>Урок пройден, далее →</button>';
  }
  html += '</div>';
  return html;
}

function renderLessonQuizStage(lesson){
  var result = studentState.lessonQuizResult;
  var prevScore = course.progress && course.progress.lesson_quiz_scores && course.progress.lesson_quiz_scores[lesson.id];
  var html = '';
  if(result){
    html += '<div class="empty-state" style="padding:40px 10px;">' +
      '<div class="big">'+icon(result.score>=60?"badge":"star","ic-lg")+'</div>' +
      '<b style="font-size:20px;display:block;margin-bottom:6px;">'+result.score+'%</b>' +
      '<p style="color:var(--muted);">правильных ответов — это просто для закрепления материала, на сертификат не влияет.</p>' +
      '<button class="btn btn-primary" style="margin-top:14px;" data-action="next-lesson">Далее →</button>' +
    '</div>';
    return html;
  }
  if(typeof prevScore==="number"){
    html += '<p class="hint" style="margin-bottom:12px;">Прошлый результат: '+prevScore+'%. Можно пройти ещё раз.</p>';
  }
  html += '<form id="lessonQuizForm" data-lesson-id="'+lesson.id+'">';
  lesson.quiz.forEach(function(q,qi){
    html += '<div class="quiz-q"><p class="qtext">'+(qi+1)+'. '+escapeHtml(q.question)+'</p>';
    q.options.forEach(function(opt,oi){
      html += '<label class="opt"><input type="radio" name="'+q.id+'" value="'+oi+'" required> '+escapeHtml(opt)+'</label>';
    });
    html += '</div>';
  });
  html += '<button class="btn btn-primary btn-block" type="submit">Завершить тест</button></form>';
  return html;
}

// Гейт после последнего урока модуля: сначала итоговый тест по модулю (если у него
// есть вопросы), потом мини-опрос — оба шага в одном "плеере", без сайдбара с
// уроками (тот же приём, что и renderQuizOrCert для итогового теста курса).
function renderModuleGate(){
  var mod = (course.modules||[]).find(function(m){ return m.id===studentState.moduleGateId; });
  if(!mod){ resetModuleGateState(); return renderCoursePlayer(); }
  var body = '<div class="lesson-body">' +
    (studentState.moduleGateStage==="quiz" ? renderModuleQuizStage(mod) : renderModuleFeedbackStage(mod)) +
  '</div>';
  return el('<div class="player" style="margin-top:6px;grid-template-columns:1fr;">'+body+'</div>');
}

function renderModuleQuizStage(mod){
  var result = studentState.moduleQuizResult;
  if(result){
    return '<div class="empty-state" style="padding:40px 10px;">' +
      '<div class="big">'+icon(result.score>=60?"badge":"star","ic-lg")+'</div>' +
      '<b style="font-size:20px;display:block;margin-bottom:6px;">'+result.score+'%</b>' +
      '<p style="color:var(--muted);">Итоговый тест модуля «'+escapeHtml(mod.title)+'» — для закрепления материала.</p>' +
      '<button class="btn btn-primary" style="margin-top:14px;" data-action="module-gate-to-feedback">Далее → короткий отзыв</button>' +
    '</div>';
  }
  var html = '<div class="meta" style="margin-bottom:2px;">Модуль «'+escapeHtml(mod.title)+'» пройден</div>' +
    '<h3 style="margin-top:4px;">Итоговый тест модуля</h3>' +
    '<div class="meta">'+mod.quiz.length+' вопросов</div>' +
    '<form id="moduleQuizForm" data-module-id="'+mod.id+'">';
  mod.quiz.forEach(function(q,qi){
    html += '<div class="quiz-q"><p class="qtext">'+(qi+1)+'. '+escapeHtml(q.question)+'</p>';
    q.options.forEach(function(opt,oi){
      html += '<label class="opt"><input type="radio" name="'+q.id+'" value="'+oi+'" required> '+escapeHtml(opt)+'</label>';
    });
    html += '</div>';
  });
  html += '<button class="btn btn-primary btn-block" type="submit">Завершить тест</button></form>';
  return html;
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
  var certsOn = course && course.course && course.course.certificatesEnabled;
  var html = '<div class="player" style="margin-top:6px;grid-template-columns:1fr;"><div class="cert">';

  if(!certsOn){
    // Текущий курс — демо: сертификат за него не выдаётся, вместо этого предлагаем
    // скидку и заявку на полноценное обучение (см. существующий request-full-access).
    var requested = !!pr.requested_full_access;
    html += '<div class="seal">'+icon("badge","ic-lg")+'</div>' +
      '<h2>Поздравляем с прохождением демо-курса!</h2>' +
      '<p style="color:var(--muted);font-size:14px;">'+escapeHtml(me.name)+', «'+escapeHtml(course.course.title)+'»</p>' +
      '<div class="score">'+pr.quiz_score+'%</div>' +
      '<p style="color:var(--muted);font-size:13px;margin-bottom:24px;">правильных ответов в итоговом тесте</p>' +
      '<p style="font-size:13.5px;color:var(--muted);max-width:380px;margin:0 auto 24px;">Вы получили скидку 10% на обучение по курсу «Медицина Долголетия». Желаете присоединиться к полноценному обучению?</p>';
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
    html += '<p style="font-size:13.5px;color:var(--muted);max-width:360px;margin:0 auto 24px;">Куратор проверит результат и выдаст сертификат — он появится здесь автоматически.</p>';
  } else {
    html += '<p style="font-size:12.5px;color:var(--muted);margin:0 0 24px;">Выдан '+fmtDate(pr.certificate_issued_at)+(pr.certificate_issued_by?(' · '+escapeHtml(pr.certificate_issued_by)):'')+'</p>';
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
      '<span style="font-size:13.5px;flex:1;'+(unlocked?'':'color:var(--muted);')+'">'+t.points+' очков</span>' +
      '<b style="font-size:13.5px;'+(unlocked?'color:var(--ink);':'color:var(--muted);')+'">скидка '+t.discount+'%</b>' +
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
    if(next) html += '<p style="font-size:12.5px;color:var(--muted-2);margin:10px 0 0;">Ещё '+(next.points-points)+' очков — и скидка вырастет до '+next.discount+'%.</p>';
  } else {
    html += '<p style="font-size:12.5px;color:var(--muted-2);margin:0;">Наберите '+POINT_TIERS[0].points+' очков, чтобы открыть первую скидку — '+POINT_TIERS[0].discount+'%. Осталось '+(POINT_TIERS[0].points-points)+'.</p>';
  }
  return html;
}

// «Ваши протоколы» — коллекция, которая пополняется по мере прохождения уроков
// (каждый пройденный урок может открыть свои протоколы — см. lesson_protocols).
// Разбивка на «по вашей специализации» / «дополнительные» приходит уже готовой
// с бэкенда (GET /course/protocols), тут только рендер и переключение гайдов.
function renderProtocolCard(p, isForYou){
  var expanded = !!protocolExpanded[p.id];
  var myIds = (me.specializationIds||[]).concat(me.interestIds||[]);
  var defaultGuide = null;
  if(isForYou){
    defaultGuide = p.guides.find(function(g){ return myIds.indexOf(g.specializationId)!==-1; });
  }
  var activeSpecId = protocolGuideTab[p.id] || (defaultGuide ? defaultGuide.specializationId : (p.guides[0] ? p.guides[0].specializationId : null));
  var activeGuide = p.guides.find(function(g){ return g.specializationId===activeSpecId; });

  var html = '<div class="card" style="padding:18px 20px;margin-bottom:12px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;cursor:pointer;" data-action="toggle-protocol" data-id="'+p.id+'">' +
      '<div><b style="font-size:14.5px;display:block;">'+escapeHtml(p.title)+'</b>' +
        (p.summary ? '<p style="font-size:13px;color:var(--muted);margin:4px 0 0;">'+renderPlainToProse(p.summary)+'</p>' : '') +
      '</div>' +
      '<button type="button" class="btn btn-sm btn-ghost" style="flex-shrink:0;">'+(expanded?'Свернуть':'Открыть гайд')+'</button>' +
    '</div>';

  if(expanded){
    if(!p.guides.length){
      html += '<p class="hint" style="margin-top:12px;">Гайд применения ещё не добавлен куратором.</p>';
    } else {
      if(p.guides.length>1){
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 10px;">';
        p.guides.forEach(function(g){
          html += '<button type="button" class="btn btn-sm '+(g.specializationId===activeSpecId?'btn-primary':'btn-ghost')+'" data-action="select-protocol-guide" data-id="'+p.id+'" data-spec="'+g.specializationId+'">'+escapeHtml(g.specializationName)+'</button>';
        });
        html += '</div>';
      } else {
        html += '<p class="hint" style="margin-top:14px;">Гайд для специализации «'+escapeHtml(p.guides[0].specializationName)+'»</p>';
      }
      html += '<div class="prose">'+(activeGuide&&activeGuide.guideHtml?renderPlainToProse(activeGuide.guideHtml):'')+'</div>';
      if(activeGuide && activeGuide.files && activeGuide.files.length){
        html += '<div style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">';
        activeGuide.files.forEach(function(f){
          html += '<a href="'+f.url+'" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--primary);text-decoration:underline;width:fit-content;">'+icon("folder","ic-sm")+'<span>'+escapeHtml(f.originalName)+'</span></a>';
        });
        html += '</div>';
      }
    }
  }
  html += '</div>';
  return html;
}

function renderProtocolsPage(){
  var html = '<div style="margin-top:6px;max-width:760px;">' +
    '<div class="card" style="padding:18px 20px;margin-bottom:16px;background:var(--primary-tint);border-color:transparent;">' +
      '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Ваша коллекция протоколов</b>' +
      '<p style="font-size:13px;color:var(--muted);margin:0;">После каждого пройденного урока сюда добавляются протоколы, о которых говорил спикер — с готовым гайдом по внедрению именно в рамках вашей специализации.</p>' +
    '</div>';

  var forYou = studentProtocols.forYou||[], additional = studentProtocols.additional||[];
  if(!forYou.length && !additional.length){
    html += '<div class="empty-state" style="padding:40px 10px;">'+icon("doctor","ic-lg")+'<p style="margin-top:10px;">Пока пусто — пройдите первый урок, чтобы начать собирать протоколы.</p></div>';
    return el(html);
  }

  if(forYou.length){
    html += '<b style="font-size:13.5px;display:block;margin:6px 0 10px;">По вашей специализации</b>';
    forYou.forEach(function(p){ html += renderProtocolCard(p, true); });
  }
  if(additional.length){
    html += '<b style="font-size:13.5px;display:block;margin:18px 0 10px;color:var(--muted);">Дополнительные протоколы</b>' +
      '<p class="hint" style="margin:-4px 0 10px;">Тоже из пройденных уроков, но не по вашему профилю — можно посмотреть гайд для любой специализации.</p>';
    additional.forEach(function(p){ html += renderProtocolCard(p, false); });
  }
  html += '</div>';
  return el(html);
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

function renderNotificationsPage(){
  var reminders = upcomingEventReminders();
  var items = reminders.concat(notifState.items);
  var html = '<div style="margin-top:6px;max-width:760px;">' +
    '<div class="card" style="padding:18px 20px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
        '<b style="font-size:14.5px;">Уведомления</b>' +
        (notifState.unreadCount>0 ? '<button class="btn btn-sm btn-ghost" data-action="mark-all-notifs-read">Пометить всё прочитанным</button>' : '') +
      '</div>';
  if(!items.length){
    html += '<div class="empty-state" style="padding:30px 10px;">У вас нет новых уведомлений.</div>';
  } else {
    items.forEach(function(n){
      var unread = n.synthetic || !n.read_at;
      html += '<div class="'+(n.synthetic?'':'notif-item')+'" '+(n.synthetic?'':'data-action="mark-notif-read" data-id="'+n.id+'"')+
        ' style="padding:12px 0;border-bottom:1px solid var(--line-2);cursor:'+(n.synthetic?'default':'pointer')+';'+(unread?'':'opacity:.55;')+'">' +
        '<b style="font-size:13.5px;display:block;">'+escapeHtml(n.title)+'</b>' +
        (n.body?'<span style="font-size:12.5px;color:var(--muted);display:block;margin-top:3px;">'+escapeHtml(n.body)+'</span>':'') +
        (n.created_at&&!n.synthetic?'<span style="font-size:11px;color:var(--muted-2);display:block;margin-top:4px;">'+fmtDate(n.created_at)+' '+fmtTime(n.created_at)+'</span>':'') +
      '</div>';
    });
  }
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
      { label:"Редактировать содержимое уроков, тест и их порядок", allowed:false },
      { label:"Назначать роли сотрудникам, просматривать журнал действий", allowed:false }
    ];
  }
  if(role==="admin"){
    return [
      { label:"Всё, что доступно куратору обучения", allowed:true },
      { label:"Редактировать уроки, тест, черновики и историю правок", allowed:true },
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
  var isStudent = me.role==="student";
  var caps = roleCapabilities(me.role);
  var html = '<div style="margin-top:6px;" class="grid-2">';

  // Левая колонка (шире) — форма профиля и то, что доступно роли.
  html += '<div>';
  html += '<div class="card" style="padding:18px 20px;margin-bottom:14px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:14px;">Основная информация</b>' +
    '<form id="profileEditorForm">' +
      '<div class="field"><label>Имя и фамилия</label><input class="input" id="profileEditorName" required value="'+escapeHtml(profileEditor.name)+'"></div>' +
      (isStudent ? renderProfileSpecializationFields() : '') +
      '<div class="field"><label>Телефон</label><input class="input" type="tel" id="profileEditorPhone" value="'+escapeHtml(profileEditor.phone)+'"></div>' +
      (isStudent ? '<div class="field"><label>Место работы</label><input class="input" id="profileEditorWorkplace" value="'+escapeHtml(profileEditor.workplace)+'"></div>' : '') +
      '<div class="field"><label>Email</label><div class="input" style="background:var(--line-2);color:var(--muted);">'+escapeHtml(me.email||"")+'</div><p class="hint">Email нельзя изменить самостоятельно — обратитесь к куратору.</p></div>' +
      '<div class="err-text" id="profileEditorError" style="display:none;"></div>' +
      '<button class="btn btn-primary" type="submit">Сохранить</button>' +
    '</form>' +
    (isStudent ? renderMyProductBlock() : '') +
  '</div>';

  html += '<div class="card" style="padding:18px 20px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Доступы</b>' +
    '<p class="hint" style="margin:0 0 12px;">Что вам доступно на платформе при роли «'+escapeHtml(roleLabel(me.role))+'», а что нет.</p>';
  caps.forEach(function(c){
    html += '<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-2);">' +
      '<span style="width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff;background:'+(c.allowed?'var(--status-active)':'var(--line-2)')+';">'+(c.allowed?icon("check","ic-sm"):'')+'</span>' +
      '<span style="font-size:13px;'+(c.allowed?'':'color:var(--muted);')+'">'+escapeHtml(c.label)+'</span>' +
    '</div>';
  });
  html += '</div>';
  html += '</div>';

  // Правая колонка (уже) — безопасность и сеансы, не привязаны к ширине формы.
  html += '<div>';
  html += '<div class="card" style="padding:18px 20px;margin-bottom:14px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:14px;">Безопасность</b>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-2);">' +
      '<span style="font-size:13.5px;">Тема оформления</span>' +
      '<button class="btn btn-sm btn-ghost" data-action="toggle-theme">'+icon(getTheme()==="dark"?"sun":"moon")+(getTheme()==="dark"?"Светлая":"Тёмная")+'</button>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;">' +
      '<span style="font-size:13.5px;">Пароль</span>' +
      '<button class="btn btn-sm btn-ghost" data-action="open-change-password">Сменить пароль</button>' +
    '</div>' +
  '</div>';

  html += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:8px;">' +
      '<b style="font-size:14.5px;">Текущие сеансы</b>' +
      '<button class="btn btn-sm btn-ghost" data-action="logout-everywhere">Выйти со всех устройств</button>' +
    '</div>' +
    '<p class="hint" style="margin:0 0 12px;">С каких устройств и когда входили в аккаунт.</p>';
  if(!mySessionsLoaded){
    html += '<p style="font-size:12.5px;color:var(--muted);">Загрузка…</p>';
  } else if(!mySessionsList.length){
    html += '<p style="font-size:12.5px;color:var(--muted);">Сеансов пока нет.</p>';
  } else {
    mySessionsList.forEach(function(s){
      html += '<div style="padding:8px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="font-size:13px;">'+escapeHtml(s.device)+'</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:2px;">'+escapeHtml(s.ip||"—")+' · '+fmtDate(s.createdAt)+' '+fmtTime(s.createdAt)+'</div>' +
      '</div>';
    });
  }
  html += '</div>';
  html += '</div>';

  html += '</div>';
  return el(html);
}

function renderSettingsPage(){
  var isDark = getTheme()==="dark";
  var html = '<div style="margin-top:6px;max-width:520px;">' +
    '<div class="card" style="padding:18px 20px;">' +
      '<b style="font-size:14.5px;display:block;margin-bottom:14px;">Настройки</b>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<span style="font-size:13.5px;">Тема оформления</span>' +
        '<button class="btn btn-sm btn-ghost" data-action="toggle-theme">'+icon(isDark?"sun":"moon")+(isDark?"Светлая":"Тёмная")+'</button>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<span style="font-size:13.5px;">Пароль</span>' +
        '<button class="btn btn-sm btn-ghost" data-action="open-change-password">Сменить пароль</button>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;">' +
        '<span style="font-size:13.5px;">Активные сеансы</span>' +
        '<button class="btn btn-sm btn-ghost" data-action="logout-everywhere">Выйти со всех устройств</button>' +
      '</div>' +
    '</div>';
  html += '</div>';
  return el(html);
}

/* ============================= РЕНДЕР: ПЕРСОНАЛ ============================= */
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
  content.appendChild(el('<h1 class="section-title">'+escapeHtml(roleLabel(me.role))+'</h1>'));
  content.appendChild(renderStaffCourseSwitcher());

  if(staffState.mainTab === "courses" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderCoursesTab());
  } else if(staffState.mainTab === "team" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderTeamTab());
  } else if(staffState.mainTab === "calendar"){
    content.appendChild(renderCalendarTab());
  } else if(staffState.mainTab === "materials"){
    content.appendChild(renderMaterialsTab());
  } else if(staffState.mainTab === "dashboard"){
    content.appendChild(renderDashboardTab());
  } else if(staffState.mainTab === "protocols"){
    content.appendChild(renderProtocolsAdminTab());
  } else if(staffState.mainTab === "modules" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderModulesAdminTab());
  } else if(staffState.mainTab === "audit" && (me.role==="admin"||me.role==="super_admin")){
    content.appendChild(renderAuditLogTab());
  } else if(staffState.mainTab === "notifications"){
    content.appendChild(renderStaffNotificationsPage());
  } else if(staffState.mainTab === "settings"){
    content.appendChild(renderSettingsPage());
  } else if(staffState.mainTab === "profile"){
    content.appendChild(renderMyProfilePage());
  } else if(staffState.mainTab === "students"){
    addSideFlow(main);
    content.appendChild(renderInboxCard());
    content.appendChild(renderStaffStats());
    content.appendChild(renderCertificateQueue());
    content.appendChild(renderRoster());
  } else {
    addSideFlow(main);
    renderStaffHome(content);
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
  if(scheduleModal.open){
    wrap.appendChild(renderScheduleModal());
  }
  return wrap;
}

// У персонала пока нет отдельной системы уведомлений (в отличие от врача) — честно
// показываем то немногое, что уже можно посчитать на лету (напоминания об эфирах),
// и пустое состояние вместо выдуманной ленты.
function renderStaffNotificationsPage(){
  var reminders = upcomingEventReminders();
  var html = '<div style="margin-top:6px;max-width:760px;"><div class="card" style="padding:18px 20px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:14px;">Уведомления</b>';
  if(!reminders.length){
    html += '<div class="empty-state" style="padding:30px 10px;">У вас нет новых уведомлений.</div>';
  } else {
    reminders.forEach(function(n){
      html += '<div style="padding:12px 0;border-bottom:1px solid var(--line-2);"><b style="font-size:13.5px;">'+escapeHtml(n.title)+'</b></div>';
    });
  }
  html += '</div></div>';
  return el(html);
}

// Главная куратора/администратора: сводка по потокам в зоне ответственности,
// задачи на сегодня (переиспользует уже существующий renderInboxCard), короткие
// окна уведомлений/сообщений (как на главной врача) и дайджест-«ИИ-ассистент»
// за вчера (детерминированный шаблон из src/dailyDigest.js, не LLM-вызов —
// см. комментарий в самом dailyDigest.js).
function renderStaffHome(container){
  var totalLessons = (staffState.materials||[]).length || 1;
  var students = staffState.students || [];
  var byStream = {};
  students.forEach(function(s){
    var key = s.stream_id || "__none";
    (byStream[key] = byStream[key] || []).push(s);
  });
  var streamKeys = Object.keys(byStream);

  var streamsHtml = '<b style="font-size:14.5px;display:block;margin-bottom:10px;">Ваши потоки</b>';
  if(!streamKeys.length){
    streamsHtml += '<div class="card empty-state" style="padding:32px 20px;">' +
      '<div class="tile-icon" style="background:var(--primary-tint);color:var(--primary);margin:0 auto 12px;">'+icon("users")+'</div>' +
      '<b style="font-size:13.5px;display:block;color:var(--ink);">Врачей пока нет</b>' +
      '<p style="font-size:12.5px;margin:4px 0 0;">Как только куратор добавит первого врача в поток, здесь появится карточка с его прогрессом.</p>' +
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
            '<b style="font-size:13.5px;display:block;">'+escapeHtml(name)+'</b>' +
            '<span style="font-size:12px;color:var(--muted);">средний прогресс</span>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line-2);display:flex;align-items:baseline;gap:6px;">' +
          '<span style="font-family:var(--sans);font-weight:800;font-size:22px;" data-count="'+list.length+'">'+list.length+'</span>' +
          '<span style="font-size:12px;color:var(--muted);">врачей · '+activeCount+' активных</span>' +
        '</div>' +
      '</div>';
    });
    streamsHtml += '</div>';
  }
  container.appendChild(el('<div style="margin-top:6px;">'+streamsHtml+'</div>'));

  var inbox = staffState.inbox || {inactive:[],pendingCertificates:[]};
  var totalTasks = inbox.inactive.length + inbox.pendingCertificates.length;
  container.appendChild(el(
    '<div style="display:flex;align-items:center;gap:10px;margin:20px 0 10px;">' +
      '<div class="tile-icon" style="background:var(--status-attention-tint);color:var(--status-attention);">'+icon("clipboard")+'</div>' +
      '<b style="font-size:14.5px;">Задачи на сегодня</b>' +
    '</div>'
  ));
  if(totalTasks) container.appendChild(renderInboxCard());
  else container.appendChild(el(
    '<div class="card empty-state" style="padding:32px 20px;">' +
      '<div class="tile-icon" style="background:var(--status-active-tint);color:var(--status-active);margin:0 auto 12px;">'+icon("check")+'</div>' +
      '<b style="font-size:13.5px;display:block;color:var(--ink);">Всё разобрано</b>' +
      '<p style="font-size:12.5px;margin:4px 0 0;">Никто не ждёт ответа и не завис без активности — новые задачи появятся здесь сами.</p>' +
    '</div>'
  ));

  var reminders = upcomingEventReminders();
  var gridHtml = '<div class="grid-2" style="margin-top:20px;">';
  gridHtml += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
      '<div class="tile-icon" style="background:var(--primary-tint);color:var(--primary);">'+icon("bell")+'</div>' +
      '<b style="font-size:14px;">Уведомления</b>' +
    '</div>';
  if(!reminders.length){
    gridHtml += '<div style="display:flex;align-items:center;gap:8px;color:var(--status-active);">'+icon("check","ic-sm")+'<p style="font-size:13px;color:var(--muted);margin:0;">Ближайших эфиров и дедлайнов не запланировано — тут спокойно.</p></div>';
  } else {
    reminders.slice(0,3).forEach(function(n){
      gridHtml += '<div style="padding:8px 0;border-bottom:1px solid var(--line-2);"><b style="font-size:12.5px;display:block;">'+escapeHtml(n.title)+'</b></div>';
    });
  }
  gridHtml += '</div>';
  gridHtml += '<div class="card" style="padding:18px 20px;">' +
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
  var digestHtml = '<div class="card" style="padding:18px 20px;margin-top:20px;max-width:640px;">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
      '<div class="tile-icon" style="background:var(--status-done-tint);color:var(--status-done);">'+icon("chartbar")+'</div>' +
      '<b style="font-size:14px;">ИИ-ассистент — отчёт за вчера</b>' +
    '</div>';
  if(!d){
    digestHtml += '<div style="display:flex;align-items:center;gap:8px;color:var(--muted-2);">'+icon("clock","ic-sm")+'<p style="font-size:13px;color:var(--muted);margin:0;">Ещё не готов — соберёт итоги дня и появится здесь к 9:00 по МСК.</p></div>';
  } else {
    digestHtml += '<p style="font-size:13.5px;margin:0;line-height:1.5;">'+escapeHtml(d.summary)+'</p>';
  }
  digestHtml += '</div>';
  container.appendChild(el(digestHtml));
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
      '<div class="field" style="margin-bottom:0;min-width:220px;flex:1;"><label>Ссылка на Telegram-группу (можно позже)</label><input class="input" name="telegramUrl" type="url" placeholder="https://t.me/..."></div>' +
      '<button class="btn btn-primary" type="submit">Создать</button></form>';
  }
  if(!streams.length){
    html += '<p style="font-size:13px;color:var(--muted);margin:0;">Пока нет ни одного потока.</p>';
  } else {
    html += '<div style="display:flex;flex-wrap:wrap;gap:10px;">';
    streams.forEach(function(s){
      html += '<div class="stream-card"><b style="font-size:13.5px;display:block;">'+escapeHtml(s.name)+'</b>' +
        '<span style="font-size:12px;color:var(--muted);">старт: '+(s.start_date?fmtDate(s.start_date):"—")+' · '+(countsByStream[s.id]||0)+' врачей</span><br>' +
        (s.telegram_url
          ? '<a class="btn btn-sm btn-primary" style="margin-top:8px;display:inline-block;" href="'+escapeHtml(s.telegram_url)+'" target="_blank" rel="noopener">Открыть Telegram-группу →</a>'
          : '') +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
          '<input class="input" style="flex:1;" data-stream-telegram-input data-id="'+s.id+'" value="'+escapeHtml(s.telegram_url||"")+'" placeholder="Ссылка на Telegram-группу">' +
          '<button class="btn btn-sm btn-ghost" data-action="save-stream-telegram" data-id="'+s.id+'">Сохранить</button>' +
        '</div>' +
        '<div style="margin-top:8px;">' +
          '<button class="btn btn-sm btn-ghost" data-action="delete-stream" data-id="'+s.id+'">Удалить поток</button>' +
        '</div></div>';
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
  if(a.indexOf("access.block")===0 || a==="staff.remove" || a==="invite.cancel") return "blocked";
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
      '<b style="font-size:14.5px;">Журнал действий персонала</b>' +
      '<a class="btn btn-sm btn-ghost" href="'+auditExportUrl()+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+' Экспорт CSV</a>' +
    '</div>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:4px 0 16px;">Последние 100 действий (с учётом фильтров ниже) — экспорт выгружает те же фильтры, до 5000 строк. '+(me.role==="super_admin"?'Обратимые действия можно откатить — это вернёт состояние к тому, что было до изменения.':'')+'</p>';

  var actorOpts = auditActorOptions();
  html += '<div class="dash-filters-grid" style="margin-bottom:16px;">' +
    '<div class="dash-field" style="grid-column:span 2;"><label>Поиск</label><input class="input" id="auditSearchInput" placeholder="Кто или что" value="'+escapeHtml(auditFilters.q)+'"></div>' +
    '<div class="dash-field"><label>Действие</label><select class="input" id="auditActionFilter" style="padding:8px 9px;font-size:12.5px;">' +
      '<option value="">Все</option>' +
      auditActionsList.map(function(a){ return '<option value="'+escapeHtml(a)+'"'+(auditFilters.action===a?' selected':'')+'>'+escapeHtml(auditActionLabel(a))+'</option>'; }).join('') +
    '</select></div>' +
    '<div class="dash-field"><label>Кто</label><select class="input" id="auditActorFilter" style="padding:8px 9px;font-size:12.5px;">' +
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
      (canEdit ? '<button class="btn btn-sm btn-ghost" data-action="open-lesson-video-editor" data-id="'+l.id+'" data-title="'+escapeHtml(l.title)+'">Видео</button>' : '') +
      (canEdit ? '<button class="btn btn-sm btn-ghost" data-action="open-lesson-quiz-manager" data-id="'+l.id+'" data-title="'+escapeHtml(l.title)+'">Тест урока</button>' : '') +
      '<button class="btn btn-sm btn-ghost" data-action="open-schedule-modal" data-id="'+l.id+'" data-title="'+escapeHtml(l.title)+'">Расписание</button>' +
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
        '<span style="font-size:13.5px;font-weight:600;">Применить ко всем врачам</span></label>' +
      (!scheduleModal.applyToAll ?
        '<input class="input" id="scheduleSearch" placeholder="Поиск по имени или email" value="'+escapeHtml(scheduleModal.search)+'" style="margin-bottom:12px;">' +
        '<div style="max-height:220px;overflow-y:auto;margin-bottom:14px;">' +
        (students.length ? students.map(function(s){
          var checked = scheduleModal.selectedIds.indexOf(s.id)!==-1;
          var current = scheduleByStudent[s.id];
          return '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--line-2);cursor:pointer;">' +
            '<input type="checkbox" data-action="toggle-schedule-student" data-id="'+s.id+'"'+(checked?' checked':'')+'>' +
            '<div class="avatar" style="width:26px;height:26px;font-size:11px;">'+initials(s.name)+'</div>' +
            '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:11.5px;color:var(--muted);">'+(current?'открыт с '+fmtDate(current):'по дрипу')+'</span></div></label>';
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
  var buckets = {}, order = [];
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
    if(buckets[key]!==undefined) buckets[key]++;
  });
  return { weekly:weekly, labels:order, counts:order.map(function(k){ return buckets[k]; }) };
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
      if(answers[q.id]===q.correct) correct++; else incorrect++;
    });
    return { idx:idx, question:q.question, correct:correct, incorrect:incorrect };
  });
}

function renderVBarChart(labels, counts, weekly){
  var max = Math.max.apply(null, counts.concat([1]));
  var html = '<div class="chart-vbars">';
  counts.forEach(function(c,i){
    var h = Math.round((c/max)*100);
    html += '<div class="chart-vbar-col"><div class="chart-vbar" style="height:'+(h||1)+'%;" title="'+escapeHtml(fmtDate(labels[i]))+(weekly?' (неделя)':'')+': '+c+'"></div></div>';
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

function renderAnalyticsSection(filtered){
  var reg = analyticsRegistrationsByDay(filtered);
  var funnel = analyticsFunnel(filtered);
  var dropoff = analyticsLessonDropoff(filtered);
  var quizStats = (me.role==="admin"||me.role==="super_admin") ? analyticsQuizStats(filtered) : null;
  var regTotal = reg.counts.reduce(function(a,b){ return a+b; }, 0);

  var html = '<div class="chart-grid">';
  html += '<div class="card chart-card">' +
    '<b class="chart-card-title">Регистрации '+(reg.weekly?'по неделям':'по дням')+'</b>' +
    '<p class="chart-card-sub">Всего за период: '+regTotal+'</p>' +
    renderVBarChart(reg.labels, reg.counts, reg.weekly) +
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
  html += '</div></div>';

  html += renderAnalyticsSection(filtered);

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
        '<td>'+escapeHtml(specNames(s)||"—")+'</td>' +
        '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+escapeHtml(streamName)+'">'+escapeHtml(streamName)+'</td>' +
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
    '<b style="font-size:14.5px;display:block;margin-bottom:14px;">Требует внимания ('+total+')</b>';

  if(inbox.inactive.length){
    html += '<div class="inbox-group">'+magnet("attention","Неактивны 7+ дней");
    // Вся строка кликабельна, «Открыть» проявляется при наведении — семь одинаковых
    // кнопок подряд рябили. Дни без входа — нейтральная «таблетка» справа (без
    // красного/жёлтого: сортировка и так от самых давних).
    inbox.inactive.forEach(function(r){
      var st = (staffState.students||[]).find(function(x){ return x.id===r.id; });
      var stream = st && st.stream_id ? calendarState.streams.find(function(x){ return x.id===st.stream_id; }) : null;
      html += '<div class="inbox-row inbox-row-link" data-action="open-student" data-id="'+r.id+'">' +
        '<div class="avatar" style="'+avatarTone(r.name)+'">'+initials(r.name)+'</div>' +
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
        '<div class="avatar">'+initials(r.name)+'</div>' +
        '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+escapeHtml(r.name)+'</b><span style="font-size:12px;color:var(--muted);">тест: '+r.quiz_score+'%</span></div>' +
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
      '<b style="font-size:13.5px;display:block;margin-bottom:6px;">Массовый импорт врачей</b>' +
      '<p style="font-size:12.5px;color:var(--muted);margin:0 0 10px;">CSV с заголовком: Имя, Email, Телефон, Место работы, Специализация, Поток (последние три необязательны). Записывает сразу на курс «'+escapeHtml((staffState.coursesList.find(function(c){return c.id===staffState.activeCourseId;})||{}).title||"")+'» — переключите курс сверху, если нужен другой.</p>' +
      '<form id="importStudentsForm" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        '<input class="input" type="file" name="file" accept=".csv,.txt" required style="max-width:280px;">' +
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
        html += '<div style="margin-top:8px;">'+ir.skipped.map(function(s){ return '<div style="font-size:12.5px;color:var(--muted);">Строка '+s.row+' ('+escapeHtml(s.email||"—")+'): '+escapeHtml(s.reason)+'</div>'; }).join("")+'</div>';
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
    html += '<div style="overflow-x:auto;"><table class="roster"><thead><tr><th style="width:32px;"><input type="checkbox" data-action="select-all-students"'+(allSelected?' checked':'')+'></th><th>Врач</th><th>Прогресс</th><th>Тест</th><th>Статус</th><th>Поток</th><th>Была в сети</th><th>Регистрация</th><th></th></tr></thead><tbody>';
    students.forEach(function(s){
      var done = (s.completed_lessons||[]).length;
      var isChecked = staffState.selectedIds.indexOf(s.id)!==-1;
      var status = s.completed ? magnet("done","Завершил") : (done>0 ? magnet("active","В процессе") : magnet("neutral","Новый"));
      html += '<tr>' +
        '<td><input type="checkbox" data-action="select-student" data-id="'+s.id+'"'+(isChecked?' checked':'')+'></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;"><div class="who-cell"><div class="avatar-wrap"><div class="avatar">'+initials(s.name)+'</div>'+(s.online?'<span class="presence-dot" title="Онлайн"></span>':'')+'</div><div><b>'+escapeHtml(s.name)+'</b><span>'+escapeHtml(specNames(s)||"—")+'</span></div></div></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+done+'/5</td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+(typeof s.quiz_score==="number"?s.quiz_score+'%':'—')+'</td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+status+'</td>' +
        '<td><select class="input" style="font-size:12.5px;padding:5px 8px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" data-stream-select data-id="'+s.id+'">'+buildStreamOptions(s.stream_id||"", "Без потока")+'</select></td>' +
        '<td data-action="open-student" data-id="'+s.id+'" style="cursor:pointer;">'+(s.online?magnet("active","В сети"):'<span style="color:var(--muted);font-size:12.5px;">'+escapeHtml(timeSince(s.last_seen_at))+'</span>')+'</td>' +
        '<td style="color:var(--muted);">'+fmtDate(s.created_at)+'</td>' +
        '<td style="text-align:right;"><button class="btn btn-sm btn-ghost" data-action="open-student" data-id="'+s.id+'">Открыть →</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  return el(html);
}

/* ============================= РЕНДЕР: ПРОТОКОЛЫ (АДМИН) ============================= */
// Специализации — фиксированный справочник (см. schema.sql «Этап 11»): отсюда админ
// им управляет, отсюда же их читают форма регистрации и профиль врача.
function renderSpecializationsCard(){
  var html = '<div class="card" style="padding:18px 20px;margin-bottom:16px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Специализации</b>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:0 0 14px;">Справочник, из которого врач выбирает специализацию при регистрации — на нём же основан подбор протоколов.</p>';
  specializationsList.forEach(function(s){
    html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-2);">' +
      '<span style="flex:1;font-size:13.5px;">'+escapeHtml(s.name)+'</span>' +
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

// Модули курса (admin/super_admin) — группировка уроков, у каждого модуля свой
// итоговый тест (staffState.quizAdmin-подобный список, свой набор вопросов) и
// свои отзывы врачей. Привязка урока к модулю — просто смена module_id урока,
// поэтому «добавление» урока в один модуль автоматически убирает его из другого.
function renderModulesAdminTab(){
  var html = '<div class="card" style="padding:18px 20px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Модули курса</b>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:0 0 14px;">Группа уроков — например, 8 подряд. По прохождении всех уроков модуля врачу показывается итоговый тест модуля (если вы его добавили) и короткий обязательный отзыв.</p>' +
    '<form id="moduleCreateForm" style="display:flex;gap:8px;">' +
      '<input class="input" name="title" placeholder="Название модуля" required style="flex:1;">' +
      '<button class="btn btn-sm btn-primary" type="submit">Добавить модуль</button>' +
    '</form>' +
  '</div>';

  if(!moduleManagerState.modules.length){
    html += '<div class="empty-state" style="padding:30px 10px;">Модулей пока нет — уроки идут одним общим списком, без гейта после них.</div>';
  } else {
    moduleManagerState.modules.forEach(function(m){
      var lessonsInModule = moduleManagerState.allLessons.filter(function(l){ return l.moduleId===m.id; });
      var availableLessons = moduleManagerState.allLessons.filter(function(l){ return l.moduleId!==m.id; });
      var avgLabel = m.feedback.average!==null ? ' · ★'+m.feedback.average.toFixed(1) : '';
      html += '<div class="card" style="padding:14px 16px;margin-top:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">' +
          '<b style="font-size:13.5px;">'+escapeHtml(m.title)+'</b>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button class="btn btn-sm btn-ghost" data-action="open-module-quiz-manager" data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'">Тест ('+m.quizCount+')</button>' +
            '<button class="btn btn-sm btn-ghost" data-action="open-module-feedback-viewer" data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'">Отзывы ('+m.feedback.count+avgLabel+')</button>' +
            '<button class="btn btn-sm btn-ghost" data-action="rename-module" data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'" title="Переименовать">'+icon("gear","ic-sm")+'</button>' +
            '<button class="btn btn-sm btn-ghost" data-action="delete-module" data-id="'+m.id+'" data-title="'+escapeHtml(m.title)+'" title="Удалить">'+icon("trash","ic-sm")+'</button>' +
          '</div>' +
        '</div>';
      if(!lessonsInModule.length){
        html += '<p class="hint" style="margin:0 0 8px;">В модуле пока нет уроков.</p>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">';
        lessonsInModule.forEach(function(l){
          html += '<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line-2);">' +
            '<span style="flex:1;">'+escapeHtml(l.title)+'</span>' +
            '<button class="btn btn-sm btn-ghost" data-action="unassign-module-lesson" data-id="'+l.id+'" title="Убрать из модуля">'+icon("trash","ic-sm")+'</button>' +
          '</div>';
        });
        html += '</div>';
      }
      if(availableLessons.length){
        html += '<div style="display:flex;gap:8px;align-items:center;">' +
          '<select class="input" id="addLessonSelect-'+m.id+'" style="flex:1;">' +
            availableLessons.map(function(l){ return '<option value="'+l.id+'">'+escapeHtml(l.title)+(l.moduleId?' (сейчас в другом модуле)':'')+'</option>'; }).join('') +
          '</select>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="assign-module-lesson" data-module-id="'+m.id+'">Добавить урок</button>' +
        '</div>';
      }
      html += '</div>';
    });
  }
  return el('<div>'+html+'</div>');
}

function renderProtocolsAdminTab(){
  var isProtocolAdmin = me.role==="admin" || me.role==="super_admin";
  var html = isProtocolAdmin ? renderSpecializationsCard() : '';
  html += '<div class="card" style="padding:18px 20px;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:10px;">' +
      '<b style="font-size:14.5px;">Протоколы</b>' +
      (isProtocolAdmin ? '<button class="btn btn-sm btn-primary" data-action="open-protocol-creator">+ Добавить протокол</button>' : '') +
    '</div>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:0 0 14px;">Разблокируются врачу после прохождения привязанных уроков — с гайдом применения под его специализацию (см. «Ваши протоколы» у врача).'+(isProtocolAdmin?'':' Вы можете редактировать текст гайдов и прикладывать к ним файлы.')+'</p>';
  if(!adminProtocolsState.list.length){
    html += '<div class="empty-state" style="padding:30px 10px;">Протоколов пока нет.</div>';
  } else {
    adminProtocolsState.list.forEach(function(p){
      html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2);">' +
        '<div style="flex:1;"><b style="font-size:13.5px;display:block;">'+escapeHtml(p.title)+'</b>' +
          '<span style="font-size:12px;color:var(--muted);">'+p.guides.length+' гайд(ов) · '+p.lessonIds.length+' урок(ов) открывают</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-action="open-protocol-editor" data-id="'+p.id+'">Редактировать</button>' +
        (isProtocolAdmin ? '<button class="btn btn-sm btn-ghost" data-action="delete-protocol" data-id="'+p.id+'" data-title="'+escapeHtml(p.title)+'" title="Удалить">'+icon("trash","ic-sm")+'</button>' : '') +
      '</div>';
    });
  }
  html += '</div>';
  return el('<div>'+html+'</div>');
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
  return el('<div class="overlay" data-action="overlay-close-specialization-editor"><div class="drawer" data-stop="1" style="width:min(420px,100%);">'+body+'</div></div>');
}

function renderProtocolGuideFiles(g){
  var html = '<div style="margin-top:10px;">';
  (g.files||[]).forEach(function(f){
    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line-2);">' +
      '<a href="'+f.url+'" target="_blank" rel="noopener" style="flex:1;font-size:12.5px;display:flex;align-items:center;gap:6px;min-width:0;color:var(--primary);text-decoration:underline;">'+icon("folder","ic-sm")+'<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escapeHtml(f.originalName)+'</span></a>' +
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
    body += '<b style="font-size:14.5px;display:block;">'+escapeHtml(protocolEditor.title)+'</b>' +
      (protocolEditor.summary ? '<p style="font-size:12.5px;color:var(--muted);margin:6px 0 0;">'+escapeHtml(protocolEditor.summary)+'</p>' : '');
  }

  if(!isNew){
    body += '<div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line-2);">' +
      '<b style="font-size:13.5px;display:block;margin-bottom:10px;">Гайды по специализациям</b>';
    protocolEditor.guides.forEach(function(g){
      body += '<div class="card" style="padding:12px 14px;margin-bottom:8px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b style="font-size:13px;">'+escapeHtml(g.specializationName)+'</b>' +
          '<button class="btn btn-sm btn-ghost" data-action="delete-protocol-guide" data-spec="'+g.specializationId+'" title="Удалить гайд">'+icon("trash","ic-sm")+'</button></div>' +
        (g.guideHtml ? '<div class="prose" style="font-size:12.5px;">'+renderPlainToProse(g.guideHtml)+'</div>' : '<p class="hint" style="margin:0;">Текста пока нет — только файлы.</p>') +
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
        '<b style="font-size:13.5px;display:block;margin-bottom:10px;">Какие уроки открывают этот протокол</b>';
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
  var html = '<div class="grid-2" style="align-items:flex-start;">';

  html += '<div class="card" style="padding:18px 20px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Курсы</b>';
  if(!staffState.coursesList.length){
    html += '<div class="empty-state" style="padding:30px 10px;">Курсов пока нет.</div>';
  }
  staffState.coursesList.forEach(function(c){
    var isEditing = staffState.courseEditorId === c.id;
    var isDeleting = staffState.courseDeleteConfirmId === c.id;
    html += '<div style="padding:12px 0;border-bottom:1px solid var(--line-2);">';
    if(isEditing){
      html += '<div class="field"><label>Название</label><input class="input" id="courseEditTitleInput" value="'+escapeHtml(staffState.courseEditorTitle)+'"></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0;">' +
          '<input type="checkbox" id="courseEditCertsInput"'+(staffState.courseEditorCertsEnabled?' checked':'')+'> Выдавать сертификаты по этому курсу</label>' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn-sm btn-primary" data-action="save-course">Сохранить</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="cancel-edit-course">Отмена</button>' +
        '</div>';
    } else if(isDeleting){
      html += '<p style="font-size:13px;margin:0 0 8px;">Удалить курс «'+escapeHtml(c.title)+'» безвозвратно вместе со всеми уроками, тестами и прогрессом '+c.enrolledCount+' врачей? Наберите название курса, чтобы подтвердить.</p>' +
        '<input class="input" id="courseDeleteConfirmInput" placeholder="'+escapeHtml(c.title)+'" style="margin-bottom:8px;">' +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn-sm btn-ghost" style="color:var(--danger);" data-action="confirm-delete-course" data-id="'+c.id+'">Удалить курс</button>' +
          '<button class="btn btn-sm btn-ghost" data-action="cancel-delete-course">Отмена</button>' +
        '</div>';
    } else {
      html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:160px;"><b style="font-size:13.8px;display:block;">'+escapeHtml(c.title)+'</b>' +
          '<span style="font-size:12px;color:var(--muted);">'+c.enrolledCount+' '+ruPluralClient(c.enrolledCount,"врач","врача","врачей")+' · сертификаты: '+(c.certificatesEnabled?"включены":"выключены")+'</span></div>' +
        '<button class="btn btn-sm btn-ghost" data-action="edit-course-open" data-id="'+c.id+'">Изменить</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="delete-course-open" data-id="'+c.id+'">Удалить</button>' +
      '</div>';
    }
    html += '</div>';
  });
  html += '</div>';

  html += '<div class="card" style="padding:18px 20px;">' +
    '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Новый курс</b>' +
    '<form id="createCourseForm">' +
      '<div class="field"><label>Название</label><input class="input" name="title" required></div>' +
      '<button class="btn btn-primary btn-block" type="submit">Создать</button>' +
    '</form>' +
  '</div></div>';
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
    if(staffState.inviteCode){
      html += '<b style="font-size:14.5px;display:block;margin-bottom:4px;">Код сотрудника</b>' +
        '<p style="font-size:12.5px;color:var(--muted);margin:0 0 10px;">Продиктуйте его отдельно (не тем же письмом, где email) тому, кого приглашаете куратором или администратором, — без этого кода регистрация по приглашению останется обычным врачом.</p>' +
        '<div style="font-size:22px;font-weight:700;letter-spacing:3px;font-family:monospace;padding:10px 14px;background:var(--surface-2);border-radius:var(--radius-s);display:inline-block;">'+escapeHtml(staffState.inviteCode.code)+'</div>' +
        '<p class="hint" style="margin-top:8px;">Действует до '+fmtDate(staffState.inviteCode.expiresAt)+', '+fmtTime(staffState.inviteCode.expiresAt)+' — потом перевыпустится сам при следующем заходе сюда.</p>' +
        '<hr style="border:none;border-top:1px solid var(--line-2);margin:16px 0;">';
    }
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
    '<div style="display:flex;gap:12px;align-items:center;"><div class="avatar-wrap"><div class="avatar" style="width:42px;height:42px;font-size:15px;">'+initials(s.name)+'</div>'+(s.online?'<span class="presence-dot" title="Онлайн"></span>':'')+'</div>' +
    '<div><b style="font-size:16px;display:block;">'+escapeHtml(s.name)+'</b><span style="font-size:13px;color:var(--muted);">'+escapeHtml(specNames(s)||"—")+'</span>' +
    '<span style="font-size:12px;color:var(--muted-2);display:block;margin-top:2px;">'+(s.online?'<span style="color:var(--status-active);font-weight:600;">● В сети сейчас</span>':'Была в сети: '+escapeHtml(timeSince(s.last_seen_at)))+'</span></div></div>' +
    '<button class="btn btn-ghost btn-sm" data-action="close-drawer">Закрыть ✕</button></div>';

  var body = '<div class="drawer-body">' +
    '<div class="tabs"><button class="tab'+(staffState.drawerTab==="progress"?' active':'')+'" data-action="drawer-tab" data-tab="progress">Прогресс</button>' +
    '<button class="tab'+(staffState.drawerTab==="access"?' active':'')+'" data-action="drawer-tab" data-tab="access">Доступ</button>' +
    '<button class="tab'+(staffState.drawerTab==="profile"?' active':'')+'" data-action="drawer-tab" data-tab="profile">Профиль</button>' +
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
    body += '<div class="progress-label">'+done+' из 5 уроков'+(typeof s.quiz_score==="number"?' · тест: '+s.quiz_score+'%':'')+'</div>';
    if(s.completed){
      if(staffState.certificatesEnabled){
        body += '<div class="card" style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
          '<b style="font-size:13.5px;">Сертификат: '+(s.certificate_status==="issued"?"выдан":"ожидает выдачи")+'</b>' +
          (s.certificate_status==="issued"
            ? '<a class="btn btn-sm btn-ghost" href="api/staff/students/'+s.id+'/certificate/download?courseId='+encodeURIComponent(staffState.activeCourseId||"")+'" target="_blank" rel="noopener">'+icon("download","ic-sm")+' Скачать PDF</a>'
            : '<button class="btn btn-sm btn-primary" data-action="issue-certificate" data-id="'+s.id+'">Выдать сертификат</button>') +
        '</div>';
      } else {
        body += '<div class="card" style="padding:14px 16px;">' +
          '<b style="font-size:13.5px;">Демо-курс пройден · тест '+s.quiz_score+'%</b>' +
          '<p style="font-size:12.5px;color:var(--muted);margin:4px 0 0;">Сертификаты на демо-курсе не выдаются.</p>' +
        '</div>';
      }
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
    body += '<div class="field"><label>Имя и фамилия</label><input class="input" id="studentProfileName" value="'+escapeHtml(staffState.editName)+'"></div>' +
      renderSpecPicker("staff-current", "Текущая специализация", null, staffState.editSpecializationIds) +
      '<div class="field"><label>Email</label><div class="input" style="background:var(--line-2);">'+escapeHtml(s.email||"—")+'</div></div>' +
      '<div class="field"><label>Телефон</label><input class="input" id="studentProfilePhone" value="'+escapeHtml(staffState.editPhone)+'"></div>' +
      '<div class="field"><label>Место работы</label><input class="input" id="studentProfileWorkplace" value="'+escapeHtml(staffState.editWorkplace)+'"></div>' +
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

// Общая точка входа для переключения раздела врача — используется и прямыми
// ссылками внутри страниц (data-action="student-tab"), и боковой навигацией
// (sidebar-nav), поэтому navKey передаётся отдельно от tab: два пункта меню
// («Поиск» и «Материалы обучения») ведут на один и тот же tab="materials",
// но должны подсвечиваться в сайдбаре по-разному.
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

/* ============================= СОБЫТИЯ ============================= */
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
    if(e.target.closest('[data-action="wysiwyg-cmd"]')) e.preventDefault();
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
    var t = e.target.closest("[data-action]");
    if(!t) return;
    var action = t.getAttribute("data-action");

    if(action==="go-register"){ view="register"; registerDraft={name:"",email:"",phone:"",password:"",staffInviteCode:"",specializationIds:[],interestIds:[]}; specPickerOpen=null; render(); return; }
    if(action==="go-login"){ view="login"; render(); return; }
    if(action==="logout"){ stopNotificationPolling(); stopHeartbeat(); sendOfflineBeacon(); await api("/auth/logout", { method:"POST" }); me=null; course=null; view="login"; mySessionsList=[]; mySessionsLoaded=false; studentProtocols={forYou:[],additional:[]}; protocolExpanded={}; protocolGuideTab={}; render(); return; }
    if(action==="toggle-theme"){ toggleTheme(); render(); return; }
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
    if(action==="toggle-mobile-nav"){ mobileNavOpen = !mobileNavOpen; render(); return; }
    if(action==="close-mobile-nav"){ mobileNavOpen = false; render(); return; }
    if(action==="sidebar-nav"){
      mobileNavOpen = false;
      var navKey = t.getAttribute("data-key");
      if(navKey==="messages" || navKey==="chats"){
        telegramModal.open = true;
        render();
        return;
      }
      if(navKey==="profile"){
        if(view==="student"){ studentState.tab="profile"; studentState.navKey="profile"; }
        else { staffState.mainTab="profile"; staffState.navKey="profile"; }
        profileEditor.name=me.name||""; profileEditor.phone=me.phone||""; profileEditor.workplace=me.workplace||"";
        profileEditor.specializationIds=(me.specializationIds||[]).slice();
        profileEditor.interestIds=(me.interestIds||[]).slice();
        specPickerOpen=null;
        render();
        loadMySessions().then(render);
        return;
      }
      if(view==="student"){
        if(navKey==="search"){ studentState.materialsAutoFocus=true; await applyStudentTab("materials","search"); return; }
        if(navKey==="materials"){ studentState.materialsAutoFocus=false; await applyStudentTab("materials","materials"); return; }
        await applyStudentTab(navKey, navKey);
        return;
      }
      staffState.navKey = navKey;
      staffState.mainTab = navKey;
      render();
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
      previewMode = true; previewReturnTab = staffState.mainTab;
      try{ course = await api("/staff/course-preview"+(staffState.activeCourseId?"?courseId="+encodeURIComponent(staffState.activeCourseId):"")); }
      catch(err){ showToast(err.message); previewMode=false; return; }
      studentState = { tab:"course", navKey:"course", lessonIndex:0, quizMode:false, quizSubmitted:false,
        lessonStage:"intro", videoEnded:false, lessonQuizAnswers:{}, lessonQuizResult:null };
      view = "student";
      render(); return;
    }
    if(action==="exit-preview"){
      previewMode = false; course = null; view = "staff";
      staffState.mainTab = previewReturnTab || "students";
      staffState.navKey = staffState.mainTab;
      render(); return;
    }
    if(action==="open-student"){
      staffState.selectedStudentId=t.getAttribute("data-id"); staffState.drawerTab="progress"; staffState.selectedStudent=null; staffState.notes=[]; render();
      try{
        var cqOpen=staffState.activeCourseId?"?courseId="+encodeURIComponent(staffState.activeCourseId):"";
        var d=await api("/staff/students/"+staffState.selectedStudentId+cqOpen);
        staffState.selectedStudent=d.student;
        staffState.selectedStudentEnrollments=d.enrollments||[];
        staffState.editSpecializationIds=(d.student.specialization_ids||[]).slice();
        staffState.editName=d.student.name||""; staffState.editPhone=d.student.phone||""; staffState.editWorkplace=d.student.workplace||"";
        render();
      }catch(err){ showToast(err.message); }
      return;
    }
    if(action==="close-drawer" || (action==="overlay-close" && !e.target.closest("[data-stop]"))){ staffState.selectedStudentId=null; render(); return; }
    if(action==="drawer-tab"){
      staffState.drawerTab=t.getAttribute("data-tab"); render();
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
        await loadStaffData();
        render();
      }
      return;
    }
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
      if(wHidden) wHidden.value = wTarget.innerHTML;
      return;
    }
    if(action==="delete-lesson"){
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
      quizEditor = { open:true, isNew:false, id:q.id, question:q.question, options:q.options.slice(), correct:q.correct, lessonId:null, moduleId:null };
      render(); return;
    }
    if(action==="open-quiz-creator"){
      quizEditor = { open:true, isNew:true, id:null, question:"", options:["",""], correct:0, lessonId:null, moduleId:null };
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
      var mqIds=staffState.quizAdmin.map(function(x){ return x.id; });
      var mqIdx=mqIds.indexOf(mqId);
      var mqSwap = mqDir==="up" ? mqIdx-1 : mqIdx+1;
      if(mqIdx===-1 || mqSwap<0 || mqSwap>=mqIds.length) return;
      var tmpq=mqIds[mqIdx]; mqIds[mqIdx]=mqIds[mqSwap]; mqIds[mqSwap]=tmpq;
      try{ await api("/course/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: mqIds }) }); await loadStaffData(); }
      catch(err){ showToast(err.message); }
      render(); return;
    }

    /* ---------- Видео урока ---------- */
    if(action==="open-lesson-video-editor"){
      videoEditor = { open:true, lessonId:t.getAttribute("data-id"), lessonTitle:t.getAttribute("data-title"), videoUrl:"", timecodes:[], uploadProgress:null };
      render();
      try{
        var lv=await api("/course/lessons/"+videoEditor.lessonId);
        videoEditor.videoUrl = lv.lesson.video_url || "";
        videoEditor.timecodes = lv.lesson.video_timecodes || [];
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="close-video-editor"){ videoEditor.open=false; render(); return; }
    if(action==="overlay-close-video-editor" && !e.target.closest("[data-stop]")){ videoEditor.open=false; render(); return; }
    if(action==="upload-lesson-video"){
      var vfInput = document.getElementById("videoFileInput");
      if(!vfInput || !vfInput.files || !vfInput.files[0]){ showToast("Выберите файл"); return; }
      var vfFile = vfInput.files[0];
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
        videoEditor.videoUrl = vur.videoUrl;
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
    if(action==="open-lesson-quiz-manager"){
      lessonQuizManager = { open:true, lessonId:t.getAttribute("data-id"), lessonTitle:t.getAttribute("data-title"), questions:[] };
      render();
      try{ var lqm=await api("/course/lessons/"+lessonQuizManager.lessonId+"/quiz-admin"); lessonQuizManager.questions=lqm.quiz; }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="close-lesson-quiz-manager"){ lessonQuizManager.open=false; render(); return; }
    if(action==="overlay-close-lesson-quiz-manager" && !e.target.closest("[data-stop]")){ lessonQuizManager.open=false; render(); return; }
    if(action==="open-lesson-quiz-creator"){
      quizEditor = { open:true, isNew:true, id:null, question:"", options:["",""], correct:0, lessonId:lessonQuizManager.lessonId, moduleId:null };
      render(); return;
    }
    if(action==="open-lesson-quiz-editor"){
      var lq=lessonQuizManager.questions.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!lq) return;
      quizEditor = { open:true, isNew:false, id:lq.id, question:lq.question, options:lq.options.slice(), correct:lq.correct, lessonId:lessonQuizManager.lessonId, moduleId:null };
      render(); return;
    }
    if(action==="move-lesson-quiz-question"){
      var lmIdx=parseInt(t.getAttribute("data-idx"),10); var lmDir=t.getAttribute("data-dir");
      var lmIds=lessonQuizManager.questions.map(function(x){ return x.id; });
      var lmSwap = lmDir==="up" ? lmIdx-1 : lmIdx+1;
      if(lmSwap<0 || lmSwap>=lmIds.length) return;
      var tmpl=lmIds[lmIdx]; lmIds[lmIdx]=lmIds[lmSwap]; lmIds[lmSwap]=tmpl;
      try{
        await api("/course/lessons/"+lessonQuizManager.lessonId+"/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: lmIds }) });
        var lmd=await api("/course/lessons/"+lessonQuizManager.lessonId+"/quiz-admin"); lessonQuizManager.questions=lmd.quiz;
      }catch(err){ showToast(err.message); }
      render(); return;
    }

    /* ---------- Модули курса ---------- */
    if(action==="rename-module"){
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
    if(action==="assign-module-lesson"){
      var amModuleId=t.getAttribute("data-module-id");
      var amSelect=document.getElementById("addLessonSelect-"+amModuleId);
      if(!amSelect || !amSelect.value) return;
      try{ await api("/course/lessons/"+amSelect.value+"/module", { method:"PUT", body: JSON.stringify({ moduleId: amModuleId }) }); await loadStaffData(); showToast("Урок добавлен в модуль"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="unassign-module-lesson"){
      try{ await api("/course/lessons/"+t.getAttribute("data-id")+"/module", { method:"PUT", body: JSON.stringify({ moduleId: null }) }); await loadStaffData(); showToast("Урок убран из модуля"); }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="open-module-quiz-manager"){
      moduleQuizManager = { open:true, moduleId:t.getAttribute("data-id"), moduleTitle:t.getAttribute("data-title"), questions:[] };
      render();
      try{ var mqm=await api("/course/modules/"+moduleQuizManager.moduleId+"/quiz-admin"); moduleQuizManager.questions=mqm.quiz; }
      catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="close-module-quiz-manager"){ moduleQuizManager.open=false; render(); return; }
    if(action==="overlay-close-module-quiz-manager" && !e.target.closest("[data-stop]")){ moduleQuizManager.open=false; render(); return; }
    if(action==="open-module-quiz-creator"){
      quizEditor = { open:true, isNew:true, id:null, question:"", options:["",""], correct:0, lessonId:null, moduleId:moduleQuizManager.moduleId };
      render(); return;
    }
    if(action==="open-module-quiz-editor"){
      var mq=moduleQuizManager.questions.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!mq) return;
      quizEditor = { open:true, isNew:false, id:mq.id, question:mq.question, options:mq.options.slice(), correct:mq.correct, lessonId:null, moduleId:moduleQuizManager.moduleId };
      render(); return;
    }
    if(action==="move-module-quiz-question"){
      var mmIdx=parseInt(t.getAttribute("data-idx"),10); var mmDir=t.getAttribute("data-dir");
      var mmIds=moduleQuizManager.questions.map(function(x){ return x.id; });
      var mmSwap = mmDir==="up" ? mmIdx-1 : mmIdx+1;
      if(mmSwap<0 || mmSwap>=mmIds.length) return;
      var tmpm=mmIds[mmIdx]; mmIds[mmIdx]=mmIds[mmSwap]; mmIds[mmSwap]=tmpm;
      try{
        await api("/course/modules/"+moduleQuizManager.moduleId+"/quiz-admin/reorder", { method:"PUT", body: JSON.stringify({ orderedIds: mmIds }) });
        var mmd=await api("/course/modules/"+moduleQuizManager.moduleId+"/quiz-admin"); moduleQuizManager.questions=mmd.quiz;
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(action==="open-module-feedback-viewer"){
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
      protocolEditor = { open:true, id:null, title:"", summary:"", guides:[], lessonIds:[] };
      render(); return;
    }
    if(action==="open-protocol-editor"){
      var pe=adminProtocolsState.list.find(function(x){ return x.id===t.getAttribute("data-id"); });
      if(!pe) return;
      protocolEditor = { open:true, id:pe.id, title:pe.title, summary:pe.summary||"", guides:pe.guides.slice(), lessonIds:pe.lessonIds.slice() };
      render(); return;
    }
    if(action==="close-protocol-editor"){ protocolEditor.open=false; render(); return; }
    if(action==="overlay-close-protocol-editor" && !e.target.closest("[data-stop]")){ protocolEditor.open=false; render(); return; }
    if(action==="delete-protocol"){
      askConfirm({
        title: 'Удалить протокол «'+t.getAttribute("data-title")+'»?',
        body: "Вместе с ним удалятся все его гайды и привязки к урокам.",
        confirmLabel: "Удалить", danger: true,
        onConfirm: async function(){
          try{ await api("/protocols/"+t.getAttribute("data-id"), { method:"DELETE" }); adminProtocolsState.list=adminProtocolsState.list.filter(function(p){ return p.id!==t.getAttribute("data-id"); }); showToast("Протокол удалён"); }
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
    if(action==="save-stream-telegram"){
      var stId=t.getAttribute("data-id");
      var stInp=root.querySelector('[data-stream-telegram-input][data-id="'+stId+'"]');
      var stUrl=stInp?stInp.value.trim():"";
      try{
        await api("/streams/"+stId, { method:"PATCH", body: JSON.stringify({ telegramUrl: stUrl }) });
        var stObj=calendarState.streams.find(function(s){ return s.id===stId; });
        if(stObj) stObj.telegram_url = stUrl || null;
        showToast("Ссылка сохранена");
      }catch(err){ showToast(err.message); }
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

    if(action==="open-telegram-modal"){ telegramModal.open=true; render(); return; }
    if(action==="close-telegram-modal"){ telegramModal.open=false; render(); return; }
    if(action==="overlay-close-telegram-modal" && !e.target.closest("[data-stop]")){ telegramModal.open=false; render(); return; }
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

    if(action==="open-schedule-modal"){
      var schLessonId=t.getAttribute("data-id");
      scheduleModal = { open:true, lessonId:schLessonId, lessonTitle:t.getAttribute("data-title"), search:"", selectedIds:[], applyToAll:true, unlockDate:"", schedule:[] };
      render();
      try{ var sch=await api("/course/lessons/"+schLessonId+"/schedule"); scheduleModal.schedule=sch.schedule; render(); }catch(err){ showToast(err.message); }
      return;
    }
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
          staffInviteCode:registerDraft.staffInviteCode,
          interestIds: registerDraft.interestIds
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
    if(e.target.id==="quizEditorForm"){
      e.preventDefault();
      var fdqe=new FormData(e.target);
      var errQe=document.getElementById("quizEditorError"); errQe.style.display="none";
      var btnQe=e.target.querySelector("button[type=submit]"); btnQe.disabled=true; btnQe.textContent="Сохраняем…";
      var opts=quizEditor.options.map(function(_,i){ return fdqe.get("opt"+i); });
      var correctVal=parseInt(fdqe.get("correct"),10);
      var isLessonQuiz = !!quizEditor.lessonId;
      var isModuleQuiz = !!quizEditor.moduleId;
      try{
        if(quizEditor.isNew){
          var createUrl = isLessonQuiz ? "/course/lessons/"+quizEditor.lessonId+"/quiz-admin"
            : isModuleQuiz ? "/course/modules/"+quizEditor.moduleId+"/quiz-admin"
            : "/course/quiz-admin";
          var qBody = { question:fdqe.get("question"), options:opts, correct:correctVal };
          if(!isLessonQuiz && !isModuleQuiz) qBody.courseId = staffState.activeCourseId;
          await api(createUrl, { method:"POST", body: JSON.stringify(qBody) });
          quizEditor.open=false; showToast("Вопрос добавлен");
        } else {
          await api("/course/quiz-admin/"+quizEditor.id, { method:"PUT", body: JSON.stringify({ question:fdqe.get("question"), options:opts, correct:correctVal }) });
          var qi=staffState.quizAdmin.find(function(x){return x.id===quizEditor.id;});
          if(qi){ qi.question=fdqe.get("question"); qi.options=opts; qi.correct=correctVal; }
          quizEditor.open=false; showToast("Вопрос сохранён");
        }
        if(isLessonQuiz){
          var lqRefresh=await api("/course/lessons/"+quizEditor.lessonId+"/quiz-admin"); lessonQuizManager.questions=lqRefresh.quiz;
        } else if(isModuleQuiz){
          var mqRefresh=await api("/course/modules/"+quizEditor.moduleId+"/quiz-admin"); moduleQuizManager.questions=mqRefresh.quiz;
          await loadStaffData(); // обновить счётчик вопросов у карточки модуля
        } else {
          await loadStaffData();
        }
      }catch(err){ errQe.textContent=err.message; errQe.style.display="block"; btnQe.disabled=false; btnQe.textContent="Сохранить вопрос"; }
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
        var r3=await api("/course/quiz-submit", { method:"POST", body: JSON.stringify({answers:answers, courseId:activeCourseId}) });
        course.progress.quiz_score=r3.score; course.progress.completed=r3.completed; course.progress.certificate_status=r3.certificateStatus;
        await loadCourse(); // очки/стрик пересчитываются на сервере из всего прогресса разом — проще перезагрузить, чем дублировать формулу на клиенте
        studentState.quizSubmitted=true;
      }catch(err){ showToast(err.message); }
      render(); return;
    }
    if(e.target.id==="lessonQuizForm"){
      e.preventDefault();
      var lqLessonId = e.target.getAttribute("data-lesson-id");
      var lqLesson = course.lessons.find(function(l){ return l.id===lqLessonId; });
      var fdlq=new FormData(e.target); var lqAnswers={};
      (lqLesson.quiz||[]).forEach(function(q){ lqAnswers[q.id]=parseInt(fdlq.get(q.id),10); });
      var btnlq=e.target.querySelector("button[type=submit]"); btnlq.disabled=true; btnlq.textContent="Считаем результат…";
      var wasProtoAvailLQ = protocolsSectionAvailable();
      if(previewMode){
        studentState.lessonQuizResult={ score:100 };
        if(course.progress.completed_lessons.indexOf(lqLessonId)===-1) course.progress.completed_lessons.push(lqLessonId);
        maybeCelebrateProtocolsUnlock(wasProtoAvailLQ);
        render(); return;
      }
      try{
        var rlq = await api("/course/lessons/"+lqLessonId+"/quiz-submit", { method:"POST", body: JSON.stringify({ answers: lqAnswers }) });
        course.progress.completed_lessons = rlq.completedLessons;
        if(rlq.gamification) course.gamification = Object.assign({}, course.gamification, rlq.gamification);
        if(!course.progress.lesson_quiz_scores) course.progress.lesson_quiz_scores={};
        course.progress.lesson_quiz_scores[lqLessonId]=rlq.score;
        studentState.lessonQuizResult = { score: rlq.score };
        maybeCelebrateProtocolsUnlock(wasProtoAvailLQ);
      }catch(err){ showToast(err.message); btnlq.disabled=false; btnlq.textContent="Завершить тест"; return; }
      render(); return;
    }
    if(e.target.id==="moduleQuizForm"){
      e.preventDefault();
      var mqModuleId = e.target.getAttribute("data-module-id");
      var mqModule = (course.modules||[]).find(function(m){ return m.id===mqModuleId; });
      var fdmq=new FormData(e.target); var mqAnswers={};
      (mqModule.quiz||[]).forEach(function(q){ mqAnswers[q.id]=parseInt(fdmq.get(q.id),10); });
      var btnmq=e.target.querySelector("button[type=submit]"); btnmq.disabled=true; btnmq.textContent="Считаем результат…";
      if(previewMode){ studentState.moduleQuizResult={ score:100 }; render(); return; }
      try{
        var rmq = await api("/course/modules/"+mqModuleId+"/quiz-submit", { method:"POST", body: JSON.stringify({ answers: mqAnswers }) });
        if(!course.progress.module_quiz_scores) course.progress.module_quiz_scores={};
        course.progress.module_quiz_scores[mqModuleId]=rmq.score;
        studentState.moduleQuizResult = { score: rmq.score };
      }catch(err){ showToast(err.message); btnmq.disabled=false; btnmq.textContent="Завершить тест"; return; }
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
        staffState.activeCourseId=newC.id;
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
      if(hidden) hidden.value = e.target.innerHTML;
    }
  });
}

// Esc закрывает открытую модалку/дровер — раньше работало только по клику на
// подложку или на «Закрыть», без единого глобального обработчика клавиатуры.
// Порядок проверки — от заведомо самого верхнего слоя (confirmState монтируется
// последним) к самому нижнему, чтобы Esc закрывал именно то, что видно сверху.
document.addEventListener("keydown", function(e){
  if(e.key !== "Escape") return;
  if(confirmState){ confirmState=null; render(); return; }
  if(quizEditor.open){ quizEditor.open=false; render(); return; }
  if(unlockCelebration.open){ unlockCelebration.open=false; render(); return; }
  if(specializationEditor.open){ specializationEditor.open=false; render(); return; }
  if(protocolEditor.open){ protocolEditor.open=false; render(); return; }
  if(moduleFeedbackViewer.open){ moduleFeedbackViewer.open=false; render(); return; }
  if(moduleQuizManager.open){ moduleQuizManager.open=false; render(); return; }
  if(lessonQuizManager.open){ lessonQuizManager.open=false; render(); return; }
  if(videoEditor.open){ videoEditor.open=false; render(); return; }
  if(lessonEditor.open){ lessonEditor.open=false; render(); return; }
  if(tempPasswordResult){ tempPasswordResult=null; render(); return; }
  if(telegramModal.open){ telegramModal.open=false; render(); return; }
  if(profileEditor.open){ profileEditor.open=false; render(); return; }
  if(changePasswordOpen){ changePasswordOpen=false; render(); return; }
  if(typeof calendarState!=="undefined" && calendarState.eventModalMode){ calendarState.eventModalMode=null; render(); return; }
  if(typeof materialsPicker!=="undefined" && materialsPicker.open){ materialsPicker.open=false; render(); return; }
  if(typeof scheduleModal!=="undefined" && scheduleModal.open){ scheduleModal.open=false; render(); return; }
  if(typeof staffState!=="undefined" && staffState.selectedStudentId){ staffState.selectedStudentId=null; render(); return; }
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
