import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import fs from "fs/promises";
import path from 'path';
import lcovTotal from 'lcov-total';

const checkForLcovInfo = async (cwd) => {
  try {
    await fs.stat(path.resolve(cwd, "coverage", "lcov.info"));
    return true;
  } catch(e) {
    return false;
  }
}

const rootExclusive = async (root) => {
  const workspacePackages = core.getInput('PACKAGES', { required: true, trimWhitespace: true })?.split(/(?<!(?:$|[^\\])(?:\\\\)*?\\),/).map(item => item.replace("\\,", ","));

  const coverages = [];

  for (const workspacePackage of workspacePackages) {
    await fs.stat(process.cwd(), root, workspacePackage);
    const packageCwd = path.resolve(process.cwd(), root, workspacePackage);

    if (!await checkForLcovInfo(packageCwd)) {
      try {
        await fs.stat(path.resolve(process.cwd(), root, workspacePackage, ".nyc_output"));
        await exec.exec('npx nyc report', ["--reporter=lcovonly"], {cwd: path.resolve(process.cwd(), root, workspacePackage)});
      } catch(e) {}

      if (!await checkForLcovInfo(packageCwd)) {
        throw new Error("lcov.info not found");
      }
    }

    const totalCoverage = lcovTotal(path.resolve(packageCwd, "coverage", "lcov.info"), {type: "lcov"});
    coverages.push({ workspacePackage, coverageSummary: { totalCoverage } });
  }

  return coverages;
}

try {
  const token = core.getInput("GITHUB_TOKEN", { required: true, trimWhitespace: true });

  const root = core.getInput('ROOT', { required: true, trimWhitespace: true }) || ".";
  const coverages = await rootExclusive(root);
  
  const coverageBranch = core.getInput("COVERAGE_BRANCH", { required: false, trimWhitespace: true });
  if (coverageBranch !== "") {
    let originalBranch;
    let latestCommitId;

    await exec.exec("git branch", [], {
      listeners: {
        stdout: data => {
          let branches = data.toString();
          branches = branches.slice(branches.indexOf("* ") + 2);
          branches = branches.slice(0, branches.indexOf("\n"));
          originalBranch = branches;
        },
      }
    });

    await exec.exec("git rev-parse HEAD", [], {
      listeners: {
        stdout: data => {
          latestCommitId = data.toString().trim();
        },
      }
    });

    try {
      await exec.exec("git switch", [coverageBranch]);
    } catch(e) {
      await exec.exec("git switch", ["--orphan", coverageBranch]);
    }

    await io.mkdirP(path.resolve("old", latestCommitId)).catch(() => {});
    await io.rmRF(path.resolve("latest", "*")).catch(() => {});
    await io.mkdirP(path.resolve("latest")).catch(() => {});

    for (const {workspacePackage, coverageSummary}  of coverages) {
      await io.mkdirP(workspacePackage);
      await fs.writeFile(path.resolve("old", latestCommitId, workspacePackage + ".json"), JSON.stringify(coverageSummary, null, 2));
      await fs.writeFile(path.resolve("latest", workspacePackage + ".json"), JSON.stringify(coverageSummary, null, 2));

      await exec.exec("git add", [path.resolve("old", latestCommitId, workspacePackage + ".json")]);
      await exec.exec("git add", [path.resolve("latest", workspacePackage + ".json")]);
    }

    await exec.exec("git config", ["http.sslVerify", false]);
    await exec.exec("git config", ["--local", "user.email", "github-actions[bot]@users.noreply.github.com"]);
    await exec.exec("git config", ["--local", "user.name", "github-actions[bot]"]);

    await exec.exec("git commit", ["-m", "autogenerated coverage"]);

    await exec.exec("git push", [`https://${GITHUB_ACTOR}:${token}@github.com/${GITHUB_REPOSITORY}.git`]);

    await exec.exec("git switch", [originalBranch]);
  }

  core.setOutput("COVERAGE", JSON.stringify(coverages));
} catch (error) {
  console.log(error.stack);
  core.setFailed(error.message);
}
