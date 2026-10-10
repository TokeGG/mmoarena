/**
 * The GitHub routes a dev commit uses to land: its branch, its pull request, the checks on it, the merge. A fake GitHub
 * answers these with the checks it is given (all passing unless `checks` says otherwise) and returns undefined for the rest.
 */
export interface CheckRun { name: string; status: string; conclusion: string | null }

export const PASSING: CheckRun[] = [{ name: 'check', status: 'completed', conclusion: 'success' }];

export function landingRoute(url: string, method: string, ok: (b: unknown) => Response, checks: CheckRun[] = PASSING): Response | undefined {
  if (method === 'POST' && url.endsWith('/git/refs')) return ok({});
  if (method === 'POST' && url.endsWith('/pulls')) return ok({ number: 7, html_url: 'https://github.com/TokeGG/mmoarena/pull/7' });
  if (method === 'GET' && url.endsWith('/pulls/7')) return ok({ head: { sha: 'pr-head' } });
  if (method === 'GET' && url.includes('/check-runs')) return ok({ check_runs: checks });
  if (method === 'PUT' && url.endsWith('/pulls/7/merge')) return ok({ merged: true });
  if (method === 'DELETE' && url.includes('/git/refs/heads/')) return ok({});
  if (method === 'POST' && url.endsWith('/issues/7/comments')) return ok({});
  return undefined;
}
