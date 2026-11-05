/**
 * Connected-agents registry API.
 *
 *   GET    /api/registry                 → { storage, agents }
 *   POST   /api/registry                 body { agent: {...} }  connect one agent
 *                                        body { agents: [...] } connect several
 *                                        body { agent: {...}, update: true } edit a connected agent
 *   DELETE /api/registry?id=<agent id>   disconnect (remove) an agent
 *
 * Changes require a signed-in user (Static Web Apps authentication sends the
 * x-ms-client-principal header). Set ALLOW_ANONYMOUS_CHANGES=true only for
 * local development. Set REGISTRY_ADMIN_ROLE to limit changes to one SWA role.
 * Disconnecting an agent never deletes telemetry; it only stops it being monitored.
 */
const { DefaultAzureCredential } = require('@azure/identity');
const { loadRegistry, updateRegistry, connect, disconnect, RegistryError } = require('../shared/registry');

const credential = new DefaultAzureCredential();
const json = (status, body) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body });

function principal(req) {
  const header = req.headers?.['x-ms-client-principal'];
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function authorise(req) {
  const p = principal(req);
  if (process.env.ALLOW_ANONYMOUS_CHANGES === 'true') return p?.userDetails || 'anonymous (local dev)';
  if (!p) throw new RegistryError('Please sign in to connect or remove agents.', 401);
  const role = process.env.REGISTRY_ADMIN_ROLE;
  if (role && !(p.userRoles || []).includes(role)) throw new RegistryError(`Only users with the “${role}” role can change connected agents.`, 403);
  return p.userDetails || p.userId || 'signed-in user';
}

module.exports = async function (context, req) {
  const method = String(req.method || 'GET').toUpperCase();
  try {
    if (method === 'GET') {
      const reg = await loadRegistry(credential);
      context.res = json(200, { storage: reg.storage, updatedAt: reg.updatedAt, agents: reg.agents });
      return;
    }
    const user = authorise(req);
    if (method === 'POST') {
      const body = req.body || {};
      const items = Array.isArray(body.agents) ? body.agents : body.agent ? [body.agent] : [];
      if (!items.length) throw new RegistryError('No agent details were sent.', 400);
      if (items.length > 200) throw new RegistryError('Too many agents in one request (max 200).', 400);
      const { result } = await updateRegistry(credential, (agents) => items.map((a) => connect(agents, a, { user, allowUpdate: !!body.update })), user);
      context.log(`Registry: ${body.update ? 'updated' : 'connected'} ${result.map((r) => r.id).join(', ')} by ${user}`);
      context.res = json(200, { ok: true, agents: result });
      return;
    }
    if (method === 'DELETE') {
      const id = req.query?.id;
      if (!id) throw new RegistryError('Agent id is required.', 400);
      const { result } = await updateRegistry(credential, (agents) => disconnect(agents, id), user);
      context.log(`Registry: disconnected ${result.id} by ${user}`);
      context.res = json(200, { ok: true, removed: result.id });
      return;
    }
    context.res = json(405, { message: 'Method not allowed' });
  } catch (e) {
    const status = e instanceof RegistryError ? e.status : 500;
    if (status >= 500) context.log.error('Registry request failed.', e);
    context.res = json(status, { message: status >= 500 && !(e instanceof RegistryError) ? 'The agent list could not be updated.' : e.message });
  }
};
