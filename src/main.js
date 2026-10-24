import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
  nameplate: { enabled: false, mode: 'laser', shape: 'rect', height: 60, width: null, align: 'center', offset: 0, text: 'PAINT', threshold: 128, invert: false, image: null },
  // 每種顏料各自的名牌：items[k] = { on, text, offset }，可各自關閉、各自左右移；width 空白 = 滿寬
  // 每種顏料各自的名牌：items[k] = { on, text } 各自開關；大小與位置全部連動
  // height = 名牌高度（只影響名牌，最高到孔板下緣），align / offset = 靠左、置中、靠右與距離
  labels: { enabled: false, mode: 'laser', height: 12, width: null, align: 'center', offset: 0, items: [] },
  selectedSign: null, // { key: 'top' | 顏料編號, module }：正在調整的名牌
};

// 名牌圖案處理結果（由 updateArtwork 產生）：'top' 為頂端名牌，'label:k' 為第 k 種顏料
const EMPTY_ART = { art: null, canvas: null, dataUrl: null, empty: true };
const artCache = new Map();
let artwork = EMPTY_ART;
const artFor = (part) => artCache.get(part.artKey) || EMPTY_ART;
const labelText = (k) => state.labels.items[k]?.text?.trim() || `顏料 ${k + 1}`;
const labelOn = (k) => state.labels.items[k]?.on !== false;
// 送進 rack.js 的參數：有任何顏料名牌開啟時，前緣留邊會自動加寬
const rackInput = () => ({
  ...state.params,
  labelsOn: state.labels.enabled && kindsCount() > 0 && [...Array(kindsCount()).keys()].some(labelOn),
});
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

// 控制球：掛點與名牌的移動、縮放都直接拖球（不用座標軸）
const handlesGroup = new THREE.Group();
scene.add(handlesGroup);
let drag = null; // 拖拉中的控制球：{ type, plane, start, ... }

const KIND_COLORS = {
  side: 0xd9b48a, back: 0xc49a6c, shelf: 0xe4c49c, holeplate: 0xebd2ae, top: 0xe4c49c, clip: 0x6f9bd1, splice: 0x5fb08a,
  nameplate: 0xe8cfa8, label: 0xf0dcbc, capside: 0xd9b48a,
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

/** @param light 拖拉中：只更新 3D，略過排版、材料表與側欄（放開時再完整重建） */
function rebuild(light = false) {
  rack = buildRack(rackInput(), state.mounts, {
    nameplate: { ...state.nameplate, art: artwork.art },
    labels: {
      ...state.labels,
      items: Array.from({ length: kindsCount() }, (_, k) => ({
        on: labelOn(k), art: artCache.get(`label:${k}`)?.art || null,
      })),
    },
  });
  const L = rack.layout;

  hovered = null;
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

  if (light) {
    buildMountSpheres();
    buildSignHandles();
    return;
  }

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

  // 重建後保留名牌的選取與控制球
  if (state.selectedSign && !selectedSignPart()) state.selectedSign = null;
  buildSignHandles();
  updateHint();
  renderInspector();

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
  ok: new THREE.MeshBasicMaterial({ color: 0xd9822b, depthTest: false, transparent: true }),
  bad: new THREE.MeshBasicMaterial({ color: 0xd6453d, depthTest: false, transparent: true }),
  sel: new THREE.MeshBasicMaterial({ color: 0xffc061, depthTest: false, transparent: true }),
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
  }
}

function snapValue(v) {
  const g = state.params.gridSnap;
  return g > 0 ? Math.round(v / g) * g : Math.round(v * 10) / 10;
}

// ---------- 名牌：選取與控制球 ----------
// key：'top' = 頂端名牌；數字 = 第幾種顏料。顏料名牌的大小與位置全部連動（共用一組設定）
const signKey = (part) => (part.kind === 'nameplate' ? 'top' : part.labelKind);
const isSign = (part) => part && (part.kind === 'nameplate' || part.kind === 'label');
const signCfg = (key) => (key === 'top' ? state.nameplate : state.labels);
const sameGroup = (part, key) => isSign(part) && (key === 'top' ? part.kind === 'nameplate' : part.kind === 'label');
const signParts = (key) => rack.parts.filter((p) => isSign(p) && signKey(p) === key);
const coarsePointer = matchMedia('(pointer: coarse)').matches; // 觸控：控制球與可點範圍都放大
const handleMats = {
  // transparent：與名牌雕刻貼圖同一批繪製，renderOrder 才能讓控制球畫在最上層
  move: new THREE.MeshBasicMaterial({ color: 0xd9822b, depthTest: false, transparent: true }),
  size: new THREE.MeshBasicMaterial({ color: 0x3a6fd8, depthTest: false, transparent: true }),
};
const outlineMat = new THREE.LineDashedMaterial({ color: 0x3a6fd8, dashSize: 5, gapSize: 3, depthTest: false, transparent: true });

