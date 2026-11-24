import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';
it('enforces isolated gate installation and capacity boundaries without host mutations', () => {
  const result = execFileSync('python3', ['-I', fileURLToPath(new URL('../../scripts/test-isolated-gate-install.py', import.meta.url))], { encoding:'utf8', timeout:30000, maxBuffer:65536, stdio:['ignore','pipe','pipe'] });
  expect(result).toBeDefined();
});
