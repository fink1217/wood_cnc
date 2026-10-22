import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  buildRack, deriveLayout, autoMounts, validateMount, normalizeParams,
  DEFAULTS, BASIC_SPEC, LINKED_BASIC_SPEC, CHOICE_SPEC, ADVANCED_SPEC, ASSEMBLY_SPEC, NAMEPLATE_MODES, NAMEPLATE_SHAPES,
} from './rack.js';
import { layoutParts, flatten, toSVG, toDXF, toBOM, makeZip, KIND_NAMES } from './export.js';
import { calculatorUrl } from './calculator-link.js';
import { loadImage, readFileAsDataURL, textCanvas, rasterize, cropMask, maskToArtwork } from './artwork.js';

const LINKED_SPECS = [...LINKED_BASIC_SPEC, ...ADVANCED_SPEC];

const STORE_KEY = 'paintRack.v2';
const $ = (id) => document.getElementById(id);
const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ---------- 狀態 ----------
const state = {
  params: { ...DEFAULTS },
  mounts: [],
  nextId: 1,
  selected: null,
  explode: 0,
  showCans: true,
  showDims: true,
  // 展示名牌：image 為使用者匯入的圖片（縮小後的 data URL），沒有圖片時用文字
  nameplate: { enabled: false, mode: 'laser', shape: 'rect', height: 60, width: null, offset: 0, text: 'PAINT', threshold: 128, invert: false, image: null },
  // 每種顏料各自的名牌：items[k] = { on, text, offset }，可各自關閉、各自左右移；width 空白 = 滿寬
  labels: { enabled: false, mode: 'laser', height: 18, width: null, items: [] },
  selectedSign: null, // 'top' 或顏料編號：正在左右移的名牌
};

// 名牌圖案處理結果（由 updateArtwork 產生）：'top' 為頂端名牌，'label:k' 為第 k 種顏料
const EMPTY_ART = { art: null, canvas: null, dataUrl: null, empty: true };
const artCache = new Map();
let artwork = EMPTY_ART;
const artFor = (part) => artCache.get(part.artKey) || EMPTY_ART;
const labelText = (k) => state.labels.items[k]?.text?.trim() || `顏料 ${k + 1}`;
const labelOn = (k) => state.labels.items[k]?.on !== false;
// 送進 rack.js 的參數：有任何顏料名牌開啟時，前緣留邊會自動加寬
const rackInput = () => ({ ...state.params, labelsOn: state.labels.enabled && kindsCount() > 0 && [...Array(kindsCount()).keys()].some(labelOn) });
const kindsCount = () => normalizeParams(state.params).kinds;
loadState();

let rack = null;
let layout = null;

// ---------- 場景 ----------
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);

const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 1 }));
wall.receiveShadow = true;
scene.add(wall);
let wallGrid = null;

const partsGroup = new THREE.Group();
const cansGroup = new THREE.Group();
const mountsGroup = new THREE.Group();
const overlayGroup = new THREE.Group();
scene.add(partsGroup, cansGroup, mountsGroup, overlayGroup);

const tc = new TransformControls(camera, renderer.domElement);
tc.showZ = false;
tc.setSize(0.8);
tc.setSpace('world');
scene.add(tc);
// 名牌拖拉：座標軸掛在一個代理物件上，只開放 X（左右）方向
const signProxy = new THREE.Object3D();
scene.add(signProxy);
let signDrag = null; // { key: 'top' | 顏料編號, startX, startOffset, maxOffset, offset }

tc.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (e.value) return;
  if (signDrag) commitSignOffset();
  saveState();
  rebuild();
});
tc.addEventListener('objectChange', () => (tc.object === signProxy ? onSignDrag() : onMountDrag()));

const KIND_COLORS = {
  side: 0xd9b48a, back: 0xc49a6c, shelf: 0xe4c49c, holeplate: 0xebd2ae, top: 0xe4c49c, clip: 0x6f9bd1, splice: 0x5fb08a,
  nameplate: 0xe8cfa8, label: 0xf0dcbc,
};
const materials = {};
for (const [k, c] of Object.entries(KIND_COLORS)) materials[k] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x5a4632, transparent: true, opacity: 0.45 });
const hoverMat = new THREE.MeshStandardMaterial({ color: 0xffb35c, roughness: 0.6, emissive: 0x442200 });

// ---------- 建構 ----------
function partMesh(part) {
  const shape = new THREE.Shape(part.outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of part.holes) {
    const path = new THREE.Path();
    if (h.type === 'circle') path.absarc(h.c[0], h.c[1], h.r, 0, Math.PI * 2, true);
    else path.setFromPoints(h.pts.map(([x, y]) => new THREE.Vector2(x, y)));
    shape.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: part.t, bevelEnabled: false, curveSegments: 40 });
  const mesh = new THREE.Mesh(geo, materials[part.kind]);
  mesh.castShadow = mesh.receiveShadow = true;
  const U = new THREE.Vector3(...part.U), V = new THREE.Vector3(...part.V);
  const W = new THREE.Vector3().crossVectors(U, V);
  mesh.applyMatrix4(new THREE.Matrix4().makeBasis(U, V, W).setPosition(...part.origin));
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat));
  mesh.userData.part = part;
  // 名牌雕刻預覽：把黑白圖案貼在前表面（鏤空模式直接用幾何開孔呈現）
  const aw = artFor(part);
  if (part.artRect && part.artMode !== 'cut' && aw.canvas) {
    const r = part.artRect;
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(r.w, r.h),
      new THREE.MeshStandardMaterial({
        color: part.artMode === 'laser' ? 0x4a2c16 : 0x7a5634, roughness: 0.95, transparent: true, alphaMap: invertedAlpha(aw.canvas),
      }),
    );
    decal.position.set(r.x + r.w / 2, r.y + r.h / 2, part.t + 0.2);
    decal.raycast = () => {}; // 不參與滑鼠選取
    mesh.add(decal);
  }
  const wrap = new THREE.Group();
  wrap.add(mesh);
  wrap.userData.part = part;
  return wrap;
}

// 黑白圖 → alpha：墨色（黑）不透明、背景透明，看起來像燒刻的痕跡
function invertedAlpha(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.filter = 'invert(1)';
  ctx.drawImage(canvas, 0, 0);
  return new THREE.CanvasTexture(c);
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isCSS2DObject) o.element.remove();
  });
  group.clear();
}

let firstBuild = true;

function rebuild() {
  rack = buildRack(rackInput(), state.mounts, {
    nameplate: { ...state.nameplate, art: artwork.art },
    labels: {
      ...state.labels,
      items: Array.from({ length: kindsCount() }, (_, k) => ({
        on: labelOn(k), art: artCache.get(`label:${k}`)?.art || null, offset: state.labels.items[k]?.offset || 0,
      })),
    },
  });
  const L = rack.layout;

  if (tc.object) tc.detach();
  disposeGroup(partsGroup);
  for (const part of rack.parts) partsGroup.add(partMesh(part));
  applyExplode();

  disposeGroup(cansGroup);
  const canGeo = new THREE.CylinderGeometry(1, 1, 1, 40);
  for (const c of rack.cans) {
    const hue = (c.kind * 0.618034) % 1;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.55, 0.55), roughness: 0.4, metalness: 0.1 });
    const m = new THREE.Mesh(canGeo, mat);
    m.scale.set(c.r, c.h, c.r);
    m.position.set(c.x, c.y + c.h / 2, c.z);
    m.castShadow = true;
    cansGroup.add(m);
  }
  cansGroup.visible = state.showCans;

  // 牆面
  const span = Math.max(L.totalW, L.totalH);
  wall.scale.set(L.totalW + span, L.totalH + span, 1);
  wall.position.set(L.totalW / 2, L.totalH / 2, -0.5);
  if (wallGrid) { scene.remove(wallGrid); wallGrid.geometry.dispose(); }
  const gsize = Math.ceil((span * 2) / 100) * 100;
  wallGrid = new THREE.GridHelper(gsize, gsize / 50, 0xbab3a6, 0xcdc7bc);
  wallGrid.rotation.x = Math.PI / 2;
  wallGrid.position.set(L.totalW / 2, L.totalH / 2, -0.2);
  scene.add(wallGrid);

  sun.position.set(L.totalW * 0.2 + span, L.totalH + span, span * 1.5);
  sun.target.position.set(L.totalW / 2, L.totalH / 2, 0);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -span * 1.2;
  sc.right = sc.top = span * 1.2;
  sc.near = 1; sc.far = span * 6;
  sc.updateProjectionMatrix();

  layout = layoutParts(rack.parts, rack.params);
  $('layout-info').textContent = `排版：${layout.sheets.length} 張 ${rack.params.sheetW}×${rack.params.sheetH} 板材、共 ${rack.parts.length} 件` +
    (layout.warnings.length ? `（${layout.warnings.length} 件超過板材）` : '');

  buildMountSpheres();
  updateOverlay();
  renderSidebar();
  renderConnectors();
  renderBOM();
  renderNameplateStatus();
  updateFieldNotes();

  // 重建後保留名牌的選取狀態，可以接著拖
  if (state.selectedSign != null) {
    const p = state.explode === 0 && signParts(state.selectedSign)[0];
    if (p) selectSign(p); else clearSignSelection();
  }

  if (firstBuild) { setView('iso'); firstBuild = false; }
}

