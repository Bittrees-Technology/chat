import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
const wallet = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
beforeEach(() => {
  vi.resetModules();
  const storage = new Map([['chirpy.xmtp.ready.' + wallet, '1']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const { XmtpTransport } = await import('../src/xmtp');
  const provider = { request: vi.fn(async (_request: { method: string }) => [wallet]) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const existing = { isRegistered: vi.fn(async () => true), close: vi.fn() };
  const created = { close: vi.fn() };
  const sdk = { IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 }, Client: {
    build: vi.fn(async () => existing), create: vi.fn(async () => created),
  } };
  Object.assign(transport, { loadSdk: async () => sdk, listConversations: vi.fn(async () => []),
    inspectMessagingDevices: vi.fn(async () => ({ inboxId: null, localInstallationId: null, installations: [] })) });
  return { transport, provider, existing, created, sdk };
}
it('reconnects a saved registered installation without registration or wallet signing', async () => {
  const f = await setup();
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.every(([args]) => (args as any).method === 'eth_accounts')).toBe(true);
  expect(f.provider.request).toHaveBeenCalledTimes(3);
  expect(f.existing.close).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('ready');
});
it('retries saved installation after transient startup failure without creating another', async () => {
  const f = await setup(); f.sdk.Client.build.mockRejectedValueOnce(new Error('temporary offline'));
  await f.transport.init();
  expect(f.transport.status).toBe('idle');
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledTimes(2);
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('ready');
});
it('holds an uncertain reconnect without registration, signing or revocation', async () => {
  const f = await setup(); f.sdk.Client.build.mockRejectedValue(new Error('temporary offline'));
  await expect(f.transport.enable()).rejects.toThrow('temporary offline');
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('error');
});
it('only registers after confirming that the local installation is unregistered', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(false);
  await f.transport.enable();
  expect(f.existing.close).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).toHaveBeenCalledOnce();
  expect(f.transport.status).toBe('ready');
});
it.each(['before', 'after'])('rejects a wallet change %s saved-installation lookup', async phase => {
  const f = await setup();
  if (phase === 'before') f.provider.request.mockResolvedValue([other]);
  else f.existing.isRegistered.mockImplementationOnce(async () => {
    f.provider.request.mockResolvedValue([other]); return true;
  });
  await expect(f.transport.enable()).rejects.toThrow('Wallet changed');
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  if (phase === 'before') expect(f.sdk.Client.build).not.toHaveBeenCalled();
  else expect(f.existing.close).toHaveBeenCalledOnce();
  expect(f.transport.status).toBe('error');
});
it('closes a candidate and holds an uncertain registration-state response', async () => {
  const f = await setup(); f.existing.isRegistered.mockRejectedValueOnce(new Error('lookup unavailable'));
  await expect(f.transport.enable()).rejects.toThrow('lookup unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('preserves explicit installation-revocation recovery instead of reopening the old client', async () => {
  const f = await setup(); const revoke = vi.fn(async () => 1);
  Object.assign(f.transport, { revokeStaleInstallations: revoke });
  await f.transport.enable({ revokeStale: true });
  expect(revoke).toHaveBeenCalledOnce(); expect(f.sdk.Client.build).not.toHaveBeenCalled();
  expect(f.sdk.Client.create).toHaveBeenCalledOnce();
});
it('keeps first-time enablement explicit when no saved installation was enabled', async () => {
  const f = await setup(); localStorage.removeItem('chirpy.xmtp.ready.' + wallet);
  await f.transport.init(); expect(f.sdk.Client.build).not.toHaveBeenCalled();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  f.existing.isRegistered.mockResolvedValue(false);
  await f.transport.enable(); expect(f.sdk.Client.build).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).toHaveBeenCalledOnce();
});

