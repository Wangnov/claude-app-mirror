const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "claude-app-mirror-cloudflare-cron";

export default {
  async scheduled(controller, env) {
    const result = await dispatchWorkflow(controller, env);
    console.log(JSON.stringify(result));
  },
};

async function dispatchWorkflow(controller, env) {
  const owner = env.GITHUB_OWNER || "Wangnov";
  const repo = env.GITHUB_REPO || "claude-app-mirror";
  const workflow = env.GITHUB_WORKFLOW || "mirror.yml";
  const ref = env.GITHUB_REF || "main";
  const forceRelease = env.GITHUB_FORCE_RELEASE || "false";

  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN secret is not configured.");
  }

  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: JSON.stringify({
      ref,
      inputs: {
        force_release: forceRelease,
      },
    }),
  });

  const result = {
    event: "github_workflow_dispatch",
    cron: controller.cron,
    owner,
    repo,
    workflow,
    ref,
    force_release: forceRelease,
    status: response.status,
    ok: response.ok,
    at: new Date().toISOString(),
  };

  if (!response.ok) {
    result.body = await response.text();
    console.error(JSON.stringify(result));
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}.`);
  }

  return result;
}
