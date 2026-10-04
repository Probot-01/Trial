import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One throwaway "device" per test process: its own SQLite file and documents dir.
if (!process.env.NETRASETU_TEST_ROOT) {
  process.env.NETRASETU_TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'netrasetu-device-'));
}

register('./loader.mjs', import.meta.url);


const NodeFormData = globalThis.FormData;
globalThis.FormData = class RNFormData extends NodeFormData {
  append(name, value, filename) {
    if (value && typeof value === 'object' && typeof value.uri === 'string' && !(value instanceof Blob)) {
      const file = value.uri.startsWith('file://') ? new URL(value.uri) : value.uri;
      const blob = new Blob([fs.readFileSync(file)], { type: value.type || 'application/octet-stream' });
      return super.append(name, blob, value.name || filename || 'file');
    }
    // A 3-argument append requires a Blob in Node, so only pass a filename when given.
    return filename === undefined ? super.append(name, value) : super.append(name, value, filename);
  }
};
