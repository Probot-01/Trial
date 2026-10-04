
export interface QualityEngine {
  engine: 'matlab' | 'python' | 'js-fallback' | 'js-device';
  fallback: boolean;
  detail: string | null;
}

export const QUALITY_GATE_ENGINE: QualityEngine = {
  engine: 'js-device',
  fallback: false,
  detail: 'qualityGate.ts, the TypeScript port of qualityGateMain.m, run on the phone',
};
