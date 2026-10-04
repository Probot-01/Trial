// ── Mock Data — shapes match api-contracts.md exactly ──

export const mockPatients = [
  { patientId: 'PHC001-kr7x9a-k20', name: 'Krrish', age: 20, contactNumber: '+919823044821', registeredAt: '2026-09-10T09:00:00.000Z' },
  { patientId: 'PHC001-lz3k9f-a2x9', name: 'Sunita Devi', age: 54, contactNumber: '+919812345678', registeredAt: '2026-09-06T09:00:00.000Z' },
  { patientId: 'PHC001-lz3k9g-b4y2', name: 'Ramesh Kumar', age: 62, contactNumber: '+919876543210', registeredAt: '2026-09-06T09:10:00.000Z' },
  { patientId: 'PHC001-lz3k9h-c6z5', name: 'Priya Sharma', age: 45, contactNumber: '+919912345678', registeredAt: '2026-09-06T09:20:00.000Z' },
  { patientId: 'PHC001-lz3k9i-d8w3', name: 'Anil Verma', age: 58, contactNumber: '+919823456789', registeredAt: '2026-09-06T09:35:00.000Z' },
  { patientId: 'PHC001-lz3k9j-e1v7', name: 'Kavita Joshi', age: 49, contactNumber: '+919834567890', registeredAt: '2026-09-06T09:50:00.000Z' },
];

export const mockAiPredictions = {
  pass: {
    status: "success",
    processedAt: new Date().toISOString(),
    model: {
      version: "netrasetu-efficientnetb0-v1",
      name: "tf_efficientnet_b0.ns_jft_in1k",
      imageSize: 384
    },
    input: {
      filename: "fundus_capture_01.png",
      contentType: "image/png",
      originalHeight: 1200,
      originalWidth: 1600
    },
    imageQuality: {
      status: "good",
      qualityScore: 0.91,
      issues: [],
      metrics: {
        focusScore: 0.94,
        illuminationScore: 0.88,
        contrastScore: 0.86,
        retinalCoverageScore: 0.98,
        glarePenalty: 0.01
      }
    },
    severity: {
      level: 1,
      label: "Mild NPDR",
      code: "mild_npdr"
    },
    confidence: {
      score: 0.924
    },
    enhancement: {
      applied: true,
      steps: [
        "retinal_roi_crop",
        "illumination_normalization",
        "clahe",
        "mild_denoising"
      ]
    }
  },
  borderline: {
    status: "success",
    processedAt: new Date().toISOString(),
    model: {
      version: "netrasetu-efficientnetb0-v1",
      name: "tf_efficientnet_b0.ns_jft_in1k",
      imageSize: 384
    },
    input: {
      filename: "fundus_capture_02.png",
      contentType: "image/png",
      originalHeight: 1000,
      originalWidth: 1504
    },
    imageQuality: {
      status: "borderline",
      qualityScore: 0.58,
      issues: ["blur", "low_illumination"],
      metrics: {
        focusScore: 0.42,
        illuminationScore: 0.54,
        contrastScore: 0.65,
        retinalCoverageScore: 0.90,
        glarePenalty: 0.05
      }
    },
    severity: {
      level: 2,
      label: "Moderate NPDR",
      code: "moderate_npdr"
    },
    confidence: {
      score: 0.781
    },
    enhancement: {
      applied: true,
      steps: [
        "retinal_roi_crop",
        "illumination_normalization",
        "clahe"
      ]
    }
  },
  retake: {
    status: "success",
    processedAt: new Date().toISOString(),
    model: {
      version: "netrasetu-efficientnetb0-v1",
      name: "tf_efficientnet_b0.ns_jft_in1k",
      imageSize: 384
    },
    input: {
      filename: "fundus_capture_03.png",
      contentType: "image/png",
      originalHeight: 1000,
      originalWidth: 1504
    },
    imageQuality: {
      status: "poor",
      qualityScore: 0.28,
      issues: ["blur", "motion_artifact"],
      metrics: {
        focusScore: 0.18,
        illuminationScore: 0.32,
        contrastScore: 0.35,
        retinalCoverageScore: 0.62,
        glarePenalty: 0.22
      }
    },
    severity: null,
    confidence: null,
    enhancement: {
      applied: false,
      steps: []
    }
  }
};


export const qualityReasonMessages = {
  blur: 'Image is blurry — please stabilize the camera and retake',
  low_illumination: 'Image is too dark — adjust lighting and retake',
  insufficient_fov: 'Insufficient field of view — ensure full retinal coverage',
  glare: 'Glare detected in image — reduce direct light source',
  motion_artifact: 'Motion artifact detected — ask patient to hold still',
  eyelash_occlusion: 'Eyelash/eyelid obstruction — gently retract and retake',
};

export const mockQueueItems = [
  { captureId: 'PHC001-kr9a2b-c101', patientId: 'PHC001-kr7x9a-k20', patientName: 'Krrish', patientAge: 20, status: 'result_delivered', capturedAt: '2026-09-10T09:05:00.000Z' },
  { captureId: 'PHC001-lz4a2b-c7f1', patientId: 'PHC001-lz3k9f-a2x9', patientName: 'Sunita Devi', patientAge: 54, status: 'result_delivered', capturedAt: '2026-09-06T09:05:00.000Z' },
  { captureId: 'PHC001-lz4a2c-d8g2', patientId: 'PHC001-lz3k9g-b4y2', patientName: 'Ramesh Kumar', patientAge: 62, status: 'synced', capturedAt: '2026-09-06T09:15:00.000Z' },
  { captureId: 'PHC001-lz4a2d-e9h3', patientId: 'PHC001-lz3k9h-c6z5', patientName: 'Priya Sharma', patientAge: 45, status: 'result_pending', capturedAt: '2026-09-06T09:25:00.000Z' },
  { captureId: 'PHC001-lz4a2e-f1i4', patientId: 'PHC001-lz3k9i-d8w3', patientName: 'Anil Verma', patientAge: 58, status: 'quality_passed', capturedAt: '2026-09-06T09:35:00.000Z' },
  { captureId: 'PHC001-lz4a2f-g2j5', patientId: 'PHC001-lz3k9j-e1v7', patientName: 'Kavita Joshi', patientAge: 49, status: 'captured', capturedAt: '2026-09-06T09:50:00.000Z' },
];

export const mockSyncStatus = {
  online: true,
  pendingCount: 2,
  lastSyncAttempt: '2026-09-06T09:40:00.000Z',
};


export const mockPeerDevices = [
  {
    deviceId: 'ph-4a91c2e7b03f',
    name: 'Outreach phone 1',
    createdAt: '2026-09-02T06:10:00.000Z',
    lastSeenAt: '2026-09-27T05:48:00.000Z',
    revokedAt: null,
  },
  {
    deviceId: 'ph-7c02de55a1b8',
    name: 'Camp tablet',
    createdAt: '2026-08-19T11:25:00.000Z',
    lastSeenAt: '2026-09-11T14:02:00.000Z',
    revokedAt: null,
  },
  {
    deviceId: 'ph-1f88b30c7d24',
    name: 'Old phone (replaced)',
    createdAt: '2026-06-30T08:00:00.000Z',
    lastSeenAt: '2026-08-04T09:15:00.000Z',
    revokedAt: '2026-08-05T10:00:00.000Z',
  },
];

export const cameraDevices = [
  { id: 'forus_3nethra_v2', label: 'Forus 3Nethra v2' },
  { id: 'remidio_fop', label: 'Remidio FOP' },
  { id: 'generic_fundus', label: 'Generic Fundus Camera' },
  { id: 'unknown', label: 'Unknown / Other' },
];
