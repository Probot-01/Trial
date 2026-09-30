import { USE_MOCK_DATA, LOCAL_API_BASE } from '../config';
import * as mockData from './mockData';

// Delay helper to simulate network latency (mock mode only)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// How long a real call to the local backend may take before it is reported as
// failed. The quality gate itself can take a few seconds (it runs a real image
// analysis), so this is generous.
const REAL_CALL_TIMEOUT_MS = 8000;
// POST /captures runs the MATLAB quality gate synchronously; a cold MATLAB
// start is far slower than any other call here.
const CAPTURE_TIMEOUT_MS = 60000;

/**
 * ApiError — what every live-mode failure rejects with. `code` is the
 * contract's snake_case `error` field (api-contracts.md, "Error shape") or a
 * client-side code (network_error, timeout, config_missing, bad_response).
 */
export class ApiError extends Error {
  constructor(code, message, status = null, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    // The rest of the error body the backend sent (e.g. captureId on a 503
    // quality_gate_failed, which is what a re-check of the saved image needs).
    this.details = details;
  }
}

/**
 * The technician's session token from POST /auth/login (App.jsx keeps the
 * login payload in localStorage 'netra_phc_auth'). Sent as a Bearer header on
 * every real call; required once the local backend runs with
 * LOCAL_AUTH_ENABLED=true.
 */
