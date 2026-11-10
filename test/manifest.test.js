// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS, LANGUAGES, LIMITS, OAUTH_KEY, SCENE_ACTION } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const allFields = [
  ...manifest.config_schema,
  ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ...(manifest.scene_actions ?? []).flatMap((a) => a.fields ?? []),
];

test('the store basics, one version everywhere (semver, never pinned twice)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-google-assistant-sdk:${manifest.version}`,
  );
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['notifications', 'assistants']);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies['@gladysassistant/integration-sdk'], '^0.16.0');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.match(manifest.description[lang], /^(Unofficial|Non officiel)/);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Google|sans\s+lien\s+avec\s+Google/i);
    assert.match(docs, /never tested with a real|jamais (été )?testée? avec un vrai/i);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('no device, no network capture, no extra container, no webhook, no widget', () => {
  for (const key of ['network_discovery', 'containers', 'webhooks', 'widgets', 'scene_triggers']) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('the configuration matches the code; the secret has no default; no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'client_id',
    'client_secret',
    'language',
    OAUTH_KEY,
  ]);
  assert.equal(fields.client_secret.type, 'secret');
  assert.equal(fields[OAUTH_KEY].type, 'oauth2');
  for (const field of allFields) {
    assert.ok(!field.key.toLowerCase().startsWith('gladys_'), field.key);
    if (field.type === 'secret') assert.equal(field.default, undefined, field.key);
  }
  // The refresh token is an off-schema key: never a form field.
  assert.equal(fields.refresh_token, undefined);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.equal(fields.language.default, undefined, 'the user picks the language');
  for (const lang of ['en', 'fr']) {
    assert.match(
      fields.client_secret.description[lang],
      /(Kept by Gladys in its database, never shown again, sent only to Google|Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à Google)/,
    );
  }
  const section = fields.intro;
  for (const lang of ['en', 'fr']) assert.ok(section.description[lang].length <= 1000);
  assert.ok(section.links.every((l) => l.url.startsWith('https://')));
  assert.match(section.description.en, /https:\/\/my\.gladysassistant\.com\/redirect\/oauth/);
});

test('select options follow the rules of the core (labels plain text, unique values)', () => {
  for (const field of allFields.filter((f) => f.options)) {
    assert.ok(Array.isArray(field.options) && field.options.length > 0, field.key);
    for (const option of field.options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
      for (const lang of ['en', 'fr']) {
        assert.equal(typeof option.label[lang], 'string');
        assert.ok(option.label[lang]);
        assert.equal(option.label[lang], option.label[lang].trim());
      }
    }
    assert.equal(new Set(field.options.map((o) => o.value)).size, field.options.length);
  }
  // No device is published, so no feature carries supported_options.
  assert.equal(manifest.devices, undefined);
});

test('the actions and the scene action are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    [SCENE_ACTION],
  );
  assert.ok(handlers.includes('onSceneAction(SCENE_ACTION'));
  const [scene] = manifest.scene_actions;
  assert.equal(scene.timeout_seconds, 30);
  assert.equal(scene.outputs, undefined);
  assert.deepEqual(
    scene.fields.map((f) => [f.key, f.type, f.required]),
    [
      ['message', 'string', true],
      ['room', 'string', false],
    ],
  );
  for (const action of manifest.actions) assert.ok(action.timeout_seconds <= 120);
  // Field descriptions state the bounds of the code.
  assert.match(scene.fields[0].description.en, new RegExp(`${LIMITS.messageChars} characters`));
});