function selectedSignPart() {
  if (!state.selectedSign || !rack) return null;
  const list = signParts(state.selectedSign.key);
  return list.find((p) => p.module.join(',') === state.selectedSign.module) || list[0] || null;
}

function selectSign(part) {
  state.selected = null;
  state.selectedSign = { key: signKey(part), module: part.module.join(',') };
  buildMountSpheres();
  buildSignHandles();
  updateOverlay();
  renderMounts();
  updateHint();
  markLabelRow();
  renderInspector();
}

function markLabelRow() {
  for (const row of document.querySelectorAll('.label-row')) {
    const k = Number(row.querySelector('[data-lb-pick]').dataset.lbPick);
    row.classList.toggle('selected', state.selectedSign?.key === k);
  }
}

function clearSelection() {
  state.selected = null;
  state.selectedSign = null;
  disposeGroup(handlesGroup);
  buildMountSpheres();
  updateOverlay();
  renderMounts();
  updateHint();
  markLabelRow();
  renderInspector();
}

const handleRadius = () => Math.max(4, Math.max(rack.layout.totalW, rack.layout.totalH) * 0.009) * (coarsePointer ? 1.5 : 1);
const signHeight = (part) => (part.kind === 'nameplate' ? rack.info.nameplateH : rack.info.labelH);
const alignText = { left: '靠左', center: '置中', right: '靠右' };

/** 選取的名牌：橘球＝移動、左右藍球＝拉寬窄、上方藍球＝拉高，外加虛線外框與尺寸 */
function buildSignHandles() {
  disposeGroup(handlesGroup);
  handlesGroup.position.x = 0;
  const part = selectedSignPart();
  if (!part || state.explode > 0) return;
  const s = part.span, [ox, oy, oz] = part.origin;
  const top = part.kind === 'label' ? rack.info.labelH : part.bounds.maxY;
  const z = oz + part.t + 1, yMid = oy + top / 2, cx = ox + (s.x0 + s.x1) / 2;
  const r = handleRadius() * (part.kind === 'label' ? 0.8 : 1);
  const ball = (type, pos, mat, scale = 1) => {
    const m = new THREE.Mesh(sphereGeo, mat);
    m.scale.setScalar(r * scale);
    m.position.set(...pos);
    m.renderOrder = 12;
    m.userData.handle = type;
    handlesGroup.add(m);
  };
  ball('move', [cx, yMid, z], handleMats.move, 1.7);
  ball('left', [ox + s.x0, yMid, z], handleMats.size);
  ball('right', [ox + s.x1, yMid, z], handleMats.size);
  ball('top', [cx, oy + top, z], handleMats.size);
  const pts = [[s.x0, 0], [s.x1, 0], [s.x1, top], [s.x0, top], [s.x0, 0]].map(([u, v]) => new THREE.Vector3(ox + u, oy + v, z));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), outlineMat);
  line.computeLineDistances();
  line.renderOrder = 11;
  handlesGroup.add(line);
  const pos = s.align === 'center' ? (s.offset ? ` ${s.offset > 0 ? '右' : '左'} ${fmt(Math.abs(s.offset))}` : '') : ` ${fmt(s.offset)}`;
  const tag = label(`${fmt(s.width)} × ${fmt(signHeight(part))} mm · ${alignText[s.align]}${pos}`, 'sign-tag');
  tag.position.set(cx, oy + top + r * 3, z);
  handlesGroup.add(tag);
}

// ---------- 拖拉 ----------
let rebuildTimer = null;
function rebuildSoon() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(true); }, 50);
}

function planeAt(z) { return new THREE.Plane(new THREE.Vector3(0, 0, 1), -z); }
function pointOn(plane) { const p = new THREE.Vector3(); return raycaster.ray.intersectPlane(plane, p) ? p : null; }

