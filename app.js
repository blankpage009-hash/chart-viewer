/* Navigraph Chart Viewer — 2단계 (진짜 PDF 연결)
   PDF 원본은 브라우저 안 창고(IndexedDB)에 통째로 보관한다.
   한 번 넣으면 원본 파일이나 인터넷 없이 열린다. */

import * as pdfjsLib from './pdfjs/pdf.min.mjs';

// PDF 해석은 별도 일꾼(worker)에게 맡겨야 화면이 멈추지 않는다
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const TYPES = ['SID', 'STAR', 'APP', 'TAXI', 'ETC'];

/* ── 1. 파일 이름 해석 ────────────────────────────────────────────
   RKSS_[APP] 11-5_ILS OR LOC RWY 32R.pdf
   → icao=RKSS · type=APP · no=11-5 · title=ILS OR LOC RWY 32R
   KDEN_Denver_USA.pdf (공항 하나가 통째로 묶인 통합본)
   → icao=KDEN · type=ETC · 공항 이름 Denver · 국가 USA
   규칙에 안 맞는 이름도 버리지 않고 ETC(기타)로 살려둔다. */
const NAME_RE = /^([A-Za-z0-9]+)[_ ]\[([^\]]+)\]\s*([^_,]*)[_,]\s*(.+)$/;

/* 코드_이름_국가. 이름·국가에 숫자를 허용하지 않아야
   RKSS_10-9_AIRPORT 같은 차트 이름을 공항 이름으로 잘못 읽지 않는다 */
const SOLO_RE = /^([A-Za-z]{4})_([A-Za-z][A-Za-z .'\-]*?)(?:_([A-Za-z][A-Za-z .'\-]*?))?$/;

function parseFileName(fileName) {
  // 정렬용으로 이름 앞에 ★ 같은 표시를 붙이는 경우가 있어 글자·숫자가 나올 때까지 잘라낸다
  const base = fileName.replace(/\.pdf$/i, '').replace(/^[^A-Za-z0-9]+/, '').trim();
  const m = base.match(NAME_RE);

  if (m) {
    const rawType = m[2].trim().toUpperCase();
    return {
      file: fileName,
      icao: m[1].toUpperCase(),
      type: TYPES.includes(rawType) ? rawType : 'ETC',
      rawType,
      no: m[3].trim(),
      title: m[4].trim()
    };
  }

  const solo = base.match(SOLO_RE);
  if (solo) {
    const aptName    = (solo[2] || '').trim();
    const aptCountry = (solo[3] || '').trim();
    return {
      file: fileName,
      icao: solo[1].toUpperCase(),
      type: 'ETC',
      rawType: 'ETC',
      no: '',
      title: [aptName, aptCountry].filter(Boolean).join(' · '),
      aptName,
      aptCountry
    };
  }

  const guess = base.match(/^([A-Za-z0-9]{3,4})[_\-\s]/);
  return {
    file: fileName,
    icao: guess ? guess[1].toUpperCase() : '?',
    type: 'ETC',
    rawType: 'ETC',
    no: '',
    title: base
  };
}

/* ── 2. 창고 (IndexedDB) ──────────────────────────────────────────
   files = PDF 원본 / meta = 이름·용량.
   목록을 그릴 때 원본까지 읽으면 메모리를 다 쓰므로 둘을 나눠 둔다. */
const DB_NAME = 'ncv-charts';
const S_FILES = 'files';
const S_META  = 'meta';
let dbPromise = null;

function openDB(version) {
  return new Promise((resolve, reject) => {
    const rq = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains(S_FILES)) d.createObjectStore(S_FILES, { keyPath: 'name' });
      if (!d.objectStoreNames.contains(S_META))  d.createObjectStore(S_META,  { keyPath: 'name' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror   = () => reject(rq.error);
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = (async () => {
      // 버전을 지정하지 않고 연다. 처음이면 새로 만들어지고, 있으면 있는 그대로 열린다
      let d = await openDB();
      // 저장 공간이 깨져 보관함이 사라진 경우에만 버전을 올려 다시 만든다
      if (!d.objectStoreNames.contains(S_FILES) || !d.objectStoreNames.contains(S_META)) {
        const next = d.version + 1;
        d.close();
        d = await openDB(next);
      }
      return d;
    })();
  }
  return dbPromise;
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

async function putFile(file) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction([S_FILES, S_META], 'readwrite');
    t.objectStore(S_FILES).put({ name: file.name, blob: file });
    t.objectStore(S_META).put({ name: file.name, size: file.size, addedAt: Date.now() });
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  });
}

async function getFile(name) {
  const d = await db();
  return req(d.transaction(S_FILES, 'readonly').objectStore(S_FILES).get(name));
}

async function listMeta() {
  const d = await db();
  return req(d.transaction(S_META, 'readonly').objectStore(S_META).getAll());
}

async function deleteFile(name) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction([S_FILES, S_META], 'readwrite');
    t.objectStore(S_FILES).delete(name);
    t.objectStore(S_META).delete(name);
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
  });
}

/* ── 3. 즐겨찾기 · 공항 정보 (작은 값이라 localStorage) ────────── */
const KEY_FAV = 'ncv.favorites';
const KEY_APT = 'ncv.airports';
const KEY_APT_FAV = 'ncv.favAirports';
const KEY_ROT = 'ncv.rotations';
const KEY_THEME = 'ncv.theme';
const KEY_AI_KEY = 'ncv.aiKey';       // 제미나이 열쇠. 이 기기 밖으로 나가지 않는다
const KEY_AI_NOTES = 'ncv.aiNotes';   // 차트별 해석 글 (한 번 받아두면 인터넷 없이 다시 본다)

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 실패는 무시 */ }
}

let favorites   = load(KEY_FAV, []);
let airports    = load(KEY_APT, {});
let favAirports = load(KEY_APT_FAV, []);
/* 차트마다 마지막으로 돌려 본 방향. 다시 열 때 그 방향 그대로 보여 준다 */
let rotations   = load(KEY_ROT, {});
/* 화면 색. 'light' 또는 'dark' (index.html 머리말에서 이미 한 번 적용해 둔다) */
let theme       = load(KEY_THEME, 'light') === 'dark' ? 'dark' : 'light';
let aiKey       = load(KEY_AI_KEY, '');
let aiNotes     = load(KEY_AI_NOTES, {});

function applyTheme(next) {
  theme = next === 'dark' ? 'dark' : 'light';
  // 밝은 테마는 표시를 아예 지워서, CSS 기본값(:root)이 그대로 쓰이게 한다
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  save(KEY_THEME, theme);
  renderThemeTab();
}

function renderThemeTab() {
  $$('#theme-list .theme-btn').forEach(b =>
    b.classList.toggle('is-on', b.dataset.themeSet === theme));
}

/* 저장 공간 안내 (알아낸 뒤에만 목록 아래에 덧붙인다) */
let storageNote = '';

async function refreshStorageNote() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return;
    const left = Math.max(0, est.quota - (est.usage || 0));
    storageNote = ` · 남은 공간 약 ${fmtSize(left)}`;
  } catch { /* 못 알아내면 안 보여주면 그만 */ }
}

/* ── 4. 상태 ──────────────────────────────────────────────────── */
let CHARTS = [];

const state = {
  query: '',
  split: false,
  activePane: 0,
  fullscreen: false,     // 전체 화면 보기 (상단 바를 감추고 차트 하나만 채움)
  sidebarWasHidden: false, // 전체 화면에 들어가기 직전의 목록 상태 (나올 때 그대로 되돌리려고 기억한다)
  groupType: {}          // 공항(ICAO)별로 따로 고르는 종류 필터. 비어 있으면 'ALL'
};

/* 설정 창 Files 칸에서 체크해 둔 파일 이름들 */
const selectedFiles = new Set();

function newPane() {
  return {
    file: null, doc: null, page: null, loading: null,
    pageNum: 1, numPages: 1,
    zoom: 1, rot: 0, fitScale: 1,
    crop: null,                  // 이 장에서 내용이 들어 있는 네모 (PDF 원래 좌표)
    task: null, token: 0
  };
}
const panes = [newPane(), newPane()];

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const viewEl   = i => $(`.viewer[data-pane="${i}"]`);
const bodyEl   = i => viewEl(i).querySelector('.viewer-body');
const canvasEl = i => viewEl(i).querySelector('.chart-canvas');

/* ── 5. 검색 ──────────────────────────────────────────────────── */
function matches(chart, q) {
  if (!q) return true;
  const apt = airports[chart.icao] || {};
  const hay = [chart.icao, chart.no, chart.title, chart.rawType, apt.name, apt.country]
    .join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}


