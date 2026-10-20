/* Browser state, HTTP requests, and SSE display. No research logic here. */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let currentSession = null;
let currentView = "plan";
let busy = false;
let toastTimer;
let selectedFiles = [];
let draftSession = null;
let selectedMode = "research";
let downloading = false;
const approvedOutcomes = new Set([
  "student_approved", "student_approved_with_unresolved_reviews",
]);
const previews = new Map();
const sessionBase = (mode = currentSession?.mode || selectedMode) =>
  `/api/${mode}/sessions`;
const readable = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
function planText(plan) {
  if (!plan || typeof plan === "string") return plan || "";
  const sections = (plan.sections || []).map((name, index) =>
    `${index + 1}. ${name}`).join("\n");
  const tasks = (plan.tasks || []).map((task) =>
    `${task.task_id} · ${task.section}\n${task.research_question}` +
    (task.depends_on?.length
      ? `\nAfter: ${task.depends_on.join(", ")}` : "")).join("\n\n");
  return [plan.rationale, sections, tasks,
    plan.missing_information?.length
      ? "Missing information: " + plan.missing_information.join("; ") : ""]
    .filter(Boolean).join("\n\n");
}

function criticText(review) {
  if (!review || typeof review === "string") return review || "";
  return [review.decision, review.reasoning,
    ...(review.issues || []), ...(review.suggested_changes || [])]
    .filter(Boolean).join("\n\n");
}

const draftText = (state) => state.assembled_draft || state.draft || "";

function showMode(mode) {
  selectedMode = mode;
  $(".demo-notice").textContent = mode === "demo" ? "Demo" : "Research";
  $(".demo-notice").title = mode === "demo"
    ? "Scripted demo. No model API calls."
    : "Real research with your PDFs and configured models.";
  $(".setup-note").textContent = mode === "demo"
    ? window.thesisDemoRequest
      ? "Scripted demo · no AI or PDF processing. Sessions stay in this browser."
      : "Demo: PDFs are saved locally, not indexed."
    : "Research uses your PDFs and configured model APIs.";
}

function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 5000);
}

function updateDownload() {
  const available = currentSession?.mode === "research" &&
    Boolean(currentSession.state?.assembled_draft);
  $("#download-report").hidden = !available;
  $("#download-report").disabled = busy || downloading ||
    Boolean(currentSession?.running);
  $("#download-report").textContent = downloading ? "Downloading…"
    : approvedOutcomes.has(currentSession?.state?.outcome)
      ? "Download report" : "Download draft";
}

function updateInput() {
  updateDownload();
  const allowed = !busy && Boolean(currentSession?.review);
  $("#feedback").disabled = !allowed;
  $("#send-feedback").disabled = !allowed;
  $("#feedback").placeholder = busy
    ? "Working…"
    : allowed
      ? "Write your feedback…"
      : currentSession?.state?.outcome
        ? "Session ended."
        : "Wait for a review to send feedback…";
}

function setBusy(value) {
  busy = value;
  $$(
    "#research-form button, #research-form input, #research-form textarea, " +
      "#run-mode, " +
      "[form='review-form'], [data-new-session], .session-card, " +
      "#resume-session, #open-sessions",
  ).forEach((element) => {
    element.disabled = value;
  });
  $("#run-status").textContent = value ? "Working…" : "Ready";
  updateInput();
}

function showSetup() {
  if (busy) return;
  currentSession = null;
  draftSession = null;
  selectedFiles = [];
  $("#research-form").reset();
  showMode($("#run-mode").value);
  renderFiles();
  $("#setup-screen").hidden = false;
  $("#run-screen").hidden = true;
  $("#open-document").hidden = true;
  const url = new URL(location.href);
  url.searchParams.delete("session");
  url.searchParams.delete("mode");
  history.replaceState(null, "", url);
}

function followConversation(update) {
  const pane = $("#chat-scroll");
  const nearBottom =
    pane.scrollHeight - pane.scrollTop - pane.clientHeight < 90;
  update();
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
}

