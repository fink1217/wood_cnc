import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { autoMounts, validateMount } from './system/frame.js';
import { NAMEPLATE_MODES, NAMEPLATE_SHAPES } from './system/signs.js';
import { SHARED_KEYS } from './system/spec.js';
import { TYPES, TYPE_LIST, DEFAULT_TYPE } from './types/index.js';
import { layoutParts, flatten, toSVG, toDXF, toBOM, makeZip, KIND_NAMES } from './export.js';
import { calculatorUrl } from './calculator-link.js';
import { loadImage, readFileAsDataURL, textCanvas, rasterize, cropMask, maskToArtwork } from './artwork.js';

// 目前的架子類型：參數清單、尺寸推算、零件都由它決定（外框與接合各類型共用）
let T = TYPES[DEFAULT_TYPE];
const buildRack = (...a) => T.build(...a);
const deriveLayout = (input) => T.derive(input);
const normalizeParams = (input) => T.normalizeParams(input);
const linkedSpecs = () => [...T.LINKED_BASIC_SPEC, ...T.ADVANCED_SPEC];
const noun = () => T.itemNoun; // 罐／瓶

const STORE_KEY = 'paintRack.v2';
const $ = (id) => document.getElementById(id);
const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ---------- 狀態 ----------
const state = {
  type: DEFAULT_TYPE,
  byType: {}, // 每種架子各自的 { params, mounts, nextId }；共用參數（板厚、機器…）切換時帶過去
  params: { ...T.DEFAULTS },
  mounts: [],
  nextId: 1,
  selected: null,
  explode: 0,
  showCans: true,
  showDims: true,
  // 展示名牌：image 為使用者匯入的圖片（縮小後的 data URL），沒有圖片時用文字
  // artX / artY：圖案離置中位置的距離（mm）；artScale：圖案佔名牌可用區的幾成，小於 1 才有空間左右移
  nameplate: { enabled: false, mode: 'laser', shape: 'rect', height: 60, width: null, align: 'center', offset: 0, text: 'PAINT', threshold: 128, invert: false, image: null,
    artX: 0, artY: 0, artScale: 0.8 },
  // 每種顏料各自的名牌：items[k] = { on, text, offset }，可各自關閉、各自左右移；width 空白 = 滿寬
  // 每種顏料各自的名牌：items[k] = { on, text } 各自開關；大小與位置全部連動
  // height = 名牌板高度（空白 = 蓋住層板與孔板前緣；只影響名牌），align / offset / width = 文字區位置
  labels: { enabled: false, mode: 'laser', height: null, width: null, align: 'center', offset: 0, items: [] },
  selectedSign: null, // { key: 'top' | 顏料編號, module }：正在調整的名牌
  selectedGap: false, // 點了罐子／瓶子：調整左右的手指空間
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
  labelH: state.labels.height, // 名牌高過孔板時，罐頂距離自動加大
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
viewport.appendChild(labelRenderer.domElement);

const BG = 0x060708;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 1000, 4000);
const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1410, 0.75));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
const rim = new THREE.DirectionalLight(0x4ef0ff, 0.7); // 冷色側光勾出輪廓
scene.add(rim);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);

const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x0f1114, roughness: 1 }));
wall.receiveShadow = true;
scene.add(wall);
let wallGrid = null;
let fogSpan = 1000; // 霧跟著鏡頭距離：木架永遠清楚，遠處格線淡入黑暗

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
  side: 0xd9b48a, back: 0xc49a6c, shelf: 0xe4c49c, holeplate: 0xebd2ae, top: 0xe4c49c, clip: 0x4ec9e0, splice: 0x3fd6a0,
  nameplate: 0xe8cfa8, label: 0xf0dcbc, capside: 0xd9b48a, front: 0xebd2ae, rear: 0xd9b48a,
};
const materials = {};
for (const [k, c] of Object.entries(KIND_COLORS)) materials[k] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x3a2a1c, transparent: true, opacity: 0.5 });
const hoverMat = new THREE.MeshStandardMaterial({ color: 0xbfeff5, roughness: 0.6, emissive: 0x0b4a55 });

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
  for (const c of rack.items) {
    const hue = (c.kind * 0.618034) % 1;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.55, 0.55), roughness: 0.4, metalness: 0.1 });
    if (c.shape === 'bottle') {
      cansGroup.add(bottleMesh(c, mat));
      continue;
    }
    const m = new THREE.Mesh(canGeo, mat);
    m.scale.set(c.r, c.h, c.r);
    m.position.set(c.x, c.y + c.h / 2, c.z);
    m.castShadow = true;
    m.userData.can = c;
    cansGroup.add(m);
  }
  cansGroup.visible = state.showCans;

  // 牆面
  const span = Math.max(L.totalW, L.totalH);
  wall.scale.set(L.totalW + span, L.totalH + span, 1);
  wall.position.set(L.totalW / 2, L.totalH / 2, -0.5);
  if (wallGrid) { scene.remove(wallGrid); wallGrid.geometry.dispose(); }
  const gsize = Math.ceil((span * 2) / 100) * 100;
  wallGrid = new THREE.GridHelper(gsize, gsize / 50, 0x1d4a52, 0x16191d);
  wallGrid.rotation.x = Math.PI / 2;
  wallGrid.position.set(L.totalW / 2, L.totalH / 2, -0.2);
  scene.add(wallGrid);

  sun.position.set(L.totalW * 0.2 + span, L.totalH + span, span * 1.5);
  rim.position.set(-span * 1.5, L.totalH * 0.7, span * 0.6);
  fogSpan = span;
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

  if (firstBuild) { setView('iso', { intro: true }); firstBuild = false; }
}

// 尖嘴瓶：瓶身圓柱 + 收窄的瓶肩與尖嘴，沿著傾斜方向擺
const bottleNozzleMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.5 });
function bottleMesh(c, mat) {
  const g = new THREE.Group();
  const body = c.len * 0.62, shoulder = c.len * 0.14, nozzle = c.len - body - shoulder;
  const parts = [
    [new THREE.CylinderGeometry(c.r, c.r, body, 32), mat, body / 2],
    [new THREE.CylinderGeometry(c.r * 0.45, c.r, shoulder, 32), mat, body + shoulder / 2],
    [new THREE.CylinderGeometry(1.2, c.r * 0.35, nozzle, 16), bottleNozzleMat, body + shoulder + nozzle / 2],
  ];
  for (const [geo, m, at] of parts) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.y = at;
    mesh.castShadow = true;
    mesh.userData.can = c;
    g.add(mesh);
  }
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...c.dir));
  g.position.set(c.x, c.y, c.z);
  return g;
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
  ok: new THREE.MeshBasicMaterial({ color: 0x4ef0ff, depthTest: false, transparent: true }),
  bad: new THREE.MeshBasicMaterial({ color: 0xff5468, depthTest: false, transparent: true }),
  sel: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
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
    // 觸控螢幕小，掛點多時編號會疊在一起：只標選取的那個
    if (!coarsePointer || m.id === state.selected) {
      const tag = label(`#${m.id}`, 'mount-tag');
      tag.position.set(0, 1.9, 0);
      s.add(tag);
    }
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
  move: new THREE.MeshBasicMaterial({ color: 0x4ef0ff, depthTest: false, transparent: true }),
  size: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
};
const outlineMat = new THREE.LineDashedMaterial({ color: 0x4ef0ff, dashSize: 5, gapSize: 3, depthTest: false, transparent: true });
const artOutlineMat = new THREE.LineDashedMaterial({ color: 0xffb35c, dashSize: 3, gapSize: 2, depthTest: false, transparent: true });
handleMats.art = new THREE.MeshBasicMaterial({ color: 0xffb35c, depthTest: false, transparent: true });

