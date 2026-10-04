
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { POLICY } from '../config';
import {
  getCaseBundle, listAwaitingGrade, markAttemptFailed, markFailed, markSummarySent, markSynced,
  nextDueForUpload, pendingUploadCount, setCentralStatus,
} from '../db/captures';
import { CaseFields, CentralError, checkHealth, getCaseStatus, postCase, postCaseChunked, postSummary } from '../api/central';
import { imageExists } from '../lib/storage';
import { nowIso, kvGet, kvSet } from '../db/database';
import { getPairing } from '../peer/pairing';
import { replicateWithPc } from '../peer/replicate';
import { PeerError } from '../peer/peerClient';

export type Connectivity = 'unknown' | 'offline' | 'no_server' | 'online';

export interface SyncSnapshot {
  connectivity: Connectivity;
  syncing: boolean;
  pendingCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /** What the manager is doing right now, for the header status line. */
  activity: string | null;
  /** Link to the paired PHC PC (docs/peer-sync-protocol.md). */
  pcLink: 'unpaired' | 'linked' | 'unreachable' | 'error';
  pcLastSyncAt: string | null;
  pcError: string | null;
}

type Listener = (s: SyncSnapshot) => void;

const MAX_ITEMS_PER_PASS = 8;

class SyncManager {
  private snapshot: SyncSnapshot = {
    connectivity: 'unknown', syncing: false, pendingCount: 0, lastSyncAt: null, lastError: null, activity: null,
    pcLink: 'unpaired', pcLastSyncAt: null, pcError: null,
  };
  private listeners = new Set<Listener>();
  private queueListeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private started = false;
  private subscriptions: (() => void)[] = [];

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.snapshot);
    return () => this.listeners.delete(l);
  }

  /** Fires whenever a queue row changed state -- screens reload on it. */
  onQueueChanged(l: () => void): () => void {
    this.queueListeners.add(l);
    return () => this.queueListeners.delete(l);
  }

  get current(): SyncSnapshot {
    return this.snapshot;
  }

  private set(patch: Partial<SyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l(this.snapshot));
  }

  private queueChanged() {
    this.queueListeners.forEach((l) => l());
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.set({ lastSyncAt: await kvGet('lastSyncAt') });
    await this.refreshPending();
    this.timer = setInterval(() => this.trigger(), POLICY.syncIntervalMs);
    const app = AppState.addEventListener('change', (s) => { if (s === 'active') this.trigger(); });
    this.subscriptions.push(() => app.remove());
    try {
      const net = Network.addNetworkStateListener((e) => { if (e.isConnected) this.trigger(); else this.set({ connectivity: 'offline' }); });
      this.subscriptions.push(() => net.remove());
    } catch { /* listener unsupported: the interval still runs */ }
    this.trigger();
  }

  /** On logout. Queued cases stay queued; they sync after the next login. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subscriptions.splice(0).forEach((remove) => remove());
    this.started = false;
  }

  async refreshPending() {
    this.set({ pendingCount: await pendingUploadCount() });
  }


  trigger(): Promise<void> {
    if (this.inFlight) { this.rerun = true; return this.inFlight; }
    this.inFlight = (async () => {
      do {
        this.rerun = false;
        try {
          await this.pass();
        } catch (err) {
          this.set({ lastError: String((err as Error)?.message ?? err) });
        } finally {
          this.set({ syncing: false, activity: null });
        }
      } while (this.rerun);
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async pass() {
    const net = await Network.getNetworkStateAsync().catch(() => null);
    if (net && net.isConnected === false) {
      this.set({ connectivity: 'offline', pcLink: (await getPairing()) ? 'unreachable' : 'unpaired' });
      await this.refreshPending();
      return;
    }

    await this.pcPass();
    this.set({ activity: 'CONTACTING CENTRAL SERVER...' });
    const up = await checkHealth();
    this.set({ connectivity: up ? 'online' : 'no_server' });
    if (!up) { await this.refreshPending(); return; }

    this.set({ syncing: true });
    for (let i = 0; i < MAX_ITEMS_PER_PASS; i++) {
      const captureId = await nextDueForUpload();
      if (!captureId) break;
      const keepGoing = await this.uploadOne(captureId);
      this.queueChanged();
      await this.refreshPending();
      if (!keepGoing) break;
    }
    await this.pollGrades();
    const t = nowIso();
    await kvSet('lastSyncAt', t);
    this.set({ lastSyncAt: t });
    await this.refreshPending();
  }

  /** Replicate with the paired PHC PC, if any. Never throws: the PC being off is normal. */
  private async pcPass() {
    if (!(await getPairing())) { this.set({ pcLink: 'unpaired' }); return; }
    this.set({ activity: 'SYNCING WITH PHC PC...' });
    try {
      const r = await replicateWithPc();
      this.set({ pcLink: 'linked', pcLastSyncAt: nowIso(), pcError: null });
      if (r.pulled || r.pushed) this.queueChanged();
    } catch (err) {
      const e = err as PeerError;
      this.set({ pcLink: e?.code === 'pc_unreachable' ? 'unreachable' : 'error', pcError: e?.code === 'pc_unreachable' ? null : String(e?.message ?? err) });
    }
  }

  /** Returns false when the link itself failed (stop this pass). */
  private async uploadOne(captureId: string): Promise<boolean> {
    const b = await getCaseBundle(captureId);
    if (!b) return true;
    if (!imageExists(b.capture.imagePath)) {
      await markFailed(captureId, 'image_missing', 'The stored image file is missing on this device.');
      return true;
    }
    const pendingCount = await pendingUploadCount();
    const fields: CaseFields = {
      patientId: b.patient.patientId,
      captureIdRef: captureId,
      cameraDeviceId: b.capture.cameraDeviceId,
      capturedAt: b.capture.capturedAt,
      consentGivenAt: b.patient.consentGivenAt,
      patientName: b.patient.name,
      patientAge: b.patient.age,
      patientContactNumber: b.patient.contactNumber,
      questionnaireData: b.questionnaire,
      captureMetadata: b.metadata,
      qualityScores: b.capture.qualityScores
        ? {
          ...b.capture.qualityScores.scores, status: b.capture.qualityScores.status, reason: b.capture.qualityScores.reason,
          compositeScore: b.capture.qualityScores.compositeScore, preset: b.capture.qualityScores.preset,
          analysedAt: b.capture.qualityScores.analysedAt, bestEffort: b.capture.bestEffort, source: 'mobile_js_port'
        }
        : null,
      qualityGateEngine: b.capture.qualityEngine,
      pendingCount,
    };

    try {
      if (b.sync.state === 'pending') {
        this.set({ activity: `SENDING CASE SUMMARY ${captureId}` });
        const s = await postSummary(fields);
        await markSummarySent(captureId, s.caseId, s.status ?? 'awaiting_image');
        this.queueChanged();
      }
      const big = (b.capture.imageBytes ?? 0) > POLICY.chunkThresholdBytes;
      this.set({ activity: `UPLOADING IMAGE ${captureId}` });
      const r = big
        ? await postCaseChunked(fields, b.capture.imagePath, (done, total) =>
          this.set({ activity: `UPLOADING IMAGE ${captureId} · ${done}/${total}` }))
        : await postCase(fields, b.capture.imagePath);
      await markSynced(captureId, r.caseId, r.status ?? 'processing');
      this.set({ lastError: null });
      return true;
    } catch (err) {
      const e = err instanceof CentralError ? err : new CentralError('network', 'unknown', String((err as Error)?.message ?? err));
      if (e.kind === 'config') {
        this.set({ lastError: e.message });
        return false;
      }
      if (e.retryable) {
        await markAttemptFailed(captureId, e.code, e.message);
        if (e.kind !== 'http') {
          this.set({ connectivity: 'no_server', lastError: e.message });
          return false;
        }
        return true;
      }
      await markFailed(captureId, e.code, e.message);
      this.set({ lastError: `${captureId}: ${e.message}` });
      return true;
    }
  }

  private async pollGrades() {
    const waiting = await listAwaitingGrade();
    for (const w of waiting) {
      try {
        const s = await getCaseStatus(w.caseId);
        await setCentralStatus(w.captureId, s.status);
        if (s.status === 'graded' || s.status === 'error') this.queueChanged();
      } catch (err) {
        if (err instanceof CentralError && err.kind !== 'http') return;
      }
    }
  }
}

export const syncManager = new SyncManager();
