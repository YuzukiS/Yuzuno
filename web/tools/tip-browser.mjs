// The app's one tooltip (web/src/Tip.tsx, YN-44) in a Chromium check: what a
// trigger's tip says, read the way a pointer resting on it opens it. Its
// lines are joined by "\n", as a native title's were before.

/** The lines of the tip showing now, joined by "\n", or null. */
export const shownTipText = (page) =>
  page.evaluate(() => {
    const tip = document.querySelector('.tip[role="tooltip"]');
    return tip ? [...tip.children].map((c) => c.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") : null;
  });

/**
 * Rests the mouse on `locator` and returns what its tip says, or null when
 * none opens within `wait` ms (a name shown whole, under `cut`). The mouse
 * leaves again, and the moment in which the next tip would open at once
 * (TIP_SKIP_MS) is waited out first.
 */
export async function tipText(page, locator, { wait = 1500 } = {}) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(500);
  await locator.hover();
  const deadline = Date.now() + wait;
  let said = null;
  while (Date.now() < deadline && said === null) {
    await page.waitForTimeout(100);
    said = await shownTipText(page);
  }
  await page.mouse.move(1, 1);
  await page.waitForTimeout(450);
  return said;
}

