import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Repo = {
  path: string;
  name: string;
  branch: string;
  remote: string | null;
  remote_web: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  last_commit: number | null;
  dirty: boolean;
  unpushed: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
  deleted: string[];
  conflicted: string[];
};
type Commit = {
  id: string;
  short_id: string;
  author: string;
  email: string;
  date: number;
  committer: string;
  committer_email: string;
  committer_date: number;
  message: string;
  parents: string[];
};
type FileChange = {
  path: string;
  old_path: string | null;
  status: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  patch: string;
};
type Detail = {
  info: Commit;
  insertions: number;
  deletions: number;
  files: FileChange[];
};
type DS = { st: "load" } | { st: "err"; m: string } | { st: "ok"; d: Detail };
type Prog = {
  stage: string;
  current: string;
  dirs: number;
  found: number;
  done: number;
  total: number;
};
type Startup = {
  repos: Repo[];
  roots: string[];
  drives: string[];
  last_scan: number;
};
type Toast = { id: number; m: string };
type DriveInfo = { drives: string[]; roots: string[] };
type Filter = "all" | "dirty" | "unpushed" | "behind";

let started = false;
const cats = (r: Repo): [string, string, string[], string][] => [
  ["modified", "Modified", r.modified, "Tracked files changed but not staged"],
  ["staged", "Staged", r.staged, "Changes added to the index, ready to commit"],
  [
    "untracked",
    "Untracked",
    r.untracked,
    "New files/folders Git is not tracking yet",
  ],
  ["deleted", "Deleted", r.deleted, "Tracked files removed from disk or index"],
  [
    "conflicted",
    "Conflicts",
    r.conflicted,
    "Files with unresolved merge conflicts",
  ],
];
const PAGE = 50;
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const call = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  isTauri
    ? invoke<T>(cmd, args)
    : Promise.reject(new Error("Tauri unavailable in web mode"));
