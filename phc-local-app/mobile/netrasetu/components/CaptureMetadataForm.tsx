
import React from 'react';
import { View } from 'react-native';
import { Eye, LightingEnvironment, ObservedIssue, PupilStatus, UsabilityRating } from '../types';
import { MetadataDraft, toggleObservedIssue } from '../lib/metadata';
import { Card, ChipGroup, Field, MultiChipGroup } from './ui';
import { SelectField } from './SelectField';

export { metadataMissing, toMetadataPayload } from '../lib/metadata';
export type { MetadataDraft } from '../lib/metadata';

export const CAMERA_DEVICES = [
  { value: 'forus_3nethra_v2', label: 'Forus 3Nethra v2' },
  { value: 'remidio_fop', label: 'Remidio FOP' },
  { value: 'generic_fundus', label: 'Generic Fundus Camera' },
  { value: 'unknown', label: 'Unknown / Other' },
];

export const LENS_DEVICE = { value: 'mobile_lens', label: 'Phone + attached fundus lens' };

const ISSUES: { value: ObservedIssue; label: string }[] = [
  { value: 'glare', label: 'GLARE' },
  { value: 'blink_or_moved', label: 'BLINKED / MOVED' },
  { value: 'out_of_focus', label: 'OUT OF FOCUS' },
  { value: 'media_opacity', label: 'MEDIA OPACITY (CATARACT?)' },
  { value: 'eyelash_obstruction', label: 'EYELASH / EYELID' },
  { value: 'none_noticed', label: 'NONE NOTICED' },
];

export function CaptureMetadataForm({ value, onChange, lensCapture, showErrors }: {
  value: MetadataDraft;
  onChange: (d: MetadataDraft) => void;
  lensCapture: boolean;
  showErrors: boolean;
}) {
  const set = <K extends keyof MetadataDraft>(k: K, v: MetadataDraft[K]) => onChange({ ...value, [k]: v });

  const toggleIssue = (issue: ObservedIssue) => set('observedIssues', toggleObservedIssue(value.observedIssues, issue));

  const err = (missing: boolean) => (showErrors && missing ? 'Required' : null);

  return (
    <Card title="CAPTURE METADATA">
      <View>
        <Field label="EYE SCANNED" required error={err(!value.eye)}>
          <ChipGroup<Eye>
            columns={2}
            value={value.eye}
            onChange={(v) => set('eye', v)}
            options={[{ value: 'left', label: 'LEFT (OS)' }, { value: 'right', label: 'RIGHT (OD)' }]}
          />
        </Field>

        <Field label="CAMERA DEVICE" required hint={lensCapture ? 'Captured in this app with the attached lens.' : 'The dedicated fundus camera that took this image.'}>
          <SelectField
            title="CAMERA DEVICE"
            value={value.cameraDeviceId}
            onChange={(v) => set('cameraDeviceId', v)}
            options={lensCapture ? [LENS_DEVICE] : CAMERA_DEVICES}
            disabled={lensCapture}
          />
        </Field>

        <Field label="PUPIL STATUS" required error={err(!value.pupilStatus)}>
          <ChipGroup<PupilStatus>
            columns={3}
            value={value.pupilStatus}
            onChange={(v) => set('pupilStatus', v)}
            options={[{ value: 'dilated', label: 'DILATED' }, { value: 'non_dilated', label: 'NOT DILATED' }, { value: 'unknown', label: 'UNKNOWN' }]}
          />
        </Field>

        <Field label="LIGHTING ENVIRONMENT" required error={err(!value.lightingEnvironment)}>
          <ChipGroup<LightingEnvironment>
            columns={3}
            value={value.lightingEnvironment}
            onChange={(v) => set('lightingEnvironment', v)}
            options={[{ value: 'indoor_clinic', label: 'INDOOR CLINIC' }, { value: 'outdoor_mobile', label: 'OUTDOOR / CAMP' }, { value: 'low_light', label: 'LOW LIGHT' }]}
          />
        </Field>

        <Field label="OBSERVED ISSUES" required error={err(!value.observedIssues.length)}>
          <MultiChipGroup<ObservedIssue> columns={2} values={value.observedIssues} onToggle={toggleIssue} options={ISSUES} />
        </Field>

        <Field label="YOUR USABILITY RATING" required error={err(!value.workerUsabilityRating)} style={{ marginBottom: 0 }}>
          <ChipGroup<UsabilityRating>
            columns={3}
            value={value.workerUsabilityRating}
            onChange={(v) => set('workerUsabilityRating', v)}
            options={[{ value: 'clear', label: 'CLEAR' }, { value: 'not_sure', label: 'NOT SURE' }, { value: 'clearly_unusable', label: 'UNUSABLE' }]}
          />
        </Field>
      </View>
    </Card>
  );
}
