/** PR destination determines coverage; main and unknown events remain strict. */
export function coverageThreshold({ eventName, baseRef, ref }) {
  if (eventName === "pull_request") return baseRef === "staging" ? 50 : 100;
  if ((eventName === "push" || eventName === "workflow_dispatch") && ref === "refs/heads/staging") return 50;
  return 100;
}
