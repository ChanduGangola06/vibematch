import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateOpenApi } from '../src/docs/generate.js';

const out = path.resolve(import.meta.dirname, '../../docs/openapi.json');
await mkdir(path.dirname(out), { recursive: true });
const doc = generateOpenApi();
await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(doc.paths as object).length} paths)`);
process.exit(0);
