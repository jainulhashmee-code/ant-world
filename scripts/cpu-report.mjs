#!/usr/bin/env node
/**
 * Summarise a V8 .cpuprofile into self-time per function.
 *
 *   node scripts/cpu-report.mjs .prof/XXXX.cpuprofile
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.prof';
let file = dir;

if (dir.endsWith('.cpuprofile') === false) {
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => join(dir, f))
    .sort();
  if (candidates.length === 0) {
    console.error(`no .cpuprofile files in ${dir}`);
    process.exit(1);
  }
  file = candidates[candidates.length - 1];
}

const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map();
for (const node of profile.nodes) byId.set(node.id, node);

// Self time = samples attributed directly to the node.
const self = new Map();
let total = 0;
for (const id of profile.samples ?? []) {
  const node = byId.get(id);
  if (!node) continue;
  const cf = node.callFrame;
  const key = `${cf.functionName || '(anonymous)'}  ${cf.url.replace(/^.*\//, '')}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + 1);
  total++;
}

const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

console.log(`\nprofile: ${file}`);
console.log(`samples: ${total}\n`);
console.log('self%   function');
console.log('-'.repeat(78));
for (const [key, n] of rows) {
  console.log(`${((n / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
}
console.log('');
