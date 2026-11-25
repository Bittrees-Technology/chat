const HEX_ID = /^[a-f0-9]{64}$/;
const held = () => new Error('Device removal is unconfirmed. Refresh messaging devices before trying again.');
type Operation = { id: string; operation: string };
type Record = { version: 1; pending: Operation | null; completed: Operation[] };

/** Public IDs only. Retain uncertain submissions across reloads; never store signatures. */
export function deviceRemovalRecord(scope: string) {
  const key = `chirpy.xmtp.device-removal.v1.${scope}`;
  const read = (): Record => {
    let value: unknown;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return { version: 1, pending: null, completed: [] };
      if (raw.length > 16_384) throw held();
      value = JSON.parse(raw);
    } catch { throw held(); }
    const valid = (v: unknown): v is Operation => !!v && typeof v === 'object'
      && typeof (v as Operation).id === 'string' && HEX_ID.test((v as Operation).id)
      && typeof (v as Operation).operation === 'string' && /^[a-f0-9-]{36}$/.test((v as Operation).operation)
      && Object.keys(v).sort().join(',') === 'id,operation';
    const record = value as Record;
    if (!record || Object.keys(record).sort().join(',') !== 'completed,pending,version' || record.version !== 1 || !(record.pending === null || valid(record.pending))
      || !Array.isArray(record.completed) || record.completed.length > 32 || !record.completed.every(valid)) throw held();
    return record;
  };
  const write = (record: Record) => {
    try {
      const raw = JSON.stringify(record); localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw held();
    } catch { throw held(); }
  };
  return {
    reconcile(registered: string[]) {
      const record = read();
      if (record.pending && !registered.includes(record.pending.id)) {
        if (record.completed.length >= 32) throw held();
        write({ ...record, completed: [...record.completed, record.pending], pending: null });
      }
    },
    ready() { const record = read(); if (record.pending || record.completed.length >= 32) throw held(); },
    reserve(id: string) {
      if (!HEX_ID.test(id)) throw held();
      const record = read(); if (record.pending || record.completed.length >= 32) throw held();
      write({ ...record, pending: { id, operation: crypto.randomUUID() } });
    },
  };
}