/* ── 6. 목록 그리기 ───────────────────────────────────────────── */
/* 즐겨찾기(Pinboards) 아이콘 = 비스듬히 꽂힌 압정. 똑바로 선 압정 그림을 45도 돌려서 쓴다
   (돌리면 네 귀퉁이가 그림틀 밖으로 나가므로 0.88배로 줄여 안에 들어오게 맞췄다).
   즐겨찾기 여부는 모양이 아니라 색(.is-on/.is-fav → 회색/금색)으로 구분한다
   (2026-08-02, 별표 → Pin.png → 직접 그린 압정 순서로 바뀜) */
function pinIcon() {
  return `<svg class="pin-icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <g transform="rotate(45 12 12)"><g transform="translate(12 12) scale(.88) translate(-12 -12)">
        <path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97l1.03 9 1.03-9H19v-2c-1.66 0-3-1.34-3-3z"/>
      </g></g></svg>`;
}

/* 공항 즐겨찾기(사이드바 Airport 탭 전용) 아이콘 = 별표. 차트 즐겨찾기(압정)와 모양을 다르게 해서
   "공항을 찜한다"와 "차트를 찜한다"가 헷갈리지 않게 한다 */
function starIcon() {
  return `<svg class="star-icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2.5l2.98 6.04 6.67.97-4.83 4.7 1.14 6.65L12 17.77l-5.96 3.13 1.14-6.65-4.83-4.7 6.67-.97L12 2.5z"/>
    </svg>`;
}

function chartRow(chart) {
  const row = document.createElement('div');
  row.className = 'chart-row';
  row.dataset.file = chart.file;
  if (panes.some(p => p.file === chart.file)) row.classList.add('is-open');

  const isFav = favorites.includes(chart.file);
  row.innerHTML = `
    <button class="row-main" data-open="${esc(chart.file)}">
      <span class="badge badge-${chart.type}">${esc(chart.type === 'ETC' ? (chart.rawType || 'ETC') : chart.type)}</span>
      <span class="chart-meta">
        <span class="chart-no">${esc(chart.no)}</span>
        <span class="chart-title">${esc(chart.title)}</span>
      </span>
    </button>
    <button class="star-btn${isFav ? ' is-on' : ''}" data-star="${esc(chart.file)}"
            title="즐겨찾기">${pinIcon()}</button>`;
  return row;
}

function groupByAirport(list) {
  const map = new Map();
  list.forEach(c => {
    if (!map.has(c.icao)) map.set(c.icao, []);
    map.get(c.icao).push(c);
  });
  return map;
}

/* opts.withFilter 가 있으면 공항 묶음마다 종류 필터(전체·SID·STAR·APP·TAXI·기타)를 따로 붙인다.
   검색 결과에서만 쓰고, 즐겨찾기에는 필요 없다고 해서 안 붙인다 */
function renderGroupedList(container, list, opts = {}) {
  container.innerHTML = '';
  const grouped = groupByAirport(list);
  // 공항이 딱 하나만 나올 때는 Charts 제목 옆에 이름·국가를 대신 보여주므로, 묶음 위 머리글은 생략한다
  const skipHead = opts.hideAptHeadIfSingle && grouped.size === 1;

  grouped.forEach((charts, icao) => {
    const apt = airports[icao] || {};
    const label = [apt.name, apt.country].filter(Boolean).join(' · ');

    const group = document.createElement('div');
    group.className = 'apt-group';

    // 공항 코드 + 종류 필터는 스크롤해도 위에 붙어 있도록 한 덩어리로 묶는다
    const head = document.createElement('div');
    head.className = 'apt-head-sticky';
    // 이름·국가 입력은 상단 [공항 정보] 창에서만 한다 (목록 머리글을 눌러 여는 기능은 없앰)
    head.innerHTML = skipHead ? '' : `<div class="apt-head">
        <span class="apt-icao">${esc(icao)}</span>
        ${label
          ? `<span class="apt-name">${esc(label)}</span>`
          : '<span class="apt-name apt-empty">이름 미입력</span>'}
      </div>`;
    group.appendChild(head);

    let rows = charts;
    if (opts.withFilter) {
      const sel = state.groupType[icao] || 'ALL';
      const nav = document.createElement('nav');
      nav.className = 'apt-filters';
      nav.dataset.icao = icao;
      nav.innerHTML = ['ALL', ...TYPES].map(t => {
        const shown = t === 'ALL' ? 'ALL' : (t === 'ETC' ? 'etc' : t);
        return `<button class="apt-filter-btn${t === sel ? ' is-on' : ''}" data-type="${t}">${shown}</button>`;
      }).join('');
      head.appendChild(nav);
      rows = sel === 'ALL' ? charts : charts.filter(c => c.type === sel);
    }

    if (opts.withFilter && !rows.length) {
      group.insertAdjacentHTML('beforeend', '<p class="empty-note">이 종류의 차트가 없습니다.</p>');
    } else {
      rows.forEach(c => group.appendChild(chartRow(c)));
    }
    container.appendChild(group);
  });

  return grouped;
}

/* Charts 제목 줄 옆에 "공항이 하나만 나왔을 때" 이름·국가를 보여준다 (여러 공항이 섞이면 숨긴다) */
function updateChartsHeaderAirport(grouped) {
  const info = $('#result-airport-info');
  const divider = $('#result-divider');
  let label = '';
  if (grouped && grouped.size === 1) {
    const icao = [...grouped.keys()][0];
    const apt = airports[icao] || {};
    label = [apt.name, apt.country].filter(Boolean).join(' · ');
  }
  info.textContent = label;
  info.hidden = !label;
  divider.hidden = !label;
}

function renderAll() {
  const q = state.query;
  const searchList = q ? CHARTS.filter(c => matches(c, q)) : [];

  const resultGroups = renderGroupedList($('#result-body'), searchList, { withFilter: true, hideAptHeadIfSingle: true });
  updateChartsHeaderAirport(resultGroups);
  $('#result-count').textContent = searchList.length;
  if (!searchList.length) {
    $('#result-body').innerHTML = !q
      ? '<p class="empty-note">검색창에 ICAO·공항 이름·국가를 입력하면 여기에 나타납니다.</p>'
      : (CHARTS.length
          ? '<p class="empty-note">조건에 맞는 차트가 없습니다. 검색어를 확인해보세요.</p>'
          : '<p class="empty-note">아직 넣어둔 차트가 없습니다.<br>오른쪽 위 <b>Upload</b> 를 눌러 차트를 넣어주세요.</p>');
  }

  const favList = CHARTS.filter(c => favorites.includes(c.file));
  renderGroupedList($('#fav-body'), favList);
  $('#fav-count').textContent = favorites.filter(f => CHARTS.some(c => c.file === f)).length;
  if (!favList.length) {
    $('#fav-body').innerHTML = '<p class="empty-note">차트 옆 핀 아이콘을 누르면 여기에 담깁니다.</p>';
  }

  const bytes = CHARTS.reduce((sum, c) => sum + (c.size || 0), 0);
  $('#store-info').textContent = CHARTS.length
    ? `차트 ${CHARTS.length}개 · ${fmtSize(bytes)}${storageNote}`
    : '';

  renderFavAirportChips();
  renderAirportList();
  panes.forEach((_, i) => updateBar(i));
}

/* Airport 탭 — 차트가 들어 있는 공항 전체 목록. 눌러서 검색으로 바로 이동한다 */
function renderAirportList() {
  const box = $('#airport-body');
  const codes = [...new Set(CHARTS.map(c => c.icao))].sort();
  $('#airport-count').textContent = codes.length;

  if (!codes.length) {
    box.innerHTML = '<p class="empty-note">아직 넣어둔 차트가 없습니다.</p>';
    return;
  }
  box.innerHTML = codes.map(icao => {
    const apt = airports[icao] || {};
    const label = [apt.name, apt.country].filter(Boolean).join(' · ');
    const isFav = favAirports.includes(icao);
    return `<div class="airport-row">
        <button class="apt-row-main" data-apt-select="${esc(icao)}">
          <span class="apt-icao">${esc(icao)}</span>
          ${label
            ? `<span class="apt-name">${esc(label)}</span>`
            : '<span class="apt-name apt-empty">이름 미입력</span>'}
        </button>
        <button class="apt-fav-toggle${isFav ? ' is-on' : ''}" data-apt-fav="${esc(icao)}"
                title="공항 즐겨찾기">${starIcon()}</button>
      </div>`;
  }).join('');
}

/* 검색 결과가 생겼을 때 Charts 칸을 화면 위쪽으로 데려온다.
   공항이 여러 개 들어 있으면 Airport 목록이 사이드바를 통째로 차지해서, 검색해도 Charts 칸이
   스크롤 한참 아래에 그려질 뿐이라 '검색창이 먹통'인 것처럼 보였다 (2026-08-04 지적) */
function focusChartsSection() {
  const airportHead = document.querySelector('[data-toggle="airport-body"]');
  airportHead.classList.add('collapsed');
  $('#airport-body').classList.add('collapsed');

  const resultHead = document.querySelector('[data-toggle="result-body"]');
  resultHead.classList.remove('collapsed');
  $('#result-body').classList.remove('collapsed');

  $('#sidebar').scrollTop = 0;
}

