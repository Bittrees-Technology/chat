import React, { useEffect, useRef, useState } from 'react';
import type { MessagingDevices } from '@app/transport';
import { useI18n } from '../i18n';

export function MessagingDevicesView({ inspect, revoke, initiallyOpen = false }: {
  inspect: () => Promise<MessagingDevices>; revoke?: (id: string) => Promise<void>; initiallyOpen?: boolean;
}) {
  const { t, lang } = useI18n();
  const [result, setResult] = useState<MessagingDevices | null>(null);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const active = useRef(true); const pending = useRef(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [removalState, setRemovalState] = useState<'none' | 'success' | 'unconfirmed'>('none');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false); setResult(null); setSelection(null); setAcknowledged(false);
    try { const value = await inspect(); if (active.current) setResult(value); }
    catch { if (active.current) setFailed(true); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const remove = async () => {
    if (pending.current || !revoke || !selection || !acknowledged) return;
    pending.current = true; setBusy(true); setRemovalState('none');
    const target = selection;
    try {
      await revoke(target);
      if (!active.current) return;
      const next = await inspect();
      if (active.current) { setResult(next); setSelection(null); setAcknowledged(false); setRemovalState('success'); }
    } catch {
      if (active.current) { setResult(null); setSelection(null); setAcknowledged(false); setRemovalState('unconfirmed'); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return <details id="messaging-devices" className="card" open={initiallyOpen || selection !== null || removalState !== 'none'}>
    <summary>{t('settings.messagingDevices')}</summary>
    <p className="muted">{t('settings.messagingDevicesHelp')}</p>
    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { void run(); }}>
      {t(busy ? 'settings.devicesReading' : 'settings.devicesRead')}
    </button>
    {failed && <p role="alert">{t('settings.devicesFailed')}</p>}
    {removalState !== 'none' && <p role={removalState === 'success' ? 'status' : 'alert'}>{t(removalState === 'success' ? 'settings.deviceRemoved' : 'settings.deviceRemovalUnconfirmed')}</p>}
    {result && <div>
      {!result.inboxId ? <p role="status">{t('settings.devicesNoInbox')}</p> : <>
        <p role="status">{t('settings.devicesCount', undefined, { count: result.installations.length })}</p>
        <p className="muted">{t('settings.devicesDates')}</p>
        {revoke && <p>{t('settings.deviceRemovalHelp')}</p>}
        {!result.localInstallationId && <p>{t('settings.devicesLocalUnknown')}</p>}
        {result.localInstallationId && !result.installations.some(i => i.id === result.localInstallationId) && <p>{t('settings.devicesLocalMissing')}</p>}
        {!result.installations.length && <p>{t('settings.devicesEmpty')}</p>}
        <ul>
          {result.installations.map((device, index) => <li key={device.id} style={{ marginBlock: '0.75rem' }}>
            <strong>{t('settings.deviceNumber', undefined, { count: index + 1 })}</strong>
            {device.id === result.localInstallationId && <> · {t('settings.deviceThisBrowser')}</>}
            <div>{t('settings.deviceCreated')} {device.createdAtMs === null ? t('settings.deviceDateUnknown') :
              <time dateTime={new Date(device.createdAtMs).toISOString()}>{new Date(device.createdAtMs).toLocaleString(lang)}</time>}</div>
            <details><summary>{t('settings.deviceId')} · {device.id.slice(0, 8)}…{device.id.slice(-8)}</summary>
              <code style={{ overflowWrap: 'anywhere' }}>{device.id}</code>
            </details>
            {revoke && <button className="btn btn-ghost btn-sm" disabled={busy || device.id === result.localInstallationId}
              aria-expanded={selection === device.id} aria-controls={`remove-${device.id}`}
              onClick={() => { setSelection(device.id); setAcknowledged(false); setRemovalState('none'); }}>{t('settings.deviceRemoveReview')}</button>}
            {revoke && selection === device.id && <fieldset id={`remove-${device.id}`}>
              <legend>{t('settings.deviceRemoveTitle')}</legend>
              <p>{t('settings.deviceRemoveEffect')}</p>
              <code style={{ overflowWrap: 'anywhere' }}>{device.id}</code>
              <label><input type="checkbox" checked={acknowledged} disabled={busy}
                onChange={event => setAcknowledged(event.currentTarget.checked)} />{t('settings.deviceRemoveAcknowledge')}</label>
              <div className="modal-actions">
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setSelection(null); setAcknowledged(false); }}>{t('settings.cancel')}</button>
                <button className="btn btn-sm" disabled={busy || !acknowledged} onClick={() => { void remove(); }}>{t('settings.deviceRemoveConfirm')}</button>
              </div>
            </fieldset>}
          </li>)}
        </ul>
      </>}
    </div>}
  </details>;
}
