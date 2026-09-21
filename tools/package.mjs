// Builds the Chrome Web Store upload: a zip of exactly what the extension runs.
//
// The repository and the package are different things. Tests, tooling, docs and
// screenshots belong in the repo and have no business inside the uploaded
// extension — they only inflate the download and widen the review surface.
// Anything not listed in INCLUDE below simply never reaches the store.
//
// Written by hand rather than shelling out to `zip` so a build needs nothing
// beyond Node, and with fixed timestamps so the same source always produces a
// byte-identical archive.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './crc32.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Everything the extension needs at runtime, and nothing else. */
const INCLUDE = ['manifest.json', 'src', 'icons'];

/** Belt and braces: never let these in even if they appear under an included dir. */
const EXCLUDE = /(^|[\\/])(\.|.*\.test\.js$|.*\.md$|node_modules$)/;

function collect(entry) {
  const absolute = join(ROOT, entry);
  const stats = statSync(absolute);
  if (!stats.isDirectory()) return [entry];
  return readdirSync(absolute)
    .flatMap((child) => collect(join(entry, child)))
    .filter((path) => !EXCLUDE.test(path));
}

// DOS epoch: a fixed stamp keeps builds reproducible.
const DOS_TIME = 0;
const DOS_DATE = 33;

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const compressed = deflateRawSync(data, { level: 9 });
    const sum = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);           // version made by
    entry.writeUInt16LE(20, 6);           // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(0o644 << 16, 38); // external attributes
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    central.push(entry);

    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const { version, name } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifestVersion = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
if (manifestVersion !== version) {
  console.error(`version mismatch: package.json says ${version}, manifest.json says ${manifestVersion}`);
  process.exit(1);
}

const files = INCLUDE.flatMap(collect)
  .sort()
  .map((path) => ({ name: path.split(sep).join('/'), data: readFileSync(join(ROOT, path)) }));

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', `${name}-${version}.zip`);
const archive = zip(files);
writeFileSync(out, archive);

console.log(`${relative(ROOT, out)} — ${files.length} files, ${(archive.length / 1024).toFixed(1)} KB`);
for (const file of files) console.log(`  ${file.name}`);
