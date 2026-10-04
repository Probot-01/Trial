

import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { POLICY } from '../config';

const capturesDir = () => new Directory(Paths.document, 'captures');

function extFor(uri: string, mimeType?: string | null): string {
  const m = /\.(jpe?g|png|heic|heif|tiff?|bmp)$/i.exec(uri.split('?')[0]);
  if (m) {
    const e = m[1].toLowerCase();
    // central accepts jpg/png/tif/bmp/dcm; HEIC is converted by the caller first.
    return e === 'jpeg' ? 'jpg' : e;
  }
  if (mimeType === 'image/png') return 'png';
  return 'jpg';
}

/** Copies the image at `sourceUri` to captures/<captureId>.<ext>; returns the stored file. */
export async function persistCaptureImage(sourceUri: string, captureId: string, mimeType?: string | null): Promise<{ uri: string; bytes: number }> {
  const dir = capturesDir();
  dir.create({ intermediates: true, idempotent: true });
  let ext = extFor(sourceUri, mimeType);
  let from = sourceUri;
  if (ext === 'heic' || ext === 'heif') {
    // iPhone galleries hand out HEIC, which central does not accept. Convert
    // once, at maximum JPEG quality, before anything is stored or graded.
    const ref = await ImageManipulator.manipulate(sourceUri).renderAsync();
    from = (await ref.saveAsync({ format: SaveFormat.JPEG, compress: 1 })).uri;
    ext = 'jpg';
  }
  const dest = new File(dir, `${captureId}.${ext}`);
  if (dest.exists) dest.delete();
  await new File(from).copy(dest);
  return { uri: dest.uri, bytes: dest.size ?? 0 };
}

export function imageExists(uri: string): boolean {
  try { return new File(uri).exists; } catch { return false; }
}

export interface StoragePressure {
  availableBytes: number;
  low: boolean;
}

export function storagePressure(): StoragePressure {
  let available = Number.POSITIVE_INFINITY;
  try { available = Paths.availableDiskSpace; } catch { /* unknown on this platform */ }
  return { availableBytes: available, low: available < POLICY.lowDiskBytes };
}
