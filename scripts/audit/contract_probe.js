// Usage: OPH_PW=... ADM_PW=... PHC_KEY=... OUTFILE=probe.json node scripts/audit/contract_probe.js  (passwords: printed by demo-reset)
// Probe every documented GET endpoint on the live central + PHC backends and report status + missing contract keys.
const fs = require('fs');
const CENTRAL = 'http://localhost:5200', PHC = 'http://localhost:4200';
const OPH = { email: 'ophthalmologist@demo.netrasetu.local', password: process.env.OPH_PW };
const ADM = { email: 'admin@demo.netrasetu.local', password: process.env.ADM_PW };
const PHCKEY = process.env.PHC_KEY;
async function login(u) {
  const r = await fetch(CENTRAL + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u) });
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookie, body: await r.json() };
}
const out = [];
const rec = (name, ok, detail = '') => { out.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
async function get(base, path, headers = {}) { const r = await fetch(base + path, { headers, redirect: 'manual' }); let b = null; const t = await r.text(); try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b, headers: r.headers }; }
(async () => {
  const o = await login(OPH), a = await login(ADM);
  rec('ophthalmologist login', o.status === 200 && !!o.cookie); rec('admin login', a.status === 200 && !!a.cookie);
  const oh = { cookie: o.cookie }, ah = { cookie: a.cookie };
  const q = await get(CENTRAL, '/api/v1/ophthalmologist/queue', oh);
  rec('GET /ophthalmologist/queue 200', q.status === 200, `status ${q.status}`);
  const items = q.body.items || q.body.cases || q.body;
  rec('queue has items', Array.isArray(items) && items.length > 0, `n=${items?.length}`);
  const first = items[0] || {};
  const need = ['caseId', 'patientReference', 'capturedAt', 'conformalTier'];
  const miss = need.filter((k) => !(k in first));
  rec('queue item keys', miss.length === 0, miss.length ? 'missing ' + miss.join(',') : `keys=${Object.keys(first).length}`);
  const caseId = first.caseId;
  const d = await get(CENTRAL, `/api/v1/cases/${caseId}`, oh);
  rec('GET /cases/:id 200', d.status === 200);
  const example = ['caseId', 'patientReference', 'imageUrl', 'gradCamOverlayUrl', 'lesionCounts', 'nvSuspicionScore', 'evidenceSummaryText', 'drGradeCnn', 'drGradeRuleEngine', 'branchAgreement', 'confidenceScore', 'uncertaintyScore', 'conformalTier', 'lesionAttentionConsistencyScore', 'questionnaireData', 'captureMetadata', 'priorAssessments', 'engineProvenance', 'status', 'modelVersion', 'eyeLaterality'];
  const dm = example.filter((k) => !(k in d.body));
  rec('case detail contract keys present (null allowed)', dm.length === 0, dm.length ? 'missing ' + dm.join(',') : `${Object.keys(d.body).length} keys`);
  const lc = d.body.lesionCounts || {};
  rec('lesionCounts has the 4 contract keys', ['microaneurysms', 'hemorrhages', 'hardExudates', 'softExudates'].every((k) => k in lc));
  const ep = d.body.engineProvenance || {};
  rec('engineProvenance has 4 top keys', ['classifier', 'segmentation', 'ruleEngine', 'qualityGate'].every((k) => k in ep), Object.keys(ep).join(','));
  for (const [n, p] of [['status', `/api/v1/cases/${caseId}/status`], ['reviews', `/api/v1/cases/${caseId}/reviews`], ['report pdf', `/api/v1/cases/${caseId}/report`]]) {
    const r = await get(CENTRAL, p, oh); rec(`GET ${n}`, r.status === 200, `status ${r.status} ${r.headers.get('content-type') || ''}`);
  }
  if (d.body.imageUrl) { const r = await fetch(CENTRAL + d.body.imageUrl, { headers: oh }); rec('image served to reviewer (encrypted-at-rest decrypted)', r.status === 200 && /image/.test(r.headers.get('content-type') || ''), `${r.status} ${r.headers.get('content-type')}`); const anon = await fetch(CENTRAL + d.body.imageUrl); rec('image refused anonymously', anon.status === 401, `status ${anon.status}`); }
  if (d.body.gradCamOverlayUrl) { const r = await fetch(CENTRAL + d.body.gradCamOverlayUrl, { headers: oh }); rec('grad-cam served', r.status === 200, `${r.status}`); }
  for (const p of ['/api/v1/admin/dashboard', '/api/v1/admin/phcs', '/api/v1/admin/referrals', '/api/v1/admin/resource-recommendations', '/api/v1/admin/simulink-validation', '/api/v1/admin/system-health', '/api/v1/auth/me']) {
    const r = await get(CENTRAL, p, ah); rec(`GET ${p} (admin)`, r.status === 200, `status ${r.status}`);
  }
  // role separation
  for (const p of ['/api/v1/admin/dashboard', '/api/v1/admin/system-health']) { const r = await get(CENTRAL, p, oh); rec(`ophthalmologist blocked from ${p}`, r.status === 403, `status ${r.status}`); }
  const r1 = await get(CENTRAL, '/api/v1/ophthalmologist/queue', ah); rec('admin blocked from reviewer queue', r1.status === 403, `status ${r1.status}`);
  const s = await get(CENTRAL, '/api/v1/patients/search?name=demo', oh); rec('GET patients/search (central)', s.status === 200, `status ${s.status}`);
  // PHC key endpoints
  const cap = (d.body.captureIdRef) || null;
  const h = await get(CENTRAL, '/health'); rec('central /health components', ['db', 'queue', 'matlabSession', 'python'].every((k) => h.body.components && k in h.body.components), Object.keys(h.body.components || {}).join(','));
  // PHC local API
  for (const p of ['/health', '/patients', '/captures', '/sync/status']) { const r = await get(PHC, p); rec(`PHC GET ${p}`, r.status === 200, `status ${r.status}`); }
  const pl = await get(PHC, '/captures'); const done = (pl.body || []).find((c) => c.captureId);
  if (done) { const r = await get(CENTRAL, `/api/v1/phc/cases/${encodeURIComponent(done.captureId)}/report`, { 'x-phc-api-key': PHCKEY }); rec('PHC report endpoint (phc key)', [200, 404, 409].includes(r.status), `status ${r.status}`); }
  const anonRep = await get(CENTRAL, `/api/v1/phc/cases/x/report`); rec('PHC report refuses anonymous', anonRep.status === 401, `status ${anonRep.status}`);
  const nf = await get(CENTRAL, '/api/v1/nope', oh); rec('unknown route -> JSON error shape', nf.status === 404 && typeof nf.body === 'object' && 'error' in nf.body, JSON.stringify(nf.body).slice(0, 80));
  const failed = out.filter((x) => !x.ok);
  console.log(`\n${out.length - failed.length}/${out.length} passed`);
  fs.writeFileSync(process.env.OUTFILE, JSON.stringify(out, null, 1));
})();
