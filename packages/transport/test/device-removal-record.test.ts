import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deviceRemovalRecord } from '../src/deviceRemoval';
let stored = new Map<string, string>();
beforeEach(() => { stored = new Map(); vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) }); });
afterEach(() => vi.unstubAllGlobals());
it('keeps only public target/operation IDs, and reconciles absence without discarding the receipt', () => {
  const id = 'ab'.repeat(32), record = deviceRemovalRecord('production:wallet:inbox');
  record.ready(); record.reserve(id);
  expect(() => record.ready()).toThrow('unconfirmed');
  record.reconcile([id]); expect(() => record.ready()).toThrow('unconfirmed');
  record.reconcile([]); record.ready();
  const saved = JSON.parse([...stored.values()][0]); expect(saved.pending).toBeNull(); expect(saved.completed[0].id).toBe(id);
  expect(Object.keys(saved.completed[0]).sort()).toEqual(['id','operation']);
});
it.each(['invalid JSON', '{"version":1}', JSON.stringify({ version: 1, pending: null, completed: [], secret: 'must refuse' })])('holds malformed records: %s', value => {
  const record = deviceRemovalRecord('scope'); record.reserve('ab'.repeat(32)); const key = [...stored.keys()][0]; stored.set(key, value);
  expect(() => record.ready()).toThrow('unconfirmed');
});
it('keeps scopes separate and does not overwrite an unresolved target', () => {
  const a = deviceRemovalRecord('production:a:inbox'), b = deviceRemovalRecord('dev:a:inbox');
  a.reserve('ab'.repeat(32)); b.ready(); b.reserve('cd'.repeat(32));
  expect(() => a.reserve('ef'.repeat(32))).toThrow('unconfirmed'); expect(stored.size).toBe(2);
});
it('holds when receipt capacity is exhausted instead of pruning history', () => {
  const record = deviceRemovalRecord('scope');
  for (let i = 0; i < 32; i++) { record.reserve(i.toString(16).padStart(64,'0')); record.reconcile([]); }
  const before = [...stored.values()][0]; expect(() => record.reserve('ab'.repeat(32))).toThrow('unconfirmed');
  expect([...stored.values()][0]).toBe(before);
});
