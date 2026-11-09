export type DeploymentContext = { deploy?: { context?: string; published?: boolean } };
// Trusted Netlify invocation metadata, not request headers or build-only env vars.
export function publishedProduction(context?: DeploymentContext) {
  return context?.deploy?.context === 'production' && context.deploy.published === true;
}
