import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildRack, deriveLayout, autoMounts, validateMount, normalizeParams, DEFAULTS, PARAM_SPEC } from './rack.js';
import { layoutParts, toSVG, toDXF, toBOM, KIND_NAMES } from './export.js';

const STORE_KEY = 'paintRack.v1';
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
};
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
tc.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (!e.value) { saveState(); rebuild(); }
});
tc.addEventListener('objectChange', onMountDrag);

const KIND_COLORS = {
  side: 0xd9b48a, back: 0xc49a6c, shelf: 0xe4c49c, holeplate: 0xebd2ae, top: 0xe4c49c, clip: 0x6f9bd1, key: 0x5fb08a,
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
  const wrap = new THREE.Group();
  wrap.add(mesh);
  wrap.userData.part = part;
  return wrap;
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
  rack = buildRack(state.params, state.mounts);
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

  buildMountSpheres();
  updateOverlay();
  renderSidebar();

  layout = layoutParts(rack.parts, rack.params);
  $('layout-info').textContent = `排版：${layout.sheets.length} 張 ${rack.params.sheetW}×${rack.params.sheetH} 板材、共 ${rack.parts.length} 件` +
    (layout.warnings.length ? `（${layout.warnings.length} 件超過板材）` : '');

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

function selectMount(id) {
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
  const L = deriveLayout(state.params);
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
function renderParams() {
  const root = $('params');
  root.innerHTML = '<h2>參數</h2>';
  const groups = new Map();
  for (const spec of PARAM_SPEC) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push(spec);
  }
  let first = true;
  for (const [name, specs] of groups) {
    const det = document.createElement('details');
    det.className = 'group';
    if (first || name === '顏料罐') det.open = true;
    first = false;
    det.innerHTML = `<summary>${name}</summary>`;
    for (const spec of specs) {
      if (spec.type === 'bool') {
        const lab = document.createElement('label');
        lab.className = 'check';
        lab.innerHTML = `<input type="checkbox" data-key="${spec.key}" ${state.params[spec.key] ? 'checked' : ''}/> ${spec.label}`;
        det.appendChild(lab);
        continue;
      }
      const lab = document.createElement('label');
      lab.className = 'field';
      lab.innerHTML = `<span>${spec.label}${spec.hint ? `<small>${spec.hint}</small>` : ''}</span>
        <span class="input"><input type="number" data-key="${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${state.params[spec.key]}"/><span class="unit">${spec.unit || ''}</span></span>`;
      det.appendChild(lab);
    }
    root.appendChild(det);
  }
  let timer = null;
  root.addEventListener('input', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    const spec = PARAM_SPEC.find((s) => s.key === key);
    const raw = spec.type === 'bool' ? e.target.checked : e.target.value;
    if (spec.type !== 'bool' && (raw === '' || !Number.isFinite(Number(raw)))) return;
    state.params[key] = spec.type === 'bool' ? raw : Number(raw);
    clearTimeout(timer);
    timer = setTimeout(() => onParamsChanged(key), 180);
  });
  root.addEventListener('change', (e) => {
    const key = e.target.dataset.key;
    if (!key || e.target.type !== 'number') return;
    e.target.value = normalizeParams(state.params)[key];
  });
}

function onParamsChanged(key) {
  state.params = normalizeParams(state.params);
  const layoutKeys = ['thickness', 'canDia', 'canHeight', 'kinds', 'perKind', 'canGap', 'retainHeight', 'liftClear', 'frontMargin', 'maxCols', 'maxRows', 'margin', 'tolerance'];
  const before = rack.layout;
  const after = deriveLayout(state.params);
  if (layoutKeys.includes(key) && (before.mx !== after.mx || before.my !== after.my || before.W !== after.W || before.H !== after.H)) {
    // 尺寸改變時，掛點依比例搬移，維持在相對位置
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
  if (hit) selectMount(hit.object.userData.mountId);
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
  if (e.key === 'Escape') { state.selected = null; tc.detach(); buildMountSpheres(); updateOverlay(); renderMounts(); }
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
  if (state.explode > 0) tc.detach(); else if (state.selected != null) selectMount(state.selected);
};
$('collapse').onclick = () => $('sidebar').classList.toggle('collapsed');
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

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => `paint-rack_${rack.info.mx}x${rack.info.my}_t${rack.params.thickness}`;
$('export-dxf').onclick = () => download(`${stamp()}.dxf`, toDXF(layout), 'application/dxf');
$('export-svg').onclick = () => download(`${stamp()}.svg`, toSVG(layout), 'image/svg+xml');
$('export-bom').onclick = () => download(`${stamp()}_BOM.csv`, toBOM(rack), 'text/csv');
$('export-json').onclick = () => download(`${stamp()}.json`, JSON.stringify({ params: state.params, mounts: state.mounts }, null, 2), 'application/json');
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
    alert('無法讀取 JSON：' + err.message);
  }
  e.target.value = '';
};

// ---------- 儲存 ----------
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      params: state.params, mounts: state.mounts, nextId: state.nextId, showCans: state.showCans, showDims: state.showDims,
    }));
  } catch { /* 無法儲存時忽略 */ }
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
rebuild();

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

window.__rack = () => rack; // 除錯用
