

export interface AppConfig {
  /** Central backend base URL, e.g. http://192.168.1.20:5000 */
  centralUrl: string;
  /** This site's key, sent as X-PHC-Api-Key (api-contracts.md, PHC device auth). */
  phcApiKey: string;
  /** Site code used in every locally generated ID (docs/id-format-spec.md). */
  phcCode: string;
  /** Display name shown in the header. */
  phcName: string;
}

/** kv key the device's overrides are stored under. */
export const CONFIG_KV_KEY = 'config';


export const DEFAULT_CONFIG: AppConfig = {
  centralUrl: (process.env.EXPO_PUBLIC_CENTRAL_API_URL ?? '').replace(/\/+$/, ''),
  phcApiKey: process.env.EXPO_PUBLIC_PHC_API_KEY ?? '',
  phcCode: process.env.EXPO_PUBLIC_PHC_CODE ?? 'PHC001',
  phcName: process.env.EXPO_PUBLIC_PHC_NAME ?? 'PHC',
};

let current: AppConfig = { ...DEFAULT_CONFIG };
const listeners = new Set<(c: AppConfig) => void>();

export function getConfig(): AppConfig {
  return current;
}

export function setConfig(next: Partial<AppConfig>): AppConfig {
  current = { ...current, ...next, centralUrl: (next.centralUrl ?? current.centralUrl).replace(/\/+$/, '') };
  listeners.forEach((l) => l(current));
  return current;
}

export function subscribeConfig(listener: (c: AppConfig) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}


export const DEMO_TOOLS = process.env.EXPO_PUBLIC_DEMO_TOOLS === '1';

/** Tunables that are policy, not deployment. */
export const POLICY = {
  /** Requests to central give up after this long (upload of a large image may take a while). */
  requestTimeoutMs: 30_000,
  uploadTimeoutMs: 120_000,
  /** Above this, images go through the chunked/resumable upload (api-contracts.md, Task 8.2). */
  chunkThresholdBytes: 2 * 1024 * 1024,
  chunkSizeBytes: 1024 * 1024,
  /** Background sync loop period while the app is open. */
  syncIntervalMs: 15_000,
  /** Failed retakes before "best effort -- proceed as ungradable" is offered (design doc §10.2). */
  maxRetakesBeforeBestEffort: 3,
  /** Storage-pressure warning thresholds (design doc §10.1). */
  lowDiskBytes: 500 * 1024 * 1024,
  queueWarnCount: 150,
};
