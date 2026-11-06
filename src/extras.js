'use strict';

const fs = require('fs');
const path = require('path');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * A cooldownStore backed by a small JSON file, so provider cooldowns (a daily
 * limit, say) survive a restart and are shared by processes on one machine.
 * The file holds provider names and timestamps only, never keys. Writes are
 * atomic (temp file + rename). With concurrent writers the last write wins,
 * which at worst costs one extra request to a cooling provider. An unreadable
 * or corrupt file counts as "no cooldowns".
 * @param {string} filePath
 */
function fileCooldownStore(filePath) {
  const file = path.resolve(String(filePath));
  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const until = (data, provider) => {
    const value = Object.hasOwn(data, provider) ? Number(data[provider]) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  return {
    get: (provider) => until(load(), provider),
    getMany: (providers) => {
      const data = load();
      return providers.map((p) => until(data, p));
    },
    set: (provider, untilMs) => {
      const now = Date.now();
      const kept = Object.entries(load()).filter(([p, t]) => p !== provider && Number(t) > now);
      if (untilMs > now) kept.push([provider, untilMs]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(kept)));
      fs.renameSync(temp, file);
    },
  };
}

/**
 * Lists OpenRouter's free models right now, largest context window first. The
 * free lineup changes often, so use this to refresh a `models` list. Needs no
 * key and spends no quota.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{id: string, name: string, contextLength: number|null}[]>}
 */
async function discoverFreeModels({ timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { redirect: 'error', signal: controller.signal });
    if (!res.ok) throw new Error(`openrouter HTTP ${res.status}`);
    const body = await res.json();
    return (Array.isArray(body?.data) ? body.data : [])
      .filter((m) => typeof m?.id === 'string' && m.id.endsWith(':free'))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: Number.isFinite(m.context_length) ? m.context_length : null }))
      .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fileCooldownStore, discoverFreeModels };
