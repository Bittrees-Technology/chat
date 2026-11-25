import type { Page } from '@playwright/test';
export async function openSettingsGroup(page: Page, group: 'data' | 'organizations') {
  await page.locator(`.settings-index a[href="#settings-${group}"]`).click();
}