function applyExplode() {
  if (!rack) return;
  const L = rack.layout;
  const f = state.explode;
  for (const wrap of partsGroup.children) {
    const p = wrap.userData.part;
    const [i, j] = p.module;
    const md = [(i - (L.mx - 1) / 2) * L.W * 0.5, (j - (L.my - 1) / 2) * L.H * 0.35, 0];
    wrap.position.set(
      (p.explode[0] * 70 + md[0]) * f,
      (p.explode[1] * 70 + md[1]) * f,
      (p.explode[2] * 70 + md[2]) * f,
    );
  }
  cansGroup.visible = state.showCans && f === 0;
}

// ---------- 掛點 ----------
const sphereGeo = new THREE.SphereGeometry(1, 24, 16);
const sphereMats = {
  ok: new THREE.MeshBasicMaterial({ color: 0xd9822b, depthTest: false }),
  bad: new THREE.MeshBasicMaterial({ color: 0xd6453d, depthTest: false }),
  sel: new THREE.MeshBasicMaterial({ color: 0xffc061, depthTest: false }),
};

function mountZ() { return rack.layout.inset + rack.layout.t + 0.5; }

function buildMountSpheres() {
  disposeGroup(mountsGroup);
  const L = rack.layout;
  const rad = Math.max(5, Math.max(L.totalW, L.totalH) * 0.012);
  for (const m of state.mounts) {
    const v = validateMount(L, m.x, m.y);
    const s = new THREE.Mesh(sphereGeo, m.id === state.selected ? sphereMats.sel : v.valid ? sphereMats.ok : sphereMats.bad);
    s.scale.setScalar(rad);
    s.position.set(m.x, m.y, mountZ());
    s.renderOrder = 10;
    s.userData.mountId = m.id;
    const tag = label(`#${m.id}`, 'mount-tag');
    tag.position.set(0, 1.9, 0);
    s.add(tag);
    mountsGroup.add(s);
    if (m.id === state.selected) tc.attach(s);
  }
}

function snapValue(v) {
  const g = state.params.gridSnap;
  return g > 0 ? Math.round(v / g) * g : Math.round(v * 10) / 10;
}

function onMountDrag() {
  const s = tc.object;
  if (!s) return;
  const L = rack.layout;
  const m = state.mounts.find((q) => q.id === s.userData.mountId);
  if (!m) return;
  // 只對正在拖拉的軸做吸附，另一軸維持原值
  const axis = tc.axis || 'XY';
  if (axis.includes('X')) m.x = Math.min(L.totalW, Math.max(0, snapValue(s.position.x)));
  if (axis.includes('Y')) m.y = Math.min(L.totalH, Math.max(0, snapValue(s.position.y)));
  s.position.set(m.x, m.y, mountZ());
  s.material = validateMount(L, m.x, m.y).valid ? sphereMats.sel : sphereMats.bad;
  updateOverlay();
  renderMounts();
}

// ---------- 名牌左右移 ----------
const signKey = (part) => (part.kind === 'nameplate' ? 'top' : part.labelKind);
const signParts = (key) => rack.parts.filter((p) => (key === 'top' ? p.kind === 'nameplate' : p.kind === 'label' && p.labelKind === key));
const signOffset = (key) => (key === 'top' ? state.nameplate.offset : state.labels.items[key]?.offset) || 0;

function selectSign(part) {
  state.selected = null;
  state.selectedSign = signKey(part);
  tc.detach();
  buildMountSpheres();
  const U = part.U, V = part.V, b = part.bounds;
  const u = (b.minX + b.maxX) / 2, v = (b.minY + b.maxY) / 2;
  signProxy.position.set(...part.origin.map((o, k) => o + u * U[k] + v * V[k] + (k === 2 ? part.t + 2 : 0)));
  signDrag = { key: state.selectedSign, startX: signProxy.position.x, startOffset: part.span.offset, maxOffset: part.span.maxOffset, offset: part.span.offset };
  tc.showY = false;
  tc.attach(signProxy);
  updateOverlay();
  renderMounts();
  renderSignOffsets();
}

function onSignDrag() {
  const d = signDrag;
  if (!d) return;
  const want = d.startOffset + (signProxy.position.x - d.startX);
  d.offset = Math.round(Math.min(d.maxOffset, Math.max(-d.maxOffset, want)));
  signProxy.position.x = d.startX + (d.offset - d.startOffset);
  // 預覽：直接平移名牌，放開後才重建（榫槽跟著移）
  for (const w of partsGroup.children) {
    const p = w.userData.part;
    if ((p.kind === 'nameplate' || p.kind === 'label') && signKey(p) === d.key) w.position.x = d.offset - d.startOffset;
  }
  renderSignOffsets(d);
}

function commitSignOffset() {
  const { key, offset } = signDrag;
  if (key === 'top') state.nameplate.offset = offset;
  else (state.labels.items[key] ||= {}).offset = offset;
  signDrag = null;
  syncSignInputs();
}

function clearSignSelection() {
  state.selectedSign = null;
  signDrag = null;
  if (tc.object === signProxy) tc.detach();
  tc.showY = true;
}

function selectMount(id) {
  clearSignSelection();
  state.selected = id;
  tc.detach();
  for (const s of mountsGroup.children) {
    const m = state.mounts.find((q) => q.id === s.userData.mountId);
    const valid = validateMount(rack.layout, m.x, m.y).valid;
    s.material = s.userData.mountId === id ? sphereMats.sel : valid ? sphereMats.ok : sphereMats.bad;
    if (s.userData.mountId === id) tc.attach(s);
  }
  updateOverlay();
  renderMounts();
}

function addMount(x, y) {
  const L = rack.layout;
  if (x == null) {
    // 找一個有效的位置：從頂端中間往下掃
    const cand = autoMounts(L);
    const free = cand.find((c) => !state.mounts.some((m) => Math.hypot(m.x - c.x, m.y - c.y) < 20)) || { x: L.totalW / 2, y: L.totalH / 2 };
    x = free.x; y = free.y;
  }
  const m = { id: state.nextId++, x, y };
  state.mounts.push(m);
  state.selected = m.id;
  saveState();
  rebuild();
}

function removeMount(id) {
  state.mounts = state.mounts.filter((m) => m.id !== id);
  if (state.selected === id) state.selected = null;
  saveState();
  rebuild();
}

function resetMounts() {
  const L = deriveLayout(rackInput());
  state.nextId = 1;
  state.mounts = autoMounts(L).map((p) => ({ id: state.nextId++, ...p }));
  state.selected = null;
}

