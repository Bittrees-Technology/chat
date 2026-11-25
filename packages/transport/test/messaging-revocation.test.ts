import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';

const wallet = '0x' + 'ab'.repeat(20), other = '0x' + 'cd'.repeat(20);
const inbox = '12'.repeat(32), alternate = '34'.repeat(32);
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

async function setup(address = wallet) {
  const { XmtpTransport } = await import('../src/xmtp');
  const accounts = { value: [address] };
  let onSign = () => {};
  const provider = { request: vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return accounts.value;
    if (method === 'personal_sign') { onSign(); return '0x1234'; }
    throw Error('Unexpected wallet request');
  }) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address }, provider);
  const backend = {};
  const state: any = { inboxId: inbox, accountIdentifiers: [{ identifier: address, identifierKind: 0 }],
    installations: [1, 2].map(byte => ({ id: byte.toString(16).padStart(2, '0').repeat(32), bytes: new Uint8Array(32).fill(byte) })) };
  const submitted = vi.fn();
  const sdk = { IdentifierKind: { Ethereum: 0 }, LogLevel: { Off: 0 },
    createBackend: vi.fn(async () => backend), getInboxIdForIdentifier: vi.fn(async () => inbox as string | undefined),
    generateInboxId: vi.fn(async () => alternate), Client: {
      fetchInboxStates: vi.fn(async () => [state]),
      revokeInstallations: vi.fn(async (signer: { signMessage: (text: string) => Promise<Uint8Array> }, ..._args: unknown[]) => {
        await signer.signMessage('Synthetic revocation request'); submitted();
      }),
      create: vi.fn(async () => ({ close: vi.fn() })), build: vi.fn(),
    } };
  Object.assign(transport, { loadSdk: async () => sdk, listConversations: vi.fn(async () => []) });
  return { transport, accounts, provider, backend, state, sdk, submitted, onSign: (fn: () => void) => { onSign = fn; } };
}

function noAuthorization(f: Awaited<ReturnType<typeof setup>>) {
  expect(f.sdk.generateInboxId).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.some(([a]) => a.method === 'personal_sign')).toBe(false);
  expect(f.sdk.Client.revokeInstallations).not.toHaveBeenCalled();
  expect(f.sdk.Client.create).not.toHaveBeenCalled();
  expect(f.submitted).not.toHaveBeenCalled();
}

it('only submits the verified network inbox and validated device IDs after wallet approval', async () => {
  const f = await setup();
  await f.transport.enable({ revokeStale: true });
  expect(f.sdk.generateInboxId).not.toHaveBeenCalled();
  expect(f.sdk.Client.revokeInstallations).toHaveBeenCalledOnce();
  expect(f.sdk.Client.revokeInstallations.mock.calls[0]?.slice(1, 3)).toEqual([inbox,
    [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]]);
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'missing'])('never derives a replacement inbox after a %s lookup', async reason => {
  const f = await setup();
  if (reason === 'unavailable') f.sdk.getInboxIdForIdentifier.mockRejectedValue(new Error('network unavailable'));
  else f.sdk.getInboxIdForIdentifier.mockResolvedValue(undefined);
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow();
  expect(f.sdk.Client.fetchInboxStates).not.toHaveBeenCalled(); noAuthorization(f);
});

it.each(['wallet', 'inbox', 'device', 'duplicate'])('refuses unbound or malformed %s metadata before signing', async problem => {
  const f = await setup();
  if (problem === 'wallet') f.state.accountIdentifiers = [{ identifier: other, identifierKind: 0 }];
  if (problem === 'inbox') f.state.inboxId = alternate;
  if (problem === 'device') f.state.installations[0].bytes = new Uint8Array(31);
  if (problem === 'duplicate') f.state.installations[1] = f.state.installations[0];
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow(); noAuthorization(f);
});

it('stops when the wallet changes while the device list loads', async () => {
  const f = await setup();
  f.sdk.Client.fetchInboxStates.mockImplementationOnce(async () => { f.accounts.value = [other]; return [f.state]; });
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow('Wallet changed'); noAuthorization(f);
});