/** 點到的是否為選取中頂端名牌的圖案區：回傳該名牌零件 */
function hitSignArt(pad = 4) { // pad：圖案很細時也點得到
  const sel = state.selectedSign;
  if (!sel || sel.key !== 'top' || state.explode > 0) return null;
  const hit = raycaster.intersectObjects(partsGroup.children, true).find((q) => q.object.isMesh);
  const part = hit?.object.userData.part;
  if (!part || part.kind !== 'nameplate' || !part.artRect) return null;
  const a = part.artRect, u = hit.point.x - part.origin[0], v = hit.point.y - part.origin[1];
  return u >= a.x - pad && u <= a.x + a.w + pad && v >= a.y - pad && v <= a.y + a.h + pad ? part : null;
}

function selectedSignPart() {
  if (!state.selectedSign || !rack) return null;
  const list = signParts(state.selectedSign.key);
  return list.find((p) => p.module.join(',') === state.selectedSign.module) || list[0] || null;
}

function selectSign(part) {
  state.selected = null;
  state.selectedGap = false;
  state.selectedSign = { key: signKey(part), module: part.module.join(',') };
  buildMountSpheres();
  buildSignHandles();
  updateOverlay();
  renderMounts();
  updateHint();
  markLabelRow();
  renderInspector();
  if (isMobile()) focusSign(part);
}

/** 手機：鏡頭拉近選取的名牌，放在調整面板上方，手指才拖得到 */
let viewBeforeFocus = null;
function focusSign(part) {
  const b = part.bounds, [ox, oy, oz] = part.origin;
  const c = new THREE.Vector3(ox + (b.minX + b.maxX) / 2, oy + (b.minY + b.maxY) / 2, oz);
  updateFracTarget();
  const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const d = Math.max((b.w * 0.72) / (tv * camera.aspect), (b.h * 0.9) / (tv * fracTarget)) + part.t;
  if (!viewBeforeFocus) viewBeforeFocus = { pos: camera.position.clone(), target: orbit.target.clone() };
  tweenCamera(c.clone().add(new THREE.Vector3(0, 0.12, 1).normalize().multiplyScalar(d)), c, 700);
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
  state.selectedGap = false;
  disposeGroup(handlesGroup);
  buildMountSpheres();
  updateOverlay();
  renderMounts();
  updateHint();
  markLabelRow();
  renderInspector();
  // 手機：名牌調完回到原本的視角
  if (viewBeforeFocus) {
    updateFracTarget();
    tweenCamera(viewBeforeFocus.pos, viewBeforeFocus.target, 700);
    viewBeforeFocus = null;
  }
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
  const art = part.kind === 'nameplate' && part.artRect;
  ball('move', [cx, art ? oy : yMid, z], handleMats.move, 1.7); // 頂端名牌：中間留給圖案，移動球放在下緣
  if (art) {
    // 圖案外框（可直接拖）＋右上角縮放球
    const a = part.artRect;
    const apts = [[a.x, a.y], [a.x + a.w, a.y], [a.x + a.w, a.y + a.h], [a.x, a.y + a.h], [a.x, a.y]].map(([u, v]) => new THREE.Vector3(ox + u, oy + v, z));
    const aline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(apts), artOutlineMat);
    aline.computeLineDistances();
    aline.renderOrder = 11;
    handlesGroup.add(aline);
    ball('artsize', [ox + a.x + a.w, oy + a.y + a.h, z], handleMats.art, 0.8);
  }
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
  if (type === 'mount') {
    drag.mount = state.mounts.find((m) => m.id === obj.userData.mountId);
    drag.snapshot = { x: drag.mount.x, y: drag.mount.y };
  } else {
    const part = selectedSignPart();
    drag.part = part;
    drag.key = signKey(part);
    drag.span0 = { ...part.span };
    drag.art0 = part.artPos && { ...part.artPos, rect: { ...part.artRect } };
    drag.snapshot = { ...signCfg(drag.key) };
  }
  orbit.enabled = false;
  navigator.vibrate?.(8);
}

/** 拖拉被打斷（第二根手指放下、系統取消）：還原到拖拉前 */
function cancelDrag() {
  const d = drag;
  drag = null;
  orbit.enabled = true;
  clearTimeout(rebuildTimer);
  rebuildTimer = null;
  handlesGroup.position.x = 0;
  if (d.type === 'mount') Object.assign(d.mount, d.snapshot);
  else Object.assign(signCfg(d.key), d.snapshot);
  rebuild();
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
  if (drag.type === 'art' && drag.art0) {
    // 拖圖案：在名牌可用區內自由移動（左右、上下）
    const a = drag.art0;
    cfg.artX = Math.round(Math.min(a.maxDx, Math.max(a.minDx, a.dx + p.x - drag.start.x)));
    cfg.artY = Math.round(Math.min(a.maxDy, Math.max(a.minDy, a.dy + p.y - drag.start.y)));
    renderInspector();
    rebuildSoon();
    return;
  }
  if (drag.type === 'artsize' && drag.art0) {
    // 拉右上角：以圖案中心等比縮放
    const r = drag.art0.rect, cxA = part.origin[0] + r.x + r.w / 2, cyA = part.origin[1] + r.y + r.h / 2;
    const k = Math.max(Math.abs(p.x - cxA) / (r.w / 2), Math.abs(p.y - cyA) / (r.h / 2));
    cfg.artScale = Math.round(Math.min(1, Math.max(0.15, drag.art0.scale * k)) * 100) / 100;
    renderInspector();
    rebuildSoon();
    return;
  }
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
    else cfg.height = Math.round(Math.min(rack.info.labelHMax, Math.max(6, v))); // 顏料名牌板：高過孔板時罐頂距離自動加大
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
    // 顏料名牌高度會連動罐頂距離（列距）：走參數連動，掛點跟著調整
    if (d.type === 'top' && d.key !== 'top') onParamsChanged(); else rebuild();
  }
}

/** 名牌還原：滿寬、置中 */
/** 點罐子：用面板調整罐子左右的手指空間 */
function selectGap() {
  state.selected = null;
  state.selectedSign = null;
  state.selectedGap = true;
  disposeGroup(handlesGroup);
  buildMountSpheres();
  updateOverlay();
  renderMounts();
  updateHint();
  markLabelRow();
  renderInspector();
}

