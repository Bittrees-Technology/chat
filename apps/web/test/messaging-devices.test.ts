import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MessagingDevicesView } from '../src/views/MessagingDevices';
import { I18nProvider } from '../src/i18n';
const device = 'ab'.repeat(32);
function mount(inspect: () => Promise<any>, revoke?: (id: string) => Promise<void>) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  return { host, root, render: (key = 'a') => root.render(React.createElement(I18nProvider, null, React.createElement(MessagingDevicesView, { key, inspect, revoke, initiallyOpen: true }))) };
}
it('reads only on an explicit click, coalesces clicks, and discards a result after changing wallet scope', async () => {
  let finish!: (value: any) => void;
  const inspect = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const f = mount(inspect);
  try {
    await act(async () => f.render()); expect(inspect).not.toHaveBeenCalled();
    await act(async () => { f.host.querySelector('button')!.click(); f.host.querySelector('button')!.click(); });
    expect(inspect).toHaveBeenCalledOnce();
    await act(async () => f.render('wallet-b'));
    await act(async () => finish({ inboxId: 'old-wallet', localInstallationId: device, installations: [{ id: device, createdAtMs: null }] }));
    expect(f.host.querySelector('[role="status"]')).toBeNull(); expect(f.host.textContent).not.toContain(device);
  } finally { await act(async () => f.root.unmount()); }
});
it('shows device identity, clock limitations and unknown dates without offering removal or registration', async () => {
  const f = mount(vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: device, installations: [{ id: device, createdAtMs: null }] })));
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('Registered devices: 1'); expect(f.host.textContent).toContain('This browser');
    expect(f.host.textContent).toContain('do not show last activity'); expect(f.host.textContent).toContain('Date unavailable');
    expect(f.host.textContent).toContain(device); expect(f.host.querySelectorAll('button')).toHaveLength(1);
  } finally { await act(async () => f.root.unmount()); }
});
it('clears old results and hides provider diagnostics after a failed explicit refresh', async () => {
  const inspect = vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: null, installations: [{ id: device, createdAtMs: 1_790_000_000_000 }] }));
  const f = mount(inspect);
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain(device); expect(f.host.querySelector('time')).not.toBeNull();
    inspect.mockRejectedValueOnce(new Error('NEVER_INCLUDE_PRIVATE_PROVIDER_DETAILS'));
    await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.querySelector('[role="alert"]')).not.toBeNull(); expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(f.host.textContent).not.toContain(device); expect(f.host.textContent).not.toContain('NEVER_INCLUDE');
  } finally { await act(async () => f.root.unmount()); }
});
it('distinguishes an absent network inbox from a known local installation missing in its registered list', async () => {
  const inspect = vi.fn(async () => ({ inboxId: null as string | null, localInstallationId: null as string | null, installations: [] }));
  const f = mount(inspect);
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('No registered messaging inbox');
    inspect.mockResolvedValueOnce({ inboxId: 'cd'.repeat(32), localInstallationId: device, installations: [] });
    await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('not in the registered list'); expect(f.host.textContent).not.toContain('No registered messaging inbox');
  } finally { await act(async () => f.root.unmount()); }
});

it('explains an unopened local session without declaring its history lost', async () => {
  const f = mount(vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: null, installations: Array.from({ length: 10 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), createdAtMs: null })) })));
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('Registered devices: 10');
    expect(f.host.textContent).toContain('try reopening the saved session');
    expect(f.host.textContent).toContain('does not mean your history was deleted');
  } finally { await act(async () => f.root.unmount()); }
});

it('requires review of one full device ID and explicit acknowledgment before removal', async () => {
  const other = 'ef'.repeat(32);
  const inspect = vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: device, installations: [{ id: device, createdAtMs: null }, { id: other, createdAtMs: null }] }));
  const revoke = vi.fn(async (id: string) => {
    expect(id).toBe(other);
    inspect.mockResolvedValue({ inboxId: 'cd'.repeat(32), localInstallationId: device, installations: [{ id: device, createdAtMs: null }] });
  });
  const f = mount(inspect, revoke);
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    const reviews = [...f.host.querySelectorAll('button')].filter(b => b.textContent === 'Review removal');
    expect(reviews[0].disabled).toBe(true); expect(reviews[1].disabled).toBe(false);
    await act(async () => reviews[1].click());
    const fieldset = f.host.querySelector('fieldset')!;
    expect(fieldset.textContent).toContain(other); expect(fieldset.textContent).toContain('only the device ID');
    const confirm = [...fieldset.querySelectorAll('button')].find(b => b.textContent === 'Sign to remove this device')!;
    expect(confirm.disabled).toBe(true); await act(async () => confirm.click()); expect(revoke).not.toHaveBeenCalled();
    await act(async () => fieldset.querySelector('input')!.click());
    await act(async () => { confirm.click(); confirm.click(); });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(other);
    expect(f.host.textContent).toContain('Registered devices: 1'); expect(f.host.textContent).toContain(device);
    expect(f.host.textContent).toContain('No new session was registered');
  } finally { await act(async () => f.root.unmount()); }
});
it('does not remove anything when a review is cancelled', async () => {
  const revoke = vi.fn(); const f = mount(vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: null, installations: [{ id: device, createdAtMs: null }] })), revoke);
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    await act(async () => [...f.host.querySelectorAll('button')].find(b => b.textContent === 'Review removal')!.click());
    await act(async () => [...f.host.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.click());
    expect(f.host.querySelector('fieldset')).toBeNull(); expect(revoke).not.toHaveBeenCalled();
  } finally { await act(async () => f.root.unmount()); }
});
it('hides uncertain provider details and clears stale device choices after removal fails', async () => {
  const f = mount(vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: null, installations: [{ id: device, createdAtMs: null }] })), vi.fn(async () => { throw new Error('PRIVATE_PROVIDER_DETAILS'); }));
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    await act(async () => [...f.host.querySelectorAll('button')].find(b => b.textContent === 'Review removal')!.click());
    await act(async () => f.host.querySelector('input')!.click());
    await act(async () => [...f.host.querySelectorAll('button')].find(b => b.textContent === 'Sign to remove this device')!.click());
    expect(f.host.textContent).toContain('Device removal could not be confirmed');
    expect(f.host.textContent).not.toContain('PRIVATE_PROVIDER'); expect(f.host.querySelector('fieldset')).toBeNull();
  } finally { await act(async () => f.root.unmount()); }
});