// ---------- 尺寸線與標籤 ----------
function label(text, cls = '') {
  const el = document.createElement('div');
  el.className = 'dim-label ' + cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

const lineMats = {
  dim: new THREE.LineBasicMaterial({ color: 0x3a6fd8, depthTest: false, transparent: true }),
  pair: new THREE.LineDashedMaterial({ color: 0xd9822b, dashSize: 6, gapSize: 4, depthTest: false, transparent: true }),
  edge: new THREE.LineDashedMaterial({ color: 0x3a6fd8, dashSize: 4, gapSize: 4, depthTest: false, transparent: true }),
};

function addLine(a, b, mat, text, cls) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  const line = new THREE.Line(g, mat);
  line.renderOrder = 9;
  if (mat.isLineDashedMaterial) line.computeLineDistances();
  overlayGroup.add(line);
  if (text) {
    const l = label(text, cls);
    l.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    overlayGroup.add(l);
  }
}

function updateOverlay() {
  disposeGroup(overlayGroup);
  if (!rack) return;
  const L = rack.layout;
  const z = mountZ();

  if (state.showDims) {
    const off = Math.max(25, L.totalW * 0.05);
    const zf = L.depth;
    // 寬
    addLine([0, -off, zf], [L.totalW, -off, zf], lineMats.dim, `寬 ${fmt(L.totalW)}`);
    addLine([0, -off - 6, zf], [0, -off + 6, zf], lineMats.dim);
    addLine([L.totalW, -off - 6, zf], [L.totalW, -off + 6, zf], lineMats.dim);
    // 高
    addLine([-off, 0, zf], [-off, L.totalH, zf], lineMats.dim, `高 ${fmt(L.totalH)}`);
    addLine([-off - 6, 0, zf], [-off + 6, 0, zf], lineMats.dim);
    addLine([-off - 6, L.totalH, zf], [-off + 6, L.totalH, zf], lineMats.dim);
    // 深
    addLine([L.totalW + off, 0, 0], [L.totalW + off, 0, L.depth], lineMats.dim, `深 ${fmt(L.depth)}`);
  }

  // 掛點之間：最小生成樹的邊（只標示相鄰的掛點）
  for (const [a, b] of mountPairs()) {
    addLine([a.x, a.y, z], [b.x, b.y, z], lineMats.pair, `${fmt(Math.hypot(b.x - a.x, b.y - a.y))}`, 'soft');
  }

  // 選取的掛點：到各邊距離
  const m = state.mounts.find((q) => q.id === state.selected);
  if (m) {
    addLine([0, m.y, z], [m.x, m.y, z], lineMats.edge, `←${fmt(m.x)}`);
    addLine([m.x, m.y, z], [L.totalW, m.y, z], lineMats.edge, `${fmt(L.totalW - m.x)}→`);
    addLine([m.x, m.y, z], [m.x, L.totalH, z], lineMats.edge, `↑${fmt(L.totalH - m.y)}`);
    addLine([m.x, 0, z], [m.x, m.y, z], lineMats.edge, `↓${fmt(m.y)}`);
  }
}

// 以 Prim 演算法求掛點的最小生成樹，回傳相鄰掛點對
function mountPairs() {
  const pts = state.mounts;
  if (pts.length < 2) return [];
  const inTree = [0];
  const pairs = [];
  while (inTree.length < pts.length) {
    let best = null;
    for (const a of inTree) {
      for (let b = 0; b < pts.length; b++) {
        if (inTree.includes(b)) continue;
        const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
        if (!best || d < best.d - 1e-9) best = { a, b, d };
      }
    }
    inTree.push(best.b);
    const [p, q] = [pts[best.a], pts[best.b]].sort((m, n) => m.x - n.x || m.y - n.y);
    pairs.push([p, q]);
  }
  return pairs.sort(([a], [b]) => b.y - a.y || a.x - b.x);
}

// ---------- 側欄 ----------
const fieldHTML = (spec, value, extra = '') => `
  <label class="field" data-field="${spec.key}">
    <span>${spec.label}<small class="note" id="note-${spec.key}">${spec.hint || ''}</small></span>
    <span class="input"><input type="number" id="param-${spec.key}" data-key="${spec.key}" ${extra}
      min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value ?? ''}"/><span class="unit">${spec.unit || ''}</span></span>
  </label>`;