/* 검색창을 비웠을 때 — 공항을 다시 훑어볼 수 있도록 Airport 목록을 펴 준다 */
function unfocusChartsSection() {
  document.querySelector('[data-toggle="airport-body"]').classList.remove('collapsed');
  $('#airport-body').classList.remove('collapsed');
  $('#sidebar').scrollTop = 0;
}

/* 공항을 골랐을 때(Airport 탭이든 위쪽 즐겨찾기 칩이든) 공통으로 하는 일:
   그 공항으로 검색하고, Airport 탭은 닫고 Charts 탭을 편다 */
function jumpToAirport(icao) {
  $('#search').value = icao;
  state.query = icao;
  renderAll();
  focusChartsSection();
  $('#layout').classList.remove('sidebar-hidden');
}

/* 즐겨찾기한 공항을 검색창 옆에 칩으로 나열. 누르면 그 공항으로 바로 검색된다 */
function renderFavAirportChips() {
  const box = $('#fav-airports');
  box.innerHTML = favAirports.map(icao =>
    `<button class="fav-apt-chip" data-apt-jump="${esc(icao)}"
             title="${esc(airports[icao]?.name || icao)}">${esc(icao)}</button>`
  ).join('');
}

/* ── 7. 뷰어 ──────────────────────────────────────────────────── */
function updateBar(i) {
  const p = panes[i];
  const view = viewEl(i);
  const chart = CHARTS.find(c => c.file === p.file);
  const isFav = p.file && favorites.includes(p.file);

  view.classList.toggle('is-active', i === state.activePane);
  view.classList.toggle('has-chart', !!p.file);

  // 맨 앞엔 공항 ICAO 코드를 흰 판(공항 명판 느낌)으로, 그다음 종류(SID/STAR/APP/TAXI/etc) 배지를 붙인다.
  // 코드가 앞에 따로 나오니 뒤 제목 글자에서는 ICAO를 반복하지 않는다
  view.querySelector('.viewer-title').innerHTML = chart
    ? `<span class="icao-badge">${esc(chart.icao)}</span>` +
      `<span class="badge badge-${chart.type}">${esc(chart.type === 'ETC' ? (chart.rawType || 'ETC') : chart.type)}</span>` +
      `<span class="viewer-title-text">${esc(chart.no)}  ${esc(chart.title)}</span>`
    : '<span class="viewer-title-text">차트를 선택하세요</span>';

  const favBtn = view.querySelector('[data-act="fav"]');
  favBtn.classList.toggle('is-fav', !!isFav);
  favBtn.innerHTML = pinIcon();

  // 이미 해석해 둔 차트는 전구에 불이 들어와 있어, 인터넷 없이도 열린다는 걸 알 수 있다
  const aiBtn = view.querySelector('[data-act="ai"]');
  aiBtn.classList.toggle('is-on', !!(p.file && aiNotes[p.file]));
  aiBtn.title = p.file && aiNotes[p.file] ? 'AI 해석 보기 (저장됨)' : 'AI 차트 해석';

  const fsBtn = view.querySelector('[data-act="fullscreen"]');
  fsBtn.classList.toggle('is-on', state.fullscreen);
  fsBtn.title = state.fullscreen ? '전체 화면 나가기' : '전체 화면';

  view.querySelector('.zoom-label').textContent = Math.round(p.zoom * 100) + '%';

  const nav = view.querySelector('.page-nav');
  nav.hidden = p.numPages <= 1;
  nav.querySelector('.page-label').textContent = `${p.pageNum} / ${p.numPages}`;
}

function showPlaceholder(i, html) {
  const view = viewEl(i);
  canvasEl(i).hidden = true;
  const ph = view.querySelector('.chart-placeholder');
  ph.hidden = false;
  ph.innerHTML = html;
}

/* PDF 한 장에서 '실제로 그림·글씨가 있는 네모'를 찾는다.
   차트 가장자리의 흰 여백을 잘라내고 화면을 꽉 채워 보여주기 위한 것.
   작게 한 번 그려 보고 흰색이 아닌 점의 범위를 재는 방식이다.
   돌려주는 값은 PDF 원래 좌표라서, 회전하거나 확대해도 그대로 쓸 수 있다 */
async function detectContent(page) {
  try {
    const v1 = page.getViewport({ scale: 1 });
    // 여백만 재면 되므로 크게 그릴 필요가 없다. 긴 변 900점 정도면 충분하다
    const s = Math.min(1.2, 900 / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale: s });
    const w = Math.max(1, Math.ceil(vp.width));
    const h = Math.max(1, Math.ceil(vp.height));

    const probe = document.createElement('canvas');
    probe.width = w;
    probe.height = h;
    const ctx = probe.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const px = ctx.getImageData(0, 0, w, h).data;
    const rows = new Uint32Array(h);
    const cols = new Uint32Array(w);
    const DARK = 240;                 // 이보다 어두우면 내용이 있는 것으로 본다
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) << 2;
        if (px[i] < DARK || px[i + 1] < DARK || px[i + 2] < DARK) { rows[y]++; cols[x]++; }
      }
    }

    // 점 한두 개짜리 얼룩(스캔 티끌)은 내용으로 치지 않는다
    const MIN = 2;
    let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
    while (y0 < h && rows[y0] < MIN) y0++;
    while (y1 > y0 && rows[y1] < MIN) y1--;
    while (x0 < w && cols[x0] < MIN) x0++;
    while (x1 > x0 && cols[x1] < MIN) x1--;
    if (y0 >= h || x0 >= w) return null;                       // 빈 장

    const pad = 3;                    // 딱 붙여 자르면 잘린 것처럼 보여서 아주 조금 남긴다
    x0 = Math.max(0, x0 - pad);  y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad);  y1 = Math.min(h - 1, y1 + pad);

    const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
    if (cw > w * 0.97 && chh > h * 0.97) return null;          // 잘라낼 여백이 없다
    if (cw < w * 0.15 || chh < h * 0.15) return null;          // 너무 조금 남으면 잘못 잰 것으로 본다

    const a = vp.convertToPdfPoint(x0, y0);
    const b = vp.convertToPdfPoint(x1 + 1, y1 + 1);
    return {
      x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]),
      x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1])
    };
  } catch (err) {
    console.warn('여백을 재지 못했습니다:', err);
    return null;                      // 못 재면 예전처럼 장 전체를 보여준다
  }
}

/* 화면 맞춤 배율로 되돌아갈 때와 확대할 때 모두 이 함수로 다시 그린다 */
async function drawPage(i) {
  const p = panes[i];
  if (!p.page) return;

  const token = ++p.token;
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }

  const body = bodyEl(i);
  const canvas = canvasEl(i);
  const base = p.page.getViewport({ scale: 1, rotation: p.rot });

  // 내용이 있는 네모만 잘라서 보여 준다. PDF 원래 좌표를 지금 회전 상태의 좌표로 옮긴다
  let cropX = 0, cropY = 0, cropW = base.width, cropH = base.height;
  if (p.crop) {
    const c = p.crop;
    const pts = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]]
      .map(([x, y]) => base.convertToViewportPoint(x, y));
    const xs = pts.map(q => q[0]);
    const ys = pts.map(q => q[1]);
    cropX = Math.max(0, Math.min(...xs));
    cropY = Math.max(0, Math.min(...ys));
    cropW = Math.min(base.width  - cropX, Math.max(...xs) - cropX);
    cropH = Math.min(base.height - cropY, Math.max(...ys) - cropY);
  }

  const availW = Math.max(80, body.clientWidth  - 6);   // .viewer-body 안쪽 여백(3px씩)만큼 뺀다
  const availH = Math.max(80, body.clientHeight - 6);
  p.fitScale = Math.min(availW / cropW, availH / cropH);

  const cssW = cropW * p.fitScale * p.zoom;
  const cssH = cropH * p.fitScale * p.zoom;

  // 화면 픽셀 밀도까지 반영해야 글자가 또렷하다
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = p.fitScale * p.zoom * dpr;

  // 캔버스가 너무 크면 아이패드에서 아예 그려지지 않으므로 상한을 둔다
  const MAX_PX = 12e6;
  if (cropW * scale * cropH * scale > MAX_PX) {
    scale = Math.sqrt(MAX_PX / (cropW * cropH));
  }

  const vp = p.page.getViewport({ scale, rotation: p.rot });
  canvas.width  = Math.max(1, Math.floor(cropW * scale));
  canvas.height = Math.max(1, Math.floor(cropH * scale));
  canvas.style.width  = Math.round(cssW) + 'px';
  canvas.style.height = Math.round(cssH) + 'px';
  canvas.style.transform = '';

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 잘라낸 만큼 왼쪽·위로 밀어서 그리면 내용만 캔버스에 담긴다
  p.task = p.page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: [1, 0, 0, 1, -cropX * scale, -cropY * scale]
  });
  try {
    await p.task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') throw err;
    return;
  }
  if (token !== p.token) return;      // 그리는 사이에 다른 차트로 바뀐 경우

  p.task = null;
  canvas.hidden = false;
  viewEl(i).querySelector('.chart-placeholder').hidden = true;
  updateBar(i);
}

