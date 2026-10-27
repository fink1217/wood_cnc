// 架子類型清單。新增一種架子：寫一個類型檔（參數、尺寸推算、模組裡面的零件），在這裡登記就好；
// 外框、接合、頂蓋、掛點、匯出與材料表都共用。

import { assemble } from '../system/frame.js';
import { paintCan } from './paint-can.js';
import { slantBottle } from './slant-bottle.js';

export const TYPE_LIST = [paintCan, slantBottle];
export const TYPES = Object.fromEntries(TYPE_LIST.map((t) => [t.id, t]));
for (const t of TYPE_LIST) t.build = (input, mounts, options) => assemble(t, input, mounts, options);
export const DEFAULT_TYPE = paintCan.id;