function renderParams() {
  const root = $('params');
  root.innerHTML = `<h2>參數</h2>
    <div class="param-block">${BASIC_SPEC.map((s) => fieldHTML(s, state.params[s.key])).join('')}
      ${LINKED_BASIC_SPEC.map((s) => fieldHTML(s, state.params[s.key], 'data-adv="1"')).join('')}</div>
    <h3>加工與五金</h3>
    <div class="param-block">${CHOICE_SPEC.map((s) => `
      <label class="field"><span>${s.label}</span>
        <span class="input"><select id="param-${s.key}" data-key="${s.key}" data-choice="1">
          ${s.options.map(([v, l]) => `<option value="${v}" ${state.params[s.key] === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></span></label>`).join('')}</div>
    <details class="group" id="advanced">
      <summary>進階 <span class="hint">全部自動連動，輸入數值即可覆寫</span></summary>
      <div class="param-block">${ADVANCED_SPEC.map((s) => fieldHTML(s, state.params[s.key], 'data-adv="1"')).join('')}</div>
      <button id="adv-reset" class="ghost">進階全部改回自動</button>
    </details>`;
  $('assembly').innerHTML = ASSEMBLY_SPEC.map((s) => fieldHTML(s, state.params[s.key])).join('');
  try { $('advanced').open = localStorage.getItem(STORE_KEY + '.adv') === '1'; } catch { /* 忽略 */ }
  $('advanced').addEventListener('toggle', () => {
    try { localStorage.setItem(STORE_KEY + '.adv', $('advanced').open ? '1' : '0'); } catch { /* 忽略 */ }
  });
  $('adv-reset').onclick = () => {
    for (const s of ADVANCED_SPEC) { state.params[s.key] = null; $('param-' + s.key).value = ''; }
    onParamsChanged();
  };
}

// 參數輸入事件只綁一次（renderParams 可能重複呼叫）
for (const root of [$('params'), $('assembly')]) {
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(onParamsChanged, 180); };
  root.addEventListener('input', (e) => {
    const el = e.target, key = el.dataset.key;
    if (!key || el.dataset.choice) return;
    if (el.dataset.adv) {
      // 清空 = 回到自動
      state.params[key] = el.value === '' ? null : Number(el.value);
      if (el.value !== '' && !Number.isFinite(Number(el.value))) return;
    } else {
      if (el.value === '' || !Number.isFinite(Number(el.value))) return;
      state.params[key] = Number(el.value);
    }
    schedule();
  });
  root.addEventListener('change', (e) => {
    const el = e.target, key = el.dataset.key;
    if (!key) return;
    if (el.dataset.choice) { state.params[key] = el.value; onParamsChanged(); return; }
    // 基本欄位：離開時顯示夾到範圍內的值
    if (!el.dataset.adv) el.value = normalizeParams(state.params)[key];
  });
  root.addEventListener('click', (e) => {
    const key = e.target.dataset?.auto;
    if (!key) return;
    e.preventDefault();
    state.params[key] = null;
    $('param-' + key).value = '';
    onParamsChanged();
  });
}

/** 依連動結果更新進階欄位的提示與自動值 */
function updateFieldNotes() {
  const fields = rack.layout.fields;
  for (const spec of LINKED_SPECS) {
    const f = fields[spec.key];
    const input = $('param-' + spec.key), note = $('note-' + spec.key);
    if (!f || !input) continue;
    input.placeholder = `${f.value}`;
    input.classList.toggle('manual', !f.auto);
    if (f.auto) {
      if (document.activeElement !== input) input.value = '';
      note.innerHTML = `<span class="auto-tag">自動</span> ${f.note}`;
    } else {
      note.innerHTML = `<button class="auto-btn" data-auto="${spec.key}">改回自動</button> ${f.note || '手動設定'}`;
    }
    note.classList.toggle('adjusted', f.adjusted);
  }
  const n = ADVANCED_SPEC.filter((s) => !fields[s.key].auto).length;
  const adj = ADVANCED_SPEC.filter((s) => fields[s.key].adjusted).length;
  $('advanced').querySelector('summary .hint').textContent = n
    ? `${n} 項手動${adj ? `，${adj} 項因衝突已自動調整` : ''}`
    : '全部自動連動，輸入數值即可覆寫';
}

function onParamsChanged() {
  state.params = normalizeParams(state.params);
  const before = rack.layout;
  const after = deriveLayout(rackInput());
  if (before.mx !== after.mx || before.my !== after.my) {
    // 模組數改變：每個模組重新配置 2 個掛點
    resetMounts();
  } else if (before.W !== after.W || before.H !== after.H) {
    // 尺寸改變時，掛點維持在同一模組內的相對位置（水平比例、距模組頂端距離）
    for (const m of state.mounts) {
      const i = Math.min(before.mx - 1, Math.floor(m.x / before.W)), j = Math.min(before.my - 1, Math.floor(m.y / before.H));
      const fu = (m.x - i * before.W) / before.W, fv = (before.H - (m.y - j * before.H));
      m.x = Math.round((Math.min(i, after.mx - 1) * after.W + fu * after.W) * 10) / 10;
      m.y = Math.round((Math.min(j, after.my - 1) * after.H + after.H - fv) * 10) / 10;
    }
  }
  saveState();
  rebuild();
}

function renderSidebar() {
  const i = rack.info;
  const extra = i.capacity - i.required;
  $('summary').innerHTML = `
    <h2>尺寸資訊</h2>
    <div class="stats">
      <div class="stat"><div class="k">總寬 W</div><div class="v">${fmt(i.width)} mm</div></div>
      <div class="stat"><div class="k">總高 H</div><div class="v">${fmt(i.height)} mm</div></div>
      <div class="stat"><div class="k">深 D</div><div class="v">${fmt(i.depth)} mm</div></div>
      <div class="stat"><div class="k">模組</div><div class="v">${i.mx} × ${i.my}</div></div>
      <div class="stat"><div class="k">單模組</div><div class="v">${fmt(i.moduleW)} × ${fmt(i.moduleH)}</div></div>
      <div class="stat"><div class="k">每模組</div><div class="v">${i.cols} 欄 × ${i.rows} 列</div></div>
      <div class="stat"><div class="k">罐孔徑</div><div class="v">⌀ ${fmt(i.holeD)}</div></div>
      <div class="stat"><div class="k">列距</div><div class="v">${fmt(i.rowPitch)} mm</div></div>
      <div class="stat wide"><div class="k">容量</div><div class="v">${i.capacity} 罐 <span class="hint">（需求 ${i.required}${extra > 0 ? `，空位 ${extra}` : ''}）</span></div></div>
      <div class="stat wide"><div class="k">零件</div><div class="v" style="font-size:12.5px;font-weight:500">${Object.entries(rack.counts).map(([k, n]) => `${KIND_NAMES[k]} ×${n}`).join('、')}</div></div>
    </div>`;
  const w = [...rack.warnings, ...(layout?.warnings || [])];
  $('warnings').innerHTML = w.length ? `<h2>注意</h2>${w.map((s) => `<div class="warn">• ${s}</div>`).join('')}` : '';
  renderMounts();
}

function renderMounts() {
  const L = rack.layout;
  $('mount-list').innerHTML = state.mounts.length ? '' : '<p class="hint">尚無掛點</p>';
  for (const m of state.mounts) {
    const v = validateMount(L, m.x, m.y);
    const row = document.createElement('div');
    row.className = 'mount' + (m.id === state.selected ? ' selected' : '') + (v.valid ? '' : ' invalid');
    row.innerHTML = `<span class="dot">${m.id}</span>
      <span class="coords">X ${fmt(m.x)} · Y ${fmt(m.y)}</span>
      <button class="ghost" title="刪除">✕</button>
      <span class="dist">左 ${fmt(m.x)} · 右 ${fmt(L.totalW - m.x)} · 頂 ${fmt(L.totalH - m.y)} · 底 ${fmt(m.y)}
      ${v.valid ? '' : `<br><span class="bad">${v.reason}</span>`}</span>`;
    row.addEventListener('click', () => selectMount(m.id));
    row.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); removeMount(m.id); });
    $('mount-list').appendChild(row);
  }

  const sel = state.mounts.find((m) => m.id === state.selected);
  $('mount-edit').innerHTML = sel ? `
    <div class="edit-grid">
      <label class="field"><span>X</span><span class="input"><input type="number" step="0.5" id="mx" value="${sel.x}"/><span class="unit">mm</span></span></label>
      <label class="field"><span>Y</span><span class="input"><input type="number" step="0.5" id="my" value="${sel.y}"/><span class="unit">mm</span></span></label>
    </div>` : '';
  if (sel) {
    const apply = () => {
      const x = Number($('mx').value), y = Number($('my').value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      sel.x = Math.min(L.totalW, Math.max(0, x));
      sel.y = Math.min(L.totalH, Math.max(0, y));
      saveState();
      rebuild();
    };
    $('mx').addEventListener('change', apply);
    $('my').addEventListener('change', apply);
  }

  if (state.mounts.length > 1) {
    let html = '<table class="pairs"><tr><th>相鄰掛點</th><th>ΔX</th><th>ΔY</th><th>直線距離</th></tr>';
    for (const [a, b] of mountPairs()) {
      html += `<tr><td>#${a.id} → #${b.id}</td><td>${fmt(b.x - a.x)}</td><td>${fmt(b.y - a.y)}</td><td>${fmt(Math.hypot(b.x - a.x, b.y - a.y))}</td></tr>`;
    }
    const xs = state.mounts.map((m) => m.x), ys = state.mounts.map((m) => m.y);
    html += `</table><p class="hint" style="margin-top:6px">掛點總跨距 X ${fmt(Math.max(...xs) - Math.min(...xs))} · Y ${fmt(Math.max(...ys) - Math.min(...ys))} mm</p>`;
    $('mount-pairs').innerHTML = html;
  } else $('mount-pairs').innerHTML = '';
}

// ---------- 零件縮圖、連接件、材料表 ----------
function partThumb(part, w = 64, h = 44) {
  const f = flatten(part, part.bounds.h > part.bounds.w);
  const pad = Math.max(f.w, f.h) * 0.04;
  const path = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(2)} ${(f.h - y).toFixed(2)}`).join('L') + 'Z';
  let d = path(f.outer);
  for (const hole of f.holes) {
    if (hole.type === 'circle') {
      const [cx, cy] = hole.c, r = hole.r;
      d += `M${(cx - r).toFixed(2)} ${(f.h - cy).toFixed(2)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    } else d += path(hole.pts);
  }
  return `<svg viewBox="${-pad} ${-pad} ${f.w + 2 * pad} ${f.h + 2 * pad}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path class="part-shape" d="${d}"/></svg>`;
}

// 依形狀分組（同種類、同尺寸、同開孔數視為同一款）
function partGroups(filter = () => true) {
  const groups = new Map();
  for (const p of rack.parts.filter(filter)) {
    const key = `${p.kind}|${p.bounds.w.toFixed(1)}|${p.bounds.h.toFixed(1)}|${p.holes.length}`;
    const g = groups.get(key) || { part: p, qty: 0 };
    g.qty++;
    groups.set(key, g);
  }
  return [...groups.values()];
}

