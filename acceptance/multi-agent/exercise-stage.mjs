// Called only by browser-live.mjs exercise/reconnect after its fixed-port and
// process-ownership checks. All mutations happen through real GUI controls.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

export async function runExercise({ page, api, record, report, output, mode }) {
  const config = JSON.parse(await readFile(resolve(output, "exercise-config.json"), "utf8"));
  assert.match(config.runId, /^[a-zA-Z0-9_-]{1,32}$/, "Use an explicit short run ID.");
  assert.equal(config.allowModelTurns, true, "Root must explicitly enable model turns in the lab config.");
  assert.ok(config.remote?.cwd?.startsWith("/") && config.remote.cwd.includes("acceptance"),
    "Remote cwd must be an explicit absolute acceptance directory.");
  assert.ok(!config.remote.cwd.split("/").includes(".."));
  assert.ok(config.remote.target && config.remote.codex);
  const run = config.runId;
  const agents = [];
  const statePath = resolve(output, `exercise-${run}-state.json`);
  const saveState = () => writeFile(statePath, JSON.stringify({ runId: run, agents }, null, 2));

  const detail = id => api(`/api/agents/${encodeURIComponent(id)}`);
  async function wait(id, predicate, { timeout = 180_000, allowPending = false } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const current = await detail(id);
      if (predicate(current)) return current;
      const pending = current.pending.filter(value => !value.stale && !value.params._responseSent);
      if (!allowPending && pending.length) {
        record("unexpected-pending-left-unapproved", { agentId: id, pending: pending.map(({ id, method }) => ({ id, method })) });
        throw new Error("Unexpected permission/input request. No response was sent; inspect the lab request.");
      }
      if (current.agent.status === "error") throw new Error(current.agent.error || "Agent entered error state.");
      await delay(400);
    }
    throw new Error(`Timed out waiting for ${id}; no model request is retried automatically.`);
  }
  async function select(agent) {
    const row = page.locator(".agent-row").filter({ has: page.locator(".agent-name", { hasText: agent.name }) });
    await row.click();
    await page.getByRole("heading", { name: agent.name, exact: true }).waitFor();
  }
  async function send(agent, prompt) {
    await select(agent);
    await page.getByRole("textbox", { name: `Message ${agent.name}`, exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
  }

  if (mode === "reconnect") {
    assert.ok(config.reconnectAgentId, "reconnect requires the explicit existing lab Agent ID.");
    const before = await detail(config.reconnectAgentId);
    assert.equal(before.agent.remote?.machine?.target, config.remote.target);
    assert.equal(before.agent.cwd, config.remote.cwd);
    await select(before.agent);
    if (before.agent.connectionState === "connected") {
      record("automatic-reconnect-already-complete-manual-button-not-exercised", { agentId: before.agent.id });
      return;
    }
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    const after = await wait(before.agent.id, value => value.agent.connectionState === "connected", { allowPending: true });
    assert.equal(after.agent.threadId, before.agent.threadId);
    assert.equal(after.agent.remote?.runtime?.instanceId, before.agent.remote?.runtime?.instanceId);
    assert.equal(after.agent.reviewedSeq, before.agent.reviewedSeq);
    await page.screenshot({ path: resolve(output, `exercise-${run}-reconnected.png`), animations: "disabled" });
    record("gui-reconnect-same-agent-thread-runtime-read-state", { agentId: after.agent.id });
    return;
  }

  // A unique, explicitly chosen run ID prevents ambiguous automatic retries.
  const existing = (await api("/api/workspace")).agents;
  assert.ok(!existing.some(agent => agent.name.startsWith(`Lab ${run} `)),
    "Agents for this run already exist. Inspect its state; use a new run ID only for an intentional new run.");
  const specifications = [
    { suffix: "Local A", cwd: resolve(output, "tasks/local-alpha"), machineId: "local" },
    { suffix: "Local B", cwd: resolve(output, "tasks/local-beta"), machineId: "local" },
    { suffix: "Mac mini", cwd: config.remote.cwd, remote: true },
  ];
  for (const spec of specifications) {
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Where to work", { exact: true }).waitFor();
    if (spec.remote) {
      const machines = (await api("/api/machines")).machines;
      let machine = machines.find(value => value.kind === "ssh" && value.target === config.remote.target && value.defaultCwd === config.remote.cwd);
      if (!machine) {
        await dialog.getByRole("button", { name: "Add SSH machine", exact: true }).click();
        await dialog.getByLabel("Machine name", { exact: true }).fill(`Mac mini lab ${run}`);
        await dialog.getByLabel("SSH destination").fill(config.remote.target);
        await dialog.getByLabel("Default working folder", { exact: true }).fill(config.remote.cwd);
        await dialog.getByLabel("Codex executable").fill(config.remote.codex);
        await dialog.getByRole("button", { name: "Save machine", exact: true }).click();
        await dialog.getByRole("button", { name: "Test connection", exact: true }).waitFor();
        machine = (await api("/api/machines")).machines.find(value => value.name === `Mac mini lab ${run}`);
        assert.ok(machine);
        record("gui-register-remote-machine", { machineId: machine.id, target: machine.target });
      } else {
        await dialog.getByLabel("Where to work", { exact: true }).selectOption(machine.id);
        record("reuse-preconfigured-lab-machine", { machineId: machine.id });
      }
      await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
      await dialog.locator(".remote-check-success").waitFor({ timeout: 60_000 });
      record("gui-check-remote-machine", { machineId: machine.id });
    } else {
      await dialog.getByLabel("Where to work", { exact: true }).selectOption("local");
    }
    const name = `Lab ${run} ${spec.suffix}`;
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel(/^A lasting purpose/).fill("Bounded multi-agent acceptance. Work only in this task folder.");
    await dialog.getByLabel(/^Working folder/).fill(spec.cwd);
    if (config.model) {
      const field = dialog.getByLabel(/^Model/);
      if (await field.evaluate(element => element.tagName) === "SELECT")
        await field.selectOption(config.model);
      else await field.fill(config.model);
    }
    await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor({ timeout: 60_000 });
    const agent = (await api("/api/workspace")).agents.find(value => value.name === name);
    assert.ok(agent);
    agents.push(agent);
    await saveState();
    const ready = await wait(agent.id, current => current.agent.threadId && current.agent.connectionState === "connected");
    Object.assign(agent, ready.agent);
    assert.equal(Boolean(agent.remote), Boolean(spec.remote));
    if (spec.remote) await page.locator(".remote-controls").getByText("Connected", { exact: true }).waitFor();
    record("gui-created-real-agent", { agentId: agent.id, threadId: agent.threadId, agentName: name, machine: agent.remote?.machine?.name || "local" });
    await saveState();
  }

  // Three turns overlap. Prompts authorize only their isolated cwd, no network or installs.
  for (const [index, agent] of agents.entries()) {
    const marker = `YUZUNO_SLICE_${run}_${index}`;
    agent.acceptanceMarker = marker;
    const prompt = `Work only in your current folder ${agent.cwd}. Use a file editing tool to create report.md with exactly three lines: "# Acceptance report", "${marker}", and "done". Do not read or change other folders, install anything, use network, or start background work. Then reply with ${marker} and the exact Markdown link [report.md](report.md:2). This is the complete task.`;
    await send(agent, prompt);
    record("gui-sent-bounded-task", { agentId: agent.id, marker });
  }
  await saveState();
  for (const agent of agents) {
    const completed = await wait(agent.id, current => current.turns.some(turn => turn.status === "completed" && (turn.items || []).some(item => item.type === "agentMessage" && item.text?.includes(agent.acceptanceMarker))));
    const finalTurn = completed.turns.find(turn => turn.status === "completed" && turn.items.some(item => item.text?.includes(agent.acceptanceMarker)));
    await select(agent);
    const turnView = page.locator(`[data-turn-id="${finalTurn.id}"]`);
    await turnView.locator(".final-message").filter({ hasText: agent.acceptanceMarker }).waitFor();
    await turnView.locator('a[href$="report.md:2"]').first().click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('.source-line-highlight[data-line="2"]').waitFor();
    assert.match(await dialog.innerText(), new RegExp(agent.acceptanceMarker));
    await page.screenshot({ path: resolve(output, `exercise-${run}-${agent.remote ? "remote" : agent.name.endsWith("A") ? "local-a" : "local-b"}-artifact.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    assert.equal(completed.agent.reviewedSeq, agent.reviewedSeq, "Artifact preview must not mark the Agent reviewed.");
    record("gui-native-result-and-source-line-artifact", { agentId: agent.id, turnId: finalTurn.id, remote: Boolean(agent.remote) });
  }

  const remote = agents.find(agent => agent.remote);
  report.exerciseAgentIds = agents.map(agent => agent.id);
  await saveState();
  if (!config.exerciseControls) {
    await page.reload();
    await page.getByRole("heading", { name: remote.name, exact: true }).waitFor();
    const reopened = await detail(remote.id);
    assert.equal(reopened.agent.threadId, remote.threadId);
    record("gui-reload-preserves-real-workspace", { agentIds: report.exerciseAgentIds });
    record("controls-deferred-to-root", { reason: "exerciseControls is not enabled; no approval or interrupt turn was sent." });
    return;
  }
  const approvalMarker = `YUZUNO_APPROVAL_${run}`;
  const safeCommand = `/usr/bin/printf ${approvalMarker}`;
  const beforeApproval = await detail(remote.id);
  await send(remote, `This is a one-command approval UI acceptance. Work only in ${remote.cwd}. Run exactly ${safeCommand} using your command tool with sandbox_permissions=require_escalated so I can approve that harmless print once. Do not request a prefix rule or session-wide approval. Do not run any other commands, touch files, install packages or use network. After the command succeeds reply APPROVAL_DONE_${run}.`);
  const waiting = await wait(remote.id, current => current.pending.some(value => !value.stale && value.method === "item/commandExecution/requestApproval"), { allowPending: true });
  const requests = waiting.pending.filter(value => !value.stale && !value.params._responseSent);
  assert.equal(requests.length, 1, "Only the exact fixed acceptance request may be approved.");
  const pending = requests[0];
  assert.equal(pending.method, "item/commandExecution/requestApproval");
  assert.equal(pending.params.cwd, remote.cwd);
  const safeCommands = new Set([safeCommand]);
  for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"])
    for (const flag of ["-lc", "-c"])
      for (const quote of ["'", '"']) safeCommands.add(`${shell} ${flag} ${quote}${safeCommand}${quote}`);
  const supplied = pending.params.command;
  const commandMatches = typeof supplied === "string" ? safeCommands.has(supplied)
    : Array.isArray(supplied) && supplied.length === 3 &&
      ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(supplied[0]) &&
      ["-lc", "-c"].includes(supplied[1]) && supplied[2] === safeCommand;
  assert.ok(commandMatches, `Unexpected approval command left untouched: ${JSON.stringify(supplied)}`);
  const card = page.locator(`[id="request-${pending.id}"]`);
  await card.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, `exercise-${run}-approval.png`), animations: "disabled" });
  await card.getByRole("button", { name: "Allow once", exact: true }).click();
  const approved = await wait(remote.id, current => current.turns.some(turn => turn.status === "completed" && turn.items.some(item => item.text?.includes(`APPROVAL_DONE_${run}`))));
  assert.equal(approved.agent.reviewedSeq, beforeApproval.agent.reviewedSeq);
  record("gui-exact-harmless-command-allowed-once", { agentId: remote.id, requestId: pending.id, command: supplied });

  const priorTurnIds = new Set(approved.turns.map(turn => turn.id));
  await send(remote, `In your current acceptance folder, use your command tool to run exactly /bin/sleep 45 and then reply WAIT_DONE_${run}. This is an interrupt test. No files, network, other commands, or background work.`);
  const working = await wait(remote.id, current => current.turns.some(turn => !priorTurnIds.has(turn.id) && turn.status === "inProgress" && turn.items.some(item => item.type === "commandExecution")));
  const runningTurn = working.turns.find(turn => !priorTurnIds.has(turn.id) && turn.status === "inProgress");
  await page.locator(`[data-turn-id="${runningTurn.id}"] .turn-activity`).getByText("Working", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^Interrupt/ }).click();
  const interrupted = await wait(remote.id, current => current.turns.some(turn => turn.id === runningTurn.id && turn.status === "interrupted"), { timeout: 45_000 });
  assert.equal(interrupted.agent.threadId, remote.threadId);
  await page.locator(`[data-turn-id="${runningTurn.id}"] .turn-activity`).waitFor({ state: "detached" });
  await page.screenshot({ path: resolve(output, `exercise-${run}-interrupted.png`), animations: "disabled" });
  record("gui-remote-interrupt-preserves-native-thread", { agentId: remote.id, turnId: runningTurn.id, threadId: remote.threadId });

  await page.reload();
  await page.getByRole("heading", { name: remote.name, exact: true }).waitFor();
  const reopened = await detail(remote.id);
  assert.equal(reopened.agent.threadId, remote.threadId);
  assert.equal(reopened.turns.length, interrupted.turns.length);
  record("gui-reload-preserves-real-workspace", { agentIds: agents.map(agent => agent.id) });
  report.exerciseAgentIds = agents.map(agent => agent.id);
  await saveState();
}
