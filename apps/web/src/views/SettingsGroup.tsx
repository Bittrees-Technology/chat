import React, { useState, useEffect } from 'react';
import { useI18n } from '../i18n';

const groups = ['profile', 'preferences', 'messaging', 'data', 'organizations'] as const;
type Group = typeof groups[number];

/** Native disclosures keep drafts and pending operations mounted when collapsed. */
export function SettingsGroup({ id, initiallyOpen = false, attention = false, children }: {
  id: Group; initiallyOpen?: boolean; attention?: boolean; children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => { if (attention) setOpen(true); }, [attention]);
  return <details className="settings-group" id={`settings-${id}`} data-settings-group={id} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><h2>{t(`settings.groups.${id}.title`)}</h2><span className="muted">{t(`settings.groups.${id}.help`)}</span></summary>
    <div className="settings-group-body">{children}</div>
  </details>;
}

/** Jump links open the destination and move keyboard focus to its disclosure. */
export function SettingsIndex() {
  const { t } = useI18n();
  return <nav className="settings-index" aria-label={t('settings.navigation')}>
    {groups.map(group => <a key={group} href={`#settings-${group}`} onClick={event => {
      event.preventDefault();
      const target = document.getElementById(`settings-${group}`) as HTMLDetailsElement | null;
      if (target) {
        target.open = true;
        target.querySelector('summary')?.focus();
        target.scrollIntoView({ block: 'start' });
      }
    }}>{t(`settings.groups.${group}.title`)}</a>)}
  </nav>;
}