const when = (t: number | null) =>
  t
    ? new Date(t * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  for (const [n, l] of [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ] as [number, string][])
    if (s >= n) {
      const v = Math.floor(s / n);
      return `${v} ${l}${v > 1 ? "s" : ""} ago`;
    }
  return "just now";
};
const shortPath = (p: string) => (p.length > 78 ? `…${p.slice(-75)}` : p);
const SC: Record<string, [string, string]> = {
  added: ["Added", "bg-emerald-500/15 text-emerald-300"],
  deleted: ["Deleted", "bg-red-500/15 text-red-300"],
  modified: ["Modified", "bg-amber-500/15 text-amber-300"],
  renamed: ["Renamed", "bg-sky-500/15 text-sky-300"],
  copied: ["Copied", "bg-sky-500/15 text-sky-300"],
  typechange: ["Type changed", "bg-purple-500/15 text-purple-300"],
};
const Spin = () => (
  <span
    aria-hidden="true"
    className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-orange-500 border-t-transparent animate-spin"
  />
);
const Badge = ({ s }: { s: string }) => {
  const [l, c] = SC[s] ?? [s, "bg-zinc-700 text-zinc-300"];
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${c}`}
    >
      {l}
    </span>
  );
};

function Diff({ patch }: { patch: string }) {
  const rows = useMemo(() => {
    let o = 0,
      n = 0,
      on = false;
    const out: { k: string; t: string; o: string; n: string }[] = [];
    const ls = patch.split("\n");
    if (ls[ls.length - 1] === "") ls.pop();
    for (const l of ls) {
      if (l.startsWith("@@")) {
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
        o = m ? +m[1] : 0;
        n = m ? +m[2] : 0;
        on = true;
        out.push({ k: "h", t: l, o: "", n: "" });
        continue;
      }
      if (!on) continue;
      const c = l[0];
      if (c === "+") out.push({ k: "a", t: l, o: "", n: String(n++) });
      else if (c === "-") out.push({ k: "d", t: l, o: String(o++), n: "" });
      else if (c === "\\") out.push({ k: "m", t: l, o: "", n: "" });
      else out.push({ k: "c", t: l, o: String(o++), n: String(n++) });
    }
    return out;
  }, [patch]);
  const bg: Record<string, string> = {
    a: "bg-emerald-500/10 text-emerald-200",
    d: "bg-red-500/10 text-red-200",
    h: "bg-sky-500/10 text-sky-300",
    m: "text-zinc-500 italic",
    c: "text-zinc-400",
  };
  return (
    <div className="overflow-x-auto">
      <div className="min-w-max font-mono text-[12px] leading-5">
        {rows.map((r, i) => (
          <div key={i} className={`flex ${bg[r.k]}`}>
            <span className="w-10 shrink-0 text-right pr-2 text-zinc-600 select-none">
              {r.o}
            </span>
            <span className="w-10 shrink-0 text-right pr-2 text-zinc-600 select-none">
              {r.n}
            </span>
            <span className="whitespace-pre pr-4">{r.t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileView({ f, open }: { f: FileChange; open: boolean }) {
  const [o, setO] = useState(open);
  return (
    <details
      open={open}
      onToggle={(e) => setO(e.currentTarget.open)}
      className="border border-line rounded-lg mb-3 overflow-hidden"
    >
      <summary className="cursor-pointer list-none flex items-center gap-2 px-3 py-2 bg-zinc-900 text-xs">
        <Badge s={f.status} />
        <span className="font-mono truncate min-w-0 flex-1" title={f.path}>
          {f.old_path ? `${f.old_path} → ${f.path}` : f.path}
        </span>
        <span className="text-emerald-400">+{f.insertions}</span>
        <span className="text-red-400">−{f.deletions}</span>
      </summary>
      {!o ? null : f.binary ? (
        <div className="p-3 text-xs text-zinc-500">Binary file not shown.</div>
      ) : f.patch ? (
        <Diff patch={f.patch} />
      ) : (
        <div className="p-3 text-xs text-zinc-500">
          {f.truncated
            ? "Diff too large to display."
            : f.status === "renamed"
              ? "File renamed without changes."
              : "No content changes."}
        </div>
      )}
      {o && f.truncated && f.patch && (
        <div className="p-2 text-xs text-amber-400 border-t border-line">
          Diff truncated (file too large).
        </div>
      )}
    </details>
  );
}

function CommitItem({
  c,
  open,
  ds,
  onToggle,
}: {
  c: Commit;
  open: boolean;
  ds?: DS;
  onToggle: () => void;
}) {
  const [subject, ...rest] = c.message.trim().split("\n");
  const body = rest.join("\n").trim();
  const same = c.committer === c.author && c.committer_email === c.email;
  const counts = (fs: FileChange[]) =>
    Object.entries(
      fs.reduce((a: Record<string, number>, f) => {
        a[f.status] = (a[f.status] || 0) + 1;
        return a;
      }, {}),
    )
      .map(([k, v]) => `${v} ${(SC[k]?.[0] ?? k).toLowerCase()}`)
      .join(", ");
  return (
    <div className="border-b border-line">
      <button
        onClick={onToggle}
        className={`w-full text-left px-4 py-3 flex gap-3 items-start hover:bg-zinc-900/60 ${open ? "bg-zinc-900/40" : ""}`}
      >
        <span className="text-zinc-600 text-xs mt-0.5 w-3">
          {open ? "▾" : "▸"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {subject || "(no message)"}
          </div>
          <div className="text-xs text-zinc-500 mt-1 truncate">
            {c.author} committed {ago(c.date)}
            {c.parents.length > 1 && (
              <span className="ml-2 text-purple-300">merge</span>
            )}
          </div>
        </div>
        <span className="font-mono text-xs text-orange-300 shrink-0 mt-0.5">
          {c.short_id}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {body && (
            <pre className="whitespace-pre-wrap break-words text-xs text-zinc-300 font-sans mb-3">
              {body}
            </pre>
          )}
          <div className="rounded-lg bg-zinc-900 p-3 text-xs grid grid-cols-[80px_1fr] gap-y-1.5 mb-3">
            <span className="text-zinc-500">Author</span>
            <span>
              {c.author}{" "}
              <span className="text-zinc-500">&lt;{c.email}&gt;</span> ·{" "}
              {when(c.date)}
            </span>
            {!same && (
              <>
                <span className="text-zinc-500">Committer</span>
                <span>
                  {c.committer}{" "}
                  <span className="text-zinc-500">
                    &lt;{c.committer_email}&gt;
                  </span>{" "}
                  · {when(c.committer_date)}
                </span>
              </>
            )}
            <span className="text-zinc-500">Commit</span>
            <span className="font-mono break-all">
              {c.id}{" "}
              <button
                onClick={() => navigator.clipboard?.writeText(c.id)}
                className="ml-2 px-1.5 rounded border border-line text-zinc-400 hover:text-white font-sans"
              >
                Copy
              </button>
            </span>
            <span className="text-zinc-500">
              {c.parents.length === 1 ? "Parent" : "Parents"}
            </span>
            <span className="font-mono">
              {c.parents.length
                ? c.parents.map((p) => p.slice(0, 7)).join("  ")
                : "none (root commit)"}
            </span>
          </div>
          {(!ds || ds.st === "load") && (
            <div className="flex items-center gap-2 text-xs text-zinc-400 py-3">
              <Spin />
              Loading changes for {c.short_id}…
            </div>
          )}
          {ds?.st === "err" && (
            <div className="text-xs text-red-300 py-2">{ds.m}</div>
          )}
          {ds?.st === "ok" && (
            <>
              <div className="text-xs text-zinc-400 mb-2">
                Showing{" "}
                <b className="text-zinc-200">
                  {ds.d.files.length} changed file
                  {ds.d.files.length === 1 ? "" : "s"}
                </b>{" "}
                ({counts(ds.d.files)}) with{" "}
                <b className="text-emerald-400">{ds.d.insertions} additions</b>{" "}
                and <b className="text-red-400">{ds.d.deletions} deletions</b>
                {c.parents.length > 1 && " (compared to first parent)"}.
              </div>
              <div className="rounded-lg border border-line mb-3 divide-y divide-line">
                {ds.d.files.map((f) => (
                  <div
                    key={f.path + f.status}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <Badge s={f.status} />
                    <span
                      className="font-mono truncate flex-1 min-w-0"
                      title={f.path}
                    >
                      {f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                    </span>
                    <span className="text-emerald-400">+{f.insertions}</span>
                    <span className="text-red-400">−{f.deletions}</span>
                  </div>
                ))}
              </div>
              {ds.d.files.map((f, i) => (
                <FileView key={f.path + f.status} f={f} open={i < 10} />
              ))}
              {ds.d.files.length === 0 && (
                <div className="text-xs text-zinc-500">
                  This commit has no file changes.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    return this.state.err ? (
      <div
        role="alert"
        className="h-full grid place-items-center bg-bg text-zinc-200 p-6"
      >
        <div className="max-w-md text-center">
          <div className="text-lg font-bold mb-2">Something went wrong</div>
          <div className="text-sm text-zinc-400 mb-4 break-words">
            {this.state.err.message}
          </div>
          <button
            onClick={() => location.reload()}
            className="rounded-lg bg-orange-500 text-black font-bold px-4 py-2 text-sm"
          >
            Reload GitPulse
          </button>
        </div>
      </div>
    ) : (
      this.props.children
    );
  }
}

function App() {
  const [booted, setBooted] = useState(false);
  const [sec, setSec] = useState<string | null>(null);
  const [drives, setDrives] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [watched, setWatched] = useState<string[]>([]);
  const [lastScan, setLastScan] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastRefresh = useRef(0);
  const [input, setInput] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState<Repo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ds, setDs] = useState<Record<string, DS>>({});
  const [query, setQuery] = useState("");
  const [commitQuery, setCommitQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scroll, setScroll] = useState(0);
  const [prog, setProg] = useState<Prog | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [secs, setSecs] = useState(0);
  const [scanned, setScanned] = useState(false);
  const selRef = useRef<string | null>(null);
  const reposRef = useRef<Repo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [sbw, setSbw] = useState(() => {
    try {
      const v = Number(localStorage.getItem("gp.sbw"));
      return v >= 320 ? v : 640;
    } catch {
      return 640;
    }
  });
  const [vw, setVw] = useState(window.innerWidth);
  const [mw, setMw] = useState(1000);
  const mainRef = useRef<HTMLElement>(null);
  const sbwRef = useRef(sbw);
  useEffect(() => {
    const f = () => setVw(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const o = new ResizeObserver((e) => setMw(e[0].contentRect.width));
    o.observe(el);
    return () => o.disconnect();
  }, []);
  const overlay = vw < 900;
  const sw = Math.min(
    vw,
    Math.min(
      Math.max(sbw, 320),
      Math.max(320, Math.min(vw - (overlay ? 0 : 360), 1100)),
    ),
  );
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const mv = (ev: PointerEvent) => {
      const w = Math.round(window.innerWidth - ev.clientX);
      sbwRef.current = w;
      setSbw(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      try {
        localStorage.setItem("gp.sbw", String(sbwRef.current));
      } catch {}
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const cols =
    mw >= 880
      ? [0, 1, 2, 3, 4]
      : mw >= 700
        ? [0, 1, 2, 3]
        : mw >= 480
          ? [0, 2, 3]
          : [0, 2];
  const has = (k: number) => cols.includes(k);
  const tpl = cols
    .map((k) => ["minmax(0,1fr)", "110px", "120px", "110px", "170px"][k])
    .join(" ");
  const [settings, setSettings] = useState(false);
  const [ignoreText, setIgnoreText] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const rowH = 66,
    viewport = 1400,
    overscan = 8;
  reposRef.current = repos;

  const fetchCommits = async (path: string, skip: number) => {
    const c = await call<Commit[]>("commit_list", { path, skip, limit: PAGE });
    return c;
  };
  const load = async (path: string) => {
    setLoadingRepo(true);
    try {
      const [r, c] = await Promise.all([
        call<Repo>("repo_info", { path }),
        fetchCommits(path, 0),
      ]);
      if (selRef.current !== path) return;
      setInfo(r);
      setCommits(c);
      setHasMore(c.length === PAGE);
    } catch (e) {
      if (selRef.current === path) setError(String(e));
    } finally {
      if (selRef.current === path) setLoadingRepo(false);
    }
  };
  const open = (path: string) => {
    if (selRef.current === path) return;
    selRef.current = path;
    setSelected(path);
    setInfo(null);
    setCommits([]);
    setHasMore(false);
    setExpanded(null);
    setDs({});
    setCommitQuery("");
    setError("");
    setSec(null);
    load(path);
  };
  const close = () => {
    selRef.current = null;
    setSelected(null);
    setInfo(null);
  };
  const refresh = () => {
    const p = selRef.current;
    if (p) {
      setExpanded(null);
      setDs({});
      load(p);
    }
  };
  const more = async () => {
    const p = selRef.current;
    if (!p) return;
    setLoadingMore(true);
    try {
      const c = await fetchCommits(p, commits.length);
      if (selRef.current === p) {
        setCommits((o) => [...o, ...c]);
        setHasMore(c.length === PAGE);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  };
  const toggle = (c: Commit) => {
    const p = selRef.current;
    if (!p) return;
    if (expanded === c.id) {
      setExpanded(null);
      return;
    }
    setExpanded(c.id);
    if (ds[c.id]?.st === "ok" || ds[c.id]?.st === "load") return;
    setDs((o) => ({ ...o, [c.id]: { st: "load" } }));
    call<Detail>("commit_detail", { path: p, id: c.id })
      .then((d) => setDs((o) => ({ ...o, [c.id]: { st: "ok", d } })))
      .catch((e) =>
        setDs((o) => ({ ...o, [c.id]: { st: "err", m: String(e) } })),
      );
  };
  const act = (cmd: string, args: Record<string, unknown>) =>
    call(cmd, args).catch((e) => setError(String(e)));

  const toast = (m: string) => {
    const id = Date.now() + Math.random();
    setToasts((o) => [...o.slice(-3), { id, m }]);
    setTimeout(() => setToasts((o) => o.filter((t) => t.id !== id)), 5000);
  };
  const upsert = (p: Repo) =>
    setRepos((o) => {
      const i = o.findIndex((r) => r.path === p.path);
      if (i < 0)
        return [...o, p].sort((a, b) =>
          a.path.toLowerCase().localeCompare(b.path.toLowerCase()),
        );
      const n = o.slice();
      n[i] = p;
      return n;
    });
  const refreshAll = async () => {
    if (!isTauri) return;
    setRefreshing(true);
    lastRefresh.current = Date.now();
    try {
      await call("refresh_all");
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  };
  const scan = async (paths: string[], bg = false) => {
    if (!isTauri) return;
    setLoading(true);
    setError("");
    setProg(null);
    setRecent([]);
    let dup = false;
    try {
      const r = await call<Repo[]>("scan", { paths, background: bg });
      setRepos(r);
      setLastScan(Math.floor(Date.now() / 1000));
      lastRefresh.current = Date.now();
      if (selRef.current && !r.some((x) => x.path === selRef.current)) close();
    } catch (e) {
      const m = String(e);
      if (m.includes("already running")) {
        dup = true;
        toast("A scan is already in progress");
      } else setError(m);
    } finally {
      if (!dup) {
        setLoading(false);
        setScanned(true);
      }
    }
  };
  const startScan = () => {
    const c = input
      .split(/\r?\n|,/)
      .map((x) => x.trim())
      .filter(Boolean);
    scan(c.length ? c : sel.length ? sel : drives);
  };
  const cancel = () => {
    call("cancel_scan").catch(() => {});
  };
  useEffect(() => {
    if (!isTauri) return;
    const subs = [
      listen<Prog>("scan-progress", (e) => setProg(e.payload)),
      listen<string>("scan-found", (e) =>
        setRecent((o) => [e.payload, ...o].slice(0, 8)),
      ),
      listen<Repo>("repo-updated", (e) => {
        const p = e.payload;
        const prev = reposRef.current.find((r) => r.path === p.path);
        upsert(p);
        if (selRef.current === p.path) {
          setInfo(p);
          if (prev && prev.last_commit !== p.last_commit)
            fetchCommits(p.path, 0)
              .then((c) => {
                if (selRef.current === p.path) {
                  setCommits(c);
                  setHasMore(c.length === PAGE);
                }
              })
              .catch(() => {});
        }
      }),
      listen<Repo>("repo-added", (e) => {
        upsert(e.payload);
        toast(`Repository added: ${e.payload.name}`);
      }),
      listen<string>("repo-removed", (e) => {
        const p = e.payload;
        const nm = reposRef.current.find((r) => r.path === p)?.name ?? p;
        setRepos((o) => o.filter((r) => r.path !== p));
        if (selRef.current === p) close();
        toast(`Repository removed: ${nm}`);
      }),
    ];
    if (!started) {
      started = true;
      call<Startup>("startup")
        .then((s) => {
          setRepos(s.repos);
          setLastScan(s.last_scan);
          setBooted(true);
          call<DriveInfo>("drives_info")
            .then((d) => {
              setDrives(d.drives);
              setSel(d.drives);
              setWatched(d.roots);
            })
            .catch(() => {});
          if (
            s.repos.length === 0 ||
            Date.now() / 1000 - s.last_scan > 12 * 3600
          )
            scan([], s.repos.length > 0);
          else refreshAll();
        })
        .catch((e) => {
          setBooted(true);
          setError(String(e));
        });
    }
    return () => {
      subs.forEach((s) => s.then((f) => f()));
    };
  }, []);
  useEffect(() => {
    if (!isTauri) return;
    const f = () => {
      if (Date.now() - lastRefresh.current > 60000 && !loading) refreshAll();
    };
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [loading]);
  useEffect(() => {
    if (!loading) return;
    setSecs(0);
    const t = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && /INPUT|TEXTAREA/.test(t.tagName);
      if (e.key === "Escape") {
        if (settings) setSettings(false);
        else if (selRef.current) close();
      } else if (
        (e.key === "/" && !typing) ||
        (e.key === "k" && (e.ctrlKey || e.metaKey))
      ) {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [settings]);
  const openSettings = () => {
    setSettings(true);
    if (isTauri)
      call<string[]>("get_ignore")
        .then((l) => setIgnoreText(l.join("\n")))
        .catch(() => {});
  };
  const saveSettings = () => {
    call("set_ignore", { list: ignoreText.split(/\r?\n|,/) })
      .then(() => {
        setSettings(false);
        toast("Saved. Excluded folders apply from the next scan");
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(() => {
    setScroll(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [filter, query]);

  const counts = {
    dirty: repos.filter((r) => r.dirty).length,
    unpushed: repos.filter((r) => r.ahead > 0).length,
    behind: repos.filter((r) => r.behind > 0).length,
  };
  const filtered = useMemo(
    () =>
      repos.filter(
        (r) =>
          (filter === "all" ||
            (filter === "dirty"
              ? r.dirty
              : filter === "unpushed"
                ? r.ahead > 0
                : r.behind > 0)) &&
          (r.name + " " + r.path + " " + r.branch)
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [repos, query, filter],
  );
  const start = Math.max(0, Math.floor(scroll / rowH) - overscan),
    end = Math.min(
      filtered.length,
      Math.ceil((scroll + viewport) / rowH) + overscan,
    );
  const visible = filtered.slice(start, end);
  const shown = useMemo(
    () =>
      commits.filter((c) =>
        (c.message + " " + c.author + " " + c.id)
          .toLowerCase()
          .includes(commitQuery.toLowerCase()),
      ),
    [commits, commitQuery],
  );
  const n = (r: Repo) =>
    r.modified.length +
    r.staged.length +
    r.untracked.length +
    r.deleted.length +
    r.conflicted.length;
  const summary = (r: Repo) =>
    [
      [r.modified.length, "M"],
      [r.staged.length, "S"],
      [r.untracked.length, "U"],
      [r.deleted.length, "D"],
      [r.conflicted.length, "C"],
    ]
      .filter((x) => x[0])
      .map((x) => `${x[0]}${x[1]}`)
      .join(" ");
  const view =
    info && info.path === selected
      ? info
      : (repos.find((r) => r.path === selected) ?? null);
  const statusText = !isTauri
    ? "Web mode – run npm run tauri dev"
    : !booted
      ? "Starting GitPulse… loading saved data"
      : loading
        ? `${prog?.stage ?? "Starting scan"}${prog?.current ? ` — ${prog.current}` : ""}`
        : refreshing
          ? "Checking saved repositories for changes…"
          : selected && loadingRepo
            ? `Loading ${view?.name ?? "repository"}…`
            : `Idle · watching ${repos.length} repositories live`;
  const busy = isTauri && (!booted || loading || refreshing || loadingRepo);
  const chip = (k: Filter, label: string, v: number, c: string) => (
    <button
      aria-pressed={filter === k}
      onClick={() => setFilter((f) => (f === k ? "all" : k))}
      title={`Show ${label}`}
      className={`px-2.5 py-1 rounded-md border text-xs whitespace-nowrap shrink-0 ${filter === k ? "border-orange-500 bg-orange-500/10 text-orange-200" : "border-line hover:bg-panel2 text-zinc-400"}`}
    >
      <b className={c}>{v}</b> {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-bg text-zinc-200">
      <header className="min-h-16 shrink-0 border-b border-line flex flex-wrap items-center px-3 sm:px-5 py-2 gap-2 sm:gap-4 bg-panel">
        <div className="flex items-center gap-3 mr-auto">
          <div className="h-9 w-9 rounded-xl bg-orange-500 text-black font-black grid place-items-center">
            GP
          </div>
          <div>
            <div className="font-bold tracking-tight">GitPulse</div>
            <div className="hidden sm:block text-[11px] text-zinc-500">
              local Git intelligence
            </div>
          </div>
        </div>
        <input
          ref={filterRef}
          aria-label="Filter repositories"
          aria-keyshortcuts="/"
          title="Press / to focus"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter repositories…  ( / )"
          className="flex-1 min-w-[120px] max-w-64 rounded-lg bg-zinc-900 border border-line px-3 py-2 text-sm outline-none focus:border-orange-500"
        />
        <button
          onClick={startScan}
          disabled={loading || !isTauri}
          className="rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-black font-bold px-4 py-2 text-sm"
        >
          {loading ? "Scanning…" : repos.length ? "Rescan" : "Scan"}
        </button>
        {loading && (
          <button
            onClick={cancel}
            className="rounded-lg border border-line hover:bg-panel2 px-4 py-2 text-sm"
          >
            Cancel
          </button>
        )}
        <button
          onClick={openSettings}
          aria-label="Settings"
          title="Settings"
          className="rounded-lg border border-line hover:bg-panel2 px-3 py-2 text-sm"
        >
          ⚙
        </button>
      </header>
      {!isTauri && (
        <div
          role="alert"
          className="shrink-0 bg-amber-500/10 border-b border-amber-500/40 text-amber-300 px-5 py-2 text-sm"
        >
          Running in web mode: native features are unavailable. Run{" "}
          <code className="font-mono">npm run tauri dev</code> to use GitPulse.
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <main
          ref={mainRef}
          className="flex-1 min-w-0 overflow-hidden flex flex-col"
        >
          <div className="px-3 sm:px-5 py-3 border-b border-line flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {chip("all", "repositories", repos.length, "text-zinc-200")}
            {chip("dirty", "dirty", counts.dirty, "text-orange-300")}
            {chip("unpushed", "unpushed", counts.unpushed, "text-orange-300")}
            {chip("behind", "behind", counts.behind, "text-sky-300")}
            {filter !== "all" && (
              <span className="ml-1 whitespace-nowrap">
                Showing {filtered.length} of {repos.length}
              </span>
            )}
          </div>
          <div className="px-3 sm:px-5 py-2 border-b border-line flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>Scan drives:</span>
            {drives.map((d) => (
              <button
                key={d}
                aria-pressed={sel.includes(d)}
                onClick={() =>
                  setSel((o) =>
                    o.includes(d) ? o.filter((x) => x !== d) : [...o, d],
                  )
                }
                className={`px-2.5 py-1 rounded-md border ${sel.includes(d) ? "border-orange-500 bg-orange-500/10 text-orange-200" : "border-line text-zinc-400 hover:bg-panel2"}`}
              >
                {d}
              </button>
            ))}
            <button
              aria-label="Select all or none of the drives"
              onClick={() => setSel(sel.length === drives.length ? [] : drives)}
              className="px-2.5 py-1 rounded-md border border-line hover:bg-panel2"
            >
              {sel.length === drives.length ? "None" : "All"}
            </button>
            <input
              aria-label="Custom folders to scan"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="or custom folder(s), comma-separated"
              className="w-full sm:w-[min(28vw,340px)] min-w-[160px] bg-zinc-900 border border-line rounded-lg px-3 py-1.5 text-zinc-300 outline-none focus:border-orange-500"
            />
            <span className="ml-auto flex items-center gap-3 whitespace-nowrap">
              {refreshing && (
                <span className="flex items-center gap-1.5">
                  <Spin />
                  Updating…
                </span>
              )}
              <span
                title={`Watching: ${watched.join(", ")}`}
                className="flex items-center gap-1.5"
              >
                <i
                  className={`h-2 w-2 rounded-full ${isTauri ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`}
                />
                Live
              </span>
              <span>
                {lastScan ? `Last scan ${ago(lastScan)}` : "Never scanned"}
              </span>
            </span>
          </div>
          {error && (
            <div className="mx-5 mt-3 rounded-lg border border-red-900 bg-red-950/30 text-red-300 px-3 py-2 text-sm flex">
              <span className="flex-1">{error}</span>
              <button onClick={() => setError("")} className="ml-3">
                ✕
              </button>
            </div>
          )}
          {loading && (
            <div className="mx-5 mt-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm">
              <div className="flex items-center gap-3">
                <Spin />
                <b>{prog?.stage ?? "Starting…"}</b>
                <span className="ml-auto text-xs text-zinc-500">
                  {secs}s · {prog?.dirs ?? 0} folders checked ·{" "}
                  {prog?.found ?? 0} repos found
                </span>
              </div>
              {prog && prog.total > 0 && (
                <div className="mt-2 h-1.5 rounded bg-zinc-800">
                  <div
                    className="h-full rounded bg-orange-500"
                    style={{
                      width: `${Math.round((prog.done / prog.total) * 100)}%`,
                    }}
                  />
                </div>
              )}
              <div
                className="mt-2 text-xs text-zinc-400 font-mono truncate"
                title={prog?.current}
              >
                {prog?.current || "Preparing…"}
              </div>
              {recent.length > 0 && (
                <div className="mt-2 text-xs text-zinc-500">
                  Found:
                  {recent.map((r) => (
                    <div
                      key={r}
                      className="font-mono truncate text-emerald-400/80"
                    >
                      {r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {isTauri && !booted && (
            <div className="mx-5 mt-3 flex items-center gap-2 text-sm text-zinc-400">
              <Spin />
              Loading saved repositories…
            </div>
          )}
          {booted && !loading && !scanned && repos.length === 0 && !error && (
            <div className="mx-5 mt-3 rounded-lg border border-line bg-panel p-5 text-sm">
              <div className="font-semibold mb-1">Welcome to GitPulse</div>
              <div className="text-zinc-400">
                No repositories yet. Press Scan to search{" "}
                {sel.length ? sel.join(", ") : "all drives"} for Git
                repositories. The first scan can take a few minutes and its
                progress is shown here; results are saved, so later launches are
                instant.
              </div>
            </div>
          )}
          {!loading && scanned && repos.length === 0 && !error && (
            <div className="mx-5 mt-3 text-sm text-zinc-500">
              No Git repositories found in the scanned paths.
            </div>
          )}
          {!loading && repos.length > 0 && filtered.length === 0 && (
            <div className="mx-5 mt-3 text-sm text-zinc-500">
              No repositories match the current filter.
            </div>
          )}
          <div
            style={{ gridTemplateColumns: tpl }}
            className="mx-5 px-4 pt-3 grid gap-3 text-[11px] uppercase tracking-wider text-zinc-600 font-bold"
          >
            <div>Repository</div>
            {has(1) && <div>Branch</div>}
            <div>Status</div>
            {has(3) && <div>Sync</div>}
            {has(4) && <div>Last commit</div>}
          </div>
          <div
            ref={listRef}
            className="mx-5 mt-2 flex-1 min-h-0 overflow-auto"
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            <div
              style={{ height: filtered.length * rowH, position: "relative" }}
            >
              {visible.map((r, i) => (
                <button
                  key={r.path}
                  onClick={() => open(r.path)}
                  style={{
                    position: "absolute",
                    top: (start + i) * rowH,
                    left: 0,
                    right: 0,
                    height: rowH - 5,
                    gridTemplateColumns: tpl,
                  }}
                  className={`w-full grid gap-3 items-center text-left rounded-xl border px-4 mb-1 transition ${selected === r.path ? "border-orange-500/60 bg-orange-500/5" : "border-transparent hover:border-line hover:bg-panel"}`}
                >
                  <div className="min-w-0 flex items-center gap-2">
                    {selected === r.path && loadingRepo && <Spin />}
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{r.name}</div>
                      <div className="text-xs text-zinc-600 truncate">
                        {shortPath(r.path)}
                      </div>
                    </div>
                  </div>
                  {has(1) && (
                    <div
                      className="text-sm text-zinc-400 truncate"
                      title={r.branch}
                    >
                      {r.branch}
                    </div>
                  )}
                  <div className="flex items-center gap-2 min-w-0">
                    {r.dirty ? (
                      <>
                        <i className="h-2 w-2 shrink-0 rounded-full bg-orange-400" />
                        <span
                          className="text-orange-300 text-xs truncate"
                          title={cats(r)
                            .filter((c) => c[2].length)
                            .map((c) => `${c[2].length} ${c[1].toLowerCase()}`)
                            .join(", ")}
                        >
                          {summary(r)}
                        </span>
                      </>
                    ) : (
                      <>
                        <i className="h-2 w-2 rounded-full bg-emerald-400" />
                        <span className="text-emerald-300">Clean</span>
                      </>
                    )}
                  </div>
                  {has(3) && (
                    <div className="text-xs">
                      {r.upstream ? (
                        <>
                          <span
                            className={
                              r.ahead > 0 ? "text-orange-300" : "text-zinc-600"
                            }
                          >
                            ↑{r.ahead}
                          </span>{" "}
                          <span className="text-zinc-700">/</span>{" "}
                          <span
                            className={
                              r.behind > 0 ? "text-sky-300" : "text-zinc-600"
                            }
                          >
                            ↓{r.behind}
                          </span>
                        </>
                      ) : (
                        <span className="text-zinc-600">
                          {r.last_commit ? "no upstream" : "—"}
                        </span>
                      )}
                    </div>
                  )}
                  {has(4) && (
                    <div className="text-xs text-zinc-500 truncate">
                      {r.last_commit ? when(r.last_commit) : "No commits yet"}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </main>
        {selected && view && (
          <>
            {overlay && (
              <div className="fixed inset-0 z-30 bg-black/50" onClick={close} />
            )}
            <aside
              role="dialog"
              aria-label={`Details for ${view.name}`}
              style={{ width: sw }}
              className={`${overlay ? "fixed inset-y-0 right-0 z-40 shadow-2xl" : "relative"} shrink-0 border-l border-line bg-panel flex flex-col`}
            >
              <div
                onPointerDown={startDrag}
                title="Drag to resize"
                className="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize hover:bg-orange-500/60 active:bg-orange-500 z-10"
              />
              <div className="p-4 border-b border-line flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-bold truncate flex items-center gap-2">
                    {view.name}
                    {loadingRepo && <Spin />}
                  </div>
                  <div
                    className="text-xs text-zinc-600 truncate"
                    title={view.path}
                  >
                    {view.path}
                  </div>
                </div>
                <button
                  onClick={close}
                  aria-label="Close details"
                  title="Close (Esc)"
                  className="text-zinc-500 hover:text-white px-2"
                >
                  ✕
                </button>
              </div>
              <div className="px-4 py-3 border-b border-line text-xs text-zinc-400 grid grid-cols-[80px_1fr] gap-y-1">
                <span className="text-zinc-600">Branch</span>
                <span className="font-mono">
                  {view.branch}
                  {view.upstream && (
                    <span className="text-zinc-500"> → {view.upstream}</span>
                  )}
                  {view.upstream && (
                    <span>
                      {" "}
                      ·{" "}
                      <span className={view.ahead ? "text-orange-300" : ""}>
                        ↑{view.ahead}
                      </span>{" "}
                      <span className={view.behind ? "text-sky-300" : ""}>
                        ↓{view.behind}
                      </span>
                    </span>
                  )}
                </span>
                <span className="text-zinc-600">Remote</span>
                <span
                  className="font-mono truncate min-w-0"
                  title={view.remote ?? ""}
                >
                  {view.remote ?? "none"}
                </span>
                <span className="text-zinc-600">Last commit</span>
                <span>
                  {view.last_commit
                    ? `${when(view.last_commit)} (${ago(view.last_commit)})`
                    : "No commits yet"}
                </span>
              </div>
              <div className="p-4 border-b border-line grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-2">
                {cats(view).map(([k, l, a, d]) => (
                  <button
                    key={k}
                    disabled={!a.length}
                    title={a.length ? `${d} – click to list` : d}
                    onClick={() => {
                      setSec((o) => (o === k ? null : k));
                      setTimeout(
                        () =>
                          document
                            .getElementById("wt-" + k)
                            ?.scrollIntoView({
                              block: "nearest",
                              behavior: "smooth",
                            }),
                        60,
                      );
                    }}
                    className={`rounded-lg p-2 text-center transition ${a.length ? (sec === k ? "bg-orange-500/20 ring-1 ring-orange-500" : "bg-zinc-900 hover:bg-zinc-800 cursor-pointer") : "bg-zinc-900/50 opacity-60 cursor-default"}`}
                  >
                    <b className={a.length ? "text-orange-300" : ""}>
                      {a.length}
                    </b>
                    <small className="block text-zinc-500">
                      {l.toLowerCase()}
                    </small>
                  </button>
                ))}
              </div>
              <div className="px-4 py-3 flex flex-wrap gap-2 border-b border-line">
                <button
                  onClick={() => act("open_terminal", { path: view.path })}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs"
                >
                  Terminal
                </button>
                {view.remote_web && view.last_commit !== null && (
                  <button
                    onClick={() => act("open_remote", { url: view.remote_web })}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs"
                  >
                    Remote
                  </button>
                )}
                <button
                  onClick={refresh}
                  disabled={loadingRepo}
                  className="ml-auto px-3 py-1.5 rounded-lg border border-line hover:bg-zinc-800 disabled:opacity-50 text-xs"
                >
                  Refresh
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                {n(view) > 0 && (
                  <section className="p-4 border-b border-line">
                    <h3 className="font-semibold mb-2">
                      Working tree{" "}
                      <span className="text-xs text-zinc-500 font-normal">
                        uncommitted changes · click a category to expand
                      </span>
                    </h3>
                    {cats(view).map(([k, l, a, d]) =>
                      a.length ? (
                        <div key={k} id={"wt-" + k} className="mb-1">
                          <button
                            onClick={() => setSec((o) => (o === k ? null : k))}
                            className="w-full flex items-center gap-2 py-1.5 text-left text-sm text-zinc-300 hover:text-white"
                          >
                            <span className="text-xs text-zinc-600 w-3">
                              {sec === k ? "▾" : "▸"}
                            </span>
                            <b>{l}</b>
                            <span className="text-orange-300">{a.length}</span>
                            <span className="text-xs text-zinc-600 truncate">
                              {d}
                            </span>
                          </button>
                          {sec === k && (
                            <div className="ml-5 mb-2 max-h-64 overflow-auto rounded-lg bg-zinc-900 p-2">
                              {a.slice(0, 500).map((f) => (
                                <div
                                  key={f}
                                  className="text-xs py-0.5 text-zinc-300 font-mono truncate"
                                  title={f}
                                >
                                  {f}
                                </div>
                              ))}
                              {a.length > 500 && (
                                <div className="text-xs text-zinc-500 pt-1">
                                  …and {a.length - 500} more
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : null,
                    )}
                  </section>
                )}
                <section>
                  <div className="flex items-center gap-2 p-4">
                    <h3 className="font-semibold mr-auto">
                      Commit history{" "}
                      <span className="text-xs text-zinc-500 font-normal">
                        {commits.length}
                        {hasMore ? "+" : ""} loaded
                      </span>
                    </h3>
                    <input
                      value={commitQuery}
                      onChange={(e) => setCommitQuery(e.target.value)}
                      aria-label="Search loaded commits"
                      placeholder="Search loaded commits…"
                      className="w-52 bg-zinc-900 border border-line rounded-lg px-2 py-1.5 text-xs outline-none focus:border-orange-500"
                    />
                  </div>
                  {loadingRepo && commits.length === 0 && (
                    <div className="flex items-center gap-2 px-4 pb-4 text-sm text-zinc-400">
                      <Spin />
                      Loading {view.name}…
                    </div>
                  )}
                  {!loadingRepo && commits.length === 0 && (
                    <div className="px-4 pb-4 text-sm text-zinc-500">
                      No commits yet in this repository.
                    </div>
                  )}
                  {shown.map((c) => (
                    <CommitItem
                      key={c.id}
                      c={c}
                      open={expanded === c.id}
                      ds={ds[c.id]}
                      onToggle={() => toggle(c)}
                    />
                  ))}
                  {hasMore && (
                    <div className="p-4">
                      <button
                        onClick={more}
                        disabled={loadingMore}
                        className="w-full py-2 rounded-lg border border-line hover:bg-zinc-800 text-xs flex items-center justify-center gap-2"
                      >
                        {loadingMore && <Spin />}
                        {loadingMore ? "Loading…" : `Load ${PAGE} more commits`}
                      </button>
                    </div>
                  )}
                </section>
              </div>
            </aside>
          </>
        )}
      </div>
      {settings && (
        <div
          className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4"
          onClick={() => setSettings(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-xl border border-line bg-panel p-5"
          >
            <div className="flex items-center mb-3">
              <h2 className="font-bold mr-auto">Settings</h2>
              <button
                onClick={() => setSettings(false)}
                aria-label="Close settings"
                className="text-zinc-500 hover:text-white px-2"
              >
                ✕
              </button>
            </div>
            <label className="text-sm font-semibold" htmlFor="ign">
              Extra folders to skip while scanning
            </label>
            <div className="text-xs text-zinc-500 mb-2">
              One folder name per line (case-insensitive, matched anywhere in
              the path). Built in: Windows, AppData, ProgramData, Program Files,
              node_modules, venv, site-packages and similar system/dependency
              folders.
            </div>
            <textarea
              id="ign"
              value={ignoreText}
              onChange={(e) => setIgnoreText(e.target.value)}
              rows={6}
              placeholder="e.g. backups"
              className="w-full rounded-lg bg-zinc-900 border border-line p-2 font-mono text-xs outline-none focus:border-orange-500"
            />
            <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <span className="mr-auto">
                Shortcuts: <kbd>/</kbd> filter · <kbd>Esc</kbd> close
              </span>
              <button
                onClick={() => setSettings(false)}
                className="px-3 py-1.5 rounded-lg border border-line hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                disabled={!isTauri}
                className="px-3 py-1.5 rounded-lg bg-orange-500 text-black font-bold disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      <footer
        role="status"
        aria-live="polite"
        className="h-8 shrink-0 border-t border-line bg-panel px-5 flex items-center gap-3 text-xs text-zinc-400"
      >
        <span className="flex items-center gap-2 min-w-0">
          {busy && <Spin />}
          <span className="truncate">{statusText}</span>
        </span>
        <span className="ml-auto whitespace-nowrap text-zinc-600 hidden sm:block">
          {repos.length} repositories · {counts.dirty} dirty
        </span>
      </footer>
      <div className="fixed bottom-10 left-4 flex flex-col gap-2 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="rounded-lg border border-line bg-panel2 px-4 py-2 text-sm shadow-lg"
          >
            {t.m}
          </div>
        ))}
      </div>
    </div>
  );
}
export default App;
