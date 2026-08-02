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
  fullscreen: false,     // 전체 화면 보기 (상단 바·사이드바를 감추고 차트 하나만 채움)
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
  groupByAirport(list).forEach((charts, icao) => {
    const apt = airports[icao] || {};
    const label = [apt.name, apt.country].filter(Boolean).join(' · ');

    const group = document.createElement('div');
    group.className = 'apt-group';

    // 공항 코드 + 종류 필터는 스크롤해도 위에 붙어 있도록 한 덩어리로 묶는다
    const head = document.createElement('div');
    head.className = 'apt-head-sticky';
    // 이름·국가 입력은 상단 [공항 정보] 창에서만 한다 (목록 머리글을 눌러 여는 기능은 없앰)
    head.innerHTML = `<div class="apt-head">
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
}

function renderAll() {
  const q = state.query;
  const searchList = q ? CHARTS.filter(c => matches(c, q)) : [];

  renderGroupedList($('#result-body'), searchList, { withFilter: true });
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
    return `<button class="airport-row" data-apt-select="${esc(icao)}">
        <span class="apt-icao">${esc(icao)}</span>
        ${label
          ? `<span class="apt-name">${esc(label)}</span>`
          : '<span class="apt-name apt-empty">이름 미입력</span>'}
      </button>`;
  }).join('');
}

/* 공항을 골랐을 때(Airport 탭이든 위쪽 즐겨찾기 칩이든) 공통으로 하는 일:
   그 공항으로 검색하고, Airport 탭은 닫고 Charts 탭을 편다 */
function jumpToAirport(icao) {
  $('#search').value = icao;
  state.query = icao;
  renderAll();

  const airportHead = document.querySelector('[data-toggle="airport-body"]');
  airportHead.classList.add('collapsed');
  $('#airport-body').classList.add('collapsed');

  const resultHead = document.querySelector('[data-toggle="result-body"]');
  resultHead.classList.remove('collapsed');
  $('#result-body').classList.remove('collapsed');

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

  // 파일 이름 맨 앞에 종류(SID/STAR/APP/TAXI/etc) 배지를 붙여, 지금 보는 차트가 어떤 종류인지 바로 보이게 한다
  view.querySelector('.viewer-title').innerHTML = chart
    ? `<span class="badge badge-${chart.type}">${esc(chart.type === 'ETC' ? (chart.rawType || 'ETC') : chart.type)}</span>` +
      `<span class="viewer-title-text">${esc(chart.icao)}  ${esc(chart.no)}  ${esc(chart.title)}</span>`
    : '<span class="viewer-title-text">차트를 선택하세요</span>';

  const favBtn = view.querySelector('[data-act="fav"]');
  favBtn.classList.toggle('is-fav', !!isFav);
  favBtn.innerHTML = pinIcon();

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

  if (window.innerWidth <= 900) $('#layout').classList.add('sidebar-hidden');
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

/* 같은 공항의 차트 목록(전체 종류, CHARTS의 정렬 순서 그대로) 안에서 이전·다음으로 넘어간다.
   dir 은 -1(이전) 또는 1(다음) */
function stepChart(i, dir) {
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
  openChart(next.file);
}

/* 차트가 화면 맞춤(100%) 배율일 때는 가로로 넘칠 내용이 없어 좌우 스와이프가 그냥 버려지므로,
   그 손짓을 이전·다음 차트 넘기기로 대신 쓴다. 확대돼 있으면(스크롤이 필요하면) 평소처럼 스와이프로
   화면을 옮긴다 (2026-08-02 요청) */
function attachChartSwipe(i) {
  const body = bodyEl(i);
  const MIN_X = 50;      // 이만큼은 옆으로 그어야 넘긴다
  let sx = 0, sy = 0, watching = false;

  body.addEventListener('touchstart', e => {
    const p = panes[i];
    watching = e.touches.length === 1 && !!p.page && p.zoom === 1;
    if (!watching) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });

  body.addEventListener('touchend', e => {
    if (!watching) return;
    watching = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    // 위아래로 그은 것은 무시한다
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
    panes.forEach((p, i) => { if (p.file === file) closePane(i); });
  }
  favorites = favorites.filter(f => !files.includes(f));
  save(KEY_FAV, favorites);
  save(KEY_ROT, rotations);
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

/* ── 10. 화면 연결 ────────────────────────────────────────────── */
$('#search').addEventListener('input', e => {
  state.query = e.target.value.trim();
  renderAll();
});
$('#btn-search-clear').addEventListener('click', () => {
  $('#search').value = '';
  state.query = '';
  renderAll();
  $('#search').focus();
});

$('#sidebar').addEventListener('click', e => {
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

$('#btn-sidebar').addEventListener('click', () =>
  $('#layout').classList.toggle('sidebar-hidden'));
$('#sidebar-scrim').addEventListener('click', () =>
  $('#layout').classList.add('sidebar-hidden'));

/* 손가락으로 목록 열고 닫기 (아이패드·아이폰).
   '열기'는 화면 왼쪽 가장자리에서 시작한 쓸기만 인정한다.
   그래야 차트 위를 손가락으로 미는 동작(이동·확대)과 부딪히지 않는다 */
function attachSidebarSwipe() {
  const layout = $('#layout');
  const EDGE  = 34;   // 가장자리로 인정하는 폭
  const MIN_X = 55;   // 이만큼은 옆으로 그어야 반응한다
  let sx = 0, sy = 0, watching = false;

  document.addEventListener('touchstart', e => {
    watching = false;
    if (e.touches.length !== 1) return;                       // 두 손가락 확대는 건드리지 않는다
    if (document.body.classList.contains('is-fullscreen')) return;
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
    case 'fullscreen': {
      state.fullscreen = !state.fullscreen;
      if (state.fullscreen) state.activePane = i;
      document.body.classList.toggle('is-fullscreen', state.fullscreen);
      panes.forEach((_, k) => updateBar(k));
      // 칸 크기가 바뀌었으니 화면 맞춤 배율을 다시 계산해서 다시 그린다
      for (const k of [0, 1]) if (panes[k].page) await drawPage(k);
      return;
    }
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
    const isFav = favAirports.includes(icao);
    row.innerHTML = `
      <button class="apt-fav-toggle${isFav ? ' is-on' : ''}" data-apt-fav="${esc(icao)}"
              title="공항 즐겨찾기">${pinIcon()}</button>
      <span class="code">${esc(icao)}</span>
      <input data-apt="${esc(icao)}" data-field="name"    placeholder="공항 이름 (예: Gimpo Intl)">
      <input data-apt="${esc(icao)}" data-field="country" placeholder="국가 (예: Korea)">`;
    row.querySelector('[data-field="name"]').value    = airports[icao].name || '';
    row.querySelector('[data-field="country"]').value = airports[icao].country || '';
    box.appendChild(row);
  });
}

$('#airport-table').addEventListener('click', e => {
  const favBtn = e.target.closest('[data-apt-fav]');
  if (!favBtn) return;
  const icao = favBtn.dataset.aptFav;
  const at = favAirports.indexOf(icao);
  if (at >= 0) favAirports.splice(at, 1); else favAirports.push(icao);
  save(KEY_APT_FAV, favAirports);
  favBtn.classList.toggle('is-on');
  favBtn.innerHTML = pinIcon();
  renderFavAirportChips();
});

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
