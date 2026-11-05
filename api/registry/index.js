/**
 * Agent settings API (no sign-in required).
 *
 *   GET    /api/registry                      → { storage, agents, removed }
 *   POST   /api/registry  { agent: {...} }    save (create or update) an agent profile; also restores a removed agent
 *   POST   /api/registry  { restore: "<id>" } start monitoring a removed agent again
 *   DELETE /api/registry?id=<id>              stop monitoring an agent (telemetry is not deleted)
 *   DELETE /api/registry?id=<id>&profile=1    also delete its saved profile
 */
const { DefaultAzureCredential } = require('@azure/identity');
const { loadRegistry, updateRegistry, saveProfile, removeAgent, restoreAgent, deleteProfile, RegistryError } = require('../shared/registry');

const credential = new DefaultAzureCredential();
const json = (status, body) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body });

module.exports = async function (context, req) {
  const method = String(req.method || 'GET').toUpperCase();
  try {
    if (method === 'GET') {
      const reg = await loadRegistry(credential);
      context.res = json(200, { storage: reg.storage, updatedAt: reg.updatedAt, agents: reg.agents, removed: reg.removed });
      return;
    }
    if (method === 'POST') {
      const body = req.body || {};
      if (body.restore) {
        const id = await updateRegistry(credential, (s) => restoreAgent(s, String(body.restore)));
        context.log(`Agent settings: restored ${id}`);
        context.res = json(200, { ok: true, restored: id });
        return;
      }
      if (!body.agent) throw new RegistryError('No agent details were sent.', 400);
      const saved = await updateRegistry(credential, (s) => saveProfile(s, body.agent));
      context.log(`Agent settings: saved ${saved.id}`);
      context.res = json(200, { ok: true, agent: saved });
      return;
    }
    if (method === 'DELETE') {
      const id = req.query?.id;
      if (!id) throw new RegistryError('Agent id is required.', 400);
      await updateRegistry(credential, (s) => {
        removeAgent(s, id);
        if (req.query?.profile === '1') deleteProfile(s, id);
      });
      context.log(`Agent settings: removed ${id} from monitoring`);
      context.res = json(200, { ok: true, removed: id });
      return;
    }
    context.res = json(405, { message: 'Method not allowed' });
  } catch (e) {
    const status = e instanceof RegistryError ? e.status : 500;
    if (status >= 500) context.log.error('Agent settings request failed.', e);
    context.res = json(status, { message: e instanceof RegistryError ? e.message : 'The agent settings could not be updated.' });
  }
};
