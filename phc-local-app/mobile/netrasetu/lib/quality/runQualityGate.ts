
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { decode } from 'fast-png';
import { QualityResult } from '../../types';
import { runQualityGateOnGray, toGray } from './qualityGate';

const MAX_SIDE = 4600;

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

export async function runQualityGate(imageUri: string, cameraDeviceId: string): Promise<QualityResult & { durationMs: number }> {
  const t0 = Date.now();

  // First pass only to learn the size (and apply EXIF orientation).
  const ctx = ImageManipulator.manipulate(imageUri);
  let ref = await ctx.renderAsync();
  let scale = 1;
  if (Math.max(ref.width, ref.height) > MAX_SIDE) {
    scale = MAX_SIDE / Math.max(ref.width, ref.height);
    ctx.resize({ width: Math.round(ref.width * scale), height: Math.round(ref.height * scale) });
    ref = await ctx.renderAsync();
  }
  const saved = await ref.saveAsync({ format: SaveFormat.PNG });

  const pngFile = new File(saved.uri);
  let gray;
  try {
    const bytes = await pngFile.bytes();
    await nextFrame();
    const png = decode(bytes);
    if (png.palette) throw new Error('Indexed-colour PNG not supported by the quality gate');
    await nextFrame();
    gray = toGray(png.data as Uint8Array, png.width, png.height, png.channels, png.depth);
  } finally {
    try { pngFile.delete(); } catch { /* temp file; ignore */ }
  }

  await nextFrame();
  const result = runQualityGateOnGray(gray, cameraDeviceId, { diskRadius: Math.max(1, Math.round(7 * scale)) });
  if (scale !== 1) result.analysedAt += ` (scaled ${Math.round(scale * 100)}%)`;
  return { ...result, durationMs: Date.now() - t0 };
}