function showDocument(view) {
  currentView = view;
  $$("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const state = currentSession?.state || {};
  $("#document-heading").textContent = {
    plan: "Plan",
    draft: "Draft",
    sources: "Files",
  }[view];
  $("#document-text").textContent = {
    plan: planText(state.plan) || "No plan yet.",
    draft: draftText(state) || "No draft yet.",
    sources: currentSession?.files?.length
      ? currentSession.files.map((file) => file.name).join("\n") +
        (currentSession.mode === "research"
          ? "\n\nSources for this research session."
          : "\n\nSaved locally. Not indexed in this demo.")
      : "No files attached.",
  }[view];
}

function renderSession(session) {
  if (currentSession?.id !== session.id) {
    previews.clear();
    $("#model-output").replaceChildren();
    $("#model-previews").hidden = true;
    $("#workflow-progress").hidden = true;
  }
  currentSession = session;
  showMode(session.mode || "demo");
  $("#setup-screen").hidden = true;
  $("#run-screen").hidden = false;
  $("#open-document").hidden = false;
  const url = new URL(location.href);
  url.searchParams.set("session", session.id);
  url.searchParams.set("mode", selectedMode);
  history.replaceState(null, "", url);
  for (const [node, field] of Object.entries({
    planner: "plan",
    critic: "critic_text",
    worker: "draft",
  })) {
    const agent = $(`[data-agent="${node}"]`);
    const state = session.state || {};
    const text = node === "worker" ? draftText(state)
      : node === "critic"
        ? criticText(state.critic_review || state.critic_text)
        : planText(state[field]);
    agent.hidden = !text;
    agent.dataset.status = text ? "finished" : "waiting";
    agent.querySelector(".agent-status").textContent = "";
    agent.querySelector(".agent-text").textContent = text ? readable(text) : "";
  }
  localStorage.setItem("thesis-demo-session", session.id);
  $("#project-name").textContent = session.title;
  const feedback = session.state?.student_feedback ||
    session.state?.feedback || "";
  $("#revision-message").hidden = !feedback;
  $("#revision-text").textContent = feedback;
  $("#review-summary").hidden = false;
  $("#decision-actions").hidden = !session.review;
  const realReview = session.mode === "research" && session.review;
  const savedReview = session.mode === "research" &&
    session.state?.assembled_draft ? {
      planner: session.state.planner_review,
      critic: session.state.critic_review,
      claim_audit: session.state.claim_audit,
      requirements_review: session.state.requirements_review,
    } : null;
  $("#review-details").hidden = !(realReview || savedReview);
  $("#review-content").textContent = readable(
    session.review || savedReview || "",
  );
  const unresolved = realReview && (
    session.review.critic_position?.decision !== "approved" ||
    session.review.planner_position?.decision === "revise" ||
    session.review.claim_audit?.passed === false ||
    session.review.requirements_review?.passed === false
  );
  const approvedWithIssues = session.state?.outcome ===
    "student_approved_with_unresolved_reviews";
  $("#review-warning").hidden = !(unresolved || approvedWithIssues);
  $("#review-warning").textContent = approvedWithIssues
    ? "Approved with unresolved review findings."
    : "Unresolved findings: read the review before approving.";
  $("#review-details").open = Boolean(unresolved);
  $("#resume-session").hidden = Boolean(
    session.review || session.state?.outcome,
  );
  if (session.review) {
    const planning = session.review.stage === "planning";
    $("#review-state").textContent = planning
      ? "Approve this plan?"
      : "Approve this draft?";
    $("#run-status").textContent = "Waiting for your review";
    $("#approve-decision").textContent = planning
      ? "Approve plan"
      : "Approve draft";
    showDocument(planning ? "plan" : "draft");
  } else if (session.state?.outcome) {
    const approved = ["demo_approved", "student_approved",
      "student_approved_with_unresolved_reviews"].includes(
        session.state.outcome,
      );
    $("#run-status").textContent = approved ? "Complete" : "Ended";
    $("#review-state").textContent = approved
      ? "Draft approved."
      : "Session ended.";
    showDocument(draftText(session.state) ? "draft" : "plan");
  } else {
    $("#review-state").textContent = "Ready to resume.";
    showDocument(currentView);
  }
  $$(".session-card").forEach((button) => {
    const active = button.dataset.sessionId === session.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#activity-placeholder").hidden = Boolean(session.state?.plan);
  updateInput();
  if (!busy) {
    $("#chat-scroll").scrollTop = $("#chat-scroll").scrollHeight;
  }
}

async function request(path, options = {}) {
  const response = await (window.thesisDemoRequest || fetch)(path, options);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : "Check the fields and try again.",
    );
  }
  return response;
}

async function refreshSessions() {
  const groups = await Promise.all(["research", "demo"].map(async (mode) =>
    (await request(sessionBase(mode))).json(),
  ));
  const sessions = groups.flat();
  const select = $("#saved-sessions");
  select.replaceChildren(new Option("Choose a session…", ""));
  $("#session-list").replaceChildren();
  $("#sidebar-empty").hidden = sessions.length > 0;
  sessions.forEach((session) => {
    select.add(
      new Option(session.title + " · " + session.id.slice(0, 5), session.id),
    );
    const button = document.createElement("button");
    button.className = "session-card";
    button.dataset.sessionId = session.id;
    const active = currentSession?.id === session.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    const title = document.createElement("b");
    title.textContent = session.title + (session.mode === "demo"
      ? " · Demo" : "");
    const detail = document.createElement("small");
    detail.textContent = session.review
      ? "Waiting for your review"
      : ["demo_approved", "student_approved",
        "student_approved_with_unresolved_reviews"].includes(
          session.state?.outcome,
        )
        ? "Draft approved"
        : session.state?.outcome
          ? "Session ended"
          : "Ready to continue";
    button.append(title, detail);
    button.addEventListener("click", () => openSession(session.id, session.mode));
    $("#session-list").append(button);
  });
  if (currentSession) select.value = currentSession.id;
}

function handleEvent(type, data) {
  if (type === "progress") {
    $("#workflow-progress").hidden = false;
    $("#activity-placeholder").hidden = true;
    const label = data.event.replaceAll("_", " ");
    $("#workflow-progress").textContent = [label, data.role,
      data.name, data.task_id, data.reason, data.nodes?.join(", ")]
      .filter(Boolean).join(" · ");
    return;
  }
  if (type === "model_delta") {
    $("#model-previews").hidden = false;
    const key = JSON.stringify([data.namespace, data.run_id, data.node]);
    if (!previews.has(key)) {
      const article = document.createElement("article");
      const label = document.createElement("b");
      label.textContent = data.node.replaceAll("_", " ");
      const text = document.createElement("pre");
      article.append(label, text);
      $("#model-output").append(article);
      previews.set(key, text);
    }
    followConversation(() => {
      previews.get(key).textContent += data.text;
    });
    return;
  }
  if (type === "started") {
    const agent = $(`[data-agent="${data.node}"]`);
    agent.hidden = false;
    $("#activity-placeholder").hidden = true;
    agent.dataset.status = "running";
    agent.querySelector(".agent-status").textContent = "Writing…";
    agent.querySelector(".agent-text").textContent = "";
    if (data.node === "planner" || data.node === "worker") {
      const key = data.node === "planner" ? "plan" : "draft";
      currentSession.state[key] = "";
      showDocument(key);
    }
  } else if (type === "text_delta") {
    followConversation(() => {
      $(`[data-agent="${data.node}"] .agent-text`).textContent += data.text;
    });
    if (data.node === "planner" || data.node === "worker") {
      const key = data.node === "planner" ? "plan" : "draft";
      currentSession.state[key] += data.text;
      if (currentView === key) $("#document-text").textContent += data.text;
    }
  } else if (type === "finished") {
    const agent = $(`[data-agent="${data.node}"]`);
    agent.dataset.status = "finished";
    agent.querySelector(".agent-status").textContent = "Complete";
  } else if (type === "review") {
    currentSession.review = data;
  } else if (type === "complete") {
    currentSession = data;
  } else if (type === "error") {
    throw new Error(data.message);
  }
}

function parseEvent(block) {
  let type = "message";
  const data = [];
  block.split("\n").forEach((line) => {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  });
  if (data.length) handleEvent(type, JSON.parse(data.join("\n")));
}

async function runSession(body = {}) {
  setBusy(true);
  previews.clear();
  $("#model-output").replaceChildren();
  $("#model-previews").hidden = true;
  $("#workflow-progress").hidden = true;
  $("#decision-actions").hidden = true;
  $("#review-summary").hidden = true;
  let reader;
  try {
    const response = await request(
      `${sessionBase()}/${currentSession.id}/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        parseEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (done) break;
    }
    $("#feedback").value = "";
  } catch (error) {
    notify(error.message);
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    setBusy(false);
    try {
      const response = await request(
        `${sessionBase()}/${currentSession.id}`,
      );
      renderSession(await response.json());
      await refreshSessions();
    } catch (error) {
      notify(error.message);
    }
  }
}

$$("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showDocument(button.dataset.view));
});
$("#research-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  try {
    selectedMode = $("#run-mode").value;
    if (selectedMode === "research" && !selectedFiles.length &&
        !draftSession?.files?.length) {
      throw new Error("Choose at least one PDF for research.");
    }
    const title = $("#research-title").value;
    const description = $("#research-description").value;
    if (
      !draftSession ||
      draftSession.title !== title ||
      draftSession.description !== description ||
      draftSession.mode !== selectedMode
    ) {
      const response = await request(sessionBase(selectedMode), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
      draftSession = await response.json();
    }
    if (selectedFiles.length) {
      const data = new FormData();
      selectedFiles.forEach((file) => data.append("files", file));
      const response = await request(
        `${sessionBase(draftSession.mode)}/${draftSession.id}/files`,
        { method: "POST", body: data },
      );
      draftSession = await response.json();
      selectedFiles = [];
      renderFiles();
    }
    renderSession(draftSession);
    draftSession = null;
    $("#feedback").value = "";
    $$(".agent").forEach((agent) => {
      agent.hidden = true;
      agent.querySelector(".agent-text").textContent = "";
    });
    await runSession();
  } catch (error) {
    setBusy(false);
    notify(error.message);
    await refreshSessions().catch(() => {});
  }
});
$("#review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !event.submitter) return;
  const decision = event.submitter.value;
  const feedback = $("#feedback").value.trim();
  if (decision === "revise" && !feedback) {
    $("#feedback").focus();
    notify("Describe what you want changed first.");
    return;
  }
  await runSession({ decision, feedback });
});
async function openSession(id, mode = selectedMode) {
  if (!id || busy) return;
  setBusy(true);
  try {
    const session = await (await request(sessionBase(mode) + "/" + id)).json();
    setBusy(false);
    renderSession(session);
    $("#feedback").value = "";
    $("#saved-sessions").value = id;
    $("#sessions-dialog").close();
    if (!session.review && !session.state?.outcome) await runSession();
  } catch (error) {
    setBusy(false);
    notify(error.message);
  }
}

$("#saved-sessions").addEventListener("change", (event) => {
  openSession(event.target.value);
});
$$("[data-new-session]").forEach((button) => {
  button.addEventListener("click", showSetup);
});
$("#open-sessions").addEventListener("click", () => {
  if (!busy) $("#sessions-dialog").showModal();
});
$("#close-sessions").addEventListener("click", () => {
  $("#sessions-dialog").close();
});
$("#resume-session").addEventListener("click", () => {
  if (!busy && currentSession) runSession();
});

$("#open-document").addEventListener("click", () => {
  $("#document-dialog").showModal();
});
$("#close-document").addEventListener("click", () => {
  $("#document-dialog").close();
});
$("#download-report").addEventListener("click", async () => {
  if (busy || downloading || currentSession?.mode !== "research") return;
  const approved = approvedOutcomes.has(currentSession.state?.outcome);
  const id = currentSession.id;
  downloading = true;
  updateDownload();
  let url;
  try {
    const response = await request(
      `${sessionBase()}/${id}/report?draft=${!approved}`,
    );
    url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${approved ? "report" : "draft"}-${id}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    notify(error.message);
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloading = false;
    updateDownload();
  }
});

function renderFiles() {
  $("#file-list").replaceChildren();
  selectedFiles.forEach((file, index) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove " + file.name);
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      if (busy) return;
      selectedFiles.splice(index, 1);
      renderFiles();
    });
    item.append(name, remove);
    $("#file-list").append(item);
  });
}

function addFiles(incoming) {
  if (busy) return;
  const additions = [...incoming].filter(
    (file) =>
      !selectedFiles.some(
        (saved) =>
          saved.name === file.name &&
          saved.size === file.size &&
          saved.lastModified === file.lastModified,
      ),
  );
  if (selectedFiles.length + additions.length > 10) {
    notify("Choose up to 10 PDFs.");
    return;
  }
  if (additions.some((file) => !file.name.toLowerCase().endsWith(".pdf"))) {
    notify("Choose PDF files only.");
    return;
  }
  if (additions.some((file) => file.size > 20 * 1024 * 1024)) {
    notify("Each PDF must be 20 MB or smaller.");
    return;
  }
  selectedFiles.push(...additions);
  renderFiles();
}

$("#choose-files").addEventListener("click", () => {
  if (!busy) $("#file-input").click();
});
$("#file-input").addEventListener("change", (event) => {
  addFiles(event.target.files);
  event.target.value = "";
});
for (const type of ["dragenter", "dragover"]) {
  $("#drop-zone").addEventListener(type, (event) => {
    event.preventDefault();
    if (!busy) $("#drop-zone").classList.add("dragging");
  });
}
$("#drop-zone").addEventListener("dragleave", () => {
  $("#drop-zone").classList.remove("dragging");
});
$("#drop-zone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#drop-zone").classList.remove("dragging");
  addFiles(event.dataTransfer.files);
});

async function initialize() {
  if (location.protocol === "file:") {
    $("#start-demo").disabled = true;
    $("#saved-sessions").disabled = true;
    $(".demo-notice").textContent = "Offline preview";
    $(".demo-notice").title = "Start FastAPI to run the demo.";
    return;
  }
  try {
    const params = new URLSearchParams(location.search);
    const id = params.get("session");
    const mode = params.get("mode") === "research" ? "research" : "demo";
    if (id) {
      const response = await (window.thesisDemoRequest || fetch)(
        sessionBase(mode) + "/" + id,
      );
      if (response.ok) renderSession(await response.json());
      else showSetup();
    }
    await refreshSessions();
  } catch {
    notify("Open this page through the local FastAPI server to try the demo.");
  }
}
$("#run-mode").addEventListener("change", (event) => {
  showMode(event.target.value);
});
showMode($("#run-mode").value);
initialize();