const thumbRow = (g, sub) => `<div class="thumb-row">${partThumb(g.part)}
  <div><div class="name">${KIND_NAMES[g.part.kind]}</div><div class="sub">${sub}</div></div>
  <div class="qty">×${g.qty}</div></div>`;

function hardwareTable() {
  const hw = rack.info.hardware;
  if (!hw.length) return '';
  return `<table class="hw-table">${hw.map((h) => `<tr><td>${h.name}<span class="use">${h.use}</span></td><td>×${h.qty}</td></tr>`).join('')}</table>`;
}

function renderConnectors() {
  const i = rack.info;
  const groups = partGroups((p) => p.kind === 'clip' || p.kind === 'splice');
  const desc = {
    clip: `卡入相鄰模組側板上下緣的槽，${i.hJoints} 條水平接縫 × 每條 4 個`,
    splice: `貼在上下模組側板內側，每片 4 支螺栓，${i.vJoints} 條垂直接縫 × 左右 2 片`,
  };
  const total = i.mx * i.my;
  $('connectors').innerHTML = `<h2>連接點</h2>
    <p class="hint">${total} 個模組（${i.mx} × ${i.my}）${i.hJoints + i.vJoints ? `，${i.hJoints} 條水平接縫、${i.vJoints} 條垂直接縫` : '，目前不需要連接件'}。</p>
    ${groups.length ? `<div class="thumb-list">${groups.map((g) => thumbRow(g, `${desc[g.part.kind]}<br>${g.part.bounds.w.toFixed(1)} × ${g.part.bounds.h.toFixed(1)} × ${g.part.t} mm`)).join('')}</div>` : ''}
    ${hardwareTable()}`;
}

function sheetThumb(sheet) {
  const W = layout.sheetW, H = layout.sheetH;
  let d = '';
  for (const it of sheet.items) {
    const tr = ([u, v]) => `${(it.x + u).toFixed(1)} ${(H - it.y - v).toFixed(1)}`;
    d += 'M' + it.flat.outer.map(tr).join('L') + 'Z';
    for (const h of it.flat.holes) if (h.type !== 'circle') d += 'M' + h.pts.map(tr).join('L') + 'Z';
  }
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="cut" d="${d}"/></svg>`;
}

function renderBOM() {
  const P = rack.params;
  const groups = partGroups().sort((a, b) => b.part.bounds.w * b.part.bounds.h - a.part.bounds.w * a.part.bounds.h);
  const used = layout.sheets.reduce((n, s) => n + s.items.reduce((m, it) => m + it.flat.w * it.flat.h, 0), 0);
  const fill = used / (layout.sheets.length * P.sheetW * P.sheetH);
  const link = calculatorUrl({ sheetW: P.sheetW, sheetH: P.sheetH, count: layout.sheets.length, thickness: P.thickness });
  $('bom').innerHTML = `<h2>材料表</h2>
    <div class="thumb-list">${groups.map((g) => {
      const kh = g.part.holes.filter((h) => h.mount != null).length;
      return thumbRow(g, `${g.part.bounds.w.toFixed(1)} × ${g.part.bounds.h.toFixed(1)} × ${g.part.t} mm${g.part.kind === 'back' ? ` · 掛孔 ${kh} 個` : ''}`);
    }).join('')}</div>
    <h3>五金</h3>${hardwareTable() || '<p class="hint">不需要五金。</p>'}
    <h3>排版 · ${layout.sheets.length} 張 ${P.sheetW}×${P.sheetH}（板材利用率約 ${(fill * 100).toFixed(0)}%）</h3>
    <div class="sheets">${layout.sheets.map((sh, k) => `<div class="sheet-card">${sheetThumb(sh)}第 ${k + 1} 張 · ${sh.items.length} 件</div>`).join('')}</div>
    <a class="button calc-link" href="${link}" target="_blank" rel="noopener">到板材計算機：從原板裁出 ${layout.sheets.length} 張 ${P.sheetW}×${P.sheetH} ↗</a>
    <p class="hint" style="margin-top:6px">把 CNC 用的板材尺寸、張數和板厚帶到板材計算機，算出要買幾張原板與裁切方式。</p>`;
}

function renderHover(part) {
  if (!part) { $('hover-info').innerHTML = ''; return; }
  const b = part.bounds;
  const slots = part.holes.filter((h) => h.type === 'poly' && h.mount == null).length;
  const circles = part.holes.filter((h) => h.type === 'circle').length;
  const keyholes = part.holes.filter((h) => h.mount != null).length;
  $('hover-info').innerHTML = `<h2>游標部件</h2>
    <div class="stats">
      <div class="stat wide"><div class="k">${KIND_NAMES[part.kind]}</div><div class="v">${part.name}</div></div>
      <div class="stat"><div class="k">外框</div><div class="v">${fmt(b.w)} × ${fmt(b.h)}</div></div>
      <div class="stat"><div class="k">厚</div><div class="v">${fmt(part.t)} mm</div></div>
      <div class="stat wide"><div class="k">開孔</div><div class="v" style="font-size:12.5px;font-weight:500">榫槽 ${slots} · 圓孔 ${circles}${keyholes ? ` · 掛孔 ${keyholes}` : ''}</div></div>
    </div>`;
}

// ---------- 互動 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;

function setPointer(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (tc.axis || tc.dragging) return;
  setPointer(e);
  const hit = raycaster.intersectObjects(mountsGroup.children, false)[0];
  if (hit) { selectMount(hit.object.userData.mountId); return; }
  // 點名牌：出現左右移的座標軸
  if (state.explode > 0) return;
  const partHit = raycaster.intersectObjects(partsGroup.children, true).find((h) => h.object.isMesh);
  const part = partHit?.object.userData.part;
  if (part && (part.kind === 'nameplate' || part.kind === 'label')) selectSign(part);
});

renderer.domElement.addEventListener('dblclick', (e) => {
  // 雙擊背板新增掛點
  setPointer(e);
  const hit = raycaster.intersectObjects(partsGroup.children, true).find((h) => h.object.isMesh);
  if (hit && hit.object.userData.part?.kind === 'back' && state.explode === 0) addMount(snapValue(hit.point.x), snapValue(hit.point.y));
});

let hoverPending = false;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (hoverPending || tc.dragging) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    setPointer(e);
    const hit = raycaster.intersectObjects(partsGroup.children, true).find((h) => h.object.isMesh);
    const mesh = hit?.object || null;
    if (mesh === hovered) return;
    if (hovered) hovered.material = materials[hovered.userData.part.kind];
    hovered = mesh;
    if (hovered) hovered.material = hoverMat;
    renderHover(hovered?.userData.part);
  });
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected != null) removeMount(state.selected);
  if (e.key === 'Escape') { clearSignSelection(); state.selected = null; tc.detach(); buildMountSpheres(); updateOverlay(); renderMounts(); renderSignOffsets(); }
});

function setView(kind) {
  const L = rack.layout;
  const c = new THREE.Vector3(L.totalW / 2, L.totalH / 2, L.depth / 2);
  const d = Math.max(L.totalW, L.totalH) * 1.9 + 200;
  const dir = kind === 'front' ? new THREE.Vector3(0, 0, 1) : kind === 'side' ? new THREE.Vector3(1, 0.15, 0.35) : new THREE.Vector3(0.55, 0.35, 1);
  camera.position.copy(c).addScaledVector(dir.normalize(), d);
  orbit.target.copy(c);
  orbit.update();
}

$('view-front').onclick = () => setView('front');
$('view-iso').onclick = () => setView('iso');
$('view-side').onclick = () => setView('side');
$('show-cans').checked = state.showCans;
$('show-dims').checked = state.showDims;
$('explode').value = state.explode;
$('show-cans').onchange = (e) => { state.showCans = e.target.checked; applyExplode(); saveState(); };
$('show-dims').onchange = (e) => { state.showDims = e.target.checked; updateOverlay(); saveState(); };
$('explode').oninput = (e) => {
  state.explode = Number(e.target.value);
  applyExplode();
  mountsGroup.visible = overlayGroup.visible = state.explode === 0;
  labelRenderer.domElement.style.display = state.explode === 0 ? '' : 'none';
  if (state.explode > 0) { clearSignSelection(); tc.detach(); } else if (state.selected != null) selectMount(state.selected);
};
function setSidebar(open) {
  $('sidebar').classList.toggle('collapsed', !open);
  document.body.classList.toggle('sidebar-closed', !open);
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('sidebar-toggle').title = open ? '收合側欄' : '展開側欄';
  try { localStorage.setItem(STORE_KEY + '.sidebar', open ? '1' : '0'); } catch { /* 忽略 */ }
}
$('sidebar-toggle').onclick = () => setSidebar($('sidebar').classList.contains('collapsed'));
try { if (localStorage.getItem(STORE_KEY + '.sidebar') === '0') setSidebar(false); } catch { /* 忽略 */ }
$('mount-add').onclick = () => addMount();
$('mount-auto').onclick = () => { resetMounts(); saveState(); rebuild(); };
$('mount-clear').onclick = () => { state.mounts = []; state.selected = null; saveState(); rebuild(); };
$('reset').onclick = () => {
  state.params = { ...DEFAULTS };
  resetMounts();
  saveState();
  renderParams();
  firstBuild = true;
  rebuild();
};

// 在 claude.ai 頁面中以 downloads 能力存檔（不支援 .dxf，改包成 zip）；本機則直接下載
const SAVE_EXT = ['txt', 'json', 'md', 'csv', 'svg', 'html', 'zip', 'pdf'];
let downloadsCap = null;
const getDownloads = () => (downloadsCap ??= window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null));

function showExportMsg(text, bad = false) {
  const el = $('export-msg');
  el.textContent = text;
  el.className = bad ? 'warn' : 'okmsg';
}

async function download(name, data) {
  const cap = await getDownloads();
  if (cap) {
    const ext = name.split('.').pop().toLowerCase();
    if (!SAVE_EXT.includes(ext)) {
      data = makeZip([{ name, data }]);
      name += '.zip';
    }
    try {
      await cap.save({ filename: name, data });
      showExportMsg(`已存檔：${name}`);
    } catch (err) {
      if (err?.code !== 'declined') showExportMsg(`無法存檔（${err?.code || err}）`, true);
    }
    return;
  }
  const blob = new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => `paint-rack_${rack.info.mx}x${rack.info.my}_t${rack.params.thickness}`;
const paramsJson = () => JSON.stringify({ params: state.params, mounts: state.mounts }, null, 2);
// 雷射名牌：SVG 內嵌各自的黑白點陣，ZIP 另外附上每片的 PNG
const laserHref = (part) => (part.artMode === 'laser' ? artFor(part).dataUrl : null);
const dataUrlBytes = (url) => Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));
$('export-zip').onclick = () => {
  const files = [
    { name: `${stamp()}.dxf`, data: toDXF(layout) },
    { name: `${stamp()}.svg`, data: toSVG(layout, laserHref) },
    { name: `${stamp()}_BOM.csv`, data: toBOM(rack) },
    { name: `${stamp()}.json`, data: paramsJson() },
  ];
  const seen = new Set();
  for (const p of rack.parts) {
    const href = p.raster ? laserHref(p) : null;
    if (!href || seen.has(p.artKey)) continue;
    seen.add(p.artKey);
    const name = p.artKey === 'top' ? '頂端名牌' : `第${p.labelKind + 1}種_${labelText(p.labelKind)}`;
    files.push({ name: `${stamp()}_雷射_${name.replace(/[\\/:*?"<>|]/g, '_')}.png`, data: dataUrlBytes(href) });
  }
  download(`${stamp()}.zip`, makeZip(files));
};
$('export-dxf').onclick = () => download(`${stamp()}.dxf`, toDXF(layout));
$('export-svg').onclick = () => download(`${stamp()}.svg`, toSVG(layout, laserHref));
$('export-bom').onclick = () => download(`${stamp()}_BOM.csv`, toBOM(rack));
$('export-json').onclick = () => download(`${stamp()}.json`, paramsJson());
$('import-json').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    state.params = normalizeParams(data.params || {});
    state.mounts = Array.isArray(data.mounts) ? data.mounts.filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y)).map((m, k) => ({ id: k + 1, x: m.x, y: m.y })) : [];
    state.nextId = state.mounts.length + 1;
    state.selected = null;
    saveState();
    renderParams();
    firstBuild = true;
    rebuild();
  } catch (err) {
    showExportMsg('無法讀取 JSON：' + err.message, true);
  }
  e.target.value = '';
};

