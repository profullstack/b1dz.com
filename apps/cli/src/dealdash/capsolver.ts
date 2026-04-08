/**
 * CapSolver client — solves reCAPTCHA challenges for the automated DealDash
 * login flow. Uses CAPSOLVER_API_KEY from .env, falls back to TWOCAPTCHA on
 * failure (TODO).
 *
 * Workflow:
 *   1. createTask() with site key + page url → returns task_id
 *   2. poll getTaskResult() until status === "ready"
 *   3. return gRecaptchaResponse token to caller
 */

const CAPSOLVER_BASE = 'https://api.capsolver.com';

interface CreateTaskResponse { errorId: number; errorCode?: string; errorDescription?: string; taskId?: string; }
interface GetResultResponse { errorId: number; status: 'idle' | 'processing' | 'ready'; solution?: { gRecaptchaResponse: string }; errorDescription?: string; }

export async function solveRecaptchaV2(opts: { siteKey: string; pageUrl: string }): Promise<string> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error('CAPSOLVER_API_KEY missing in .env');

  const create = await fetch(`${CAPSOLVER_BASE}/createTask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: opts.pageUrl,
        websiteKey: opts.siteKey,
      },
    }),
  });
  const created = (await create.json()) as CreateTaskResponse;
  if (created.errorId !== 0 || !created.taskId) {
    throw new Error(`capsolver createTask failed: ${created.errorCode} ${created.errorDescription}`);
  }

  console.log(`  capsolver task ${created.taskId} created, polling…`);
  // Poll up to ~120s
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId: created.taskId }),
    });
    const result = (await res.json()) as GetResultResponse;
    if (result.errorId !== 0) throw new Error(`capsolver: ${result.errorDescription}`);
    if (result.status === 'ready' && result.solution?.gRecaptchaResponse) {
      console.log(`  capsolver solved in ${(i + 1) * 2}s`);
      return result.solution.gRecaptchaResponse;
    }
    if (i % 5 === 4) console.log(`  capsolver still ${result.status}… (${(i + 1) * 2}s)`);
  }
  throw new Error('capsolver timed out after ~120s');
}