/** 手指空間：null = 自動（預設值） */
function setCanGap(v) {
  state.params.canGap = v;
  const input = $('param-canGap');
  if (input) input.value = v ?? '';
  onParamsChanged();
}

function resetSign(key) {
  const cfg = signCfg(key);
  Object.assign(cfg, { width: null, align: 'center', offset: 0 });
  if (key === 'top') Object.assign(cfg, { artX: 0, artY: 0 });
  saveState();
  rebuild();
}

function selectMount(id) {
  state.selectedSign = null;
  state.selectedGap = false;
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
let hintTimer = null, lastHint = '';
function updateHint() {
  const el = $('hint');
  if (!el) return;
  let html;
  if (state.selectedSign) {
    const lab = state.selectedSign.key !== 'top';
    html = lab
      ? '<b>顏料名牌 · 全部連動</b>' + (coarsePointer ? '拖球或用下面的面板調' : '拖球或用下面的面板調 · 雙擊還原 · Esc 取消')
      : '<b>頂端名牌</b>直接拖圖案移動，橘色角球縮放' + (coarsePointer ? '' : ' · 雙擊還原 · Esc 取消');
  } else if (state.selectedGap) {
    html = `<b>手指空間</b>${noun()}子之間和靠側板的空隙會一起變`;
  } else if (state.selected != null) {
    html = `<b>掛點 #${state.selected}</b>` + (coarsePointer ? '按住拖，或用下面的面板微調' : '拖拉或用下面的面板微調 · Delete 刪除 · Esc 取消');
  } else {
    const signs = (rack?.parts.some(isSign) ? ' · 點名牌調整' : '') + ` · 點${noun()}子調手指空間`;
    html = (coarsePointer ? '單指轉、雙指縮放，掛點先點一下再拖' : '拖掛點移動 · 雙擊背板加掛點') + signs;
  }
  if (html === lastHint) return;
  lastHint = html;
  el.innerHTML = html;
  el.classList.remove('fade');
  clearTimeout(hintTimer);
  if (!state.selectedSign && state.selected == null && !state.selectedGap) hintTimer = setTimeout(() => el.classList.add('fade'), 6000);
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
  const part = selectedSignPart();
  const m = state.mounts.find((q) => q.id === state.selected);
  if (part && state.explode === 0) {
    const key = signKey(part), s = part.span;
    const offLabel = s.align === 'left' ? '離左側板' : s.align === 'right' ? '離右側板' : '偏移（右正）';
    el.innerHTML = `<div class="insp-head"><b>${key === 'top' ? '頂端名牌' : '顏料名牌'}</b>${key === 'top' ? '' : '<span>全部一起調整</span>'}
        <button class="primary" data-insp-act="done">完成</button></div>
      <div class="seg insp-align">${['left', 'center', 'right'].map((a) => `<button data-align="${a}" aria-pressed="${s.align === a}">${alignText[a]}</button>`).join('')}</div>
      ${nudgeRow('offset', offLabel, fmtInput(s.offset), 'mm', s.maxOffset - s.minOffset < 0.5 ? '<small>滿寬時不能左右移</small>' : '')}
      ${nudgeRow('width', '寬度', fmtInput(s.width), 'mm', `<button class="ghost" data-insp-act="full">滿寬</button>`)}
      ${nudgeRow('height', key === 'top' ? '高出頂蓋' : '名牌高度', fmtInput(signHeight(part)), 'mm', key === 'top' ? '' : `<small>${rack.layout.fields.topGap?.note?.includes('名牌') ? '名牌比孔板高，上層已經自動加高' : '沒超過孔板就不會動到別的零件'}。最高到罐頂 ${fmt(rack.info.labelHMax)} mm</small>`)}
      ${key === 'top' && part.artPos ? `<div class="insp-sub">圖案</div>
        ${nudgeRow('artX', '左右', fmtInput(part.artPos.dx), 'mm')}
        ${nudgeRow('artY', '上下', fmtInput(part.artPos.dy), 'mm')}
        ${nudgeRow('artScale', '大小', Math.round(part.artPos.scale * 100), '%', part.artPos.maxDx < 0.5 && part.artPos.maxDy - part.artPos.minDy < 0.5 ? '<small>圖案已經撐滿，縮小一點才有空間移動</small>' : '')}
        <div class="row-buttons"><button class="ghost" data-insp-act="art-center">圖案置中</button></div>` : ''}
      ${key === 'top' ? '' : '<p class="hint">名牌從正面插進側板的槽，要換直接拔出來。左右和寬度調的是字的位置。</p>'}
      <div class="row-buttons"><button class="ghost" data-insp-act="reset">還原滿寬置中</button></div>`;
    el.hidden = false;
    el.dataset.kind = 'sign';
  } else if (state.selectedGap && state.explode === 0) {
    const f = rack.layout.fields.canGap;
    el.innerHTML = `<div class="insp-head"><b>手指空間</b><span>${f.auto ? '自動' : '手動'}</span>
        <button class="primary" data-insp-act="done">完成</button></div>
      ${nudgeRow('gap', `${noun()}子左右`, fmtInput(f.value), 'mm', `<small>${noun()}子之間、${noun()}子到側板都留這麼寬。調大架子會變寬，深度不變。${f.adjusted ? `<br>${f.note}` : ''}</small>`)}
      <div class="row-buttons">${[16, 20, 25].map((v) => `<button data-gap-preset="${v}">${v}</button>`).join('')}
        ${f.auto ? '' : '<button class="ghost" data-insp-act="gap-auto">改回自動</button>'}</div>
      <p class="hint">寬度 ${fmt(rack.info.width)} mm · 每模組 ${rack.layout.cols} ${noun()}寬</p>`;
    el.hidden = false;
    el.dataset.kind = 'gap';
  } else if (m) {
    el.innerHTML = `<div class="insp-head"><b>掛點 #${m.id}</b><button class="primary" data-insp-act="done">完成</button></div>
      ${nudgeRow('mx', 'X（離左）', fmtInput(m.x), 'mm')}
      ${nudgeRow('my', 'Y（離底）', fmtInput(m.y), 'mm')}
      <div class="row-buttons"><button class="ghost" data-insp-act="delete">刪除掛點</button></div>`;
    el.hidden = false;
    el.dataset.kind = 'mount';
  } else {
    el.hidden = true;
    el.innerHTML = '';
  }
  // 手機：選取時抽屜往下讓位給調整面板，取消選取再回來；木架改放在面板上方
  document.body.classList.toggle('selecting', !el.hidden);
  if (isMobile()) updateFracTarget();
}
const fmtInput = (v) => String(Math.round(v * 10) / 10);

/** 套用面板上的數值 */
function applyInspector(key, value) {
  if (!Number.isFinite(value)) return;
  const part = selectedSignPart();
  const m = state.mounts.find((q) => q.id === state.selected);
  if (state.selectedGap) {
    setCanGap(Math.min(60, Math.max(0, Math.round(value))));
  } else if (part) {
    const k = signKey(part), cfg = signCfg(k);
    if (key === 'offset') cfg.offset = value;
    if (key === 'width') cfg.width = value >= part.span.full - 0.5 ? null : value;
    if (key === 'height') cfg.height = k === 'top' ? value : Math.min(rack.info.labelHMax, Math.max(6, value));
    if (key === 'artX') cfg.artX = value;
    if (key === 'artY') cfg.artY = value;
    if (key === 'artScale') cfg.artScale = Math.min(1, Math.max(0.15, value / 100));
    saveState();
    if (key === 'height' && k !== 'top') onParamsChanged(); else rebuild();
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
  const steps = { offset: 5, width: 10, height: 2, mx: 5, my: 5, gap: 1, artX: 2, artY: 2, artScale: 5 };
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
    else if (t.dataset.inspAct === 'art-center') { Object.assign(state.nameplate, { artX: 0, artY: 0 }); saveState(); rebuild(); }

    else if (t.dataset.inspAct === 'delete' && state.selected != null) removeMount(state.selected);
    else if (t.dataset.gapPreset) setCanGap(Number(t.dataset.gapPreset));
    else if (t.dataset.inspAct === 'gap-auto') setCanGap(null);
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
  dim: new THREE.LineBasicMaterial({ color: 0x4ef0ff, depthTest: false, transparent: true, opacity: 0.7 }),
  pair: new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 4, depthTest: false, transparent: true, opacity: 0.5 }),
  edge: new THREE.LineDashedMaterial({ color: 0x4ef0ff, dashSize: 4, gapSize: 4, depthTest: false, transparent: true }),
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
    const zf = L.sideDepth;
    // 寬
    addLine([0, -off, zf], [L.totalW, -off, zf], lineMats.dim, `寬 ${fmt(L.totalW)}`);
    addLine([0, -off - 6, zf], [0, -off + 6, zf], lineMats.dim);
    addLine([L.totalW, -off - 6, zf], [L.totalW, -off + 6, zf], lineMats.dim);
    // 高
    addLine([-off, 0, zf], [-off, L.totalH, zf], lineMats.dim, `高 ${fmt(L.totalH)}`);
    addLine([-off - 6, 0, zf], [-off + 6, 0, zf], lineMats.dim);
    addLine([-off - 6, L.totalH, zf], [-off + 6, L.totalH, zf], lineMats.dim);
    // 深
    addLine([L.totalW + off, 0, 0], [L.totalW + off, 0, L.sideDepth], lineMats.dim, `深 ${fmt(L.sideDepth)}`);
  }

  // 手指空間：最下一列左邊兩罐之間、最左罐到側板（避開上方的掛點標籤）
  if (((state.showDims && !coarsePointer) || state.selectedGap) && rack.items.length) {
    const yTop = Math.min(...rack.items.map((c) => c.y));
    const row = rack.items.filter((c) => Math.abs(c.y - yTop) < 0.5).sort((a, b) => a.x - b.x);
    const c0 = row[0];
    const bottle = c0.shape === 'bottle';
    const y = bottle ? L.holeY[0] - L.b - 3 : c0.y + c0.h * 0.6, zc = bottle ? L.zf + L.t + 1 : c0.z + c0.r;
    const mat = state.selectedGap ? lineMats.dim : lineMats.edge;
    const cls = state.selectedGap ? 'gap-tag' : 'soft';
    addLine([L.t, y, zc], [c0.x - c0.r, y, zc], mat, fmt(L.side), cls);
    if (row[1] && row[1].x - c0.x < L.W) addLine([c0.x + c0.r, y, zc], [row[1].x - row[1].r, y, zc], mat, `手指 ${fmt(L.gap)}`, cls);
  }

  // 掛點之間：最小生成樹的邊（只標示相鄰的掛點）
  for (const [a, b] of mountPairs()) {
    // 觸控：只標跟選取掛點相連的距離，其他只畫線
    const show = !coarsePointer || a.id === state.selected || b.id === state.selected;
    addLine([a.x, a.y, z], [b.x, b.y, z], lineMats.pair, show ? `${fmt(Math.hypot(b.x - a.x, b.y - a.y))}` : '', 'soft');
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
    <div class="param-block">${T.BASIC_SPEC.map((s) => fieldHTML(s, state.params[s.key])).join('')}
      ${T.LINKED_BASIC_SPEC.map((s) => fieldHTML(s, state.params[s.key], 'data-adv="1"')).join('')}</div>
    <h3>加工與五金</h3>
    <div class="param-block">${T.CHOICE_SPEC.map((s) => `
      <label class="field"><span>${s.label}</span>
        <span class="input"><select id="param-${s.key}" data-key="${s.key}" data-choice="1">
          ${s.options.map(([v, l]) => `<option value="${v}" ${state.params[s.key] === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></span></label>`).join('')}</div>
    <details class="group" id="advanced">
      <summary>進階 <span class="hint">都會自動算，想改再填</span></summary>
      <div class="param-block">${T.ADVANCED_SPEC.map((s) => fieldHTML(s, state.params[s.key], 'data-adv="1"')).join('')}</div>
      <button id="adv-reset" class="ghost">進階全部改回自動</button>
    </details>`;
  $('assembly').innerHTML = T.ASSEMBLY_SPEC.map((s) => fieldHTML(s, state.params[s.key])).join('');
  syncMachineUI();
  try { $('advanced').open = localStorage.getItem(STORE_KEY + '.adv') === '1'; } catch { /* 忽略 */ }
  $('advanced').addEventListener('toggle', () => {
    try { localStorage.setItem(STORE_KEY + '.adv', $('advanced').open ? '1' : '0'); } catch { /* 忽略 */ }
  });
  $('adv-reset').onclick = () => {
    for (const s of T.ADVANCED_SPEC) { state.params[s.key] = null; $('param-' + s.key).value = ''; }
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
    if (el.dataset.choice) {
      state.params[key] = el.value;
      if (key === 'machine') switchMachine(el.value);
      onParamsChanged();
      return;
    }
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

// 換加工機器：板材換成適合的預設尺寸；雷射不用選銑刀
const LASER_SHEETS = ['1300x900', '900x600', '600x400'];
function switchMachine(machine) {
  const laserSheet = LASER_SHEETS.includes(state.params.sheet);
  if (machine === 'laser' && !laserSheet) state.params.sheet = '900x600';
  if (machine === 'cnc' && laserSheet) state.params.sheet = '1220x2440';
  if ($('param-sheet')) $('param-sheet').value = state.params.sheet;
  syncMachineUI();
}
function syncMachineUI() {
  const laser = state.params.machine === 'laser';
  const bit = $('param-bit');
  if (bit) {
    bit.disabled = laser;
    bit.title = laser ? '雷射不用銑刀' : '';
  }
}

/** 依連動結果更新進階欄位的提示與自動值 */
function updateFieldNotes() {
  const fields = rack.layout.fields;
  for (const spec of linkedSpecs()) {
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
  const n = T.ADVANCED_SPEC.filter((s) => fields[s.key] && !fields[s.key].auto).length;
  const adj = T.ADVANCED_SPEC.filter((s) => fields[s.key]?.adjusted).length;
  $('advanced').querySelector('summary .hint').textContent = n
    ? `改了 ${n} 項${adj ? `，其中 ${adj} 項有衝突，自動修正過` : ''}`
    : '都會自動算，想改再填';
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
  if (!$('dim-w')) {
    $('summary').innerHTML = `<div class="dims"><b id="dim-w">0</b><i>×</i><b id="dim-h">0</b><i>×</i><b id="dim-d">0</b><span>MM</span></div><div class="meta"></div>`;
  }
  countTo($('dim-w'), i.width);
  countTo($('dim-h'), i.height);
  countTo($('dim-d'), i.depth);
  $('summary').querySelector('.meta').innerHTML = `<span><b>${i.mx}×${i.my}</b> 模組</span><span><b>${i.cols}×${i.rows}</b> 每模組</span>` +
    `<span><b>${i.capacity}</b> ${noun()}${extra > 0 ? `（空 ${extra}）` : ''}</span><span><b>${rack.parts.length}</b> 件</span>`;
  const w = [...rack.warnings, ...(layout?.warnings || [])];
  $('warnings').innerHTML = w.length
    ? `<details class="warn-box"><summary>${w.length} 項注意</summary>${w.map((t) => `<div class="warn">• ${t}</div>`).join('')}</details>`
    : '';
  renderMounts();
}

/** 數字從舊值滾到新值 */
function countTo(el, to) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = to;
  cancelAnimationFrame(el._raf);
  if (reducedMotion || Math.abs(to - from) < 0.05) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function renderMounts() {
  const L = rack.layout;
  $('mount-list').innerHTML = state.mounts.length ? '' : '<p class="hint">還沒有掛點</p>';
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
    clip: `卡進左右兩個模組側板上下的槽，一條接縫 4 個，共 ${i.hJoints} 條`,
    splice: `貼在上下兩個模組的側板內側，一片鎖 4 支螺栓，一條接縫左右各 1 片，共 ${i.vJoints} 條`,
  };
  const total = i.mx * i.my;
  $('connectors').innerHTML = `<h2>連接點</h2>
    <p class="hint">${total} 個模組（${i.mx} × ${i.my}）${i.hJoints + i.vJoints ? `，${i.hJoints} 條水平接縫、${i.vJoints} 條垂直接縫` : '，不用連接件'}。</p>
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
    <h3>五金</h3>${hardwareTable() || '<p class="hint">不用五金。</p>'}
    <h3>排版 · ${layout.sheets.length} 張 ${P.sheetW}×${P.sheetH}（板材利用率約 ${(fill * 100).toFixed(0)}%）</h3>
    <div class="sheets">${layout.sheets.map((sh, k) => `<div class="sheet-card">${sheetThumb(sh)}第 ${k + 1} 張 · ${sh.items.length} 件</div>`).join('')}</div>
    <a class="button calc-link" href="${link}" target="_blank" rel="noopener">到板材計算機：從原板裁出 ${layout.sheets.length} 張 ${P.sheetW}×${P.sheetH} ↗</a>
    <p class="hint" style="margin-top:6px">把板材尺寸、張數和厚度帶過去，算要買幾張原板、怎麼裁。</p>`;
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

// 觸控防誤觸：
// - 名牌、掛點都在「點一下」（放開且沒移動）時才選取，轉視角時不會誤選
// - 觸控時掛點要先選取才能拖，手指剛好落在掛點附近轉視角也不會把它拖走
// - 第二根手指放下（雙指縮放）會取消拖拉並還原
// - 觸控不做游標提示與雙擊新增
const pointers = new Set();
let downAt = null;
let lastPointerType = 'mouse';
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointers.add(e.pointerId);
  lastPointerType = e.pointerType;
  if (pointers.size > 1) { if (drag) cancelDrag(); downAt = null; return; }
  if (e.button !== 0) return;
  const touch = e.pointerType !== 'mouse';
  setPointer(e);
  downAt = { x: e.clientX, y: e.clientY, touch };
  // 1. 名牌控制球（只有選取的名牌才有）
  // 手指落在圖案上時，圖案優先（名牌在手機上很小，上下的控制球會搶走觸控）；縮放角球除外
  const strictArt = hitSignArt(0);
  const h = pickNear(handlesGroup.children.filter((o) => o.userData.handle && (!strictArt || o.userData.handle === 'artsize')), e);
  if (h) { startDrag(h.userData.handle, h); renderer.domElement.setPointerCapture(e.pointerId); downAt = null; return; }
  if (state.explode > 0) return;
  const artPart = strictArt || hitSignArt();
  if (artPart) {
    const z = artPart.origin[2] + artPart.t + 1;
    startDrag('art', { position: new THREE.Vector3(0, 0, z), getWorldPosition: (v) => v.set(0, 0, z) });
    renderer.domElement.setPointerCapture(e.pointerId);
    downAt = null;
    return;
  }
  // 2. 掛點球：滑鼠直接拖；觸控要先點選，選取後才能拖
  const m = pickNear(mountsGroup.children, e);
  if (m) {
    const id = m.userData.mountId;
    if (!touch || id === state.selected) {
      if (id !== state.selected) selectMount(id);
      startDrag('mount', m);
      renderer.domElement.setPointerCapture(e.pointerId);
      downAt = null;
      return;
    }
    downAt.mount = id;
    return;
  }
  // 3. 名牌：放開時才選取
  const hit = raycaster.intersectObjects([...partsGroup.children, ...(cansGroup.visible ? cansGroup.children : [])], true).find((q) => q.object.isMesh);
  const part = hit?.object.userData.part;
  if (isSign(part)) downAt.sign = part;
  else if (hit?.object.userData.can) downAt.can = true;
});

function pointerEnd(e) {
  pointers.delete(e.pointerId);
  if (drag) { if (e.type === 'pointercancel') cancelDrag(); else endDrag(); return; }
  const d = downAt;
  downAt = null;
  if (!d || e.type === 'pointercancel') return;
  const tap = Math.hypot(e.clientX - d.x, e.clientY - d.y) < (d.touch ? 10 : 5);
  if (!tap) return;
  if (d.mount != null) selectMount(d.mount);
  else if (d.sign) selectSign(d.sign);
  else if (d.can) selectGap();
  else if (state.selected != null || state.selectedSign) clearSelection(); // 點空白處取消選取
}
renderer.domElement.addEventListener('pointerup', pointerEnd);
renderer.domElement.addEventListener('pointercancel', pointerEnd);

renderer.domElement.addEventListener('dblclick', (e) => {
  if (lastPointerType !== 'mouse') return; // 觸控連點容易誤觸，改用「新增掛點」按鈕
  setPointer(e);
  const hit = raycaster.intersectObjects(partsGroup.children, true).find((h) => h.object.isMesh);
  const part = hit?.object.userData.part;
  if (!part || state.explode > 0) return;
  // 雙擊名牌：還原滿寬置中；雙擊背板：新增掛點
  if (isSign(part)) { resetSign(signKey(part)); return; }
  if (part.kind === 'back') addMount(snapValue(hit.point.x), snapValue(hit.point.y));
});

let hoverPending = false;
function setHovered(mesh) {
  if (mesh === hovered) return;
  if (hovered) hovered.material = materials[hovered.userData.part.kind];
  hovered = mesh;
  if (hovered) hovered.material = hoverMat;
}
renderer.domElement.addEventListener('pointermove', (e) => {
  if (drag) { setPointer(e); moveDrag(); hideTooltip(); return; }
  if (e.pointerType !== 'mouse' || hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    setPointer(e);
    // 游標形狀提示能拖的東西
    const h = pickNear(handlesGroup.children.filter((o) => o.userData.handle), e);
    const onMount = !h && state.explode === 0 && pickNear(mountsGroup.children, e);
    const cursors = { top: 'ns-resize', artsize: 'nesw-resize', move: 'ew-resize', left: 'ew-resize', right: 'ew-resize' };
    renderer.domElement.style.cursor = h ? cursors[h.userData.handle] : onMount ? 'grab' : hitSignArt() ? 'move' : '';
    const hit = raycaster.intersectObjects(partsGroup.children, true).find((q) => q.object.isMesh);
    const mesh = h || onMount ? null : hit?.object || null;
    if (mesh && isSign(mesh.userData.part)) renderer.domElement.style.cursor = 'pointer';
    setHovered(mesh);
    if (hovered) showTooltip(hovered.userData.part, e); else hideTooltip();
  });
});
renderer.domElement.addEventListener('pointerleave', () => { hideTooltip(); setHovered(null); });

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

// ---------- 鏡頭動態 ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let camTween = null;
let currentView = 'iso';
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
orbit.addEventListener('start', () => { camTween = null; markView(null); }); // 使用者一動手就交給他

function tweenCamera(pos, target, dur = 900) {
  if (reducedMotion || dur === 0) {
    camera.position.copy(pos);
    orbit.target.copy(target);
    orbit.update();
    camTween = null;
    return;
  }
  camTween = { p0: camera.position.clone(), t0: orbit.target.clone(), p1: pos, t1: target, start: performance.now(), dur };
}

function markView(kind) {
  currentView = kind;
  for (const k of ['front', 'iso', 'side']) $('view-' + k).setAttribute('aria-pressed', String(k === kind));
}

/** 讓整座木架放進可見區域；kind 為 null 時保留目前的觀看方向，只調整距離 */
function setView(kind, { intro = false, instant = false } = {}) {
  const L = rack.layout;
  const c = new THREE.Vector3(L.totalW / 2, L.totalH / 2, L.sideDepth / 2);
  // 依畫面直橫比讓整座木架放得進視野（手機直向時水平視角較窄）
  const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const vfov = 2 * Math.atan(tv * fracTarget);
  const hfov = 2 * Math.atan(tv * camera.aspect * fracXTarget); // 扣掉側欄蓋住的寬度
  // 寬、高各自需要的距離取大者（比外接球貼合，手機直向時木架不會縮得太小）
  const m = kind === 'front' ? 1.12 : 1.22;
  const d = Math.max((0.5 * Math.hypot(L.totalW, L.sideDepth) * m) / Math.tan(hfov / 2), (0.5 * L.totalH * m) / Math.tan(vfov / 2)) + L.sideDepth;
  const dir = kind === 'front' ? new THREE.Vector3(0, 0, 1) : kind === 'side' ? new THREE.Vector3(1, 0.15, 0.35)
    : kind === 'iso' ? new THREE.Vector3(0.55, 0.35, 1) : camera.position.clone().sub(orbit.target);
  const pos = c.clone().addScaledVector(dir.normalize(), d);
  if (intro && !reducedMotion) {
    // 開場：從遠處斜上方滑進來
    camera.position.copy(c).addScaledVector(new THREE.Vector3(1.4, 0.9, 1.2).normalize(), d * 2.4);
    orbit.target.copy(c);
  }
  if (kind) markView(kind);
  tweenCamera(pos, c, instant ? 0 : intro ? 1600 : 900);
}

$('view-front').onclick = () => setView('front');
$('view-iso').onclick = () => setView('iso');
$('view-side').onclick = () => setView('side');
$('show-cans').checked = state.showCans;
$('show-dims').checked = state.showDims;
$('show-cans').onchange = (e) => { state.showCans = e.target.checked; applyExplode(); saveState(); };
$('show-dims').onchange = (e) => { state.showDims = e.target.checked; updateOverlay(); saveState(); };
let explodeTarget = 0;
$('explode').onchange = (e) => {
  explodeTarget = e.target.checked ? 1 : 0;
  if (explodeTarget) { state.selected = null; state.selectedSign = null; state.selectedGap = false; disposeGroup(handlesGroup); buildMountSpheres(); updateHint(); renderInspector(); }
  if (reducedMotion) setExplode(explodeTarget);
};
function setExplode(v) {
  state.explode = v;
  applyExplode();
  mountsGroup.visible = overlayGroup.visible = v === 0;
  labelRenderer.domElement.style.display = v === 0 ? '' : 'none';
}
// 側欄分頁
function setTab(tab) {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  document.querySelector('.tabs').style.setProperty('--tab', tabs.findIndex((b) => b.dataset.tab === tab));
  document.querySelector('.sheet-body').scrollTop = 0;
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  try { localStorage.setItem(STORE_KEY + '.tab', tab); } catch { /* 忽略 */ }
}
for (const b of document.querySelectorAll('[data-tab]')) {
  b.onclick = () => {
    if (sheetDrag.suppress) return;
    setTab(b.dataset.tab);
    if (isMobile() && sheet === 'peek') setSheet('half');
  };
}
{
  let tab = 'design';
  try { tab = localStorage.getItem(STORE_KEY + '.tab') || tab; } catch { /* 忽略 */ }
  setTab(document.querySelector(`[data-panel="${tab}"]`) ? tab : 'design');
}

// 桌面：右側面板可收合
function setSidebar(open) {
  $('sidebar').classList.toggle('collapsed', !open);
  document.body.classList.toggle('sidebar-closed', !open);
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('sidebar-toggle').title = $('sidebar-toggle').ariaLabel = open ? '收合側欄' : '展開側欄';
  try { localStorage.setItem(STORE_KEY + '.sidebar', open ? '1' : '0'); } catch { /* 忽略 */ }
  if (rack) { updateFracTarget(); setView(currentView); }
}
$('sidebar-toggle').onclick = () => setSidebar($('sidebar').classList.contains('collapsed'));
// 收合只用在桌面；手機是底部抽屜，不套用（舊版在手機上存過收合狀態，會把工具列撐開）
try { if (localStorage.getItem(STORE_KEY + '.sidebar') === '0' && !matchMedia('(max-width: 640px)').matches) setSidebar(false); } catch { /* 忽略 */ }

// 手機：底部抽屜，三段停靠（peek 只露摘要與分頁／half 半開／full 全開），拖拉把手或點分頁切換
const isMobile = () => matchMedia('(max-width: 640px)').matches;
let sheet = 'half';
const sheetDrag = { suppress: false };
try { sheet = ['peek', 'half', 'full'].includes(localStorage.getItem(STORE_KEY + '.sheet')) ? localStorage.getItem(STORE_KEY + '.sheet') : 'half'; } catch { /* 忽略 */ }

/** 各停靠點的 translateY（px） */
function sheetStops() {
  const el = $('sidebar');
  const H = el.offsetHeight;
  const peekH = $('sheet-head').offsetHeight + (parseFloat(getComputedStyle(el).paddingBottom) || 0);
  return { full: 0, half: Math.max(0, H - innerHeight * 0.52), peek: Math.max(0, H - peekH) };
}
function setSheet(name, { reframe = true } = {}) {
  sheet = name;
  const el = $('sidebar');
  el.dataset.sheet = name;
  el.style.setProperty('--sheet-y', `${sheetStops()[name]}px`);
  try { localStorage.setItem(STORE_KEY + '.sheet', name); } catch { /* 忽略 */ }
  if (!rack || !isMobile()) return;
  // full 時木架被蓋住，維持 half 的取景
  const before = fracTarget;
  updateFracTarget();
  if (reframe && Math.abs(before - fracTarget) > 0.01) setView(currentView);
}
{
  const head = $('sheet-head'), el = $('sidebar');
  let start = null;
  head.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    start = { y: e.clientY, t: performance.now(), base: sheetStops()[sheet], moved: false, id: e.pointerId, last: e.clientY, lastT: performance.now(), v: 0 };
    sheetDrag.suppress = false;
  });
  head.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.abs(dy) < 8) return;
    if (!start.moved) { start.moved = true; head.setPointerCapture(e.pointerId); el.classList.add('dragging'); }
    const now = performance.now();
    start.v = (e.clientY - start.last) / Math.max(1, now - start.lastT);
    start.last = e.clientY; start.lastT = now;
    const stops = sheetStops();
    const y = Math.min(stops.peek + 40, Math.max(-20, start.base + dy));
    el.style.setProperty('--sheet-y', `${y}px`);
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const s0 = start;
    start = null;
    el.classList.remove('dragging');
    if (!s0.moved) {
      // 點把手區（不是分頁按鈕）：收合 ↔ 半開
      if (!e.target.closest('button, a, input, details')) setSheet(sheet === 'peek' ? 'half' : 'peek');
      return;
    }
    sheetDrag.suppress = true; // 剛拖完不要觸發分頁點擊
    setTimeout(() => { sheetDrag.suppress = false; }, 0);
    const stops = sheetStops();
    const y = s0.base + (e.clientY - s0.y) + s0.v * 180; // 依甩動速度往前推
    const best = Object.entries(stops).sort((a, b) => Math.abs(a[1] - y) - Math.abs(b[1] - y))[0][0];
    setSheet(best);
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}
$('mount-add').onclick = () => addMount();
$('mount-auto').onclick = () => { resetMounts(); saveState(); rebuild(); };
$('mount-clear').onclick = () => { state.mounts = []; state.selected = null; saveState(); rebuild(); };
$('reset').onclick = () => {
  state.params = { ...T.DEFAULTS };
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
      if (err?.code !== 'declined') showExportMsg(`存檔失敗（${err?.code || err}）`, true);
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
const stamp = () => `${T.id === 'paint-can' ? 'paint-rack' : T.id}_${rack.info.mx}x${rack.info.my}_t${rack.params.thickness}`;
const paramsJson = () => JSON.stringify({ type: T.id, params: state.params, mounts: state.mounts }, null, 2);
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
    if (TYPES[data.type] && data.type !== T.id) switchType(data.type, { render: false });
    state.params = normalizeParams(data.params || {});
    state.mounts = Array.isArray(data.mounts) ? data.mounts.filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y)).map((m, k) => ({ id: k + 1, x: m.x, y: m.y })) : [];
    state.nextId = state.mounts.length + 1;
    state.selected = null;
    saveState();
    renderParams();
    firstBuild = true;
    rebuild();
  } catch (err) {
    showExportMsg('這個 JSON 讀不了：' + err.message, true);
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
    <p class="hint">在 3D 點一下名牌（或清單裡的色點），就能拖球或用下面的面板調位置和大小。</p>
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
      <label class="card-head"><span>顏料名牌 <small>${T.labelHint}</small></span><input type="checkbox" class="switch" id="lb-enabled" ${lb.enabled ? 'checked' : ''}/></label>
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
    Object.assign(lb, { width: null, height: null, align: 'center', offset: 0 });
    saveState();
    onParamsChanged();
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
      $('np-status').textContent = `這張圖讀不了：${err.message}`;
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
  const what = { laser: '雷射雕刻，每片附一張 PNG', engrave: 'CNC 雕刻，輪廓在 ENGRAVE 圖層', cut: '字直接切穿' }[state.labels.mode];
  el.textContent = state.labels.enabled ? `開了 ${on}/${kindsCount()} 種，共 ${n} 片。${what}` : '';
}

