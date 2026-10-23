export default async function run(page, ui) {
  const requests = [];
  const failures = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/')) {
      requests.push(`${r.status()} ${r.request().method()} ${new URL(u).pathname}`);
      if (r.status() >= 400) failures.push(`${r.status()} ${u}`);
    }
  });

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.waitForTimeout(4000);

  await page.getByRole('button', { name: /Chamada Manual/ }).first().click();
  await page.waitForTimeout(2000);

  const dom = await page.evaluate(() => ({
    studentCards: document.querySelectorAll('.student-card').length,
    names: Array.from(document.querySelectorAll('.student-card strong')).map((e) => e.textContent.trim()),
    apiError: document.querySelector('.error-card.form-msg')?.textContent?.trim() || '',
  }));

  await page.screenshot({ path: 'qa-db.png' });
  return { dom, requests: [...new Set(requests)], failures: [...new Set(failures)] };
}
