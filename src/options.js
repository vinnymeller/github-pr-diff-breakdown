import { parseConfigFile, matchesScope } from './lib/config.js';
import { extensionOf } from './lib/classify.js';

const $ = (id) => document.getElementById(id);
const configBox = $('config');
const issues = $('issues');
const status = $('status');

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = `status ${kind}`;
}

/** Validate on every keystroke so a broken rule is obvious before saving. */
function validate() {
  issues.replaceChildren();
  const text = configBox.value.trim();
  if (!text) return { rules: [], errors: [] };

  const parsed = parseConfigFile(text, 'your overrides');
  for (const error of parsed.errors) {
    const li = document.createElement('li');
    li.textContent = error.replace(/^your overrides: /, '');
    issues.appendChild(li);
  }
  return parsed;
}

function probe(rules) {
  const verdict = $('verdict');
  const path = $('probe').value.trim();
  const [owner, name] = $('probe-repo').value.trim().split('/');
  verdict.replaceChildren();
  if (!path) return;

  const chip = document.createElement('span');
  chip.className = 'chip';
  const why = document.createElement('span');
  why.className = 'why';

  // Scoped rules only count for the repository being tested, the same way they
  // are filtered on a real pull request.
  const inScope = rules.filter((rule) => matchesScope(rule.scope, owner, name));
  const hit = inScope.find((rule) => rule.re.some((re) => re.test(path)));

  const skipped = rules.find((rule) => rule.scope && !matchesScope(rule.scope, owner, name)
    && rule.re.some((re) => re.test(path)));

  if (!hit) {
    chip.textContent = extensionOf(path);
    why.textContent = skipped
      ? ` — the rule that matches this path is scoped to ${skipped.scope.join(', ')}, so it does not apply here.`
      : ' — no rule of yours matches, so it falls through to the repo config, then .gitattributes, then its extension.';
  } else if (hit.label === null) {
    chip.textContent = extensionOf(path);
    why.textContent = ' — a null-label rule matched, so it skips the repo config and falls through to the default layer.';
  } else {
    chip.textContent = hit.label;
    why.textContent = ' — matched by one of your rules.';
    if (hit.color) chip.style.background = hit.color;
  }
  verdict.append(chip, why);
}

let currentRules = [];
function refresh() {
  currentRules = validate().rules;
  probe(currentRules);
}

configBox.addEventListener('input', () => { refresh(); setStatus(''); });
for (const id of ['probe', 'probe-repo']) $(id).addEventListener('input', () => probe(currentRules));

$('save').addEventListener('click', async () => {
  const parsed = validate();
  if (parsed.errors.length) {
    setStatus(`Not saved — ${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'} above.`, 'err');
    return;
  }
  await chrome.storage.sync.set({ localConfig: configBox.value });
  setStatus('Saved. Reload any open pull request to see it.', 'ok');
});

$('reset').addEventListener('click', async () => {
  configBox.value = '';
  await chrome.storage.sync.set({ localConfig: '' });
  refresh();
  setStatus('Cleared.', 'ok');
});

const { localConfig = '' } = await chrome.storage.sync.get('localConfig');
configBox.value = localConfig;
refresh();
