import { USE_MOCK_DATA, LOCAL_API_BASE } from '../config';
import * as mockData from './mockData';

// Delay helper to simulate network latency (mock mode only)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


const REAL_CALL_TIMEOUT_MS = 8000;

const CAPTURE_TIMEOUT_MS = 60000;


export class ApiError extends Error {
  constructor(code, message, status = null, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;

    this.details = details;
  }
}


function authHeader() {
  try {
    const token = JSON.parse(localStorage.getItem('netra_phc_auth') || 'null')?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}


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
      } catch (e) { }
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


  async recheckQuality(captureId) {
    if (this.useMock) return null;
    const data = await this._request(`/captures/${encodeURIComponent(captureId)}/quality-check`, { method: 'POST' }, CAPTURE_TIMEOUT_MS);
    if (!data || typeof data.captureId !== 'string' || typeof data.qualityStatus !== 'string') {
      throw new ApiError('bad_response', 'The quality-check response did not have the expected shape.');
    }
    return data;
  }

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
      } catch (e) { }
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
    } catch (e) { }
    return { success: true, captureId, ...metadata };
  }


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
      } catch (e) { }
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
