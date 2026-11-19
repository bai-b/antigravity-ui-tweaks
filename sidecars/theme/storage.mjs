import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const gemini = join(homedir(), '.gemini');
export const configDir = process.env.AGY_UI_TWEAKS_CONFIG_DIR || join(gemini, 'config');
export const appData = process.env.AGY_UI_TWEAKS_APP_DATA || join(gemini, 'antigravity');
export const privateDir = join(configDir, '.ui-tweaks-data');
export const settingsPath = join(configDir, 'config.json');

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseObject(raw, path) {
  if (raw === null) return {};
  const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!object(value)) throw new Error(path + ' 应为 JSON 对象。');
  return value;
}

export async function readJson(path) {
  return parseObject(await readOptional(path), path);
}

export async function serialize(operations, key, run) {
  const operation = (operations.get(key) || Promise.resolve()).catch(() => {}).then(run);
  operations.set(key, operation);
  try { return await operation; }
  finally { if (operations.get(key) === operation) operations.delete(key); }
}

const writes = new Map();

export function updateJson(path, update, options = {}) {
  return serialize(writes, path, () => writeJson(path, update, options));
}

async function writeJson(path, update, { backup = false }) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const original = await readOptional(path);
    const document = parseObject(original, path);
    const before = JSON.stringify(document);
    await update(document);
    if (JSON.stringify(document) === before) return document;
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
      if (backup && original !== null) {
        const directory = join(configDir, '.ui-tweaks-backups');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'config-' + randomUUID() + '.json'), original, { flag: 'wx' });
      }
      if (await readOptional(path) !== original) continue;
      await rename(temporary, path);
      return document;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  throw new Error('配置同时发生了更新。请重新读取后再试。');
}