/** 螢幕距離挑選：離游標最近、在容許半徑內的物件（比射線打中小球容易得多，觸控更明顯） */
function pickNear(objects, e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const tol = coarsePointer ? 34 : 18;
  let best = null, bestD = tol;
  const v = new THREE.Vector3();
  for (const o of objects) {
    o.getWorldPosition(v).project(camera);
    if (v.z > 1) continue;
    const d = Math.hypot(rect.left + (v.x + 1) / 2 * rect.width - e.clientX, rect.top + (1 - v.y) / 2 * rect.height - e.clientY);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function startDrag(type, obj) {
  const z = obj.getWorldPosition(new THREE.Vector3()).z;
  const plane = planeAt(z);
  drag = { type, plane, start: pointOn(plane) || obj.position.clone(), moved: false };
  if (type === 'mount') drag.mount = state.mounts.find((m) => m.id === obj.userData.mountId);
  else {
    const part = selectedSignPart();
    drag.part = part;
    drag.key = signKey(part);
    drag.span0 = { ...part.span };
  }
  orbit.enabled = false;
}

function moveDrag() {
  const p = pointOn(drag.plane);
  if (!p) return;
  drag.moved = true;
  const L = rack.layout;
  if (drag.type === 'mount') {
    const m = drag.mount;
    m.x = Math.min(L.totalW, Math.max(0, snapValue(p.x)));
    m.y = Math.min(L.totalH, Math.max(0, snapValue(p.y)));
    const s = mountsGroup.children.find((q) => q.userData.mountId === m.id);
    if (s) {
      s.position.set(m.x, m.y, mountZ());
      s.material = validateMount(L, m.x, m.y).valid ? sphereMats.sel : sphereMats.bad;
    }
    updateOverlay();
    renderMounts();
    renderInspector();
    return;
  }
  const { part, span0, key } = drag;
  const cfg = signCfg(key);
  const minW = part.kind === 'nameplate' ? 60 : 30;
  const u = p.x - part.origin[0], v = p.y - part.origin[1];
  const { aMin, aMax, x0, x1 } = span0;
  const setWidth = (w) => { cfg.width = w >= span0.full - 0.5 ? null : Math.round(w); };
  if (drag.type === 'move') {
    // 依對齊方式換算位移；所有同組名牌一起動
    const dx = p.x - drag.start.x;
    const want = span0.offset + (span0.align === 'right' ? -dx : dx);
    cfg.offset = Math.round(Math.min(span0.maxOffset, Math.max(span0.minOffset, want)));
    const shift = (cfg.offset - span0.offset) * (span0.align === 'right' ? -1 : 1);
    for (const w of partsGroup.children) if (sameGroup(w.userData.part, key)) w.position.x = shift;
    handlesGroup.position.x = shift;
    renderInspector();
    return;
  }
  if (drag.type === 'left' || drag.type === 'right') {
    if (span0.align === 'center') {
      // 置中：兩側一起伸縮，中心不動
      const c = (x0 + x1) / 2;
      const half = Math.max(minW / 2, Math.min(Math.abs(u - c), c - aMin, aMax - c));
      setWidth(half * 2);
    } else if ((span0.align === 'left') === (drag.type === 'right')) {
      // 拉離對齊的那一側：對齊側不動
      const w = drag.type === 'right' ? Math.min(aMax, Math.max(x0 + minW, u)) - x0 : x1 - Math.max(aMin, Math.min(x1 - minW, u));
      setWidth(w);
    } else {
      // 拉對齊的那一側：同時改寬度與離側板的距離
      if (drag.type === 'left') {
        const nx0 = Math.max(aMin, Math.min(x1 - minW, u));
        setWidth(x1 - nx0);
        cfg.offset = Math.round(nx0 - aMin);
      } else {
        const nx1 = Math.min(aMax, Math.max(x0 + minW, u));
        setWidth(nx1 - x0);
        cfg.offset = Math.round(aMax - nx1);
      }
    }
  }
  if (drag.type === 'top') {
    if (key === 'top') cfg.height = Math.round(Math.min(300, Math.max(20, v - L.e)));
    else cfg.height = Math.round(Math.min(rack.info.labelHMax, Math.max(4, v))); // 顏料名牌：最高到孔板下緣，其他零件不動
  }
  renderInspector();
  rebuildSoon();
}

function endDrag() {
  const d = drag;
  drag = null;
  orbit.enabled = true;
  clearTimeout(rebuildTimer);
  rebuildTimer = null;
  handlesGroup.position.x = 0;
  if (d.moved) {
    saveState();
    rebuild();
  }
}

/** 名牌還原：滿寬、置中 */
function resetSign(key) {
  const cfg = signCfg(key);
  Object.assign(cfg, { width: null, align: 'center', offset: 0 });
  saveState();
  rebuild();
}

function selectMount(id) {
  state.selectedSign = null;
  disposeGroup(handlesGroup);
  state.selected = id;
  for (const s of mountsGroup.children) {
    const m = state.mounts.find((q) => q.id === s.userData.mountId);
    const valid = validateMount(rack.layout, m.x, m.y).valid;
    s.material = s.userData.mountId === id ? sphereMats.sel : valid ? sphereMats.ok : sphereMats.bad;
  }
  updateOverlay();
  renderMounts();
  updateHint();
  markLabelRow();
  renderInspector();
}

// ---------- 操作提示 ----------
function updateHint() {
  const el = $('hint');
  if (!el) return;
  let html;
  if (state.selectedSign) {
    const lab = state.selectedSign.key !== 'top';
    html = `<b>${lab ? '顏料名牌（全部連動）' : '頂端名牌'}</b> 拖球或用下方面板調整 · 雙擊還原 · Esc 取消`;
  } else if (state.selected != null) {
    html = `<b>掛點 #${state.selected}</b> 拖拉或用下方面板微調 · Delete 刪除 · Esc 取消`;
  } else {
    html = '拖拉橘色球移動掛點 · 雙擊背板新增掛點' + (rack?.parts.some(isSign) ? ' · 點名牌可調整位置與大小' : '');
  }
  el.innerHTML = html;
}

// ---------- 選取面板：精確調整（手機也好操作） ----------
const nudgeRow = (key, label, value, unit, extra = '') => `
  <div class="insp-row"><span>${label}</span>
    <button data-nudge="${key}" data-d="-1" aria-label="${label}減少">−</button>
    <input type="number" data-insp="${key}" value="${value}" step="1" inputmode="decimal" aria-label="${label}"/>
    <button data-nudge="${key}" data-d="1" aria-label="${label}增加">＋</button>
    <em>${unit}</em>${extra}</div>`;

function renderInspector() {
  const el = $('inspector');
  if (!el || !rack) return;
  // 手機：選到東西時收起側欄，讓出畫面給木架與調整面板
  if ((state.selectedSign || state.selected != null) && matchMedia('(max-width: 640px)').matches && !$('sidebar').classList.contains('collapsed')) {
    setSidebar(false, false);
  }
  const part = selectedSignPart();
  const m = state.mounts.find((q) => q.id === state.selected);
  if (part && state.explode === 0) {
    const key = signKey(part), s = part.span;
    const offLabel = s.align === 'left' ? '離左側板' : s.align === 'right' ? '離右側板' : '偏移（右正）';
    el.innerHTML = `<div class="insp-head"><b>${key === 'top' ? '頂端名牌' : '顏料名牌'}</b>${key === 'top' ? '' : '<span>全部一起調整</span>'}
        <button class="ghost" data-insp-act="done">完成</button></div>
      <div class="seg insp-align">${['left', 'center', 'right'].map((a) => `<button data-align="${a}" aria-pressed="${s.align === a}">${alignText[a]}</button>`).join('')}</div>
      ${nudgeRow('offset', offLabel, fmtInput(s.offset), 'mm', s.maxOffset - s.minOffset < 0.5 ? '<small>滿寬時無法移動</small>' : '')}
      ${nudgeRow('width', '寬度', fmtInput(s.width), 'mm', `<button class="ghost" data-insp-act="full">滿寬</button>`)}
      ${nudgeRow('height', key === 'top' ? '高出頂蓋' : '名牌高度', fmtInput(signHeight(part)), 'mm', key === 'top' ? '' : `<small>最高 ${fmt(rack.info.labelHMax)} mm（到孔板下緣），只改名牌本身</small>`)}
      ${key === 'top' ? '' : `<p class="hint">名牌從正面插進層板前緣的開口槽，推到底即定位，隨時可往前拔出。</p>
        <div class="row-buttons"><button class="ghost" data-insp-act="raise">孔板加高 5 mm（名牌可再高 5 mm）</button></div>`}
      <div class="row-buttons"><button class="ghost" data-insp-act="reset">還原滿寬置中</button></div>`;
    el.hidden = false;
    el.dataset.kind = 'sign';
  } else if (m) {
    el.innerHTML = `<div class="insp-head"><b>掛點 #${m.id}</b><button class="ghost" data-insp-act="done">完成</button></div>
      ${nudgeRow('mx', 'X（離左）', fmtInput(m.x), 'mm')}
      ${nudgeRow('my', 'Y（離底）', fmtInput(m.y), 'mm')}
      <div class="row-buttons"><button class="ghost" data-insp-act="delete">刪除掛點</button></div>`;
    el.hidden = false;
    el.dataset.kind = 'mount';
  } else {
    el.hidden = true;
    el.innerHTML = '';
  }
}
const fmtInput = (v) => String(Math.round(v * 10) / 10);

/** 套用面板上的數值 */
function applyInspector(key, value) {
  if (!Number.isFinite(value)) return;
  const part = selectedSignPart();
  const m = state.mounts.find((q) => q.id === state.selected);
  if (part) {
    const k = signKey(part), cfg = signCfg(k);
    if (key === 'offset') cfg.offset = value;
    if (key === 'width') cfg.width = value >= part.span.full - 0.5 ? null : value;
    if (key === 'height') cfg.height = k === 'top' ? value : Math.min(rack.info.labelHMax, Math.max(4, value));
    saveState();
    rebuild();
  } else if (m) {
    const L = rack.layout;
    if (key === 'mx') m.x = Math.min(L.totalW, Math.max(0, value));
    if (key === 'my') m.y = Math.min(L.totalH, Math.max(0, value));
    saveState();
    rebuild();
  }
}

{
  const el = $('inspector');
  const steps = { offset: 5, width: 10, height: 2, mx: 5, my: 5 };
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const part = selectedSignPart();
    if (t.dataset.nudge) {
      const input = el.querySelector(`[data-insp="${t.dataset.nudge}"]`);
      applyInspector(t.dataset.nudge, Number(input.value) + steps[t.dataset.nudge] * Number(t.dataset.d));
    } else if (t.dataset.align && part) {
      // 換對齊方式：貼齊那一側（置中＝正中間），再用位移調整
      Object.assign(signCfg(signKey(part)), { align: t.dataset.align, offset: 0 });
      saveState();
      rebuild();
    } else if (t.dataset.inspAct === 'full' && part) applyInspector('width', part.span.full);
    else if (t.dataset.inspAct === 'reset' && part) resetSign(signKey(part));
    else if (t.dataset.inspAct === 'raise') {
      // 由使用者明確選擇：固定孔板加高（罐頂距離的下限會跟著抬高）
      state.params.retainHeight = Math.round(rack.layout.retain + 5);
      state.labels.height = Math.round(rack.info.labelHMax + 5);
      renderParams();
      onParamsChanged();
    }
    else if (t.dataset.inspAct === 'delete' && state.selected != null) removeMount(state.selected);
    else if (t.dataset.inspAct === 'done') clearSelection();
  });
  el.addEventListener('change', (e) => {
    const key = e.target.dataset.insp;
    if (key) applyInspector(key, Number(e.target.value));
  });
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
  root.innerHTML = `
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
    if (f.min != null) input.min = f.min; // 有連動下限的欄位：只能往上調
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
    <div class="dims"><b>${fmt(i.width)}</b> × <b>${fmt(i.height)}</b> × <b>${fmt(i.depth)}</b> <span>mm</span></div>
    <div class="meta">${i.mx}×${i.my} 模組 · 每模組 ${i.cols}×${i.rows} · ${i.capacity} 罐${extra > 0 ? `（空 ${extra}）` : ''} · ${rack.parts.length} 件</div>`;
  const w = [...rack.warnings, ...(layout?.warnings || [])];
  $('warnings').innerHTML = w.length
    ? `<details class="warn-box"><summary>${w.length} 項注意</summary>${w.map((t) => `<div class="warn">• ${t}</div>`).join('')}</details>`
    : '';
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

// 游標旁的零件資訊
function showTooltip(part, e) {
  const el = $('tooltip');
  const b = part.bounds;
  const slots = part.holes.filter((h) => h.type === 'poly' && h.mount == null && !h.art).length;
  const circles = part.holes.filter((h) => h.type === 'circle').length;
  const keyholes = part.holes.filter((h) => h.mount != null).length;
  const extra = [slots && `榫槽 ${slots}`, circles && `圓孔 ${circles}`, keyholes && `掛孔 ${keyholes}`].filter(Boolean).join(' · ');
  el.innerHTML = `<b>${escapeAttr(part.name)}</b><span>${fmt(b.w)} × ${fmt(b.h)} × ${fmt(part.t)} mm${extra ? ` · ${extra}` : ''}</span>${isSign(part) ? '<em>點一下可移動、縮放</em>' : ''}`;
  const r = viewport.getBoundingClientRect();
  el.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 260)}px`;
  el.style.top = `${e.clientY - r.top + 16}px`;
  el.hidden = false;
}
function hideTooltip() { $('tooltip').hidden = true; }

// ---------- 互動 ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;

function setPointer(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  setPointer(e);
  downAt = { x: e.clientX, y: e.clientY, hit: false };
  // 1. 名牌控制球
  const h = pickNear(handlesGroup.children.filter((o) => o.userData.handle), e);
  if (h) { downAt.hit = true; startDrag(h.userData.handle, h); renderer.domElement.setPointerCapture(e.pointerId); return; }
  // 2. 掛點球：選取並直接拖
  const m = state.explode === 0 && pickNear(mountsGroup.children, e);
  if (m) {
    downAt.hit = true;
    selectMount(m.userData.mountId);
    startDrag('mount', m);
    renderer.domElement.setPointerCapture(e.pointerId);
    return;
  }
  // 3. 點名牌：出現控制球與調整面板
  if (state.explode > 0) return;
  const part = raycaster.intersectObjects(partsGroup.children, true).find((q) => q.object.isMesh)?.object.userData.part;
  if (isSign(part)) { downAt.hit = true; selectSign(part); }
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (drag) { endDrag(); return; }
  // 點空白處（不是旋轉視角）取消選取
  if (downAt && !downAt.hit && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4 && (state.selected != null || state.selectedSign)) clearSelection();
  downAt = null;
});

renderer.domElement.addEventListener('dblclick', (e) => {
  setPointer(e);
  const part = raycaster.intersectObjects(partsGroup.children, true).find((h) => h.object.isMesh)?.object.userData.part;
  if (!part || state.explode > 0) return;
  // 雙擊名牌：還原滿寬置中；雙擊背板：新增掛點
  if (isSign(part)) { resetSign(signKey(part)); return; }
  const hit = raycaster.intersectObjects(partsGroup.children, true).find((h) => h.object.isMesh);
  if (part.kind === 'back') addMount(snapValue(hit.point.x), snapValue(hit.point.y));
});

let hoverPending = false;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (drag) { setPointer(e); moveDrag(); hideTooltip(); return; }
  if (hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    setPointer(e);
    // 游標形狀提示能拖的東西
    const h = pickNear(handlesGroup.children.filter((o) => o.userData.handle), e);
    const onMount = !h && state.explode === 0 && pickNear(mountsGroup.children, e);
    renderer.domElement.style.cursor = h ? (h.userData.handle === 'top' ? 'ns-resize' : 'ew-resize') : onMount ? 'grab' : '';
    const hit = raycaster.intersectObjects(partsGroup.children, true).find((q) => q.object.isMesh);
    const mesh = h || onMount ? null : hit?.object || null;
    if (mesh && isSign(mesh.userData.part)) renderer.domElement.style.cursor = 'pointer';
    if (mesh !== hovered) {
      if (hovered) hovered.material = materials[hovered.userData.part.kind];
      hovered = mesh;
      if (hovered) hovered.material = hoverMat;
    }
    if (hovered) showTooltip(hovered.userData.part, e); else hideTooltip();
  });
});
renderer.domElement.addEventListener('pointerleave', hideTooltip);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected != null) removeMount(state.selected);
    else if (state.selectedSign) {
      // 關閉這片名牌
      const { key } = state.selectedSign;
      if (key === 'top') state.nameplate.enabled = false; else (state.labels.items[key] ||= {}).on = false; // 只關這一種
      state.selectedSign = null;
      saveState();
      renderNameplate();
      updateArtwork().then(rebuild);
    }
  }
  if (e.key === 'Escape') clearSelection();
});

function setView(kind) {
  const L = rack.layout;
  const c = new THREE.Vector3(L.totalW / 2, L.totalH / 2, L.depth / 2);
  // 依畫面直橫比讓整座木架放得進視野（手機直向時水平視角較窄）
  const radius = 0.5 * Math.hypot(L.totalW, L.totalH, L.depth);
  const vfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * visibleFrac());
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const d = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.92; // 外接球偏保守，略拉近
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
  if (state.explode > 0) { state.selectedSign = null; disposeGroup(handlesGroup); updateHint(); renderInspector(); }
};
// 側欄分頁
function setTab(tab) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  try { localStorage.setItem(STORE_KEY + '.tab', tab); } catch { /* 忽略 */ }
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => setTab(b.dataset.tab);
{
  let tab = 'design';
  try { tab = localStorage.getItem(STORE_KEY + '.tab') || tab; } catch { /* 忽略 */ }
  setTab(document.querySelector(`[data-panel="${tab}"]`) ? tab : 'design');
}

function setSidebar(open, reframe = true) {
  $('sidebar').classList.toggle('collapsed', !open);
  document.body.classList.toggle('sidebar-closed', !open);
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('sidebar-toggle').title = open ? '收合側欄' : '展開側欄';
  try { localStorage.setItem(STORE_KEY + '.sidebar', open ? '1' : '0'); } catch { /* 忽略 */ }
  if (rack && matchMedia('(max-width: 640px)').matches) { resize(); if (reframe) setView('iso'); }
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
  const np = state.nameplate, lb = state.labels;
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  $('nameplate').innerHTML = `
    <p class="hint">在 3D 點名牌（或清單的色點）：拖球或用畫面下方的面板，選靠左／置中／靠右再調距離、寬度、高度。</p>
    <div class="card">
      <label class="card-head"><span>頂端名牌</span><input type="checkbox" class="switch" id="np-enabled" ${np.enabled ? 'checked' : ''}/></label>
      <div id="np-body" ${np.enabled ? '' : 'hidden'}>
        <div class="pair">
          <label class="mini"><span>外形</span><select id="np-shape">${opts(NAMEPLATE_SHAPES, np.shape)}</select></label>
          <label class="mini"><span>加工</span><select id="np-mode">${opts(NAMEPLATE_MODES, np.mode)}</select></label>
        </div>
        <div class="art-row">
          <span class="input"><input type="text" id="np-text" value="${escapeAttr(np.text)}" maxlength="40" placeholder="名牌文字" aria-label="名牌文字"/></span>
          <label class="button">圖片<input type="file" id="np-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden/></label>
          <button id="np-clear" class="ghost" ${np.image ? '' : 'hidden'} title="移除圖片、改用文字">✕</button>
        </div>
        <div class="np-preview"><canvas id="np-canvas" width="300" height="80" aria-label="名牌圖案預覽"></canvas></div>
        <div class="art-row">
          <label class="mini grow"><span>黑白門檻</span><input type="range" id="np-threshold" min="10" max="245" step="1" value="${np.threshold}"/></label>
          <label class="check"><input type="checkbox" id="np-invert" ${np.invert ? 'checked' : ''}/> 反轉</label>
        </div>
        <p class="hint" id="np-status"></p>
        <button id="np-reset" class="ghost">還原滿寬置中</button>
      </div>
    </div>
    <div class="card">
      <label class="card-head"><span>顏料名牌 <small>每種一片，從正面插進層板、可隨時拔出；大小位置全部連動</small></span><input type="checkbox" class="switch" id="lb-enabled" ${lb.enabled ? 'checked' : ''}/></label>
      <div id="lb-body" ${lb.enabled ? '' : 'hidden'}>
        <div class="pair">
          <label class="mini"><span>加工</span><select id="lb-mode">${opts(NAMEPLATE_MODES, lb.mode)}</select></label>
          <div class="row-buttons tight">
            <button id="lb-all-on" class="ghost">全開</button>
            <button id="lb-all-off" class="ghost">全關</button>
            <button id="lb-reset" class="ghost">還原</button>
          </div>
        </div>
        <div id="lb-list" class="label-list"></div>
        <p class="hint" id="lb-status"></p>
      </div>
    </div>`;
  renderLabelList();
  const artChanged = () => { saveState(); updateArtwork().then(rebuild); };
  let timer = null;
  const later = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 250); };
  $('np-enabled').onchange = (e) => { np.enabled = e.target.checked; $('np-body').hidden = !np.enabled; artChanged(); };
  $('np-mode').onchange = (e) => { np.mode = e.target.value; artChanged(); };
  $('np-shape').onchange = (e) => { np.shape = e.target.value; saveState(); rebuild(); };
  $('np-text').oninput = (e) => { np.text = e.target.value; if (!np.image) later(artChanged); };
  $('np-threshold').oninput = (e) => { np.threshold = Number(e.target.value); later(artChanged); };
  $('np-invert').onchange = (e) => { np.invert = e.target.checked; artChanged(); };
  $('np-clear').onclick = () => { np.image = null; $('np-clear').hidden = true; artChanged(); };
  $('np-reset').onclick = () => resetSign('top');
  $('lb-enabled').onchange = (e) => { lb.enabled = e.target.checked; $('lb-body').hidden = !lb.enabled; artChanged(); };
  $('lb-mode').onchange = (e) => { lb.mode = e.target.value; artChanged(); };
  const setAll = (on) => { for (let k = 0; k < kindsCount(); k++) (lb.items[k] ||= {}).on = on; renderLabelList(); artChanged(); };
  $('lb-all-on').onclick = () => setAll(true);
  $('lb-all-off').onclick = () => setAll(false);
  $('lb-reset').onclick = () => {
    Object.assign(lb, { width: null, height: 12, align: 'center', offset: 0 });
    saveState();
    rebuild();
  };
  $('np-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      // 縮到 3000px 以內再存：夠雷射點陣用，也避免瀏覽器儲存空間不足
      const img = await loadImage(await readFileAsDataURL(file));
      const longSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      // SVG 是向量圖，直接放大畫；點陣圖只縮不放
      const sc = file.type === 'image/svg+xml' ? 3000 / longSide : Math.min(1, 3000 / longSide);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * sc));
      c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * sc));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      np.image = c.toDataURL('image/png');
      $('np-clear').hidden = false;
      artChanged();
    } catch (err) {
      $('np-status').textContent = `無法讀取圖片：${err.message}`;
    }
  };
}

let lbTimer = null, labelListK = -1;

/** 每種顏料一列：開關、顏色點（與 3D 罐子同色，點一下在 3D 選取那片名牌）、名牌文字 */
function renderLabelList() {
  const list = $('lb-list');
  if (!list) return;
  const K = kindsCount();
  labelListK = K;
  list.innerHTML = Array.from({ length: K }, (_, k) => {
    const hue = Math.round(((k * 0.618034) % 1) * 360);
    const sel = state.selectedSign?.key === k ? ' selected' : '';
    return `<div class="label-row${sel}">
      <input type="checkbox" data-lb-on="${k}" ${labelOn(k) ? 'checked' : ''} aria-label="第 ${k + 1} 種名牌開關"/>
      <button class="swatch" data-lb-pick="${k}" style="background:hsl(${hue} 55% 55%)" title="在 3D 選取這片名牌" aria-label="選取第 ${k + 1} 種名牌"></button>
      <span class="input"><input type="text" data-lb-text="${k}" maxlength="24" placeholder="顏料 ${k + 1}" value="${escapeAttr(state.labels.items[k]?.text || '')}"/></span>
    </div>`;
  }).join('');
  list.oninput = (e) => {
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
  list.onclick = (e) => {
    const k = Number(e.target.dataset.lbPick);
    if (Number.isNaN(k)) return;
    const part = rack && signParts(k)[0];
    if (part) selectSign(part);
  };
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
        state.labels = { ...state.labels, ...d.labels, items: Array.isArray(d.labels.items) ? d.labels.items.map((it) => ({ on: it?.on !== false, text: String(it?.text ?? '') })) : [] };
      }
      return;
    }
  } catch { /* 讀取失敗則使用預設 */ }
  resetMounts();
}

// ---------- 啟動 ----------
// 手機版側欄佔下半部：只用上方可見區域，畫面中心往上移
const visibleFrac = () => (matchMedia('(max-width: 640px)').matches && !$('sidebar').classList.contains('collapsed') ? 0.46 : 1);
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  const f = visibleFrac();
  if (f < 1) camera.setViewOffset(w, h, 0, (h * (1 - f)) / 2, w, h);
  else camera.clearViewOffset();
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
// 除錯／瀏覽器測試用：名牌控制球位置、世界座標 → 螢幕座標
window.__handles = () => handlesGroup.children.filter((o) => o.userData.handle).map((o) => ({ type: o.userData.handle, pos: o.position.toArray() }));
window.__project = (w) => {
  const v = Array.isArray(w) ? new THREE.Vector3(...w) : new THREE.Vector3(w.x, w.y, w.z);
  v.project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
};
// 除錯用：鏡頭對準第一欄的上下接縫
window.__look = () => {
  const L = rack.layout;
  const t = new THREE.Vector3(L.t * 3, L.H, L.depth / 2);
  orbit.target.copy(t);
  camera.position.copy(t).add(new THREE.Vector3(160, 60, 260));
  orbit.update();
};
window.__lookAt = (target, eye) => { orbit.target.set(...target); camera.position.set(...eye); orbit.update(); };