it('does not retain a client when the wallet changes during inbox loading', async () => {
  const f = await setup();
  Object.assign(f.transport, { listConversations: vi.fn(async () => {
    f.provider.request.mockResolvedValue([other]); return [];
  }) });
  await expect(f.transport.enable()).rejects.toThrow('Wallet changed');
  expect(f.existing.close).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect((f.transport as any).client).toBeNull();
});
it('holds malformed registration status instead of treating it as a missing installation', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(undefined as any);
  await expect(f.transport.enable()).rejects.toThrow('Unable to confirm');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('releases a failed saved client without replacing its identity or signing', async () => {
  const f = await setup(); Object.assign(f.transport, { listConversations: vi.fn(async () => { throw new Error('inbox unavailable'); }) });
  await expect(f.transport.enable()).rejects.toThrow('inbox unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect((f.transport as any).client).toBeNull(); expect(f.transport.status).toBe('error');
});

it('does not report success if inbox loading invalidates the saved installation', async () => {
  const f = await setup();
  Object.assign(f.transport, { listConversations: vi.fn(async () => {
    Object.assign(f.transport, { client: null, status: 'idle' }); return [];
  }) });
  await expect(f.transport.enable()).rejects.toThrow('saved messaging installation is unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('error');
});

it('reuses the already-open saved client when startup failed during inbox loading', async () => {
  const f = await setup();
  const list = vi.fn(async () => []); list.mockRejectedValueOnce(new Error('temporary inbox failure'));
  Object.assign(f.transport, { listConversations: list });
  await f.transport.init(); expect(f.transport.status).toBe('idle');
  f.sdk.Client.build.mockRejectedValueOnce(new Error('OPFS is already open'));
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledTimes(1);
  expect(f.sdk.Client.create).not.toHaveBeenCalled(); expect(f.transport.status).toBe('ready');
});
it('does not reuse a cached failed candidate on a later explicit reconnect', async () => {
  const f = await setup();
  const list = vi.fn(async () => []); list.mockRejectedValueOnce(new Error('temporary inbox failure'));
  Object.assign(f.transport, { listConversations: list }); await f.transport.init();
  f.existing.isRegistered.mockRejectedValueOnce(new Error('lookup unavailable'));
  await expect(f.transport.enable()).rejects.toThrow('lookup unavailable');
  expect(f.existing.close).toHaveBeenCalledOnce();
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledTimes(2); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});

it('recovers a registered database when its convenience flag is missing without signing or registration', async () => {
  const f = await setup(); localStorage.removeItem('chirpy.xmtp.ready.' + wallet);
  await f.transport.enable();
  expect(f.sdk.Client.build).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(localStorage.getItem('chirpy.xmtp.ready.' + wallet)).toBe('1');
  expect(f.transport.status).toBe('ready');
});
it('resumes an enabled saved installation through shared sign-in without an injected wallet', async () => {
  const f = await setup(); Object.assign(f.transport, { provider: null });
  await f.transport.init();
  expect(f.transport.status).toBe('ready'); expect(f.sdk.Client.build).toHaveBeenCalledOnce();
  expect(f.sdk.Client.create).not.toHaveBeenCalled(); expect(f.provider.request).not.toHaveBeenCalled();
});
it('explicitly resumes a saved installation without a wallet extension or convenience flag', async () => {
  const f = await setup(); Object.assign(f.transport, { provider: null }); localStorage.removeItem('chirpy.xmtp.ready.' + wallet);
  await f.transport.enable(); expect(f.transport.status).toBe('ready');
  expect(f.sdk.Client.create).not.toHaveBeenCalled(); expect(f.provider.request).not.toHaveBeenCalled();
});
it('never registers a new installation through shared sign-in alone', async () => {
  const f = await setup(); Object.assign(f.transport, { provider: null }); f.existing.isRegistered.mockResolvedValue(false);
  await expect(f.transport.enable()).rejects.toThrow('Connect a wallet');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('does not adopt a new or uncertain local installation during automatic resume', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(undefined as any);
  await f.transport.init(); expect(f.transport.status).toBe('idle');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('checks the device cap before requesting a new registration signature', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(false);
  const inspect = vi.fn(async () => ({ inboxId: 'ab'.repeat(32), localInstallationId: null, installations: Array(10).fill({ id: 'cd'.repeat(32) }) }));
  Object.assign(f.transport, { inspectMessagingDevices: inspect });
  await expect(f.transport.enable()).rejects.toMatchObject({ code: 'installation_limit' });
  expect(inspect).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.every(([args]) => args.method === 'eth_accounts')).toBe(true);
});
it('holds an uncertain device inventory before registration', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(false);
  Object.assign(f.transport, { inspectMessagingDevices: vi.fn(async () => { throw new Error('Device lookup unavailable'); }) });
  await expect(f.transport.enable()).rejects.toThrow('Device lookup unavailable');
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
});

it('automatically opens an existing store for a verified wallet when its convenience flag is missing', async () => {
  const f = await setup(); localStorage.removeItem('chirpy.xmtp.ready.' + wallet);
  await f.transport.init({ resumeSaved: true });
  expect(f.transport.status).toBe('ready'); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(localStorage.getItem('chirpy.xmtp.ready.' + wallet)).toBe('1');
});
it('does not open a private store for an explicitly unverified caller even when its flag exists', async () => {
  const f = await setup(); await f.transport.init({ resumeSaved: false });
  expect(f.sdk.Client.build).not.toHaveBeenCalled(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.transport.status).toBe('idle');
});
it('keeps a verified first-time store unregistered without requesting a signature', async () => {
  const f = await setup(); localStorage.removeItem('chirpy.xmtp.ready.' + wallet); f.existing.isRegistered.mockResolvedValue(false);
  await f.transport.init({ resumeSaved: true }); expect(f.transport.status).toBe('idle');
  expect(f.existing.close).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('serializes overlapping startup scopes instead of opening the same store twice', async () => {
  const first = await setup(), second = await setup();
  let release!: () => void;
  first.sdk.Client.build.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return first.existing; });
  const a = first.transport.init({ resumeSaved: true }); const b = second.transport.init({ resumeSaved: true });
  await vi.waitFor(() => expect(first.sdk.Client.build).toHaveBeenCalledOnce());
  expect(second.sdk.Client.build).not.toHaveBeenCalled(); release(); await Promise.all([a, b]);
  expect(first.transport.status).toBe('ready'); expect(second.transport.status).toBe('ready');
  expect(second.sdk.Client.build).not.toHaveBeenCalled();
  expect(first.sdk.Client.create).not.toHaveBeenCalled(); expect(second.sdk.Client.create).not.toHaveBeenCalled();
});
it('a saved-session-only retry never creates or revokes an installation even for an unregistered store', async () => {
  const f = await setup(); f.existing.isRegistered.mockResolvedValue(false);
  await expect(f.transport.enable({ resumeOnly: true })).rejects.toThrow('Existing devices were kept');
  expect(f.sdk.Client.create).not.toHaveBeenCalled(); expect(f.transport.inspectMessagingDevices).not.toHaveBeenCalled();
});
it('rejects a conflicting saved-session retry and revocation request before doing anything', async () => {
  const f = await setup();
  await expect(f.transport.enable({ resumeOnly: true, revokeStale: true })).rejects.toThrow('cannot revoke');
  expect(f.sdk.Client.build).not.toHaveBeenCalled(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('reports only fixed startup categories and public IDs after an opening failure', async () => {
  const f = await setup(); f.sdk.Client.build.mockRejectedValueOnce(new Error('OPFS lock unavailable NEVER_INCLUDE_SECRET'));
  await f.transport.init({ resumeSaved: true });
  const report = (f.transport as any).startupReport;
  expect(report).toEqual({ remembered: true, outcome: 'failed', phase: 'store', reason: 'storage' });
  expect(JSON.stringify(report)).not.toContain('NEVER_INCLUDE'); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});

it('does not reuse an open private client for an explicitly unverified scope', async () => {
  const first = await setup(); await first.transport.init({ resumeSaved: true });
  const next = await setup(); await next.transport.init({ resumeSaved: false });
  expect(next.transport.status).toBe('idle'); expect(next.sdk.Client.build).not.toHaveBeenCalled();
  expect((next.transport as any).client).toBeNull();
});
it('retains an open shared store after a transient later-scope inbox failure', async () => {
  const first = await setup(); await first.transport.init({ resumeSaved: true });
  const next = await setup(); const list = vi.fn(async () => []); list.mockRejectedValueOnce(new Error('temporary inbox error'));
  Object.assign(next.transport, { listConversations: list });
  await next.transport.init({ resumeSaved: true }); expect(next.transport.status).toBe('idle');
  await next.transport.enable({ resumeOnly: true });
  expect(next.transport.status).toBe('ready'); expect(next.sdk.Client.build).not.toHaveBeenCalled();
  expect(next.sdk.Client.create).not.toHaveBeenCalled(); expect(first.existing.close).not.toHaveBeenCalled();
});

it('a saved-only SDK load failure exposes a fixed error without provider details or signing', async () => {
  const f = await setup(); Object.assign(f.transport, { loadSdk: async () => { throw new Error('fetch failed NEVER_INCLUDE_PRIVATE_DETAILS'); } });
  await expect(f.transport.enable({ resumeOnly: true })).rejects.toThrow('Existing devices were kept');
  expect((f.transport as any).startupReport).toEqual({ remembered: true, outcome: 'failed', phase: 'sdk', reason: 'network' });
  expect(f.sdk.Client.create).not.toHaveBeenCalled(); expect(f.provider.request).not.toHaveBeenCalled();
});

it('releases messaging handles on a real page exit while preserving a back-forward cached session', async () => {
  const page = new EventTarget(); vi.stubGlobal('window', page);
  const f = await setup(); await f.transport.init({ resumeSaved: true });
  const cached = new Event('pagehide'); Object.defineProperty(cached, 'persisted', { value: true }); page.dispatchEvent(cached);
  expect(f.existing.close).not.toHaveBeenCalled();
  const leaving = new Event('pagehide'); Object.defineProperty(leaving, 'persisted', { value: false }); page.dispatchEvent(leaving);
  expect(f.existing.close).toHaveBeenCalledOnce();
  const next = await setup(); await next.transport.init({ resumeSaved: true });
  expect(next.sdk.Client.build).toHaveBeenCalledOnce(); expect(next.transport.status).toBe('ready');
});