async function loadPage(i, num) {
  const p = panes[i];
  if (!p.doc) return;
  const token = p.token;
  p.pageNum = Math.min(Math.max(1, num), p.numPages);
  p.page = await p.doc.getPage(p.pageNum);
  if (token !== p.token) return;              // 여는 사이에 다른 차트로 바뀐 경우

  // 여백 재기는 그리기 전에 끝내야 한다 (같은 장을 동시에 두 번 그리지 않도록)
  p.crop = await detectContent(p.page);
  if (token !== p.token) return;

  await drawPage(i);
}

async function openChart(file) {
  const i = state.activePane;
  const p = panes[i];
  const token = ++p.token;

  closePane(i, { keepToken: true });
  p.file = file;
  showPlaceholder(i, '<p class="ph-hint">차트를 여는 중…</p>');
  updateBar(i);
  renderRowStates();

  try {
    const rec = await getFile(file);
    if (!rec) throw new Error('저장된 파일을 찾을 수 없습니다');
    const buf = await rec.blob.arrayBuffer();
    if (token !== p.token) return;

    // 문서를 닫을 때는 이 loadingTask 를 없애야 메모리가 함께 정리된다
    const loading = pdfjsLib.getDocument({ data: buf });
    const doc = await loading.promise;
    if (token !== p.token) { loading.destroy(); return; }

    p.loading = loading;
    p.doc = doc;
    p.numPages = doc.numPages;
    p.zoom = 1;
    p.rot = rotations[file] || 0;      // 지난번에 돌려 본 방향 그대로
    await loadPage(i, 1);
  } catch (err) {
    console.error(err);
    showPlaceholder(i,
      '<p class="ph-hint">이 파일을 열지 못했습니다.<br>PDF가 아니거나 손상된 파일일 수 있습니다.</p>');
  }

  // 전체 화면에서는 목록이 차트 위에 겹쳐 뜨므로, 차트를 고르면 비켜 준다
  if (state.fullscreen || window.innerWidth <= 900) $('#layout').classList.add('sidebar-hidden');
}

function closePane(i, opts = {}) {
  const p = panes[i];
  if (!opts.keepToken) p.token++;
  if (p.task)    { try { p.task.cancel(); } catch {} }
  if (p.loading) { try { p.loading.destroy(); } catch {} }
  Object.assign(p, newPane(), { token: p.token });
  showPlaceholder(i, '<p class="ph-hint">왼쪽 목록에서 차트를 고르세요</p>');
}

/* 목록에서 '지금 열려 있는 차트' 표시만 갱신 (전체를 다시 그리지 않도록) */
function renderRowStates() {
  $$('.chart-row').forEach(row =>
    row.classList.toggle('is-open', panes.some(p => p.file === row.dataset.file)));
}

/* 왼쪽 가장자리에서 시작한 좌우 쓸기는 '사이드바 열기'가 먼저 차지하고 있다 (attachSidebarSwipe).
   한 손짓에 사이드바가 열리면서 차트까지 넘어가 버리지 않도록, 차트 넘기기는 이 폭 안에서 시작한
   손짓을 무시한다. 사이드바 판정 폭(34px)보다 넉넉히 잡아 살짝 안쪽에서 시작해도 겹치지 않게 했다 */
const SIDEBAR_EDGE   = 34;
const SWIPE_DEAD_LEFT = 64;

/* 전체 화면 보기 켜고 끄기. 상단 바(＋목록 여는 ☰ 버튼)가 사라지므로, 들어갈 때는 목록을 접어
   차트만 보이게 시작하고 나올 때는 들어가기 직전 상태로 되돌린다.
   전체 화면 중에도 왼쪽 가장자리를 쓸면 목록을 차트 위에 겹쳐 띄울 수 있다 */
async function setFullscreen(i, on) {
  if (state.fullscreen === on) return;
  const layout = $('#layout');

  if (on) {
    state.sidebarWasHidden = layout.classList.contains('sidebar-hidden');
    state.activePane = i;
    layout.classList.add('sidebar-hidden');
  } else if (!state.sidebarWasHidden) {
    layout.classList.remove('sidebar-hidden');
  }

  state.fullscreen = on;
  document.body.classList.toggle('is-fullscreen', on);
  panes.forEach((_, k) => updateBar(k));
  // 칸 크기가 바뀌었으니 화면 맞춤 배율을 다시 계산해서 다시 그린다
  for (const k of [0, 1]) if (panes[k].page) await drawPage(k);
}

/* 차트를 넘길 때 미끄러지는 효과. 가던 방향으로 밀어냈다가 새 차트를 반대쪽에서 밀어 넣는다.
   run() 이 실제로 차트를 여는 일을 맡고, 그 사이 화면은 밀려나간 자리에 그대로 비워 둔다 */
async function slideSwap(i, dir, run) {
  const stage = viewEl(i).querySelector('.chart-stage');
  const body  = bodyEl(i);
  // 움직임을 줄여 달라고 설정한 기기에서는 효과 없이 바로 바꾼다
  if (!stage?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await run();
    return;
  }

  const d = Math.max(120, body.clientWidth * 0.35);
  body.classList.add('is-sliding');   // 미는 동안 삐져나간 부분이 스크롤로 잡히지 않게 한다

  // 끝난 뒤 반드시 직접 붙잡은 것으로 되돌린다. stage.getAnimations()로 훑어서 지우면 안 된다 —
  // 끝난 애니메이션이 목록에서는 빠지면서 fill:forwards 효과만 남아, 차트가 화면 밖에 세워진 채
  // 영영 안 보이게 된다 (2026-08-03에 실제로 겪음)
  let out = null, back = null;
  try {
    // 새 차트를 그리는 동안 가운데에 다시 나타나지 않도록 밀려난 자리에 세워 둔다
    out = stage.animate(
      [{ transform: 'translateX(0)', opacity: 1 },
       { transform: `translateX(${-dir * d}px)`, opacity: 0 }],
      { duration: 150, easing: 'ease-in', fill: 'forwards' }
    );
    await out.finished;

    await run();

    back = stage.animate(
      [{ transform: `translateX(${dir * d}px)`, opacity: 0 },
       { transform: 'translateX(0)', opacity: 1 }],
      { duration: 190, easing: 'ease-out' }
    );
    await back.finished;
  } finally {
    try { out?.cancel(); } catch {}
    try { back?.cancel(); } catch {}
    stage.style.transform = '';
    stage.style.opacity   = '';
    body.classList.remove('is-sliding');
  }
}

/* 같은 공항의 차트 목록(전체 종류, CHARTS의 정렬 순서 그대로) 안에서 이전·다음으로 넘어간다.
   dir 은 -1(이전) 또는 1(다음) */
let stepping = false;   // 넘어가는 도중에 손짓이 겹쳐 들어와 두 장씩 건너뛰는 것을 막는다

async function stepChart(i, dir) {
  if (stepping) return;
  const chart = CHARTS.find(c => c.file === panes[i].file);
  if (!chart) return;
  const siblings = CHARTS.filter(c => c.icao === chart.icao);
  const idx = siblings.findIndex(c => c.file === chart.file);
  const next = siblings[idx + dir];
  if (!next) return;               // 맨 처음·맨 끝이면 그냥 둔다

  if (state.split && state.activePane !== i) {
    state.activePane = i;
    panes.forEach((_, k) => updateBar(k));
  }
  stepping = true;
  try {
    await slideSwap(i, dir, () => openChart(next.file));
  } finally {
    stepping = false;
  }
}

/* 차트가 화면 맞춤(100%) 배율일 때는 가로로 넘칠 내용이 없어 좌우 스와이프가 그냥 버려지므로,
   그 손짓을 이전·다음 차트 넘기기로 대신 쓴다. 확대돼 있으면(스크롤이 필요하면) 평소처럼 스와이프로
   화면을 옮긴다 (2026-08-02 요청) */
