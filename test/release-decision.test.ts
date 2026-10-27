import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/release-decision.sh", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));
const NAME = "@withautonomi/ant-browser-sdk";

// A repository like the one the workflow checks out: 0.1.2 tagged on main, and
// commits that set later versions, not yet on main unless a case puts them there.
let work: string;
let repo: string;
const commits: Record<string, string> = {};
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commitVersion = (version: string) => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: NAME, version }));
  git("add", "package.json");
  git("commit", "-q", "-m", version);
  return git("rev-parse", "HEAD");
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "release-decision-"));
  repo = join(work, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  // Independent of the developer's git configuration.
  for (const [key, value] of [["user.email", "test@example.invalid"], ["user.name", "Release decision test"],
    ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git("config", key!, value!);
  commits["0.1.2"] = commitVersion("0.1.2");
  git("tag", "v0.1.2");
  for (const version of ["0.1.3", "0.1.4-beta.1", "0.1.4-alpha.1"]) {
    git("checkout", "-q", "--detach", commits["0.1.2"]!);
    commits[version] = commitVersion(version);
  }
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

function decide(event: "push" | "workflow_dispatch", ref: { tag: string } | { branch: string }, version: string, main: string) {
  git("checkout", "-q", "--detach", commits[version]!);
  git("update-ref", "refs/remotes/origin/main", commits[main]!);
  const output = join(work, "github-output");
  writeFileSync(output, "");
  const run = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF_TYPE: "tag" in ref ? "tag" : "branch",
      GITHUB_REF_NAME: "tag" in ref ? ref.tag : ref.branch,
      GITHUB_SHA: commits[version]!,
      GITHUB_OUTPUT: output,
    },
  });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean)
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return { status: run.status, stdout: run.stdout, outputs };
}

describe("release decision", () => {
  it("publishes a version merged to main that has no tag yet", () => {
    const run = decide("push", { branch: "main" }, "0.1.3", "0.1.3");
    expect(run.status).toBe(0);
    expect(run.outputs).toEqual({ name: NAME, version: "0.1.3", tag: "v0.1.3", publish: "true", dist_tag: "latest" });
  });

  it("releases nothing for a push to main whose version is already tagged", () => {
    const run = decide("push", { branch: "main" }, "0.1.2", "0.1.2");
    expect(run.status).toBe(0);
    expect(run.outputs.publish).toBe("false");
    expect(run.stdout).toContain("v0.1.2 is already tagged");
  });

  it("publishes a pushed tag on main that matches package.json", () => {
    const run = decide("push", { tag: "v0.1.3" }, "0.1.3", "0.1.3");
    expect(run.status).toBe(0);
    expect(run.outputs.publish).toBe("true");
  });

  it("refuses a pushed tag that is not on main or does not match package.json", () => {
    const offMain = decide("push", { tag: "v0.1.3" }, "0.1.3", "0.1.2");
    expect(offMain.status).toBe(1);
    expect(offMain.stdout).toContain("Tag is not on main");
    const mismatch = decide("push", { tag: "v9.9.9" }, "0.1.3", "0.1.3");
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain("Tag does not match package.json");
  });

  it("never publishes from a manual run, on a branch or on a release tag", () => {
    for (const ref of [{ branch: "main" }, { tag: "v0.1.3" }]) {
      const run = decide("workflow_dispatch", ref, "0.1.3", "0.1.3");
      expect(run.status).toBe(0);
      expect(run.outputs.publish).toBe("false");
      expect(run.stdout).toContain("without publishing");
    }
  });

  it("sends a beta to its dist-tag and fails an unknown pre-release before publishing", () => {
    expect(decide("push", { branch: "main" }, "0.1.4-beta.1", "0.1.4-beta.1").outputs.dist_tag).toBe("beta");
    const unknown = decide("push", { branch: "main" }, "0.1.4-alpha.1", "0.1.4-alpha.1");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain("Unrecognised pre-release");
  });

  it("gates the publish job on a push as well", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const publishJob = workflow.slice(workflow.indexOf("\n  publish:\n"));
    expect(publishJob).toMatch(/\n {4}if: github\.event_name == 'push' && needs\.decide\.outputs\.publish == 'true'\n/u);
    expect(workflow).toContain("run: bash scripts/release-decision.sh");
  });
});
