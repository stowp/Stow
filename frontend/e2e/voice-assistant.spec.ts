import { test, expect, type Page } from "@playwright/test";

/**
 * E2E acceptance test for the savings voice assistant.
 *
 * SpeechRecognition and speechSynthesis are stubbed in the page via
 * addInitScript, so no real microphone or speech engine is needed. The
 * test drives the stubbed recognition by calling the helpers we attach
 * to window (stowSpeak / stowFireResult / stowWakeWord).
 *
 * Acceptance criterion: say the wake word, say "check balance", assert the
 * displayed/announced balance; then a deposit flow with confirmation.
 *
 * NOTE: requires the Playwright browsers to be installed
 * (`pnpm exec playwright install chromium`). They are not present in every
 * CI/dev environment, so this spec is written but may be skipped there.
 */

declare global {
  interface Window {
    stowFireResult: (transcript: string) => void;
    stowSpeak: () => string | undefined;
    stowLastSpoken: () => string;
  }
}

/**
 * Installs fake SpeechRecognition + speechSynthesis on the page before any
 * app code runs. The fake records the last utterance spoken and lets the
 * test inject transcripts into the active recognition instance.
 */
async function stubSpeech(page: Page) {
  await page.addInitScript(() => {
    interface FakeRec {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      maxAlternatives: number;
      onresult: ((e: { results: Array<Array<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
      onerror: ((e: { error: string; message: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
      abort: () => void;
    }

    let activeRecognition: FakeRec | null = null;
    let lastSpoken = "";

    class FakeSpeechRecognition {
      lang = "en";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: FakeRec["onresult"] = null;
      onerror: FakeRec["onerror"] = null;
      onend: FakeRec["onend"] = null;
      start() {
        activeRecognition = this as unknown as FakeRec;
      }
      stop() {
        if (activeRecognition === (this as unknown as FakeRec)) activeRecognition = null;
      }
      abort() {
        this.stop();
      }
    }

    // @ts-expect-error – assigning to window's SpeechRecognition
    window.SpeechRecognition = FakeSpeechRecognition;
    // @ts-expect-error – webkit prefix
    window.webkitSpeechRecognition = FakeSpeechRecognition;

    // Fake speechSynthesis that records the last spoken text.
    // @ts-expect-error – installing a minimal synthesis
    window.speechSynthesis = {
      cancel() {},
      speak(u: { text: string }) {
        lastSpoken = u.text;
      },
      getVoices: () => [],
      pending: false,
      speaking: false,
      paused: false,
      pause() {},
      resume() {},
      onvoiceschanged: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    };
    // @ts-expect-error – SpeechSynthesisUtterance constructor
    window.SpeechSynthesisUtterance = class {
      text: string;
      lang = "";
      rate = 1;
      pitch = 1;
      constructor(text: string) {
        this.text = text;
      }
    };

    // Test helpers
    (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult = (transcript: string) => {
      const rec = activeRecognition;
      if (!rec || !rec.onresult) return;
      const result = [{ transcript, confidence: 1 }] as Array<{ transcript: string; confidence: number }> & { isFinal: boolean };
      result.isFinal = true;
      rec.onresult({ results: [result] });
    };
    (window as unknown as { stowLastSpoken: () => string }).stowLastSpoken = () => lastSpoken;
  });
}

test.describe("Voice assistant", () => {
  test.beforeEach(async ({ page }) => {
    await stubSpeech(page);
  });

  test("wake word then 'check balance' announces and displays the balance", async ({ page }) => {
    await page.goto("/voice-demo");

    // Start wake-word listening via the dedicated link.
    await page.getByRole("button", { name: /hey stow/i }).click();

    // Say the wake word.
    await page.evaluate(() => (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult("hey stow"));
    // Say the command.
    await page.evaluate(() => (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult("check balance"));

    // The visible feedback / live region should announce the balance.
    await expect(page.locator('[aria-live="polite"]')).toContainText(/100 USDC/i, { timeout: 5000 });

    // And speechSynthesis should have spoken it (accessibility mode is off).
    const spoken = await page.evaluate(() => (window as unknown as { stowLastSpoken: () => string }).stowLastSpoken());
    expect(spoken).toMatch(/100 USDC/i);
  });

  test("deposit flow requires confirmation and updates the balance", async ({ page }) => {
    await page.goto("/voice-demo");

    // Button-triggered listening (no wake word needed).
    await page.getByRole("button", { name: /start voice assistant/i }).click();

    // Say "deposit 25" — must NOT execute yet.
    await page.evaluate(() => (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult("deposit 25"));
    await expect(page.locator('[aria-live="polite"]')).toContainText(/deposit 25/i, { timeout: 5000 });
    // Balance unchanged before confirmation.
    await expect(page.getByTestId("demo-balance")).toHaveText(/Balance: 100 USDC/i);

    // Confirm.
    await page.evaluate(() => (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult("confirm"));
    await expect(page.getByTestId("demo-balance")).toHaveText(/Balance: 125 USDC/i, { timeout: 5000 });
  });

  test("cancel does not change the balance", async ({ page }) => {
    await page.goto("/voice-demo");

    await page.getByRole("button", { name: /start voice assistant/i }).click();
    await page.evaluate(() => (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult("deposit 50"));
    await expect(page.locator('[aria-live="polite"]')).toContainText(/deposit 50/i, { timeout: 5000 });

    await page.evaluate(() => (window as unknown as { stowFireResult: (t: string) => void }).stowFireResult("cancel"));
    await expect(page.locator('[aria-live="polite"]')).toContainText(/cancel/i, { timeout: 5000 });
    // Balance unchanged.
    await expect(page.getByTestId("demo-balance")).toHaveText(/Balance: 100 USDC/i);
  });
});