function attachChartSwipe(i) {
  const body = bodyEl(i);
  const MIN_X = 50;      // 이만큼은 옆으로 그어야 넘긴다
  const MIN_Y = 60;      // 이만큼은 위아래로 그어야 전체 화면이 바뀐다
  let sx = 0, sy = 0, watching = false, deadLeft = false;

  body.addEventListener('touchstart', e => {
    const p = panes[i];
    watching = e.touches.length === 1 && !!p.page && p.zoom === 1;
    if (!watching) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    deadLeft = sx <= SWIPE_DEAD_LEFT;
  }, { passive: true });

  body.addEventListener('touchend', e => {
    if (!watching) return;
    watching = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;

    // 위아래로 그은 것 — 위로 쓸면 전체 화면, 아래로 쓸면 전체 화면 나가기 (2026-08-03 요청).
    // 목록 열기는 가로 쓸기만 보므로, 왼쪽 가장자리에서 시작해도 그대로 받는다
    if (Math.abs(dy) >= MIN_Y && Math.abs(dy) > Math.abs(dx) * 1.2) {
      setFullscreen(i, dy < 0);
      return;
    }

    // 왼쪽 가장자리는 '목록 열기' 몫이라 차트 넘기기로 쓰지 않는다 (전체 화면에서도 마찬가지다 —
    // 전체 화면에서도 목록을 열 수 있게 되면서 다시 부딪히게 됐다)
    if (deadLeft) return;
    if (Math.abs(dx) < MIN_X || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    stepChart(i, dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ── 8. 확대 · 축소 ───────────────────────────────────────────── */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function setZoom(i, next) {
  const p = panes[i];
  if (!p.page) return;
  const body = bodyEl(i);
  const prev = p.zoom;
  p.zoom = clamp(next, 0.5, 8);
  if (p.zoom === prev) return;

  // 확대 전 화면 한가운데에 있던 지점을 확대 후에도 가운데 두기 위한 값
  const cx = (body.scrollLeft + body.clientWidth  / 2) / prev;
  const cy = (body.scrollTop  + body.clientHeight / 2) / prev;

  await drawPage(i);

  body.scrollLeft = cx * p.zoom - body.clientWidth  / 2;
  body.scrollTop  = cy * p.zoom - body.clientHeight / 2;
}

/* 두 손가락 확대: 손가락을 떼기 전에는 그림을 늘려 보여주고, 떼면 그때 다시 그린다 */
function attachPinch(i) {
  const body = bodyEl(i);
  let startDist = 0, live = 1;

  const dist = t =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  body.addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || !panes[i].page) return;
    startDist = dist(e.touches);
    live = 1;
  }, { passive: true });

  body.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault();
    live = clamp(dist(e.touches) / startDist, 0.25, 4);
    canvasEl(i).style.transform = `scale(${live})`;
  }, { passive: false });

  const end = () => {
    if (!startDist) return;
    startDist = 0;
    canvasEl(i).style.transform = '';
    if (Math.abs(live - 1) > 0.02) setZoom(i, panes[i].zoom * live);
    live = 1;
  };
  body.addEventListener('touchend', end);
  body.addEventListener('touchcancel', end);

  // 사파리가 페이지 전체를 확대해 버리는 것을 막는다
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev =>
    body.addEventListener(ev, e => e.preventDefault()));

  // PC: Ctrl + 휠 (그냥 휠은 위아래 이동 — 사용자가 이 방식을 선택함)
  body.addEventListener('wheel', e => {
    if (!e.ctrlKey || !panes[i].page) return;
    e.preventDefault();
    setZoom(i, panes[i].zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });
}

/* 마우스로 차트를 붙잡아 끌어서 이동.
   손가락은 화면 자체 스크롤이 이미 처리하므로 마우스일 때만 동작시킨다 */
function attachPan(i) {
  const body = bodyEl(i);
  let dragging = false, moved = false;
  let startX = 0, startY = 0, startL = 0, startT = 0;

  body.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !panes[i].page) return;
    dragging = true;
    moved = false;
    startX = e.clientX; startY = e.clientY;
    startL = body.scrollLeft; startT = body.scrollTop;
    try { body.setPointerCapture(e.pointerId); } catch {}
    body.classList.add('is-grabbing');
    e.preventDefault();              // 끌 때 캔버스가 이미지처럼 딸려오는 것을 막는다
  });

  body.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 3) moved = true;
    body.scrollLeft = startL - dx;
    body.scrollTop  = startT - dy;
  });

  const stop = e => {
    if (!dragging) return;
    dragging = false;
    body.classList.remove('is-grabbing');
    try { body.releasePointerCapture(e.pointerId); } catch {}
  };
  body.addEventListener('pointerup', stop);
  body.addEventListener('pointercancel', stop);

  // 끌고 난 직후의 클릭은 버튼 누름으로 치지 않는다
  body.addEventListener('click', e => {
    if (!moved) return;
    moved = false;
    e.stopPropagation();
  }, true);
}

/* ── 9. 파일 넣기 ─────────────────────────────────────────────── */
async function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.pdf$/i.test(f.name));
  const dropped = fileList.length - files.length;
  if (!files.length) {
    toast(dropped ? 'PDF 파일이 아니어서 넣지 않았습니다.' : '고른 파일이 없습니다.');
    return;
  }

  const known = new Set(CHARTS.map(c => c.file));
  let added = 0, replaced = 0, failed = 0, full = false;

  for (const f of files) {
    busy(`차트를 넣는 중…  ${added + replaced + failed + 1} / ${files.length}`);
    try {
      await putFile(f);
      known.has(f.name) ? replaced++ : added++;
    } catch (err) {
      console.error(err);
      // 저장 공간이 꽉 찼으면 나머지도 어차피 안 들어가므로 멈춘다
      if (err?.name === 'QuotaExceededError') { full = true; break; }
      failed++;
    }
  }

  busy(null);
  await refreshLibrary();

  if (full) {
    toast(`저장 공간이 부족해 멈췄습니다. ${added + replaced}개까지 넣었습니다.<br>` +
          '안 보는 차트를 지우고 다시 해보세요.');
    return;
  }

  const msg = [
    added    ? `${added}개 추가` : '',
    replaced ? `${replaced}개 교체` : '',
    failed   ? `${failed}개 실패` : '',
    dropped  ? `${dropped}개는 PDF가 아니라 제외` : ''
  ].filter(Boolean).join(' · ');
  toast(msg || '변경된 내용이 없습니다.');
}

/* 차트 지우기는 설정 창의 Files 칸에서만 한다. 한 번에 여러 개를 지울 수 있다 */
async function removeCharts(files) {
  if (!files.length) return;
  const one = files.length === 1
    ? (() => { const c = CHARTS.find(x => x.file === files[0]);
               return c ? `${c.icao} ${c.no} ${c.title}` : files[0]; })()
    : `${files.length}개`;
  if (!confirm(`${one}\n\n이 차트를 지울까요?\n(원본 PDF 파일은 그대로 있습니다)`)) return;

  busy('차트를 지우는 중…');
  for (const file of files) {
    await deleteFile(file);
    delete rotations[file];
    delete aiNotes[file];          // 없는 차트의 해석이 남아 자리를 차지하지 않게
    panes.forEach((p, i) => { if (p.file === file) closePane(i); });
  }
  favorites = favorites.filter(f => !files.includes(f));
  save(KEY_FAV, favorites);
  save(KEY_ROT, rotations);
  save(KEY_AI_NOTES, aiNotes);
  selectedFiles.clear();

  busy(null);
  await refreshLibrary();
  toast(`차트 ${files.length}개를 지웠습니다.`);
}

async function refreshLibrary() {
  await refreshStorageNote();
  const metas = await listMeta();
  CHARTS = metas
    .map(m => Object.assign(parseFileName(m.name), { size: m.size }))
    .sort((a, b) =>
      a.icao.localeCompare(b.icao) ||
      TYPES.indexOf(a.type) - TYPES.indexOf(b.type) ||
      a.no.localeCompare(b.no, undefined, { numeric: true }));

  // 새로 들어온 공항은 이름을 입력할 수 있도록 빈 칸을 만들어 둔다.
  // 파일 이름에 이름·국가가 들어 있으면(KDEN_Denver_USA) 비어 있을 때만 대신 채워 준다
  let changed = false;
  CHARTS.forEach(c => {
    if (!airports[c.icao]) { airports[c.icao] = { name: '', country: '' }; changed = true; }
    const apt = airports[c.icao];
    if (c.aptName    && !apt.name)    { apt.name    = c.aptName;    changed = true; }
    if (c.aptCountry && !apt.country) { apt.country = c.aptCountry; changed = true; }
  });
  if (changed) save(KEY_APT, airports);

  renderAll();
  // 설정 창을 열어 둔 채로 차트가 늘거나 줄면 그 안의 두 목록도 같이 맞춰 준다.
  // (renderAll 이 아니라 여기서 하는 이유: 이름을 한 글자 칠 때마다 다시 그리면 입력 칸이 풀린다)
  if (!$('#settings-modal').hidden) { renderAirportTable(); renderFileTable(); }
}

/* ── 9-1. AI 차트 해석 (구글 제미나이) ────────────────────────────
   차트 그림을 그대로 보내서 한국어 설명을 받아온다.
   받은 글은 파일 이름별로 저장해 두므로, 같은 차트를 다시 열면 인터넷 없이 바로 보이고
   요금도 다시 나가지 않는다. */
const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/* 지금 해석 창에 띄워 둔 차트 (다시 해석 버튼이 어느 차트를 가리키는지) */
let aiCurrent = null;
let aiRunning = false;

