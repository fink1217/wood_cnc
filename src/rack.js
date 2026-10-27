// 相容入口：舊程式與測試從這裡匯入顏料罐架的 API。
// 實際內容在 types/paint-can.js（顏料罐架）與 system/（各類型共用的拼裝規格、骨架、名牌）。

export * from './types/paint-can.js';
export { validateMount, autoMounts } from './system/frame.js';
export { signSpan, NAMEPLATE_MODES, NAMEPLATE_SHAPES } from './system/signs.js';
