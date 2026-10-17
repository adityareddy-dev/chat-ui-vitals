import { expect, test } from '@playwright/test';

test('MutationObserver records the first painted token', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#paint', { state: 'attached' });
  await page.evaluate(() => {
    window.__chatVitals.hang();
    window.__chatVitals.startPaint();
  });
  expect(await page.evaluate(() => window.__chatVitals.paintAttr())).toBeNull();
  await page.locator('#paint').evaluate((node) => {
    node.textContent = 'Hi';
  });
  await page.waitForFunction(() => window.__chatVitals.paintAttr() != null);
  const seconds = await page.evaluate(() => window.__chatVitals.paintAttr());
  expect(typeof seconds).toBe('number');
  expect(seconds).toBeGreaterThanOrEqual(0);
  const box = await page.locator('#paint').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
});

test('Long Animation Frames and Event Timing land on the open turn', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#slow');
  const supported = await page.evaluate(() => window.__chatVitals.supported());
  expect(supported).toContain('long-animation-frame');
  expect(supported).toContain('event');
  await page.evaluate(() => window.__chatVitals.hang());
  await page.click('#slow');
  await page.evaluate(() => window.__chatVitals.burnFrame());
  await page.waitForFunction(
    () => {
      const names = window.__chatVitals.frameEvents();
      return names.includes('gen_ai.ui.long_animation_frame') && names.includes('gen_ai.ui.event');
    },
    { timeout: 8_000 },
  );
});

test('useChat renders a streamed reply through withChatVitals', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#send');
  await page.click('#send');
  await expect(page.locator('#out')).toContainText('Hello from the chat', { timeout: 10_000 });
  await page.click('#up');
  await page.waitForFunction(() =>
    window.__chatVitals.logs().some((record) => record.eventName === 'gen_ai.evaluation.result'),
  );
  const score = await page.evaluate(
    () => window.__chatVitals.logs().find((record) => record.eventName === 'gen_ai.evaluation.result')?.attributes['gen_ai.evaluation.score.value'],
  );
  expect(score).toBe(1);
});

test('traceparent reaches an @ai-sdk/otel server span', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#root');
  const report = await page.evaluate(() => window.__chatVitals.otel());
  expect(report.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const traceId = report.traceparent?.slice(3, 35);
  const spanId = report.traceparent?.slice(36, 52);
  const child = report.spans.find((span) => span.traceId === traceId && span.parentSpanId === spanId);
  expect(child, JSON.stringify(report)).toBeTruthy();
});
