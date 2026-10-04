
const LATIN1 = /^(latin1|iso-8859-1|l1|ascii|us-ascii|windows-1252)$/i;

function supportsLatin1(): boolean {
  try { new TextDecoder('latin1'); return true; } catch { return false; }
}

class Latin1Decoder {
  readonly encoding = 'windows-1252';
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

export function installLatin1Decoder(): void {
  if (typeof TextDecoder === 'undefined' || supportsLatin1()) return;
  const Native = TextDecoder;
  const Patched = function (this: unknown, label?: string, options?: TextDecoderOptions) {
    return label && LATIN1.test(label) ? new Latin1Decoder() : new Native(label, options);
  } as unknown as typeof TextDecoder;
  (Patched as { prototype: unknown }).prototype = Native.prototype;
  globalThis.TextDecoder = Patched;
}

installLatin1Decoder();
