
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const SHIMS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shims');

const SHIMMED = new Set([
  'react-native', 'expo-sqlite', 'expo-file-system', 'expo-crypto', 'expo-network', 'expo-image-manipulator', 'expo-secure-store',
]);

export async function resolve(specifier, context, next) {
  if (SHIMMED.has(specifier)) {
    return { url: pathToFileURL(path.join(SHIMS, `${specifier}.mjs`)).href, shortCircuit: true };
  }
  if ((specifier.startsWith('.') || specifier.startsWith('/')) && context.parentURL?.startsWith('file:')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (!path.extname(base) || !fs.existsSync(base)) {
      for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (/\.tsx?$/.test(url)) {
    const source = fs.readFileSync(fileURLToPath(url), 'utf8');
    const out = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  if (url.endsWith('.json')) {
    return { format: 'json', source: fs.readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return next(url, context);
}
