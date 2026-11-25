import { test, expect } from './fixtures/wallet';

test('settings groups preserve drafts and navigation opens advanced tools without authorizing anything', async ({ page, walletAddress }, testInfo) => {
  expect(walletAddress).toMatch(/^0x/);
  let writes = 0;
  await page.route('**/api/profile**', route => {
    if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 403, json: {} }); }
    const url = new URL(route.request().url()), wallet = url.searchParams.get('wallet')!;
    return route.fulfill({ json: { service: new URL('/api/profile', url).href, profiles: [{ version: 1, wallet, revision: 0, label: null, updatedAt: 0 }] } });
  });
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('[data-settings-group="data"]')).not.toHaveAttribute('open');
  await expect(page.getByLabel('Restore passphrase', { exact: true })).not.toBeVisible();
  await page.getByText('Public name and linked wallets', { exact: true }).click();
  const publicName = page.getByRole('region', { name: 'Public profile', exact: true });
  await publicName.getByLabel('What to display in Chat').selectOption('name');
  await publicName.getByLabel('Public display name', { exact: true }).fill('Unpublished draft');
  await page.locator('[data-settings-group="profile"] > summary').click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Profile', exact: true }).click();
  await expect(publicName.getByLabel('Public display name', { exact: true })).toHaveValue('Unpublished draft');
  await expect(publicName.getByRole('checkbox')).not.toBeChecked();
  expect(writes).toBe(0);
  const dataLink = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Data & recovery', exact: true });
  await dataLink.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Restore passphrase', { exact: true })).toBeVisible();
  await expect(page.locator('[data-settings-group="data"] > summary')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Restore passphrase', { exact: true })).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.settings').evaluate(el => { el.scrollTop = 0; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-grouped-mobile.png') });
  expect(writes).toBe(0);
});
