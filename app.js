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
const NAME_RE = /^([A-Za-z0-9]+)_\[([^\]]+)\]\s*([^_]*)_(.+)$/;

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
  groupType: {}          // 공항(ICAO)별로 따로 고르는 종류 필터. 비어 있으면 'ALL'
};

function newPane() {
  return {
    file: null, doc: null, page: null, loading: null,
    pageNum: 1, numPages: 1,
    zoom: 1, rot: 0, fitScale: 1,
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
            title="즐겨찾기">${isFav ? '★' : '☆'}</button>
    <button class="del-btn" data-del="${esc(chart.file)}" title="이 차트 지우기">🗑</button>`;
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
          : '<p class="empty-note">아직 넣어둔 차트가 없습니다.<br>오른쪽 위 <b>＋ PDF 추가</b>를 눌러 차트를 넣어주세요.</p>');
  }

  const favList = CHARTS.filter(c => favorites.includes(c.file));
  renderGroupedList($('#fav-body'), favList);
  $('#fav-count').textContent = favorites.filter(f => CHARTS.some(c => c.file === f)).length;
  if (!favList.length) {
    $('#fav-body').innerHTML = '<p class="empty-note">차트 옆 ☆ 을 누르면 여기에 담깁니다.</p>';
  }

  const bytes = CHARTS.reduce((sum, c) => sum + (c.size || 0), 0);
  $('#store-info').textContent = CHARTS.length
    ? `차트 ${CHARTS.length}개 · ${fmtSize(bytes)}${storageNote}`
    : '';

  renderFavAirportChips();
  panes.forEach((_, i) => updateBar(i));
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

  view.querySelector('.viewer-title').textContent = chart
    ? `${chart.icao}  ${chart.no}  ${chart.title}`
    : '차트를 선택하세요';

  const favBtn = view.querySelector('[data-act="fav"]');
  favBtn.classList.toggle('is-fav', !!isFav);
  favBtn.textContent = isFav ? '★' : '☆';

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

/* 화면 맞춤 배율로 되돌아갈 때와 확대할 때 모두 이 함수로 다시 그린다 */
async function drawPage(i) {
  const p = panes[i];
  if (!p.page) return;

  const token = ++p.token;
  if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }

  const body = bodyEl(i);
  const canvas = canvasEl(i);
  const base = p.page.getViewport({ scale: 1, rotation: p.rot });

  const availW = Math.max(80, body.clientWidth  - 16);
  const availH = Math.max(80, body.clientHeight - 16);
  p.fitScale = Math.min(availW / base.width, availH / base.height);

  const cssW = base.width  * p.fitScale * p.zoom;
  const cssH = base.height * p.fitScale * p.zoom;

  // 화면 픽셀 밀도까지 반영해야 글자가 또렷하다
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = p.fitScale * p.zoom * dpr;

  // 캔버스가 너무 크면 아이패드에서 아예 그려지지 않으므로 상한을 둔다
  const MAX_PX = 12e6;
  if (base.width * scale * base.height * scale > MAX_PX) {
    scale = Math.sqrt(MAX_PX / (base.width * base.height));
  }

  const vp = p.page.getViewport({ scale, rotation: p.rot });
  canvas.width  = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  canvas.style.width  = Math.round(cssW) + 'px';
  canvas.style.height = Math.round(cssH) + 'px';
  canvas.style.transform = '';

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  p.task = p.page.render({ canvasContext: ctx, viewport: vp });
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
  p.pageNum = Math.min(Math.max(1, num), p.numPages);
  p.page = await p.doc.getPage(p.pageNum);
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
    p.rot = 0;
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

async function removeChart(file) {
  const c = CHARTS.find(x => x.file === file);
  const label = c ? `${c.icao} ${c.no} ${c.title}` : file;
  if (!confirm(`이 차트를 지울까요?\n\n${label}\n\n(원본 PDF 파일은 그대로 있습니다)`)) return;

  await deleteFile(file);
  favorites = favorites.filter(f => f !== file);
  save(KEY_FAV, favorites);
  panes.forEach((p, i) => { if (p.file === file) closePane(i); });
  await refreshLibrary();
  toast('차트를 지웠습니다.');
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
  const filterBtn = e.target.closest('.apt-filter-btn');
  if (filterBtn) {
    const icao = filterBtn.closest('.apt-filters').dataset.icao;
    state.groupType[icao] = filterBtn.dataset.type;
    renderAll();
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del) { removeChart(del.dataset.del); return; }

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
      await drawPage(i);
      return;
    case 'prev': await loadPage(i, p.pageNum - 1); return;
    case 'next': await loadPage(i, p.pageNum + 1); return;
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

/* 공항 정보 */
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
              title="공항 즐겨찾기">${isFav ? '★' : '☆'}</button>
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
  favBtn.textContent = favAirports.includes(icao) ? '★' : '☆';
  renderFavAirportChips();
});

$('#fav-airports').addEventListener('click', e => {
  const chip = e.target.closest('[data-apt-jump]');
  if (!chip) return;
  $('#search').value = chip.dataset.aptJump;
  state.query = chip.dataset.aptJump;
  renderAll();
});

$('#airport-table').addEventListener('input', e => {
  const input = e.target.closest('[data-apt]');
  if (!input) return;
  airports[input.dataset.apt][input.dataset.field] = input.value;
  save(KEY_APT, airports);
  renderAll();
});

/* focusIcao 를 주면 그 공항 칸으로 스크롤해서 바로 입력하게 한다 */
function openAirportModal(focusIcao) {
  renderAirportTable();
  $('#airport-modal').hidden = false;
  if (!focusIcao) return;
  const input = $(`#airport-table [data-apt="${CSS.escape(focusIcao)}"][data-field="name"]`);
  if (!input) return;
  input.closest('.apt-row').classList.add('is-target');
  input.scrollIntoView({ block: 'center' });
  input.focus();
}

$('#btn-airports').addEventListener('click', () => openAirportModal());
$('#airport-modal').addEventListener('click', e => {
  if (e.target.id === 'airport-modal' || e.target.closest('[data-close-modal]'))
    $('#airport-modal').hidden = true;
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

[0, 1].forEach(i => { attachPinch(i); attachPan(i); });
refreshLibrary().catch(err => {
  console.error(err);
  toast('저장 공간을 열지 못했습니다. 브라우저의 시크릿 모드에서는 동작하지 않습니다.');
});