/* 차트 종류마다 물어보는 내용을 다르게 한다. 그래야 쓸모 있는 답이 온다 */
function aiPrompt(chart) {
  const byType = {
    SID:  '이 차트는 출발 절차(SID)입니다. 경로를 지나는 순서대로, 각 지점의 고도 제한과 속도 제한을 짚어 주세요.',
    STAR: '이 차트는 도착 절차(STAR)입니다. 경로를 지나는 순서대로, 각 지점의 고도 제한과 속도 제한을 짚어 주세요.',
    APP:  '이 차트는 접근 절차(APP)입니다. 접근 방식과 활주로, 무선 주파수, 최종 접근 고도와 최저 고도(minimums), ' +
          '그리고 복행(missed approach) 절차를 반드시 포함해 주세요.',
    TAXI: '이 차트는 공항 지상도(TAXI)입니다. 활주로와 주요 유도로 배치, 주기장 위치, ' +
          '주의해야 할 구역(활주로 침입 위험 지점 등)을 짚어 주세요.'
  };
  return [
    '너는 젭슨(Jeppesen) 항공 차트를 읽어 주는 조종사 도우미다.',
    '첨부한 차트 이미지를 읽고 한국어로 정리해라. 마이크로소프트 플라이트 시뮬레이터 비행 준비에 쓸 것이다.',
    byType[chart.type] || '이 차트의 종류와 용도를 먼저 밝히고, 담긴 주요 정보를 정리해 주세요.',
    '',
    '출력 형식 — 반드시 이대로만 쓴다:',
    '- 묶음의 제목은 **제목** 처럼 별표 두 개로 감싼 줄 하나로 쓴다. 제목은 2~6글자.',
    '- 제목 아래의 모든 줄은 한 줄에 한 가지씩, 40자 이내로 짧게 쓴다.',
    '- 한 줄은 하나의 항목이다. 여러 내용을 한 줄에 몰아 쓰지 마라.',
    '- 줄글로 설명하지 마라. 조사와 서술어를 빼고 핵심만 적는다.',
    '- 목록 기호(-, •), 번호, 표 기호는 네가 직접 넣지 마라. 앱이 알아서 붙인다.',
    '',
    '내용 규칙:',
    '- 비행에 꼭 필요한 것만. 전체 14줄을 넘기지 마라.',
    '- 차트에 없는 항목은 줄 자체를 쓰지 마라. 억지로 채우지 마라.',
    '- 차트에 적혀 있는 숫자만 쓴다. 흐려서 못 읽으면 "확인 필요"라고 적는다.',
    '  절대로 지어내지 마라.',
    '- 고도·주파수·활주로 번호는 원문 그대로 적는다.',
    '',
    '예시:',
    '**접근**',
    '활주로 32R, ILS 또는 LOC',
    'LOC 주파수 110.30 (GMP)',
    '최종 접근 코스 322°',
    '**최저 고도**',
    'ILS 480ft (지표 420ft)',
    '**복행**',
    '3000ft까지 상승 후 GMP VOR 대기'
  ].join('\n');
}

/* 화면에 보이는 캔버스를 그대로 보내면 확대 상태에 따라 잘리거나 흐릴 수 있다.
   그래서 AI에게 보낼 그림은 항상 같은 크기(긴 변 1600점)로 따로 한 장 그린다 */
async function renderForAi(p) {
  const base = p.page.getViewport({ scale: 1, rotation: p.rot });

  // 흰 여백을 잘라내는 계산은 drawPage 와 같다 (내용만 보내야 글자가 크게 잡힌다)
  let cropX = 0, cropY = 0, cropW = base.width, cropH = base.height;
  if (p.crop) {
    const c = p.crop;
    const pts = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]]
      .map(([x, y]) => base.convertToViewportPoint(x, y));
    const xs = pts.map(q => q[0]);
    const ys = pts.map(q => q[1]);
    cropX = Math.max(0, Math.min(...xs));
    cropY = Math.max(0, Math.min(...ys));
    cropW = Math.min(base.width  - cropX, Math.max(...xs) - cropX);
    cropH = Math.min(base.height - cropY, Math.max(...ys) - cropY);
  }

  const scale = 1600 / Math.max(cropW, cropH);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(cropW * scale));
  canvas.height = Math.max(1, Math.round(cropH * scale));

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 화면용 그리기(p.task)와 섞이지 않도록 이 작업은 따로 붙잡아 둔다
  const task = p.page.render({
    canvasContext: ctx,
    viewport: p.page.getViewport({ scale, rotation: p.rot }),
    transform: [1, 0, 0, 1, -cropX * scale, -cropY * scale]
  });
  await task.promise;

  // 앞의 "data:image/jpeg;base64," 는 떼고 알맹이만 보낸다
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function askGemini(chart, imageB64) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    // 열쇠는 주소가 아니라 헤더에 넣는다. 주소에 넣으면 기록에 열쇠가 그대로 남는다
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: aiPrompt(chart) },
          { inline_data: { mime_type: 'image/jpeg', data: imageB64 } }
        ]
      }]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn('제미나이 응답 오류:', res.status, detail);
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new Error('열쇠가 올바르지 않거나 권한이 없습니다. 설정 → AI 칸에서 다시 확인해 주세요.');
    if (res.status === 429)
      throw new Error('오늘 쓸 수 있는 양을 넘었습니다. 잠시 뒤에 다시 시도해 주세요.');
    throw new Error(`구글 서버가 응답하지 않았습니다. (오류 ${res.status})`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(x => x.text).filter(Boolean).join('') || '';
  if (!text) throw new Error('해석을 받지 못했습니다. 다시 시도해 주세요.');
  return text.trim();
}

/* 받은 글을 표로 그린다. **제목** 줄은 띠로, 나머지 줄은 글머리 기호(•)가 붙은 한 줄 항목으로.
   줄 사이 구분선은 CSS가 그린다 */
function aiToHtml(text) {
  const rows = [];
  for (const raw of String(text).split('\n')) {
    // AI가 목록 기호(-, •, 1.)나 세로줄을 붙여 왔으면 떼어 낸다. 기호는 앱이 직접 붙인다
    const line = raw.trim()
      .replace(/^[-•*·]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\s*\|\s*/g, ' ');
    if (!line) continue;

    const head = line.match(/^\*\*(.+?)\*\*:?$/);
    if (head) rows.push(`<tr class="ai-sec"><th>${esc(head[1].trim())}</th></tr>`);
    else      rows.push(`<tr><td>${esc(line.replace(/\*\*/g, ''))}</td></tr>`);
  }
  return rows.length ? `<table class="ai-table">${rows.join('')}</table>` : esc(text);
}

function showAiText(html, cls) {
  $('#ai-body').innerHTML = cls ? `<p class="${cls}">${html}</p>` : html;
}

function setAiRunning(on) {
  aiRunning = on;
  $('#btn-ai-again').disabled = on;
}

/* force = true 면 저장해 둔 해석을 무시하고 새로 물어본다 (다시 해석 버튼) */
async function openAiPanel(force = false) {
  const p = panes[state.activePane];
  const chart = CHARTS.find(c => c.file === p.file);
  if (!p.file || !p.page || !chart) { toast('먼저 차트를 여세요.'); return; }

  aiCurrent = { file: p.file, pane: state.activePane };
  $('#ai-chart-name').textContent = `${chart.icao} ${chart.no} ${chart.title}`;
  $('#ai-modal').hidden = false;

  const saved = aiNotes[p.file];
  if (saved && !force) { showAiText(aiToHtml(saved)); setAiRunning(false); return; }

  if (!aiKey) {
    showAiText('AI 열쇠가 아직 없습니다.<br>설정(톱니) → <b>AI</b> 칸에서 구글 제미나이 열쇠를 먼저 넣어 주세요.', 'ai-error');
    setAiRunning(false);
    return;
  }
  if (navigator.onLine === false) {
    showAiText('인터넷이 연결되어 있지 않습니다.<br>해석은 인터넷이 있을 때만 받을 수 있습니다. ' +
               '(이미 해석해 둔 차트는 인터넷 없이도 열립니다)', 'ai-error');
    setAiRunning(false);
    return;
  }

  setAiRunning(true);
  showAiText('차트를 읽는 중… (10초쯤 걸립니다)', 'ai-wait');

  try {
    const img = await renderForAi(p);
    const text = await askGemini(chart, img);
    // 창을 닫았거나 그새 다른 차트를 열었으면 화면은 건드리지 않고 저장만 한다
    aiNotes[p.file] = text;
    save(KEY_AI_NOTES, aiNotes);
    panes.forEach((_, k) => updateBar(k));      // 전구에 불을 켠다
    if (aiCurrent?.file === p.file && !$('#ai-modal').hidden) showAiText(aiToHtml(text));
  } catch (err) {
    console.error(err);
    const msg = err instanceof TypeError
      ? '구글 서버에 연결하지 못했습니다. 인터넷 상태를 확인해 주세요.'
      : err.message;
    if (aiCurrent?.file === p.file) showAiText(`<b>해석하지 못했습니다.</b><br>${esc(msg)}`, 'ai-error');
  } finally {
    setAiRunning(false);
  }
}