// ---------- 展示名牌 ----------
let artJob = 0;
const labelMemo = new Map(); // 文字 + 加工方式 → 圖案，避免每次重算所有名牌

/** 影像來源 → 描邊用低解析度圖案（輪廓點數少）＋雷射用高解析度點陣 */
function processArt(source, { threshold, invert, laser, laserPx = 3600 }) {
  const opts = { threshold, invert };
  const r = cropMask(rasterize(source, { ...opts, maxPx: 480 }));
  if (r.empty) return EMPTY_ART;
  const hi = laser ? cropMask(rasterize(source, { ...opts, maxPx: laserPx })) : null;
  return {
    art: maskToArtwork(r.mask, r.w, r.h), canvas: r.canvas, empty: false,
    dataUrl: hi && !hi.empty ? hi.canvas.toDataURL('image/png') : null,
    laserPx: hi ? [hi.w, hi.h] : null,
  };
}

/** 依目前名牌設定（圖片或文字、門檻、反轉）產生頂端名牌與每種顏料名牌的圖案 */
async function updateArtwork() {
  const np = state.nameplate, lb = state.labels;
  const job = ++artJob;
  if (np.enabled) {
    try {
      const source = np.image ? await loadImage(np.image) : textCanvas(np.text || ' ');
      if (job !== artJob) return;
      artwork = processArt(source, { threshold: np.threshold, invert: np.invert, laser: np.mode === 'laser' });
    } catch (err) {
      artwork = { ...EMPTY_ART, error: err.message };
    }
    artCache.set('top', artwork);
  }
  if (lb.enabled) {
    for (let k = 0; k < kindsCount(); k++) {
      if (!labelOn(k)) continue;
      const key = `${labelText(k)}|${lb.mode}`;
      if (!labelMemo.has(key)) {
        labelMemo.set(key, processArt(textCanvas(labelText(k), 240), { threshold: 128, invert: false, laser: lb.mode === 'laser', laserPx: 2400 }));
      }
      artCache.set(`label:${k}`, labelMemo.get(key));
    }
  }
  renderNameplateStatus();
}