function authHeader() {
  try {
    const token = JSON.parse(localStorage.getItem('netra_phc_auth') || 'null')?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * DATA MODE (config.js): mock mode serves fixtures from mockData.js and nothing
 * else; live mode serves the PHC local backend and nothing else. A live request
 * that fails REJECTS — no fixture patients, no invented quality result, no
 * silent "best effort" (design doc §1.22). Callers render the rejection.
 */
class LocalApiClient {
  constructor() {
    this.useMock = USE_MOCK_DATA;
    this.baseUrl = LOCAL_API_BASE;
  }

  /** fetch + timeout + auth + contract error shape -> parsed JSON, or ApiError. */
  async _request(path, options = {}, timeoutMs = REAL_CALL_TIMEOUT_MS) {
    if (!this.baseUrl) {
      throw new ApiError('config_missing',
        'VITE_LOCAL_API_BASE is not set, so this app does not know where the PHC backend is. ' +
        'Set it in phc-local-app/frontend/.env and restart the dev server.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { ...authHeader(), ...(options.headers || {}) },
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError('timeout', `The PHC backend did not answer within ${Math.round(timeoutMs / 1000)} s (${path}).`);
      }
      throw new ApiError('network_error', `Cannot reach the PHC backend at ${this.baseUrl}. Is it running?`);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => null);
    if (res.status === 401 && path !== '/auth/login') {
      // The stored technician session is no longer valid (expired, or the backend's accounts were
      // reset). Keeping it would leave every screen failing with a misleading "unreachable":
      // drop it and go back to the login screen.
      try { localStorage.removeItem('netra_phc_auth'); } catch { /* storage unavailable */ }
      if (typeof window !== 'undefined' && window.location.pathname !== '/') window.location.assign('/');
    }
    if (!res.ok) {
      throw new ApiError(body?.error || `http_${res.status}`,
        body?.message || `${res.status} ${res.statusText} from ${path}`, res.status, body);
    }
    return body;
  }

  /** POST /auth/login -> { token, expiresAt, user }. Throws with the backend's message. */
  async login(username, password) {
    return this._request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  /**
   * GET /auth/me -> { user }. Used at app startup to confirm a token saved in
   * localStorage from a previous visit is still live before trusting it, so a
   * stale/expired session doesn't render the authenticated layout for a beat
   * and then bounce (App.jsx). Throws (401) exactly like any other call when
   * the session is gone; _request's own 401 handling already clears it.
   */
  async getMe() {
    return this._request('/auth/me');
  }

  async getPatients() {
    if (this.useMock) {
      await delay(500);
      return [...mockData.mockPatients];
    }
    const data = await this._request('/patients');
    if (!Array.isArray(data)) throw new ApiError('bad_response', 'The patient list response was not a list.');
    return data;
  }

  /**
   * searchPatients({ name, age, phone }) -> GET /patients/search
   *
   * The duplicate check (design doc SS10.3, backend plan SSB.1). The endpoint
   * has existed on both this backend and the central one since B.1 and NO UI
   * called it, so the same person registered twice became two patient records
   * with two separate screening histories and nothing pointing between them.
   *
   * Returns candidates already ranked by the server, each with `matchedOn`
   * saying WHICH field matched -- name, phone or age. That distinction is the
   * point: two people can share a name, but a matching phone number is much
   * stronger evidence of the same person, and the worker deciding needs to
   * see which it was rather than a bare similarity score.
   *
   * Needs a name or a phone; the server rejects a search on age alone, which
   * would return most of the register. Returns [] rather than throwing when
   * there is nothing to search on, so a caller can call it on every keystroke
   * without guarding.
   */
  async searchPatients({ name, age, phone } = {}) {
    const hasName = typeof name === 'string' && name.trim().length >= 3;
    const hasPhone = typeof phone === 'string' && phone.replace(/\D/g, '').length >= 4;
    if (!hasName && !hasPhone) return [];

    if (this.useMock) {
      await delay(200);
      const n = (name || '').trim().toLowerCase();
      return mockData.mockPatients
        .filter((p) => n && String(p.name || '').toLowerCase().includes(n))
        .map((p) => ({ ...p, matchedOn: ['name'], score: 2 }));
    }

    const q = new URLSearchParams();
    if (hasName) q.set('name', name.trim());
    if (hasPhone) q.set('phone', phone);
    if (age !== undefined && age !== null && age !== '') q.set('age', String(age));

    const data = await this._request(`/patients/search?${q.toString()}`);
    if (!Array.isArray(data)) {
      throw new ApiError('bad_response', 'The patient search response was not a list.');
    }
    return data;
  }

  /** registerPatient(patientData) -> POST /patients. Live: rejects on any failure. */
  async registerPatient(patientData) {
    if (this.useMock) {
      await delay(400);
      const newPatient = {
        patientId: `PHC001-${Math.random().toString(36).substring(2, 8).toUpperCase()}-NEW1`,
        registeredAt: new Date().toISOString(),
        ...patientData
      };
      mockData.mockPatients.unshift(newPatient);
      try {
        localStorage.setItem('netra_latest_patient', JSON.stringify(newPatient));
        const existing = JSON.parse(localStorage.getItem('netra_registered_patients') || '[]');
        localStorage.setItem('netra_registered_patients', JSON.stringify([newPatient, ...existing]));
      } catch (e) {}
      return newPatient;
    }
    const data = await this._request('/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patientData)
    });
    if (!data || typeof data.patientId !== 'string') {
      throw new ApiError('bad_response', 'The registration response had no patientId; the patient may not have been saved.');
    }
    return data;
  }

  /**
   * submitCapture(patientId, imageFile, cameraDeviceId) -> POST /captures, which
   * saves the image and runs the local quality gate. Mock mode returns null
   * (CaptureScreen then uses its scenario fixtures). Live mode rejects on
   * failure — including 503 quality_gate_failed, where the image WAS saved.
   */
  async submitCapture(patientId, imageFile, cameraDeviceId = 'unknown') {
    if (this.useMock) return null;
    const formData = new FormData();
    formData.append('patientId', patientId);
    formData.append('cameraDeviceId', cameraDeviceId);
    formData.append('image', imageFile);
    const data = await this._request('/captures', { method: 'POST', body: formData }, CAPTURE_TIMEOUT_MS);
    if (!data || typeof data.captureId !== 'string' || typeof data.qualityStatus !== 'string') {
      throw new ApiError('bad_response', 'The capture response did not have the expected shape.');
    }
    return data;
  }

  /** POST /captures/:captureId/questionnaire. Live: rejects on failure. */
  async submitQuestionnaire(captureId, payload) {
    if (this.useMock) return null;
    return this._request(`/captures/${encodeURIComponent(captureId)}/questionnaire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** POST /captures/:captureId/capture-metadata. Live: rejects on failure. */
  async submitCaptureMetadata(captureId, payload) {
    if (this.useMock) return null;
    return this._request(`/captures/${encodeURIComponent(captureId)}/capture-metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * saveCaptureMetadata(captureId, metadata) — MOCK MODE ONLY. Adds the capture
   * to the client-side demo queue (mockData.mockQueueItems) that the Local
   * Queue Table and result modal are built around. There is no backend
   * equivalent: in live mode the queue comes from GET /captures and this does
   * nothing.
   */
  /**
   * recheckQuality(captureId) -> POST /captures/:captureId/quality-check.
   * Re-runs the gate on an image that was SAVED but not checked (after a 503
   * quality_gate_failed), without asking for the photograph again. Same body as
   * POST /captures. Live only: mock mode has no gate to re-run.
   */
  async recheckQuality(captureId) {
    if (this.useMock) return null;
    const data = await this._request(`/captures/${encodeURIComponent(captureId)}/quality-check`, { method: 'POST' }, CAPTURE_TIMEOUT_MS);
    if (!data || typeof data.captureId !== 'string' || typeof data.qualityStatus !== 'string') {
      throw new ApiError('bad_response', 'The quality-check response did not have the expected shape.');
    }
    return data;
  }

  /**
   * markBestEffort(captureId) -> POST /captures/:captureId/best-effort.
   * Design doc §10.2: after repeated failed retakes, queue the capture anyway
   * with an explicit "technician override, ungradable" flag, rather than an
   * infinite retry loop or the case silently never being recorded. Only valid
   * on a capture the gate marked 'retake'; live only.
   */
  async markBestEffort(captureId) {
    if (this.useMock) return null;
    const data = await this._request(`/captures/${encodeURIComponent(captureId)}/best-effort`, { method: 'POST' }, CAPTURE_TIMEOUT_MS);
    if (!data || typeof data.captureId !== 'string' || data.bestEffort !== true) {
      throw new ApiError('bad_response', 'The best-effort response did not have the expected shape.');
    }
    return data;
  }

  async saveCaptureMetadata(captureId, metadata) {
    if (!this.useMock) return null;
    await delay(400);
    let resolvedName = metadata.patientName;
    let resolvedAge = metadata.patientAge;

    if (!resolvedName) {
      try {
        const latest = JSON.parse(localStorage.getItem('netra_latest_patient'));
        if (latest?.name) {
          resolvedName = latest.name;
          resolvedAge = latest.age;
        }
      } catch (e) {}
    }

    const newQueueItem = {
      captureId,
      patientId: metadata.patientId || `PHC001-${Math.random().toString(36).substring(2, 8).toUpperCase()}-NEW1`,
      patientName: resolvedName || 'Krrish',
      patientAge: resolvedAge || 20,
      status: 'result_delivered',
      capturedAt: new Date().toISOString(),
      imagePreviewUrl: metadata.imagePreviewUrl,
      imageUrl: metadata.imagePreviewUrl,
      prediction: metadata.aiPrediction,
    };

    mockData.mockQueueItems.unshift(newQueueItem);
    try {
      const stored = JSON.parse(localStorage.getItem('netra_phc_queue') || '[]');
      localStorage.setItem('netra_phc_queue', JSON.stringify([newQueueItem, ...stored]));
      localStorage.setItem('netra_last_capture', JSON.stringify(newQueueItem));
    } catch (e) {}
    return { success: true, captureId, ...metadata };
  }

  /**
   * getQueue() — the contract's queue is GET /captures. Real rows report their
   * lifecycle status only (captured / quality_passed / synced …); the local
   * backend never holds a grade, so a real row's "view result" stays disabled
   * rather than showing a fabricated one.
   */
  async getQueue() {
    if (this.useMock) {
      await delay(200);
      try {
        const stored = JSON.parse(localStorage.getItem('netra_phc_queue') || '[]');
        if (stored && stored.length > 0) {
          const existingIds = new Set(mockData.mockQueueItems.map(q => q.captureId));
          const additions = stored.filter(q => !existingIds.has(q.captureId));
          return [...additions, ...mockData.mockQueueItems];
        }
      } catch (e) {}
      return [...mockData.mockQueueItems];
    }
    const data = await this._request('/captures');
    if (!Array.isArray(data)) throw new ApiError('bad_response', 'The capture list response was not a list.');
    return data;
  }

  async getSyncStatus() {
    if (this.useMock) {
      // Don't delay sync status checks as they might be polled
      return { ...mockData.mockSyncStatus };
    }
    const data = await this._request('/sync/status', {}, 3000);
    if (!data || typeof data.online !== 'boolean') {
      throw new ApiError('bad_response', 'The sync-status response did not have the expected shape.');
    }
    return data;
  }

  /**
   * getPeerDevices() -> GET /peer/devices
   *
   * The phones paired with this PC (docs/peer-sync-protocol.md). A pairing key
   * reads every patient record on this machine, so the list of who holds one
   * is operational safety information, not a diagnostic curiosity.
   *
   * Returns [{ deviceId, name, createdAt, lastSeenAt, revokedAt }]. A revoked
   * device stays in the list with revokedAt set -- the record of a phone that
   * once had access does not get deleted.
   */
  async getPeerDevices() {
    if (this.useMock) {
      await delay(200);
      return mockData.mockPeerDevices.map((d) => ({ ...d }));
    }
    const data = await this._request('/peer/devices');
    if (!Array.isArray(data)) {
      throw new ApiError('bad_response', 'The paired-devices response was not a list.');
    }
    return data;
  }

  /**
   * revokePeerDevice(deviceId) -> POST /peer/devices/:id/revoke
   *
   * Cuts a phone off from this PC. Admin-only on the backend
   * (requireTechnician.admin), which is the authority -- the UI hiding the
   * button is a convenience, not the control.
   *
   * Resolves on the backend's 204. Mock mode REFUSES rather than pretending:
   * revoking is a security action, and a demo that reports success without a
   * backend would teach an operator that a phone is cut off when it is not.
   */
  async revokePeerDevice(deviceId) {
    if (this.useMock) {
      throw new ApiError('mock_mode',
        'This is demo data. A paired phone can only really be revoked against the '
        + 'live PHC backend, so this action is refused here rather than reported '
        + 'as done.');
    }
    if (!deviceId) throw new ApiError('invalid_field', 'A device id is required to revoke.');
    await this._request(`/peer/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
    return true;
  }
}

export const localApi = new LocalApiClient();
