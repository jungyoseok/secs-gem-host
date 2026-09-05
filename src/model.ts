import fs from 'node:fs';

export type ModelSv = { id: number; name: string; type: string; units: string; value: any };
export type ModelReport = { rptid: number; vids: number[] };
export type ModelEvent = { ceid: number; name: string; rptids: number[] };
export type ModelAlarm = { alid: number; text: string };

export type Model = {
  mdln: string;
  softrev: string;
  svs: ModelSv[];
  reports: ModelReport[];
  events: ModelEvent[];
  alarms: ModelAlarm[];
};

/** models/default.json sits next to dist/, so resolve it relative to this module. */
export const DEFAULT_MODEL_PATH = new URL('../models/default.json', import.meta.url);

export function loadModel(file?: string): Model {
  const src = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(DEFAULT_MODEL_PATH, 'utf8');
  const m = JSON.parse(src) as Model;
  if (!m.mdln || !Array.isArray(m.svs)) throw new Error('model needs "mdln" and an "svs" array');
  return m;
}

/** Build a SECS item for one SV's current value, using the model's declared type. */
export function svItem(sv: ModelSv) {
  return sv.type === 'A'
    ? { type: 'A', value: String(sv.value) }
    : { type: sv.type, value: [Number(sv.value)] };
}