function renderNameplateStatus() {
  renderLabelStatus();
  const cv = $('np-canvas'), status = $('np-status');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (artwork.error || artwork.empty) {
    status.textContent = artwork.error ? `圖案處理失敗：${artwork.error}` : '圖案是空的，調一下黑白門檻，或勾反轉看看。';
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
  const dpi = dpiVal ? `，雷射約 ${dpiVal} DPI${dpiVal < 120 ? '（有點低，換張大一點的圖會比較清楚）' : ''}` : '';
  const size = np?.artRect ? `圖案 ${fmt(np.artRect.w)} × ${fmt(np.artRect.h)} mm${dpi}。` : '';
  const what = { laser: '雷射點陣放在 SVG 裡，另附 PNG，DXF 只有輪廓', engrave: '輪廓在 ENGRAVE 圖層，CAM 用 V 刀或平刀挖', cut: '圖案外框直接切穿' }[state.nameplate.mode];
  status.textContent = `${size}${loops} 條輪廓，${what}。`;
  status.className = 'hint';
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}

// ---------- 儲存 ----------
function saveState() {
  state.byType[state.type] = { params: state.params, mounts: state.mounts, nextId: state.nextId };
  const data = (nameplate) => JSON.stringify({
    type: state.type, byType: state.byType, showCans: state.showCans, showDims: state.showDims, nameplate, labels: state.labels,
  });
  try {
    localStorage.setItem(STORE_KEY, data(state.nameplate));
  } catch {
    // 圖片太大存不下時，至少保留其他設定
    try { localStorage.setItem(STORE_KEY, data({ ...state.nameplate, image: null })); } catch { /* 無法儲存時忽略 */ }
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      // 舊版只有顏料罐架：整份當成顏料罐架的設定
      state.byType = d.byType && typeof d.byType === 'object' ? d.byType : { [DEFAULT_TYPE]: { params: d.params, mounts: d.mounts, nextId: d.nextId } };
      state.type = TYPES[d.type] ? d.type : DEFAULT_TYPE;
      T = TYPES[state.type];
      const cur = state.byType[state.type] || {};
      state.params = normalizeParams(cur.params || {});
      state.mounts = Array.isArray(cur.mounts) ? cur.mounts : [];
      state.nextId = cur.nextId || state.mounts.reduce((a, m) => Math.max(a, m.id + 1), 1);
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

/**
 * 換架子類型：目前的設定先存起來；共用的參數（板厚、公差、機器、螺栓…）帶到新類型，
 * 新類型有存過就接著用，沒有就從預設開始並自動排掛點。
 */
function switchType(id, { render = true } = {}) {
  if (!TYPES[id]) return;
  if (id === state.type && rack) return;
  state.byType[state.type] = { params: state.params, mounts: state.mounts, nextId: state.nextId };
  const shared = Object.fromEntries(SHARED_KEYS.map((k) => [k, state.params[k]]));
  state.type = id;
  T = TYPES[id];
  const saved = state.byType[id];
  state.params = normalizeParams({ ...(saved?.params || T.DEFAULTS), ...shared });
  state.selected = null;
  state.selectedSign = null;
  state.selectedGap = false;
  if (saved?.mounts) {
    state.mounts = saved.mounts;
    state.nextId = saved.nextId || state.mounts.reduce((a, m) => Math.max(a, m.id + 1), 1);
  } else resetMounts();
  saveState();
  $('brand-type').textContent = T.name;
  if (!render) return;
  disposeGroup(handlesGroup);
  renderParams();
  renderNameplate();
  firstBuild = true;
  rebuild();
  if (state.labels.enabled) updateArtwork().then(rebuild);
}

// ---------- 啟動 ----------
// 木架放在沒被面板蓋住的區域正中間：手機抽屜蓋住下方、桌面／橫向手機的側欄蓋住右邊
// （fracNow 平滑追上 fracTarget；Y 是可見高度比例，X 是可見寬度比例）
let fracTarget = 1, fracNow = 1, fracXTarget = 1, fracXNow = 1;
function updateFracTarget() {
  const el = $('sidebar');
  if (isMobile()) {
    const stops = sheetStops();
    const insp = $('inspector');
    // 選取時：調整面板蓋住下方；沒選取：抽屜蓋住下方
    const covered = !insp.hidden ? insp.offsetHeight : el.offsetHeight - stops[sheet === 'full' ? 'half' : sheet];
    fracTarget = Math.max(0.35, Math.min(1, 1 - covered / innerHeight));
    fracXTarget = 1;
    return;
  }
  fracTarget = 1;
  const covered = el.classList.contains('collapsed') ? 0 : innerWidth - el.offsetLeft + 10; // offsetLeft 不受收合動畫的 transform 影響
  fracXTarget = Math.max(0.4, Math.min(1, 1 - covered / innerWidth));
}
function applyViewOffset() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (fracNow < 0.999 || fracXNow < 0.999) camera.setViewOffset(w, h, (w * (1 - fracXNow)) / 2, (h * (1 - fracNow)) / 2, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  if (isMobile()) setSheet(sheet, { reframe: false });
  updateFracTarget();
  applyViewOffset();
  // 手機轉向（直式抽屜 ↔ 橫式側欄）：重新取景
  if (rack && wasMobile !== isMobile()) setView(currentView);
  wasMobile = isMobile();
}
let wasMobile = null;
window.addEventListener('resize', resize);
updateFracTarget();
fracNow = fracTarget;
fracXNow = fracXTarget;
resize();
renderParams();
renderNameplate();
rebuild();
if (state.nameplate.enabled || state.labels.enabled) updateArtwork().then(rebuild);

let lastFrame = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); // 與畫面更新率無關的緩動
  lastFrame = now;
  const follow = (rate) => (reducedMotion ? 1 : 1 - Math.exp(-rate * dt));
  if (camTween) {
    const k = Math.min(1, (performance.now() - camTween.start) / camTween.dur), e = ease(k);
    camera.position.lerpVectors(camTween.p0, camTween.p1, e);
    orbit.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (k >= 1) camTween = null;
  }
  if (Math.abs(fracNow - fracTarget) > 0.001 || Math.abs(fracXNow - fracXTarget) > 0.001) {
    fracNow += (fracTarget - fracNow) * follow(9);
    fracXNow += (fracXTarget - fracXNow) * follow(9);
    if (Math.abs(fracNow - fracTarget) <= 0.001) fracNow = fracTarget;
    if (Math.abs(fracXNow - fracXTarget) <= 0.001) fracXNow = fracXTarget;
    applyViewOffset();
  }
  if (state.explode !== explodeTarget) {
    let v = state.explode + (explodeTarget - state.explode) * follow(7);
    if (Math.abs(v - explodeTarget) < 0.003) v = explodeTarget;
    setExplode(v);
  }
  // 選取中的控制球輕微呼吸，提示可以拖
  const pulse = 1 + Math.sin(now / 320) * 0.08;
  for (const o of handlesGroup.children) if (o.userData.handle) o.scale.setScalar((o.userData.r ??= o.scale.x) * pulse);
  orbit.update();
  const dist = camera.position.distanceTo(orbit.target);
  scene.fog.near = dist + fogSpan * 0.4;
  scene.fog.far = dist + fogSpan * 2.5;
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// ---------- 首頁與架子類型 ----------
// 網址 #/類型 直接進該類型的編輯器；沒有指定就顯示首頁（後面的 3D 先用上次的類型建好）
$('type-grid').innerHTML = TYPE_LIST.map((t, k) => `
  <a class="type-card" href="#/${t.id}" style="animation-delay:${0.08 * k + 0.1}s">
    <div class="type-art">${t.icon}</div>
    <div class="type-name">${t.name}</div>
    <p>${t.summary}</p>
    <span class="type-go">開始設計 →</span>
  </a>`).join('') + `
  <div class="type-card soon" style="animation-delay:${0.08 * TYPE_LIST.length + 0.1}s">
    <div class="type-art"><svg viewBox="0 0 120 90"><path d="M60 30v30M45 45h30"/></svg></div>
    <div class="type-name">更多架子</div>
    <p>筆刷架、噴罐架之類的，之後會用同一套接合加進來。</p>
  </div>`;
function route() {
  const id = location.hash.replace(/^#\/?/, '');
  const home = !TYPES[id];
  $('home').hidden = !home;
  document.body.classList.toggle('at-home', home);
  if (!home) switchType(id);
  $('brand-type').textContent = T.name;
}
window.addEventListener('hashchange', route);
route();

window.__rack = () => rack; // 除錯用
window.__state = () => state;
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
