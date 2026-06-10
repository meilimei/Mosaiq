export const TRIAL_DAYS = 7;
export const TRIAL_MINUTES_CAP = 300;
export const TRIAL_SESSION_CAP = 1;
export const TRIAL_KEEPALIVE_CAP = 1;
export const TRIAL_SIGNUP_SOURCE = 'site:trial';

export interface TrialProjectQuotaSource {
  plan: string;
  trialExpiresAt: string | null;
  trialSessionCap: number | null;
  trialKeepAliveCap: number | null;
  trialMinutesCap: number | null;
}

export interface ProjectQuotaDefaults {
  SESSIONS_PER_PROJECT_MAX: number;
  KEEPALIVE_SESSIONS_PER_PROJECT_MAX: number;
  MINUTES_PER_PROJECT_PER_MONTH_MAX: number;
}

export function trialExpiresAtFromNow(nowMs = Date.now()): string {
  return new Date(nowMs + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function isTrialExpired(project: Pick<TrialProjectQuotaSource, 'plan' | 'trialExpiresAt'>, nowIso = new Date().toISOString()): boolean {
  return project.plan === 'trial' && (!project.trialExpiresAt || project.trialExpiresAt <= nowIso);
}

export function resolveProjectQuota(
  project: TrialProjectQuotaSource,
  env: ProjectQuotaDefaults,
): {
  isTrial: boolean;
  trialExpiresAt: string | null;
  sessionCap: number;
  keepAliveCap: number;
  minutesCap: number;
} {
  const isTrial = project.plan === 'trial';
  return {
    isTrial,
    trialExpiresAt: isTrial ? project.trialExpiresAt : null,
    sessionCap:
      isTrial && project.trialSessionCap !== null
        ? project.trialSessionCap
        : env.SESSIONS_PER_PROJECT_MAX,
    keepAliveCap:
      isTrial && project.trialKeepAliveCap !== null
        ? project.trialKeepAliveCap
        : env.KEEPALIVE_SESSIONS_PER_PROJECT_MAX,
    minutesCap:
      isTrial && project.trialMinutesCap !== null
        ? project.trialMinutesCap
        : env.MINUTES_PER_PROJECT_PER_MONTH_MAX,
  };
}
