

const env = import.meta.env ?? {};


const rawMode = (env.VITE_DATA_MODE ?? '').trim().toLowerCase();
if (rawMode && rawMode !== 'live' && rawMode !== 'mock') {
  console.error(`[config] VITE_DATA_MODE="${env.VITE_DATA_MODE}" is not 'live' or 'mock'; using live.`);
}
export const DATA_MODE = rawMode === 'mock' ? 'mock' : 'live';
export const USE_MOCK_DATA = DATA_MODE === 'mock';


export const CENTRAL_API_BASE = (env.VITE_CENTRAL_API_BASE ?? '').trim().replace(/\/+$/, '');