function renderNameplate() {
  const np = state.nameplate;
  $('nameplate').innerHTML = `<h2>展示名牌 <span class="hint">選用</span></h2>
    <label class="check"><input type="checkbox" id="np-enabled" ${np.enabled ? 'checked' : ''}/> 在每架頂端加一片名牌</label>
    <div id="np-body" ${np.enabled ? '' : 'hidden'}>
      <p class="hint">名牌立在頂板上，兩支榫頭插進頂板。可匯入圖片（Logo、手寫字），或直接打字。</p>
      <div class="param-block">
        <label class="field"><span>加工方式</span><span class="input"><select id="np-mode">
          ${NAMEPLATE_MODES.map(([v, l]) => `<option value="${v}" ${np.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></span></label>
        <label class="field"><span>外形</span><span class="input"><select id="np-shape">
          ${NAMEPLATE_SHAPES.map(([v, l]) => `<option value="${v}" ${np.shape === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></span></label>
        <label class="field"><span>名牌高度<small>高出木架頂端</small></span><span class="input"><input type="number" id="np-height" min="20" max="300" step="1" value="${np.height}"/><span class="unit">mm</span></span></label>
        <label class="field"><span>名牌寬度<small>空白 = 滿寬</small></span><span class="input"><input type="number" id="np-width" min="60" step="1" placeholder="滿寬" value="${np.width ?? ''}"/><span class="unit">mm</span></span></label>
        <label class="field"><span>左右位移<small id="np-offset-note">正值往右；也可在 3D 點名牌拖拉</small></span><span class="input"><input type="number" id="np-offset" step="1" value="${np.offset || 0}"/><span class="unit">mm</span></span></label>
      </div>
      <div class="offset-slider">
        <input type="range" id="np-offset-range" min="0" max="0" step="1" value="${np.offset || 0}" aria-label="頂端名牌左右位移"/>
        <button id="np-center" class="ghost">置中</button>
      </div>
      <div class="param-block">
        <label class="field"><span>名牌文字<small>沒有匯入圖片時使用</small></span><span class="input"><input type="text" id="np-text" value="${escapeAttr(np.text)}" maxlength="40"/></span></label>
        <label class="field"><span>黑白門檻<small>越大，越多灰色變成墨色</small></span><input type="range" id="np-threshold" min="10" max="245" step="1" value="${np.threshold}"/></label>
      </div>
      <label class="check"><input type="checkbox" id="np-invert" ${np.invert ? 'checked' : ''}/> 反轉黑白（淺色圖案、深色背景時使用）</label>
      <div class="row-buttons">
        <label class="button">匯入圖片<input type="file" id="np-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden/></label>
        <button id="np-clear" class="ghost" ${np.image ? '' : 'hidden'}>改用文字</button>
      </div>
      <div class="np-preview"><canvas id="np-canvas" width="300" height="80" aria-label="名牌圖案預覽"></canvas></div>
      <p class="hint" id="np-status"></p>
    </div>
    <h3>顏料名牌</h3>
    <label class="check"><input type="checkbox" id="lb-enabled" ${state.labels.enabled ? 'checked' : ''}/> 每種顏料各有一片名牌</label>
    <div id="lb-body" ${state.labels.enabled ? '' : 'hidden'}>
      <p class="hint">名牌立在固定孔板前緣、罐子前方，榫頭插進孔板，不影響取罐。每片可各自關閉；開啟時前緣留邊會自動加寬。</p>
      <div class="param-block">
        <label class="field"><span>加工方式</span><span class="input"><select id="lb-mode">
          ${NAMEPLATE_MODES.map(([v, l]) => `<option value="${v}" ${state.labels.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></span></label>
        <label class="field"><span>名牌高度<small>高出固定孔板</small></span><span class="input"><input type="number" id="lb-height" min="8" max="60" step="1" value="${state.labels.height}"/><span class="unit">mm</span></span></label>
        <label class="field"><span>名牌寬度<small>空白 = 滿寬；變窄後每片可各自左右移</small></span><span class="input"><input type="number" id="lb-width" min="30" step="1" placeholder="滿寬" value="${state.labels.width ?? ''}"/><span class="unit">mm</span></span></label>
      </div>
      <div class="row-buttons">
        <button id="lb-all-on" class="ghost">全部開啟</button>
        <button id="lb-all-off" class="ghost">全部關閉</button>
        <button id="lb-center" class="ghost">全部置中</button>
      </div>
      <p class="hint label-head"><span>開關 · 顏色 · 名稱</span><span>左右位移 mm</span></p>
      <div id="lb-list" class="label-list"></div>
      <p class="hint" id="lb-status"></p>
    </div>`;
  renderLabelList();
  const lb = state.labels;
  const labelsChanged = () => { saveState(); updateArtwork().then(rebuild); };
  $('lb-enabled').onchange = (e) => { lb.enabled = e.target.checked; $('lb-body').hidden = !lb.enabled; labelsChanged(); };
  $('lb-mode').onchange = (e) => { lb.mode = e.target.value; labelsChanged(); };
  $('lb-height').oninput = (e) => { const v = Number(e.target.value); if (v >= 8 && v <= 60) { lb.height = v; clearTimeout(lbTimer); lbTimer = setTimeout(() => { saveState(); rebuild(); }, 250); } };
  const setAll = (on) => { for (let k = 0; k < kindsCount(); k++) (lb.items[k] ||= {}).on = on; renderLabelList(); labelsChanged(); };
  $('lb-all-on').onclick = () => setAll(true);
  $('lb-all-off').onclick = () => setAll(false);
  $('np-shape').onchange = (e) => { np.shape = e.target.value; saveState(); rebuild(); };

  // 寬度與左右位移（不需重新描圖，只重建幾何）
  const geomLater = () => { clearTimeout(lbTimer); lbTimer = setTimeout(() => { saveState(); rebuild(); }, 150); };
  const numOrNull = (v) => (v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  $('np-width').oninput = (e) => { np.width = numOrNull(e.target.value); geomLater(); };
  const setTopOffset = (v) => { np.offset = Number(v) || 0; $('np-offset').value = np.offset; $('np-offset-range').value = np.offset; geomLater(); };
  $('np-offset').oninput = (e) => { if (e.target.value !== '') setTopOffset(e.target.value); };
  $('np-offset-range').oninput = (e) => setTopOffset(e.target.value);
  $('np-center').onclick = () => setTopOffset(0);
  $('lb-width').oninput = (e) => { lb.width = numOrNull(e.target.value); geomLater(); };
  $('lb-center').onclick = () => {
    for (const it of lb.items) if (it) it.offset = 0;
    syncSignInputs();
    geomLater();
  };
  const changed = (rerender = true) => {
    saveState();
    updateArtwork().then(() => { if (rerender) rebuild(); });
  };
  $('np-enabled').onchange = (e) => { np.enabled = e.target.checked; $('np-body').hidden = !np.enabled; changed(); };
  $('np-mode').onchange = (e) => { np.mode = e.target.value; changed(); };
  let timer = null;
  const later = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 250); };
  $('np-height').oninput = (e) => { const v = Number(e.target.value); if (v >= 20 && v <= 300) { np.height = v; later(() => { saveState(); rebuild(); }); } };
  $('np-text').oninput = (e) => { np.text = e.target.value; if (!np.image) later(changed); };
  $('np-threshold').oninput = (e) => { np.threshold = Number(e.target.value); later(changed); };
  $('np-invert').onchange = (e) => { np.invert = e.target.checked; changed(); };
  $('np-clear').onclick = () => { np.image = null; $('np-clear').hidden = true; changed(); };
  $('np-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      // 縮到 2400px 以內再存：夠雷射點陣用，也避免瀏覽器儲存空間不足
      const img = await loadImage(await readFileAsDataURL(file));
      const longSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      // SVG 是向量圖，直接放大畫；點陣圖只縮不放
      const s = file.type === 'image/svg+xml' ? 3000 / longSide : Math.min(1, 3000 / longSide);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * s));
      c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * s));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      np.image = c.toDataURL('image/png');
      $('np-clear').hidden = false;
      changed();
    } catch (err) {
      $('np-status').textContent = `無法讀取圖片：${err.message}`;
    }
  };
}

let lbTimer = null, labelListK = -1;

/** 每種顏料一列：開關、顏色點（與 3D 罐子同色）、名牌文字 */
function renderLabelList() {
  const list = $('lb-list');
  if (!list) return;
  const K = kindsCount();
  labelListK = K;
  list.innerHTML = Array.from({ length: K }, (_, k) => {
    const hue = Math.round(((k * 0.618034) % 1) * 360);
    return `<label class="label-row">
      <input type="checkbox" data-lb-on="${k}" ${labelOn(k) ? 'checked' : ''} aria-label="第 ${k + 1} 種名牌開關"/>
      <span class="swatch" style="background:hsl(${hue} 55% 55%)"></span>
      <span class="input"><input type="text" data-lb-text="${k}" maxlength="24" placeholder="顏料 ${k + 1}" value="${escapeAttr(state.labels.items[k]?.text || '')}"/></span>
      <span class="input offset"><input type="number" data-lb-off="${k}" step="1" value="${state.labels.items[k]?.offset || 0}" aria-label="第 ${k + 1} 種名牌左右位移"/></span>
    </label>`;
  }).join('');
  list.oninput = (e) => {
    const off = Number(e.target.dataset.lbOff);
    if (!Number.isNaN(off)) {
      if (e.target.value === '') return;
      (state.labels.items[off] ||= {}).offset = Number(e.target.value) || 0;
      clearTimeout(lbTimer);
      lbTimer = setTimeout(() => { saveState(); rebuild(); }, 150);
      return;
    }
    const k = Number(e.target.dataset.lbText);
    if (Number.isNaN(k)) return;
    (state.labels.items[k] ||= {}).text = e.target.value;
    clearTimeout(lbTimer);
    lbTimer = setTimeout(() => { saveState(); updateArtwork().then(rebuild); }, 300);
  };
  list.onchange = (e) => {
    const k = Number(e.target.dataset.lbOn);
    if (Number.isNaN(k)) return;
    (state.labels.items[k] ||= {}).on = e.target.checked;
    saveState();
    updateArtwork().then(rebuild);
  };
}

/** 依重建結果更新位移欄位的範圍；超出範圍的值會被拉回並顯示實際值 */
function renderSignOffsets(live = null) {
  if (!rack) return;
  const ns = rack.info.nameplateSpan;
  const range = $('np-offset-range'), note = $('np-offset-note');
  if (range && ns) {
    const off = live?.key === 'top' ? live.offset : ns.offset;
    range.min = -ns.maxOffset; range.max = ns.maxOffset; range.disabled = ns.maxOffset <= 0;
    if (document.activeElement !== range) range.value = off;
    if (document.activeElement !== $('np-offset')) $('np-offset').value = off;
    if (!live) state.nameplate.offset = ns.offset;
    note.textContent = ns.maxOffset > 0
      ? `可移 ±${fmt(ns.maxOffset)} mm（名牌寬 ${fmt(ns.width)}）${state.selectedSign === 'top' ? ' · 3D 座標軸已出現，可直接拖拉' : '；也可在 3D 點名牌拖拉'}`
      : `目前滿寬 ${fmt(ns.width)} mm，先把名牌寬度改窄才能左右移`;
    note.classList.toggle('adjusted', !!ns.widthClamped);
  }
  for (const [k, sp] of Object.entries(rack.info.labelSpans || {})) {
    const input = document.querySelector(`[data-lb-off="${k}"]`);
    if (!input) continue;
    const off = live?.key === Number(k) ? live.offset : sp.offset;
    input.min = -sp.maxOffset; input.max = sp.maxOffset;
    input.disabled = sp.maxOffset <= 0;
    input.title = sp.maxOffset > 0 ? `可移 ±${fmt(sp.maxOffset)} mm` : '滿寬，先把名牌寬度改窄';
    if (document.activeElement !== input) input.value = off;
    if (!live && state.labels.items[k]) state.labels.items[k].offset = sp.offset;
    input.closest('.label-row')?.classList.toggle('selected', state.selectedSign === Number(k));
  }
}

function syncSignInputs() {
  if ($('np-offset')) { $('np-offset').value = state.nameplate.offset || 0; $('np-offset-range').value = state.nameplate.offset || 0; }
  for (const input of document.querySelectorAll('[data-lb-off]')) input.value = state.labels.items[input.dataset.lbOff]?.offset || 0;
}

function renderLabelStatus() {
  const el = $('lb-status');
  if (!el || !rack) return;
  if (labelListK !== kindsCount()) {
    // 種類數改變：更新清單，並替新增的種類產生名牌圖案
    renderLabelList();
    if (state.labels.enabled) updateArtwork().then(rebuild);
  }
  const n = rack.info.labelCount;
  const on = Array.from({ length: kindsCount() }, (_, k) => labelOn(k)).filter(Boolean).length;
  const what = { laser: '雷射點陣（每片各一張 PNG）', engrave: '向量輪廓在 ENGRAVE 圖層', cut: '文字直接貫穿切出' }[state.labels.mode];
  el.textContent = state.labels.enabled ? `${on} / ${kindsCount()} 種開啟 · 共 ${n} 片（跨模組的顏料每段各一片）· ${what}` : '';
}

function renderNameplateStatus() {
  renderLabelStatus();
  renderSignOffsets();
  const cv = $('np-canvas'), status = $('np-status');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (artwork.error || artwork.empty) {
    status.textContent = artwork.error ? `圖案處理失敗：${artwork.error}` : '圖案是空白的：調整黑白門檻或勾選反轉。';
    status.className = 'hint warn';
    return;
  }
  const src = artwork.canvas;
  const s = Math.min(cv.width / src.width, cv.height / src.height);
  const w = src.width * s, h = src.height * s;
  ctx.drawImage(src, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
  const loops = artwork.art.loops.length;
  const np = rack?.parts.find((p) => p.kind === 'nameplate');
  const dpiVal = np?.artRect && artwork.laserPx ? Math.round(artwork.laserPx[0] / (np.artRect.w / 25.4)) : 0;
  const dpi = dpiVal ? ` · 雷射約 ${dpiVal} DPI${dpiVal < 120 ? '（偏低，建議匯入更大的圖片）' : ''}` : '';
  const size = np?.artRect ? `圖案 ${fmt(np.artRect.w)} × ${fmt(np.artRect.h)} mm${dpi} · ` : '';
  const what = { laser: '雷射點陣（SVG 內嵌 + PNG），DXF 另附向量輪廓', engrave: '向量輪廓在 ENGRAVE 圖層，CAM 以 V 刀或平刀挖槽', cut: '圖案外框直接貫穿切出' }[state.nameplate.mode];
  status.textContent = `${size}${loops} 條輪廓 · ${what}`;
  status.className = 'hint';
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}

// ---------- 儲存 ----------
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      params: state.params, mounts: state.mounts, nextId: state.nextId, showCans: state.showCans, showDims: state.showDims,
      nameplate: state.nameplate, labels: state.labels,
    }));
  } catch {
    // 圖片太大存不下時，至少保留其他設定
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        params: state.params, mounts: state.mounts, nextId: state.nextId, showCans: state.showCans, showDims: state.showDims,
        nameplate: { ...state.nameplate, image: null }, labels: state.labels,
      }));
    } catch { /* 無法儲存時忽略 */ }
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      state.params = normalizeParams(d.params);
      state.mounts = Array.isArray(d.mounts) ? d.mounts : [];
      state.nextId = d.nextId || state.mounts.reduce((a, m) => Math.max(a, m.id + 1), 1);
      state.showCans = d.showCans ?? true;
      state.showDims = d.showDims ?? true;
      if (d.nameplate && typeof d.nameplate === 'object') state.nameplate = { ...state.nameplate, ...d.nameplate };
      if (d.labels && typeof d.labels === 'object') {
        state.labels = { ...state.labels, ...d.labels, items: Array.isArray(d.labels.items) ? d.labels.items.map((it) => ({ on: it?.on !== false, text: String(it?.text ?? ''), offset: Number(it?.offset) || 0 })) : [] };
      }
      return;
    }
  } catch { /* 讀取失敗則使用預設 */ }
  resetMounts();
}

// ---------- 啟動 ----------
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
renderParams();
renderNameplate();
rebuild();
if (state.nameplate.enabled || state.labels.enabled) updateArtwork().then(rebuild);

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

window.__rack = () => rack; // 除錯用
window.__artUrl = () => artwork.dataUrl;
// 除錯／瀏覽器測試用：名牌座標軸位置、世界座標 → 螢幕座標
window.__signProxy = () => signProxy.position.toArray();
window.__project = (w) => {
  const v = Array.isArray(w) ? new THREE.Vector3(...w) : new THREE.Vector3(w.x, w.y, w.z);
  v.project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
};