it.each(['wallet', 'inbox'])('does not submit a signature or register when the %s changes during approval', async change => {
  const f = await setup();
  f.onSign(() => {
    if (change === 'wallet') f.accounts.value = [other];
    else f.sdk.getInboxIdForIdentifier.mockResolvedValue(alternate);
  });
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow();
  expect(f.sdk.generateInboxId).not.toHaveBeenCalled();
  expect(f.submitted).not.toHaveBeenCalled(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});

it('preserves a submitted revocation without registering after a later wallet change', async () => {
  const f = await setup();
  f.sdk.Client.revokeInstallations.mockImplementationOnce(async signer => {
    await signer.signMessage('Synthetic revocation request'); f.submitted(); f.accounts.value = [other];
  });
  await expect(f.transport.enable({ revokeStale: true })).rejects.toThrow('Device recovery was submitted');
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});

function singleDeviceStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_key: string, _options: unknown, run: (lock: object | null) => Promise<void>) => run({})) } });
  return data;
}
it('removes exactly the selected installation and never registers or revokes another', async () => {
  singleDeviceStorage(); const f = await setup(); const selected = '02'.repeat(32);
  f.sdk.Client.revokeInstallations.mockImplementationOnce(async (signer, _inbox, ids: Uint8Array[]) => {
    await signer.signMessage('Synthetic selected-device removal'); f.submitted();
    f.state.installations = f.state.installations.filter((i: any) => i.id !== selected);
  });
  await f.transport.revokeMessagingDevice(selected);
  expect(f.sdk.Client.revokeInstallations.mock.calls[0]?.slice(1, 3)).toEqual([inbox, [new Uint8Array(32).fill(2)]]);
  expect(f.state.installations.map((i: any) => i.id)).toEqual(['01'.repeat(32)]);
  expect(f.sdk.Client.create).not.toHaveBeenCalled(); expect(f.sdk.Client.build).not.toHaveBeenCalled();
});
it.each(['invalid', 'missing', 'current'])('holds an %s single-device selection before signing', async reason => {
  singleDeviceStorage(); const f = await setup();
  if (reason === 'current') Object.assign(f.transport, { client: { installationId: '01'.repeat(32) } });
  await expect(f.transport.revokeMessagingDevice(reason === 'invalid' ? 'bad' : reason === 'missing' ? '03'.repeat(32) : '01'.repeat(32))).rejects.toThrow();
  noAuthorization(f);
});
it('holds a submitted but uncertain removal across a fresh transport without replaying it', async () => {
  const data = singleDeviceStorage(); const f = await setup();
  f.sdk.Client.revokeInstallations.mockImplementationOnce(async signer => { await signer.signMessage('Synthetic uncertain removal'); throw new Error('Network uncertainty'); });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('unconfirmed');
  expect(JSON.parse([...data.values()][0]).pending.id).toBe('02'.repeat(32));
  const next = await setup();
  await expect(next.transport.revokeMessagingDevice('01'.repeat(32))).rejects.toThrow('unconfirmed');
  noAuthorization(next);
});
it('does not leave a submission record or mutate access when wallet approval is cancelled', async () => {
  const data = singleDeviceStorage(); const f = await setup();
  f.provider.request.mockImplementation(async ({ method }) => { if (method === 'eth_accounts') return [wallet]; throw new Error('Wallet rejected request'); });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('rejected');
  expect(data.size).toBe(0); expect(f.submitted).not.toHaveBeenCalled();
});
it('withholds an approved signature when durable intent cannot be saved', async () => {
  singleDeviceStorage(); const f = await setup();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('Quota'); } });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('unconfirmed');
  expect(f.submitted).not.toHaveBeenCalled(); expect(f.sdk.Client.create).not.toHaveBeenCalled();
});
it('reconciles an uncertain removal only after its public installation disappears', async () => {
  const data = singleDeviceStorage(); const f = await setup();
  f.sdk.Client.revokeInstallations.mockImplementationOnce(async signer => { await signer.signMessage('Synthetic uncertain removal'); throw new Error('Network uncertainty'); });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('unconfirmed');
  f.state.installations = [f.state.installations[0]];
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('no longer registered');
  const record = JSON.parse([...data.values()][0]); expect(record.pending).toBeNull(); expect(record.completed).toHaveLength(1);
  expect(f.sdk.Client.revokeInstallations).toHaveBeenCalledOnce();
});
it('does not sign or mutate if another tab owns the device-removal lock', async () => {
  singleDeviceStorage(); const f = await setup();
  vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, run: (lock: null) => Promise<void>) => run(null) } });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('another tab'); noAuthorization(f);
});
it('fails closed when safe cross-tab coordination is unavailable', async () => {
  singleDeviceStorage(); const f = await setup(); vi.stubGlobal('navigator', {});
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('cannot safely coordinate'); noAuthorization(f);
});

it.each(['current', 'gone'])('withholds the signature if the selected device becomes %s during approval', async change => {
  const data = singleDeviceStorage(); const f = await setup();
  f.onSign(() => {
    if (change === 'current') Object.assign(f.transport, { client: { installationId: '02'.repeat(32) } });
    else f.state.installations = [f.state.installations[0]];
  });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('selection changed');
  expect(f.submitted).not.toHaveBeenCalled(); expect(data.size).toBe(0);
});

it('holds the same pending inbox removal after switching to another linked wallet', async () => {
  singleDeviceStorage(); const f = await setup();
  f.sdk.Client.revokeInstallations.mockImplementationOnce(async signer => { await signer.signMessage('Synthetic uncertain removal'); throw new Error('Network uncertainty'); });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('unconfirmed');
  const linked = await setup(other);
  await expect(linked.transport.revokeMessagingDevice('01'.repeat(32))).rejects.toThrow('unconfirmed');
  noAuthorization(linked);
});
it('refuses an inbox change between metadata selection and acquiring its removal guard', async () => {
  singleDeviceStorage(); const f = await setup();
  const inspect = f.transport.inspectMessagingDevices.bind(f.transport);
  let reads = 0;
  Object.assign(f.transport, { inspectMessagingDevices: async () => {
    const result = await inspect();
    if (++reads === 1) { f.state.inboxId = alternate; f.sdk.getInboxIdForIdentifier.mockResolvedValue(alternate); }
    return result;
  } });
  await expect(f.transport.revokeMessagingDevice('02'.repeat(32))).rejects.toThrow('binding changed');
  noAuthorization(f);
});
