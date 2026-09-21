import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff } from '../src/lib/diff.js';
import { compileGlob } from '../src/lib/glob.js';
import { parseGitattributes, attributesFor } from '../src/lib/gitattributes.js';
import { parseYaml } from '../src/lib/yaml.js';
import { parseConfigFile } from '../src/lib/config.js';
import { extensionOf } from '../src/lib/classify.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('diff: every awkward shape git can emit', () => {
  const { files } = parseDiff(fixture('edge-cases.diff'));
  const got = files.map((f) => [f.path, f.additions, f.deletions, f.binary, f.status]);
  assert.deepEqual(got, [
    ['src/app.py', 2, 0, false, 'modified'],
    ['src/renamed.py', 1, 0, false, 'renamed'],
    ['src/removed.py', 0, 2, false, 'deleted'],
    // A file whose *contents* are a diff: the parser must count the outer diff,
    // not the ---/+++/@@ lines inside it.
    ['tests/embedded.diff', 6, 0, false, 'added'],
    ['tests/embedded2.diff', 1, 0, false, 'modified'],
    ['logo.png', 0, 0, true, 'modified'],
    ['icon.ico', 0, 0, true, 'added'],
    ['src/q"uote.txt', 1, 0, false, 'modified'],
    ['weird dir/a file.txt', 1, 0, false, 'modified'],
    ['src/nonewline.txt', 1, 1, false, 'modified'],
    ['docs/café.md', 1, 0, false, 'added'],
    // git terminates ---/+++ with a tab when the path contains a space; without
    // stripping it this lands in a phantom "md\t" bucket beside the real one.
    ['docs/architecture docs/ADR-INDEX.md', 1, 0, false, 'modified'],
    ['scripts/run.sh', 0, 0, false, 'modified'],
  ]);
});

test('diff: reproduces GitHub\'s own per-file counts for a real PR', () => {
  // Ground truth from the REST API for sindresorhus/got#2465.
  const { files } = parseDiff(fixture('got-2465.diff'));
  assert.deepEqual(
    files.map((f) => `${f.additions}/${f.deletions} ${f.path}`),
    [
      '14/0 source/as-promise/index.ts',
      '80/7 source/core/index.ts',
      '35/3 source/core/options.ts',
      '13/0 source/create.ts',
      '6/0 test/helpers/server-tools.ts',
      '385/0 test/hooks.ts',
      '231/0 test/pagination.ts',
    ],
  );
  assert.equal(files.reduce((s, f) => s + f.additions, 0), 764);
  assert.equal(files.reduce((s, f) => s + f.deletions, 0), 10);
});

test('diff: an empty or truncated payload yields no files rather than throwing', () => {
  assert.deepEqual(parseDiff('').files, []);
  assert.deepEqual(parseDiff('not a diff at all\n').files, []);
  assert.equal(parseDiff('diff --git a/a.py b/a.py\n@@ -1,5 +1,5 @@\n-one\n').files[0].deletions, 1);
});

test('glob: gitignore semantics', () => {
  const cases = [
    ['*.py', 'src/deep/a.py', true],
    ['*.py', 'a.py', true],
    ['*.py', 'a.pyc', false],
    ['/*.md', 'x.md', true],
    ['/*.md', 'docs/x.md', false],       // a leading slash anchors to the root
    ['tests/cassettes/**', 'tests/cassettes/a/b.yaml', true],
    ['tests/cassettes/**', 'tests/cassettes', false],
    ['docs/', 'docs/a/b.md', true],       // a trailing slash means everything under
    ['**/__snapshots__/**', 'src/x/__snapshots__/a.snap', true],
    ['src/*.py', 'src/deep/a.py', false], // * does not cross a slash
    ['?.py', 'a.py', true],
    ['[ab].py', 'b.py', true],
    ['[!ab].py', 'c.py', true],
    ['[!ab].py', 'a.py', false],
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(compileGlob(pattern).test(path), expected, `${pattern} ~ ${path}`);
  }
});

test('glob: rejects the inputs that would make this a regex engine', () => {
  assert.throws(() => compileGlob('!*.py'), /negated/);
  assert.throws(() => compileGlob('x'.repeat(600)), /512/);
  assert.throws(() => compileGlob('   '), /empty/);
  // Regex metacharacters are literals, not operators.
  assert.ok(compileGlob('a+b.py').test('a+b.py'));
  assert.ok(!compileGlob('a+b.py').test('aab.py'));
});