function renderAiTab() {
  $('#ai-key').value = aiKey;
  const n = Object.keys(aiNotes).length;
  $('#ai-saved-count').textContent = n ? `저장된 해석 ${n}개` : '저장된 해석이 없습니다';
  $('#btn-ai-clear').disabled = !n;
}

/* ── 10. 화면 연결 ────────────────────────────────────────────── */
$('#search').addEventListener('input', e => {
  const q = e.target.value.trim();
  const wasEmpty = !state.query;
  state.query = q;
  renderAll();
  // 자리 잡아 주는 것은 검색을 막 시작한 순간 한 번뿐이다.
  // 한 글자 칠 때마다 하면 사용자가 직접 펴 둔 목록이 자꾸 접히고 스크롤이 튄다
  if (q && wasEmpty) focusChartsSection();
  else if (!q) unfocusChartsSection();
});
$('#btn-search-clear').addEventListener('click', () => {
  $('#search').value = '';
  state.query = '';
  renderAll();
  unfocusChartsSection();
  $('#search').focus();
});

$('#sidebar').addEventListener('click', e => {
  const aptFav = e.target.closest('[data-apt-fav]');
  if (aptFav) {
    const icao = aptFav.dataset.aptFav;
    const at = favAirports.indexOf(icao);
    if (at >= 0) favAirports.splice(at, 1); else favAirports.push(icao);
    save(KEY_APT_FAV, favAirports);
    aptFav.classList.toggle('is-on');
    renderFavAirportChips();
    return;
  }

  const aptSelect = e.target.closest('[data-apt-select]');
  if (aptSelect) { jumpToAirport(aptSelect.dataset.aptSelect); return; }

  const filterBtn = e.target.closest('.apt-filter-btn');
  if (filterBtn) {
    const icao = filterBtn.closest('.apt-filters').dataset.icao;
    state.groupType[icao] = filterBtn.dataset.type;
    renderAll();
    return;
  }

  const star = e.target.closest('[data-star]');
  if (star) {
    const file = star.dataset.star;
    const at = favorites.indexOf(file);
    if (at >= 0) favorites.splice(at, 1); else favorites.push(file);
    save(KEY_FAV, favorites);
    renderAll();
    return;
  }

  const open = e.target.closest('[data-open]');
  if (open) openChart(open.dataset.open);
});

$$('.section-head').forEach(head => {
  head.addEventListener('click', () => {
    head.classList.toggle('collapsed');
    $('#' + head.dataset.toggle).classList.toggle('collapsed');
  });
});

/* 로고를 누르면 화면을 처음 켰을 때 상태로 되돌린다 (2026-08-03 요청).
   되돌리는 것은 '지금 보고 있는 화면'뿐이다 — 넣어둔 차트 PDF, 즐겨찾기, 공항 이름·국가,
   차트 회전 방향, 테마는 건드리지 않는다. 실수로 눌릴 자리라 확인을 한 번 받는다 */
function resetView() {
  panes.forEach((_, i) => closePane(i));

  state.query = '';
  state.split = false;
  state.activePane = 0;
  state.groupType = {};
  $('#search').value = '';

  $('#viewers').classList.remove('split');
  $('#btn-split').classList.remove('is-on');
  viewEl(1).hidden = true;

  state.fullscreen = false;
  state.sidebarWasHidden = false;
  document.body.classList.remove('is-fullscreen');

  $('#settings-modal').hidden = true;
  $('#ai-modal').hidden = true;
  $('#layout').classList.remove('sidebar-hidden');

  // 목록 접힘 상태도 index.html 의 처음 모양대로 (Pinboards만 접혀 있다)
  [['fav-body', true], ['airport-body', false], ['result-body', false]].forEach(([id, folded]) => {
    document.querySelector(`[data-toggle="${id}"]`).classList.toggle('collapsed', folded);
    $('#' + id).classList.toggle('collapsed', folded);
  });

  renderAll();
  $('#sidebar').scrollTop = 0;
}

$('#btn-reset').addEventListener('click', () => {
  if (!confirm('화면을 처음 상태로 되돌릴까요?\n\n(넣어둔 차트와 즐겨찾기·공항 이름·설정은 그대로 있습니다)')) return;
  resetView();
  toast('처음 상태로 되돌렸습니다.');
});

$('#btn-sidebar').addEventListener('click', () =>
  $('#layout').classList.toggle('sidebar-hidden'));
$('#sidebar-scrim').addEventListener('click', () =>
  $('#layout').classList.add('sidebar-hidden'));

/* 손가락으로 목록 열고 닫기 (아이패드·아이폰).
   '열기'는 화면 왼쪽 가장자리에서 시작한 쓸기만 인정한다.
   그래야 차트 위를 손가락으로 미는 동작(이동·확대)과 부딪히지 않는다 */
function attachSidebarSwipe() {
  const layout = $('#layout');
  const EDGE  = SIDEBAR_EDGE;   // 가장자리로 인정하는 폭 (차트 넘기기 쪽과 값을 함께 쓴다)
  const MIN_X = 55;             // 이만큼은 옆으로 그어야 반응한다
  let sx = 0, sy = 0, watching = false;

  document.addEventListener('touchstart', e => {
    watching = false;
    if (e.touches.length !== 1) return;                       // 두 손가락 확대는 건드리지 않는다
    if (!$('#settings-modal').hidden) return;

    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    watching = layout.classList.contains('sidebar-hidden')
      ? sx <= EDGE
      : (sx <= EDGE || !!e.target.closest('#sidebar, #sidebar-scrim'));
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!watching) return;
    watching = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    // 위아래로 그은 것(목록 스크롤)은 무시한다
    if (Math.abs(dx) < MIN_X || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    layout.classList.toggle('sidebar-hidden', dx < 0);
  }, { passive: true });
}

$('#btn-split').addEventListener('click', async () => {
  state.split = !state.split;
  $('#viewers').classList.toggle('split', state.split);
  $('#btn-split').classList.toggle('is-on', state.split);
  viewEl(1).hidden = !state.split;
  if (!state.split) { state.activePane = 0; closePane(1); }
  renderRowStates();
  panes.forEach((_, i) => updateBar(i));
  // 칸의 너비가 바뀌었으므로 화면 맞춤 배율을 다시 계산한다
  for (const i of [0, 1]) if (panes[i].page) await drawPage(i);
});

$('#viewers').addEventListener('click', async e => {
  const view = e.target.closest('.viewer');
  if (!view) return;
  const i = Number(view.dataset.pane);
  const p = panes[i];
  const act = e.target.closest('[data-act]')?.dataset.act;

  switch (act) {
    case 'zoom-in':  await setZoom(i, p.zoom * 1.25); return;
    case 'zoom-out': await setZoom(i, p.zoom / 1.25); return;
    case 'fit':      await setZoom(i, 1); return;
    case 'rotate':
      if (!p.page) return;
      p.rot = (p.rot + 90) % 360;
      p.zoom = 1;
      // 다음에 같은 차트를 열 때도 이 방향으로 보이도록 기억해 둔다
      if (p.file) { rotations[p.file] = p.rot; save(KEY_ROT, rotations); }
      await drawPage(i);
      return;
    case 'prev': await loadPage(i, p.pageNum - 1); return;
    case 'next': await loadPage(i, p.pageNum + 1); return;
    case 'fullscreen': await setFullscreen(i, !state.fullscreen); return;
    case 'ai':
      // 나란히보기에서 오른쪽 칸의 아이콘을 눌렀으면 그 칸을 기준으로 해석한다
      if (state.activePane !== i) { state.activePane = i; panes.forEach((_, k) => updateBar(k)); }
      await openAiPanel();
      return;
    case 'fav': {
      if (!p.file) return;
      const at = favorites.indexOf(p.file);
      if (at >= 0) favorites.splice(at, 1); else favorites.push(p.file);
      save(KEY_FAV, favorites);
      renderAll();
      return;
    }
    case 'close':
      closePane(i);
      renderAll();
      return;
  }

  if (state.split && state.activePane !== i) {
    state.activePane = i;
    panes.forEach((_, k) => updateBar(k));
  }
});

/* 설정 창 — Airport 칸 (공항 이름 · 국가) */
function renderAirportTable() {
  const box = $('#airport-table');
  box.innerHTML = '';
  const codes = Object.keys(airports).filter(c => CHARTS.some(ch => ch.icao === c)).sort();

  if (!codes.length) {
    box.innerHTML = '<p class="empty-note">차트를 먼저 넣으면 공항 목록이 나타납니다.</p>';
    return;
  }
  codes.forEach(icao => {
    const row = document.createElement('div');
    row.className = 'apt-row';
    row.innerHTML = `
      <span class="code">${esc(icao)}</span>
      <input data-apt="${esc(icao)}" data-field="name"    placeholder="공항 이름 (예: Gimpo Intl)">
      <input data-apt="${esc(icao)}" data-field="country" placeholder="국가 (예: Korea)">`;
    row.querySelector('[data-field="name"]').value    = airports[icao].name || '';
    row.querySelector('[data-field="country"]').value = airports[icao].country || '';
    box.appendChild(row);
  });
}

