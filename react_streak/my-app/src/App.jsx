import { useEffect, useRef, useState, useCallback } from "react";
import "./styles.css";
import { ymdFromISTNow, istYesterdayLabel, nextISTMidnightUtcMs } from "./ist";
import { api, apiJson, API_BASE_URL } from "./api";
import { auth } from "./auth";
import Header from "./Header";

/* ------------------------------ App ----------------------------- */
export default function App() {
  // app state
  const [state, setState] = useState({
    dayKey: ymdFromISTNow(),
    overall: { streak: 0, lastCompletedDate: null, completedToday: false },
    lists: [],
    _overallBeforeToday: null, // snapshot for same-day undo (not persisted)
    _overallDirty: false, // persist /overall only when we changed it locally
  });

  const [booted, setBooted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newListName, setNewListName] = useState("");
  const resetTimer = useRef(null);

  const [authReady, setAuthReady] = useState(false);

  /* ---------------- Auth bootstrap (get access via refresh) ------ */
  useEffect(() => {
    (async () => {
      try {
        const rt = auth.getRefreshToken();
        if (!rt) {
          setAuthReady(true);
          return;
        }
        const r = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: rt }),
        });
        if (r.ok) {
          const { accessToken } = await r.json();
          auth.setTokens({ accessToken });
        } else {
          auth.clear();
        }
      } catch {
        auth.clear();
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  /* ---------- Initial load: lists + overall from Mongo ---------- */
  useEffect(() => {
    if (!authReady) return;
    if (!auth.isAuthenticated() || !auth.accessToken) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const [lists, ovDoc] = await Promise.all([
          apiJson("/lists"),
          apiJson("/overall"),
        ]);

        setState((prev) => ({
          ...prev,
          lists: lists.map(fromServer),
          overall: {
            streak: ovDoc?.streak ?? 0,
            lastCompletedDate: ovDoc?.lastCompletedDate ?? null,
            completedToday: !!ovDoc?.completedToday,
          },
          _overallBeforeToday: null,
          _overallDirty: false,
        }));
        setBooted(true);
      } catch (err) {
        console.error("Initial load failed:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [authReady]);

  /* ---------- If IST day changed while app was closed ---------- */
  useEffect(() => {
    const currentIST = ymdFromISTNow();
    if (state.dayKey !== currentIST) {
      setState((prev) => doDailyResetIST(prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------- Schedule midnight IST reset ---------------- */
  useEffect(() => {
    scheduleNextISTReset();
    return () => clearTimer();
  }, [state.dayKey]);

  function clearTimer() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }
  function scheduleNextISTReset() {
    clearTimer();
    const msUntil = nextISTMidnightUtcMs() - Date.now();
    resetTimer.current = setTimeout(() => {
      setState((prev) => ({ ...doDailyResetIST(prev) }));
      scheduleNextISTReset();
    }, Math.max(msUntil, 1000));
  }

  function doDailyResetIST(prev) {
    const s = structuredClone(prev);
    const oldDay = s.dayKey;
    const todayIST = ymdFromISTNow();

    // per-list continuity + reset tasks
    s.lists.forEach((list) => {
      if (!(list.completedToday && list.lastCompletedDate === oldDay)) {
        list.streak = 0;
      }
      list.completedToday = false;
      list.tasks.forEach((t) => (t.done = false));
      persistList(list).catch(() => {});
    });

    // overall continuity
    if (!(s.overall.completedToday && s.overall.lastCompletedDate === oldDay)) {
      s.overall.streak = 0;
    }
    s.overall.completedToday = false;
    s._overallBeforeToday = null;
    s._overallDirty = false;

    s.dayKey = todayIST;
    return s;
  }

  /* --------------- Derived: are ALL lists done today? ---------- */
  const allListsCompletedToday = useCallback((lists, dayKey) => {
    if (!lists || lists.length === 0) return false;
    return lists.every(
      (l) => l.completedToday === true && l.lastCompletedDate === dayKey
    );
  }, []);

  /* -------- Persist overall to Mongo only when we changed it ---- */
  useEffect(() => {
    if (!booted || !state._overallDirty) return;
    (async () => {
      try {
        await saveOverall(state.overall);
        setState((prev) => ({ ...prev, _overallDirty: false }));
      } catch {
        // keep dirty=true for retry
      }
    })();
  }, [state.overall, state._overallDirty, booted]);

  /* ----------------------- API helpers (JWT) -------------------- */
  async function fetchOverall() {
    return apiJson("/overall");
  }
  async function saveOverall(overall) {
    await api("/overall", {
      method: "PUT",
      body: JSON.stringify(overall),
    });
  }

  async function createListOnServer(newList) {
    const saved = await apiJson("/lists", {
      method: "POST",
      body: JSON.stringify(toServer(newList)),
    });
    return fromServer(saved);
  }

  // Guard against temp ids to avoid accidental upserts/duplicates
  const isMongoId = (id) =>
    typeof id === "string" && /^[a-f0-9]{24}$/i.test(id);

  async function persistList(list) {
    if (!isMongoId(list.id)) return; // don't PUT until we have a real Mongo _id
    await api(`/lists/${list.id}`, {
      method: "PUT",
      body: JSON.stringify(toServer(list)),
    });
  }
  async function deleteListOnServer(id) {
    if (!isMongoId(id)) return; // skip delete for unsaved temp list
    await api(`/lists/${id}`, { method: "DELETE" });
  }

  /* ----------------- List streak helpers (undo-safe) ----------- */
  const applyListStreakIncrementForToday = useCallback((list, today) => {
    const prev = list.streak ?? 0;
    const yest = istYesterdayLabel(today);
    const carry = list.lastCompletedDate === yest;
    return {
      ...list,
      _streakBeforeToday: prev, // UI-only snapshot
      _prevLastCompletedDate: list.lastCompletedDate ?? null,
      streak: carry ? prev + 1 : 1,
      lastCompletedDate: today,
      completedToday: true,
    };
  }, []);

  const rollbackListStreakForToday = useCallback((list, today) => {
    if (list.lastCompletedDate !== today) {
      return { ...list, completedToday: false };
    }
    const prevStreak = list._streakBeforeToday ?? 0;
    const prevLast = list._prevLastCompletedDate ?? null;
    const next = {
      ...list,
      streak: prevStreak,
      lastCompletedDate: prevLast,
      completedToday: false,
    };
    delete next._streakBeforeToday;
    delete next._prevLastCompletedDate;
    return next;
  }, []);

  /* ----------------------- Mutations ---------------------------- */
  async function addList(name) {
    if (!name.trim()) return;

    // optimistic local list (with temp id)
    const local = {
      id: uid(),
      title: name.trim(),
      streak: 0,
      lastCompletedDate: null,
      completedToday: false,
      tasks: [],
    };

    // 1) Pure state update — no network calls here
    setState((prev) => {
      const s = structuredClone(prev);
      const prevAllDone = allListsCompletedToday(s.lists, s.dayKey);
      s.lists = [...s.lists, local];
      const nowAllDone = allListsCompletedToday(s.lists, s.dayKey);
      applyOverallTransitionIfNeeded(s, prevAllDone, nowAllDone);
      return s;
    });

    // 2) Single POST outside the updater (avoids StrictMode double-run)
    try {
      const saved = await createListOnServer(local); // { id: realMongoId, ... }
      setState((cur) => {
        const c = structuredClone(cur);
        const idx = c.lists.findIndex((L) => L.id === local.id);
        if (idx !== -1) {
          const withRealId = { ...c.lists[idx], id: saved.id };
          c.lists[idx] = withRealId;
          persistList(withRealId).catch(() => {});
        }
        return c;
      });
    } catch {
      // keep optimistic list; optionally show a toast
    }
  }

  function renameList(id, nextTitle) {
    setState((prev) => {
      const s = structuredClone(prev);
      const L = s.lists.find((x) => x.id === id);
      if (L && nextTitle.trim()) {
        L.title = nextTitle.trim();
        persistList(L).catch(() => {});
      }
      return s;
    });
  }

  function deleteList(id) {
    setState((prev) => {
      const s = structuredClone(prev);
      const prevAllDone = allListsCompletedToday(s.lists, s.dayKey);
      s.lists = s.lists.filter((x) => x.id !== id);
      const nowAllDone = allListsCompletedToday(s.lists, s.dayKey);
      applyOverallTransitionIfNeeded(s, prevAllDone, nowAllDone);
      deleteListOnServer(id).catch(() => {});
      return s;
    });
  }

  function addTask(listId, text) {
    if (!text.trim()) return;
    setState((prev) => {
      const s = structuredClone(prev);
      const L = s.lists.find((x) => x.id === listId);
      if (!L) return prev;

      const prevAllDone = allListsCompletedToday(s.lists, s.dayKey);
      const wasCompleted =
        L.completedToday === true && L.lastCompletedDate === s.dayKey;

      L.tasks.push({ id: uid(), text: text.trim(), done: false });

      // adding an undone task always makes the list incomplete
      if (wasCompleted) {
        const rolled = rollbackListStreakForToday(L, s.dayKey);
        Object.assign(L, rolled);
      }
      L.completedToday = false;

      const nowAllDone = allListsCompletedToday(s.lists, s.dayKey);
      applyOverallTransitionIfNeeded(s, prevAllDone, nowAllDone);

      persistList(L).catch(() => {});
      return s;
    });
  }

  function toggleTask(listId, taskId, checked) {
    setState((prev) => {
      const s = structuredClone(prev);
      const L = s.lists.find((x) => x.id === listId);
      if (!L) return prev;
      const T = L.tasks.find((t) => t.id === taskId);
      if (!T) return prev;

      const prevAllDone = allListsCompletedToday(s.lists, s.dayKey);

      const wasCompleted =
        L.completedToday === true && L.lastCompletedDate === s.dayKey;
      T.done = checked;

      const nowCompleted =
        L.tasks.length > 0 && L.tasks.every((t) => t.done === true);

      if (nowCompleted && !wasCompleted) {
        const nextL = applyListStreakIncrementForToday(L, s.dayKey);
        Object.assign(L, nextL);
      } else if (!nowCompleted && wasCompleted) {
        const rolled = rollbackListStreakForToday(L, s.dayKey);
        Object.assign(L, rolled);
      } else {
        L.completedToday = nowCompleted;
      }

      const nowAllDone = allListsCompletedToday(s.lists, s.dayKey);
      applyOverallTransitionIfNeeded(s, prevAllDone, nowAllDone);

      persistList(L).catch(() => {});
      return s;
    });
  }

  function deleteTask(listId, taskId) {
    setState((prev) => {
      const s = structuredClone(prev);
      const L = s.lists.find((x) => x.id === listId);
      if (!L) return prev;

      const prevAllDone = allListsCompletedToday(s.lists, s.dayKey);
      const wasCompleted =
        L.completedToday === true && L.lastCompletedDate === s.dayKey;

      L.tasks = L.tasks.filter((t) => t.id !== taskId);
      const nowCompleted =
        L.tasks.length > 0 && L.tasks.every((t) => t.done === true);

      if (nowCompleted && !wasCompleted) {
        const nextL = applyListStreakIncrementForToday(L, s.dayKey);
        Object.assign(L, nextL);
      } else if (!nowCompleted && wasCompleted) {
        const rolled = rollbackListStreakForToday(L, s.dayKey);
        Object.assign(L, rolled);
      } else {
        L.completedToday = nowCompleted;
      }

      const nowAllDone = allListsCompletedToday(s.lists, s.dayKey);
      applyOverallTransitionIfNeeded(s, prevAllDone, nowAllDone);

      persistList(L).catch(() => {});
      return s;
    });
  }

  // overall transition helper
  function applyOverallTransitionIfNeeded(s, prevAllDone, nowAllDone) {
    const today = s.dayKey;
    const yest = istYesterdayLabel(today);

    // NOT all done -> ALL done : bump
    if (!prevAllDone && nowAllDone) {
      // snapshot for same-day undo
      s._overallBeforeToday = {
        streak: s.overall.streak,
        lastCompletedDate: s.overall.lastCompletedDate,
      };

      // carry only if yesterday was the last completed date
      s.overall.streak =
        s.overall.lastCompletedDate === yest ? s.overall.streak + 1 : 1;

      s.overall.completedToday = true;
      s.overall.lastCompletedDate = today;
      s._overallDirty = true;
      return;
    }

    // ALL done -> NOT all done : drop
    if (prevAllDone && !nowAllDone) {
      // Always decrement and backdate so a same-day re-complete won't reset to 1
      s.overall.streak = Math.max(0, s.overall.streak - 1);
      s.overall.lastCompletedDate = s.overall.streak > 0 ? yest : null;

      s.overall.completedToday = false;
      s._overallBeforeToday = null;
      s._overallDirty = true;
    }
  }

  /* ----------------------------- UI ---------------------------- */
  if (!authReady || loading) {
    return (
      <main className="container">
        <div className="empty">Loading…</div>
      </main>
    );
  }

  if (!auth.accessToken) {
    return <AuthScreen onAuthenticated={() => window.location.reload()} />;
  }

  // Controls header glow: true only if all lists are done today
  const overallDoneToday =
    state.overall.completedToday &&
    state.overall.lastCompletedDate === state.dayKey;

  return (
    <>
      <Header
        streak={state.overall.streak}
        active={overallDoneToday}
        onLogout={() => {
          auth.clear();
          window.location.reload();
        }}
      />

      <main className="container">
        <section id="listsContainer" className="lists">
          {state.lists.length === 0 ? (
            <div className="empty">No lists yet. Click ＋ to add one.</div>
          ) : (
            state.lists.map((list) => (
              <ListCard
                key={list.id}
                list={list}
                onRename={(name) => renameList(list.id, name)}
                onDelete={() => deleteList(list.id)}
                onAddTask={(text) => addTask(list.id, text)}
                onToggleTask={(taskId, checked) =>
                  toggleTask(list.id, taskId, checked)
                }
                onDeleteTask={(taskId) => deleteTask(list.id, taskId)}
              />
            ))
          )}
        </section>
      </main>

      <button
        id="addListBtn"
        className="fab"
        title="Add To-Do List"
        aria-label="Add To-Do List"
        onClick={() => {
          setNewListName("");
          setDialogOpen(true);
        }}
      >
        ＋
      </button>

      {dialogOpen && (
        <dialog open id="newListDialog">
          <form
            id="newListForm"
            method="dialog"
            onSubmit={async (e) => {
              e.preventDefault();
              await addList(newListName);
              setDialogOpen(false);
            }}
          >
            <h2>Create New List</h2>
            <label className="field">
              <span>List name</span>
              <input
                type="text"
                id="newListName"
                placeholder="e.g., Morning Routine"
                required
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button type="submit" className="btn primary">
                Create
              </button>
              <button
                type="button"
                className="btn"
                id="cancelNewList"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}

/* ------------------------- Auth Screen -------------------------- */
function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    setErr("");
    try {
      const r = await fetch(`${API_BASE_URL}/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Auth failed (${r.status})`);
      }
      const { accessToken, refreshToken } = await r.json();
      auth.setTokens({ accessToken, refreshToken });
      onAuthenticated();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 420 }}>
      <h1 className="app-title">Streaky To-Dos</h1>
      <div className="card" style={{ padding: 16 }}>
        <div
          className="row"
          style={{ justifyContent: "space-between", marginBottom: 8 }}
        >
          <strong>{mode === "login" ? "Login" : "Register"}</strong>
          <button
            className="btn"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            Switch to {mode === "login" ? "Register" : "Login"}
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
            />
          </label>
          {err && (
            <div className="empty" style={{ color: "crimson" }}>
              {err}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit" className="btn primary">
              {mode === "login" ? "Login" : "Register"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

/* --------------------------- ListCard --------------------------- */
function ListCard({
  list,
  onRename,
  onDelete,
  onAddTask,
  onToggleTask,
  onDeleteTask,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [input, setInput] = useState("");

  useEffect(() => {
    function onDocClick() {
      setMenuOpen(false);
    }
    function onEsc(e) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  return (
    <article className="list-card" onClick={(e) => e.stopPropagation()}>
      <div className="list-header">
        <div className="list-title">
          <span>{list.title}</span>
          <div
            className={`list-streak-icon ${
              list.completedToday ? "active" : ""
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="flame"
              width="18"
              height="18"
              aria-hidden="true"
            >
              <path d="M12 2c0 4-3 4.5-3 8 0 1.8 1.2 3 3 3s3-1.2 3-3c0-1.7-.6-3.1-1.2-4.3-.4-.9 0-2 1-2.2C18 4.2 20 7.4 20 11.1 20 15.5 16.9 19 12 19S4 15.5 4 11.1c0-2.4 1.1-4.7 2.9-6.2.7-.6 1.9 0 1.7.9C8.2 6.7 8 7.6 8 8c0 1.7 1.3 3 3 3" />
            </svg>
            <span className="count-inline">{list.streak}</span>
          </div>
        </div>

        <div className="card-actions">
          <button
            className="kebab-btn"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <span className="kebab-dots">
              <span />
            </span>
          </button>

          <div className={`card-menu ${menuOpen ? "open" : ""}`}>
            <button
              onClick={() => {
                setMenuOpen(false);
                const next = prompt("Rename list:", list.title);
                if (next) onRename(next);
              }}
            >
              Rename
            </button>
            <button className="danger" onClick={() => onDelete()}>
              Delete
            </button>
          </div>
        </div>
      </div>

      <div className="tasks">
        {list.tasks.length === 0 ? (
          <div className="empty">No tasks.</div>
        ) : (
          list.tasks.map((t) => (
            <label key={t.id} className={`task ${t.done ? "done" : ""}`}>
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => onToggleTask(t.id, e.target.checked)}
              />
              <span className="label">{t.text}</span>
              <button
                className="icon-btn"
                title="Remove task"
                style={{ marginLeft: "auto" }}
                onClick={() => onDeleteTask(t.id)}
              >
                ✕
              </button>
            </label>
          ))
        )}
      </div>

      <div className="row">
        <input
          className="input"
          placeholder="Add a task and press Enter"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onAddTask(input);
              setInput("");
            }
          }}
        />
        <button
          className="btn primary"
          onClick={() => {
            onAddTask(input);
            setInput("");
          }}
        >
          Add
        </button>
      </div>
    </article>
  );
}

/* -------------------------- helpers ---------------------------- */
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

const fromServer = (doc) => ({
  id: doc._id,
  title: doc.title,
  streak: doc.streak ?? 0,
  lastCompletedDate: doc.lastCompletedDate ?? null,
  completedToday: !!doc.completedToday,
  tasks: (doc.tasks || []).map((t) => ({
    id: t.id || t._id || uid(),
    text: t.text,
    done: !!t.done,
  })),
});

const toServer = (list) => ({
  title: list.title,
  streak: list.streak,
  lastCompletedDate: list.lastCompletedDate,
  completedToday: list.completedToday,
  tasks: list.tasks.map((t) => ({ id: t.id, text: t.text, done: t.done })),
});
