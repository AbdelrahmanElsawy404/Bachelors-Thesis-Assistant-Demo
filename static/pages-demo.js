/* GitHub Pages only: scripted responses and browser-local sessions. */
(() => {
  const key = "thesis-pages-demo-v1";
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  const read = () => JSON.parse(localStorage.getItem(key) || "{}");
  const save = (session) => {
    const sessions = read();
    sessions[session.id] = session;
    localStorage.setItem(key, JSON.stringify(sessions));
  };
  const revision = (session) => session.state.feedback
    ? "\n\nRequested revision: " + session.state.feedback : "";
  function plan(session) {
    return `Research plan: ${session.title}\n\n` +
      "01 — Define the research question and comparison criteria.\n" +
      "02 — Review the literature and record evidence.\n" +
      "03 — Compare findings, limitations and open questions.\n" +
      "04 — Draft the discussion and review every citation.\n\n" +
      "Scripted preview. No papers have been searched." + revision(session);
  }
  const critic = "The plan has a clear sequence. Before real research, " +
    "specify source selection criteria and university requirements. " +
    "This scripted review does not verify research quality.";
  function draft(session) {
    return `Working draft — ${session.title}\n\n` +
      "Background\nThis scripted preview shows where a research draft " +
      "would appear.\n\nMethodology\nThe local Python application " +
      "retrieves indexed passages and tracks source references.\n\n" +
      "Discussion\nNo findings or citations are generated in this demo. " +
      "Real evidence must be checked against original sources.\n\n" +
      "Conclusion\nReview, request changes, or approve this sample. " +
      "Approval applies only to the demo." + revision(session);
  }
  function stream(session, body) {
    const pending = session.review;
    if (session.state.outcome || (pending && !body.decision) ||
        (!pending && body.decision)) {
      return json({ detail: "This session cannot run that action." }, 409);
    }
    if (body.decision && !["approve", "revise", "end"]
      .includes(body.decision)) return json({ detail: "Invalid decision." }, 422);
    if (body.decision === "revise" && !body.feedback?.trim()) {
      return json({ detail: "Describe the requested changes." }, 422);
    }
    const events = [];
    const emit = (type, data) => events.push([type, data]);
    const write = (node, field, text) => {
      emit("started", { node });
      for (const word of text.match(/\S+\s*/g) || []) {
        emit("text_delta", { node, text: word });
      }
      emit("finished", { node });
      session.state[field] = text;
    };
    if (pending) session.state.feedback = body.feedback || "";
    session.review = null;
    if (body.decision === "end") session.state.outcome = "ended";
    else if (pending?.stage === "results" && body.decision === "approve") {
      session.state.outcome = "demo_approved";
    } else if (!pending ||
        (pending.stage === "planning" && body.decision === "revise")) {
      write("planner", "plan", plan(session));
      write("critic", "critic_text", critic);
      session.review = { stage: "planning", text: session.state.plan };
    } else {
      write("worker", "draft", draft(session));
      session.review = { stage: "results", text: session.state.draft };
    }
    if (session.review) emit("review", session.review);
    emit("complete", session);
    const encoder = new TextEncoder();
    let cancelled = false;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 12));
        if (cancelled) return;
        const [type, data] = events.shift();
        if (!events.length) {
          try { save(session); }
          catch {
            controller.enqueue(encoder.encode('event: error\ndata: ' +
              JSON.stringify({ message: "Browser storage is full or blocked." }) +
              '\n\n'));
            controller.close();
            return;
          }
        }
        controller.enqueue(encoder.encode(
          `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
        ));
        if (!events.length) controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  }
  window.thesisDemoRequest = async (path, options = {}) => {
    try {
      // Never fall through to network APIs on this static site.
      if (path === "/api/research/sessions") return json([]);
      const match = path.match(/^\/api\/demo\/sessions(?:\/([^/]+))?(\/stream)?$/);
      if (!match) return json({ detail: "Unavailable in this demo." }, 404);
      const [, id, action] = match;
      const body = JSON.parse(options.body || "{}");
      const sessions = read();
      if (!id && options.method === "POST") {
        if (!body.title?.trim() || body.title.length > 180 ||
            !body.description?.trim() || body.description.length > 2000) {
          return json({ detail: "Enter a title and description." }, 422);
        }
        if (Object.keys(sessions).length >= 30) {
          return json({ detail: "Demo limit reached. Clear this site's " +
            "browser storage to start again." }, 422);
        }
        const session = { id: crypto.randomUUID(), mode: "demo",
          title: body.title.trim(), description: body.description.trim(),
          files: [], state: {}, review: null, next: [], running: false };
        save(session);
        return json(session, 201);
      }
      if (!id) return json(Object.values(sessions).reverse());
      const session = sessions[id];
      if (!Object.hasOwn(sessions, id)) {
        return json({ detail: "Demo session not found in this browser." }, 404);
      }
      if (action && options.method === "POST") return stream(session, body);
      if (action) return json({ detail: "Use POST to continue." }, 405);
      return json(session);
    } catch {
      return json({ detail: "Browser storage is unavailable. Allow site " +
        "storage, or clear this site's saved data and reload." }, 503);
    }
  };
})();