$('#fav-airports').addEventListener('click', e => {
  const chip = e.target.closest('[data-apt-jump]');
  if (!chip) return;
  jumpToAirport(chip.dataset.aptJump);
});

$('#airport-table').addEventListener('input', e => {
  const input = e.target.closest('[data-apt]');
  if (!input) return;
  airports[input.dataset.apt][input.dataset.field] = input.value;
  save(KEY_APT, airports);
  renderAll();
});

/* 설정 창 — Files 칸 (넣어둔 PDF 전체 관리) */

/* 검색창에 적은 말로 걸러낸 목록. 여기서는 파일 이름으로도 찾을 수 있게 한다 */
function filteredFiles() {
  const q = $('#file-search').value.trim().toLowerCase();
  if (!q) return CHARTS;
  return CHARTS.filter(c => matches(c, q) || c.file.toLowerCase().includes(q));
}

function renderFileTable() {
  // 지워진 파일이 선택 상태로 남아 있지 않게 정리한다
  selectedFiles.forEach(f => { if (!CHARTS.some(c => c.file === f)) selectedFiles.delete(f); });

  const list = filteredFiles();
  const box = $('#file-table');
  box.innerHTML = list.length
    ? list.map(c => `
        <label class="file-row">
          <input type="checkbox" data-file="${esc(c.file)}"${selectedFiles.has(c.file) ? ' checked' : ''}>
          <span class="badge badge-${c.type}">${esc(c.type === 'ETC' ? (c.rawType || 'ETC') : c.type)}</span>
          <span class="file-info">
            <span class="file-main">${esc(c.icao)} ${esc(c.no)} ${esc(c.title)}</span>
            <span class="file-sub">${esc(c.file)}</span>
          </span>
          <span class="file-size">${fmtSize(c.size || 0)}</span>
        </label>`).join('')
    : (CHARTS.length
        ? '<p class="empty-note">찾는 차트가 없습니다. 검색어를 확인해보세요.</p>'
        : '<p class="empty-note">아직 넣어둔 차트가 없습니다.<br>오른쪽 위 <b>Upload</b> 를 눌러 차트를 넣어주세요.</p>');

  updateFileTools();
}

function updateFileTools() {
  const list = filteredFiles();
  const bytes = list.reduce((sum, c) => sum + (c.size || 0), 0);
  const picked = selectedFiles.size;
  const searching = list.length !== CHARTS.length;

  $('#file-sum').textContent = CHARTS.length
    ? (searching ? `찾은 ${list.length}개 · ${fmtSize(bytes)}  (전체 ${CHARTS.length}개)`
                 : `전체 ${CHARTS.length}개 · ${fmtSize(bytes)}`)
    : '';

  const del = $('#btn-file-del');
  del.disabled = !picked;
  del.textContent = picked ? `선택 ${picked}개 삭제` : '선택 삭제';

  // 전체 선택은 '지금 보이는 것' 기준이다 (검색으로 걸러 놓고 그것만 지울 수 있도록)
  const all = $('#file-all');
  all.checked = list.length > 0 && picked === list.length;
  all.indeterminate = picked > 0 && picked < list.length;
}

$('#file-table').addEventListener('change', e => {
  const box = e.target.closest('[data-file]');
  if (!box) return;
  if (box.checked) selectedFiles.add(box.dataset.file);
  else selectedFiles.delete(box.dataset.file);
  updateFileTools();
});

$('#file-all').addEventListener('change', e => {
  selectedFiles.clear();
  if (e.target.checked) filteredFiles().forEach(c => selectedFiles.add(c.file));
  $$('#file-table [data-file]').forEach(box => { box.checked = e.target.checked; });
  updateFileTools();
});

/* 검색어를 바꾸면 골라 둔 것을 푼다.
   안 보이는 차트가 선택된 채로 남아 있다가 같이 지워지는 사고를 막기 위함이다 */
$('#file-search').addEventListener('input', () => {
  selectedFiles.clear();
  renderFileTable();
});
$('#btn-file-search-clear').addEventListener('click', () => {
  $('#file-search').value = '';
  selectedFiles.clear();
  renderFileTable();
  $('#file-search').focus();
});

$('#btn-file-del').addEventListener('click', () => removeCharts([...selectedFiles]));

/* 설정 창 열고 닫기 · 탭 바꾸기 */
function showTab(name) {
  $$('#modal-tabs .tab-btn').forEach(b => b.classList.toggle('is-on', b.dataset.tab === name));
  $$('#settings-modal .tab-panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
}

function openSettings(tab = 'airport') {
  $('#file-search').value = '';        // 지난번 검색어가 남아 차트가 안 보이는 일이 없게
  selectedFiles.clear();
  renderAirportTable();
  renderFileTable();
  renderThemeTab();
  renderAiTab();
  showTab(tab);
  $('#settings-modal').hidden = false;
}

$('#btn-settings').addEventListener('click', () => openSettings());
$('#modal-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (btn) showTab(btn.dataset.tab);
});
$('#theme-list').addEventListener('click', e => {
  const btn = e.target.closest('.theme-btn');
  if (btn) applyTheme(btn.dataset.themeSet);
});
$('#settings-modal').addEventListener('click', e => {
  if (e.target.id === 'settings-modal' || e.target.closest('[data-close-modal]'))
    $('#settings-modal').hidden = true;
});

/* 설정 창 — AI 칸 (열쇠 넣기 · 저장된 해석 지우기) */
$('#ai-key').addEventListener('input', e => {
  aiKey = e.target.value.trim();
  save(KEY_AI_KEY, aiKey);
});

$('#btn-ai-clear').addEventListener('click', () => {
  const n = Object.keys(aiNotes).length;
  if (!n) return;
  if (!confirm(`저장해 둔 해석 ${n}개를 모두 지웁니다.\n다시 보려면 인터넷에 연결해 새로 받아야 합니다.`)) return;
  aiNotes = {};
  save(KEY_AI_NOTES, aiNotes);
  renderAiTab();
  panes.forEach((_, k) => updateBar(k));
  toast('저장된 해석을 모두 지웠습니다.');
});

/* AI 해석 창 */
$('#ai-modal').addEventListener('click', e => {
  if (e.target.id === 'ai-modal' || e.target.closest('[data-close-ai]'))
    $('#ai-modal').hidden = true;
});
$('#btn-ai-again').addEventListener('click', () => { if (!aiRunning) openAiPanel(true); });

/* PDF 넣기 */
$('#btn-add').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async e => {
  await addFiles(e.target.files);
  e.target.value = '';          // 같은 파일을 다시 골라도 반응하도록 비워 둔다
});

/* PC에서는 창에 파일을 끌어다 놓아도 들어가게 */
['dragover', 'drop'].forEach(ev =>
  document.addEventListener(ev, e => { e.preventDefault(); }));
document.addEventListener('drop', e => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* 창 크기가 바뀌면 화면 맞춤 배율을 다시 계산 */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    panes.forEach((p, i) => { if (p.page && p.zoom === 1) drawPage(i); });
  }, 200);
});

/* ── 11. 잔심부름 ─────────────────────────────────────────────── */
let toastTimer;
function toast(html) {
  const el = $('#toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function busy(text) {
  const el = $('#busy');
  if (!text) { el.hidden = true; return; }
  $('#busy-text').textContent = text;
  el.hidden = false;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + 'GB';
  if (bytes >= 1024 * 1024)        return Math.round(bytes / 1024 / 1024) + 'MB';
  return Math.max(1, Math.round(bytes / 1024)) + 'KB';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/* ── 12. 시작 ─────────────────────────────────────────────────── */

/* 인터넷 없이 열리게 해 주는 도우미를 등록한다.
   등록에 실패해도(파일 직접 열기 등) 앱 자체는 그대로 동작한다 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url))
      .catch(err => console.warn('오프라인 준비를 하지 못했습니다:', err));
  });
}

/* 아이패드가 저장 공간이 모자랄 때 우리 차트를 멋대로 지우지 않도록 요청한다.
   홈 화면에 추가한 앱에서는 대개 허락된다 */
navigator.storage?.persist?.()
  .then(ok => console.log(ok ? '차트 보관이 보호됩니다' : '보관 보호가 허락되지 않았습니다'))
  .catch(() => {});

/* 머리말 코드가 막혀 있었을 경우를 대비해 한 번 더 맞춰 준다 */
applyTheme(theme);

[0, 1].forEach(i => { attachPinch(i); attachPan(i); attachChartSwipe(i); });
attachSidebarSwipe();
refreshLibrary().catch(err => {
  console.error(err);
  toast('저장 공간을 열지 못했습니다. 브라우저의 시크릿 모드에서는 동작하지 않습니다.');
});