test('gitattributes: the attributes that mean "a human did not write this"', () => {
  const rules = parseGitattributes(`
# comment
tests/cassettes/** linguist-generated=true
*.lock linguist-generated
vendor/** linguist-vendored
docs/** linguist-documentation
*.png binary
*.bin -diff
src/real.py -linguist-generated
[attr]mymacro foo
`);
  const at = (p) => attributesFor(rules, p);
  assert.equal(at('tests/cassettes/a.yaml').generated, true);
  assert.equal(at('poetry.lock').generated, true);
  assert.equal(at('vendor/x.go').vendored, true);
  assert.equal(at('docs/a.md').documentation, true);
  assert.equal(at('logo.png').binary, true);
  assert.equal(at('a.bin').binary, true);
  assert.equal(at('src/real.py').generated, false);
  assert.equal(at('src/app.py').generated, false);
});

test('gitattributes: later lines win, the way git resolves them', () => {
  const rules = parseGitattributes('*.yaml linguist-generated=true\ntests/keep.yaml -linguist-generated\n');
  assert.equal(attributesFor(rules, 'a.yaml').generated, true);
  assert.equal(attributesFor(rules, 'tests/keep.yaml').generated, false);
});

test('yaml: the supported subset round-trips', () => {
  assert.deepEqual(
    parseYaml(`version: 1
buckets:
  - label: cassettes
    color: purple
    patterns:
      - tests/cassettes/**
      - '**/*.cassette.yaml'
  - label: ci
    patterns: ['.github/workflows/**', ".circleci/**"]
  - label: ~
    patterns:
      - vendor/**   # trailing comment
`),
    {
      version: 1,
      buckets: [
        { label: 'cassettes', color: 'purple', patterns: ['tests/cassettes/**', '**/*.cassette.yaml'] },
        { label: 'ci', patterns: ['.github/workflows/**', '.circleci/**'] },
        { label: null, patterns: ['vendor/**'] },
      ],
    },
  );
});

test('yaml: unsupported syntax fails loudly with a line number', () => {
  const bad = [
    ['a: b\n\tc: d', /line 2.*tabs/],
    ['x: |\n  block', /block scalars/],
    ['foo: &anchor', /anchors/],
    ['k: [1, 2', /unterminated flow sequence/],
    ['k: {a: 1}', /flow mappings/],
  ];
  for (const [src, pattern] of bad) assert.throws(() => parseYaml(src), pattern, src);
});

test('config: a broken repo file reports errors instead of silently applying', () => {
  const { rules, errors } = parseConfigFile('version: 2\nbuckets: []\n', 'repo');
  assert.deepEqual(rules, []);
  assert.match(errors[0], /unsupported version/);

  assert.match(parseConfigFile('buckets:\n  - patterns: [a]\n', 'repo').errors[0], /missing "label"/);
  assert.match(parseConfigFile('buckets:\n  - label: x\n', 'repo').errors[0], /non-empty list/);
  assert.match(parseConfigFile('buckets:\n  - label: x\n    color: chartreuse\n    patterns: [a]\n', 'repo').errors[0], /color must be/);
  assert.match(parseConfigFile('buckets:\n  - label: x\n    patterns: ["!a"]\n', 'repo').errors[0], /negated/);
  assert.match(parseConfigFile(': : :\n', 'repo').errors[0], /line 1/);
  // A typo in a top-level key must not parse cleanly into "no rules at all".
  assert.match(parseConfigFile('bucket:\n  - label: x\n    patterns: [a]\n', 'repo').errors[0], /unknown key "bucket"/);
});

test('config: a valid bucket survives alongside a broken sibling', () => {
  const { rules, errors } = parseConfigFile(
    'buckets:\n  - label: good\n    patterns: [src/**]\n  - label: bad\n    color: nope\n    patterns: [lib/**]\n', 'repo');
  assert.equal(rules.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(rules[1].color, null, 'the bad color is dropped, the bucket is kept');
});

test('extension labels: dotfiles and extensionless files keep their name', () => {
  assert.equal(extensionOf('src/app.py'), 'py');
  assert.equal(extensionOf('src/App.PY'), 'py');
  assert.equal(extensionOf('.gitignore'), '.gitignore');
  assert.equal(extensionOf('Dockerfile'), 'Dockerfile');
  assert.equal(extensionOf('a/b/Makefile'), 'Makefile');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
});
